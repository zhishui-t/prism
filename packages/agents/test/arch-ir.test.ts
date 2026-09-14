/**
 * archify IR 生成器（architecture / sequence / dataflow / lifecycle）+ 正交布线器，纯函数判据。
 *
 * 判据分层：
 * 1. **纯函数**：同输入同字节（红线 R7——sidecar 的 `ir_hash` 才有意义）；
 * 2. **渲染器口径不变量**：文本单位上限、坐标边界、`yOffset` 页距——这些值都是从
 *    `3rd/archify/archify/renderers/*` 里读出来的硬约束，改上游就得改这里，
 *    所以把它们写成断言（真渲染门禁在 `packages/server/test/arch-from-graph.test.ts`）；
 * 3. **拒画**：数据不足时**必须报错**而不是造一张看着像的图。
 */
import { describe, expect, it } from 'vitest'

import {
  buildArchitectureIr,
  buildDataflowIr,
  buildSequenceIr,
  commonDirPrefix,
  isTestFile,
  makeRegionOf,
  type CodeGraph,
} from '../src/arch/graph-ir.js'
import {
  TASK_LIFECYCLE_CELLS,
  buildTaskLifecycleIr,
  type LifecycleIr,
} from '../src/arch/lifecycle-ir.js'
import { anchorOf, freeTracks, pickLabelAt, planRoute, type RouterBox } from '../src/arch/router.js'
import { fitMiddle, fitUnits, textUnits } from '../src/arch/text.js'

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/**
 * 合成图谱：覆盖
 * - 4 个目录角色（cli / api / domain / store）→ dataflow 多层；
 * - **同一个 `domain` 层里 6 个模块** → 触发 `yOffset` 叠排（rowYs 只有 5 个槽位）；
 * - 跨文件 `calls` 边 → sequence 可派生；
 * - 一个超长文件名 → 触发 `fitMiddle` 中间截断。
 */
function makeGraph(): CodeGraph {
  const nodes: Array<Record<string, unknown>> = [
    { id: 'cli', label: 'entrypoint', source_file: 'proj/src/cli/entrypoint.ts', community: 0 },
    { id: 'api', label: 'routes', source_file: 'proj/src/api/routes.ts', community: 1 },
    { id: 'api2', label: 'handler', source_file: 'proj/src/api/a_very_long_route_descriptor_handler.ts', community: 1 },
    { id: 'store', label: 'db', source_file: 'proj/src/store/database.ts', community: 2 },
  ]
  for (let i = 0; i < 6; i += 1) {
    nodes.push({
      id: `dom${i}`,
      label: `service${i}`,
      source_file: `proj/src/domain/mod${i}/service.ts`,
      community: 10 + i,
    })
  }
  const edges: Array<Record<string, unknown>> = [
    { source: 'cli', target: 'api', relation: 'calls' },
    { source: 'api', target: 'api2', relation: 'calls' },
    { source: 'api2', target: 'dom0', relation: 'calls' },
    { source: 'dom0', target: 'store', relation: 'calls' },
    { source: 'dom1', target: 'store', relation: 'imports' },
    { source: 'dom2', target: 'dom3', relation: 'imports' },
  ]
  return { nodes: nodes as never, links: edges as never }
}

/** 只含 `imports`（无 `calls`）的图谱：sequence 应当拒画。 */
function makeGraphWithoutCalls(): CodeGraph {
  return {
    nodes: [
      { id: 'a', label: 'a', source_file: 'proj/src/api/a.ts', community: 0 },
      { id: 'b', label: 'b', source_file: 'proj/src/domain/b.ts', community: 1 },
    ],
    links: [{ source: 'a', target: 'b', relation: 'imports' }],
  }
}

/** 全部文件同在一个目录（拍平快照）：dataflow 应当拒画。 */
function makeFlatGraph(): CodeGraph {
  return {
    nodes: [
      { id: 'a', label: 'a', source_file: 'snap/raw/a.py', community: 0 },
      { id: 'b', label: 'b', source_file: 'snap/raw/b.py', community: 1 },
    ],
    links: [{ source: 'a', target: 'b', relation: 'imports' }],
  }
}

