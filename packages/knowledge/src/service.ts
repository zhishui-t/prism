/**
 * KnowledgeService 实现（design.md §3.5 落库契约）。
 *
 * 写路径：所有写操作经 openPersistence 的 SingleWriterQueue 串行（core 已默认
 * WAL + busy_timeout=5000）；版本号在 BEGIN IMMEDIATE 事务内取 MAX 语义
 * （ORDER BY version DESC LIMIT 1）+1，唯一约束 (id, version) 兜底；
 * 版次文件与最新版副本在同一临界区内落盘，失败回滚并还原文件快照。
 *
 * 落库校验清单（需求 D3，Prism 不判审只做三件事）：
 * 必填字段 / id 冲突判 layer+book+owner / 段名合法 / 类型合法 /
 * status 默认 active + 旧版 superseded 记 supersedes /
 * content_hash=SHA256 / 写 AuditLog knowledge.deposited（与 knowledge.superseded）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { AuditLog, openPersistence, PrismError, prismPaths } from '@prism/core'
import type { DatabaseSync } from 'node:sqlite'
import type { PrismPersistence } from '@prism/core'

import { bodyForRowid, ensureKbFts, indexEntry, searchFts } from './index-db.js'
import { renderMarkdownFile, splitFrontmatter } from './frontmatter.js'
import {
  INBOX_DIR,
  isValidSegment,
  ownerFromPath,
  readContentFile,
  readEntryContent,
  writeEntryFiles,
} from './store.js'
import { bigram, toMatchExpression } from './tokenize.js'
import type {
  BookNode,
  CatalogEntry,
  DepositInput,
  EdgeConfidence,
  EdgeRelation,
  EntryType,
  GraphNode,
  GraphPath,
  GraphQuery,
  GraphView,
  IndexInput,
  IndexResult,
  KnowledgeConflict,
  KnowledgeEdge,
  KnowledgeEntry,
  KnowledgeService,
  KnowledgeServiceOptions,
  KbStats,
  Layer,
  ReindexReport,
  RemoveResult,
  SearchQuery,
  SearchResult,
} from './types.js'

const LAYERS: readonly Layer[] = ['global', 'project', 'role']
const ENTRY_TYPES: readonly EntryType[] = [
  'rule',
  'doc',
  'guide',
  'pitfall',
  'pattern',
  'diagram',
  'summary',
  'other',
]
const RISKS = ['low', 'medium', 'high'] as const
const VISIBILITIES = ['global', 'project', 'role'] as const

const EDGE_RELATIONS: readonly EdgeRelation[] = ['references', 'overrides', 'supersedes', 'related']

/**
 * 正文双链抽取：`[[ID]]` 或 `[[ID|显示文本]]`（中括号内不含换行/中括号）。
 * 去重后按出现顺序返回。确定性抽取，零 LLM（EXTRACTED）。
 */
