/**
 * v16 B-3 / R-3：`hybrid` 参数上 HTTP / MCP（**只做参数面透传**，领域逻辑早已在 knowledge）。
 *
 * 背景：`SearchQuery.hybrid?: boolean`（`packages/knowledge/src/types.ts:290`）与 service 侧的
 * 三判据联动（`#vectorDegraded = vectorCapable ∧ hybrid !== false ∧ qVec === null`，
 * `service.ts:1914`）在 v15 已落地；CLI 面早有 `--no-embedding` → `{ hybrid: false }`
 * （`cli/src/commands/kb.ts:634`）。本轮补齐 HTTP 查询串与 MCP inputSchema。
 *
 * 为什么必须用**录制桩**：`MemoryKb` 只在 `search()` 内部使用 query、**不记录**它——
 * 「响应与不带参数时一样」这类断言对「参数有没有真的透传到 service」是**假断言**
 * （接线整个漏掉也照样绿）。故本文件用 `RecordingKb` 捕获送进 `searchWithMeta` 的 `SearchQuery`。
 *
 * 口径（审核钉死）：
 * - HTTP 侧**严格**：只认 `0|1|true|false`，其余（含空串）→ `400 bad_request`；
 *   **不复用** `parseBool`（后者「非 true/1 即 false」的宽松语义供 `all_versions` 用，
 *   改它会波及该面既有行为）。
 * - MCP 侧维持既有口径：**静默忽略非法值**（SPEC-3.3 是 HTTP 专属）。
 * - SPEC-3.4 用**真服务**（能力已装 + 查询向量算不出）验证判据③自动生效——固定载荷的桩
 *   证明不了「服务确实没置降级标记」。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrismKnowledgeService } from '@prism/knowledge'

import { afterEach, describe, expect, it } from 'vitest'

import { startServer } from '../src/app.js'
import { createMcpTools, handleRpcRequest } from '../src/mcp/server.js'
import { MemoryKb, makeTempDir } from './helpers.js'
import type { SearchQuery, SearchResponse, SearchResult } from '../src/kb/port.js'

const dirs: string[] = []

async function makeHome(prefix = 'kb-hybrid-'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(home)
  return home
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/**
 * **录制桩**：把送进 service 的 `SearchQuery` 原样记下来（返回固定载荷，不参与判定）。
 * 两条入口都录——`searchWithMeta`（HTTP/MCP 优先走它）与 `search`（回落分支）。
 */
class RecordingKb extends MemoryKb {
  readonly queries: SearchQuery[] = []

  constructor(private readonly payload: SearchResponse = { results: [] }) {
    super()
  }

  override async searchWithMeta(query: SearchQuery): Promise<SearchResponse> {
    this.queries.push(query)
    return this.payload
  }

  override async search(query: SearchQuery): Promise<SearchResult[]> {
    this.queries.push(query)
    return this.payload.results
  }

  get last(): SearchQuery {
    const query = this.queries.at(-1)
    if (query === undefined) throw new Error('录制桩未被调用——接线可能根本没走到 service')
    return query
  }
}

/** 起一个 HTTP server（临时 home，R5）。 */
async function serve(kb: MemoryKb): Promise<{ base: string; close: () => Promise<void> }> {
  const app = await startServer({ home: await makeTempDir('kb-hybrid-srv-'), kb, port: 0 })
  return { base: `http://127.0.0.1:${app.port}`, close: () => app.close() }
}

/** 调 MCP `prism_kb_search` 并解析载荷。 */
async function callMcpSearch(kb: MemoryKb, args: Record<string, unknown>): Promise<SearchResponse> {
  const tools = createMcpTools({ home: await makeTempDir('kb-hybrid-mcp-'), kb })
  const res = await handleRpcRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_kb_search', arguments: args } },
    tools,
  )
  const content = (res?.result as { isError: boolean; content: Array<{ text: string }> }).content
  return JSON.parse(content[0]!.text) as SearchResponse
}

describe('SPEC-3.1 HTTP：hybrid 透传到 SearchQuery（录制桩）', () => {
  it('hybrid=false → 录制到的 query.hybrid === false', async () => {
    const kb = new RecordingKb()
    const { base, close } = await serve(kb)
    try {
      const res = await fetch(`${base}/api/kb/search?q=x&hybrid=false`)
      expect(res.status).toBe(200)
      expect(kb.last.hybrid).toBe(false)
    } finally {
      await close()
    }
  })

  it('hybrid=true → true；**缺省 → 无该键**（不塞 hybrid:undefined，判据③的既有行为不变）', async () => {
    const kb = new RecordingKb()
    const { base, close } = await serve(kb)
    try {
      await fetch(`${base}/api/kb/search?q=x&hybrid=true`)
      expect(kb.last.hybrid).toBe(true)

      await fetch(`${base}/api/kb/search?q=x`)
      expect('hybrid' in kb.last).toBe(false)
      expect(kb.last.hybrid).toBeUndefined()
    } finally {
      await close()
    }
  })
})