// ===== 文本度量 =====

describe('arch/text：文本度量与截断', () => {
  it('CJK / 全角按 2 单位计（与 archify textUnits 同口径的保守近似）', () => {
    expect(textUnits('abc')).toBe(3)
    expect(textUnits('等待')).toBe(4)
    expect(textUnits('等待abc')).toBe(7)
    expect(textUnits('')).toBe(0)
  })

  it('fitUnits：超限才截断，且以省略号收尾、不超预算', () => {
    expect(fitUnits('abc', 5)).toBe('abc')
    expect(fitUnits('abcdef', 4)).toBe('abc…')
    expect(textUnits(fitUnits('abcdefghij', 5))).toBeLessThanOrEqual(5)
    // 全角不能算成 1 单位
    expect(textUnits(fitUnits('一二三四五', 5))).toBeLessThanOrEqual(5)
  })

  it('fitMiddle：中间截断保留头尾（文件名的区分度在尾部）', () => {
    expect(fitMiddle('short', 10)).toBe('short')
    const cut = fitMiddle('test_post_suggestion_handler', 13)
    expect(textUnits(cut)).toBeLessThanOrEqual(13)
    expect(cut).toContain('…')
    // 预算 13 → 头 6 / 尾 6
    expect(cut).toBe('test_p…andler')
    // 与头截断的区别：尾部信息不被丢掉
    expect(fitUnits('test_post_suggestion_handler', 13)).toBe('test_post_su…')
  })
})

// ===== 区域名（分层口径的基石）=====

describe('arch/graph-ir：区域名归一化', () => {
  it('公共目录前缀按段对齐（绝对路径的空首段已归一化）', () => {
    expect(commonDirPrefix(['a/b/c/x.ts', 'a/b/d/y.ts'])).toEqual(['a', 'b'])
    expect(commonDirPrefix(['/home/u/proj/x.py', '/home/u/proj/sub/y.py'])).toEqual(['home', 'u', 'proj'])
    expect(commonDirPrefix(['a/x.ts'])).toEqual(['a'])
    expect(commonDirPrefix([])).toEqual([])
  })

  it('src 之后取两段；文件直接躺在 src 下取包名；无 src 取头两段', () => {
    const of = makeRegionOf([
      'packages/core/src/graph/a.ts',
      'packages/core/src/graph/deep/b.ts',
      'packages/core/src/c.ts',
      'backend/app/api/d.py',
      'backend/tests/e.py',
      'snap/raw/f.py',
    ])
    expect(of('packages/core/src/graph/a.ts')).toBe('graph')
    expect(of('packages/core/src/graph/deep/b.ts')).toBe('graph/deep')
    expect(of('packages/core/src/c.ts')).toBe('core')
    expect(of('backend/app/api/d.py')).toBe('backend/app')
    expect(of('backend/tests/e.py')).toBe('backend/tests')
    // 混合语料里公共前缀退化成空 → 拍平快照按头两段算
    expect(of('snap/raw/f.py')).toBe('snap/raw')
  })

  it('全仓库同目录 → 单区域 `(root)`（调用方据此拒画，而不是硬造层次）', () => {
    const of = makeRegionOf(['snap/raw/a.py', 'snap/raw/b.py'])
    expect(of('snap/raw/a.py')).toBe('(root)')
    expect(of('snap/raw/b.py')).toBe('(root)')
  })

  it('绝对路径：公共前缀吃掉机器相关前缀，剩下的目录才是区域', () => {
    const of = makeRegionOf([
      '/home/safi/bench/repos/minGPT/mingpt/x.py',
      '/home/safi/bench/repos/minGPT/mingpt/y.py',
      '/home/safi/bench/repos/nanoGPT/z.py',
    ])
    expect(of('/home/safi/bench/repos/minGPT/mingpt/x.py')).toBe('minGPT/mingpt')
    expect(of('/home/safi/bench/repos/nanoGPT/z.py')).toBe('nanoGPT')
  })

  it('src 直接位于仓库根时区域名是 `src`（旧实现会错返回文件名）', () => {
    const of = makeRegionOf(['src/game.py', 'test/test_game.py'])
    expect(of('src/game.py')).toBe('src')
    expect(of('test/test_game.py')).toBe('test')
  })

  it('测试文件按路径段识别', () => {
    expect(isTestFile('backend/tests/a.py')).toBe(true)
    expect(isTestFile('src/__tests__/a.ts')).toBe(true)
    expect(isTestFile('a/test_b.py')).toBe(false) // 文件名不算，只看目录段
  })
})

