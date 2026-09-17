/**
 * v10 F5 调用链图：**纯函数层**测试（node 环境，不渲染）。
 *
 * 覆盖 `pages/graph-logic.ts` 的全部导出：
 *  1. 形状判据（三档映射，`data-shape` 的唯一来源）；
 *  2. 辐射布局（起点在正上方、顺时针均分、入图节点两两不重叠、全在画布内）；
 *  3. 纵向链布局（等距、行距 > 节点高、画布高度含落白）；
 *  4. 标签截断（按**码点**切，代理对不成半个字符；不足长原样返回）；
 *  5. `affected` 分组（保序、同键相邻、空关系归一组）；
 *  6. 导出寻址（**只有** relations 的命中节点可寻址；多义 / path / affected 拿不到 id）；
 *  7. 导出错误 → 文案键（两类 bad_request 各自命中，其余返回 null 走原文透出）；
 *  8. `formatLocation`（自 `GraphQuery.tsx` 迁入的既有纯函数）。
 *
 * 环境：默认 node（不写环境 pragma，同 `graph-query-styles.test.ts` 的既有做法）——
 * `graph-logic.ts` 只 `import type` 别处的东西，运行时零依赖。
 */

import { describe, expect, it } from 'vitest'

import type { GraphAffected, GraphPath, GraphRelations } from '../src/api.ts'
import {
  CHAIN_MAX,
  CHAIN_NODE,
  CHAIN_VIEW_W,
  EDGE_GAP,
  RADIAL_CENTER,
  RADIAL_MAX,
  RADIAL_PEER,
  RADIAL_VIEW,
  chainShape,
  chainViewH,
  chainY,
  clipLabel,
  formatLocation,
  groupAffected,
  radialPoint,
  segmentBetweenBoxes,
  sequenceAddress,
  sequenceExportErrorKey,
} from '../src/pages/graph-logic.ts'

/** relations 结果（只铺被测函数读到的那几个字段）。 */
function rel(node: string, extra: Partial<GraphRelations> = {}): GraphRelations {
  return { project: 'demo', node, dir: 'in', total: 0, limit: 200, items: [], ...extra }
}

const PATH: GraphPath = { project: 'demo', raw: '', hops: 1, chain: ['a', 'b'], found: true }
const AFFECTED: GraphAffected = {
  project: 'demo',
  raw: '',
  depth: 1,
  nodes: [{ label: 'x', relation: 'calls', location: null }],
}

describe('F5 形状判据：三档映射', () => {
  it('relations → 中心-辐射；path → 纵向链；affected → 分组列表', () => {
    expect(chainShape('relations')).toBe('radial')
    expect(chainShape('path')).toBe('chain')
    expect(chainShape('affected')).toBe('groups')
  })

  it('两个上限常量都是正数（守卫常量本身：0 或负数会让「画几个 / 画不画」失义）', () => {
    expect(CHAIN_MAX).toBeGreaterThan(0)
    expect(RADIAL_MAX).toBeGreaterThan(0)
  })
})

describe('F5 辐射布局', () => {
  it('第一个关系节点在**正上方**，其余顺时针均分（4 个 → 上/右/下/左）', () => {
    expect(radialPoint(0, 4)).toEqual({ x: RADIAL_CENTER.x, y: RADIAL_CENTER.y - 108 })
    const right = radialPoint(1, 4)
    expect(Math.round(right.x)).toBe(RADIAL_CENTER.x + 200)
    expect(Math.round(right.y)).toBe(RADIAL_CENTER.y)
    const bottom = radialPoint(2, 4)
    expect(Math.round(bottom.x)).toBe(RADIAL_CENTER.x)
    expect(Math.round(bottom.y)).toBe(RADIAL_CENTER.y + 108)
  })

  it('单个关系节点也落在正上方（不除以 0）', () => {
    expect(radialPoint(0, 1).x).toBe(RADIAL_CENTER.x)
    expect(radialPoint(0, 0).x).toBe(RADIAL_CENTER.x)
  })

  it(`满员 ${RADIAL_MAX} 个时：两两不重叠、且全在画布内`, () => {
    const points = Array.from({ length: RADIAL_MAX }, (_, i) => radialPoint(i, RADIAL_MAX))
    for (const p of points) {
      // 节点框（含中心框）完整落在 viewBox 内——否则贴边节点会被裁掉一半
      expect(p.x - RADIAL_PEER.w / 2).toBeGreaterThanOrEqual(0)
      expect(p.x + RADIAL_PEER.w / 2).toBeLessThanOrEqual(RADIAL_VIEW.w)
      expect(p.y - RADIAL_PEER.h / 2).toBeGreaterThanOrEqual(0)
      expect(p.y + RADIAL_PEER.h / 2).toBeLessThanOrEqual(RADIAL_VIEW.h)
    }
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!
        const b = points[j]!
        // 矩形不重叠判据：任一分轴拉开即可（同一椭圆上相邻两点靠**横轴**拉开）
        const apart = Math.abs(a.x - b.x) >= RADIAL_PEER.w || Math.abs(a.y - b.y) >= RADIAL_PEER.h
        expect(apart, `第 ${i} 与第 ${j} 个关系节点重叠`).toBe(true)
      }
    }
  })
})

