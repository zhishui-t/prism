import type { BookNode, BookStructure, CatalogEntry, DepositResult, EntryVersion, GraphPath, GraphQuery, GraphView, KnowledgeEntry, KnowledgeService, KbStats, Layer, SearchQuery, SearchResult } from '../src/kb/port.js'
import { PrismError } from '@prism/core'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 内存版知识服务（测试桩；实现 server 的 §3.2 端口）。 */
export class MemoryKb implements KnowledgeService {
  readonly #entries = new Map<string, KnowledgeEntry>()
  /** F-A1 桩：书结构的内存存储（key = `layer/book`），只有 generate/freeze 会写它。 */
  readonly #structures = new Map<string, BookStructure>()
  versionCounter = 1

  /**
   * 落库（桩）。
   *
   * 返回类型直接取端口 `DepositResult`（不再是窄化的 `{id,version,path}`）：
   * `action` 是端口契约的一部分，`writeEnrichment`（富化回写）与 MCP `prism_kb_enrich`
   * 直接读它；旧桩少返回 `action` 会让「落库动作」类断言只能绕道真实服务。
   *
   * 与真实服务同口径：**正文哈希与最新版相同 → `unchanged`**（不产生新版次）。
   * **未建模**：`id_conflict`（同 id 换 layer/book/owner 时真实服务抛错）。
   */
  async deposit(input: Parameters<KnowledgeService['deposit']>[0]): Promise<DepositResult> {
    const existing = input.id !== undefined ? [...this.#entries.values()].filter((e) => e.id === input.id) : []
    const id = input.id ?? `kb-${this.versionCounter++}`
    const contentHash = createHash('sha256').update(input.content).digest('hex')
    const latest = existing.sort((a, b) => a.version - b.version).at(-1)
    if (latest !== undefined && latest.content_hash === contentHash) {
      return { id, version: latest.version, path: latest.path, action: 'unchanged' }
    }
    const version = existing.length + 1
    const now = new Date().toISOString()
    const entry: KnowledgeEntry = {
      id,
      version,
      title: input.title,
      type: input.type,
      layer: input.layer,
      owner: input.owner,
      book: input.book,
      module: input.module ?? '_inbox',
      status: 'active',
      risk: input.risk ?? 'low',
      confidence: input.confidence ?? 0.5,
      tags: input.tags ?? [],
      content: input.content,
      path: `${input.layer}/${input.book}/${id}/v${String(version).padStart(2, '0')}.md`,
      content_hash: contentHash,
      created_at: now,
      updated_at: now,
    }
    for (const old of existing) {
      old.status = 'superseded'
      old.superseded_by = id
    }
    this.#entries.set(`${id}@${version}`, entry)
    return { id, version, path: entry.path, action: existing.length > 0 ? 'updated' : 'created' }
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const keyword = query.q.toLowerCase()
    const results: SearchResult[] = []
    for (const entry of this.#entries.values()) {
      if (!entry.content.toLowerCase().includes(keyword) && !entry.title.toLowerCase().includes(keyword)) {
        continue
      }
      if (query.layers !== undefined && !query.layers.includes(entry.layer)) {
        continue
      }
      if (query.owner !== undefined && entry.owner !== query.owner) {
        continue
      }
      if (query.book !== undefined && entry.book !== query.book) {
        continue
      }
      results.push({
        id: entry.id,
        version: entry.version,
        title: entry.title,
        type: entry.type,
        layer: entry.layer,
        owner: entry.owner,
        book: entry.book,
        module: entry.module,
        excerpt: entry.content.slice(0, 80),
        score: 1,
        source: `${entry.layer}${entry.owner !== undefined ? `/${entry.owner}` : ''}/${entry.book}/${entry.module}/${entry.id}@${entry.version}`,
        // F-B1：把 DB 列 freshness 读出来（缺省不下发该键，保持既有形状）
        ...(entry.freshness !== undefined ? { freshness: entry.freshness } : {}),
      })
    }
    return query.limit !== undefined ? results.slice(0, query.limit) : results
  }

  async get(id: string, version?: number): Promise<KnowledgeEntry | null> {
    if (version !== undefined) {
      return this.#entries.get(`${id}@${version}`) ?? null
    }
    const all = [...this.#entries.values()].filter((e) => e.id === id)
    return all.length > 0 ? all[all.length - 1] : null
  }

  async tree(layer?: Layer, owner?: string): Promise<BookNode[]> {
    void layer
    void owner
    return []
  }

  async stats(): Promise<KbStats> {
    const entries = [...this.#entries.values()]
    const byType: Record<string, number> = {}
    for (const e of entries) {
      byType[e.type] = (byType[e.type] ?? 0) + 1
    }
    return { layers: { global: 0, project: 0, role: 0 }, books: 0, entries: entries.length, by_type: byType }
  }

  /** 测试桩：按正文 `[[id]]` 现算边，支持 graph/path 的路由级验证。 */
  #edgesOf(): Array<{ from: string; to: string; relation: 'references' }> {
    const out: Array<{ from: string; to: string; relation: 'references' }> = []
    for (const entry of this.#entries.values()) {
      if (entry.status !== 'active') continue
      const re = /\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(entry.content)) !== null) {
        const to = m[1]!.trim()
        if (to !== '' && to !== entry.id) out.push({ from: entry.id, to, relation: 'references' })
      }
    }
    return out
  }