// ===== architecture =====

describe('arch/graph-ir：architecture', () => {
  const ir = buildArchitectureIr(makeGraph(), { title: '合成架构' })

  it('组件 / 边界 / 连线结构合法', () => {
    expect(ir.diagram_type).toBe('architecture')
    expect(ir.components.length).toBeGreaterThanOrEqual(4)
    for (const component of ir.components) {
      expect(component.id).toMatch(ID_PATTERN)
      expect(component.pos).toHaveLength(2)
      expect(component.size).toHaveLength(2)
    }
    const ids = new Set(ir.components.map((component) => component.id))
    for (const connection of ir.connections ?? []) {
      expect(ids.has(connection.from)).toBe(true)
      expect(ids.has(connection.to)).toBe(true)
      expect(connection.from).not.toBe(connection.to)
      expect(connection.route).toBe('straight')
      // via 只含**中间**折点（首末锚点由渲染器补）
      expect(Array.isArray(connection.via)).toBe(true)
    }
  })

  it('同输入同字节（纯函数）', () => {
    expect(JSON.stringify(buildArchitectureIr(makeGraph(), { title: '合成架构' }))).toBe(JSON.stringify(ir))
  })

  it('连线不穿组件（自研布线器的核心不变量）', () => {
    const boxes = new Map<string, RouterBox>()
    for (const component of ir.components) {
      const [x, y] = component.pos
      const [w, h] = component.size
      boxes.set(component.id, { x0: x, x1: x + w, y0: y, y1: y + h })
    }
    for (const connection of ir.connections ?? []) {
      const from = boxes.get(connection.from)!
      const to = boxes.get(connection.to)!
      const points: Array<[number, number]> = [
        anchorOf(from, connection.fromSide!),
        ...(connection.via ?? []),
        anchorOf(to, connection.toSide!),
      ]
      for (const [id, box] of boxes) {
        if (id === connection.from || id === connection.to) continue
        for (let i = 0; i + 1 < points.length; i += 1) {
          expect(crossesBox(points[i]!, points[i + 1]!, box, 2)).toBe(false)
        }
      }
    }
  })
})

// ===== sequence =====

describe('arch/graph-ir：sequence', () => {
  const ir = buildSequenceIr(makeGraph(), { title: '合成时序' })

  it('参与者 ≥ 2、消息连到已知参与者、y 递增', () => {
    expect(ir.participants.length).toBeGreaterThanOrEqual(2)
    const ids = new Set(ir.participants.map((participant) => participant.id))
    for (const message of ir.messages) {
      expect(ids.has(message.from)).toBe(true)
      expect(ids.has(message.to)).toBe(true)
      expect(typeof message.y).toBe('number')
    }
    const ys = ir.messages.map((message) => message.y)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  })

  it('文本受渲染器口径约束：label ≤ 13 / sublabel ≤ 21 单位（participantW = 86px）', () => {
    for (const participant of ir.participants) {
      expect(textUnits(participant.label)).toBeLessThanOrEqual(13)
      if (participant.sublabel !== undefined) {
        expect(textUnits(participant.sublabel)).toBeLessThanOrEqual(21)
      }
    }
    // 超长文件名走中间截断
    const long = ir.participants.map((p) => p.label).find((label) => label.includes('…'))
    expect(long).toBeDefined()
  })

  it('viewBox 自算：消息 y 落在渲染器允许的 [160, viewBox[1] - 83] 内', () => {
    const height = ir.meta.viewBox![1]
    for (const message of ir.messages) {
      expect(message.y).toBeGreaterThanOrEqual(160)
      expect(message.y).toBeLessThanOrEqual(height - 83)
    }
    expect(ir.meta.viewBox![0]).toBeGreaterThanOrEqual(920)
  })

  it('同输入同字节；没有跨文件 calls 边 → 明确拒画', () => {
    expect(JSON.stringify(buildSequenceIr(makeGraph(), { title: '合成时序' }))).toBe(JSON.stringify(ir))
    expect(() => buildSequenceIr(makeGraphWithoutCalls(), { title: 'x' })).toThrow(/跨文件 calls 边/)
  })
})

