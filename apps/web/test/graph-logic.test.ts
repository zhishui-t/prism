/**
 * v10 F5 调用链图：**纯函数层**测试（node 环境，不渲染）。
 *
 * 覆盖 `pages/graph-logic.ts` 的全部导出：
 *  1. 形状判据（三档映射，`data-shape` 的唯一来源）；
 *  2. 辐射布局（起点在正上方、顺时针均分、入图节点两两不重叠、全在算出的 viewBox 内）；
 *  3. 纵向链布局（等距、行距 > 节点高、横向居中）；
 *  3b. 节点几何包围盒 → viewBox（v12 F1：单/多/负坐标/空输入，星形与纵向链都走它）；
 *  4. 标签截断（按**码点**切，代理对不成半个字符；不足长原样返回）；
 *  5. `affected` 分组（保序、同键相邻、空关系归一组）；
 *  6. 导出寻址（relations 的命中节点 → `{ node }`；path 的 `chain[].id` → `{ symbols }`；
 *     多义 / affected / 空链拿不到 → `undefined`）；
 *  7. 导出错误 → 文案键（两类 bad_request 各自命中，其余返回 null 走原文透出）；
 *  8. `formatLocation`（自 `GraphQuery.tsx` 迁入的既有纯函数）；
 *  9. **v12 F1 缩放平移**：适应窗口（双向比取 min + 居中）、倍率 clamp 与百分比、
 *     指针锚缩放、平移、`<g transform>` 归一化（含「不叠加两次」的复合不变式）、
 *     第二行标注（阈值 / 不猜 / 不截断）；
 * 10. **v15 W-1 容器 resize 重 fit**：防抖时长常量（200）与 pristine 决策（true → 重算、
 *     false → 不动视口）——DOM 侧（ResizeObserver 接线）在 `graph-call-chain-zoom-dom.test.ts`；
 * 11. **v17 W-8 段标注几何**：段中线 `chainEdgeMidY` 与 viewBox 外扩 `chainLabelBoxes`
 *     （空串不占位；宽度按码点估算）。
 *
 * 环境：默认 node（不写环境 pragma，同 `graph-query-styles.test.ts` 的既有做法）——
 * `graph-logic.ts` 只 `import type` 别处的东西，运行时零依赖。
 */

import { describe, expect, it } from 'vitest'

import type { GraphAffected, GraphPath, GraphRelations } from '../src/api.ts'
import {
  ANNOTATION_SCALE,
  CHAIN_EDGE_LABEL_DX,
  CHAIN_MAX,
  CHAIN_NODE,
  CHAIN_VIEW_W,
  EDGE_GAP,
  RADIAL_CENTER,
  RADIAL_MAX,
  RADIAL_PEER,
  REFIT_DEBOUNCE_MS,
  VIEW_PAD,
  ZOOM_STEP,
  annotationLine,
  annotationVisible,
  chainBoxes,
  chainEdgeMidY,
  chainLabelBoxes,
  chainShape,
  chainY,
  clampZoom,
  clipLabel,
  contentViewBox,
  fitTransform,
  formatLocation,
  groupAffected,
  panBy,
  radialBoxes,
  radialPoint,
  segmentBetweenBoxes,
  sequenceAddress,
  sequenceExportErrorKey,
  sequenceSymbols,
  sequenceTarget,
  shouldRefitOnResize,
  transformAttr,
  userTransform,
  viewBoxAttr,
  zoomAt,
  zoomPercent,
  zoomRatio,
} from '../src/pages/graph-logic.ts'
import type { Point } from '../src/pages/graph-logic.ts'

/** relations 结果（只铺被测函数读到的那几个字段）。 */
function rel(node: string, extra: Partial<GraphRelations> = {}): GraphRelations {
  return { project: 'demo', node, dir: 'in', total: 0, limit: 200, items: [], ...extra }
}