describe('F5 纵向链布局', () => {
  it('首行紧贴现距、行距恒定且大于节点高（不叠行）', () => {
    expect(chainY(0)).toBe(38)
    expect(chainY(1) - chainY(0)).toBe(46)
    expect(chainY(2) - chainY(1)).toBe(46)
    expect(chainY(1) - chainY(0)).toBeGreaterThan(CHAIN_NODE.h)
  })

  it('画布高度 = 末行中心 + 半节点 + 落白；节点横向居中于画布', () => {
    expect(chainViewH(3)).toBe(chainY(2) + CHAIN_NODE.h / 2 + 24)
    expect(CHAIN_NODE.w).toBeLessThan(CHAIN_VIEW_W)
    // count 0/负数也落在合法区域（不返回 NaN，也说明调用方不必先分支）
    expect(chainViewH(0)).toBeGreaterThan(0)
  })
})

describe('F5 连线端点：退到节点框外（否则箭头被框盖住）', () => {
  const CENTER = RADIAL_CENTER
  const PEER = RADIAL_PEER

  it('水平方向：两端各退半框宽 + 缝，端点落在框外', () => {
    const to = { x: CENTER.x + 200, y: CENTER.y }
    const s = segmentBetweenBoxes(CENTER, CENTER, to, PEER)
    expect(s.y1).toBe(CENTER.y)
    expect(s.y2).toBe(CENTER.y)
    expect(s.x1).toBe(CENTER.x + CENTER.w / 2 + EDGE_GAP)
    expect(s.x2).toBe(to.x - PEER.w / 2 - EDGE_GAP)
    // 端点确实在框外（否则 marker 的箭头会被后画的节点框埋掉）
    expect(s.x1 - CENTER.x).toBeGreaterThan(CENTER.w / 2)
    expect(to.x - s.x2).toBeGreaterThan(PEER.w / 2)
  })

  it('垂直方向（纵向链）：退半框高 + 缝，且自上而下', () => {
    const cx = 280
    const s = segmentBetweenBoxes({ x: cx, y: chainY(0) }, CHAIN_NODE, { x: cx, y: chainY(1) }, CHAIN_NODE)
    expect(s.x1).toBe(cx)
    expect(s.x2).toBe(cx)
    expect(s.y1).toBe(chainY(0) + CHAIN_NODE.h / 2 + EDGE_GAP)
    expect(s.y2).toBe(chainY(1) - CHAIN_NODE.h / 2 - EDGE_GAP)
    expect(s.y1).toBeLessThan(s.y2)
  })

  it('斜向：退的距离取「射线先碰到的那条边」（不越界、也不反向）', () => {
    const to = radialPoint(1, RADIAL_MAX)
    const s = segmentBetweenBoxes(CENTER, CENTER, to, PEER)
    // 起点仍在中心框外、终点仍在对端框外：到中心的距离都大于半框在**该方向**上的投影
    expect(Math.hypot(s.x1 - CENTER.x, s.y1 - CENTER.y)).toBeGreaterThan(CENTER.h / 2)
    expect(Math.hypot(s.x2 - to.x, s.y2 - to.y)).toBeGreaterThan(PEER.h / 2)
  })

  it('两端重合 → 原样返回（零长线，不产生 NaN）', () => {
    const at = { x: 10, y: 20 }
    expect(segmentBetweenBoxes(at, PEER, at, PEER)).toEqual({ x1: 10, y1: 20, x2: 10, y2: 20 })
  })

  it('两框靠得太近（退完会反向）→ 退化为零长线，**不画一根箭头朝反的线**', () => {
    const near = { x: CENTER.x + 10, y: CENTER.y }
    const s = segmentBetweenBoxes(CENTER, CENTER, near, PEER)
    expect(s.x1).toBe(s.x2)
    expect(s.y1).toBe(s.y2)
  })
})

