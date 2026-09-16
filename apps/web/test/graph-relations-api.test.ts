/**
 * F4 调用链查询：**api 客户端契约**测试（node 环境，不渲染、不 mock 模块）。
 *
 * 锁三件事（design-v8 §2 F4 契约 + 审核修订 #3/#10）：
 *  1. **查询串拼装**——`relation` 是逗号分隔多值、`limit` 只在给了才出现、
 *     `dir` 原样透传；path/affected 的 `from`/`to`/`depth` 同上；
 *  2. **信封解包**——`{ok:true,value}` 取 value；`{ok:false,error}` 抛
 *     `` `${code}: ${message}` ``（`api.ts` 的 D-1 契约：错误码靠这个前缀承载）；
 *  3. **多义分支**——它是 200 不是报错，`candidates` 要原样回到调用方
 *     （UI 靠它做二次寻址）。
 *
 * mock 口径：仓库既有测试全是 `vi.mock('../src/api.ts')`（整模块替身），
 * 没有 stub `fetch` 的先例；本文件要验的恰恰是 api.ts 自己的拼装与解包，
 * 故用 `vi.stubGlobal('fetch', …)` 挡在最外层，让 api.ts 跑真代码。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '../src/api.ts'

interface Recorded {
  url: string
  init: RequestInit | undefined
}

/** 铺一个 fetch 桩：记录请求 + 恒定返回给定信封。 */
function stubFetch(body: unknown): Recorded[] {
  const calls: Recorded[] = []
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve({ json: async () => body } as unknown as Response)
  })
  return calls
}

/** 请求 URL 的查询参数（路径与参数分开断言，避免被编码差异误伤）。 */
function params(call: Recorded): URLSearchParams {
  return new URL(call.url, 'http://localhost').searchParams
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('graphRelations：查询串拼装', () => {
  it('relation 多值按逗号原样传（服务端 parseRelationFilter 按逗号切）', async () => {
    const calls = stubFetch({ ok: true, value: { project: 'demo', node: 'a', dir: 'in', total: 0, limit: 200, items: [] } })
    await api.graphRelations({ project: 'demo', node: 'CodeGraphPage', dir: 'in', relation: 'calls,invokes' })

    expect(new URL(calls[0]!.url, 'http://localhost').pathname).toBe('/api/graph/relations')
    const qs = params(calls[0]!)
    expect(qs.get('project')).toBe('demo')
    expect(qs.get('node')).toBe('CodeGraphPage')
    expect(qs.get('dir')).toBe('in')
    expect(qs.get('relation')).toBe('calls,invokes')
  })

  it('relation 缺省/空串 = 不传该参数（语义「全部关系」，不是空白名单）', async () => {
    const calls = stubFetch({ ok: true, value: { project: 'demo', node: 'a', dir: 'out', total: 0, limit: 200, items: [] } })
    await api.graphRelations({ project: 'demo', node: 'a', dir: 'out' })
    await api.graphRelations({ project: 'demo', node: 'a', dir: 'out', relation: '' })

    expect(params(calls[0]!).has('relation')).toBe(false)
    expect(params(calls[1]!).has('relation')).toBe(false)
    expect(params(calls[1]!).get('dir')).toBe('out')
  })

  it('limit 只在给了才出现；节点名/项目名做 URL 编码', async () => {
    const calls = stubFetch({ ok: true, value: { project: 'demo', node: 'a', dir: 'in', total: 0, limit: 50, items: [] } })
    await api.graphRelations({ project: 'demo', node: 'a b/c', dir: 'in', limit: 50 })

    const qs = params(calls[0]!)
    expect(qs.get('limit')).toBe('50')
    expect(qs.get('node')).toBe('a b/c')
  })
})

describe('graphRelations：信封解包', () => {
  it('命中：value 原样返回（items 带 other/other_label/kind/file/line）', async () => {
    const value = {
      project: 'demo',
      node: 'node-1',
      dir: 'in' as const,
      total: 1,
      limit: 200,
      items: [{ other: 'node-2', other_label: 'caller', kind: 'calls', file: 'src/a.ts', line: '52' }],
    }
    stubFetch({ ok: true, value })
    await expect(api.graphRelations({ project: 'demo', node: 'caller', dir: 'in' })).resolves.toEqual(value)
  })

  it('多义是 200 不是报错：candidates 原样回到调用方（UI 据此二次寻址）', async () => {
    const value = {
      project: 'demo',
      node: 'dup',
      dir: 'in' as const,
      total: 0,
      limit: 200,
      items: [],
      candidates: [
        { id: 'a#dup', label: 'dup' },
        { id: 'b#dup', label: 'dup' },
      ],
    }
    stubFetch({ ok: true, value })
    const got = await api.graphRelations({ project: 'demo', node: 'dup', dir: 'in' })
    expect(got.total).toBe(0)
    expect(got.items).toEqual([])
    expect(got.candidates?.map((c) => c.id)).toEqual(['a#dup', 'b#dup'])
  })

  it('错误信封：抛 `${code}: ${message}`（错误码靠前缀承载，不得改形）', async () => {
    stubFetch({ ok: false, error: { code: 'not_found', message: '图谱中没有节点: nope' } })
    await expect(api.graphRelations({ project: 'demo', node: 'nope', dir: 'out' })).rejects.toThrow(
      /^not_found: 图谱中没有节点/,
    )

    stubFetch({ ok: false, error: { code: 'graph_not_found', message: '图谱不存在' } })
    await expect(api.graphRelations({ project: 'demo', node: 'a', dir: 'in' })).rejects.toThrow(/^graph_not_found: /)

    stubFetch({ ok: false, error: { code: 'bad_request', message: 'dir 必须为 in 或 out' } })
    await expect(api.graphRelations({ project: 'demo', node: 'a', dir: 'in' })).rejects.toThrow(/^bad_request: /)
  })
})

describe('graphPath / graphAffected：既有端点的客户端', () => {
  it('path：from/to 透传，value 原样返回（chain/hops/found）', async () => {
    const value = { project: 'demo', raw: 'a --> b', hops: 1, chain: ['a', 'b'], found: true }
    const calls = stubFetch({ ok: true, value })
    const got = await api.graphPath({ project: 'demo', from: 'a', to: 'b' })

    expect(new URL(calls[0]!.url, 'http://localhost').pathname).toBe('/api/graph/path')
    expect(params(calls[0]!).get('from')).toBe('a')
    expect(params(calls[0]!).get('to')).toBe('b')
    expect(got).toEqual(value)
  })

  it('affected：depth 只在给了才出现', async () => {
    const value = { project: 'demo', raw: '', depth: 2, nodes: [{ label: 'x', relation: 'calls', location: 'a.ts:1' }] }
    const calls = stubFetch({ ok: true, value })
    await api.graphAffected({ project: 'demo', node: 'a' })
    await api.graphAffected({ project: 'demo', node: 'a', depth: 2 })

    expect(new URL(calls[0]!.url, 'http://localhost').pathname).toBe('/api/graph/affected')
    expect(params(calls[0]!).has('depth')).toBe(false)
    expect(params(calls[1]!).get('depth')).toBe('2')
  })
})