// ===== dataflow =====

describe('arch/graph-ir：dataflow（依赖流向口径）', () => {
  const ir = buildDataflowIr(makeGraph(), { title: '合成流向' })

  it('层次压缩：只留命中层并保持原顺序；节点 stage 落在 stages 范围内', () => {
    expect(ir.stages.map((stage) => stage.label)).toEqual(['入口', '接口', '领域', '存储'])
    for (const node of ir.nodes) {
      expect(node.stage).toBeGreaterThanOrEqual(0)
      expect(node.stage).toBeLessThan(ir.stages.length)
    }
    expect(ir.meta.subtitle).toContain('依赖流向视图')
  })

  it('只画跨层流动', () => {
    const stageOf = new Map(ir.nodes.map((node) => [node.id, node.stage]))
    for (const flow of ir.flows) {
      expect(stageOf.get(flow.from)).not.toBe(stageOf.get(flow.to))
      expect(flow.label.length).toBeGreaterThan(0)
    }
  })

  it('坐标边界与页距不变量（务必与 render-dataflow.mjs 的 layout 同口径）', () => {
    const rowYs = [128, 242, 356, 470, 584]
    const nodeH = 58
    const height = ir.meta.viewBox![1]
    for (const node of ir.nodes) {
      const y = rowYs[node.row]! + (node.yOffset ?? 0)
      // 上边界：node.y >= stageY + stageH + 22
      expect(y).toBeGreaterThanOrEqual(104)
      // 下边界：node.y + height <= viewBox[1] - stageBottomPad
      expect(y + nodeH).toBeLessThanOrEqual(height - 74)
      // 叠排页距必须是整页倍数（≥ 524，否则第二排压在第一排上）
      if (node.yOffset !== undefined) {
        expect(node.yOffset % 560).toBe(0)
        expect(node.yOffset).toBeGreaterThanOrEqual(560)
      }
    }
    // 同一 stage 内两两不重叠（渲染器要求 ≥ 10px 间距）
    for (let i = 0; i < ir.nodes.length; i += 1) {
      for (let j = i + 1; j < ir.nodes.length; j += 1) {
        const a = ir.nodes[i]!
        const b = ir.nodes[j]!
        if (a.stage !== b.stage) continue
        const ay = rowYs[a.row]! + (a.yOffset ?? 0)
        const by = rowYs[b.row]! + (b.yOffset ?? 0)
        const cx = (node: typeof a): number => 100 + node.stage * 215
        const overlapX = Math.abs(cx(a) - cx(b)) < 112 - 10
        const overlapY = ay < by + nodeH + 10 && by < ay + nodeH + 10
        expect(overlapX && overlapY).toBe(false)
      }
    }
  })

  it('节点文本受 nodeW = 112 约束（label ≤ 18 / sublabel ≤ 27 单位）', () => {
    for (const node of ir.nodes) {
      expect(textUnits(node.label)).toBeLessThanOrEqual(18)
      if (node.sublabel !== undefined) expect(textUnits(node.sublabel)).toBeLessThanOrEqual(27)
      if (node.tag !== undefined) expect(textUnits(node.tag)).toBeLessThanOrEqual(27)
    }
  })

  it('同层超 5 个模块 → 用 yOffset 叠第二排', () => {
    const domainStage = ir.stages.findIndex((stage) => stage.label === '领域')
    const rows = ir.nodes.filter((node) => node.stage === domainStage)
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.some((node) => node.yOffset !== undefined)).toBe(true)
  })

  it('同输入同字节；扁平仓库（同目录）→ 明确拒画', () => {
    expect(JSON.stringify(buildDataflowIr(makeGraph(), { title: '合成流向' }))).toBe(JSON.stringify(ir))
    expect(() => buildDataflowIr(makeFlatGraph(), { title: 'x' })).toThrow(/只分出 1 层/)
  })
})

