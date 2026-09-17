/**
 * F4 调用链查询（+ v10 F5 时序图导出 + v10 F9ui 分层聚合）：**api 客户端契约**测试
 * （node 环境，不渲染、不 mock 模块）。
 *
 * 锁三件事（design-v8 §2 F4 契约 + 审核修订 #3/#10；F5 见 design-v10；F9ui 见 design-v10 F9）：
 *  1. **查询串拼装**——`relation` 是逗号分隔多值、`limit` 只在给了才出现、
 *     `dir` 原样透传；path/affected 的 `from`/`to`/`depth` 同上；rollup 的
 *     `level`/`parent` 见文末那一组（community 层不带 parent）；
 *  2. **信封解包**——`{ok:true,value}` 取 value；`{ok:false,error}` 抛
 *     `` `${code}: ${message}` ``（`api.ts` 的 D-1 契约：错误码靠这个前缀承载）；
 *  3. **多义分支**——它是 200 不是报错，`candidates` 要原样回到调用方
 *     （UI 靠它做二次寻址）；
 *  4. **F5 导出**——`POST` 到 `ARCH_RENDER_ENDPOINT` 的 `mode: 'from-graph'` 分支（**路径与
 *     mode 只在 api 层一处**，本文件按常量断言，不复制字面量）、体里是
 *     `{ mode, type, project, node }`，错误仍走 D-1 信封。
 *
 * mock 口径：仓库既有测试全是 `vi.mock('../src/api.ts')`（整模块替身），
 * 没有 stub `fetch` 的先例；本文件要验的恰恰是 api.ts 自己的拼装与解包，
 * 故用 `vi.stubGlobal('fetch', …)` 挡在最外层，让 api.ts 跑真代码。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ARCH_RENDER_ENDPOINT, ARCH_RENDER_MODE_FROM_GRAPH, GRAPH_ROLLUP_ENDPOINT, api } from '../src/api.ts'

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

/**
 * v10 F5 时序图导出。
 *
 * ✅ 端点**已与后端批对账**：`POST /api/arch/render` 的 `mode: 'from-graph'` 分支
 * （`packages/server/src/http/routes/arch.ts` 的 `renderFromGraph`）。本组锁前端这一侧的
 * 契约面：打哪个路径、用什么方法、体里是什么（含 `mode` / `type`）、错误怎么冒泡。
 * 路径与 mode 都取自 api.ts 的常量（**单点改**），另有断言把字面值钉住，改动会显式可见。
 */
describe('archRenderFromGraph（F5 导出时序图）', () => {
  it('端点与 mode 常量的字面值（与后端 `arch.ts` 同源的锚点）', () => {
    expect(ARCH_RENDER_ENDPOINT).toBe('/api/arch/render')
    expect(ARCH_RENDER_MODE_FROM_GRAPH).toBe('from-graph')
  })

  it('POST 到该端点，体里是 `{ mode, type, project, node }`（node 为**节点 id**），带 JSON 头', async () => {
    const calls = stubFetch({ ok: true, value: { preview: '/api/arch/preview/sequence/x.html' } })
    await api.archRenderFromGraph({ project: 'demo', node: 'pkg/a.ts#alpha' })

    const url = new URL(calls[0]!.url, 'http://localhost')
    expect(url.pathname).toBe(ARCH_RENDER_ENDPOINT)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      mode: 'from-graph',
      type: 'sequence',
      project: 'demo',
      node: 'pkg/a.ts#alpha',
    })
    // 走 POST 体而不是查询串：node 里可能带 `#` / `/`，放 query 会被编码成一团
    expect(url.search).toBe('')
  })

  it('命中：value 原样返回（含 `preview` / `root_file` / `relative_path`；UI 只消费 preview）', async () => {
    const value = {
      type: 'sequence',
      project: 'demo',
      node: 'entry',
      root: '/tmp/demo',
      root_file: 'proj/src/cli/entry.ts',
      name: 'sequence-entry-20260917-101112-ab12cd34.html',
      relative_path: '.prism/arch/sequence/sequence-entry-20260917-101112-ab12cd34.html',
      bytes: 1234,
      preview: '/api/arch/preview/sequence/sequence-entry-20260917-101112-ab12cd34.html?project=demo',
      ir: '/tmp/demo/.prism/arch/sequence/x.ir.json',
      meta: {},
      source: 'project' as const,
    }
    stubFetch({ ok: true, value })
    await expect(api.archRenderFromGraph({ project: 'demo', node: 'entry' })).resolves.toEqual(value)
  })

  it('错误信封：抛 `${code}: ${message}`（F5 的两类 bad_request 靠这个前缀 + 消息文本分派）', async () => {
    stubFetch({ ok: false, error: { code: 'bad_request', message: '指定的根文件没有跨文件调用边: a.ts' } })
    await expect(api.archRenderFromGraph({ project: 'demo', node: 'n1' })).rejects.toThrow(/^bad_request: 指定的根文件/)

    stubFetch({ ok: false, error: { code: 'bad_request', message: '图谱没有跨文件 calls 边' } })
    await expect(api.archRenderFromGraph({ project: 'demo', node: 'n1' })).rejects.toThrow(/^bad_request: 图谱没有跨文件/)

    stubFetch({ ok: false, error: { code: 'not_found', message: '未注册的图谱项目: nope' } })
    await expect(api.archRenderFromGraph({ project: 'nope', node: 'n1' })).rejects.toThrow(/^not_found: /)
  })
})