export function extractWikiLinks(content: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    const id = match[1]!.trim()
    if (id !== '' && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** LIKE 通配符转义（配 ESCAPE '\' 使用）。 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

interface EntryRow {
  rowid: number
  id: string
  version: number
  is_latest: number
  title: string
  type: string
  layer: string
  owner: string | null
  book: string
  module: string
  status: string
  risk: string
  confidence: number
  freshness: number
  visibility: string
  tags: string
  path: string
  content_hash: string
  origin: string
  source_hash: string | null
  overrides: string
  supersedes: string | null
  created_at: string
  updated_at: string
}

const ENTRY_COLUMNS = `rowid, id, version, is_latest, title, type, layer, owner, book, module, status,
  risk, confidence, freshness, visibility, tags, path, content_hash, origin, source_hash,
  overrides, supersedes, created_at, updated_at`

/** knowledge_edges 表行。 */
interface EdgeRow {
  from_id: string
  to_id: string
  relation: string
  confidence: string
  weight: number
  source: string
  created_at: string
}

/** 事务失败时的文件还原快照。 */
interface FileSnapshot {
  path: string
  existed: boolean
  content: string | null
}

/** reindex 解析出的版次行（模块级类型，私有方法返回值的类型位置可用）。 */
interface ReindexRow {
  id: string
  version: number
  title: string
  type: string
  /** 文件里记录的 status（BLK-2：软删后 reindex 不能复活） */
  status: 'active' | 'deprecated'
  layer: Layer
  owner: string | null
  book: string
  module: string
  risk: string
  confidence: number
  freshness: number
  visibility: string
  tags: string[]
  overrides: string[]
  contentHash: string
  body: string
  path: string
  createdAt: string
  updatedAt: string
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) return { path, existed: false, content: null }
  try {
    return { path, existed: true, content: readFileSync(path, 'utf-8') }
  } catch {
    return { path, existed: true, content: null }
  }
}

function restoreFile(snapshot: FileSnapshot): void {
  try {
    if (!snapshot.existed) {
      if (existsSync(snapshot.path)) unlinkSync(snapshot.path)
      return
    }
    if (snapshot.content !== null) writeFileSync(snapshot.path, snapshot.content, 'utf-8')
  } catch {
    // 还原失败不掩盖原始错误
  }
}

/** 校验并归一化后的落库地址与默认值。 */
interface NormalizedDeposit {
  id: string
  layer: Layer
  owner?: string
  book: string
  module: string
  title: string
  risk: string
  confidence: number
  visibility: string
  tags: string[]
  overrides: string[]
}

export class PrismKnowledgeService implements KnowledgeService {
  readonly home: string
  readonly knowledgeDir: string
  readonly persistence: PrismPersistence
  readonly audit: AuditLog
  readonly #now: () => Date
  readonly #idFactory: () => string
  readonly #ownsPersistence: boolean
  readonly #enqueueEnrichment: KnowledgeServiceOptions['enqueueEnrichment']

  constructor(options: KnowledgeServiceOptions = {}) {
    this.home = options.home ?? prismPaths().home
    this.knowledgeDir = options.knowledgeDir ?? prismPaths(this.home).knowledgeDir
    this.#ownsPersistence = !options.persistence
    this.persistence = options.persistence ?? openPersistence({ home: this.home })
    this.audit =
      options.audit ??
      new AuditLog({ dir: prismPaths(this.home).auditDir, queue: this.persistence.queue })
    this.#now = options.now ?? (() => new Date())
    this.#idFactory =
      options.idFactory ?? (() => `KB-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
    this.#enqueueEnrichment = options.enqueueEnrichment
    ensureKbFts(this.persistence.knowledge)
  }

  /** 释放内部创建的持久化（注入的连接由注入方负责关闭）。 */
  close(): void {
    if (this.#ownsPersistence) this.persistence.close()
  }

  // ===== deposit =====

  async deposit(input: DepositInput): Promise<{ id: string; version: number; path: string }> {
    const address = this.#validateAndNormalize(input)
    const content = input.content
    const nowIso = this.#now().toISOString()
    const seg = bigram(`${address.title}\n${content}`)
    const contentHash = createHash('sha256').update(content, 'utf-8').digest('hex')
    const frontmatterBase = {
      id: address.id,
      title: address.title,
      type: input.type,
      layer: address.layer,
      ...(address.owner !== undefined ? { owner: address.owner } : {}),
      book: address.book,
      module: address.module,
      status: 'active',
      risk: address.risk,
      confidence: address.confidence,
      freshness: 1.0,
      visibility: address.visibility,
      tags: address.tags,
      created: nowIso,
      updated: nowIso,
      ...(input.source !== undefined ? { source: input.source } : {}),
      overrides: address.overrides,
      supersedes: null,
      ...(input.deposited_by !== undefined
        ? { deposited_by: { ...input.deposited_by, at: nowIso } }
        : {}),
    }

    const deposited = await this.persistence.knowledge.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      const snapshots: FileSnapshot[] = []
      try {
        const prev = raw
          .prepare(
            `SELECT version, layer, book, owner, path FROM knowledge_entries
             WHERE id = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(address.id) as
          | { version: number; layer: string; book: string; owner: string | null; path: string }
          | undefined

        // id 冲突：同 id 已存在但 layer/book/owner 与既有不一致 → id_conflict（§3.5）
        if (prev) {
          // owner 优先取列（Z1）；老库列为空时回落 path 反解
          const prevOwner = prev.owner ?? ownerFromPath(this.knowledgeDir, prev.path)
          if (
            prev.layer !== address.layer ||
            prev.book !== address.book ||
            prevOwner !== address.owner
          ) {
            throw new PrismError('id_conflict', `条目 id 已存在于其他位置: ${address.id}`, {
              id: address.id,
              existing: { layer: prev.layer, book: prev.book, owner: prevOwner ?? null },
              attempted: {
                layer: address.layer,
                book: address.book,
                owner: address.owner ?? null,
              },
            })
          }
        }

        const version = prev ? prev.version + 1 : 1
        const markdown = renderMarkdownFile(
          {
            ...frontmatterBase,
            version,
            updated: nowIso,
            supersedes: prev ? `${address.id}@v${prev.version}` : null,
          },
          content,
        )

        // 文件为真相：先快照、再写版次文件与最新版副本，随后同临界区提交索引事务
        const files = writeEntryFiles(this.knowledgeDir, address, address.id, version, markdown)
        snapshots.push(snapshotFile(files.versionFile), snapshotFile(files.latestFile))

        if (prev) {
          raw
            .prepare(
              `UPDATE knowledge_entries SET is_latest = 0, status = 'superseded', updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .run(nowIso, address.id, prev.version)
        }

        const insert = raw
          .prepare(
            `INSERT INTO knowledge_entries
             (id, version, is_latest, title, type, layer, owner, book, module, status, risk, confidence,
              freshness, visibility, tags, path, content_hash, overrides, supersedes, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1.0, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            address.id,
            version,
            address.title,
            input.type,
            address.layer,
            address.owner ?? null,
            address.book,
            address.module,
            address.risk,
            address.confidence,
            address.visibility,
            JSON.stringify(address.tags),
            files.versionFile,
            contentHash,
            JSON.stringify(address.overrides),
            prev ? `${address.id}@v${prev.version}` : null,
            nowIso,
            nowIso,
          )

        indexEntry(raw, Number(insert.lastInsertRowid), content, seg)
        // 关系边：以本条目为源整体重建（单一边表 + 多视图，D8）
        this.#writeEdges(raw, address.id, {
          content,
          overrides: address.overrides,
          nowIso,
        })
        raw.exec('COMMIT')
        return { id: address.id, version, path: files.versionFile }
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          // 事务已因 COMMIT 失败而终止时忽略
        }
        // 逆序还原文件快照（COMMIT 成功后不会走到这里）
        for (let i = snapshots.length - 1; i >= 0; i--) restoreFile(snapshots[i]!)
        throw error
      }
    })

    // 留痕（§3.5：写 AuditLog）。审计失败向上抛出（条目已提交，重试产生新版次）。
    await this.audit.record({
      type: 'knowledge.deposited',
      knowledge_id: deposited.id,
      layer: address.layer,
      source: input.source?.kind ?? 'manual',
    })
    if (deposited.version > 1) {
      await this.audit.record({
        type: 'knowledge.superseded',
        new_id: `${deposited.id}@v${deposited.version}`,
        old_id: `${deposited.id}@v${deposited.version - 1}`,
        reason: 'new_version',
      })
    }

    // B2：层间冲突检测（只记录不阻断，§12.3）
    await this.#detectConflicts(this.persistence.knowledge.raw, {
      id: deposited.id,
      layer: address.layer,
      book: address.book,
      module: address.module,
      title: address.title,
      overrides: address.overrides,
    })

    // A4：落库后投递富化任务（默认未注入 = 不入队；由 server 按 prism.yaml 决定）
    if (this.#enqueueEnrichment !== undefined) {
      await this.#enqueueEnrichment({
        id: deposited.id,
        version: deposited.version,
        layer: address.layer,
        book: address.book,
        module: address.module,
        type: input.type,
      })
    }
    return deposited
  }

  // ===== index（引用型：项目文件为真相，Prism 只存索引） =====

  /**
   * 索引一条引用型知识（design-knowledge-model-v1 §2/§4）。
   *
   * 与 `deposit` 的三点不同：
   * 1. **不写副本**——`path` 指向项目原件，Prism 不在 knowledgeDir 下生成文件；
   * 2. **不递增版次**——源变了就是 `updated`（同一行更新），不做版本历史（git 管）；
   * 3. **源哈希比对**——`source_hash` 相同则跳过（`unchanged`），避免无谓重写。
   *
   * reindex 只扫 knowledgeDir 下的版次文件，**不会碰到引用型行**（它们 path 在外部，
   * 且本方法不产生 v<NN>.md），因此两者互不干扰。
   */
  async index(input: IndexInput): Promise<IndexResult> {
    const address = this.#validateAndNormalize({
      id: input.id,
      title: input.title,
      type: input.type ?? 'doc',
      layer: input.layer,
      owner: input.owner,
      book: input.book,
      module: input.module,
      content: input.content,
      tags: input.tags,
    })
    const nowIso = this.#now().toISOString()
    const seg = bigram(`${address.title}\n${input.content}`)

    const action = await this.persistence.knowledge.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const prev = raw
          .prepare(
            `SELECT version, source_hash, origin, layer, book, owner FROM knowledge_entries
             WHERE id = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(address.id) as
          | { version: number; source_hash: string | null; origin: string; layer: string; book: string; owner: string | null }
          | undefined

        // 位置冲突：同 id 已在别处 → 拒绝（与 deposit 同口径）
        if (prev !== undefined) {
          const prevOwner = prev.owner ?? undefined
          if (prev.layer !== address.layer || prev.book !== address.book || prevOwner !== address.owner) {
            throw new PrismError('id_conflict', `条目 id 已存在于其他位置: ${address.id}`, {
              id: address.id,
              existing: { layer: prev.layer, book: prev.book, owner: prevOwner ?? null },
              attempted: { layer: address.layer, book: address.book, owner: address.owner ?? null },
            })
          }
          // 源未变 → 跳过（这就是「后续只是索引没变」）
          if (prev.origin === 'indexed' && prev.source_hash === input.source_hash) {
            raw.exec('COMMIT')
            return 'unchanged' as const
          }
        }

        if (prev !== undefined) {
          // 引用型同一行更新（不做版次）；若原先是自有型，转为引用型需显式覆盖整行
          raw
            .prepare(
              `UPDATE knowledge_entries SET
                 is_latest = 1, title = ?, type = ?, module = ?, status = 'active',
                 tags = ?, path = ?, content_hash = ?, source_hash = ?, origin = 'indexed',
                 updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .run(
              address.title,
              input.type ?? 'doc',
              address.module,
              JSON.stringify(address.tags),
              input.path,
              createHash('sha256').update(input.content, 'utf-8').digest('hex'),
              input.source_hash,
              nowIso,
              address.id,
              prev.version,
            )
          // FTS 与边表以该行为源重建
          const row = raw.prepare('SELECT rowid FROM knowledge_entries WHERE id = ? AND version = ?').get(
            address.id,
            prev.version,
          ) as { rowid: number } | undefined
          if (row !== undefined) {
            raw.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid)
            indexEntry(raw, row.rowid, input.content, seg)
          }
          this.#writeEdges(raw, address.id, { content: input.content, overrides: [], nowIso })
          raw.exec('COMMIT')
          return 'updated' as const
        }

        const insert = raw
          .prepare(
            `INSERT INTO knowledge_entries
             (id, version, is_latest, title, type, layer, owner, book, module, status, risk, confidence,
              freshness, visibility, tags, path, content_hash, source_hash, origin, overrides, supersedes,
              created_at, updated_at)
             VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, 'active', 'low', 0.5, 1.0, 'project', ?, ?, ?, ?, 'indexed',
                     '[]', NULL, ?, ?)`,
          )
          .run(
            address.id,
            address.title,
            input.type ?? 'doc',
            address.layer,
            address.owner ?? null,
            address.book,
            address.module,
            JSON.stringify(address.tags),
            input.path,
            createHash('sha256').update(input.content, 'utf-8').digest('hex'),
            input.source_hash,
            nowIso,
            nowIso,
          )
        indexEntry(raw, Number(insert.lastInsertRowid), input.content, seg)
        this.#writeEdges(raw, address.id, { content: input.content, overrides: [], nowIso })
        raw.exec('COMMIT')
        return 'created' as const
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          // 事务已终止时忽略
        }
        throw error
      }
    })

    if (action !== 'unchanged') {
      await this.audit.record({
        type: 'knowledge.deposited',
        knowledge_id: address.id,
        layer: address.layer,
        source: 'import',
      })
    }
    return { id: address.id, action }
  }

  // ===== 层间冲突（B2，§12.3：只记录不阻断） =====

  /**
   * 检测层间冲突：同一 book/module 下**标题相同**的条目跨层共存，
   * 且高层未显式声明 `overrides: [低层ID]` → 记一条 `same_title` 冲突。
   *
   * 为什么用标题判据：Prism 零 LLM，无法判断「语义冲突」；标题相同是**确定性**
   * 的强信号（同名规则覆盖），且不会误报。只记录，不改状态、不阻断落库。
   */
  async #detectConflicts(
    raw: DatabaseSync,
    input: {
      id: string
      layer: Layer
      book: string
      module: string
      title: string
      overrides: string[]
    },
  ): Promise<void> {
    // 只在 project/role 层检查（global 是最底层，没有「更低层」）
    if (input.layer === 'global') return
    const lows = raw
      .prepare(
        `SELECT id, title FROM knowledge_entries
         WHERE is_latest = 1 AND layer = 'global' AND book = ? AND module = ?
           AND status != 'deprecated' AND title = ? AND id != ?`,
      )
      .all(input.book, input.module, input.title, input.id) as Array<{ id: string; title: string }>
    const nowIso = this.#now().toISOString()
    for (const low of lows) {
      // 已显式声明 overrides → 不算冲突（就近覆盖是有意为之）
      if (input.overrides.includes(low.id)) continue
      const existing = raw
        .prepare(
          `SELECT id FROM knowledge_conflicts WHERE high_id = ? AND low_id = ? AND kind = 'same_title'`,
        )
        .get(input.id, low.id) as { id: string } | undefined
      if (existing !== undefined) continue
      raw
        .prepare(
          `INSERT INTO knowledge_conflicts (id, high_id, low_id, kind, resolved, detected_at)
           VALUES (?, ?, ?, 'same_title', 0, ?)`,
        )
        .run(`CF-${randomUUID().slice(0, 12)}`, input.id, low.id, nowIso)
      await this.audit.record({
        type: 'knowledge.conflict_detected',
        high_id: input.id,
        low_id: low.id,
        kind: 'same_title',
      })
    }
  }

  /** 列出层间冲突（未解决在前）。 */
  async conflicts(options: { includeResolved?: boolean } = {}): Promise<KnowledgeConflict[]> {
    const raw = this.persistence.knowledge.raw
    const where = options.includeResolved === true ? '' : 'WHERE resolved = 0'
    const rows = raw
      .prepare(
        `SELECT id, high_id, low_id, kind, resolved, detected_at FROM knowledge_conflicts
         ${where} ORDER BY resolved ASC, detected_at DESC`,
      )
      .all() as Array<{
      id: string
      high_id: string
      low_id: string
      kind: string
      resolved: number
      detected_at: string
    }>
    return rows.map((r) => ({
      id: r.id,
      high_id: r.high_id,
      low_id: r.low_id,
      kind: r.kind,
      resolved: r.resolved === 1,
      detected_at: r.detected_at,
    }))
  }

  /** 标记冲突已处理（只改标记，不删记录）。 */
  async resolveConflict(conflictId: string): Promise<boolean> {
    const result = this.persistence.knowledge.raw
      .prepare('UPDATE knowledge_conflicts SET resolved = 1 WHERE id = ?')
      .run(conflictId)
    return Number(result.changes) > 0
  }

  // ===== remove（B1：软删优先，被引用禁硬删） =====
  /**
   * 删除条目（§12.6）。
   *
   * - **默认软删**：最新版 `status = 'deprecated'`，保留行与文件（可追溯、可恢复）；
   * - **硬删**（`hard: true`）：仅当**没有任何边引用它**时才允许——被引用过的条目
   *   硬删会让别人的双链变悬空，直接拒绝（`referenced`）。硬删会一并删掉
   *   该 id 的全部版次行、FTS 行、边，以及版次文件目录。
   */
  async remove(id: string, options: { hard?: boolean } = {}): Promise<RemoveResult> {
    const raw = this.persistence.knowledge.raw
    const latest = raw
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ? AND is_latest = 1`)
      .get(id) as EntryRow | undefined
    if (latest === undefined) {
      throw new PrismError('not_found', `条目不存在: ${id}`)
    }

    const refCount = (
      raw
        .prepare(
          `SELECT COUNT(*) AS c FROM knowledge_edges WHERE (from_id = ? OR to_id = ?) AND from_id != to_id`,
        )
        .get(id, id) as { c: number }
    ).c

    // 硬删：有引用直接拒绝（不静默破坏别人的双链）
    if (options.hard === true && refCount > 0) {
      throw new PrismError(
        'referenced',
        `条目被 ${refCount} 条边引用，禁止硬删（先解除引用，或用默认软删）: ${id}`,
        { id, references: refCount },
      )
    }

    const nowIso = this.#now().toISOString()

    if (options.hard !== true) {
      // BLK-2：软删状态必须写进版次文件 frontmatter——否则 reindex（以文件为真相）
      // 重建时 status 由 is_latest 推导，deprecated 会「复活」。
      // 仅限自有型：引用型（origin='indexed'）的 path 指向**项目原件**，绝不改写用户
      // 文件（A3 红线：只读项目文件）；其软删状态只存 DB——reindex 不重建引用型行
      // （见 reindex 的 origin='owned' 过滤），不会复活。
      if (latest.origin === 'owned') {
        const fileText = readContentFile(latest.path)
        if (fileText !== null) {
          const { data, body } = splitFrontmatter(fileText)
          if (data !== null) {
            writeFileSync(latest.path, renderMarkdownFile({ ...data, status: 'deprecated' }, body), 'utf-8')
          }
        }
      }
      raw
        .prepare(`UPDATE knowledge_entries SET status = 'deprecated', updated_at = ? WHERE id = ? AND is_latest = 1`)
        .run(nowIso, id)
      await this.audit.record({
        type: 'knowledge.deprecated',
        knowledge_id: id,
        layer: latest.layer,
        source: 'manual',
      })
      return { id, mode: 'soft', references: refCount }
    }

    // 硬删：收集自有型条目的文件路径（事务外删除文件）
    // **引用型的 path 指向项目原件，绝不删除**——删索引是 Prism 的事，删用户文件不是。
    const rows = raw
      .prepare("SELECT rowid, path, origin FROM knowledge_entries WHERE id = ?")
      .all(id) as Array<{ rowid: number; path: string; origin: string }>
    await this.persistence.knowledge.run((tx) => {
      tx.exec('BEGIN IMMEDIATE')
      try {
        for (const row of rows) tx.prepare('DELETE FROM kb_fts WHERE rowid = ?').run(row.rowid)
        tx.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id)
        tx.prepare('DELETE FROM knowledge_edges WHERE from_id = ? OR to_id = ?').run(id, id)
        tx.exec('COMMIT')
      } catch (error) {
        try {
          tx.exec('ROLLBACK')
        } catch {
          // 事务已终止时忽略
        }
        throw error
      }
    })
    // 只删 Prism 自己写下的版次文件目录；引用型跳过（项目文件是用户的资产）
    const { rm } = await import('node:fs/promises')
    for (const row of rows) {
      if (row.origin !== 'owned') continue
      try {
        await rm(dirname(row.path), { recursive: true, force: true })
      } catch {
        // 文件已不在 → 忽略
      }
    }
    await this.audit.record({ type: 'knowledge.deleted', knowledge_id: id, layer: latest.layer })
    return { id, mode: 'hard', references: 0 }
  }

  // ===== reindex（Z2：以文件为真相重建索引） =====

  /**
   * 扫描 `<knowledgeDir>` 下全部 `v<NN>.md` 版次文件，按 frontmatter 重建
   * knowledge_entries 与 kb_fts。**不修改任何正文文件**；索引表整体清空重建，
   * 故能收敛手工编辑（改标题/标签/归属）与外部迁移造成的漂移。
   *
   * frontmatter 必填：id/title/type/layer/book/version；owner 缺失时由路径反解补齐。
   */
  async reindex(): Promise<ReindexReport> {
    const files = this.#scanVersionFiles()
    const errors: ReindexReport['errors'] = []
    let indexed = 0

    // 先全量解析：is_latest 需按 id 的 max(version) 判定（文件 frontmatter 恒记 active）
    const parsedRows: ReindexRow[] = []
    for (const file of files) {
      const parsed = this.#parseVersionFile(file)
      if (!parsed.ok) {
        errors.push({ path: file, reason: parsed.reason })
        continue
      }
      parsedRows.push(parsed.row)
    }
    const latestByid = new Map<string, number>()
    for (const row of parsedRows) {
      const cur = latestByid.get(row.id)
      if (cur === undefined || row.version > cur) latestByid.set(row.id, row.version)
    }

    await this.persistence.knowledge.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      try {
        // **只重建自有型**（origin='owned'）：引用型条目的真相在项目文件，
        // 不产生版次文件、不在本次扫描范围内，必须原样保留（QA BLK-1）。
        raw.exec(
          `DELETE FROM kb_fts WHERE rowid IN (SELECT rowid FROM knowledge_entries WHERE origin = 'owned')`,
        )
        raw.exec(`DELETE FROM knowledge_edges WHERE from_id IN (SELECT id FROM knowledge_entries WHERE origin = 'owned')`)
        raw.exec(`DELETE FROM knowledge_entries WHERE origin = 'owned'`)
        const insert = raw.prepare(
          `INSERT INTO knowledge_entries
           (id, version, is_latest, title, type, layer, owner, book, module, status, risk, confidence,
            freshness, visibility, tags, path, content_hash, origin, overrides, supersedes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owned', ?, ?, ?, ?)`,
        )
        for (const r of parsedRows) {
          const isLatest = latestByid.get(r.id) === r.version
          // 最新版沿用文件记录的 status（软删不复活）；历史版恒 superseded
          const status = isLatest ? r.status : 'superseded'
          const supersedes = isLatest ? null : `${r.id}@v${r.version - 1}`
          insert.run(
            r.id,
            r.version,
            isLatest ? 1 : 0,
            r.title,
            r.type,
            r.layer,
            r.owner,
            r.book,
            r.module,
            status,
            r.risk,
            r.confidence,
            r.freshness,
            r.visibility,
            JSON.stringify(r.tags),
            r.path,
            r.contentHash,
            JSON.stringify(r.overrides),
            supersedes,
            r.createdAt,
            r.updatedAt,
          )
          const rowid = Number(
            (raw.prepare('SELECT rowid FROM knowledge_entries WHERE id = ? AND version = ?').get(r.id, r.version) as { rowid: number }).rowid,
          )
          indexEntry(raw, rowid, r.body, bigram(`${r.title}\n${r.body}`))
          indexed++
        }
        // 边表同源重建（双链 + overrides；文件为真相）
        const latestRows = parsedRows.filter((r) => latestByid.get(r.id) === r.version)
        for (const r of latestRows) {
          this.#writeEdges(raw, r.id, { content: r.body, overrides: r.overrides, nowIso: r.updatedAt })
        }
        raw.exec('COMMIT')
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          // 事务已终止时忽略
        }
        throw error
      }
    })

    return { scanned: files.length, indexed, skipped: errors.length, errors }
  }

  /** 递归收集 `<knowledgeDir>` 下所有 `v<NN>.md`（跳过最新版副本 `<id>.md`）。 */
  #scanVersionFiles(): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && /^v\d+\.md$/.test(entry.name)) out.push(full)
      }
    }
    walk(this.knowledgeDir)
    return out.sort()
  }

  /** 解析单个版次文件为索引行（失败返回原因，不抛）。 */
  #parseVersionFile(file: string): { ok: true; row: ReindexRow } | { ok: false; reason: string } {
    let raw: string
    try {
      raw = readFileSync(file, 'utf-8')
    } catch (error) {
      return { ok: false, reason: `读取失败: ${error instanceof Error ? error.message : String(error)}` }
    }
    const { data, body } = splitFrontmatter(raw)
    if (data === null) return { ok: false, reason: '缺 frontmatter' }
    const str = (key: string): string | undefined =>
      typeof data[key] === 'string' && (data[key] as string).trim() !== '' ? (data[key] as string) : undefined
    const id = str('id')
    const title = str('title')
    const type = str('type')
    const layer = str('layer') as Layer | undefined
    const book = str('book')
    if (id === undefined || title === undefined || type === undefined || layer === undefined || book === undefined) {
      return { ok: false, reason: 'frontmatter 缺必填字段（id/title/type/layer/book）' }
    }
    if (!LAYERS.includes(layer)) return { ok: false, reason: `非法 layer: ${layer}` }
    const version = typeof data['version'] === 'number' ? data['version'] : Number(str('version'))
    if (!Number.isInteger(version) || version < 1) return { ok: false, reason: 'version 非正整数' }
    const moduleRaw = str('module')
    const owner = str('owner') ?? ownerFromPath(this.knowledgeDir, file) ?? null
    const tags = Array.isArray(data['tags'])
      ? (data['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : []
    const overrides = Array.isArray(data['overrides'])
      ? (data['overrides'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : []
    const nowIso = this.#now().toISOString()
    return {
      ok: true,
      row: {
        id,
        version,
        title,
        type,
        layer,
        owner,
        book,
        module: moduleRaw ?? '',
        status: str('status') === 'deprecated' ? 'deprecated' : 'active',
        risk: str('risk') ?? 'low',
        confidence: typeof data['confidence'] === 'number' ? data['confidence'] : 0.5,
        freshness: typeof data['freshness'] === 'number' ? data['freshness'] : 1.0,
        visibility: str('visibility') ?? layer,
        tags,
        overrides,
        contentHash: createHash('sha256').update(body, 'utf-8').digest('hex'),
        body,
        path: file,
        createdAt: str('created') ?? nowIso,
        updatedAt: str('updated') ?? nowIso,
      },
    }
  }

  // ===== search =====

  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (typeof query?.q !== 'string' || query.q.trim() === '') {
      throw new PrismError('bad_request', '检索词 q 必填')
    }
    const match = toMatchExpression(query.q)
    if (match === '') {
      throw new PrismError('bad_request', '检索词无有效词元')
    }
    const limit = Math.max(1, Math.floor(query.limit ?? 10))

    // owner 只存在于 project/role 层；未指定 layers 时默认限定这两层
    let layers = this.#validateLayers(query.layers)
    if (layers === null && query.owner !== undefined) layers = ['project', 'role']

    const clauses: string[] = []
    const params: string[] = []
    if (!query.all_versions) {
      clauses.push("e.is_latest = 1 AND e.status != 'deprecated'")
    }
    if (layers) {
      clauses.push(`e.layer IN (${layers.map(() => '?').join(', ')})`)
      params.push(...layers)
    }
    // B3：visibility 过滤（opt-in，不传即不过滤，保证既有行为逐字节不变）
    if (query.visibilities !== undefined && query.visibilities.length > 0) {
      clauses.push(`e.visibility IN (${query.visibilities.map(() => '?').join(', ')})`)
      params.push(...query.visibilities)
    }
    if (query.book !== undefined) {
      clauses.push('e.book = ?')
      params.push(query.book)
    }
    if (query.module !== undefined) {
      // '_inbox' 视为未归模块（DB 存 ''）
      clauses.push('e.module = ?')
      params.push(query.module === INBOX_DIR ? '' : query.module)
    }
    if (query.owner !== undefined) {
      // owner 列优先（Z1）；老库列为 NULL 时回落 path 前缀匹配（owner 必为路径第二段）
      const targetLayers: readonly Layer[] = layers ?? ['project', 'role']
      const patterns = targetLayers.map(
        (layer) => escapeLike(join(this.knowledgeDir, layer, query.owner ?? '')) + escapeLike(sep) + '%',
      )
      clauses.push(
        `(e.owner = ? OR (e.owner IS NULL AND (${patterns.map(() => `e.path LIKE ? ESCAPE '\\'`).join(' OR ')})))`,
      )
      params.push(query.owner, ...patterns)
    }

    const raw = this.persistence.knowledge.raw
    const hits = searchFts(raw, { match, where: clauses.join(' AND '), params, limit })
    if (hits.length === 0) return []

    const placeholders = hits.map(() => '?').join(', ')
    const rows = raw
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE rowid IN (${placeholders})`)
      .all(...hits.map((h) => h.rowid)) as unknown as EntryRow[]
    const byRowid = new Map(rows.map((r) => [r.rowid, r]))
    const results: SearchResult[] = []
    for (const hit of hits) {
      const row = byRowid.get(hit.rowid)
      if (row) results.push(this.#toSearchResult(raw, row, hit.score, query.q))
    }
    return results
  }

  // ===== get =====

  async get(id: string, version?: number): Promise<KnowledgeEntry | null> {
    const raw = this.persistence.knowledge.raw
    const row =
      version === undefined
        ? (raw
            .prepare(
              `SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ? AND is_latest = 1`,
            )
            .get(id) as EntryRow | undefined)
        : (raw
            .prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ? AND version = ?`)
            .get(id, version) as EntryRow | undefined)
    if (!row) return null
    return this.#toEntry(raw, row)
  }

  // ===== tree =====

  /**
   * 全量目录（最新版）：带出入度的轻量条目列表，供星图与下钻渲染。
   * 与 search 的区别是不需要检索词；上限 2000（超大库时分页/截断）。
   */
  async catalog(
    options: {
      layer?: Layer
      owner?: string
      book?: string
      limit?: number
      /** B3：按 visibility 过滤（opt-in；不传即不过滤） */
      visibilities?: Array<'global' | 'project' | 'role'>
    } = {},
  ): Promise<CatalogEntry[]> {
    if (options.layer !== undefined) this.#validateLayers([options.layer])
    const clauses = ["is_latest = 1 AND status != 'deprecated'"]
    const params: string[] = []
    if (options.visibilities !== undefined && options.visibilities.length > 0) {
      clauses.push(`visibility IN (${options.visibilities.map(() => '?').join(', ')})`)
      params.push(...options.visibilities)
    }
    if (options.layer !== undefined) {
      clauses.push('layer = ?')
      params.push(options.layer)
    }
    if (options.book !== undefined) {
      clauses.push('book = ?')
      params.push(options.book)
    }
    if (options.owner !== undefined) {
      clauses.push('owner = ?')
      params.push(options.owner)
    }
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 2000)), 5000)
    const raw = this.persistence.knowledge.raw
    const rows = raw
      .prepare(
        `SELECT id, version, title, type, layer, owner, book, module, status, risk, tags, path, origin, updated_at
         FROM knowledge_entries WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: string
      version: number
      title: string
      type: string
      layer: string
      owner: string | null
      book: string
      module: string
      status: string
      risk: string
      tags: string
      path: string
      origin: string
      updated_at: string
    }>

    // 出入度一次性聚合（避免逐条查询）
    const degreeRows = raw
      .prepare(
        `SELECT id, SUM(indeg) AS indeg, SUM(outdeg) AS outdeg FROM (
           SELECT to_id AS id, COUNT(*) AS indeg, 0 AS outdeg FROM knowledge_edges GROUP BY to_id
           UNION ALL
           SELECT from_id AS id, 0 AS indeg, COUNT(*) AS outdeg FROM knowledge_edges GROUP BY from_id
         ) GROUP BY id`,
      )
      .all() as Array<{ id: string; indeg: number; outdeg: number }>
    const degree = new Map(degreeRows.map((r) => [r.id, r]))

    return rows.map((row) => {
      const owner = row.owner ?? ownerFromPath(this.knowledgeDir, row.path)
      const d = degree.get(row.id)
      return {
        id: row.id,
        version: row.version,
        title: row.title,
        type: row.type as EntryType,
        layer: row.layer as Layer,
        ...(owner !== undefined ? { owner } : {}),
        book: row.book,
        module: row.module,
        status: row.status as KnowledgeEntry['status'],
        risk: row.risk,
        tags: parseStringArray(row.tags),
        origin: (row.origin as 'owned' | 'indexed' | undefined) ?? 'owned',
        path: row.path,
        in_degree: d?.indeg ?? 0,
        out_degree: d?.outdeg ?? 0,
        updated_at: row.updated_at,
      }
    })
  }

  async tree(layer?: Layer, owner?: string): Promise<BookNode[]> {
    this.#validateLayers(layer ? [layer] : undefined)
    const clauses = ["is_latest = 1 AND status != 'deprecated'"]
    const params: string[] = []
    if (layer !== undefined) {
      clauses.push('layer = ?')
      params.push(layer)
    }
    if (owner !== undefined) {
      // owner 列优先（Z1）；老库列为 NULL 时回落 path 前缀匹配
      const targetLayers: readonly Layer[] = layer !== undefined ? [layer] : ['project', 'role']
      const patterns = targetLayers.map(
        (l) => escapeLike(join(this.knowledgeDir, l, owner)) + escapeLike(sep) + '%',
      )
      clauses.push(
        `(owner = ? OR (owner IS NULL AND (${patterns.map(() => `path LIKE ? ESCAPE '\\'`).join(' OR ')})))`,
      )
      params.push(owner, ...patterns)
    }
    const raw = this.persistence.knowledge.raw
    const rows = raw
      .prepare(
        `SELECT layer, owner, book, module, path FROM knowledge_entries WHERE ${clauses.join(' AND ')}`,
      )
      .all(...params) as Array<{
      layer: string
      owner: string | null
      book: string
      module: string
      path: string
    }>

    interface BookAgg {
      layer: Layer
      owner?: string
      book: string
      modules: Map<string, number>
      total: number
    }
    const books = new Map<string, BookAgg>()
    for (const row of rows) {
      const rowLayer = row.layer as Layer
      // owner 列优先；老库 NULL → path 反解兜底
      const rowOwner = row.owner ?? ownerFromPath(this.knowledgeDir, row.path)
      const key = `${rowLayer}|${rowOwner ?? ''}|${row.book}`
      let agg = books.get(key)
      if (!agg) {
        agg = { layer: rowLayer, owner: rowOwner, book: row.book, modules: new Map(), total: 0 }
        books.set(key, agg)
      }
      const moduleName = row.module === '' ? INBOX_DIR : row.module
      agg.modules.set(moduleName, (agg.modules.get(moduleName) ?? 0) + 1)
      agg.total++
    }

    return Array.from(books.values())
      .sort(
        (a, b) =>
          a.layer.localeCompare(b.layer) ||
          (a.owner ?? '').localeCompare(b.owner ?? '') ||
          a.book.localeCompare(b.book),
      )
      .map((agg) => ({
        layer: agg.layer,
        ...(agg.owner !== undefined ? { owner: agg.owner } : {}),
        book: agg.book,
        modules: Array.from(agg.modules.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) =>
            a.name === INBOX_DIR ? 1 : b.name === INBOX_DIR ? -1 : a.name.localeCompare(b.name),
          ),
        total: agg.total,
      }))
  }

  // ===== stats =====

  async stats(): Promise<KbStats> {
    const raw = this.persistence.knowledge.raw
    const rows = raw
      .prepare(
        'SELECT layer, owner, book, module, type, path FROM knowledge_entries WHERE is_latest = 1',
      )
      .all() as Array<{
      layer: string
      owner: string | null
      book: string
      module: string
      type: string
      path: string
    }>

    const layers: Record<Layer, number> = { global: 0, project: 0, role: 0 }
    const books = new Set<string>()
    const byType: Record<string, number> = {}
    for (const row of rows) {
      const l = row.layer as Layer
      layers[l] = (layers[l] ?? 0) + 1
      const owner = row.owner ?? ownerFromPath(this.knowledgeDir, row.path)
      books.add(`${row.layer}|${owner ?? ''}|${row.book}`)
      byType[row.type] = (byType[row.type] ?? 0) + 1
    }
    return { layers, books: books.size, entries: rows.length, by_type: byType }
  }

  // ===== graph（单一边表 + 多视图，D8） =====

  /**
   * 图谱邻域/概览查询。
   * - 不给 id：返回全图概览（按度数降序，受 limit 截断）
   * - 给 id：以该节点为中心做 BFS 邻域（depth 跳，默认 1）
   * 边方向按**无向**遍历（引用/覆盖是双向可发现的联系）。
   */
  async graph(query: GraphQuery = {}): Promise<GraphView> {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 50)), 500)
    const depth = Math.min(Math.max(1, Math.floor(query.depth ?? 1)), 3)
    const relations = this.#validateRelations(query.relations)
    const raw = this.persistence.knowledge.raw
    const relFilter =
      relations === null ? '' : ` AND relation IN (${relations.map(() => '?').join(', ')})`
    const relParams = relations ?? []

    // 书/模块内视图（书详情、模块详情页）：先把「允许的节点」算出来，再过滤边
    // 说明：过滤只影响返回的子图，不改变边表本身（边是全局的）
    const allowedIds = this.#allowedNodeIds(raw, query)

    const nodeIds = new Set<string>()
    const edges: KnowledgeEdge[] = []
    let truncated = false

    const pushEdges = (rows: EdgeRow[]): void => {
      for (const row of rows) {
        edges.push({
          from_id: row.from_id,
          to_id: row.to_id,
          relation: row.relation as EdgeRelation,
          confidence: row.confidence as EdgeConfidence,
          weight: row.weight,
          source: row.source,
          created_at: row.created_at,
        })
        nodeIds.add(row.from_id)
        nodeIds.add(row.to_id)
      }
    }

    if (query.id === undefined) {
      // 概览：**以节点表为准**（含孤立条目——书内视图必须看到所有条目），
      // 按度数降序排；再取两端都在集合内的边作装饰。
      const degRows = raw
        .prepare(
          `SELECT id, SUM(d) AS degree FROM (
             SELECT from_id AS id, COUNT(*) AS d FROM knowledge_edges GROUP BY from_id
             UNION ALL
             SELECT to_id AS id, COUNT(*) AS d FROM knowledge_edges GROUP BY to_id
           ) GROUP BY id`,
        )
        .all() as Array<{ id: string; degree: number }>
      const degree = new Map(degRows.map((r) => [r.id, r.degree]))

      // 候选节点：有限定条件 → 用限定集；否则用条目全表
      let candidateIds: string[]
      if (allowedIds !== null) {
        candidateIds = [...allowedIds]
      } else {
        const entryRows = raw
          .prepare('SELECT id FROM knowledge_entries WHERE is_latest = 1')
          .all() as Array<{ id: string }>
        candidateIds = entryRows.map((r) => r.id)
      }
      candidateIds.sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b))
      const topIds = candidateIds.slice(0, limit)
      truncated = candidateIds.length > topIds.length
      if (topIds.length === 0) return { nodes: [], edges: [], truncated: false }

      const placeholders = topIds.map(() => '?').join(', ')
      const rows = raw
        .prepare(
          `SELECT * FROM knowledge_edges
           WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})${relFilter}
           ORDER BY from_id, relation, to_id`,
        )
        .all(...topIds, ...topIds, ...relParams) as unknown as EdgeRow[]
      // 节点集 = 全部候选（含孤立条目，边只作装饰）
      for (const id of topIds) nodeIds.add(id)
      // 边两端都必须在返回的节点集内（子图自洽）
      const topSet = new Set(topIds)
      pushEdges(rows.filter((r) => topSet.has(r.from_id) && topSet.has(r.to_id)))
    } else {
      // 邻域 BFS（无向）
      const visited = new Set<string>([query.id])
      let frontier = [query.id]
      for (let d = 0; d < depth && frontier.length > 0; d++) {
        if (nodeIds.size >= limit) {
          truncated = true
          break
        }
        const placeholders = frontier.map(() => '?').join(', ')
        const rows = raw
          .prepare(
            `SELECT * FROM knowledge_edges
             WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))${relFilter}
             ORDER BY from_id, relation, to_id`,
          )
          .all(...frontier, ...frontier, ...relParams) as unknown as EdgeRow[]
        const next: string[] = []
        for (const row of rows) {
          // 限定书/模块：越界节点不入子图（避免把别的书的内容带进来）
          if (allowedIds !== null && (!allowedIds.has(row.from_id) || !allowedIds.has(row.to_id))) {
            continue
          }
          edges.push({
            from_id: row.from_id,
            to_id: row.to_id,
            relation: row.relation as EdgeRelation,
            confidence: row.confidence as EdgeConfidence,
            weight: row.weight,
            source: row.source,
            created_at: row.created_at,
          })
          for (const id of [row.from_id, row.to_id]) {
            if (!visited.has(id)) {
              visited.add(id)
              nodeIds.add(id)
              next.push(id)
              if (nodeIds.size > limit) truncated = true
            }
          }
        }
        frontier = next
      }
      nodeIds.add(query.id)
    }

    // 去重边（邻域查询可能重复命中）
    const edgeKey = (e: KnowledgeEdge): string => `${e.from_id}\u0000${e.to_id}\u0000${e.relation}`
    const uniqueEdges = [...new Map(edges.map((e) => [edgeKey(e), e])).values()]
    const nodes = this.#loadGraphNodes(raw, [...nodeIds])
    return {
      nodes,
      edges: uniqueEdges,
      ...(query.id !== undefined ? { root: query.id } : {}),
      truncated,
    }
  }

  /** 两节点最短路径（BFS，无向；边类型可过滤）。不可达 → null。 */
  async path(fromId: string, toId: string, relations?: EdgeRelation[]): Promise<GraphPath | null> {
    if (fromId === toId) {
      return { nodes: [fromId], edges: [] }
    }
    const rels = this.#validateRelations(relations)
    const raw = this.persistence.knowledge.raw
    const relFilter = rels === null ? '' : ` AND relation IN (${rels.map(() => '?').join(', ')})`
    const relParams = rels ?? []

    const prev = new Map<string, { from: string; edge: KnowledgeEdge }>()
    const visited = new Set<string>([fromId])
    let frontier = [fromId]
    while (frontier.length > 0) {
      const placeholders = frontier.map(() => '?').join(', ')
      const rows = raw
        .prepare(
          `SELECT * FROM knowledge_edges
           WHERE (from_id IN (${placeholders}) OR to_id IN (${placeholders}))${relFilter}`,
        )
        .all(...frontier, ...frontier, ...relParams) as unknown as EdgeRow[]
      const next: string[] = []
      for (const row of rows) {
        const edge: KnowledgeEdge = {
          from_id: row.from_id,
          to_id: row.to_id,
          relation: row.relation as EdgeRelation,
          confidence: row.confidence as EdgeConfidence,
          weight: row.weight,
          source: row.source,
          created_at: row.created_at,
        }
        for (const [a, b] of [
          [row.from_id, row.to_id],
          [row.to_id, row.from_id],
        ] as const) {
          if (!frontier.includes(a) || visited.has(b)) continue
          visited.add(b)
          prev.set(b, { from: a, edge })
          if (b === toId) return this.#buildPath(prev, fromId, toId)
          next.push(b)
        }
      }
      frontier = next
    }
    return null
  }

  #buildPath(
    prev: Map<string, { from: string; edge: KnowledgeEdge }>,
    fromId: string,
    toId: string,
  ): GraphPath {
    const nodes: string[] = [toId]
    const edges: KnowledgeEdge[] = []
    let cur = toId
    while (cur !== fromId) {
      const step = prev.get(cur)
      if (step === undefined) break
      edges.unshift(step.edge)
      nodes.unshift(step.from)
      cur = step.from
    }
    return { nodes, edges }
  }

  /**
   * 计算「允许出现在子图里的节点 id」集合（书/模块内视图用）。
   * 无任何过滤 → null（表示全库）；有过滤但无命中 → 空集（子图为空）。
   */
  #allowedNodeIds(raw: DatabaseSync, query: GraphQuery): Set<string> | null {
    const hasFilter =
      query.book !== undefined ||
      query.layer !== undefined ||
      query.owner !== undefined ||
      query.module !== undefined
    if (!hasFilter) return null
    const clauses = ["is_latest = 1 AND status != 'deprecated'"]
    const params: string[] = []
    if (query.layer !== undefined) {
      clauses.push('layer = ?')
      params.push(query.layer)
    }
    if (query.book !== undefined) {
      clauses.push('book = ?')
      params.push(query.book)
    }
    if (query.owner !== undefined) {
      clauses.push('owner = ?')
      params.push(query.owner)
    }
    if (query.module !== undefined) {
      clauses.push('module = ?')
      params.push(query.module === INBOX_DIR ? '' : query.module)
    }
    const rows = raw
      .prepare(`SELECT id FROM knowledge_entries WHERE ${clauses.join(' AND ')}`)
      .all(...params) as Array<{ id: string }>
    return new Set(rows.map((r) => r.id))
  }

  /** 校验关系类型过滤（undefined → null 表示不过滤）。 */
  #validateRelations(relations?: EdgeRelation[]): EdgeRelation[] | null {
    if (relations === undefined || relations.length === 0) return null
    for (const r of relations) {
      if (!EDGE_RELATIONS.includes(r)) {
        throw new PrismError('bad_request', `非法关系类型: ${String(r)}`, {
          relation: r,
          allowed: EDGE_RELATIONS,
        })
      }
    }
    return [...relations]
  }

  /** 批量装载图谱节点（含入度/出度）；id 不存在于条目表时跳过（悬空引用）。 */
  #loadGraphNodes(raw: DatabaseSync, ids: string[]): GraphNode[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = raw
      .prepare(
        `SELECT id, title, type, layer, owner, book, module FROM knowledge_entries
         WHERE id IN (${placeholders}) AND is_latest = 1`,
      )
      .all(...ids) as Array<{
      id: string
      title: string
      type: string
      layer: string
      owner: string | null
      book: string
      module: string
    }>
    const degRows = raw
      .prepare(
        `SELECT id, SUM(indeg) AS indeg, SUM(outdeg) AS outdeg FROM (
           SELECT to_id AS id, COUNT(*) AS indeg, 0 AS outdeg FROM knowledge_edges GROUP BY to_id
           UNION ALL
           SELECT from_id AS id, 0 AS indeg, COUNT(*) AS outdeg FROM knowledge_edges GROUP BY from_id
         ) GROUP BY id`,
      )
      .all() as Array<{ id: string; indeg: number; outdeg: number }>
    const deg = new Map(degRows.map((r) => [r.id, r]))
    return rows
      .map((row) => {
        const d = deg.get(row.id)
        return {
          id: row.id,
          title: row.title,
          type: row.type as EntryType,
          layer: row.layer as Layer,
          ...(row.owner !== null ? { owner: row.owner } : {}),
          book: row.book,
          module: row.module,
          in_degree: d?.indeg ?? 0,
          out_degree: d?.outdeg ?? 0,
        }
      })
      .sort((a, b) => b.in_degree + b.out_degree - (a.in_degree + a.out_degree) || a.id.localeCompare(b.id))
  }

  // ===== 私有：校验与映射 =====

  #validateLayers(layers?: Layer[]): Layer[] | null {
    if (!layers || layers.length === 0) return null
    for (const l of layers) {
      if (!LAYERS.includes(l)) {
        throw new PrismError('bad_request', `非法层: ${String(l)}`, { layer: l })
      }
    }
    return [...layers]
  }

  #validateAndNormalize(input: DepositInput): NormalizedDeposit {
    // 运行时视角读取（HTTP 层可能传残缺对象，类型层面必填不代表运行时存在）
    const rawInput = input as unknown as Record<string, unknown>
    const bad = (message: string, details?: Record<string, unknown>): PrismError =>
      new PrismError('bad_request', message, details)

    // 必填字段（§3.5：title/type/layer/book/content）
    if (typeof rawInput.title !== 'string' || (rawInput.title as string).trim() === '') {
      throw bad('title 必填')
    }
    if (typeof rawInput.content !== 'string' || (rawInput.content as string).trim() === '') {
      throw bad('content 必填')
    }
    if (typeof rawInput.book !== 'string' || (rawInput.book as string).trim() === '') {
      throw bad('book 必填')
    }
    if (typeof rawInput.layer !== 'string' || !LAYERS.includes(rawInput.layer as Layer)) {
      throw bad(`layer 必填且须为 ${LAYERS.join('/')}`)
    }
    if (typeof rawInput.type !== 'string' || !ENTRY_TYPES.includes(rawInput.type as EntryType)) {
      throw bad(`type 必填且须为 ${ENTRY_TYPES.join('/')}`, { type: rawInput.type })
    }

    const layer = rawInput.layer as Layer
    const title = (rawInput.title as string).trim()

    // owner 规则：project/role 必填；global 不允许（design §3.3）
    const rawOwner = rawInput.owner
    const owner = typeof rawOwner === 'string' && rawOwner.trim() !== '' ? rawOwner.trim() : undefined
    if (layer !== 'global' && owner === undefined) throw bad(`${layer} 层必须提供 owner`)
    if (layer === 'global' && owner !== undefined) throw bad('global 层不允许 owner')

    // 段名合法（§3.5）
    const book = (rawInput.book as string).trim()
    if (!isValidSegment(book)) throw bad(`非法 book 名: ${String(rawInput.book)}`)
    if (owner !== undefined && !isValidSegment(owner)) throw bad(`非法 owner 名: ${owner}`)
    const rawModule = rawInput.module
    const moduleName =
      typeof rawModule === 'string' && rawModule.trim() !== '' ? rawModule.trim() : ''
    if (moduleName === INBOX_DIR) throw bad(`module 不能使用保留名 ${INBOX_DIR}`)
    if (moduleName !== '' && !isValidSegment(moduleName)) {
      throw bad(`非法 module 名: ${moduleName}`)
    }

    // id：合法段名，或自动生成
    const rawId = rawInput.id
    const id = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : this.#idFactory()
    if (!isValidSegment(id)) throw bad(`非法 id: ${String(rawId)}`)

    // 数值/枚举默认值
    const risk = rawInput.risk ?? 'low'
    if (typeof risk !== 'string' || !RISKS.includes(risk as (typeof RISKS)[number])) {
      throw bad(`risk 须为 ${RISKS.join('/')}`, { risk })
    }
    const confidence = rawInput.confidence ?? 0.5
    if (
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw bad('confidence 必须在 0..1 之间', { confidence })
    }
    const visibility = rawInput.visibility ?? layer
    if (typeof visibility !== 'string' || !VISIBILITIES.includes(visibility as 'global')) {
      throw bad(`visibility 须为 ${VISIBILITIES.join('/')}`, { visibility })
    }
    if (
      rawInput.tags !== undefined &&
      (!Array.isArray(rawInput.tags) || rawInput.tags.some((t) => typeof t !== 'string'))
    ) {
      throw bad('tags 必须是字符串数组')
    }
    if (
      rawInput.overrides !== undefined &&
      (!Array.isArray(rawInput.overrides) || rawInput.overrides.some((t) => typeof t !== 'string'))
    ) {
      throw bad('overrides 必须是字符串数组')
    }

    return {
      id,
      layer,
      owner,
      book,
      module: moduleName,
      title,
      risk,
      confidence,
      visibility,
      tags: (rawInput.tags as string[] | undefined) ?? [],
      overrides: (rawInput.overrides as string[] | undefined) ?? [],
    }
  }

  #toEntry(raw: DatabaseSync, row: EntryRow): KnowledgeEntry {
    // 自有型：文件为真相（读版次文件正文）。
    // 引用型：path 指向项目原件（可能是 docx/pdf 二进制），正文取 FTS body 里的转换结果。
    const content =
      row.origin === 'indexed'
        ? (bodyForRowid(raw, row.rowid) ?? '')
        : (readEntryContent(row.path) ?? bodyForRowid(raw, row.rowid) ?? '')
    const owner = row.owner ?? ownerFromPath(this.knowledgeDir, row.path)
    const entry: KnowledgeEntry = {
      id: row.id,
      version: row.version,
      title: row.title,
      type: row.type as EntryType,
      layer: row.layer as Layer,
      book: row.book,
      module: row.module,
      status: row.status as KnowledgeEntry['status'],
      risk: row.risk,
      confidence: row.confidence,
      tags: parseStringArray(row.tags),
      content,
      path: row.path,
      content_hash: row.content_hash,
      origin: (row.origin as 'owned' | 'indexed' | undefined) ?? 'owned',
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
    if (row.source_hash !== null && row.source_hash !== undefined) entry.source_hash = row.source_hash
    if (owner !== undefined) entry.owner = owner
    if (row.status === 'superseded') {
      entry.superseded_by = `${row.id}@v${row.version + 1}`
    }
    return entry
  }

  #toSearchResult(
    raw: DatabaseSync,
    row: EntryRow,
    score: number,
    query: string,
  ): SearchResult {
    const owner = row.owner ?? ownerFromPath(this.knowledgeDir, row.path)
    const content =
      row.origin === 'indexed'
        ? (bodyForRowid(raw, row.rowid) ?? '')
        : (readEntryContent(row.path) ?? bodyForRowid(raw, row.rowid) ?? '')
    const source = [
      row.layer,
      ...(owner !== undefined ? [owner] : []),
      row.book,
      row.module === '' ? INBOX_DIR : row.module,
      `${row.id}@v${row.version}`,
    ].join('/')
    return {
      id: row.id,
      version: row.version,
      title: row.title,
      type: row.type as EntryType,
      layer: row.layer as Layer,
      ...(owner !== undefined ? { owner } : {}),
      book: row.book,
      module: row.module,
      excerpt: computeExcerpt(content, query),
      score,
      source,
    }
  }

  /**
   * 关系边：以本条目为源整体重建（先删后插）。
   * 来源 = 正文双链 `[[id]]`（references）+ overrides 声明（overrides）；均为确定性抽取。
   */
  #writeEdges(
    raw: DatabaseSync,
    id: string,
    input: { content: string; overrides: string[]; nowIso: string },
  ): void {
    raw.prepare('DELETE FROM knowledge_edges WHERE from_id = ?').run(id)
    const insert = raw.prepare(
      `INSERT OR REPLACE INTO knowledge_edges
       (from_id, to_id, relation, confidence, weight, source, created_at)
       VALUES (?, ?, ?, 'EXTRACTED', 1.0, ?, ?)`,
    )
    const seen = new Set<string>()
    const add = (to: string, relation: EdgeRelation, source: string): void => {
      if (to === '' || to === id) return
      const key = `${to}\u0000${relation}`
      if (seen.has(key)) return
      seen.add(key)
      insert.run(id, to, relation, source, input.nowIso)
    }
    for (const target of extractWikiLinks(input.content)) add(target, 'references', '[[双链]]')
    for (const target of input.overrides) add(target.trim(), 'overrides', 'overrides')
  }
}

/** 解析 DB 中的 JSON 字符串数组列，容忍损坏数据。 */
function parseStringArray(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

/** 从原文截取摘要：命中查询词的窗口，未命中取开头。 */
function computeExcerpt(content: string, query: string): string {
  const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const lowerContent = content.toLowerCase()
  let start = -1
  let needleLen = 0
  for (const word of query.trim().split(/\s+/)) {
    const needle = word.toLowerCase()
    const pos = lowerContent.indexOf(needle)
    if (pos >= 0) {
      start = pos
      needleLen = needle.length
      break
    }
  }
  if (start < 0) {
    return collapse(content.slice(0, 120))
  }
  const from = Math.max(0, start - 40)
  const to = Math.min(content.length, start + needleLen + 80)
  const prefix = from > 0 ? '…' : ''
  const suffix = to < content.length ? '…' : ''
  return prefix + collapse(content.slice(from, to)) + suffix
}

/** 便捷工厂：默认按 PRISM_HOME 自建持久化与审计。 */
export const createKnowledgeService = (options?: KnowledgeServiceOptions): KnowledgeService =>
  new PrismKnowledgeService(options)
