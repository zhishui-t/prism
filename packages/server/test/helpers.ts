import type { BookNode, CatalogEntry, GraphPath, GraphQuery, GraphView, KnowledgeEntry, KnowledgeService, KbStats, Layer, SearchQuery, SearchResult } from '../src/kb/port.js'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 内存版知识服务（测试桩；实现 server 的 §3.2 端口）。 */
export class MemoryKb implements KnowledgeService {
  readonly #entries = new Map<string, KnowledgeEntry>()
  versionCounter = 1

  async deposit(input: Parameters<KnowledgeService['deposit']>[0]): Promise<{ id: string; version: number; path: string }> {
    const existing = input.id !== undefined ? [...this.#entries.values()].filter((e) => e.id === input.id) : []
    const version = existing.length + 1
    const id = input.id ?? `kb-${this.versionCounter++}`
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
      content_hash: createHash('sha256').update(input.content).digest('hex'),
      created_at: now,
      updated_at: now,
    }
    for (const old of existing) {
      old.status = 'superseded'
      old.superseded_by = id
    }
    this.#entries.set(`${id}@${version}`, entry)
    return { id, version, path: entry.path }
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
    // 注意：内部 key 是 `id@version`，与 get() 的查找口径一致
    const keys = [...this.#entries.keys()].filter((k) => k.startsWith(`${id}@`))
    if (keys.length === 0) {
      const err = new Error(`条目不存在: ${id}`) as Error & { code: string }
      err.code = 'not_found'
      throw err
    }
    if (options.hard === true) {
      for (const key of keys) this.#entries.delete(key)
      return { id, mode: 'hard', references: 0 }
    }
    const latestKey = keys.sort().at(-1)!
    this.#entries.get(latestKey)!.status = 'deprecated'
    return { id, mode: 'soft', references: 0 }
  }

  /** B2 桩：内存桩不做冲突检测，恒为空。 */
  async conflicts(): Promise<
    Array<{ id: string; high_id: string; low_id: string; kind: string; resolved: boolean; detected_at: string }>
  > {
    return []
  }
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
