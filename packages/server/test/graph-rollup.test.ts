/**
 * v10 F9：`GET /api/graph/rollup` —— 图谱分层聚合·逐级探索（直读 graph.json 内存分组，零子进程）。
 *
 * 契约（design-v10 F9 + 交叉验证 F9-1..F9-6）：
 * → `{ level, parent, total, truncated, nodes: [{ id, label, kind, symbol_count, community? }],
 *      edges: [{ from, to, weight }] }`（**不含 `project`**，形状钉死给前端）
 * 四层：community（无 parent）/ dir（parent=community:<n>）/ file（parent=dir:<path>）/
 * symbol（parent=file:<path>，只读出口，nodes[].id = **真实图谱节点 id**）。
 *
 * 本文件用**合成小图**（不依赖真实大图），落 `<root>/graphify-out/graph.json`；
 * 项目经 `<PRISM_HOME>/graph/projects.json` 登记（同 graph-relations.test.ts 先例）。
 */
import { stat, utimes } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { putFile } from './helpers.js'

interface RollupNode {
  id: string
  label: string
  kind: string
  symbol_count: number
  community?: number | string
}

interface RollupEdge {
  from: string
  to: string
  weight: number
}

interface RollupValue {
  level: string
  parent: string | null
  total: number
  truncated: boolean
  nodes: RollupNode[]
  edges: RollupEdge[]
}

interface Envelope {
  ok: boolean
  value?: RollupValue
  error?: { code: string; message: string }
}

// ===== 主 fixture：覆盖四层 + 未分组桶 + 跨社区文件 + calls 族过滤 =====

interface FixtureNode {
  id: string
  label: string
  source_file?: string
  community?: number
  community_name?: string
}

interface FixtureLink {
  source: string
  target: string
  relation?: string
}

const NODES: FixtureNode[] = [
  // community 1「核心」：src/a.ts ×2 + src/sub/b.ts ×2（与 community 2 共用同一文件）
  { id: 'c1a', label: 'A1', source_file: 'src/a.ts', community: 1, community_name: '核心' },
  { id: 'c1b', label: 'A2', source_file: 'src/a.ts', community: 1, community_name: '核心' },
  { id: 'c1c', label: 'B1', source_file: 'src/sub/b.ts', community: 1, community_name: '核心' },
  { id: 'c1d', label: 'B3', source_file: 'src/sub/b.ts', community: 1, community_name: '核心' },
  // community 2「工具」：与 community 1 共享 src/sub/b.ts（62/274 文件跨社区的真实形态）
  { id: 'c2a', label: 'B2', source_file: 'src/sub/b.ts', community: 2, community_name: '工具' },
  // community 3：**无 community_name** → label 回落 `Community 3`
  { id: 'c3a', label: 'D1', source_file: 'src/d.ts', community: 3 },
  // 无 community → 未分组桶；u2 无 source_file → (unknown) 桶
  { id: 'u1', label: 'C1', source_file: 'src/c.ts' },
  { id: 'u2', label: 'U2' },
]

const LINKS: FixtureLink[] = [
  // community 1 内部（同组，community 层不计）
  { source: 'c1a', target: 'c1b', relation: 'calls' },
  // 1 → 2 两条 → weight 2
  { source: 'c1a', target: 'c2a', relation: 'calls' },
  { source: 'c1b', target: 'c2a', relation: 'calls' },
  // 2 → _ ：invokes 属 calls 族，计入
  { source: 'c2a', target: 'u1', relation: 'invokes' },
  { source: 'c3a', target: 'c1a', relation: 'calls' },
  { source: 'u1', target: 'c1a', relation: 'calls' },
  // **结构边：必须不计入 weight**（F9-4 钉死）
  { source: 'c1a', target: 'u1', relation: 'imports' },
  { source: 'c2a', target: 'c3a', relation: 're_exports' },
  { source: 'u1', target: 'u2', relation: 'imports' },
  // community 1 内部跨目录（dir 层唯一可见的跨组边）
  { source: 'c1c', target: 'c1a', relation: 'calls' },
  // 未分组桶内部跨目录（(unknown) → src）
  { source: 'u2', target: 'u1', relation: 'calls' },
  // 端点不在图里 / 无 relation：一律忽略
  { source: 'ghost', target: 'c1a', relation: 'calls' },
  { source: 'c1a', target: 'c1b' },
]

