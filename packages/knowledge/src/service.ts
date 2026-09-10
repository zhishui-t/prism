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
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { AuditLog, openPersistence, PrismError, prismPaths } from '@prism/core'
import type { DatabaseSync } from 'node:sqlite'
import type { PrismPersistence } from '@prism/core'

import { bodyForRowid, ensureKbFts, indexEntry, searchFts } from './index-db.js'
import { renderMarkdownFile, splitFrontmatter, parseFrontmatter } from './frontmatter.js'
import type { FrontmatterData, FrontmatterValue } from './frontmatter.js'
import {
  INBOX_DIR,
  isValidSegment,
  ownerFromPath,
  readContentFile,
  readEntryContent,
  writeEntryFiles,
} from './store.js'
import { bigram, toMatchExpression } from './tokenize.js'
import {
  blobToVector,
  cosine,
  HYBRID_CANDIDATES,
  RRF_K,
  rrfFuse,
  vectorToBlob,
  VECTOR_FLOOR,
  VECTOR_RELATIVE,
} from './vector.js'
import type {
  BookNode,
  BookStructure,
  CatalogEntry,
  DepositInput,
  DepositResult,
  EdgeConfidence,
  EdgeRelation,
  EntryStatus,
  EntryType,
  EntryVersion,
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
  RestoreResult,
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

/**
 * 合法条目状态（F-A4，design-v4 §3.1 ①）：`candidate` 是文档承认的可选中间态，
 * `#parseVersionFile` 必须 4 值全量往返——4 值之外才 warning + 回落 `active`。
 */
const ENTRY_STATUSES: readonly EntryStatus[] = ['candidate', 'active', 'deprecated', 'superseded']

/** 书结构文件名（design §F-A1：`_modules.yaml` + 书级/模块级 `_summary.md`）。 */
const MODULES_FILE = '_modules.yaml'
const SUMMARY_FILE = '_summary.md'

/** 冻结模块 slug 规则（design §F-A1：`[a-z0-9-]+`）。 */
const MODULE_SLUG_RE = /^[a-z0-9-]+$/

/** `_modules.yaml` 用具名 YAML 标量：安全集不加引号，否则 JSON 双引号（可被自研解析器读回）。 */
const PLAIN_YAML_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@()]*$/

/**
 * 引用型（`index`）条目的 `source` 列载荷（F-E2）：`IndexInput` 没有来源字段，
 * 引用型恒记「导入」——与 `index()` 写审计时的 `source: 'import'` 同口径。
 */
const INDEXED_SOURCE_PAYLOAD = { kind: 'import' } as const

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
  /** v7 补列（F-E2）：沉淀来源 JSON（`{kind, ref?, origin_task?}`）；老行为 NULL。 */
  source: string | null
  /** v7 补列（F-E2）：沉淀留痕 JSON（`{subject?, team?, task_id?, at?}`）；老行为 NULL。 */
  deposited_by: string | null
  created_at: string
  updated_at: string
}

const ENTRY_COLUMNS = `rowid, id, version, is_latest, title, type, layer, owner, book, module, status,
  risk, confidence, freshness, visibility, tags, path, content_hash, origin, source_hash,
  overrides, supersedes, source, deposited_by, created_at, updated_at`

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
  /** 文件里记录的 status（BLK-2：软删后 reindex 不能复活；F-A4：4 值全量往返） */
  status: EntryStatus
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
  /** F-E2：`source` 列（v7）载荷文本，从 frontmatter 原样带回；缺省 null */
  source: string | null
  /** F-E2：`deposited_by` 列（v7）载荷文本；缺省 null */
  depositedBy: string | null
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

/** 书结构定位（F-A1/F-A2）：`layer` / 可选 `owner` / `book`。 */
interface BookRef {
  layer: Layer
  owner?: string
  book: string
}

/** `book_structures` 表行（DDL 见 `core/src/persistence/schemas.ts:264`）。 */
interface BookStructureRow {
  layer: string
  book: string
  revision: number
  modules: string
  suggested: string
  frozen_at: string | null
  confirmed_by: string | null
  updated_at: string
}

/** `_modules.yaml` 解析结果（**文件为真相**的部分）。 */
interface ModulesFileState {
  modules: string[]
  inherits: string[]
  revision: number
  frozenAt: string | null
  confirmedBy: string | null
}

/** 推导出的模块建议（F-A1 裁决 #1：`{slug, entries}`，按条目数降序）。 */
interface SuggestedModule {
  slug: string
  entries: number
}

/** 书内条目轻量视图（渲染 summary 与推导 suggested 用）。 */
interface BookEntryLite {
  id: string
  /** 文件层面模块名（未归类 = `_inbox`） */
  module: string
  title: string
  version: number
  updated_at: string
}

