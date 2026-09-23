/**
 * v17 B-C8 / SPEC-C8.1：`GET /api/graph/path` —— 服务端**读图 + BFS 自求路径**。
 *
 * 为什么不走 `graphify path` 子进程：它的输出只有 **label 链**，而下游（时序图导出 /
 * 前端链路图）按**节点 id**寻址——本仓冻结裁决 F5-2 禁止 label 顶替寻址，且本仓 2340 节点
 * 仅 2063 个唯一 label（159 个 label 值跨文件重名）。故服务端直读 `graph.json`（带 mtime+size 失效键的进程内缓存）自己
 * BFS，每跳 file:line 从用到的**边数据**取。
 *
 * 断言（逐条回溯 spec-v17 §C8.1）：
 * - 6 跳 → `chain` **7 节点**，每跳 file:line 是具体值（对 fixture 图断言，不是「非空」）；
 * - 多义跳 → `file`/`line` 空 + `ambiguous: true`；
 * - 起点/终点 label 多义：**落图内首个唯一匹配**，且「首个」= BFS 命中路径上的**首个可落地解**
 *   （两个候选都能到时取图内序在前者；只有远者能到时取远者——不是无脑取候选[0]）；
 * - 无解 / 端点不存在 / 起终点同节点 → `found:false`（不是错误）；
 * - 缓存：图重建（mtime/size 变）后**重读**，不吐陈旧链。
 *
 * 全部走临时目录（R5：绝不写真实宿主目录）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmpTag } from '@prism/core'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { graphPathChain, type GraphPathChainResult } from '../src/graph/graphify.js'
import { putFile } from './helpers.js'

const NODES_CHAIN: Array<Record<string, unknown>> = []
for (let i = 0; i <= 6; i += 1) {
  NODES_CHAIN.push({
    id: `h${i}`,
    label: `Hop${i}`,
    norm_label: `hop${i}`,
    source_file: `src/h/h${i}.ts`,
    source_location: `L${i}`,
    community: i,
  })
}
NODES_CHAIN.push(
  { id: 'side', label: 'Side', norm_label: 'side', source_file: 'src/side/side.ts', source_location: 'L5' },
  { id: 'side2', label: 'Side2', norm_label: 'side2', source_file: 'src/side/side2.ts', source_location: 'L6' },
  { id: 'island', label: 'Island', norm_label: 'island', source_file: 'src/island/island.ts' },
)

/**
 * 6 跳正链 `h0 → … → h6`（每跳带调用点 file:line）+ 一条**旁支** `h3 → side → side2`
 * （不进链：比正链更长，顺带锁「BFS 取最短路 + 邻居排序」的确定性）+ 一个孤立点。
 */
const LINKS_CHAIN: Array<Record<string, unknown>> = []
for (let i = 0; i + 1 <= 6; i += 1) {
  LINKS_CHAIN.push({
    source: `h${i}`,
    target: `h${i + 1}`,
    relation: 'calls',
    source_file: `src/h/h${i}.ts`,
    source_location: `L${(i + 1) * 10}`,
  })
}
LINKS_CHAIN.push(
  { source: 'h3', target: 'side', relation: 'calls', source_file: 'src/h/h3.ts', source_location: 'L99' },
  { source: 'side', target: 'side2', relation: 'calls', source_file: 'src/side/side.ts', source_location: 'L5' },
)

/**
 * 多义端点图：`dup_a` / `dup_b` 共用 norm_label `dup`（label 都叫 `Dup`）。
 * - `dup` → `m1`：只有 `dup_a`（经 `x_node`）能到 → 「首个**可落地**解」落在 dup_a；
 * - `dup` → `m2`：`dup_a` 要 3 跳、`dup_b` 只要 1 跳 → 落在 **dup_b**（不是候选[0]）。
 */