// ===== 截断 fixture：503 个 dir 桶（>500）=====

const BIG_COMMUNITY = 7
const HEAVY_DIR = 'zz_heavy'
const BIG_DIR_COUNT = 502

function bigFixture(): { nodes: FixtureNode[]; links: FixtureLink[] } {
  const nodes: FixtureNode[] = [
    // 3 个符号同目录 → symbol_count 3（label 字典序最后，但靠计数排第一）
    { id: 'h0', label: 'H0', source_file: `${HEAVY_DIR}/h0.ts`, community: BIG_COMMUNITY },
    { id: 'h1', label: 'H1', source_file: `${HEAVY_DIR}/h1.ts`, community: BIG_COMMUNITY },
    { id: 'h2', label: 'H2', source_file: `${HEAVY_DIR}/h2.ts`, community: BIG_COMMUNITY },
  ]
  for (let i = 0; i < BIG_DIR_COUNT; i += 1) {
    const dir = `d${String(i).padStart(3, '0')}`
    nodes.push({ id: `n_${dir}`, label: `N${dir}`, source_file: `${dir}/f.ts`, community: BIG_COMMUNITY })
  }
  const links: FixtureLink[] = [
    // 指向被截断的 d501 → 该边必须**消失**（无悬挂边）
    { source: 'h0', target: 'n_d501', relation: 'calls' },
    // 两端都在返回集内 → 保留
    { source: 'h1', target: 'n_d000', relation: 'calls' },
    { source: 'n_d000', target: 'h0', relation: 'invokes' },
    { source: 'n_d000', target: 'n_d001', relation: 'calls' },
  ]
  return { nodes, links }
}

const dirs: string[] = []
let app: AppHandle
let base: string
let cacheGraphFile = ''

// ===== 「`links: []` + `edges` 非空」fixture（派修 P2-4：边读取取非空侧）=====
//
// 形态来源：合并/合成产物两键并存且 `links` 是空数组（真实 graph.json 只写 `links`）。
// `normalizeGraph` 用 `links ?? edges` ⇒ 空数组胜出、非空 `edges` 被静默丢掉，
// 于是「rollup 见 0 边，而 `/api/graph/relations` 走 `readGraphEdges`（取非空侧）看得到边」。

const EDGE_SIDE_NODES: FixtureNode[] = [
  { id: 'e1', label: 'E1', source_file: 'src/e1.ts', community: 1, community_name: '边侧一' },
  { id: 'e2', label: 'E2', source_file: 'src/e2.ts', community: 2, community_name: '边侧二' },
]

const EDGE_SIDE_EDGES: FixtureLink[] = [{ source: 'e1', target: 'e2', relation: 'calls' }]

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeAll(async () => {
  const home = await tempDir('prism-rollup-home-')
  const root = await tempDir('prism-rollup-proj-')
  await putFile(
    join(root, 'graphify-out', 'graph.json'),
    `${JSON.stringify({ directed: true, nodes: NODES, links: LINKS }, null, 2)}\n`,
  )
  const big = await tempDir('prism-rollup-big-')
  await putFile(join(big, 'graphify-out', 'graph.json'), JSON.stringify(bigFixture()))
  const cache = await tempDir('prism-rollup-cache-')
  cacheGraphFile = join(cache, 'graphify-out', 'graph.json')
  await putFile(cacheGraphFile, cacheGraphJson(1))
  const bare = await tempDir('prism-rollup-bare-')
  const edgeSide = await tempDir('prism-rollup-edgeside-')
  await putFile(
    join(edgeSide, 'graphify-out', 'graph.json'),
    JSON.stringify({ nodes: EDGE_SIDE_NODES, links: [], edges: EDGE_SIDE_EDGES }),
  )

  await putFile(
    join(home, 'graph', 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: {
        demo: { root, built_at: '2026-09-17T00:00:00.000Z', registered_at: '2026-09-17T00:00:00.000Z' },
        big: { root: big, built_at: null, registered_at: '2026-09-17T00:00:00.000Z' },
        cache: { root: cache, built_at: null, registered_at: '2026-09-17T00:00:00.000Z' },
        edgeside: { root: edgeSide, built_at: null, registered_at: '2026-09-17T00:00:00.000Z' },
        // 已登记但产物缺失
        empty: { root: bare, built_at: null, registered_at: '2026-09-17T00:00:00.000Z' },
      },
    }),
  )
  app = await startServer({ home, port: 0 })
  base = `http://127.0.0.1:${app.port}`
})