describe('F5 标签截断：按码点切，不切碎代理对', () => {
  it('不足长原样返回（含边界：正好等于上限）', () => {
    expect(clipLabel('DoctorCheck', 22)).toBe('DoctorCheck')
    expect(clipLabel('a'.repeat(22), 22)).toBe('a'.repeat(22))
  })

  it('超长截断并补省略号，长度等于上限', () => {
    const out = clipLabel('a'.repeat(30), 10)
    expect(out).toBe(`${'a'.repeat(9)}…`)
    expect([...out].length).toBe(10)
  })

  it('CJK 与 emoji 都按**码点**算（emoji 是代理对，按码元切会出半个字符）', () => {
    const cjk = clipLabel('符号名字很长的调用链节点', 5)
    expect([...cjk].length).toBe(5)
    expect(cjk.endsWith('…')).toBe(true)
    const emoji = clipLabel('🙂🙂🙂🙂🙂', 3)
    expect([...emoji]).toEqual(['🙂', '🙂', '…'])
    // 无孤立代理项（半个字符）：每个码元的长度都不该是「落单的高/低代理」
    expect([...emoji].every((c) => c.length <= 2)).toBe(true)
  })
})

describe('F5 affected 分组', () => {
  const node = (label: string, relation: string) => ({ label, relation, location: null })

  it('按 `relation` **保序**分组（组序 = 首次出现顺序，不排序）', () => {
    const groups = groupAffected([
      node('v1', 'calls'),
      node('v2', 'imports'),
      node('v3', 'calls'),
      node('v4', 'imports'),
    ])
    expect(groups.map((g) => g.relation)).toEqual(['calls', 'imports'])
    expect(groups[0]!.items.map((n) => n.label)).toEqual(['v1', 'v3'])
    expect(groups[1]!.items.map((n) => n.label)).toEqual(['v2', 'v4'])
  })

  it('同键必然相邻（不产生重复组）', () => {
    const groups = groupAffected([node('a', 'calls'), node('b', 'imports'), node('c', 'calls')])
    expect(groups.map((g) => g.items.length)).toEqual([2, 1])
    expect(new Set(groups.map((g) => g.relation)).size).toBe(groups.length)
  })

  it('关系为空串也自成一组（渲染层给「其他关系」文案，不静默丢行）', () => {
    const groups = groupAffected([node('n1', ''), node('n2', 'calls')])
    expect(groups[0]!.relation).toBe('')
    expect(groups[0]!.items).toHaveLength(1)
  })

  it('空输入 → 空分组（调用方据此走空态）', () => {
    expect(groupAffected([])).toEqual([])
  })
})

describe('F5 导出寻址：只有 relations 的**命中节点**给出 id', () => {
  it('relations 命中 → 用 `node`（服务端 `node: target.id`）', () => {
    expect(sequenceAddress({ kind: 'relations', dir: 'in', value: rel('pkg/a.ts#alpha') })).toBe('pkg/a.ts#alpha')
  })

  it('relations 多义 → undefined（`node` 那时是查询原串，没有命中节点）', () => {
    const value = rel('dup', { candidates: [{ id: 'a#dup', label: 'dup' }] })
    expect(sequenceAddress({ kind: 'relations', dir: 'in', value })).toBeUndefined()
  })

  it('relations 的 node 为空串 → undefined（不拿空串去打端点）', () => {
    expect(sequenceAddress({ kind: 'relations', dir: 'out', value: rel('') })).toBeUndefined()
  })

  it('path / affected → undefined（两种响应里全是 label，没有可寻址的 id）', () => {
    expect(sequenceAddress({ kind: 'path', value: PATH })).toBeUndefined()
    expect(sequenceAddress({ kind: 'affected', value: AFFECTED })).toBeUndefined()
  })
})

