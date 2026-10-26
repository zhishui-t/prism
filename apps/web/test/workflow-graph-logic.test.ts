/**
 * 工作流图纯逻辑测试（wf* 函数：泳道/蛇形布局/回流解析/重编号/落点/聚焦）。
 * 布局与边一律以数组下标为身份（order 只用于展示与「回 N」解析）。
 */
import { describe, expect, it } from 'vitest'

import {
  WF_LANE_LABEL_W,
  WF_PAD,
  WF_ROW_LEN,
  WF_STEP_GAP,
  WF_NODE_W,
  parseReflowTarget,
  wfDropTarget,
  wfEdgePath,
  wfEdges,
  wfLanes,
  wfLayout,
  wfRelated,
  wfRenumberReflow,
  wfReflowPath,
  wfRowCol,
  type WfGraphNode,
} from '../src/pages/graph-logic.ts'

const nodes: WfGraphNode[] = [
  { order: 1, label: '受理', owner: ['reviewer'], reflow: '—' },
  { order: 2, label: '修复', owner: ['dev'], reflow: '回 1' },
  { order: 3, label: '复验', owner: ['tester'], reflow: '重走卡点①' },
]

describe('wfLanes', () => {
  it('泳道 = 承接主语首现序', () => {
    expect(wfLanes(nodes)).toEqual(['reviewer', 'dev', 'tester'])
  })
  it('空 owner 归「—」泳道', () => {
    expect(wfLanes([{ order: 1, label: 'x', owner: [], reflow: '' }])).toEqual(['—'])
  })
})

describe('wfLayout（蛇形折行）', () => {
  it('positions 以数组下标为键；单泳道 ≤ROW_LEN 步共一行、x 递增', () => {
    const same: WfGraphNode[] = [
      { order: 1, label: 'a', owner: ['dev'], reflow: '' },
      { order: 2, label: 'b', owner: ['dev'], reflow: '' },
    ]
    const l = wfLayout(same)
    expect(l.lanes).toEqual(['dev'])
    expect(l.positions.get(0)).toEqual({ x: WF_LANE_LABEL_W, y: WF_PAD })
    expect(l.positions.get(1)!.x).toBe(WF_LANE_LABEL_W + WF_NODE_W + WF_STEP_GAP)
    expect(l.positions.get(1)!.y).toBe(WF_PAD)
  })
  it('第 ROW_LEN+1 个折到第二行右端——与行尾垂直相邻（前向边为短直线）', () => {
    const chain: WfGraphNode[] = Array.from({ length: WF_ROW_LEN + 1 }, (_, i) => ({
      order: i + 1,
      label: `s${i + 1}`,
      owner: ['dev'],
      reflow: '',
    }))
    const l = wfLayout(chain)
    const last = l.positions.get(WF_ROW_LEN)!
    const tail = l.positions.get(WF_ROW_LEN - 1)!
    expect(last.x).toBe(tail.x) // 同列（奇行右对齐贴上行尾）
    expect(last.y).toBeGreaterThan(tail.y) // 下一行
    expect(l.laneRows).toEqual([2])
  })
  it('order 重复的历史数据不重叠（index 基防御）', () => {
    const dup: WfGraphNode[] = [
      { order: 1, label: 'a', owner: ['dev'], reflow: '' },
      { order: 1, label: 'b', owner: ['dev'], reflow: '' },
      { order: 2, label: 'c', owner: ['dev'], reflow: '' },
    ]
    const l = wfLayout(dup)
    const pts = [...l.positions.values()]
    expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(3)
  })
  it('多泳道：带纵区不交叠，laneTops 逐带递增', () => {
    const l = wfLayout(nodes)
    expect(l.lanes).toEqual(['reviewer', 'dev', 'tester'])
    expect(l.laneTops[1]!).toBeGreaterThan(l.laneTops[0]!)
    expect(l.laneTops[2]!).toBeGreaterThan(l.laneTops[1]!)
  })
  it('窄带（单节点泳道）在画布内水平居中，画布宽按容量收缩', () => {
    const l = wfLayout(nodes) // 三泳道各 1 节点 → 容量 2，start = 0.5（半列居中）
    const capacity = 2
    expect(l.width).toBe(WF_LANE_LABEL_W + capacity * WF_NODE_W + (capacity - 1) * WF_STEP_GAP + WF_PAD)
    expect(l.positions.get(0)!.x).toBe(WF_LANE_LABEL_W + 0.5 * (WF_NODE_W + WF_STEP_GAP))
  })
})