/** v17 C-8：`chain` 是带 id / file / line 的结构（此处与真实响应同形；W-8 消费 file/line）。 */
const PATH: GraphPath = {
  project: 'demo',
  raw: '',
  hops: 1,
  chain: [
    { id: 'n0', label: 'a', file: 'src/a.ts', line: '10' },
    { id: 'n1', label: 'b', file: '', line: '' },
  ],
  found: true,
}
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

  it(`满员 ${RADIAL_MAX} 个时：两两不重叠、且全在**算出的** viewBox 内`, () => {
    const points = Array.from({ length: RADIAL_MAX }, (_, i) => radialPoint(i, RADIAL_MAX))
    const boxes = radialBoxes(RADIAL_MAX)
    // v12 F1：viewBox 不再是固定画布，而是节点包围盒——节点框必须完整落在它里面
    const vb = contentViewBox(boxes)
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(vb.x)
      expect(b.x + b.w).toBeLessThanOrEqual(vb.x + vb.w)
      expect(b.y).toBeGreaterThanOrEqual(vb.y)
      expect(b.y + b.h).toBeLessThanOrEqual(vb.y + vb.h)
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

  it('节点横向居中于布局宽度；节点宽落在布局宽度之内', () => {
    expect(CHAIN_NODE.w).toBeLessThan(CHAIN_VIEW_W)
    const cx = CHAIN_VIEW_W / 2
    for (const b of chainBoxes(3)) expect(b.x + b.w / 2).toBe(cx)
    // count 0 / 负数 → 空框集（不返回 NaN，调用方不必先分支）
    expect(chainBoxes(0)).toEqual([])
  })
})

