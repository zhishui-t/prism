/**
 * v13 §5 契约链（B-4）：HTTP `/api/kb/search` 与 MCP `prism_kb_search` 的**响应形状**。
 *
 * 冻结真相在 `packages/knowledge/src/types.ts` 的 `SearchResponse`，经 `server/kb/port.ts`
 * **re-export**（单一真相源，server 不维护镜像类型）：
 *
 *   `{ results, chunk_scan_degraded?, hits_truncated? }` —— 可选字段**缺省不下发**；
 *   条目可选 `hits: [{seq, heading_path, excerpt, score}]`（wire 一律 snake_case）。
 *
 * `searchWithMeta` 在端口里是**可选**成员：桩/第三方实现可以不提供；HTTP 与 MCP 两条面
 * 都按「有则用之、无则回落 `search()`」接线，且**两条路径归一为同一响应形状**
 * （回落时 `results` 与旧版 `search()` 返回的数组逐字节相同）。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { startServer } from '../src/app.js'
import { createMcpTools, handleRpcRequest } from '../src/mcp/server.js'
import { MemoryKb, makeTempDir } from './helpers.js'
import type { SearchResponse, SearchResult } from '../src/kb/port.js'
import type { JsonRpcRequest } from '../src/mcp/server.js'

const rpc = (method: string, params?: Record<string, unknown>): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params,
})

/** 最小合法 `SearchResult`（只填契约必填字段）。 */
function result(title: string, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'K-1',
    version: 1,
    title,
    type: 'rule',
    layer: 'global',
    book: 'h',
    module: '',
    excerpt: '摘录',
    score: 0.5,
    source: 'global/h//K-1@1',
    ...extra,
  }
}

/** 带段级元信息的桩：`searchWithMeta` 回传固定载荷（模拟真实服务的响应级标记 + 每条目 hits）。 */
class MetaKb extends MemoryKb {
  constructor(private readonly payload: SearchResponse) {
    super()
  }

  override async searchWithMeta(): Promise<SearchResponse> {
    return this.payload
  }
}

/**
 * 造一个**未实现** `searchWithMeta` 的桩（等价旧实现/第三方桩）：用自身属性遮蔽原型方法，
 * 使 `kb.searchWithMeta` 为 `undefined` —— 正是路由回落分支的判据。
 */
function withoutSearchWithMeta(kb: MemoryKb): MemoryKb {
  Object.defineProperty(kb, 'searchWithMeta', { value: undefined, enumerable: true, configurable: true })
  return kb
}

/** 起一个 HTTP server 并返回 base + close。 */
async function serve(kb: MemoryKb): Promise<{ base: string; close: () => Promise<void> }> {
  const app = await startServer({ home: await makeTempDir('prism-search-contract-'), kb, port: 0 })
  return { base: `http://127.0.0.1:${app.port}`, close: () => app.close() }
}

describe('v13 §5 契约链：HTTP /api/kb/search 的 SearchResponse 形状', () => {
  it('searchWithMeta 的响应级标记与条目 hits 原样透传（snake_case）', async () => {
    const payload: SearchResponse = {
      results: [
        result('长文档', {
          hits: [{ seq: 2, heading_path: '甲 › 乙', excerpt: '命中窗口', score: 0.25 }],
        }),
      ],
      chunk_scan_degraded: true,
      hits_truncated: true,
    }
    const { base, close } = await serve(new MetaKb(payload))
    try {
      const res = await fetch(`${base}/api/kb/search?q=${encodeURIComponent('性能')}`)
      const body = (await res.json()) as { ok: boolean; value: SearchResponse }
      expect(body.ok).toBe(true)
      expect(body.value).toEqual(payload)
      // snake_case 是 wire 口径：断言**没有**驼峰键漏出
      expect(JSON.stringify(body.value)).not.toContain('headingPath')
    } finally {
      await close()
    }
  })

  it('无段级命中 → JSON 里既无 hits 键，也无两个响应级标记键', async () => {
    const { base, close } = await serve(new MetaKb({ results: [result('普通条目')] }))
    try {
      const res = await fetch(`${base}/api/kb/search?q=x`)
      const text = await res.text()
      expect(text).not.toContain('"hits"')
      expect(text).not.toContain('chunk_scan_degraded')
      expect(text).not.toContain('hits_truncated')
      // undefined 不得被字段白名单重组变成 null
      expect(text).not.toContain('null')
    } finally {
      await close()
    }
  })

  it('桩未实现 searchWithMeta → 回落 search()，results 与旧版数组逐字节相同', async () => {
    const bare = withoutSearchWithMeta(new MemoryKb())
    await bare.deposit({
      id: 'K-1',
      title: '性能守则',
      type: 'rule',
      layer: 'global',
      book: 'h',
      content: '含性能两字',
    })
    const { base, close } = await serve(bare)
    try {
      const res = await fetch(`${base}/api/kb/search?q=${encodeURIComponent('性能')}`)
      const body = (await res.json()) as { ok: boolean; value: SearchResponse }
      const legacy = await bare.search({ q: '性能' })
      expect(body.value.results).toEqual(legacy)
      expect(body.value.results).toHaveLength(1)
      // 回落分支同样不下发可选键
      expect(Object.keys(body.value)).toEqual(['results'])
    } finally {
      await close()
    }
  })
})