// ===== lifecycle =====

describe('arch/lifecycle-ir：任务状态机', () => {
  const ir: LifecycleIr = buildTaskLifecycleIr()

  it('14 态齐全、36 条转移（32 权威 + 4 派生虚线）', () => {
    expect(ir.states).toHaveLength(14)
    expect(ir.transitions).toHaveLength(36)
    expect(ir.transitions.filter((transition) => transition.variant === 'dashed')).toHaveLength(4)
    expect(Object.keys(TASK_LIFECYCLE_CELLS)).toHaveLength(14)
    for (const state of ir.states) expect(state.id).toMatch(ID_PATTERN)
  })

  it('每条转移都自算走线（fromSide/toSide/route/via 齐备）', () => {
    for (const transition of ir.transitions) {
      expect(transition.route).toBe('straight')
      expect(['top', 'right', 'bottom', 'left']).toContain(transition.fromSide)
      expect(['top', 'right', 'bottom', 'left']).toContain(transition.toSide)
      expect(Array.isArray(transition.via)).toBe(true)
    }
    // 没有任何连线被丢弃——丢边等于谎报状态机
    expect(ir.meta.subtitle).not.toContain('被略去')
  })

  it('坐标边界不变量：终态第二排不得越界；同格叠排的锚点距离 ≥ 32px', () => {
    const height = ir.meta.viewBox![1]
    const bandY = { phase: 126, event: 278, outcome: 450 } as const
    const bandH = { phase: 62, event: 58, outcome: 58 } as const
    const secondRow = ir.states.filter((state) => (state.yOffset ?? 0) > 0)
    expect(secondRow).toHaveLength(3)
    for (const state of secondRow) {
      expect(state.yOffset).toBe(96)
      const y = bandY.outcome + state.yOffset!
      expect(y + bandH.outcome).toBeLessThanOrEqual(height - 122)
    }
    // 同列上下两个终态的最短通路 = 下方顶边 - 上方底边，渲染器要求 ≥ 32px
    const gap = (450 + 96) - (450 + bandH.outcome)
    expect(gap).toBeGreaterThanOrEqual(32)
  })

  it('同输入同字节', () => {
    expect(JSON.stringify(buildTaskLifecycleIr())).toBe(JSON.stringify(ir))
  })
})

// ===== 布线器 =====

/** 与 archify `segmentIntersectsRect` 同口径：gap 外扩后判相交。 */
function crossesBox(a: [number, number], b: [number, number], box: RouterBox, gap: number): boolean {
  const x0 = box.x0 - gap
  const x1 = box.x1 + gap
  const y0 = box.y0 - gap
  const y1 = box.y1 + gap
  if (Math.abs(a[1] - b[1]) < 1e-9) {
    if (!(a[1] > y0 && a[1] < y1)) return false
    return Math.max(a[0], b[0]) > x0 && Math.min(a[0], b[0]) < x1
  }
  if (Math.abs(a[0] - b[0]) < 1e-9) {
    if (!(a[0] > x0 && a[0] < x1)) return false
    return Math.max(a[1], b[1]) > y0 && Math.min(a[1], b[1]) < y1
  }
  return true
}

