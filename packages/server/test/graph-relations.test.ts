/**
 * v8 F4：`GET /api/graph/relations` —— 调用链关系查询（直读 graph.json 内存过滤，零子进程）。
 *
 * 契约（design-v8 §2 + §7 第 3/10 行修订）：
 * → `{ project, node, dir, total, limit, items: [{ other, other_label, kind, file, line }] }`
 * 节点解析：精确 id → `norm_label` 精确 → 唯一前缀；多义回 `candidates`（total=0/items=[]），0 命中 404。
 *
 * 测试自造小图（不依赖真实大图），落 `<root>/graphify-out/graph.json`；
 * 项目经 `<PRISM_HOME>/graph/projects.json` 登记（同 team-activate-graph-status 先例）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { putFile } from './helpers.js'

interface FixtureNode {
  id: string
  label: string
  norm_label: string
  source_file: string
  /** 缺省 = 该节点无 source_location（测 file:line 降级链） */
  source_location?: string
}

interface FixtureEdge {
  source: string
  target: string
  relation: string
  /** 缺省 = 该边无调用点信息（测降级） */
  source_file?: string
  source_location?: string
}

const NODES: FixtureNode[] = [
  // 查询主节点：自带 location（边缺 location 时降级到它）
  { id: 'a_caller', label: 'Caller', norm_label: 'caller', source_file: 'src/caller.ts', source_location: 'L10' },
  { id: 'b_target', label: 'Target', norm_label: 'target', source_file: 'src/target.ts', source_location: 'L20' },
  { id: 'c_other', label: 'Other', norm_label: 'other', source_file: 'src/other.ts', source_location: 'L30' },
  { id: 'n1', label: 'N1', norm_label: 'n1', source_file: 'src/n1.ts', source_location: 'L1' },
  { id: 'n2', label: 'N2', norm_label: 'n2', source_file: 'src/n2.ts', source_location: 'L2' },
  { id: 'n3', label: 'N3', norm_label: 'n3', source_file: 'src/n3.ts', source_location: 'L3' },
  { id: 'n4', label: 'N4', norm_label: 'n4', source_file: 'src/n4.ts', source_location: 'L4' },
  { id: 'n5', label: 'N5', norm_label: 'n5', source_file: 'src/n5.ts', source_location: 'L5' },
  // 无 source_location：边也缺 location 时 → file/line 均为空串
  { id: 'noloc_node', label: 'NoLoc', norm_label: 'noloc', source_file: 'src/noloc.ts' },
  // norm_label 重名（多义：精确命中 2 个）
  { id: 'dup_one', label: 'Dup', norm_label: 'dup', source_file: 'src/dup1.ts', source_location: 'L1' },
  { id: 'dup_two', label: 'Dup', norm_label: 'dup', source_file: 'src/dup2.ts', source_location: 'L2' },
  // 前缀多义（widg → 2 个）与唯一前缀（widgetr → 1 个）
  { id: 'widget_a', label: 'Widget', norm_label: 'widget', source_file: 'src/widget.ts', source_location: 'L5' },
  { id: 'widget_b', label: 'Widgetry', norm_label: 'widgetry', source_file: 'src/widgetry.ts', source_location: 'L6' },
  // hub：入边 5 条（测 limit 截断 / total 全量）
  { id: 'hub', label: 'Hub', norm_label: 'hub', source_file: 'src/hub.ts', source_location: 'L1' },
]

const LINKS: FixtureEdge[] = [
  // a_caller 发出的 5 条（file 同为 src/caller.ts，行号 7/9/10/52/74 → 锁「行号按数值排序」）
  { source: 'a_caller', target: 'b_target', relation: 'calls', source_file: 'src/caller.ts', source_location: 'L52' },
  { source: 'a_caller', target: 'c_other', relation: 'imports_from', source_file: 'src/caller.ts', source_location: 'L74' },
  { source: 'a_caller', target: 'n2', relation: 'references', source_file: 'src/caller.ts', source_location: 'L9' },
  // 边无 location → 降级查询节点 a_caller（file 同源取 src/caller.ts，line 剥 L 得 "10"）
  { source: 'a_caller', target: 'n1', relation: 'calls', source_file: 'src/caller.ts' },
  { source: 'a_caller', target: 'noloc_node', relation: 'uses', source_file: 'src/caller.ts', source_location: 'L7' },
  // 指向 a_caller 的 2 条（file 不同 → 锁「file 为主排序键」）
  { source: 'c_other', target: 'a_caller', relation: 'calls', source_file: 'src/other.ts', source_location: 'L99' },
  { source: 'b_target', target: 'a_caller', relation: 'implements', source_file: 'src/target.ts', source_location: 'L20' },
  // 边与节点都无 location → file/line 置空串
  { source: 'noloc_node', target: 'b_target', relation: 'calls' },
  // hub 入边 5 条（calls ×4 + implements ×1）
  { source: 'n1', target: 'hub', relation: 'calls', source_file: 'src/n1.ts', source_location: 'L1' },
  { source: 'n2', target: 'hub', relation: 'calls', source_file: 'src/n2.ts', source_location: 'L2' },
  { source: 'n3', target: 'hub', relation: 'implements', source_file: 'src/n3.ts', source_location: 'L3' },
  { source: 'n4', target: 'hub', relation: 'calls', source_file: 'src/n4.ts', source_location: 'L4' },
  { source: 'n5', target: 'hub', relation: 'calls', source_file: 'src/n5.ts', source_location: 'L5' },
]