  async catalog(options?: { layer?: Layer; owner?: string; book?: string; limit?: number }): Promise<CatalogEntry[]> {
    const out: CatalogEntry[] = []
    for (const e of this.#entries.values()) {
      if (e.status !== 'active') continue
      if (options?.layer !== undefined && e.layer !== options.layer) continue
      if (options?.owner !== undefined && e.owner !== options.owner) continue
      if (options?.book !== undefined && e.book !== options.book) continue
      out.push({
        id: e.id, version: e.version, title: e.title, type: e.type, layer: e.layer,
        ...(e.owner !== undefined ? { owner: e.owner } : {}),
        book: e.book, module: e.module, status: e.status, risk: e.risk, tags: e.tags,
        in_degree: 0, out_degree: 0, updated_at: e.updated_at,
      })
    }
    return options?.limit !== undefined ? out.slice(0, options.limit) : out
  }

  async graph(query?: GraphQuery): Promise<GraphView> {
    const edges = this.#edgesOf().map((e) => ({
      from_id: e.from,
      to_id: e.to,
      relation: e.relation,
      confidence: 'EXTRACTED' as const,
      weight: 1,
      source: '[[双链]]',
      created_at: new Date().toISOString(),
    }))
    const ids = new Set<string>()
    for (const e of edges) {
      ids.add(e.from_id)
      ids.add(e.to_id)
    }
    const nodes = [...ids]
      .map((id) => {
        const entry = [...this.#entries.values()].find((e) => e.id === id && e.status === 'active')
        if (entry === undefined) return null
        return {
          id,
          title: entry.title,
          type: entry.type,
          layer: entry.layer,
          ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
          book: entry.book,
          module: entry.module,
          in_degree: edges.filter((e) => e.to_id === id).length,
          out_degree: edges.filter((e) => e.from_id === id).length,
        }
      })
      .filter((n): n is NonNullable<typeof n> => n !== null)
    const limit = query?.limit ?? 50
    return {
      nodes: nodes.slice(0, limit),
      edges,
      ...(query?.id !== undefined ? { root: query.id } : {}),
      truncated: nodes.length > limit,
    }
  }

  async path(fromId: string, toId: string): Promise<GraphPath | null> {
    const edges = this.#edgesOf()
    const visited = new Set<string>([fromId])
    let frontier = [fromId]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const cur of frontier) {
        for (const e of edges) {
          const other = e.from === cur ? e.to : e.to === cur ? e.from : null
          if (other === null || visited.has(other)) continue
          visited.add(other)
          if (other === toId) {
            return {
              nodes: [fromId, toId],
              edges: [
                {
                  from_id: e.from,
                  to_id: e.to,
                  relation: e.relation,
                  confidence: 'EXTRACTED',
                  weight: 1,
                  source: '[[双链]]',
                  created_at: new Date().toISOString(),
                },
              ],
            }
          }
          next.push(other)
        }
      }
      frontier = next
    }
    return null
  }

  /** B1 桩：软删置 deprecated；硬删从内存移除（真实服务才做引用检查）。 */
  async remove(
    id: string,
    options: { hard?: boolean } = {},
  ): Promise<{ id: string; mode: 'soft' | 'hard'; references: number }> {
    const keys = [...this.#entries.keys()].filter((k) => k.startsWith(`${id}@`))
    if (keys.length === 0) {
      throw codedError('not_found', `条目不存在: ${id}`)
    }
    if (options.hard === true) {
      for (const key of keys) this.#entries.delete(key)
      return { id, mode: 'hard', references: 0 }
    }
    // 取**数值最大**版次（内部 key 是 `id@version`，字符串排序在 v10+ 会挑错版本）
    this.#latestVersion(id)!.status = 'deprecated'
    return { id, mode: 'soft', references: 0 }
  }

  /**
   * B1 逆操作桩：最新版 `deprecated → active`（真实服务同时改版次文件 frontmatter，
   * 桩无文件，该差异不建模）。
   *
   * 与真实服务同口径：不存在 → `not_found`；本就 active → `restored: false`（幂等，不静默重写）。
   */
  async restore(id: string): Promise<{ id: string; restored: boolean }> {
    const latest = this.#latestVersion(id)
    if (latest === undefined) throw codedError('not_found', `条目不存在: ${id}`)
    if (latest.status !== 'deprecated') return { id, restored: false }
    latest.status = 'active'
    latest.updated_at = new Date().toISOString()
    return { id, restored: true }
  }

  /** 最新版（按 version 数值最大；无此 id → undefined）。 */
  #latestVersion(id: string): KnowledgeEntry | undefined {
    return [...this.#entries.values()].filter((e) => e.id === id).sort((a, b) => b.version - a.version)[0]
  }

  /** B2 桩：内存桩不做冲突检测，恒为空。 */
  async conflicts(): Promise<
    Array<{ id: string; high_id: string; low_id: string; kind: string; resolved: boolean; detected_at: string }>
  > {
    return []
  }

  /** B2 桩：无冲突可解决，恒 false。 */
  async resolveConflict(_conflictId: string): Promise<boolean> {
    return false
  }

  /** A3 桩：按 id@version 写入内存（模拟引用型索引）。 */
  async index(input: {
    id: string
    title: string
    type?: string
    layer: Layer
    owner?: string
    book: string
    module?: string
    path: string
    source_hash: string
    content: string
  }): Promise<{ id: string; action: 'created' | 'updated' | 'unchanged' }> {
    const existing = await this.get(input.id)
    if (existing !== null && existing.source_hash === input.source_hash) {
      return { id: input.id, action: 'unchanged' }
    }
    const action = existing === null ? ('created' as const) : ('updated' as const)
    const now = new Date().toISOString()
    const version = existing === null ? 1 : existing.version + 1
    this.#entries.set(`${input.id}@${version}`, {
      id: input.id,
      version,
      title: input.title,
      type: (input.type ?? 'doc') as KnowledgeEntry['type'],
      layer: input.layer,
      ...(input.owner !== undefined ? { owner: input.owner } : {}),
      book: input.book,
      module: input.module ?? '_inbox',
      status: 'active',
      risk: 'low',
      confidence: 0.5,
      tags: [],
      content: input.content,
      path: input.path,
      content_hash: input.source_hash,
      origin: 'indexed',
      source_hash: input.source_hash,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    })
    return { id: input.id, action }
  }

  /** Z2 桩：内存桩无需重建（文件即内存）。 */
  async reindex(): Promise<{ scanned: number; indexed: number; skipped: number; errors: Array<{ path: string; reason: string }> }> {
    const n = this.#entries.size
    return { scanned: n, indexed: n, skipped: 0, errors: [] }
  }

  /**
   * F-B1 桩：模拟 DB `knowledge_entries.freshness` 列（真实服务由流 1 写入）。
   * 只影响最新版；不存在 → 抛错（测试用的显式动作，不静默）。
   */
  setFreshness(id: string, freshness: number): void {
    const latest = [...this.#entries.values()].filter((e) => e.id === id).at(-1)
    if (latest === undefined) throw new Error(`条目不存在: ${id}`)
    latest.freshness = freshness
  }

  /**
   * F-B4 桩：按 `(id, version)` 逆序返回全部版次（真实服务查 knowledge_entries）。
   *
   * `source_path` 与真实服务同口径：**恒为该版次落盘路径**（自有型 = 版次文件
   * `v<NN>.md`，引用型 = 项目原件），只有 `path` 列真为 NULL 时才是 `null`
   * —— 桩里每条都有 path，故不下发 `null`（旧桩对自有型下发 null 与真实服务不一致）。
   */
  async listVersions(id: string): Promise<EntryVersion[]> {
    return [...this.#entries.values()]
      .filter((e) => e.id === id)
      .sort((a, b) => b.version - a.version)
      .map((e) => ({
        id: e.id,
        version: e.version,
        status: e.status,
        title: e.title,
        is_latest: e.status !== 'superseded',
        updated_at: e.updated_at,
        source_path: e.path,
      }))
  }

  /**
   * F-A1 桩：读回内存里的书结构（真实服务读 `_modules.yaml` + `book_structures` 表）。
   *
   * 与真实服务同口径：**从未 generate/freeze 过 → `null`**（等价「书上还没有结构」，
   * 不是「空结构」）。空结构会被路由/断言误读成「结构存在且为空」，故不返回空对象。
   */
  async bookStructure(layer: string, book: string): Promise<BookStructure | null> {
    return this.#structures.get(structureKey(layer, book)) ?? null
  }

  /**
   * F-A1 桩：按内存条目推导 `suggested`（模块 + 条目数，降序，`_inbox` 殿后），
   * 记进内存供 `bookStructure` 读回。`revision` 不递增（对齐真实服务：只有 freeze 递增）。
   *
   * 保留真实服务 `#requireBook` 的硬校验：**书不存在（无条目且无结构）→ `bad_request`**
   * （真实服务不静默造空结构；桩若放行，路由级测试就会把「生成不存在的书」判成成功）。
   *
   * **未建模**（真实服务有、桩没有——别据此写断言，会与真实服务不一致）：
   * 三份文件落盘（故 `files` 恒为 `[]`）、父链 `inherits` 合并、非法 slug 校验、
   * project/role 层「同名书多 owner」的定位消歧（桩键不含 owner）。
   */
  async generateBookStructure(input: { layer: string; book: string; confirmed_by?: string }): Promise<{ structure: BookStructure; files: string[] }> {
    const prev = this.#structures.get(structureKey(input.layer, input.book))
    if (prev === undefined && this.#bookEntries(input.layer, input.book).length === 0) {
      throw codedError('bad_request', `书 ${input.layer}/${input.book} 不存在（无条目、无结构文件）`)
    }
    const structure: BookStructure = {
      layer: input.layer,
      book: input.book,
      revision: prev?.revision ?? 0,
      modules: prev?.modules ?? [],
      suggested: deriveSuggested(this.#bookEntries(input.layer, input.book)),
      inherits: [],
      inherited_from: [],
      frozen_at: prev?.frozen_at ?? null,
      confirmed_by: input.confirmed_by ?? prev?.confirmed_by ?? null,
      updated_at: new Date().toISOString(),
    }
    this.#structures.set(structureKey(input.layer, input.book), structure)
    return { structure, files: [] }
  }

  /**
   * F-A1 桩：固化模块清单 → `revision+1` + `frozen_at`，供 `bookStructure` 读回。
   *
   * 保留真实服务的一处硬校验：**书无任何条目 → `bad_request`**（否则「冻结空书」
   * 会在桩上静默成功、在真实服务上 400，属典型假绿）。
   * **未建模**：slug 合法性/保留名校验、文件落盘、父链合并。
   */
  async freezeBookStructure(input: { layer: string; book: string; modules?: string[]; confirmed_by?: string; note?: string }): Promise<BookStructure> {
    const entries = this.#bookEntries(input.layer, input.book)
    if (entries.length === 0) {
      throw codedError('bad_request', `书 ${input.layer}/${input.book} 没有任何条目，无法冻结结构`)
    }
    const prev = this.#structures.get(structureKey(input.layer, input.book))
    const suggested = deriveSuggested(entries)
    const modules =
      input.modules ??
      (prev !== undefined && prev.modules.length > 0 ? prev.modules : suggested.map((s) => s.slug).filter((s) => s !== INBOX))
    const now = new Date().toISOString()
    const structure: BookStructure = {
      layer: input.layer,
      book: input.book,
      revision: (prev?.revision ?? 0) + 1,
      modules,
      suggested,
      inherits: [],
      inherited_from: [],
      frozen_at: now,
      confirmed_by: input.confirmed_by ?? prev?.confirmed_by ?? null,
      updated_at: now,
    }
    this.#structures.set(structureKey(input.layer, input.book), structure)
    return structure
  }

  /** 该书在内存里的条目（层 + 书口径，与真实服务 `#bookEntries` 一致）。 */
  #bookEntries(layer: string, book: string): KnowledgeEntry[] {
    return [...this.#entries.values()].filter((e) => e.layer === layer && e.book === book)
  }
}

/** 未归类模块（与真实服务 `INBOX_DIR` 同值）。 */
const INBOX = '_inbox'

/** 书结构桩的存储键。 */
function structureKey(layer: string, book: string): string {
  return `${layer}/${book}`
}

/**
 * 业务错误（桩内统一抛法）。
 *
 * **必须是真 `PrismError`**：HTTP 层（`http/envelope.ts:toEnvelope`）用 `isPrismError`
 * 的 `instanceof` 判定映射错误码——普通 `Error` 上挂一个 `code` 属性**不会被识别**，
 * 一律落 `internal`/500；MCP 层（`mcp/server.ts:handleRpcRequest`）同样靠 `instanceof`
 * 加 `[code]` 前缀。旧写法（`new Error` + 手挂 `.code`）会让「桩抛 bad_request →
 * 路由返回 500」这类假绿一路通过，直到有人真的断言 HTTP 状态码。
 */
function codedError(code: string, message: string): PrismError {
  return new PrismError(code, message)
}

/**
 * 按模块聚合条目（对齐真实服务 `deriveSuggested` 的降序口径：条目数 → `_inbox` 殿后 → 名）。
 * 真实服务还叠加「同模块邻接度」加权，桩不建模（见 `generateBookStructure` 注释）。
 */
function deriveSuggested(entries: KnowledgeEntry[]): Array<{ slug: string; entries: number }> {
  const counts = new Map<string, number>()
  for (const e of entries) counts.set(e.module, (counts.get(e.module) ?? 0) + 1)
  return [...counts.entries()]
    .map(([slug, count]) => ({ slug, entries: count }))
    .sort(
      (a, b) =>
        b.entries - a.entries ||
        inboxRank(a.slug) - inboxRank(b.slug) ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    )
}

function inboxRank(slug: string): number {
  return slug === INBOX ? 1 : 0
}

/** 临时目录（自动前缀），用于隔离 PRISM_HOME / 项目根。 */
export async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** 写文件（自动建父目录）。 */
export async function putFile(path: string, content: string): Promise<string> {
  const { dirname } = await import('node:path')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
  return path
}