describe('SPEC-3.3 HTTP 严格字面值：只认 0|1|true|false，其余 400', () => {
  it('0/1/true/false 四值全收，且语义正确', async () => {
    const kb = new RecordingKb()
    const { base, close } = await serve(kb)
    try {
      for (const [raw, expected] of [
        ['0', false],
        ['1', true],
        ['true', true],
        ['false', false],
      ] as const) {
        const res = await fetch(`${base}/api/kb/search?q=x&hybrid=${raw}`)
        expect(res.status, `hybrid=${raw}`).toBe(200)
        expect(kb.last.hybrid, `hybrid=${raw}`).toBe(expected)
      }
    } finally {
      await close()
    }
  })

  it('非字面值（maybe / TRUE / 空串）→ 400 bad_request，且**不触达 service**', async () => {
    const kb = new RecordingKb()
    const { base, close } = await serve(kb)
    try {
      for (const qs of ['hybrid=maybe', 'hybrid=', 'hybrid=TRUE', 'hybrid=2', 'hybrid=null']) {
        const res = await fetch(`${base}/api/kb/search?q=x&${qs}`)
        expect(res.status, qs).toBe(400)
        const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } }
        expect(body.ok, qs).toBe(false)
        expect(body.error.code, qs).toBe('bad_request')
        expect(body.error.message, qs).toContain('hybrid')
      }
      // 非法参数在解析阶段就被拒，不该有任何查询落到 service
      expect(kb.queries).toHaveLength(0)
    } finally {
      await close()
    }
  })
})

describe('SPEC-3.2 MCP：hybrid 透传 + 非法值静默忽略（既有口径不变）', () => {
  it('hybrid=false → 录制到的 query.hybrid === false；true 同理', async () => {
    const kb = new RecordingKb()
    await callMcpSearch(kb, { q: 'x', hybrid: false })
    expect(kb.last.hybrid).toBe(false)

    await callMcpSearch(kb, { q: 'x', hybrid: true })
    expect(kb.last.hybrid).toBe(true)
  })

  it('缺省 → 无该键；非布尔（"maybe" / 0 / null）→ 静默忽略、不报错', async () => {
    const kb = new RecordingKb()
    await callMcpSearch(kb, { q: 'x' })
    expect('hybrid' in kb.last).toBe(false)

    for (const bogus of ['maybe', 0, null]) {
      const parsed = await callMcpSearch(kb, { q: 'x', hybrid: bogus })
      expect(parsed).toEqual({ results: [] }) // 照常返回，不抛
      expect('hybrid' in kb.last, String(bogus)).toBe(false)
    }
  })

  it('inputSchema 暴露可选 hybrid:boolean，且描述补了一句（宿主可发现）', () => {
    const tools = createMcpTools({ home: 'X:/unused' })
    const search = tools.find((t) => t.name === 'prism_kb_search')
    expect(search).toBeDefined()

    const schema = search!.inputSchema as { properties?: Record<string, { type?: string }>; required?: string[] }
    expect(schema.properties?.['hybrid']).toMatchObject({ type: 'boolean' })
    // 可选：不进 required
    expect(schema.required ?? []).not.toContain('hybrid')

    expect(search!.description).toContain('hybrid')

    // SPEC-3.5：参数不是工具——加参数不改工具数
    expect(tools).toHaveLength(49)
    expect(Object.keys(schema.properties ?? {})).toContain('hybrid')
  })
})

describe('SPEC-3.4 hybrid=false → embedding_degraded 不发（判据③自动生效，真服务）', () => {
  /** 假活/超时/失败：查询向量恒「算不出」。 */
  const deadEmbed = async (): Promise<Float32Array | null> => null

  /** 「能力已装（vectorCapable:true）但向量算不出」的真服务 + 一条可 BM25 命中的条目。 */
  async function seedDegradedService(home: string): Promise<PrismKnowledgeService> {
    const kb = new PrismKnowledgeService({ home, embed: deadEmbed, vectorCapable: true })
    await kb.deposit({
      id: 'K-1',
      title: '性能守则',
      type: 'rule',
      layer: 'global',
      book: 'h',
      module: '',
      content: '遇到性能问题先量化，再做优化。',
    })
    return kb
  }

  it('HTTP：同一条服务，缺省带 embedding_degraded，?hybrid=false 则**不带**（结果照常）', async () => {
    const home = await makeHome()
    const kb = await seedDegradedService(home)
    const app = await startServer({ home, kb, port: 0 })
    try {
      const base = `http://127.0.0.1:${app.port}`
      const q = encodeURIComponent('性能')

      const withHybrid = (await (await fetch(`${base}/api/kb/search?q=${q}`)).json()) as {
        ok: boolean
        value: SearchResponse
      }
      expect(withHybrid.value.embedding_degraded).toBe(true)

      const forced = (await (await fetch(`${base}/api/kb/search?q=${q}&hybrid=false`)).json()) as {
        ok: boolean
        value: SearchResponse
      }
      // 判据③（hybrid !== false）自动失效 → 不报降级（这是用户显式选择，不是能力降级）
      expect('embedding_degraded' in forced.value).toBe(false)
      // 降级与不降级都照常出结果
      expect(forced.value.results.map((r) => r.id)).toEqual(['K-1'])
    } finally {
      await app.close()
      kb.close()
    }
  })

  it('MCP：同一服务，缺省带该字段，hybrid:false 不带', async () => {
    const home = await makeHome()
    const kb = await seedDegradedService(home)
    try {
      const tools = createMcpTools({ home, kb })
      const call = async (args: Record<string, unknown>): Promise<SearchResponse> => {
        const res = await handleRpcRequest(
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_kb_search', arguments: args } },
          tools,
        )
        const content = (res?.result as { isError: boolean; content: Array<{ text: string }> }).content
        return JSON.parse(content[0]!.text) as SearchResponse
      }

      expect((await call({ q: '性能' })).embedding_degraded).toBe(true)
      expect('embedding_degraded' in (await call({ q: '性能', hybrid: false }))).toBe(false)
    } finally {
      kb.close()
    }
  })
})