describe('wfRowCol（蛇形行列）', () => {
  const count = WF_ROW_LEN + 2
  it('偶数行左→右、奇数行右→左（贴满行宽，折行处垂直相邻）', () => {
    expect(wfRowCol(0, count, WF_ROW_LEN)).toEqual({ row: 0, col: 0 })
    expect(wfRowCol(WF_ROW_LEN - 1, count, WF_ROW_LEN)).toEqual({ row: 0, col: WF_ROW_LEN - 1 })
    expect(wfRowCol(WF_ROW_LEN, count, WF_ROW_LEN)).toEqual({ row: 1, col: WF_ROW_LEN - 1 })
    expect(wfRowCol(WF_ROW_LEN + 1, count, WF_ROW_LEN)).toEqual({ row: 1, col: WF_ROW_LEN - 2 })
  })
})

describe('回流解析与边', () => {
  it('parseReflowTarget：规范形/全角空格/无空格；非规范 → null', () => {
    expect(parseReflowTarget('回 1')).toBe(1)
    expect(parseReflowTarget('回2')).toBe(2)
    expect(parseReflowTarget('回　3')).toBe(3)
    expect(parseReflowTarget('重走卡点①')).toBeNull()
    expect(parseReflowTarget('—')).toBeNull()
  })
  it('wfEdges：前向 n-1 条（index 相邻）+ 可解析回流 1 条；非规范文本不画边', () => {
    const edges = wfEdges(nodes)
    expect(edges.filter((e) => e.kind === 'forward')).toEqual([
      { kind: 'forward', from: 0, to: 1, raw: '' },
      { kind: 'forward', from: 1, to: 2, raw: '' },
    ])
    expect(edges.filter((e) => e.kind === 'reflow')).toEqual([{ kind: 'reflow', from: 1, to: 0, raw: '回 1' }])
  })
  it('自指回流忽略', () => {
    const edges = wfEdges([{ order: 1, label: 'x', owner: [], reflow: '回 1' }])
    expect(edges.filter((e) => e.kind === 'reflow')).toHaveLength(0)
  })
})

describe('wfRenumberReflow', () => {
  it('改序后回流号按映射重写；非规范原样保留', () => {
    // 节点2 的回流「回 1」：旧序 1 映射到新序 3 → 重写为「回 3」
    const out = wfRenumberReflow(nodes, new Map([[1, 3], [2, 2], [3, 1]]))
    expect(out).toEqual(['—', '回 3', '重走卡点①'])
  })
})

describe('wfDropTarget（拖动落点）', () => {
  it('落到某泳道带的节点位置 → 该带该序（insertAt 指向带内成员下标）', () => {
    const l = wfLayout(nodes)
    // 落在 dev 带（第 2 带）节点位置 → 插到 dev 的第 0 个成员（全局下标 1）之前
    const p = l.positions.get(1)!
    expect(wfDropTarget(nodes, l, p.x, p.y)).toEqual({ lane: 'dev', insertAt: 1 })
  })
  it('落到带下方空白 → 夹到最近带；带内越位 → 夹到带尾', () => {
    const l = wfLayout(nodes)
    const bottom = { x: WF_LANE_LABEL_W, y: l.height + 200 }
    expect(wfDropTarget(nodes, l, bottom.x, bottom.y).lane).toBe('tester')
    const far = wfDropTarget(nodes, l, WF_LANE_LABEL_W + 5000, WF_PAD)
    expect(far).toEqual({ lane: 'reviewer', insertAt: 1 })
  })
})

describe('边路径', () => {
  it('wfEdgePath：垂直同列 → 直线；跨行 → 贝塞尔', () => {
    expect(wfEdgePath({ x: 10, y: 0 }, { x: 10, y: 50 })).toBe('M10 0L10 50')
    expect(wfEdgePath({ x: 0, y: 0 }, { x: 100, y: 40 }, 20)).toBe('M0 0C0 20,100 20,100 40')
  })
  it('wfReflowPath：右弧（控制柄在两锚点右侧）', () => {
    expect(wfReflowPath({ x: 100, y: 0 }, { x: 100, y: 80 }, 40)).toBe('M100 0C140 0,140 80,100 80')
  })
})

describe('wfRelated 聚焦', () => {
  it('前向+回流构成环时上下游都能走到（独立 seen）', () => {
    const related = wfRelated(wfEdges(nodes), 1)
    expect(related.has(0)).toBe(true) // 回流上游
    expect(related.has(2)).toBe(true) // 前向下游
  })
})