describe('v12 F1 节点几何包围盒 → viewBox（纯函数，不做 DOM 测量）', () => {
  it('单节点：四边各外扩 pad', () => {
    const vb = contentViewBox([{ x: 10, y: 20, w: 30, h: 40 }], 5)
    expect(vb).toEqual({ x: 5, y: 15, w: 40, h: 50 })
  })

  it('多节点：取并集；**负坐标**照样外扩（不夹到 0——夹了会切掉左/上节点）', () => {
    const vb = contentViewBox(
      [
        { x: -30, y: 0, w: 10, h: 10 },
        { x: 0, y: 20, w: 10, h: 10 },
      ],
      4,
    )
    expect(vb).toEqual({ x: -34, y: -4, w: 48, h: 38 })
  })

  it('空输入 → 零矩形（不返回 NaN / ±Infinity）', () => {
    expect(contentViewBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('`viewBoxAttr` 保留两位小数：三角函数浮点噪声不进属性契约', () => {
    // 值取自 `radialPoint` 的实况量级（cos/sin 的 1e-15 级误差）；
    // 字面量取 15 位有效数字——再长就触发 `no-loss-of-precision`（双精度存不下，写多少位都是噪声）
    expect(viewBoxAttr({ x: 16.7949192431123, y: 20, w: 526.4101615137756, h: 235.99999999999997 })).toBe(
      '16.79 20 526.41 236',
    )
  })

  it('纵向链：viewBox 高度随节点数增长（12 节点 > 3 节点），宽度只由节点宽 + 两侧留白定', () => {
    const few = contentViewBox(chainBoxes(3))
    const many = contentViewBox(chainBoxes(12))
    expect(many.h).toBeGreaterThan(few.h)
    expect(many.w).toBe(few.w)
    expect(few.w).toBe(CHAIN_NODE.w + VIEW_PAD * 2)
    // 首行距顶恰等于留白 ⇒ 链图 viewBox 的 y 为 0（与旧画布口径的连续性）
    expect(few.y).toBe(0)
  })

  it('星形与纵向链都走同一函数：节点框全落在算出 viewBox 内（两种形态无一固定画布）', () => {
    for (const boxes of [radialBoxes(3), radialBoxes(RADIAL_MAX), chainBoxes(1), chainBoxes(RADIAL_MAX)]) {
      const vb = contentViewBox(boxes)
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(vb.x)
        expect(b.y).toBeGreaterThanOrEqual(vb.y)
        expect(b.x + b.w).toBeLessThanOrEqual(vb.x + vb.w)
        expect(b.y + b.h).toBeLessThanOrEqual(vb.y + vb.h)
      }
    }
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

  it('path / affected → undefined（`sequenceAddress` 只认 relations；path 走 `sequenceSymbols`）', () => {
    expect(sequenceAddress({ kind: 'path', value: PATH })).toBeUndefined()
    expect(sequenceAddress({ kind: 'affected', value: AFFECTED })).toBeUndefined()
  })
})

describe('v17 W-9① 导出寻址载荷：relations → {node} / path → {symbols}', () => {
  const pathWith = (chain: GraphPath['chain'], found = true): GraphPath => ({ ...PATH, chain, found })

  it('relations 命中 → { node }（与 `sequenceAddress` 同源）', () => {
    expect(sequenceTarget({ kind: 'relations', dir: 'in', value: rel('pkg/a.ts#alpha') })).toEqual({
      node: 'pkg/a.ts#alpha',
    })
  })

  it('relations 多义 → undefined（那时没有命中节点，不给 label 顶替）', () => {
    const value = rel('dup', { candidates: [{ id: 'a#dup', label: 'dup' }] })
    expect(sequenceTarget({ kind: 'relations', dir: 'in', value })).toBeUndefined()
  })

  it('path 找到路径 → { symbols } = 链上 id（服务端按相邻对取边成 IR）', () => {
    expect(sequenceTarget({ kind: 'path', value: PATH })).toEqual({ symbols: ['n0', 'n1'] })
  })

  it('path 未找到 / id 不足两个 → undefined（没有相邻对可导）', () => {
    expect(sequenceSymbols({ kind: 'path', value: pathWith(PATH.chain, false) })).toBeUndefined()
    const single = [{ id: 'n0', label: 'only', file: '', line: '' }]
    expect(sequenceSymbols({ kind: 'path', value: pathWith(single) })).toBeUndefined()
    expect(sequenceTarget({ kind: 'path', value: pathWith(single) })).toBeUndefined()
  })

  it('path 里 id 为空串的跳**剔除**（服务端按 id 寻址，空串无意义）', () => {
    const chain = [
      { id: 'n0', label: 'a', file: 'f.ts', line: '1' },
      { id: '', label: 'ghost', file: '', line: '' },
      { id: 'n2', label: 'c', file: '', line: '' },
    ]
    expect(sequenceSymbols({ kind: 'path', value: pathWith(chain) })).toEqual(['n0', 'n2'])
  })

  it('path 的**多义跳不剔**：`ambiguous` 是入参符号多义，其 id 是真实节点 id（服务端照取边）', () => {
    const chain = [
      { id: 'n0', label: 'a', file: '', line: '', ambiguous: true },
      { id: 'n1', label: 'b', file: '', line: '' },
    ]
    expect(sequenceSymbols({ kind: 'path', value: pathWith(chain) })).toEqual(['n0', 'n1'])
  })

  it('affected → undefined（响应只有 label）', () => {
    expect(sequenceTarget({ kind: 'affected', value: AFFECTED })).toBeUndefined()
  })
})

describe('v17 W-8 段标注几何（file:line 画在哪 / 占多少 viewBox）', () => {
  it('段中线 = 相邻两个节点中心的中点（自上而下）', () => {
    expect(chainEdgeMidY(0)).toBe((chainY(0) + chainY(1)) / 2)
    expect(chainEdgeMidY(2)).toBe((chainY(2) + chainY(3)) / 2)
    expect(chainEdgeMidY(1)).toBeGreaterThan(chainEdgeMidY(0))
  })

  it('chainLabelBoxes：空串 / undefined 不占位；非空贴竖线右侧、以段中线为中心、宽度随码点线性', () => {
    expect(chainLabelBoxes([])).toEqual([])
    expect(chainLabelBoxes([undefined, ''])).toEqual([])

    const short = chainLabelBoxes(['ab'])[0]!
    const long = chainLabelBoxes(['abcd'])[0]!
    expect(short.x).toBe(CHAIN_VIEW_W / 2 + CHAIN_EDGE_LABEL_DX)
    expect(short.x + short.w / 2).toBeGreaterThan(CHAIN_VIEW_W / 2) // 完全在竖线右侧
    expect(short.y + short.h / 2).toBe(chainEdgeMidY(0))
    expect(long.w).toBe(short.w * 2)
    // 按**码点**估宽（同 clipLabel 口径：代理对算一个字符）
    expect(chainLabelBoxes(['😀😀'])[0]!.w).toBe(short.w)
  })

  it('并入 viewBox：全空标注 = 纯节点盒（既有断言不受扰）；有长标注则右边缘外扩', () => {
    const nodes = chainBoxes(3)
    const bare = contentViewBox(nodes)
    expect(viewBoxAttr(contentViewBox([...nodes, ...chainLabelBoxes(['', ''])]))).toBe(viewBoxAttr(bare))

    const wide = contentViewBox([
      ...nodes,
      ...chainLabelBoxes(['', 'packages/agents/src/arch/graph-ir.ts:715']),
    ])
    expect(wide.w).toBeGreaterThan(bare.w)
    // 标注在右侧、落在两节点之间的缝里 ⇒ 左 / 上边不动
    expect(wide.x).toBe(bare.x)
    expect(wide.y).toBe(bare.y)
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

/* ===== v12 F1 缩放平移（纯函数，SPEC-1.2–1.5 / 1.8） ===== */

/** 「适应窗口」的实况量级：900×600 的盒 + 12 节点纵向链的内容盒（宽 348 / 高 596）。 */
const CHAIN_VB = contentViewBox(chainBoxes(12))
/** 未测量（happy-dom / 首帧）→ 单位映射。 */
const UNIT = { scale: 1, tx: 0, ty: 0 }

describe('v12 F1 适应窗口（`fitTransform`，SPEC-1.1/1.4）', () => {
  it('宽受限：取宽度比，纵向居中', () => {
    const fit = fitTransform({ w: 800, h: 400 }, { x: 0, y: 0, w: 400, h: 400 })
    expect(fit).toEqual({ scale: 1, tx: 200, ty: 0 })
  })

  it('高受限（纵向长链的实况）：取高度比 + 横向居中 —— **不是** 1/0/0', () => {
    const fit = fitTransform({ w: 900, h: 600 }, CHAIN_VB)
    expect(fit.scale).toBeCloseTo(600 / CHAIN_VB.h, 10)
    expect(fit.scale).toBeLessThan(900 / CHAIN_VB.w) // 高度这一侧才是 min
    expect(fit.tx).toBeCloseTo((900 - CHAIN_VB.w * fit.scale) / 2 - CHAIN_VB.x * fit.scale, 10)
    expect(fit.ty).toBeCloseTo(0, 10)
    // 「适应窗口」是算出来的、不是常量：内容宽 348 而盒宽 900 —— 写死 1/0/0 会把它铺满整幅宽度
    expect(fit).not.toEqual(UNIT)
  })

  it('viewBox 原点偏移（W-1 之后 x/y 常为负）要减掉，否则内容整体推偏', () => {
    const fit = fitTransform({ w: 100, h: 100 }, { x: -10, y: -20, w: 50, h: 50 })
    expect(fit.scale).toBe(2)
    // 内容左上角 (-10,-20) 应落在盒内 (0,0)：tx = 0 - (-10)×2
    expect(fit.tx).toBe(20)
    expect(fit.ty).toBe(40)
  })

  it('退化输入（未测量 / 空内容）→ 单位映射，绝不产出 NaN / Infinity', () => {
    for (const bad of [
      { w: 0, h: 0 },
      { w: 800, h: 0 },
      { w: Number.NaN, h: 400 },
    ]) {
      expect(fitTransform(bad, CHAIN_VB)).toEqual(UNIT)
    }
    expect(fitTransform({ w: 800, h: 400 }, { x: 0, y: 0, w: 0, h: 0 })).toEqual(UNIT)
  })
})

describe('v12 F1 倍率：clamp 与百分比（SPEC-1.2/1.5）', () => {
  it('clamp 0.3–3，NaN / ±Infinity 回落 1（不让脏输入把视图钉死在边界）', () => {
    expect(clampZoom(0.1)).toBe(0.3)
    expect(clampZoom(9)).toBe(3)
    expect(clampZoom(0.3)).toBe(0.3)
    expect(clampZoom(3)).toBe(3)
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1)
  })

  it('倍率 = 状态 / 适应窗口；`fit` 退化（未测量）时按 1（百分比 100%）', () => {
    const fit = fitTransform({ w: 900, h: 600 }, CHAIN_VB)
    expect(zoomRatio(fit, fit)).toBe(1)
    expect(zoomPercent(fit, fit)).toBe(100)
    expect(zoomRatio({ scale: fit.scale * 1.5, tx: 0, ty: 0 }, fit)).toBeCloseTo(1.5, 10)
    expect(zoomPercent({ scale: fit.scale * 1.5, tx: 0, ty: 0 }, fit)).toBe(150)
    expect(zoomRatio({ scale: 2, tx: 0, ty: 0 }, UNIT)).toBe(2)
  })
})

describe('v12 F1 指针锚缩放（`zoomAt`，SPEC-1.2）', () => {
  const fit = fitTransform({ w: 900, h: 600 }, CHAIN_VB)
  /** 指针底下的内容坐标（元素像素 → 内容单位）：缩放前后必须一致。 */
  const under = (t: { scale: number; tx: number; ty: number }, at: Point): Point => ({
    x: (at.x - t.tx) / t.scale,
    y: (at.y - t.ty) / t.scale,
  })

  it('步进 1.1×：一轮放大 + 一轮缩小回到原状态', () => {
    const at = { x: 300, y: 200 }
    const bigger = zoomAt(fit, ZOOM_STEP, at, fit)
    expect(zoomRatio(bigger, fit)).toBeCloseTo(1.1, 10)
    const back = zoomAt(bigger, 1 / ZOOM_STEP, at, fit)
    expect(zoomRatio(back, fit)).toBeCloseTo(1, 10)
    expect(back.tx).toBeCloseTo(fit.tx, 10)
    expect(back.ty).toBeCloseTo(fit.ty, 10)
  })

  it('锚点 = 指针位置：指针底下的内容点缩放前后落在同一位置（含已平移的态）', () => {
    const moved = panBy(fit, -40, 25)
    for (const at of [{ x: 0, y: 0 }, { x: 300, y: 200 }, { x: 899, y: 599 }]) {
      const next = zoomAt(moved, ZOOM_STEP, at, fit)
      const before = under(moved, at)
      const after = under(next, at)
      expect(after.x).toBeCloseTo(before.x, 9)
      expect(after.y).toBeCloseTo(before.y, 9)
    }
  })

  it('锚点不变式扫掠（tester-whitebox 补）：任意起始倍率 × 偏移 × 指针组合，指针下内容点恒不动', () => {
    // 确定性网格（不用随机数，失败可复现）：起始倍率扫 clamp 全域、偏移扫正负、
    // 指针扫盒内含角点——把「手算成立」锁成任意组合下的不变式，而非 3 个样本点。
    for (const ratio of [0.3, 0.5, 1, 1.37, 2, 3]) {
      for (const [dx, dy] of [[0, 0], [-123, 47], [811, -90]] as const) {
        const start = panBy({ ...fit, scale: clampZoom(ratio) * fit.scale }, dx, dy)
        for (const at of [{ x: 0, y: 0 }, { x: 7, y: 513 }, { x: 450, y: 300 }, { x: 900, y: 600 }]) {
          const next = zoomAt(start, ZOOM_STEP, at, fit)
          const before = under(start, at)
          const after = under(next, at)
          expect(after.x, `ratio=${ratio} d=${dx},${dy} at=${at.x},${at.y}`).toBeCloseTo(before.x, 8)
          expect(after.y, `ratio=${ratio} d=${dx},${dy} at=${at.x},${at.y}`).toBeCloseTo(before.y, 8)
          if (ratio >= 3) {
            // 边界档：放大被钳位 ⇒ 整个变换是 no-op（scale 与偏移都不动）
            expect(next.scale).toBe(start.scale)
            expect(next.tx).toBeCloseTo(start.tx, 8)
            expect(next.ty).toBeCloseTo(start.ty, 8)
          } else {
            // 非边界档：反向步回，锚点不变式 + 倍率往返双闭合
            const back = zoomAt(next, 1 / ZOOM_STEP, at, fit)
            expect(back.tx, `round-trip tx ratio=${ratio}`).toBeCloseTo(start.tx, 8)
            expect(back.ty, `round-trip ty ratio=${ratio}`).toBeCloseTo(start.ty, 8)
            expect(back.scale, `round-trip scale ratio=${ratio}`).toBeCloseTo(start.scale, 8)
          }
        }
      }
    }
  })

  it('`userTransform` 往返（tester-whitebox 补）：fit 态归一化为单位变换；任意态归一化后可由 fit 复原', () => {
    // fit 态 ⇒ <g> 单位变换（meet 已承载适应窗口——D4-1 口径的数学面）
    expect(userTransform(fit, fit)).toEqual(UNIT)
    // 任意缩放平移态：归一化结果与「fit 映射 ∘ 归一化变换」复合 = 原状态映射（不丢信息）
    const view = panBy(zoomAt(fit, ZOOM_STEP, { x: 120, y: 340 }, fit), -66, 18)
    const g = userTransform(view, fit)
    const composite = (p: Point): Point => ({
      x: fit.scale * (g.scale * p.x + g.tx) + fit.tx,
      y: fit.scale * (g.scale * p.y + g.ty) + fit.ty,
    })
    for (const p of [{ x: 0, y: 0 }, { x: 30, y: -210 }, { x: 480, y: 96 }]) {
      expect(composite(p).x).toBeCloseTo(view.scale * p.x + view.tx, 8)
      expect(composite(p).y).toBeCloseTo(view.scale * p.y + view.ty, 8)
    }
  })

  it('clamp 到 0.3 / 3：连按步进不会越界（指针锚在边界上仍然成立）', () => {
    let view = fit
    for (let i = 0; i < 30; i++) view = zoomAt(view, ZOOM_STEP, { x: 450, y: 300 }, fit)
    expect(zoomRatio(view, fit)).toBe(3)
    for (let i = 0; i < 30; i++) view = zoomAt(view, 1 / ZOOM_STEP, { x: 450, y: 300 }, fit)
    expect(zoomRatio(view, fit)).toBeCloseTo(0.3, 10)
  })

  it('未测量（fit 退化）时照常工作：倍率相对单位映射，不除零', () => {
    const next = zoomAt(UNIT, ZOOM_STEP, { x: 100, y: 50 }, UNIT)
    expect(next.scale).toBeCloseTo(1.1, 10)
    expect(next.tx).toBeCloseTo(100 - 100 * 1.1, 10)
    expect(Number.isFinite(next.tx)).toBe(true)
  })
})

describe('v12 F1 平移与 `<g transform>` 归一化（SPEC-1.1/1.3）', () => {
  const fit = fitTransform({ w: 900, h: 600 }, CHAIN_VB)

  it('`panBy`：位移直接相加、倍率不变（1px 拖拽 = 图上 1px）', () => {
    const moved = panBy(fit, 12, -5)
    expect(moved).toEqual({ scale: fit.scale, tx: fit.tx + 12, ty: fit.ty - 5 })
    expect(zoomRatio(moved, fit)).toBe(1)
  })

  it('`userTransform`：fit 态 ⇒ 单位变换（写进 `<g>` 的就是它，渲染与 W-1 一致）', () => {
    expect(userTransform(fit, fit)).toEqual(UNIT)
  })

  it('`userTransform` ∘ 浏览器自己那条 meet 映射 = 状态定义的屏幕映射（不叠加两次）', () => {
    const view = zoomAt(panBy(fit, 30, -20), ZOOM_STEP, { x: 100, y: 100 }, fit)
    const g = userTransform(view, fit)
    for (const v of [{ x: CHAIN_VB.x, y: CHAIN_VB.y }, { x: 0, y: 0 }, { x: 400, y: 500 }]) {
      // 浏览器：viewBox 用户坐标 → 元素像素（meet）；内层 `<g>`：用户坐标里再叠一次
      const onScreen = fit.scale * (g.scale * v.x + g.tx) + fit.tx
      expect(onScreen).toBeCloseTo(view.scale * v.x + view.tx, 8)
      const onScreenY = fit.scale * (g.scale * v.y + g.ty) + fit.ty
      expect(onScreenY).toBeCloseTo(view.scale * v.y + view.ty, 8)
    }
  })

  it('`transformAttr`：保留 3 位小数（1.1 的幂带长尾），顺序是 translate 后 scale', () => {
    expect(transformAttr({ scale: 1, tx: 0, ty: 0 })).toBe('translate(0 0) scale(1)')
    expect(transformAttr({ scale: 1 / 1.1, tx: -10.00000001, ty: 2.5 })).toBe('translate(-10 2.5) scale(0.909)')
  })
})

describe('v12 F1 第二行标注（SPEC-1.8 / R-1 闭合点）', () => {
  it('阈值 1.5：1.49 不画、1.5 起画', () => {
    expect(annotationVisible(1.49)).toBe(false)
    expect(annotationVisible(1.5)).toBe(true)
    expect(annotationVisible(3)).toBe(true)
    expect(ANNOTATION_SCALE).toBe(1.5)
  })

  it('`id · file:line` 三段齐全；缺一段只给那一段（不拼空壳）', () => {
    expect(annotationLine('pkg/a.ts#alpha', 'src/a.ts', '52')).toBe('pkg/a.ts#alpha · src/a.ts:52')
    expect(annotationLine('n#a', 'src/a.ts', '')).toBe('n#a · src/a.ts')
    expect(annotationLine('n#a', '', '52')).toBe('n#a · 52')
    // id 拿不到（理论上不该发生：能画第二行的节点都带 id）就不硬拼分隔符
    expect(annotationLine('  ', 'src/a.ts', '52')).toBe('src/a.ts:52')
  })

  it('没有 file/line 就**没有**第二行（`path` 链 / `relations` 中心节点都不带定位）', () => {
    expect(annotationLine('someSymbol', '', '')).toBeNull()
    expect(annotationLine('', '', '')).toBeNull()
  })

  it('**不截断**：长路径原样留在第二行（R-1 要的就是「放大后看清 file:line」）', () => {
    const file = 'packages/agents/src/arch/graph-ir.ts'
    const line = annotationLine('pkg/x.ts#veryLongSymbolName', file, '715')
    expect(line).toBe(`pkg/x.ts#veryLongSymbolName · ${file}:715`)
    expect(line).not.toContain('…')
  })
})

/* ===== v15 W-1 容器 resize 重 fit（纯函数，SPEC-5.1–5.3） ===== */

describe('v15 W-1 容器 resize 重 fit 的判定与防抖（纯函数）', () => {
  it('防抖时长是 200ms（SPEC-5.3 的验收数值——钉死它，免得被当成随手取的实现细节改掉）', () => {
    expect(REFIT_DEBOUNCE_MS).toBe(200)
  })

  it('pristine 决策：未手动缩放（true）→ 重算 fit；已手动缩放/平移（false）→ 不动视口', () => {
    expect(shouldRefitOnResize(true)).toBe(true)
    expect(shouldRefitOnResize(false)).toBe(false)
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