interface RelationItem {
  other: string
  other_label: string
  kind: string
  file: string
  line: string
}

interface RelationsValue {
  project: string
  node: string
  dir: 'in' | 'out'
  total: number
  limit: number
  items: RelationItem[]
  candidates?: Array<{ id: string; label: string }>
}

interface RelationsEnvelope {
  ok: boolean
  value?: RelationsValue
  error?: { code: string; message: string }
}

const dirs: string[] = []
let app: AppHandle
let base: string

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeAll(async () => {
  const home = await tempDir('prism-rel-home-')
  const root = await tempDir('prism-rel-proj-')
  const bare = await tempDir('prism-rel-bare-')
  // graph.json 真实形态：边写在 `links`（Python graphify 实测；graphSummary 亦两处都认）
  await putFile(
    join(root, 'graphify-out', 'graph.json'),
    `${JSON.stringify({ directed: true, nodes: NODES, links: LINKS }, null, 2)}\n`,
  )
  // 形态兼容：旧/合并产物可能把边写在 `edges`，也可能两键并存且 `edges` 为空数组
  const legacy = await tempDir('prism-rel-legacy-')
  await putFile(
    join(legacy, 'graphify-out', 'graph.json'),
    JSON.stringify({ nodes: NODES, edges: LINKS }),
  )
  const mixedKeys = await tempDir('prism-rel-mixedkeys-')
  await putFile(
    join(mixedKeys, 'graphify-out', 'graph.json'),
    JSON.stringify({ nodes: NODES, edges: [], links: LINKS }),
  )
  await putFile(
    join(home, 'graph', 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: {
        demo: { root, built_at: '2026-09-16T00:00:00.000Z', registered_at: '2026-09-16T00:00:00.000Z' },
        legacy: { root: legacy, built_at: null, registered_at: '2026-09-16T00:00:00.000Z' },
        mixedkeys: { root: mixedKeys, built_at: null, registered_at: '2026-09-16T00:00:00.000Z' },
        // 已登记但产物缺失（bare 目录下无 graphify-out/）
        empty: { root: bare, built_at: null, registered_at: '2026-09-16T00:00:00.000Z' },
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

async function getRelations(query: string): Promise<{ status: number; json: RelationsEnvelope }> {
  const res = await fetch(`${base}/api/graph/relations${query}`)
  return { status: res.status, json: (await res.json()) as RelationsEnvelope }
}

/** 取值（失败时把 error 带进断言信息，避免只看到 undefined）。 */
function valueOf(json: RelationsEnvelope): RelationsValue {
  if (json.value === undefined) {
    throw new Error(`期望 ok:true，实际 error: ${JSON.stringify(json.error)}`)
  }
  return json.value
}

/** 只取对端 id 序列（断言排序/方向用）。 */
const othersOf = (value: RelationsValue): string[] => value.items.map((item) => item.other)

describe('F4 relations：方向与对端', () => {
  it('dir=out → 查询节点作为发出方的边；dir=in → 指向查询节点的边（other 为对端）', async () => {
    const out = valueOf((await getRelations('?project=demo&node=a_caller&dir=out')).json)
    expect(out.project).toBe('demo')
    expect(out.node).toBe('a_caller')
    expect(out.dir).toBe('out')
    expect(out.total).toBe(5)
    expect(out.limit).toBe(200) // 缺省上限
    // (file, line, other)：file 同为 src/caller.ts → 行号 7/9/10/52/74 数值升序
    expect(othersOf(out)).toEqual(['noloc_node', 'n2', 'n1', 'b_target', 'c_other'])
    expect(out.items.map((i) => i.other_label)).toEqual(['NoLoc', 'N2', 'N1', 'Target', 'Other'])
    expect(out.candidates).toBeUndefined() // 非多义 → 不下发 candidates

    const inb = valueOf((await getRelations('?project=demo&node=a_caller&dir=in')).json)
    expect(inb.dir).toBe('in')
    expect(inb.total).toBe(2)
    // file 为主排序键：src/other.ts < src/target.ts
    expect(othersOf(inb)).toEqual(['c_other', 'b_target'])
    expect(inb.items.map((i) => i.kind)).toEqual(['calls', 'implements'])
  })

  it('items 排序稳定：同一查询重复请求逐字段一致（幂等）', async () => {
    const first = valueOf((await getRelations('?project=demo&node=a_caller&dir=out')).json)
    const second = valueOf((await getRelations('?project=demo&node=a_caller&dir=out')).json)
    expect(second).toEqual(first)
  })
})

describe('F4 relations：file:line 提取与降级', () => {
  it('边带 "L52" → line "52"；剥 L 前缀且 file 取边上的 source_file', async () => {
    const value = valueOf((await getRelations('?project=demo&node=a_caller&dir=out')).json)
    const byOther = new Map(value.items.map((item) => [item.other, item]))
    expect(byOther.get('b_target')).toEqual({
      other: 'b_target',
      other_label: 'Target',
      kind: 'calls',
      file: 'src/caller.ts',
      line: '52',
    })
    expect(byOther.get('c_other')?.line).toBe('74')
    expect(byOther.get('n2')?.line).toBe('9')
  })

  it('边缺 location → 降级查询节点自身的 source_file/source_location', async () => {
    const value = valueOf((await getRelations('?project=demo&node=a_caller&dir=out')).json)
    const degraded = value.items.find((item) => item.other === 'n1')
    // 边给了 source_file 但没给 location → 二者同源回落到节点：src/caller.ts / L10 → "10"
    expect(degraded).toEqual({
      other: 'n1',
      other_label: 'N1',
      kind: 'calls',
      file: 'src/caller.ts',
      line: '10',
    })
  })

  it('边与查询节点都缺 location → file/line 均为空串', async () => {
    const value = valueOf((await getRelations('?project=demo&node=noloc_node&dir=out')).json)
    expect(value.total).toBe(1)
    expect(value.items[0]).toEqual({
      other: 'b_target',
      other_label: 'Target',
      kind: 'calls',
      file: '',
      line: '',
    })
  })

  it('dir=in 时 file:line 取**调用方**的调用点（而非查询节点自身的）', async () => {
    const value = valueOf((await getRelations('?project=demo&node=a_caller&dir=in')).json)
    const byOther = new Map(value.items.map((item) => [item.other, item]))
    // 查询节点 a_caller 自己是 L10；入边给出的必须是调用方的 L99 / L20
    expect(byOther.get('c_other')?.line).toBe('99')
    expect(byOther.get('c_other')?.file).toBe('src/other.ts')
    expect(byOther.get('b_target')?.line).toBe('20')
    expect(byOther.get('b_target')?.file).toBe('src/target.ts')
  })
})

describe('F4 relations：节点解析（id / norm_label / 前缀 / 多义 / 404）', () => {
  it('精确 id 命中即用（不参与 label 匹配）', async () => {
    const value = valueOf((await getRelations('?project=demo&node=dup_one&dir=in')).json)
    expect(value.node).toBe('dup_one')
    expect(value.total).toBe(0)
    expect(value.items).toEqual([])
  })

  it('符号名按 norm_label 精确命中（大小写归一：WIDGET → widget_a）', async () => {
    const lower = valueOf((await getRelations('?project=demo&node=widget&dir=in')).json)
    expect(lower.node).toBe('widget_a')
    const upper = valueOf((await getRelations('?project=demo&node=WIDGET&dir=in')).json)
    expect(upper.node).toBe('widget_a')
  })

  it('唯一前缀命中可解析（widgetr → widget_b）', async () => {
    const value = valueOf((await getRelations('?project=demo&node=widgetr&dir=in')).json)
    expect(value.node).toBe('widget_b')
    expect(value.total).toBe(0)
  })

  it('前缀多义（widg → 2 个）→ 200 + candidates，node 回显原串、total=0/items=[]', async () => {
    const res = await getRelations('?project=demo&node=widg&dir=in')
    expect(res.status).toBe(200)
    const value = valueOf(res.json)
    expect(value.node).toBe('widg')
    expect(value.dir).toBe('in')
    expect(value.limit).toBe(200)
    expect(value.total).toBe(0)
    expect(value.items).toEqual([])
    // 候选按 (label, id) 排序
    expect(value.candidates).toEqual([
      { id: 'widget_a', label: 'Widget' },
      { id: 'widget_b', label: 'Widgetry' },
    ])
  })

  it('norm_label 同名（dup → 2 个）→ 200 + candidates（按 label,id 排序）', async () => {
    const value = valueOf((await getRelations('?project=demo&node=dup&dir=in')).json)
    expect(value.node).toBe('dup')
    expect(value.items).toEqual([])
    expect(value.candidates).toEqual([
      { id: 'dup_one', label: 'Dup' },
      { id: 'dup_two', label: 'Dup' },
    ])
  })

  it('0 命中 → 404 not_found', async () => {
    const res = await getRelations('?project=demo&node=no_such_symbol_xyz&dir=in')
    expect(res.status).toBe(404)
    expect(res.json.ok).toBe(false)
    expect(res.json.error?.code).toBe('not_found')
  })
})

describe('F4 relations：relation 过滤 / limit 截断（total 全量）', () => {
  it('缺省不过滤 → 全部关系；relation= 白名单精确过滤边 relation', async () => {
    const all = valueOf((await getRelations('?project=demo&node=hub&dir=in')).json)
    expect(all.total).toBe(5)
    expect(othersOf(all)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5'])

    const calls = valueOf((await getRelations('?project=demo&node=hub&dir=in&relation=calls')).json)
    expect(calls.total).toBe(4)
    expect(othersOf(calls)).toEqual(['n1', 'n2', 'n4', 'n5'])
    expect(calls.items.every((item) => item.kind === 'calls')).toBe(true)

    const multi = valueOf((await getRelations('?project=demo&node=hub&dir=in&relation=calls,implements')).json)
    expect(multi.total).toBe(5)

    // 未知名（UI 默认 calls,invokes 里的 invokes 在部分图谱不存在）→ 不报错，只是 0 命中
    const unknown = valueOf((await getRelations('?project=demo&node=hub&dir=in&relation=invokes')).json)
    expect(unknown.total).toBe(0)
    expect(unknown.items).toEqual([])
  })

  it('limit 截断 items，但 total 恒为过滤后全量计数', async () => {
    const value = valueOf((await getRelations('?project=demo&node=hub&dir=in&limit=2')).json)
    expect(value.limit).toBe(2)
    expect(value.items.length).toBe(2)
    expect(value.total).toBe(5)

    const filtered = valueOf((await getRelations('?project=demo&node=hub&dir=in&relation=calls&limit=1')).json)
    expect(filtered.limit).toBe(1)
    expect(filtered.items.length).toBe(1)
    expect(filtered.total).toBe(4)
    expect(othersOf(filtered)).toEqual(['n1'])
  })
})

describe('F4 relations：graph.json 边键形态兼容（links / edges）', () => {
  it('边写在 `edges`（旧/合并产物）与「`edges` 为空数组 + `links` 有数据」都能查到同样结果', async () => {
    const expected = ['noloc_node', 'n2', 'n1', 'b_target', 'c_other']
    for (const project of ['demo', 'legacy', 'mixedkeys']) {
      const value = valueOf((await getRelations(`?project=${project}&node=a_caller&dir=out`)).json)
      expect(othersOf(value), project).toEqual(expected)
      expect(value.total, project).toBe(5)
    }
  })
})

describe('F4 relations：错误码（产物缺失 / 未注册项目 / 参数）', () => {
  it('产物缺失 → graph_not_found（既有先例）', async () => {
    const res = await getRelations('?project=empty&node=a_caller&dir=out')
    expect(res.status).toBe(404)
    expect(res.json.error?.code).toBe('graph_not_found')
    expect(res.json.error?.message).toContain('graphify-out')
  })

  it('未注册项目 → not_found', async () => {
    const res = await getRelations('?project=ghost&node=a_caller&dir=out')
    expect(res.status).toBe(404)
    expect(res.json.error?.code).toBe('not_found')
  })

  it('参数缺失/非法 → 400 bad_request（project / node / dir / limit）', async () => {
    for (const query of [
      '?node=a_caller&dir=out', // 缺 project
      '?project=demo&dir=out', // 缺 node
      '?project=demo&node=a_caller', // 缺 dir
      '?project=demo&node=a_caller&dir=sideways', // dir 非法
      '?project=demo&node=a_caller&dir=out&limit=0', // limit 非正
      '?project=demo&node=a_caller&dir=out&limit=abc', // limit 非整数
    ]) {
      const res = await getRelations(query)
      expect(res.status, query).toBe(400)
      expect(res.json.error?.code, query).toBe('bad_request')
    }
  })
})