/**
 * v10 F9ui：分层聚合客户端（`GET /api/graph/rollup`）。
 *
 * 契约来自后端实况（`packages/server/src/graph/rollup.ts` + `http/routes/graph.ts` 的
 * `rollup`，回归 `packages/server/test/graph-rollup.test.ts`），本文件按**常量 + 实况形状**断言，
 * 不复制字面量路径（路径只在 `api.ts` 的 `GRAPH_ROLLUP_ENDPOINT` 一处）。
 */
describe('graphRollup：分层聚合查询串拼装', () => {
  it('路径取自 `GRAPH_ROLLUP_ENDPOINT`（后端改名时只改 api 层一处）', async () => {
    const calls = stubFetch({ ok: true, value: { level: 'community', parent: null, total: 0, truncated: false, nodes: [], edges: [] } })
    await api.graphRollup({ project: 'demo', level: 'community' })
    expect(new URL(calls[0]!.url, 'http://localhost').pathname).toBe(GRAPH_ROLLUP_ENDPOINT)
    expect(GRAPH_ROLLUP_ENDPOINT).toBe('/api/graph/rollup')
  })

  it('community 层**不传** parent（服务端传了会 400：该层不接受 parent）', async () => {
    const calls = stubFetch({ ok: true, value: { level: 'community', parent: null, total: 0, truncated: false, nodes: [], edges: [] } })
    await api.graphRollup({ project: 'demo', level: 'community' })
    const qs = params(calls[0]!)
    expect(qs.get('project')).toBe('demo')
    expect(qs.get('level')).toBe('community')
    expect(qs.has('parent')).toBe(false)
  })

  it('其余三层带 parent，且**合成 id 原样透传**（含 `:` 与 `/`，靠 URLSearchParams 编码）', async () => {
    const calls = stubFetch({ ok: true, value: { level: 'dir', parent: 'community:1', total: 0, truncated: false, nodes: [], edges: [] } })
    await api.graphRollup({ project: 'demo', level: 'dir', parent: 'community:1' })
    expect(params(calls[0]!).get('parent')).toBe('community:1')

    await api.graphRollup({ project: 'demo', level: 'file', parent: 'dir:src/sub' })
    expect(new URL(calls[1]!.url, 'http://localhost').searchParams.get('parent')).toBe('dir:src/sub')

    await api.graphRollup({ project: 'demo', level: 'symbol', parent: 'file:src/sub/a.ts' })
    expect(new URL(calls[2]!.url, 'http://localhost').searchParams.get('parent')).toBe('file:src/sub/a.ts')
  })

  it('空串 parent 视同没给（不发出一个形态非法的 `parent=` → 服务端 400）', async () => {
    const calls = stubFetch({ ok: true, value: { level: 'community', parent: null, total: 0, truncated: false, nodes: [], edges: [] } })
    await api.graphRollup({ project: 'demo', level: 'community', parent: '' })
    expect(params(calls[0]!).has('parent')).toBe(false)
  })

  it('响应**不含 project**：恰好 { level, parent, total, truncated, nodes, edges }，逐字段原样返回', async () => {
    const value = {
      level: 'symbol',
      parent: 'file:src/sub/a.ts',
      total: 2,
      truncated: false,
      nodes: [
        { id: 'pkg/a.ts#alpha', label: 'alpha', kind: 'symbol', symbol_count: 1 },
        { id: 'pkg/a.ts#beta', label: 'beta', kind: 'symbol', symbol_count: 1 },
      ],
      edges: [],
    }
    stubFetch({ ok: true, value })
    const got = await api.graphRollup({ project: 'demo', level: 'symbol', parent: value.parent })
    expect(Object.keys(got).sort()).toEqual(['edges', 'level', 'nodes', 'parent', 'total', 'truncated'])
    expect(got).toEqual(value)
  })

  it('错误信封三档：`bad_request` / `not_found` / `graph_not_found` 都按 D-1 抛原文', async () => {
    stubFetch({ ok: false, error: { code: 'bad_request', message: 'level 必须为 community/dir/file/symbol: (缺省)' } })
    await expect(api.graphRollup({ project: 'demo', level: 'community' })).rejects.toThrow(/^bad_request: level 必须为/)

    stubFetch({ ok: false, error: { code: 'not_found', message: '图谱中没有 dir:no/such 对应的目录' } })
    await expect(api.graphRollup({ project: 'demo', level: 'file', parent: 'dir:no/such' })).rejects.toThrow(
      /^not_found: 图谱中没有/,
    )

    stubFetch({ ok: false, error: { code: 'graph_not_found', message: '项目没有图谱产物' } })
    await expect(api.graphRollup({ project: 'empty', level: 'community' })).rejects.toThrow(/^graph_not_found: /)
  })
})