describe('F5 导出错误 → 文案键（按消息关键字分派）', () => {
  it('「指定的根文件没有跨文件调用边」（P2-2 改写后的真实双判别词全文）→ 专用文案（F5-1 说的高频路径）', () => {
    // 后端实况（arch.ts from-graph catch）：root-file 抛错 = graph-ir 原文 + 追加式提示，
    // 提示里含第二个判别词「calls 边」——分派必须仍落「根文件」这条（顺序约束的实况形态）。
    expect(
      sequenceExportErrorKey(
        'bad_request: 指定的根文件没有跨文件调用边: packages/x/src/a.ts；该文件在调用图里没有跨文件 calls 边，请换一个起点符号',
      ),
    ).toBe('graph.seq.noRootEdge')
  })

  it('「图谱没有跨文件 calls 边」→ 另一条专用文案', () => {
    expect(
      sequenceExportErrorKey(
        'bad_request: 图谱没有跨文件 calls 边，无法派生时序图：本入口只从图谱的跨文件 calls 边派生调用链，请先 prism graph build 重建图，或换一个在调用图里有跨文件 calls 边的起点符号',
      ),
    ).toBe('graph.seq.noCalls')
  })

  it('两条映射互不串靠**分派顺序**锁定（真实 root-file 消息同时含两个判别词，「根文件」先判必须赢）', () => {
    // MINOR-1 订正：P2-2 之后真实 root-file 消息 = 原文 + 「…没有跨文件 calls 边…」提示，
    // **两个判别词都在**——旧断言「不含 calls 边」与实况相反，已废弃。
    const rootEdge =
      'bad_request: 指定的根文件没有跨文件调用边: a.ts；该文件在调用图里没有跨文件 calls 边，请换一个起点符号'
    expect(rootEdge.includes('根文件')).toBe(true)
    expect(rootEdge.includes('calls 边')).toBe(true)
    expect(sequenceExportErrorKey(rootEdge)).toBe('graph.seq.noRootEdge')
  })

  it('`project_root_missing` 是**独立码**：按码分派，不靠消息关键字', () => {
    // 后端原文（arch-placement.ts:71）：节点/图内容没问题，是「项目根被删/被移」
    expect(
      sequenceExportErrorKey(
        'project_root_missing: 项目根不存在: D:\\gone\\demo（项目 demo 已注册但目录已被删除或移动；Prism 不重建该目录）',
      ),
    ).toBe('graph.seq.noProjectRoot')
    expect(sequenceExportErrorKey('project_root_missing: 项目根不是目录: D:\\gone\\demo（项目 demo）')).toBe(
      'graph.seq.noProjectRoot',
    )
    // 互不串：含「根文件」的那条是 bad_request，走的是消息分派那一层
    expect(sequenceExportErrorKey('bad_request: 指定的根文件没有跨文件调用边: a.ts')).toBe('graph.seq.noRootEdge')
  })

  it('码不是 bad_request → null（走原文透出，不硬套文案）', () => {
    expect(sequenceExportErrorKey('not_found: 图谱中没有节点: x')).toBeNull()
    expect(sequenceExportErrorKey('graph_not_found: 图谱不存在')).toBeNull()
  })

  it('bad_request 但没有这两条特征词 → null（陌生错误不猜）', () => {
    expect(sequenceExportErrorKey('bad_request: 缺少 node 参数')).toBeNull()
    expect(sequenceExportErrorKey('网络不可达')).toBeNull()
  })
})

describe('F5 `formatLocation`（自 `GraphQuery.tsx` 迁入，口径不变）', () => {
  it('两段齐 → `file:line`；缺一段只显示那一段；都缺 → 空串', () => {
    expect(formatLocation('src/a.ts', '52')).toBe('src/a.ts:52')
    expect(formatLocation('src/a.ts', '')).toBe('src/a.ts')
    expect(formatLocation('', '52')).toBe('52')
    expect(formatLocation('', '')).toBe('')
  })
})