afterAll(async () => {
  await app.close()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

/** 缓存 fixture 的 graph.json：**等长**（改 community 号不改变字节数，用于锁 mtime 失效键）。 */
function cacheGraphJson(community: number): string {
  return JSON.stringify({ nodes: [{ id: 'n1', label: 'N1', source_file: 'a/x.ts', community }], links: [] })
}

async function rollup(query: string): Promise<{ status: number; json: Envelope }> {
  // 项目名 + parent（含 `:` `/`）一律编码，避免依赖 URL 对特殊字符的宽容
  const res = await fetch(`${base}/api/graph/rollup?${query}`)
  return { status: res.status, json: (await res.json()) as Envelope }
}

function q(project: string, level: string, parent?: string): string {
  const params = new URLSearchParams({ project, level })
  if (parent !== undefined) params.set('parent', parent)
  return params.toString()
}

function valueOf(json: Envelope): RollupValue {
  if (json.value === undefined) {
    throw new Error(`期望 ok:true，实际 error: ${JSON.stringify(json.error)}`)
  }
  return json.value
}

const idsOf = (value: RollupValue): string[] => value.nodes.map((node) => node.id)

describe('F9 rollup：community 层', () => {
  it('按 community 分组、未分组桶 community:_、label 回落 Community <id>', async () => {
    const { status, json } = await rollup(q('demo', 'community'))
    expect(status).toBe(200)
    const value = valueOf(json)
    expect(value.level).toBe('community')
    expect(value.parent).toBeNull()
    expect(value.truncated).toBe(false)
    expect(value.total).toBe(4)
    // symbol_count 降序 → community:1(4)、community:_(2)；同计数按 **label** 字典序
    // （'Community 3' 的 'C' < '工具' 的 '工'，故 community:3 在前——排序键是 label 不是 id）
    expect(idsOf(value)).toEqual(['community:1', 'community:_', 'community:3', 'community:2'])
    const byId = new Map(value.nodes.map((node) => [node.id, node]))
    expect(byId.get('community:1')).toEqual({
      id: 'community:1',
      label: '核心',
      kind: 'community',
      symbol_count: 4,
    })
    expect(byId.get('community:2')?.label).toBe('工具')
    // 无 community_name → 回落
    expect(byId.get('community:3')?.label).toBe('Community 3')
    // 未分组
    expect(byId.get('community:_')?.label).toBe('未分组')
    expect(byId.get('community:_')?.symbol_count).toBe(2)
    // community 层不带 community 字段
    for (const node of value.nodes) {
      expect(Object.keys(node).sort()).toEqual(['id', 'kind', 'label', 'symbol_count'])
    }
  })

  it('weight = 跨组边条数，且只计 calls 族（imports / re_exports 不计入）', async () => {
    const value = valueOf((await rollup(q('demo', 'community'))).json)
    expect(value.edges).toEqual([
      { from: 'community:1', to: 'community:2', weight: 2 },
      { from: 'community:2', to: 'community:_', weight: 1 },
      { from: 'community:3', to: 'community:1', weight: 1 },
      { from: 'community:_', to: 'community:1', weight: 1 },
    ])
  })

  it('响应形状钉死：恰好 { level, parent, total, truncated, nodes, edges }', async () => {
    const value = valueOf((await rollup(q('demo', 'community'))).json)
    expect(Object.keys(value).sort()).toEqual(['edges', 'level', 'nodes', 'parent', 'total', 'truncated'])
  })
})

describe('F9 rollup：dir 层（按目录全路径聚合）', () => {
  it('parent=community:1 → 只数该社区成员，label 为目录全路径，community 回填编号', async () => {
    const { status, json } = await rollup(q('demo', 'dir', 'community:1'))
    expect(status).toBe(200)
    const value = valueOf(json)
    expect(value.level).toBe('dir')
    expect(value.parent).toBe('community:1')
    expect(value.total).toBe(2)
    expect(value.nodes).toEqual([
      { id: 'dir:src', label: 'src', kind: 'dir', symbol_count: 2, community: 1 },
      { id: 'dir:src/sub', label: 'src/sub', kind: 'dir', symbol_count: 2, community: 1 },
    ])
    // 唯一跨组边：c1c（src/sub）→ c1a（src）；c1a→c2a 的对端不在本层
    expect(value.edges).toEqual([{ from: 'dir:src/sub', to: 'dir:src', weight: 1 }])
  })

  it('独立投影：同一文件属两个社区时两侧计数各自正确（非包含树）', async () => {
    const one = valueOf((await rollup(q('demo', 'dir', 'community:1'))).json)
    const two = valueOf((await rollup(q('demo', 'dir', 'community:2'))).json)
    // src/sub/b.ts 在 community 1 侧有 2 个符号（c1c/c1d），community 2 侧只有 1 个（c2a）
    expect(one.nodes.find((node) => node.id === 'dir:src/sub')?.symbol_count).toBe(2)
    expect(two.nodes).toEqual([
      { id: 'dir:src/sub', label: 'src/sub', kind: 'dir', symbol_count: 1, community: 2 },
    ])
  })

  it('parent=community:_ → 未分组桶，含 (unknown) 目录；community 字段省略', async () => {
    const value = valueOf((await rollup(q('demo', 'dir', 'community:_'))).json)
    expect(value.parent).toBe('community:_')
    const byId = new Map(value.nodes.map((node) => [node.id, node]))
    // 同计数 1 → label 字典序：'(unknown)' 的 '(' < 's'
    expect(idsOf(value)).toEqual(['dir:(unknown)', 'dir:src'])
    expect(byId.get('dir:(unknown)')).toEqual({
      id: 'dir:(unknown)',
      label: '(unknown)',
      kind: 'dir',
      symbol_count: 1,
    })
    for (const node of value.nodes) {
      expect(node.community).toBeUndefined()
    }
    // u2（无 source_file）→ u1（src）跨组 calls
    expect(value.edges).toEqual([{ from: 'dir:(unknown)', to: 'dir:src', weight: 1 }])
  })
})

describe('F9 rollup：file 层（父目录的全图口径）', () => {
  it('parent=dir:src/sub → 目录下全部文件节点（跨社区成员都在）', async () => {
    const value = valueOf((await rollup(q('demo', 'file', 'dir:src/sub'))).json)
    expect(value.level).toBe('file')
    expect(value.parent).toBe('dir:src/sub')
    // dir 层在 community:1 只有 2 个，file 层是全图口径 3 个 —— 独立投影的可见证据
    expect(value.nodes).toEqual([
      { id: 'file:src/sub/b.ts', label: 'src/sub/b.ts', kind: 'file', symbol_count: 3 },
    ])
    expect(value.edges).toEqual([])
  })

  it('parent=dir:src → 多文件按 symbol_count 降序；无 source_file 归 file:(unknown)', async () => {
    const value = valueOf((await rollup(q('demo', 'file', 'dir:src'))).json)
    // 全图口径：src/a.ts（c1a/c1b）、src/c.ts（u1）、src/d.ts（c3a，社区 3——社区 1 的 dir 层看不到它）
    expect(idsOf(value)).toEqual(['file:src/a.ts', 'file:src/c.ts', 'file:src/d.ts'])
    expect(value.nodes[0]?.symbol_count).toBe(2)
    expect(value.edges).toEqual([
      { from: 'file:src/c.ts', to: 'file:src/a.ts', weight: 1 },
      { from: 'file:src/d.ts', to: 'file:src/a.ts', weight: 1 },
    ])

    const unknown = valueOf((await rollup(q('demo', 'file', 'dir:(unknown)'))).json)
    expect(unknown.nodes).toEqual([
      { id: 'file:(unknown)', label: '(unknown)', kind: 'file', symbol_count: 1 },
    ])
  })
})

describe('F9 rollup：symbol 层（只读出口，给真实节点 id）', () => {
  it('parent=file:<path> → 真实图谱节点 id + kind=symbol + edges=[]', async () => {
    const { status, json } = await rollup(q('demo', 'symbol', 'file:src/sub/b.ts'))
    expect(status).toBe(200)
    const value = valueOf(json)
    expect(value.parent).toBe('file:src/sub/b.ts')
    expect(value.total).toBe(3)
    // 真实 id（合成节点在四模式查询里必然 404，故这里必须给真名）
    expect(idsOf(value).sort()).toEqual(['c1c', 'c1d', 'c2a'])
    for (const node of value.nodes) {
      expect(node.kind).toBe('symbol')
      expect(node.symbol_count).toBe(1)
    }
    expect(value.nodes.find((node) => node.id === 'c1d')?.label).toBe('B3')
    expect(value.edges).toEqual([])
  })

  it('parent=file:(unknown) → 无 source_file 的节点（label 回落 id）', async () => {
    const value = valueOf((await rollup(q('demo', 'symbol', 'file:(unknown)'))).json)
    expect(idsOf(value)).toEqual(['u2'])
    expect(value.nodes[0]?.label).toBe('U2')
  })
})

describe('F9 rollup：top-500 截断', () => {
  it('total/truncated 正确、按 symbol_count 降序 + label 字典序、无悬挂边', async () => {
    const value = valueOf((await rollup(q('big', 'dir', `community:${BIG_COMMUNITY}`))).json)
    expect(value.total).toBe(503)
    expect(value.truncated).toBe(true)
    expect(value.nodes.length).toBe(500)
    // 计数 3 的桶排第一（尽管 label 字典序最后）
    expect(value.nodes[0]).toEqual({
      id: `dir:${HEAVY_DIR}`,
      label: HEAVY_DIR,
      kind: 'dir',
      symbol_count: 3,
      community: BIG_COMMUNITY,
    })
    // 同计数 → label 字典序；恰好切到 d498
    expect(value.nodes[1]?.id).toBe('dir:d000')
    expect(value.nodes[value.nodes.length - 1]?.id).toBe('dir:d498')
    const kept = new Set(idsOf(value))
    expect(kept.has('dir:d499')).toBe(false)
    expect(kept.has('dir:d501')).toBe(false)
    // 指向被截断节点的那条边（h0 → n_d501）必须消失；其余 3 条两端都在返回集内
    // （边按 from → to 字典序：同 from 时 'd001' < 'zz_heavy'）
    expect(value.edges).toEqual([
      { from: 'dir:d000', to: 'dir:d001', weight: 1 },
      { from: 'dir:d000', to: `dir:${HEAVY_DIR}`, weight: 1 },
      { from: `dir:${HEAVY_DIR}`, to: 'dir:d000', weight: 1 },
    ])
    for (const edge of value.edges) {
      expect(kept.has(edge.from) && kept.has(edge.to)).toBe(true)
    }
  })

  it('未超限的层 truncated=false 且不排序丢失（community 层）', async () => {
    const value = valueOf((await rollup(q('big', 'community'))).json)
    expect(value.total).toBe(1)
    expect(value.truncated).toBe(false)
    expect(idsOf(value)).toEqual([`community:${BIG_COMMUNITY}`])
  })
})

describe('F9 rollup：缓存失效键（path+mtime+size）', () => {
  it('等长改写 + mtime 变化后重读（仅 size 无法解释命中变化）', async () => {
    const first = valueOf((await rollup(q('cache', 'community'))).json)
    expect(idsOf(first)).toEqual(['community:1'])

    // 等长改写：只有 community 号变化，字节长度不变 → size 相同、mtime 必须参与失效
    const before = await stat(cacheGraphFile)
    const next = cacheGraphJson(2)
    expect(next.length).toBe(cacheGraphJson(1).length)
    await putFile(cacheGraphFile, next)
    const bumped = new Date(before.mtimeMs + 5000)
    await utimes(cacheGraphFile, bumped, bumped)

    const second = valueOf((await rollup(q('cache', 'community'))).json)
    expect(idsOf(second)).toEqual(['community:2'])
  })
})

describe('F9 rollup：边读取取非空侧（派修 P2-4）', () => {
  it('`links: []` 而 `edges` 非空 → rollup 照样看得见边（不再是 0 条）', async () => {
    const { status, json } = await rollup(q('edgeside', 'community'))
    expect(status).toBe(200)
    const value = valueOf(json)
    expect(idsOf(value)).toEqual(['community:1', 'community:2'])
    // 修复前：normalizeGraph 的 `links ?? edges` 让空数组胜出 → 这里恒为 []
    expect(value.edges).toEqual([{ from: 'community:1', to: 'community:2', weight: 1 }])
  })
})

describe('F9 rollup：parent 反解与错误', () => {
  it('level 非法/缺省 → 400', async () => {
    const missing = await rollup('project=demo')
    expect(missing.status).toBe(400)
    expect(missing.json.error?.message).toContain('level 必须为')

    const bad = await rollup(q('demo', 'communities'))
    expect(bad.status).toBe(400)
    expect(bad.json.error?.message).toContain('level 必须为')
  })

  it('缺 project → 400；未注册项目 → 404；产物缺失 → 404 graph_not_found', async () => {
    const noProject = await rollup('level=community')
    expect(noProject.status).toBe(400)
    expect(noProject.json.error?.code).toBe('bad_request')

    const unknown = await rollup(q('nope', 'community'))
    expect(unknown.status).toBe(404)
    expect(unknown.json.error?.code).toBe('not_found')

    const empty = await rollup(q('empty', 'community'))
    expect(empty.status).toBe(404)
    expect(empty.json.error?.code).toBe('graph_not_found')
  })

  it('该层缺 parent → 400；形态不符 → 400（community 层不接受 parent）', async () => {
    for (const level of ['dir', 'file', 'symbol']) {
      const { status, json } = await rollup(q('demo', level))
      expect(status).toBe(400)
      expect(json.error?.message).toContain('缺少 parent')
    }
    const wrongPrefix = await rollup(q('demo', 'dir', 'dir:src'))
    expect(wrongPrefix.status).toBe(400)
    expect(wrongPrefix.json.error?.message).toContain('形态非法')

    const extra = await rollup(q('demo', 'community', 'community:1'))
    expect(extra.status).toBe(400)
    expect(extra.json.error?.message).toContain('不接受 parent')

    const emptyValue = await rollup(q('demo', 'file', 'dir:'))
    expect(emptyValue.status).toBe(400)
  })

  it('parent 反解后在图中无对应实体 → 404', async () => {
    const community = await rollup(q('demo', 'dir', 'community:99'))
    expect(community.status).toBe(404)
    expect(community.json.error?.code).toBe('not_found')

    const dir = await rollup(q('demo', 'file', 'dir:no/such/dir'))
    expect(dir.status).toBe(404)

    const file = await rollup(q('demo', 'symbol', 'file:src/nope.ts'))
    expect(file.status).toBe(404)
  })
})