export class PrismKnowledgeService implements KnowledgeService {
  readonly home: string
  readonly knowledgeDir: string
  readonly persistence: PrismPersistence
  readonly audit: AuditLog
  readonly #now: () => Date
  readonly #idFactory: () => string
  readonly #ownsPersistence: boolean
  readonly #embed: KnowledgeServiceOptions['embed']
  /** 当前 embedding 模型 id（分档）；检索只比同模型向量。未装配时为 undefined。 */
  readonly #embeddingModel: KnowledgeServiceOptions['embeddingModel']

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
    this.#embed = options.embed
    this.#embeddingModel = options.embeddingModel
    ensureKbFts(this.persistence.knowledge)
  }

  /** 释放内部创建的持久化（注入的连接由注入方负责关闭）。 */
  close(): void {
    if (this.#ownsPersistence) this.persistence.close()
  }

  // ===== deposit =====

  async deposit(input: DepositInput): Promise<DepositResult> {
    const address = this.#validateAndNormalize(input)
    const content = input.content
    const nowIso = this.#now().toISOString()
    const seg = bigram(`${address.title}\n${content}`)
    const contentHash = createHash('sha256').update(content, 'utf-8').digest('hex')
    // F-E2（§3.2 列载荷约定）：`source` = `{...input.source, origin_task?}`；
    // `deposited_by` = `{...input.deposited_by, at}`。**同一对象同时落 frontmatter 与
    // DB 两列**——否则自有型 reindex（以文件为真相）重建后 DB 两列恒空。
    const sourcePayload = buildSourcePayload(input)
    const depositedByPayload =
      input.deposited_by !== undefined ? { ...input.deposited_by, at: nowIso } : undefined
    const frontmatterBase: FrontmatterData = {
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
      ...(sourcePayload !== undefined ? { source: sourcePayload } : {}),
      overrides: address.overrides,
      supersedes: null,
      ...(depositedByPayload !== undefined ? { deposited_by: depositedByPayload } : {}),
    }

    const deposited = await this.persistence.knowledge.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      const snapshots: FileSnapshot[] = []
      try {
        const prev = raw
          .prepare(
            `SELECT version, layer, book, owner, path, content_hash FROM knowledge_entries
             WHERE id = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(address.id) as
          | {
              version: number
              layer: string
              book: string
              owner: string | null
              path: string
              content_hash: string
            }
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
          // 去重：正文哈希与最新版相同 → 不产生新版次（版本只为「内容变化」服务）。
          // 重复导入同一文件不再堆叠 v02/v03…，历史交给 git（Prism 不管版本控制）。
          if (prev.content_hash === contentHash) {
            raw.exec('COMMIT')
            return {
              id: address.id,
              version: prev.version,
              path: prev.path,
              action: 'unchanged' as const,
            }
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
              freshness, visibility, tags, path, content_hash, overrides, supersedes,
              source, deposited_by, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1.0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            // F-E2：v7 两列（载荷见上方 sourcePayload / depositedByPayload）
            sourcePayload !== undefined ? JSON.stringify(sourcePayload) : null,
            depositedByPayload !== undefined ? JSON.stringify(depositedByPayload) : null,
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
        return {
          id: address.id,
          version,
          path: files.versionFile,
          action: prev ? ('updated' as const) : ('created' as const),
        }
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

    // 无实质变更 → 不写审计、不检测冲突、不入队（否则每次重复导入都刷一遍）
    if (deposited.action === 'unchanged') return deposited

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

    // 本地向量（变更 2）：装配了 embedding 才写；失败静默（增强不阻断落库）
    await this.#writeVector(deposited.id, deposited.version, `${address.title}\n${content}`)

    // B2：层间冲突检测（只记录不阻断，§12.3）
    await this.#detectConflicts(this.persistence.knowledge.raw, {
      id: deposited.id,
      layer: address.layer,
      book: address.book,
      module: address.module,
      title: address.title,
      overrides: address.overrides,
      detected_from: 'deposit',
    })

    // 富化（summarize/classify/extract_entities/diagram_ir）改由宿主经 MCP
    // `prism_kb_enrich` 直接回写（工作队列已移除；见 enrich-writeback.ts）。
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
            `SELECT version, source_hash, origin, layer, book, owner, status FROM knowledge_entries
             WHERE id = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(address.id) as
          | {
              version: number
              source_hash: string | null
              origin: string
              layer: string
              book: string
              owner: string | null
              status: string
            }
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
          // 引用型同一行更新（不做版次）；若原先是自有型，转为引用型需显式覆盖整行。
          // **保留 status**：软删是用户的治理动作，源文件内容变化不该让它静默复活
          // （否则 `remove` 对引用型就失去意义——下次 kb sync 就撤销了）。
          // 要恢复须显式 `restore()`。
          raw
            .prepare(
              `UPDATE knowledge_entries SET
                 is_latest = 1, title = ?, type = ?, module = ?, status = ?,
                 tags = ?, path = ?, content_hash = ?, source_hash = ?, origin = 'indexed',
                 source = ?, updated_at = ?
               WHERE id = ? AND version = ?`,
            )
            .run(
              address.title,
              input.type ?? 'doc',
              address.module,
              prev.status === 'deprecated' ? 'deprecated' : 'active',
              JSON.stringify(address.tags),
              input.path,
              createHash('sha256').update(input.content, 'utf-8').digest('hex'),
              input.source_hash,
              // F-E2：引用型来源恒为导入（与下方审计 `source: 'import'` 同口径）
              JSON.stringify(INDEXED_SOURCE_PAYLOAD),
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
              source, created_at, updated_at)
             VALUES (?, 1, 1, ?, ?, ?, ?, ?, ?, 'active', 'low', 0.5, 1.0, 'project', ?, ?, ?, ?, 'indexed',
                     '[]', NULL, ?, ?, ?)`,
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
            // F-E2：v7 source 列（引用型恒为导入）；deposited_by 无来源方 → NULL
            JSON.stringify(INDEXED_SOURCE_PAYLOAD),
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
      // F-A3：引用型写路径**也**检测层间冲突（同 book/module 同名跨层 = 同一知识两处
      // 定义，漏检即失真）。保持「只记录不阻断」；引用型没有 overrides 声明 → 传 []。
      await this.#detectConflicts(this.persistence.knowledge.raw, {
        id: address.id,
        layer: address.layer,
        book: address.book,
        module: address.module,
        title: address.title,
        overrides: [],
        detected_from: 'index',
      })
      // 本地向量（变更 2）：索引型正文即真相副本，同样可向量化
      const latest = this.persistence.knowledge.raw
        .prepare('SELECT version FROM knowledge_entries WHERE id = ? ORDER BY version DESC LIMIT 1')
        .get(address.id) as { version: number } | undefined
      if (latest !== undefined) {
        await this.#writeVector(address.id, latest.version, `${address.title}\n${input.content}`)
      }
    }
    return { id: address.id, action }
  }

  // ===== 层间冲突（B2，§12.3：只记录不阻断） =====

  /**
   * 检测层间冲突：同一 book/module 下**标题相同**的条目跨层共存，
   * 且高层未显式声明 `overrides: [低层ID]` → 记一条 `same_title` 冲突。
   *
   * 层序 `global < project < role`：新条目要与**所有更低层**比对——
   * project 比 global；role 比 global + project（此前只比 global，漏了 project↔role）。
   *
   * 为什么用标题判据：Prism 零 LLM，无法判断「语义冲突」；标题相同是**确定性**
   * 的强信号（同名规则覆盖），且不会误报。只记录，不改状态、不阻断落库。
   *
   * F-A3：`deposit()` 与 `index()`（引用型）**两条写入路径共用**本方法；
   * `detected_from` 只作为审计事件字段留痕——**不加列、不进 `conflicts()` 返回体**
   * （`KnowledgeConflict` 与 `knowledge_conflicts` DDL 均不变，零迁移）。
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
      /** 冲突由哪条写入路径发现（F-A3，仅进审计事件） */
      detected_from: 'deposit' | 'index'
    },
  ): Promise<void> {
    // 更低层集合（按 LAYERS 的层序取前缀；global 无更低层 → 不检查）
    const rank = LAYERS.indexOf(input.layer)
    if (rank <= 0) return
    const lowerLayers = LAYERS.slice(0, rank)
    const lows = raw
      .prepare(
        `SELECT id, title, layer FROM knowledge_entries
         WHERE is_latest = 1 AND layer IN (${lowerLayers.map(() => '?').join(', ')})
           AND book = ? AND module = ?
           AND status != 'deprecated' AND title = ? AND id != ?`,
      )
      .all(...lowerLayers, input.book, input.module, input.title, input.id) as Array<{
      id: string
      title: string
      layer: string
    }>
    const nowIso = this.#now().toISOString()
    for (const low of lows) {
      // 已显式声明 overrides → 不算冲突（就近覆盖是有意为之）
      if (input.overrides.includes(low.id)) continue
      // 同层不算「层间」冲突（同层同名由别处治理，不在此报告）
      if (low.layer === input.layer) continue
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
      // `detected_from` 只进审计事件（F-A3）：core 的 `AuditEvent` 联合类型只约束
      // 必填字段（`audit-log.ts:141`），附加字段照常落 JSONL；用 `Object.assign`
      // 让附加字段不触发对象字面量的多余属性检查（core 不在本流文件域）。
      await this.audit.record(
        Object.assign(
          {
            type: 'knowledge.conflict_detected' as const,
            high_id: input.id,
            low_id: low.id,
            kind: 'same_title',
          },
          { detected_from: input.detected_from },
        ),
      )
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

  // ===== 书结构与版本历史（F-A1/F-A2/F-B4）=====

  /**
   * 读回书结构（F-A1/F-A2）。
   *
   * 文件为真相：`modules`/`inherits`/`revision`/`frozen_at`/`confirmed_by` 读
   * `_modules.yaml`；`suggested`/`updated_at` 读 `book_structures` 表。`modules`
   * 返回的是**合并后**的清单（父链在前，本地覆盖同名项，见 F-A2 裁决）。
   * 书上既无结构文件、也无表行 → `null`（等价「不存在」）。
   */
  async bookStructure(layer: string, book: string): Promise<BookStructure | null> {
    const ref = this.#locateBook(layer, book)
    if (ref === null) return null
    return this.#readStructure(ref, [], false)
  }

  /**
   * 生成书结构（F-A1，**零 LLM**）：从 `knowledge_entries`（`is_latest=1`，含
   * `_inbox`）+ `knowledge_edges`（同模块邻接度）推导 `suggested`（模块 + 条目数，
   * 按条目数降序），产三份文件：
   * - `<book>/_modules.yaml`（`modules` 沿用已冻结的本地清单，`inherits` 原样保留）
   * - 书级 `<book>/_summary.md`
   * - 每个非空模块 `<book>/<module>/_summary.md`（含 `_inbox`）
   *
   * **幂等**：二次执行三份文件逐字节一致、`revision` 不递增（只有 freeze 递增）。
   * 同步 upsert `book_structures`（`modules` = 继承合并结果，裁决：合并结果落列）。
   */
  async generateBookStructure(input: {
    layer: string
    book: string
    confirmed_by?: string
  }): Promise<{ structure: BookStructure; files: string[] }> {
    const ref = this.#requireBook(input.layer, input.book)
    const dir = this.#bookDir(ref)
    const entries = this.#bookEntries(ref)
    const local = this.#readModulesFile(dir)
    const row = this.#readStructureRow(ref)
    const suggested = deriveSuggested(entries, this.#bookEdgePairs(entries))
    const merged = this.#mergeInheritedModules(ref, local?.inherits ?? [], [], [])
    const localModules = local?.modules ?? (row !== null ? parseStringArray(row.modules) : [])
    const modules = dedupeStrings([...merged.modules, ...localModules])
    const revision = local?.revision ?? row?.revision ?? 0
    const frozenAt = local?.frozenAt ?? row?.frozen_at ?? null
    const confirmedBy = input.confirmed_by ?? local?.confirmedBy ?? row?.confirmed_by ?? null
    const nowIso = this.#now().toISOString()

    mkdirSync(dir, { recursive: true })
    const files: string[] = []
    const modulesFile = join(dir, MODULES_FILE)
    writeFileSync(
      modulesFile,
      renderModulesFile({ layer: ref.layer, book: ref.book, revision, frozenAt, confirmedBy, inherits: local?.inherits ?? [], modules: localModules }),
      'utf-8',
    )
    files.push(modulesFile)
    files.push(...this.#writeSummaries(ref, dir, entries, suggested))

    this.persistence.knowledge.raw
      .prepare(
        `INSERT INTO book_structures (layer, book, revision, modules, suggested, frozen_at, confirmed_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(layer, book) DO UPDATE SET
           revision = excluded.revision, modules = excluded.modules, suggested = excluded.suggested,
           frozen_at = excluded.frozen_at, confirmed_by = excluded.confirmed_by, updated_at = excluded.updated_at`,
      )
      .run(
        ref.layer,
        ref.book,
        revision,
        JSON.stringify(modules),
        JSON.stringify(suggested),
        frozenAt,
        confirmedBy,
        nowIso,
      )

    return {
      structure: {
        layer: ref.layer,
        book: ref.book,
        revision,
        modules,
        suggested,
        inherits: local?.inherits ?? [],
        inherited_from: merged.inheritedFrom,
        frozen_at: frozenAt,
        confirmed_by: confirmedBy,
        updated_at: nowIso,
      },
      files,
    }
  }

  /**
   * 固化模块清单（F-A1）：校验 slug → `revision+1` → 写文件 + 表。
   *
   * 校验（`bad_request`）：非法 slug（须 `[a-z0-9-]+`）、保留名 `_inbox`、
   * **无条目书**（没有任何 `is_latest` 条目时无可冻结内容）。
   * `modules` 省略 → 沿用当前 `_modules.yaml` 的本地清单；仍为空 → 取本次推导建议
   * （即「接受建议」，`_inbox` 不作为可冻结模块）。
   * **只写本地 `modules`**，父链模块不进文件（`inherits` 保持只读合并，F-A2）。
   */
  async freezeBookStructure(input: {
    layer: string
    book: string
    modules?: string[]
    confirmed_by?: string
    note?: string
  }): Promise<BookStructure> {
    const ref = this.#requireBook(input.layer, input.book)
    const dir = this.#bookDir(ref)
    const entries = this.#bookEntries(ref)
    if (entries.length === 0) {
      throw new PrismError('bad_request', `书 ${describeRef(ref)} 没有任何条目，无法冻结结构`, {
        layer: ref.layer,
        book: ref.book,
      })
    }
    const local = this.#readModulesFile(dir)
    const row = this.#readStructureRow(ref)
    const currentLocal = local?.modules ?? (row !== null ? parseStringArray(row.modules) : [])
    const suggested = deriveSuggested(entries, this.#bookEdgePairs(entries))
    const requested =
      input.modules ?? (currentLocal.length > 0 ? currentLocal : suggested.map((s) => s.slug).filter((s) => s !== INBOX_DIR))
    const modules = this.#validateModuleSlugs(requested)

    const inherits = local?.inherits ?? []
    const merged = this.#mergeInheritedModules(ref, inherits, [], [])
    const allModules = dedupeStrings([...merged.modules, ...modules])
    const revision = (local?.revision ?? row?.revision ?? 0) + 1
    const nowIso = this.#now().toISOString()
    const confirmedBy = input.confirmed_by ?? local?.confirmedBy ?? row?.confirmed_by ?? null

    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, MODULES_FILE),
      renderModulesFile({
        layer: ref.layer,
        book: ref.book,
        revision,
        frozenAt: nowIso,
        confirmedBy,
        inherits,
        modules,
      }),
      'utf-8',
    )
    this.#writeSummaries(ref, dir, entries, suggested)

    this.persistence.knowledge.raw
      .prepare(
        `INSERT INTO book_structures (layer, book, revision, modules, suggested, frozen_at, confirmed_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(layer, book) DO UPDATE SET
           revision = excluded.revision, modules = excluded.modules, suggested = excluded.suggested,
           frozen_at = excluded.frozen_at, confirmed_by = excluded.confirmed_by, updated_at = excluded.updated_at`,
      )
      .run(
        ref.layer,
        ref.book,
        revision,
        JSON.stringify(allModules),
        JSON.stringify(suggested),
        nowIso,
        confirmedBy,
        nowIso,
      )

    return {
      layer: ref.layer,
      book: ref.book,
      revision,
      modules: allModules,
      suggested,
      inherits,
      inherited_from: merged.inheritedFrom,
      frozen_at: nowIso,
      confirmed_by: confirmedBy,
      updated_at: nowIso,
    }
  }

  // ===== 书结构私有实现 =====

  /** 书结构定位（`layer` / 可选 `owner` / `book`）。 */
  #bookDir(ref: BookRef): string {
    const parts = [this.knowledgeDir, ref.layer]
    if (ref.layer !== 'global') parts.push(ref.owner ?? '')
    parts.push(ref.book)
    return join(...parts)
  }

  /** 定位书（读路径）：解析不了（不存在/无条目且目录不存） → `null`。 */
  #locateBook(layerRaw: string, bookRaw: string): BookRef | null {
    const layer = this.#parseLayer(layerRaw)
    const book = typeof bookRaw === 'string' ? bookRaw.trim() : ''
    if (!isValidSegment(book)) {
      throw new PrismError('bad_request', `非法 book 名: ${String(bookRaw)}`, { book: bookRaw })
    }
    if (layer === 'global') return { layer, book }
    const owners = this.#bookOwners(layer, book)
    if (owners.length === 0) return null
    if (owners.length > 1) {
      throw new PrismError(
        'bad_request',
        `${layer} 层同名书 ${book} 存在多个 owner（${owners.join('/')}），无法唯一定位`,
        { layer, book, owners },
      )
    }
    return { layer, owner: owners[0]!, book }
  }

  /** 定位书（写路径）：定位不了或书上什么都没有 → `bad_request`（不静默造空结构）。 */
  #requireBook(layerRaw: string, bookRaw: string): BookRef {
    const ref = this.#locateBook(layerRaw, bookRaw)
    const exists =
      ref !== null &&
      (this.#readModulesFile(this.#bookDir(ref)) !== null ||
        this.#readStructureRow(ref) !== null ||
        this.#bookEntries(ref).length > 0)
    if (ref === null || !exists) {
      throw new PrismError(
        'bad_request',
        `书 ${String(layerRaw)}/${String(bookRaw)} 不存在（无条目、无结构文件）`,
        { layer: layerRaw, book: bookRaw },
      )
    }
    return ref
  }

  #parseLayer(value: string): Layer {
    if (!LAYERS.includes(value as Layer)) {
      throw new PrismError('bad_request', `非法层: ${String(value)}`, { layer: value })
    }
    return value as Layer
  }

  /**
   * 书的 owner 候选：优先取条目表的 owner 列（老库 NULL 时按路径反解），
   * 无条目时回落到磁盘上已存在的 `<layer>/<owner>/<book>` 目录。
   */
  #bookOwners(layer: Layer, book: string): string[] {
    const rows = this.persistence.knowledge.raw
      .prepare('SELECT owner, path FROM knowledge_entries WHERE layer = ? AND book = ?')
      .all(layer, book) as Array<{ owner: string | null; path: string }>
    const owners = new Set<string>()
    for (const row of rows) {
      const owner = row.owner ?? ownerFromPath(this.knowledgeDir, row.path)
      if (owner !== undefined && owner !== '') owners.add(owner)
    }
    if (owners.size === 0) {
      try {
        for (const entry of readdirSync(join(this.knowledgeDir, layer), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          if (existsSync(join(this.knowledgeDir, layer, entry.name, book))) owners.add(entry.name)
        }
      } catch {
        // 层目录不存在 → 无候选
      }
    }
    return [...owners].sort()
  }

  /** 书的条目（最新版、非软删；owner 与书一致；含 `_inbox`）。 */
  #bookEntries(ref: BookRef): BookEntryLite[] {
    const rows = this.persistence.knowledge.raw
      .prepare(
        `SELECT id, module, title, version, updated_at, owner, path FROM knowledge_entries
         WHERE layer = ? AND book = ? AND is_latest = 1 AND status != 'deprecated'`,
      )
      .all(ref.layer, ref.book) as Array<{
      id: string
      module: string
      title: string
      version: number
      updated_at: string
      owner: string | null
      path: string
    }>
    return rows
      .filter((row) => (row.owner ?? ownerFromPath(this.knowledgeDir, row.path)) === ref.owner)
      .map((row) => ({
        id: row.id,
        module: row.module === '' ? INBOX_DIR : row.module,
        title: row.title,
        version: row.version,
        updated_at: row.updated_at,
      }))
  }

  /** 同书内边对（两个端点都在这本书的最新版条目里）——`suggested` 的同模块邻接度用。 */
  #bookEdgePairs(entries: BookEntryLite[]): Array<{ from: string; to: string }> {
    if (entries.length === 0) return []
    const ids = entries.map((e) => e.id)
    const rows = this.persistence.knowledge.raw
      .prepare(
        `SELECT from_id, to_id FROM knowledge_edges
         WHERE from_id IN (${ids.map(() => '?').join(', ')})
           AND to_id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids, ...ids) as Array<{ from_id: string; to_id: string }>
    return rows.map((row) => ({ from: row.from_id, to: row.to_id }))
  }

  /** 读 `book_structures` 行。 */
  #readStructureRow(ref: BookRef): BookStructureRow | null {
    const row = this.persistence.knowledge.raw
      .prepare(
        `SELECT layer, book, revision, modules, suggested, frozen_at, confirmed_by, updated_at
         FROM book_structures WHERE layer = ? AND book = ?`,
      )
      .get(ref.layer, ref.book) as BookStructureRow | undefined
    return row ?? null
  }

  /** 读 `_modules.yaml`（不存在/解析不出 modules 数组 → null）。 */
  #readModulesFile(dir: string): ModulesFileState | null {
    const file = join(dir, MODULES_FILE)
    if (!existsSync(file)) return null
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      return null
    }
    const data = parseFrontmatter(text)
    const modules = Array.isArray(data['modules'])
      ? (data['modules'] as unknown[]).filter((m): m is string => typeof m === 'string')
      : []
    const inherits = Array.isArray(data['inherits'])
      ? (data['inherits'] as unknown[]).filter((m): m is string => typeof m === 'string')
      : []
    return {
      modules,
      inherits,
      revision: typeof data['revision'] === 'number' ? data['revision'] : 0,
      frozenAt: typeof data['frozen_at'] === 'string' ? data['frozen_at'] : null,
      confirmedBy: typeof data['confirmed_by'] === 'string' ? data['confirmed_by'] : null,
    }
  }

  /**
   * 递归合并 `inherits`（F-A2）：并集去重、**父在前**、本地同名项覆盖父项。
   * 环 / 缺父 / 缺层 → `PrismError('book_inherit_invalid')`，消息含链路。
   */
  #mergeInheritedModules(
    ref: BookRef,
    inherits: string[],
    chain: string[],
    seen: string[],
  ): { modules: string[]; inheritedFrom: string[] } {
    const selfKey = describeRef(ref)
    const nextChain = [...chain, selfKey]
    const modules: string[] = []
    const inheritedFrom: string[] = []
    for (const raw of inherits) {
      const parent = this.#parseInheritRef(raw)
      const parentKey = describeRef(parent)
      if (nextChain.includes(parentKey)) {
        throw new PrismError(
          'book_inherit_invalid',
          `书结构继承存在环: ${[...nextChain, parentKey].join(' -> ')}`,
          { chain: [...nextChain, parentKey], ref: selfKey },
        )
      }
      if (seen.includes(parentKey)) continue
      const parentStructure = this.#readStructure(parent, nextChain, true)
      if (parentStructure === null) {
        throw new PrismError(
          'book_inherit_invalid',
          `书结构继承缺父: ${selfKey} -> ${parentKey}`,
          { chain: [...nextChain, parentKey], missing: parentKey, ref: selfKey },
        )
      }
      seen.push(parentKey)
      // `inherited_from` = **完整继承链**（根 → 叶）：先父书自己的祖先，再父书本尊。
      for (const ancestor of parentStructure.inherited_from) {
        if (!inheritedFrom.includes(ancestor)) inheritedFrom.push(ancestor)
      }
      if (!inheritedFrom.includes(parentKey)) inheritedFrom.push(parentKey)
      for (const module of parentStructure.modules) {
        if (!modules.includes(module)) modules.push(module)
      }
    }
    return { modules, inheritedFrom }
  }

  /** 解析 `inherits` 项：`<layer>/<book>` 或 project/role 的 `<layer>/<owner>/<book>`。 */
  #parseInheritRef(raw: string): BookRef {
    const parts = String(raw).split('/').filter((p) => p !== '')
    const invalid = (): never => {
      throw new PrismError(
        'book_inherit_invalid',
        `非法继承引用（须 <layer>/<book> 或 <layer>/<owner>/<book>）: ${String(raw)}`,
        { ref: raw },
      )
    }
    if (parts.length !== 2 && parts.length !== 3) return invalid()
    const layer = parts[0]!
    if (!LAYERS.includes(layer as Layer)) return invalid()
    if (parts.length === 2) {
      const book = parts[1]!
      if (!isValidSegment(book)) return invalid()
      if (layer === 'global') return { layer: 'global', book }
      const owners = this.#bookOwners(layer as Layer, book)
      if (owners.length !== 1) {
        throw new PrismError(
          'book_inherit_invalid',
          `继承引用 ${String(raw)} 无法唯一定位（${layer} 层需 <layer>/<owner>/<book>${
            owners.length > 1 ? `；候选 owner: ${owners.join('/')}` : ''
          }）`,
          { ref: raw, owners },
        )
      }
      return { layer: layer as Layer, owner: owners[0]!, book }
    }
    const owner = parts[1]!
    const book = parts[2]!
    if (!isValidSegment(owner) || !isValidSegment(book)) return invalid()
    if (layer === 'global') return invalid()
    return { layer: layer as Layer, owner, book }
  }

  /**
   * 读单本书结构（同步；`asParent` 决定「存在」的判定口径）。
   * - 自身读（`asParent=false`）：文件或表行存在才算「有结构」，否则 `null`；
   * - 父书读（`asParent=true`）：有条目也算存在（只是没有冻结清单，贡献空清单）。
   */
  #readStructure(ref: BookRef, chain: string[], asParent: boolean): BookStructure | null {
    const dir = this.#bookDir(ref)
    const file = this.#readModulesFile(dir)
    const row = this.#readStructureRow(ref)
    const entries = this.#bookEntries(ref)
    if (file === null && row === null && (!asParent || entries.length === 0)) return null

    const inherits = file?.inherits ?? []
    const merged = this.#mergeInheritedModules(ref, inherits, chain, [])
    const localModules = file?.modules ?? (row !== null ? parseStringArray(row.modules) : [])
    const suggested: SuggestedModule[] = row !== null ? parseSuggested(row.suggested) : []
    return {
      layer: ref.layer,
      book: ref.book,
      revision: file?.revision ?? row?.revision ?? 0,
      modules: dedupeStrings([...merged.modules, ...localModules]),
      suggested,
      inherits,
      inherited_from: merged.inheritedFrom,
      frozen_at: file?.frozenAt ?? row?.frozen_at ?? null,
      confirmed_by: file?.confirmedBy ?? row?.confirmed_by ?? null,
      updated_at: row?.updated_at ?? this.#now().toISOString(),
    }
  }

  /** 校验模块 slug 清单（F-A1：`[a-z0-9-]+`；保留名 `_inbox` 不可冻结）。 */
  #validateModuleSlugs(modules: string[]): string[] {
    if (modules.length === 0) {
      throw new PrismError('bad_request', '模块清单为空：请显式传 modules 或先为该书落条目', {
        modules,
      })
    }
    const out: string[] = []
    for (const module of modules) {
      const slug = String(module).trim()
      if (slug === INBOX_DIR) {
        throw new PrismError('bad_request', `保留名 ${INBOX_DIR} 不可冻结为模块`, { module: slug })
      }
      if (!MODULE_SLUG_RE.test(slug)) {
        throw new PrismError('bad_request', `非法模块 slug: ${slug}（须匹配 ${MODULE_SLUG_RE.source}）`, {
          module: slug,
        })
      }
      if (!out.includes(slug)) out.push(slug)
    }
    return out
  }

  /** 写书级 + 各非空模块级 `_summary.md`；返回写下的文件清单（顺序确定）。 */
  #writeSummaries(
    ref: BookRef,
    dir: string,
    entries: BookEntryLite[],
    suggested: SuggestedModule[],
  ): string[] {
    const files: string[] = []
    const bookFile = join(dir, SUMMARY_FILE)
    writeFileSync(bookFile, renderBookSummary(ref, entries, suggested), 'utf-8')
    files.push(bookFile)
    for (const module of suggested) {
      const moduleDir = join(dir, module.slug === INBOX_DIR ? INBOX_DIR : module.slug)
      mkdirSync(moduleDir, { recursive: true })
      const moduleFile = join(moduleDir, SUMMARY_FILE)
      writeFileSync(
        moduleFile,
        renderModuleSummary(ref, module.slug, entries.filter((e) => e.module === module.slug)),
        'utf-8',
      )
      files.push(moduleFile)
    }
    return files
  }

  /**
   * 列出版次（F-B4）：某 id 的全部版次，**降序**（version DESC）+ `is_latest`。
   * 数据早已齐全（`knowledge_entries` 按 `(id, version)` 存全部版次），本方法只补查询面。
   * 不存在的 id → 空数组（不报错，与 `get` 的 null 语义区分）。
   */
  async listVersions(id: string): Promise<EntryVersion[]> {
    const rows = this.persistence.knowledge.raw
      .prepare(
        `SELECT id, version, status, title, is_latest, path, updated_at FROM knowledge_entries
         WHERE id = ? ORDER BY version DESC`,
      )
      .all(id) as Array<{
      id: string
      version: number
      status: string
      title: string
      is_latest: number
      path: string
      updated_at: string
    }>
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      status: row.status as EntryStatus,
      title: row.title,
      is_latest: row.is_latest === 1,
      updated_at: row.updated_at,
      // 该版次的内容文件路径：自有型 = Prism 版次文件（v<NN>.md）；引用型 = 项目原件。
      source_path: row.path ?? null,
    }))
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
        tx.prepare('DELETE FROM kb_vectors WHERE entry_id = ?').run(id)
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

  /**
   * 恢复软删条目（`remove` 的逆操作）：最新版 `deprecated → active`。
   * 幂等：本就 active 时 `restored=false`，不写审计。
   *
   * 自有型：同时把版次文件 frontmatter 的 `status` 改回 active——否则 reindex
   * （以文件为真相）会把 deprecated 读回来、撤销恢复。引用型：只改 DB（项目原件只读）。
   */
  async restore(id: string): Promise<RestoreResult> {
    const raw = this.persistence.knowledge.raw
    const latest = raw
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ? AND is_latest = 1`)
      .get(id) as EntryRow | undefined
    if (latest === undefined) {
      throw new PrismError('not_found', `条目不存在: ${id}`)
    }
    if (latest.status !== 'deprecated') {
      return { id, restored: false }
    }

    if (latest.origin === 'owned') {
      const fileText = readContentFile(latest.path)
      if (fileText !== null) {
        const { data, body } = splitFrontmatter(fileText)
        if (data !== null) {
          writeFileSync(latest.path, renderMarkdownFile({ ...data, status: 'active' }, body), 'utf-8')
        }
      }
    }
    const nowIso = this.#now().toISOString()
    raw
      .prepare(`UPDATE knowledge_entries SET status = 'active', updated_at = ? WHERE id = ? AND is_latest = 1`)
      .run(nowIso, id)
    await this.audit.record({
      type: 'knowledge.restored',
      knowledge_id: id,
      layer: latest.layer,
      source: 'manual',
    })
    return { id, restored: true }
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
    // 每个 id 的最新版（边表与向量都只对最新版重建）
    const latestRows = parsedRows.filter((r) => latestByid.get(r.id) === r.version)

    // 向量随文重算：reindex 以文件为真相，向量也必须跟着文件走——否则用户改了
    // 知识文件后，旧内容的向量会残留并被检索到（entry_id/version 不变，JOIN 照中）。
    // **仅在装配了 embedding 时才清+重算**：没装配就无法重算，删了等于永久丢向量。
    const rebuildVectors = this.#embed !== undefined

    await this.persistence.knowledge.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      try {
        // **只重建自有型**（origin='owned'）：引用型条目的真相在项目文件，
        // 不产生版次文件、不在本次扫描范围内，必须原样保留（QA BLK-1）。
        raw.exec(
          `DELETE FROM kb_fts WHERE rowid IN (SELECT rowid FROM knowledge_entries WHERE origin = 'owned')`,
        )
        raw.exec(`DELETE FROM knowledge_edges WHERE from_id IN (SELECT id FROM knowledge_entries WHERE origin = 'owned')`)
        if (rebuildVectors) {
          // 先清自有型向量（删除 entries 前，子查询才取得到 id）；下方按新文重算
          raw.exec(`DELETE FROM kb_vectors WHERE entry_id IN (SELECT id FROM knowledge_entries WHERE origin = 'owned')`)
        }
        raw.exec(`DELETE FROM knowledge_entries WHERE origin = 'owned'`)
        const insert = raw.prepare(
          `INSERT INTO knowledge_entries
           (id, version, is_latest, title, type, layer, owner, book, module, status, risk, confidence,
            freshness, visibility, tags, path, content_hash, origin, overrides, supersedes,
            source, deposited_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owned', ?, ?, ?, ?, ?, ?)`,
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
            // F-E2：两列随文件重建（frontmatter 里没有 → NULL）
            r.source,
            r.depositedBy,
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

    // 向量按新文重算（事务外，逐条异步；失败静默——增强不阻断 reindex 主流程）
    if (rebuildVectors) {
      for (const r of latestRows) {
        await this.#writeVector(r.id, r.version, `${r.title}\n${r.body}`)
      }
    }

    return { scanned: files.length, indexed, skipped: errors.length, errors }
  }

  /** 递归收集 `<knowledgeDir>` 下所有 `v<NN>.md`（跳过最新版副本 `<id>.md`）。 */
  /**
   * 扫描版次文件。**根目录不可读时抛错**——否则会「扫描 0 条 → 清空自有型索引」
   * （QA 遗留 3：静默清库比报错危险）。子目录不可读只跳过（记入 errors 由调用方汇总）。
   */
  #scanVersionFiles(): string[] {
    const out: string[] = []
    const walk = (dir: string, isRoot = false): void => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        // 目录不存在 = 尚未落过库，返回空（正常）；存在但读不了 = 危险，拒绝。
        if (isRoot && existsSync(dir)) {
          throw new PrismError(
            'knowledge_dir_unreadable',
            `知识目录存在但不可读，拒绝 reindex（避免清空索引）: ${dir}（${error instanceof Error ? error.message : String(error)}）`,
          )
        }
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && /^v\d+\.md$/.test(entry.name)) out.push(full)
      }
    }
    walk(this.knowledgeDir, true)
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
    const sourceValue = data['source']
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
        // F-A4：4 值全量往返；越界 → warning + 回落 active（不静默压平 candidate）。
        status: parseEntryStatus(str('status'), file),
        risk: str('risk') ?? 'low',
        confidence: typeof data['confidence'] === 'number' ? data['confidence'] : 0.5,
        freshness: typeof data['freshness'] === 'number' ? data['freshness'] : 1.0,
        visibility: str('visibility') ?? layer,
        tags,
        overrides,
        // F-E2：`source`/`deposited_by` 两列（v7）随文件带回——否则自有型 reindex
        //（以文件为真相）后 DB 两列恒空。
        source:
          typeof sourceValue === 'string' && sourceValue.trim() !== ''
            ? JSON.stringify({ kind: sourceValue.trim() })
            : serializeObjectColumn(sourceValue),
        depositedBy: serializeObjectColumn(data['deposited_by']),
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
    const match = toMatchExpression(query.q, query.match_mode ?? 'all')
    if (match === '') {
      throw new PrismError('bad_request', '检索词无有效词元')
    }
    const limit = Math.max(1, Math.floor(query.limit ?? 10))
    // F-B3：候选池与融合参数化（缺省 = 既有模块常量，行为逐字节一致）。
    const hybridCandidates = positiveIntParam(
      query.hybrid_candidates,
      HYBRID_CANDIDATES,
      'hybrid_candidates',
    )
    const rrfK = numberParam(query.rrf_k, RRF_K, 'rrf_k', 0)
    const vectorFloor = numberParam(query.vector_floor, VECTOR_FLOOR, 'vector_floor', 0)
    const vectorRelative = numberParam(query.vector_relative, VECTOR_RELATIVE, 'vector_relative', 0)
    const routeWeights = normalizeRouteWeights(query.route_weights)

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

    // 装配了 embedding 且未禁用 → 混合检索（BM25 + 向量 RRF 融合）。
    // query 向量算不出（未安装/启动失败）时静默回落纯 BM25，结果与既有一致。
    if (this.#embed !== undefined && query.hybrid !== false) {
      const qVec = await this.#embed(query.q)
      if (qVec !== null && qVec.length > 0) {
        // 向量召回全量扫描（见 #vectorHits 注释：SQL LIMIT 会任意截断丢失相关条目）
        const pool = Math.max(limit, hybridCandidates)
        const vectorRowids = await this.#vectorHits(
          raw,
          clauses,
          params,
          qVec,
          pool,
          vectorFloor,
          vectorRelative,
        )
        if (vectorRowids.length > 0) {
          return this.#applyOverridesBoost(
            this.#hybridResults(raw, {
              match,
              clauses,
              params,
              limit,
              q: query.q,
              vectorRowids,
              candidates: hybridCandidates,
              rrfK,
              routeWeights,
            }),
            query.graph_boost,
          )
        }
      }
    }

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
    return this.#applyOverridesBoost(results, query.graph_boost)
  }

  /**
   * 融合：BM25 序（FTS 命中，按 -bm25 降序）+ 向量序（余弦降序）经 RRF 合并。
   * 最终 score 用 RRF 融合分（越大越相关），与既有「-bm25」同为「越大越好」语义。
   * 某条目仅单路命中时另一路空贡献，RRF 天然降权，符合「双路命中更可信」。
   */
  #hybridResults(
    raw: DatabaseSync,
    input: {
      match: string
      clauses: string[]
      params: string[]
      limit: number
      q: string
      vectorRowids: number[]
      /** 每路候选数上限（F-B3；缺省 = HYBRID_CANDIDATES） */
      candidates?: number
      /** RRF 常数 k（F-B3；缺省 = RRF_K） */
      rrfK?: number
      /** 分路权重 [关键词, 向量]（F-B3；缺省 1:1） */
      routeWeights?: readonly number[]
    },
  ): SearchResult[] {
    const bm25Hits = searchFts(raw, {
      match: input.match,
      where: input.clauses.join(' AND '),
      params: input.params,
      limit: input.candidates ?? HYBRID_CANDIDATES,
    })
    const fused = rrfFuse(
      [bm25Hits.map((h) => h.rowid), input.vectorRowids],
      input.rrfK ?? RRF_K,
      input.routeWeights,
    )
    if (fused.size === 0) return []
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, input.limit)
    const ids = ranked.map(([rowid]) => rowid)
    const rows = raw
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE rowid IN (${ids.map(() => '?').join(', ')})`)
      .all(...ids) as unknown as EntryRow[]
    const byRowid = new Map(rows.map((r) => [r.rowid, r]))
    const results: SearchResult[] = []
    for (const [rowid, score] of ranked) {
      const row = byRowid.get(rowid)
      if (row) results.push(this.#toSearchResult(raw, row, score, input.q))
    }
    return results
  }

  /**
   * `overrides` 运行时生效（F-A3）——**仅在调用方显式传 `graph_boost: true` 时**。
   *
   * 读 `knowledge_edges` 的 `overrides` 边（`from` 显式覆盖 `to`，写入点见 `#writeEdges`），
   * 对**被覆盖**的条目在同相关性下**降权**（`score × 0.5`）并返回
   * `overridden_by: <覆盖者 id>@v<版次>`；**不删除、不过滤**（预算友好 + 可解释）。
   *
   * 未传 `graph_boost`（缺省）→ **原样返回同一数组**，与改动前逐字节一致
   * （保护既有检索行为；裁决 A3 明确不做边表邻近度）。
   */
  #applyOverridesBoost(results: SearchResult[], graphBoost?: boolean): SearchResult[] {
    if (graphBoost !== true || results.length === 0) return results
    const raw = this.persistence.knowledge.raw
    const ids = results.map((r) => r.id)
    // 覆盖者必须仍是最新版且未软删——已被软删/取代的覆盖声明不应再生效。
    const rows = raw
      .prepare(
        `SELECT e.to_id AS to_id, e.from_id AS from_id, src.version AS from_version
         FROM knowledge_edges e
         JOIN knowledge_entries src ON src.id = e.from_id AND src.is_latest = 1
         WHERE e.relation = 'overrides' AND e.to_id IN (${ids.map(() => '?').join(', ')})
           AND src.status != 'deprecated'
         ORDER BY e.from_id`,
      )
      .all(...ids) as Array<{ to_id: string; from_id: string; from_version: number }>
    if (rows.length === 0) return results
    const coveredBy = new Map<string, string>()
    for (const row of rows) {
      // 多条覆盖声明时取 id 升序的第一条（确定性）
      if (!coveredBy.has(row.to_id)) {
        coveredBy.set(row.to_id, `${row.from_id}@v${row.from_version}`)
      }
    }
    const boosted = results.map((result) => {
      const overriddenBy = coveredBy.get(result.id)
      if (overriddenBy === undefined) return result
      return { ...result, score: result.score * 0.5, overridden_by: overriddenBy }
    })
    // 降权后重排（被覆盖条目在同相关性下靠后）；sort 稳定 → 同分保持原相对序。
    return boosted.sort((a, b) => b.score - a.score)
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
    // F-B1：DB `freshness` 列读出（此前只落库、从不读出）。
    if (typeof row.freshness === 'number') entry.freshness = row.freshness
    // F-E2：`deposited_by` 列（v7）读出；老库 NULL → 不设该字段（向后兼容）。
    const depositedBy = parseJsonObject<NonNullable<KnowledgeEntry['deposited_by']>>(row.deposited_by)
    if (depositedBy !== undefined) entry.deposited_by = depositedBy
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
    // F-E2：`deposited_by` 列（v7）读出；老库 NULL → 不设该字段（向后兼容）。
    const depositedBy = parseJsonObject<NonNullable<SearchResult['deposited_by']>>(row.deposited_by)
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
      // F-B1：新鲜度（DB 列读出，供 context-pack 排序；缺省视为 1.0）。
      ...(typeof row.freshness === 'number' ? { freshness: row.freshness } : {}),
      ...(depositedBy !== undefined ? { deposited_by: depositedBy } : {}),
    }
  }

  // ===== 本地向量（变更 2）=====

  /** 是否装配了 embedding（未装配 → 全链路纯 BM25，行为与既有一致）。 */
  get embeddingEnabled(): boolean {
    return this.#embed !== undefined
  }

  /**
   * 为某一条目的最新版写向量（upsert）。未装配 embedding 或计算失败 → no-op。
   * 返回是否写入成功。**不抛**：embedding 属增强，任何失败都不能阻断落库。
   *
   * `model` 由注入方（server）在装配时声明当前模型 id（`embeddingModel`）——换档后
   * 同一条目重算会写成新 model，旧 model 的向量不再被检索（见 #vectorHits）。
   */
  async #writeVector(id: string, version: number, text: string): Promise<boolean> {
    if (this.#embed === undefined) return false
    let vec: Float32Array | null = null
    try {
      vec = await this.#embed(text)
    } catch {
      return false
    }
    if (vec === null || vec.length === 0) return false
    const nowIso = this.#now().toISOString()
    const blob = vectorToBlob(vec)
    const model = this.#embeddingModel ?? 'unknown'
    await this.persistence.knowledge.run((raw) => {
      raw
        .prepare(
          `INSERT INTO kb_vectors (entry_id, version, dim, vec, model, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, version) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, model = excluded.model, updated_at = excluded.updated_at`,
        )
        .run(id, version, vec.length, blob, model, nowIso)
    })
    return true
  }

  /**
   * 向量召回：**全量扫描**符合条件的条目（JOIN kb_vectors 拿当前版向量），
   * 按余弦降序返回 rowid。
   *
   * 为什么不用 SQL `LIMIT` 取候选：向量相关性只有算完余弦才知道，SQL 层任何
   * `LIMIT` 都只能按 rowid 顺序任意截断——库一大，插入靠后的相关条目永远召不回
   * （QA 复现：61 条库里插入最后的目标条目漏召回）。条目量数千级，JS 算余弦足够快；
   * 更大规模再换 sqlite-vec，接口不变。
   *
   * 过滤：`cos < VECTOR_FLOOR` 视为不相关丢弃；再保留 `>= top * VECTOR_RELATIVE`
   * 的同量级候选（防弱相关经 RRF 混入结果）。无 query 向量或无命中 → 空。
   */
  async #vectorHits(
    raw: DatabaseSync,
    clauses: string[],
    params: string[],
    qVec: Float32Array,
    limit: number,
    floorValue: number = VECTOR_FLOOR,
    relative: number = VECTOR_RELATIVE,
  ): Promise<number[]> {
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    // 只取「当前版次、且由当前模型产出」的向量：换档/换模型后旧向量必须失效
    // （不同模型向量空间不共通，即便同维也不可比）。
    const modelClause = this.#embeddingModel !== undefined ? ' AND v.model = ?' : ''
    const rows = raw
      .prepare(
        `SELECT e.rowid AS rowid, v.vec AS vec, v.dim AS dim
         FROM knowledge_entries e
         JOIN kb_vectors v ON v.entry_id = e.id AND v.version = e.version
         ${where}${modelClause}`,
      )
      .all(...params, ...(this.#embeddingModel !== undefined ? [this.#embeddingModel] : [])) as unknown as Array<{
      rowid: number
      vec: Buffer
      dim: number
    }>
    const scored: Array<{ rowid: number; cos: number }> = []
    for (const row of rows) {
      if (row.dim !== qVec.length) continue
      const vec = blobToVector(row.vec)
      if (vec.length !== qVec.length) continue
      scored.push({ rowid: row.rowid, cos: cosine(qVec, vec) })
    }
    if (scored.length === 0) return []
    scored.sort((a, b) => b.cos - a.cos)
    const top = scored[0]!.cos
    const floor = Math.max(floorValue, top * relative)
    return scored
      .filter((s) => s.cos >= floor)
      .slice(0, limit)
      .map((s) => s.rowid)
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

// ===== 书结构（F-A1/F-A2）的纯函数 =====

/** 书地址的规范文本（`layer[/owner]/book`）——继承环/缺父的错误消息与链路口径。 */
function describeRef(ref: BookRef): string {
  return [ref.layer, ...(ref.owner !== undefined ? [ref.owner] : []), ref.book].join('/')
}

/** 稳定字符串比较（不依赖 locale，保证生成文件逐字节确定）。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 并集去重（保序：先出现的保留在前 —— 继承「父在前、本地覆盖同名项」靠它落实）。 */
function dedupeStrings(values: string[]): string[] {
  const out: string[] = []
  for (const value of values) if (!out.includes(value)) out.push(value)
  return out
}

/**
 * 零 LLM 推导模块建议（F-A1）：模块 + 条目数；同条目数时按**同模块邻接度**
 * （两个端点都在本模块内的边数）降序，再按 slug 升序；`_inbox`（未归类）恒排最后
 * ——与 `tree()` 的既有约定一致。全程确定性。含 `_inbox`（口径与 `tree()` 对齐）。
 */
function deriveSuggested(
  entries: BookEntryLite[],
  edges: Array<{ from: string; to: string }>,
): SuggestedModule[] {
  const counts = new Map<string, number>()
  const moduleOf = new Map<string, string>()
  for (const entry of entries) {
    counts.set(entry.module, (counts.get(entry.module) ?? 0) + 1)
    moduleOf.set(entry.id, entry.module)
  }
  const adjacency = new Map<string, number>()
  for (const edge of edges) {
    const from = moduleOf.get(edge.from)
    const to = moduleOf.get(edge.to)
    if (from === undefined || to === undefined || from !== to) continue
    adjacency.set(from, (adjacency.get(from) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([slug, count]) => ({ slug, entries: count }))
    .sort(
      (a, b) =>
        b.entries - a.entries ||
        (adjacency.get(b.slug) ?? 0) - (adjacency.get(a.slug) ?? 0) ||
        inboxRank(a.slug) - inboxRank(b.slug) ||
        compareStrings(a.slug, b.slug),
    )
}

/** `_inbox` 排序权重（未归类恒最后，对齐 `tree()`）。 */
function inboxRank(slug: string): number {
  return slug === INBOX_DIR ? 1 : 0
}

/** 解析 `book_structures.suggested` 列（`{slug, entries}[]`）；损坏数据 → 空。 */
function parseSuggested(json: string): SuggestedModule[] {
  try {
    const value: unknown = JSON.parse(json)
    if (!Array.isArray(value)) return []
    return value
      .filter(
        (item): item is { slug: string; entries: number } =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { slug?: unknown }).slug === 'string' &&
          typeof (item as { entries?: unknown }).entries === 'number',
      )
      .map((item) => ({ slug: item.slug, entries: item.entries }))
  } catch {
    return []
  }
}

/** YAML 标量（安全集不加引号；其余走 JSON 双引号，可被 `parseFrontmatter` 读回）。 */
function yamlScalar(value: string): string {
  if (value !== '' && PLAIN_YAML_RE.test(value) && Number.isNaN(Number(value))) return value
  return JSON.stringify(value)
}

/** YAML 行内数组（`[a, b]`；空数组 `[]`）。 */
function yamlList(values: string[]): string {
  return `[${values.map(yamlScalar).join(', ')}]`
}

/**
 * 渲染 `_modules.yaml`（**幂等**：同输入同字节——不含任何时钟字段，
 * 时间只进 `book_structures.updated_at`）。
 */
function renderModulesFile(input: {
  layer: string
  book: string
  revision: number
  frozenAt: string | null
  confirmedBy: string | null
  inherits: string[]
  modules: string[]
}): string {
  return (
    [
      '# generated: true —— 由 Prism 书结构工具生成（F-A1，零 LLM）；请勿手工编辑。',
      '# modules = 本地冻结清单（freeze 写入，revision+1）；inherits = 只读继承的父书（并集去重、父在前、本地覆盖）。',
      `layer: ${yamlScalar(input.layer)}`,
      `book: ${yamlScalar(input.book)}`,
      'generated: true',
      `revision: ${input.revision}`,
      `frozen_at: ${input.frozenAt === null ? 'null' : yamlScalar(input.frozenAt)}`,
      `confirmed_by: ${input.confirmedBy === null ? 'null' : yamlScalar(input.confirmedBy)}`,
      `inherits: ${yamlList(input.inherits)}`,
      `modules: ${yamlList(input.modules)}`,
      '',
    ].join('\n')
  )
}

/** 表格单元格转义（标题可能含 `|`）。 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** 条目集里最大的 `updated_at`（空集 → `—`）。 */
function latestUpdated(entries: BookEntryLite[]): string {
  let latest = ''
  for (const entry of entries) if (entry.updated_at > latest) latest = entry.updated_at
  return latest === '' ? '—' : latest
}

/** 书级 `_summary.md`：层 + 模块清单（含条目数）+ 条目总数 + 最近更新。 */
function renderBookSummary(
  ref: BookRef,
  entries: BookEntryLite[],
  suggested: SuggestedModule[],
): string {
  return (
    [
      `# ${cell(ref.book)} 书总纲`,
      '',
      '> generated: true —— 由 `prism kb structure generate` 生成（F-A1，零 LLM）；请勿手工编辑。',
      `> 层：${describeRef(ref)} ｜ 条目：${entries.length} ｜ 模块：${suggested.length} ｜ 最近更新：${latestUpdated(entries)}`,
      '',
      '## 模块清单',
      '',
      '| 模块 | 条目数 |',
      '| :--- | ---: |',
      ...suggested.map((module) => `| ${cell(module.slug)} | ${module.entries} |`),
      '',
      '## 说明',
      '',
      '- 模块清单是**推导建议**（按条目数降序）；冻结请执行 `prism kb structure freeze`（写 `_modules.yaml`）。',
      '- 本文件是派生产物：不进条目表、不进检索。',
      '',
    ].join('\n')
  )
}

/** 模块级 `_summary.md`：该模块条目清单（按 id 升序）+ 最近更新。 */
function renderModuleSummary(ref: BookRef, slug: string, entries: BookEntryLite[]): string {
  const sorted = [...entries].sort((a, b) => compareStrings(a.id, b.id))
  return (
    [
      `# ${cell(slug)} 模块总纲`,
      '',
      '> generated: true —— 由 `prism kb structure generate` 生成（F-A1，零 LLM）；请勿手工编辑。',
      `> 书：${describeRef(ref)} ｜ 模块：${cell(slug)} ｜ 条目：${entries.length} ｜ 最近更新：${latestUpdated(entries)}`,
      '',
      '## 条目',
      '',
      '| 条目 | 版次 | 标题 | 最近更新 |',
      '| :--- | ---: | :--- | :--- |',
      ...sorted.map(
        (entry) => `| \`${cell(entry.id)}\` | ${entry.version} | ${cell(entry.title)} | ${entry.updated_at} |`,
      ),
      '',
    ].join('\n')
  )
}

/**
 * 解析 DB 中的 JSON **对象**列（v7 的 `source`/`deposited_by`，F-E2）。
 * 空值（老库 NULL）与损坏数据一律返回 `undefined`（读侧当「无留痕」）。
 */
function parseJsonObject<T extends object>(json: string | null | undefined): T | undefined {
  if (json === null || json === undefined || json === '') return undefined
  try {
    const value: unknown = JSON.parse(json)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined
  } catch {
    return undefined
  }
}

/**
 * v7 `source` 列的载荷形状（F-E2，§3.2）：`{kind, ref?, origin_task?}`。
 * 用 `type` 别名（而非 interface）以便赋给 frontmatter 的值类型（隐式索引签名）。
 */
type DepositSourcePayload = {
  kind?: 'import' | 'agent' | 'manual' | 'task'
  ref?: string
  origin_task?: { task_id: string; dag_id?: string; stage?: string; role?: string }
}

/**
 * 构造 `source` 载荷：`{...input.source, origin_task?}`（§3.2）。
 * 两者都未提供 → `undefined`（两列写 NULL，与「老行为 NULL」一致，读侧得 `undefined`）。
 */
function buildSourcePayload(input: DepositInput): DepositSourcePayload | undefined {
  if (input.source === undefined && input.origin_task === undefined) return undefined
  const payload: DepositSourcePayload = {}
  if (input.source !== undefined) {
    payload.kind = input.source.kind
    if (input.source.ref !== undefined) payload.ref = input.source.ref
  }
  if (input.origin_task !== undefined) payload.origin_task = { ...input.origin_task }
  return payload
}

/**
 * 可选数值参数（F-B3）：缺省回落既有模块常量（**行为逐字节不变**）；
 * 显式传入但非法（非有限数 / 小于下限）→ `bad_request`（不静默吞掉错误参数，
 * 否则会在 SQL `LIMIT ?` 处抛出更难定位的错）。
 */
function numberParam(
  value: number | undefined,
  fallback: number,
  name: string,
  min: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new PrismError('bad_request', `${name} 必须是不小于 ${min} 的有限数`, { [name]: value })
  }
  return value
}

/** 同上，取正整数（候选池等需要 `LIMIT` 的参数）。 */
function positiveIntParam(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback
  return Math.max(1, Math.floor(numberParam(value, fallback, name, 1)))
}

/** 分路权重归一（F-B3）：缺省 `undefined`（= 每路 1，与既有 2 参调用一致）。 */
function normalizeRouteWeights(
  weights: { keyword?: number; vector?: number } | undefined,
): readonly number[] | undefined {
  if (weights === undefined) return undefined
  const keyword = numberParam(weights.keyword, 1, 'route_weights.keyword', 0)
  const vector = numberParam(weights.vector, 1, 'route_weights.vector', 0)
  return [keyword, vector]
}

/**
 * 解析版次文件 frontmatter 的 `status`（F-A4）。
 *
 * `EntryStatus` 4 值全量往返（`candidate` 不再被压平成 `active`，违反「文件为真相」R7）；
 * 4 值之外**不静默**：`console.warn` 一条并回落 `active`（保持既有容错行为）。
 */
export function parseEntryStatus(value: string | undefined, file: string): EntryStatus {
  if (value === undefined) return 'active'
  if ((ENTRY_STATUSES as readonly string[]).includes(value)) return value as EntryStatus
  console.warn(
    `[prism/knowledge] 未知 status ${JSON.stringify(value)}（${file}）→ 回落 active；合法值: ${ENTRY_STATUSES.join('/')}`,
  )
  return 'active'
}

/**
 * frontmatter 的嵌套对象（`source`/`deposited_by`）→ DB 文本列（F-E2）。
 * 非对象或空对象 → `null`（读侧得 `undefined`，等价「无留痕」）。
 */
function serializeObjectColumn(value: FrontmatterValue | undefined): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  return Object.keys(value).length === 0 ? null : JSON.stringify(value)
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