const NODES_DUP: Array<Record<string, unknown>> = [
  { id: 'dup_a', label: 'Dup', norm_label: 'dup', source_file: 'src/dup/a.ts', source_location: 'L1' },
  { id: 'dup_b', label: 'Dup', norm_label: 'dup', source_file: 'src/dup/b.ts', source_location: 'L2' },
  { id: 'x_node', label: 'Xstep', norm_label: 'xstep', source_file: 'src/x/x.ts', source_location: 'L5' },
  { id: 'm1', label: 'M1', norm_label: 'm1', source_file: 'src/m/m1.ts', source_location: 'L7' },
  { id: 'm2', label: 'M2', norm_label: 'm2', source_file: 'src/m/m2.ts', source_location: 'L9' },
]
const LINKS_DUP: Array<Record<string, unknown>> = [
  { source: 'dup_a', target: 'x_node', relation: 'calls', source_file: 'src/dup/a.ts', source_location: 'L21' },
  { source: 'x_node', target: 'm1', relation: 'calls', source_file: 'src/x/x.ts', source_location: 'L22' },
  { source: 'm1', target: 'm2', relation: 'calls', source_file: 'src/m/m1.ts', source_location: 'L23' },
  { source: 'dup_b', target: 'm2', relation: 'calls', source_file: 'src/dup/b.ts', source_location: 'L31' },
  // 让「终点用多义 label」这一路可达：x_node → dup_b
  { source: 'x_node', target: 'dup_b', relation: 'calls', source_file: 'src/x/x.ts', source_location: 'L41' },
]

interface Hop {
  id: string
  label: string
  file: string
  line: string
  ambiguous?: boolean
}

interface PathValue {
  project: string
  raw: string
  hops: number | null
  chain: Hop[]
  found: boolean
}

interface PathEnvelope {
  ok: boolean
  value?: PathValue
  error?: { code: string; message: string }
}

const dirs: string[] = []
let app: AppHandle
let base: string
let cacheRoot: string

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix.replace(/-$/, `-${tmpTag()}-`)))
  dirs.push(dir)
  return dir
}