describe('arch/router：正交布线器', () => {
  const box = (x0: number, y0: number, x1: number, y1: number): RouterBox => ({ x0, y0, x1, y1 })

  it('anchorOf 与 archify anchor() 同公式（各侧中点）', () => {
    const b = box(10, 20, 110, 80)
    expect(anchorOf(b, 'top')).toEqual([60, 20])
    expect(anchorOf(b, 'bottom')).toEqual([60, 80])
    expect(anchorOf(b, 'left')).toEqual([10, 50])
    expect(anchorOf(b, 'right')).toEqual([110, 50])
  })

  it('正对面 → 直线（via 为空，折点 0）', () => {
    const from = box(0, 0, 100, 100)
    const to = box(300, 0, 400, 100)
    const plan = planRoute(from, to, [from, to])
    expect(plan).not.toBeNull()
    expect(plan!.fromSide).toBe('right')
    expect(plan!.toSide).toBe('left')
    expect(plan!.via).toEqual([])
    expect(plan!.route).toBe('straight')
  })

  it('中间有障碍 → 绕开，且不穿任何无关节点', () => {
    const from = box(0, 0, 100, 100)
    const to = box(300, 0, 400, 100)
    const wall = box(150, -200, 250, 300)
    const obstacles = [from, to, wall]
    const plan = planRoute(from, to, obstacles)
    expect(plan).not.toBeNull()
    const points: Array<[number, number]> = [
      anchorOf(from, plan!.fromSide),
      ...plan!.via,
      anchorOf(to, plan!.toSide),
    ]
    for (let i = 0; i + 1 < points.length; i += 1) {
      expect(crossesBox(points[i]!, points[i + 1]!, wall, 2)).toBe(false)
    }
  })

  it('端点被四面围死 → 返回 null（宁缺毋滥，绝不吐非法 IR）', () => {
    const from = box(0, 0, 100, 100)
    const to = box(400, 0, 500, 100)
    // 短桩长 16，把 from 四周 8px 处全包住
    const ring = [box(-40, -8, 140, -7), box(-40, 101, 140, 200), box(-8, -8, -7, 108), box(101, -8, 102, 108)]
    expect(planRoute(from, to, [from, to, ...ring])).toBeNull()
  })

  it('freeTracks：空隙中点 + 首尾边距', () => {
    const tracks = freeTracks([box(0, 0, 10, 10), box(20, 0, 30, 10)], 40)
    expect(tracks.corridors).toEqual([-40, 15, 70])
  })

  it('pickLabelAt：避开节点；放不下时按 allowImperfect 决定给不给', () => {
    const obstacles = [box(0, 0, 100, 100)]
    // 路径横穿节点，但路径右段（x > 100）有空间 → 标签被推到那儿
    const along = pickLabelAt(
      [
        [0, 50],
        [200, 50],
      ],
      obstacles,
      { width: 40, height: 16 },
      [],
      { lift: 10 },
    )
    expect(along).not.toBeNull()
    expect(along!.box.x0).toBeGreaterThanOrEqual(100)

    // 整块画布被节点占满 → 严格模式下返回 null
    const packed = [box(-500, -500, 500, 500)]
    const strict = pickLabelAt(
      [
        [-400, 0],
        [400, 0],
      ],
      packed,
      { width: 40, height: 16 },
      [],
      { lift: 10 },
    )
    expect(strict).toBeNull()
    const imperfect = pickLabelAt(
      [
        [-400, 0],
        [400, 0],
      ],
      packed,
      { width: 40, height: 16 },
      [],
      { lift: 10, allowImperfect: true },
    )
    expect(imperfect).not.toBeNull()
  })

  it('同输入同输出（确定性）', () => {
    const from = box(0, 0, 100, 100)
    const to = box(300, 0, 400, 100)
    const wall = box(150, -200, 250, 300)
    const a = planRoute(from, to, [from, to, wall])
    const b = planRoute(from, to, [from, to, wall])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