describe('v13 §5 契约链：MCP prism_kb_search 的 SearchResponse 形状', () => {
  const callSearch = async (kb: MemoryKb, args: Record<string, unknown> = { q: '性能' }) => {
    const tools = createMcpTools({ home: await makeTempDir('prism-search-contract-'), kb })
    const res = await handleRpcRequest(rpc('tools/call', { name: 'prism_kb_search', arguments: args }), tools)
    const content = (res?.result as { isError: boolean; content: Array<{ text: string }> }).content
    return JSON.parse(content[0]!.text) as SearchResponse
  }

  it('与 HTTP 同契约：透传标记与 hits', async () => {
    const payload: SearchResponse = {
      results: [result('长文档', { hits: [{ seq: 0, heading_path: '', excerpt: '导语', score: 0.1 }] })],
      hits_truncated: true,
    }
    const parsed = await callSearch(new MetaKb(payload))
    expect(parsed).toEqual(payload)
  })

  it('桩未实现 searchWithMeta → 回落 search()，results 是数组且无标记键', async () => {
    const bare = withoutSearchWithMeta(new MemoryKb())
    await bare.deposit({ title: '性能守则', type: 'rule', layer: 'global', book: 'h', content: '含性能两字' })
    const parsed = await callSearch(bare)
    expect(parsed.results.map((r) => r.title)).toEqual(['性能守则'])
    expect(Object.keys(parsed)).toEqual(['results'])
  })

  it('工具描述补段级语义，且工具数仍为 48（drift 不变）', () => {
    const tools = createMcpTools({ home: 'X:/unused' })
    expect(tools).toHaveLength(48)
    const search = tools.find((t) => t.name === 'prism_kb_search')
    expect(search?.description).toContain('hits')
    expect(search?.description).toContain('heading_path')
  })
})

describe('v13 §5 契约链：单一真相源（无镜像定义）', () => {
  it('port.ts 只 re-export knowledge 的检索契约，不自行定义', async () => {
    const text = await readFile(fileURLToPath(new URL('../src/kb/port.ts', import.meta.url)), 'utf8')
    expect(text).toMatch(/export type \{[\s\S]*SearchResponse[\s\S]*\} from '@prism\/knowledge'/)
    // 镜像定义的反例：server 侧出现 interface/type 声明即为漂移
    expect(text).not.toMatch(/(interface|type)\s+SearchResponse\b/)
    expect(text).not.toMatch(/(interface|type)\s+SearchHit\b/)
  })

  it('http 路由与 MCP 都用同一回落接线（有则用之、无则 search()）', async () => {
    const route = await readFile(fileURLToPath(new URL('../src/http/routes/kb.ts', import.meta.url)), 'utf8')
    const mcp = await readFile(fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url)), 'utf8')
    for (const src of [route, mcp]) {
      expect(src).toContain('searchWithMeta')
      expect(src).toContain('{ results: await ')
    }
  })
})