beforeAll(async () => {
  const home = await tempDir('prism-path-home-')
  const chainRoot = await tempDir('prism-path-chain-')
  const dupRoot = await tempDir('prism-path-dup-')
  cacheRoot = await tempDir('prism-path-cache-')
  // graph.json 真实形态：边写在 `links`（Python graphify 实测）
  await putFile(
    join(chainRoot, 'graphify-out', 'graph.json'),
    JSON.stringify({ directed: false, nodes: NODES_CHAIN, links: LINKS_CHAIN }),
  )
  await putFile(
    join(dupRoot, 'graphify-out', 'graph.json'),
    JSON.stringify({ directed: false, nodes: NODES_DUP, links: LINKS_DUP }),
  )
  await putFile(
    join(cacheRoot, 'graphify-out', 'graph.json'),
    JSON.stringify({
      nodes: [
        { id: 'c0', label: 'C0', norm_label: 'c0', source_file: 'src/c/c0.ts' },
        { id: 'c1', label: 'C1', norm_label: 'c1', source_file: 'src/c/c1.ts' },
      ],
      links: [{ source: 'c0', target: 'c1', relation: 'calls', source_file: 'src/c/c0.ts', source_location: 'L3' }],
    }),
  )
  await putFile(
    join(home, 'graph', 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: {
        chain: { root: chainRoot, built_at: null, registered_at: '2026-09-23T00:00:00.000Z' },
        dup: { root: dupRoot, built_at: null, registered_at: '2026-09-23T00:00:00.000Z' },
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

async function getPath(query: string): Promise<{ status: number; json: PathEnvelope }> {
  const res = await fetch(`${base}/api/graph/path${query}`)
  return { status: res.status, json: (await res.json()) as PathEnvelope }
}

function valueOf(json: PathEnvelope): PathValue {
  if (json.value === undefined) {
    throw new Error(`期望 ok:true，实际 error: ${JSON.stringify(json.error)}`)
  }
  return json.value
}

describe('C8.1 path：6 跳 → chain 7 节点 + 每跳 file:line 具体值', () => {
  it('chain 逐跳给出 id/label/file/line；链尾 file/line 为空；旁支不进链', async () => {
    const value = valueOf((await getPath('?project=chain&from=h0&to=h6')).json)

    expect(value.project).toBe('chain')
    expect(value.found).toBe(true)
    expect(value.hops).toBe(6)
    expect(value.chain.map((hop) => hop.id)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    expect(value.chain.map((hop) => hop.label)).toEqual([
      'Hop0', 'Hop1', 'Hop2', 'Hop3', 'Hop4', 'Hop5', 'Hop6',
    ])
    // file/line = 该节点**发出**的那条边的调用点（链尾无下一跳 → 空串）
    expect(value.chain.map((hop) => `${hop.file}:${hop.line}`)).toEqual([
      'src/h/h0.ts:10',
      'src/h/h1.ts:20',
      'src/h/h2.ts:30',
      'src/h/h3.ts:40',
      'src/h/h4.ts:50',
      'src/h/h5.ts:60',
      ':', // 链尾没有下一跳 → file/line 双空
    ])
    // 全部单义 → 一个 ambiguous 都不该有（`ambiguous:true` 只在多义端点出现）
    expect(value.chain.filter((hop) => hop.ambiguous === true)).toEqual([])
    expect(value.raw.trim().startsWith('Shortest path (6 hops):')).toBe(true)
  })

  it('响应键集 = { project, raw, hops, chain, found }（既有字段保留，增 chain）', async () => {
    const value = valueOf((await getPath('?project=chain&from=h0&to=h6')).json)
    expect(Object.keys(value).sort()).toEqual(['chain', 'found', 'hops', 'project', 'raw'])
  })

  it('无解 / 端点不存在 → found:false + hops:null + chain:[]（是「没路径」不是服务端故障）', async () => {
    const res = await getPath('?project=chain&from=h0&to=island')
    expect(res.status).toBe(200)
    const noPath = valueOf(res.json)
    expect(noPath.found).toBe(false)
    expect(noPath.hops).toBeNull()
    expect(noPath.chain).toEqual([])

    const missing = valueOf((await getPath('?project=chain&from=h0&to=ghost')).json)
    expect(missing.found).toBe(false)
    expect(missing.raw).toContain("No node matching 'ghost' found.")
  })

  it('起终点落到同一节点（0 跳）→ found:false（宁缺毋滥，不造 0 跳链）', async () => {
    const value = valueOf((await getPath('?project=chain&from=h0&to=h0')).json)
    expect(value.found).toBe(false)
    expect(value.chain).toEqual([])
  })

  it('缺 from/to → 400；未注册项目 → 404', async () => {
    expect((await getPath('?project=chain&from=h0')).status).toBe(400)
    expect((await getPath('?project=nope&from=h0&to=h6')).status).toBe(404)
  }, 60_000)
})

describe('C8.1 path：多义端点 → ambiguous 标记 + 首个可落地解', () => {
  it('label 多义且两候选都能到 → 落**图内序在前**的那个，并标 ambiguous + file/line 空', async () => {
    // 3 跳链（dup_a → x → m1）；dup_b 到不了 m1 ⇒ 唯一解是 dup_a
    const value = valueOf((await getPath('?project=dup&from=Dup&to=m1')).json)
    expect(value.found).toBe(true)
    expect(value.chain.map((hop) => hop.id)).toEqual(['dup_a', 'x_node', 'm1'])
    expect(value.chain[0]).toEqual({
      id: 'dup_a',
      label: 'Dup',
      file: '',
      line: '',
      ambiguous: true,
    })
    // **中间跳不是多义来源**（它来自 BFS 的节点 id），file:line 照给
    expect(value.chain[1]).toEqual({ id: 'x_node', label: 'Xstep', file: 'src/x/x.ts', line: '22' })
    expect(value.chain[2]!.file).toBe('')
  })

  it('首个候选更远时取**首个可落地解**（dup_b 1 跳 vs dup_a 3 跳）', async () => {
    const value = valueOf((await getPath('?project=dup&from=Dup&to=m2')).json)
    expect(value.hops).toBe(1)
    expect(value.chain.map((hop) => hop.id)).toEqual(['dup_b', 'm2'])
    expect(value.chain[0]!.ambiguous).toBe(true)
    expect(value.chain[0]!.file).toBe('')
  })

  it('精确 id 命中优先 → 不标 ambiguous，file/line 照给', async () => {
    const value = valueOf((await getPath('?project=dup&from=dup_a&to=m1')).json)
    expect(value.chain[0]).toEqual({
      id: 'dup_a',
      label: 'Dup',
      file: 'src/dup/a.ts',
      line: '21',
    })
    expect(value.chain[0]!.ambiguous).toBeUndefined()
  })

  it('终点 label 多义 → 末位跳 ambiguous + file/line 空', async () => {
    // m1 → m2 的终点用 label `M2`（唯一），改用 `Dup` 当终点：dup_a/dup_b 都是候选
    const value = valueOf((await getPath('?project=dup&from=x_node&to=Dup')).json)
    expect(value.found).toBe(true)
    const last = value.chain[value.chain.length - 1]!
    expect(last.ambiguous).toBe(true)
    expect(last.file).toBe('')
    expect(last.line).toBe('')
  })
})

// ===== v17 白盒补测（tester-whitebox）=====
// 队长关注点「BFS 确定性 / calls 边 file:line 0 缺失」的可 CI 锁定部分：
// - 真图「1964 calls 边 0 缺失」是**数据性质**（依赖仓库产物，无法进 CI）——这里钉的是
//   它的**实现侧不变量**：等长双最短路的决胜规则 + 重复查询逐字节一致 + 边数据缺
//   source_file/source_location 时优雅降级（空串，不炸、不编造）。

describe('C8.1 白盒补测：BFS 确定性 + 边 location 缺失降级', () => {
  async function graphRoot(prefix: string, nodes: unknown[], links: unknown[]): Promise<string> {
    const root = await tempDir(prefix)
    await putFile(join(root, 'graphify-out', 'graph.json'), JSON.stringify({ nodes, links }))
    return root
  }

  it('等长双最短路 → 邻居 id 序决胜（b1 先于 b2），且重复查询 chain 逐字节一致', async () => {
    const root = await graphRoot(
      'prism-path-tie-',
      [
        { id: 'a', label: 'A', norm_label: 'a' },
        { id: 'b2', label: 'B2', norm_label: 'b2' },
        { id: 'b1', label: 'B1', norm_label: 'b1' }, // 故意乱序放：确定性不依赖节点数组序
        { id: 'c', label: 'C', norm_label: 'c' },
      ],
      [
        { source: 'a', target: 'b2', relation: 'calls', source_file: 'a.ts', source_location: 'L1' },
        { source: 'b2', target: 'c', relation: 'calls', source_file: 'b2.ts', source_location: 'L2' },
        { source: 'a', target: 'b1', relation: 'calls', source_file: 'a.ts', source_location: 'L3' },
        { source: 'b1', target: 'c', relation: 'calls', source_file: 'b1.ts', source_location: 'L4' },
      ],
    )

    const first = await graphPathChain(root, 'a', 'c')
    expect(first.found).toBe(true)
    expect(first.hops).toBe(2)
    // 两条等长路 a→b1→c / a→b2→c：邻居升序排序 ⇒ b1 稳定胜出（不是「谁先出现在文件里」）
    expect(first.chain.map((hop) => hop.id)).toEqual(['a', 'b1', 'c'])

    // 重复查询（含缓存命中路径）：chain 逐字节一致（同图同链，无随机性）
    for (let i = 0; i < 3; i += 1) {
      const again = await graphPathChain(root, 'a', 'c')
      expect(JSON.stringify(again.chain)).toBe(JSON.stringify(first.chain))
    }
  })

  it('边缺 source_file / source_location → 该跳 file/line 优雅降级为空串（不炸、不编造）', async () => {
    const root = await graphRoot(
      'prism-path-noloc-',
      [
        { id: 'n0', label: 'N0', norm_label: 'n0' },
        { id: 'n1', label: 'N1', norm_label: 'n1' },
        { id: 'n2', label: 'N2', norm_label: 'n2' },
      ],
      [
        // 第一跳：file/line 都缺；第二跳：只有 file 没有 location
        { source: 'n0', target: 'n1', relation: 'calls' },
        { source: 'n1', target: 'n2', relation: 'calls', source_file: 'src/n1.ts' },
      ],
    )

    const result = await graphPathChain(root, 'n0', 'n2')
    expect(result.found).toBe(true)
    expect(result.chain.map((hop) => [hop.id, hop.file, hop.line])).toEqual([
      ['n0', '', ''],
      ['n1', 'src/n1.ts', ''],
      ['n2', '', ''],
    ])
    // 缺 location 不算多义：ambiguous 只由端点解析产生
    expect(result.chain.some((hop) => hop.ambiguous === true)).toBe(false)
  })

  it('同一节点对的多条重复边 → 取文件序首条（edgeOf 只记首条，天然确定）', async () => {
    const root = await graphRoot(
      'prism-path-dupedge-',
      [
        { id: 'p', label: 'P', norm_label: 'p' },
        { id: 'q', label: 'Q', norm_label: 'q' },
      ],
      [
        { source: 'p', target: 'q', relation: 'calls', source_file: 'first.ts', source_location: 'L7' },
        { source: 'p', target: 'q', relation: 'calls', source_file: 'second.ts', source_location: 'L9' },
      ],
    )

    const result = await graphPathChain(root, 'p', 'q')
    expect(result.chain.map((hop) => `${hop.id}@${hop.file}:${hop.line}`)).toEqual([
      'p@first.ts:7',
      'q@:',
    ])
  })
})

describe('C8.1 path：读图缓存按 mtime+size 失效（图重建期口径）', () => {
  it('图重建后重读，不吐陈旧链', async () => {
    // 第一次：图里还没有 c2 → 「端点不存在」
    const before = await graphPathChain(cacheRoot, 'c0', 'c2')
    expect(before.found).toBe(false)
    // 缓存命中路径本身也要能用（同一张图重复查）
    const repeat: GraphPathChainResult = await graphPathChain(cacheRoot, 'c0', 'c1')
    expect(repeat.found).toBe(true)
    expect(repeat.hops).toBe(1)

    // 重建图（content 更长 ⇒ size 变 ⇒ 失效键变，即使 mtime 毫秒相同也必须重读）
    await writeFile(
      join(cacheRoot, 'graphify-out', 'graph.json'),
      JSON.stringify({
        nodes: [
          { id: 'c0', label: 'C0', norm_label: 'c0', source_file: 'src/c/c0.ts' },
          { id: 'c1', label: 'C1', norm_label: 'c1', source_file: 'src/c/c1.ts' },
          { id: 'c2', label: 'C2', norm_label: 'c2', source_file: 'src/c/c2.ts' },
        ],
        links: [
          { source: 'c0', target: 'c1', relation: 'calls', source_file: 'src/c/c0.ts', source_location: 'L3' },
          { source: 'c1', target: 'c2', relation: 'calls', source_file: 'src/c/c1.ts', source_location: 'L8' },
        ],
      }),
      'utf-8',
    )

    const after = await graphPathChain(cacheRoot, 'c0', 'c2')
    expect(after.found).toBe(true)
    expect(after.hops).toBe(2)
    expect(after.chain.map((hop) => `${hop.id}:${hop.file}:${hop.line}`)).toEqual([
      'c0:src/c/c0.ts:3',
      'c1:src/c/c1.ts:8',
      'c2::',
    ])
  })
})
