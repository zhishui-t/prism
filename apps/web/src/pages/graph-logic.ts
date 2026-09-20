/**
 * v10 F5 调用链图化：**纯函数层**（形状判据 / 布局几何 / 分组 / 导出寻址 / 错误码映射）。
 *
 * 为什么单开一个文件：与 `skills-logic.ts` / `knowledge-logic.ts` 同一口径——
 * 这一层全是「给定数据算出数字或键」的纯变换，可在 node 环境直测，不必搭 DOM；
 * 渲染（SVG / 分组行）留给 `./CallChainGraph.tsx`。
 *
 * 三条口径写死在这里（改设计时同步改这里）：
 * - **几何是数据算出来的**（viewBox 坐标），不是样式：`styles.css` 只管颜色 / 字族 / 字号，
 *   SVG 里不写 inline style、不写 hex；
 * - **可寻址的只有 id**：`relations` 的 `node` / `items[].other` 是 id，`path.chain` 与
 *   `affected.nodes[].label` 是 label（本仓 2340 节点仅 2063 个唯一 label）——
 *   导出寻址与节点点击都只认 id；
 * - **不猜**：拿不到数据就不编（`affected` 无方向字段 → 按 `relation` 分组；
 *   `path` 无 file/line → 不画 location 标注）。见各函数头注。
 */

import type { GraphAffected, GraphRelations } from '../api.ts'
import type { DictKey } from '../i18n.ts'
import type { GraphQueryResult } from './GraphQuery.tsx'

/* ===== 呈现形状 ===== */

/** F5 的三档呈现：纵向链（path）/ 中心-辐射（relations）/ 分组列表（affected）。 */
export type ChainShape = 'chain' | 'radial' | 'groups'

/** 响应 kind → 呈现形状（**唯一判据处**；组件据此挂 `data-shape`）。 */
export function chainShape(kind: GraphQueryResult['kind']): ChainShape {
  if (kind === 'relations') return 'radial'
  if (kind === 'path') return 'chain'
  return 'groups'
}

/* ===== 中心-辐射布局 ===== */

/** 中心节点（当前节点）的坐标与尺寸。 */
export const RADIAL_CENTER = { x: 280, y: 165, w: 190, h: 30 } as const

/** 关系节点的尺寸，以及它们所在椭圆的半轴。 */
export const RADIAL_PEER = { w: 132, h: 26 } as const
const RADIAL_RX = 200
const RADIAL_RY = 108

/**
 * 图上最多画几个关系节点。
 *
 * 超出的**不画**（而不是画小一点）：这一档只回答「形状长什么样」，
 * 精确清单由面板下方的既有行列表承担（那里有 kind + file:line 且不截断）。
 */
export const RADIAL_MAX = 8

/** 第 `index` 个关系节点的坐标：自**正上方**起顺时针均分（`count` = 实际入图个数）。 */
export function radialPoint(index: number, count: number): { x: number; y: number } {
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2
  return {
    x: RADIAL_CENTER.x + RADIAL_RX * Math.cos(angle),
    y: RADIAL_CENTER.y + RADIAL_RY * Math.sin(angle),
  }
}

/* ===== 纵向链路布局 ===== */

/**
 * 纵向链的**布局宽度**：节点横向居中于它的中线（`CHAIN_VIEW_W / 2`）。
 *
 * v12 F1：viewBox 不再取本值，而由节点几何包围盒算出（`contentViewBox`）——
 * 本值仍决定节点在坐标空间里的水平位置（改布局时才动它）。
 */
export const CHAIN_VIEW_W = 560
const CHAIN_TOP = 24
const CHAIN_ROW_H = 46
export const CHAIN_NODE = { w: 300, h: 28 } as const

/**
 * 链过长时不画图。
 *
 * 依据：截断的纵向链在视觉上**等于一条更短的链**（末节点下面没有箭头，看起来就是终点），
 * 而 `.graph-chain` 的文本本身完整——宁可不画，也不画半条链（R4/R7 同族：不制造假信息）。
 */
export const CHAIN_MAX = 12

/** 第 `index` 行的节点中心 y（自上而下）。 */
export function chainY(index: number): number {
  return CHAIN_TOP + CHAIN_NODE.h / 2 + index * CHAIN_ROW_H
}

/* ===== 节点几何包围盒 → viewBox（v12 F1） ===== */

/**
 * viewBox 坐标下的轴对齐矩形（`x` / `y` 是左上角）。
 *
 * 与下面的 `Box` 分开：那个只有尺寸（连线退让用），这个带位置（包围盒用）。
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 节点框到 viewBox 边缘的留白。取既有间距档 `--s-5`（24px），与纵向链首行距顶
 * （`CHAIN_TOP`）同值——故链图的包围盒顶边恰落在 y=0，viewBox 高度与旧画布一致。
 */
export const VIEW_PAD = 24

/** 框心 + 框尺寸 → viewBox 矩形。 */
export function boxAt(center: Point, size: Box): Rect {
  return { x: center.x - size.w / 2, y: center.y - size.h / 2, w: size.w, h: size.h }
}

/**
 * 节点几何包围盒 + padding → viewBox（**纯函数，不做 DOM 测量**）。
 *
 * 为什么是「节点包围盒」而不是「内容包围盒」：图上只有节点框有几何——边是端点连线
 * （两端退到框外，不超出节点簇）、文字由 `<title>` 与节点的第二行承担而不参与布局；
 * 量文本必须 DOM。故包围盒由节点坐标纯函数可得，这正是 SPEC-1.1 的口径。
 *
 * 空输入返回零矩形（本组件两档在无节点时本就整图不画；调用方不必先分支，但也不许
 * 拿它去当有效视口）。
 */
export function contentViewBox(boxes: readonly Rect[], pad = VIEW_PAD): Rect {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

/**
 * viewBox 属性串。**保留两位小数**：布局里的三角函数（`radialPoint` 的 cos/sin）
 * 带 1e-15 级浮点噪声，直接 `String()` 会写出 `280.00000000000006` 这种脏值——
 * 该属性既是浏览器读的、也是测试断言的契约，噪声不是信息。
 */
export function viewBoxAttr(vb: Rect): string {
  const round = (n: number): number => Math.round(n * 100) / 100
  return `${round(vb.x)} ${round(vb.y)} ${round(vb.w)} ${round(vb.h)}`
}

/** 星形图的节点框：中心 + 前 `count` 个关系节点（自正上方顺时针，同 `radialPoint`）。 */
export function radialBoxes(count: number): Rect[] {
  const boxes = [boxAt(RADIAL_CENTER, RADIAL_CENTER)]
  for (let i = 0; i < count; i++) boxes.push(boxAt(radialPoint(i, count), RADIAL_PEER))
  return boxes
}

/** 纵向链的节点框：自上而下、横向居中于 `CHAIN_VIEW_W / 2`。 */
export function chainBoxes(count: number): Rect[] {
  const cx = CHAIN_VIEW_W / 2
  return Array.from({ length: Math.max(0, count) }, (_, i) => boxAt({ x: cx, y: chainY(i) }, CHAIN_NODE))
}

/* ===== 连线的端点：退到节点框外 ===== */

export interface Point {
  x: number
  y: number
}

export interface Box {
  w: number
  h: number
}

export interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 连线与节点框之间留的缝（箭头尖与框沿不贴死）。 */
export const EDGE_GAP = 4

/**
 * 把「框心 → 框心」的连线两端各退到**框沿之外**（再留 `gap`）。
 *
 * 为什么必须退：`<line>` 画到框心时，两端都被后画的节点框盖住——`marker-end` 的箭头
 * 正好落在框内，**整根箭头被埋**（本批实现时实际踩到）。退到框沿后箭头才可见，
 * 且方向语义（入边箭头指向中心、出边箭头指向对端）仍然成立。
 *
 * 退的距离 = 沿连线方向到矩形边界 + `gap`（矩形边界用 `min(hw/|ux|, hh/|uy|)` 求，
 * 即「射线先碰到哪条边」）。两框离得太近（退完会反向）时**退化为零长线段**：
 * 宁可这根线不画，也不画一根箭头朝反的线。
 */
export function segmentBetweenBoxes(from: Point, fromBox: Box, to: Point, toBox: Box, gap = EDGE_GAP): Segment {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x1: from.x, y1: from.y, x2: to.x, y2: to.y }
  const ux = dx / len
  const uy = dy / len
  const reach = (box: Box): number => Math.min(
    ux === 0 ? Number.POSITIVE_INFINITY : box.w / 2 / Math.abs(ux),
    uy === 0 ? Number.POSITIVE_INFINITY : box.h / 2 / Math.abs(uy),
  )
  const start = reach(fromBox) + gap
  const end = reach(toBox) + gap
  if (start + end >= len) {
    const mid = { x: from.x + dx / 2, y: from.y + dy / 2 }
    return { x1: mid.x, y1: mid.y, x2: mid.x, y2: mid.y }
  }
  return {
    x1: from.x + ux * start,
    y1: from.y + uy * start,
    x2: to.x - ux * end,
    y2: to.y - uy * end,
  }
}

/* ===== 缩放平移（v12 F1 / SPEC-1.2–1.5） ===== */

/** 元素盒尺寸（px）。 */
export interface Size {
  w: number
  h: number
}

/**
 * 内容 → 屏幕的仿射映射（**元素像素坐标系**，原点 = 元素盒左上角）：`e = scale · v + (tx, ty)`。
 *
 * ⚠ 同一个类型出现在两个坐标系里，靠函数名分辨（两处的注释都写明单位）：
 * - `fitTransform` / `zoomAt` / `panBy` 的入参与出参 = **元素像素**（状态与事件同单位，拖拽 1px = 位移 1px）；
 * - `userTransform` 的出参 = **viewBox 用户坐标**（写进内层 `<g transform>` 的那份）。
 */
export interface ZoomTransform {
  scale: number
  tx: number
  ty: number
}

/**
 * 「适应窗口」（SPEC-1.4，也是**初始态**）：容器盒 × 内容 viewBox → 内容在盒内的映射。
 *
 * - `scale = min(盒宽/内容宽, 盒高/内容高)`：**双向比取 min** ⇒ 两个方向都不裁切
 *   （宁 letterbox 不拉伸——与 `preserveAspectRatio: meet` 同一条算法）；
 * - `tx / ty` = 剩余空间的居中偏移，并减掉 viewBox 自身的原点偏移（W-1 之后 `vb.x/vb.y`
 *   常是负数，不减会把内容整体推偏；这条同时是浏览器自己那条 meet 映射的定义）。
 *
 * 退化输入（盒或内容任一维 ≤ 0，如未测量 / 空图）→ 单位映射：调用方据此走兜底，
 * **绝不返回 NaN / Infinity** 让下游拿去做除法。
 */
export function fitTransform(box: Size, vb: Rect): ZoomTransform {
  if (!(box.w > 0) || !(box.h > 0) || !(vb.w > 0) || !(vb.h > 0)) return { scale: 1, tx: 0, ty: 0 }
  const scale = Math.min(box.w / vb.w, box.h / vb.h)
  return {
    scale,
    tx: (box.w - vb.w * scale) / 2 - vb.x * scale,
    ty: (box.h - vb.h * scale) / 2 - vb.y * scale,
  }
}

/** 滚轮一格的倍率（SPEC-1.2：向上 ×1.1，向下 ÷1.1）。 */
export const ZOOM_STEP = 1.1
/** 相对「适应窗口」的倍率下限（SPEC-1.2：clamp 0.3–3）。 */
export const ZOOM_MIN = 0.3
/** 相对「适应窗口」的倍率上限。 */
export const ZOOM_MAX = 3

/**
 * 倍率 clamp（SPEC-1.2）。非有限值（NaN / ±Infinity，来自未测量的盒）→ 1
 * ——不让一次脏输入把视图钉死在边界上。
 */
export function clampZoom(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, ratio))
}

/** 当前倍率 = 状态相对「适应窗口」的比值（1 = 适应窗口 = 100%）。`fit` 退化时按 1。 */
export function zoomRatio(view: ZoomTransform, fit: ZoomTransform): number {
  return fit.scale > 0 ? view.scale / fit.scale : 1
}

/** 百分比读数（SPEC-1.5：只读显示当前 scale，四舍五入到整数）。 */
export function zoomPercent(view: ZoomTransform, fit: ZoomTransform): number {
  return Math.round(zoomRatio(view, fit) * 100)
}

/**
 * 指针锚缩放（SPEC-1.2）：`at`（**元素盒坐标**，px）底下的那个内容点，缩放前后落在同一屏幕位置。
 *
 * 先按**旧**映射反解出锚点内容坐标，再把新偏移解回去；倍率 = 当前倍率 ×`factor` 后 clamp。
 * 反解与解回都在元素像素里做（状态同单位），所以不依赖任何「当前倍率是多少」的假设。
 */
export function zoomAt(view: ZoomTransform, factor: number, at: Point, fit: ZoomTransform): ZoomTransform {
  const from = view.scale > 0 ? view.scale : 1
  const scale = clampZoom(zoomRatio(view, fit) * factor) * (fit.scale > 0 ? fit.scale : 1)
  const ux = (at.x - view.tx) / from
  const uy = (at.y - view.ty) / from
  return { scale, tx: at.x - ux * scale, ty: at.y - uy * scale }
}

/**
 * 平移（SPEC-1.3）：拖拽位移**直接**加到映射偏移上——1px 拖拽 = 图上 1px 位移，
 * 与当前倍率无关（倍率已在映射里；再乘一次会让「放大后拖不动」）。
 */
export function panBy(view: ZoomTransform, dx: number, dy: number): ZoomTransform {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }
}

/**
 * 「元素像素映射」→ **viewBox 用户坐标**里的 `<g transform>`（SPEC-1.1：缩放平移只动内层 `<g>`）。
 *
 * 为什么要除以 `fit`：SVG 自己已按 `meet` 把 viewBox 铺进元素盒（那条映射的定义**就是** `fit`），
 * 而内层 `<g>` 的 transform 是在**用户坐标**里叠加的。不归一化就等于把「适应窗口」叠加两次
 * （等比再放 `fit.scale` 倍）——正是设计警告的「纵向链反向爆放」形态。
 * 故 `fit` 态 ⇒ `{ scale: 1, tx: 0, ty: 0 }`：渲染结果与 W-1 完全一致（比例由 viewBox + meet 定）。
 *
 * ⚠ 「适应窗口」的**状态**仍是 `fitTransform` 算出的那组数（不是 1/0/0）——归一化只发生在
 * 写进 `<g>` 的最后一步，窗口尺寸或内容变了都会重新算，这正是它与「空洞地把 scale 设成 1」的区别。
 */
export function userTransform(view: ZoomTransform, fit: ZoomTransform): ZoomTransform {
  const base = fit.scale > 0 ? fit.scale : 1
  return { scale: view.scale / base, tx: (view.tx - fit.tx) / base, ty: (view.ty - fit.ty) / base }
}

/**
 * `<g transform>` 属性串。**保留 3 位小数**：倍率是 1.1 的幂（`1/1.1` 带长尾），
 * 该属性既是浏览器读的、也是测试断言的契约，噪声不是信息（同 `viewBoxAttr` 的口径）。
 */
export function transformAttr(t: ZoomTransform): string {
  const round = (n: number): number => Math.round(n * 1000) / 1000
  return `translate(${round(t.tx)} ${round(t.ty)}) scale(${round(t.scale)})`
}

/* ===== 容器 resize 重 fit（v15 W-1 / SPEC-5.1–5.3） ===== */

/**
 * 容器尺寸变化后重算「适应窗口」的**防抖**时长（ms）。
 *
 * 拖窗口边缘会连发几十次 resize；防抖到 200ms 一次，重算与重渲染都只做一次
 * （SPEC-5.3「防抖 200ms 一次重算」——该数值是验收契约，故与下面的决策函数一并下沉到
 * 这里：组件只接线，自动化测试只打纯函数，happy-dom 量不到盒也不必碰 DOM）。
 */
export const REFIT_DEBOUNCE_MS = 200

/**
 * 容器 resize 后**是否**重算 fit（SPEC-5.1/5.2，S-8 裁决）。
 *
 * - `true`（pristine = 用户**从未**手动改变视口）⇒ 重新适配：初始态跟随容器尺寸；
 * - `false`（wheel / 拖拽 / ± 缩放过）⇒ **不动视口**：用户手动定下的视口是对 resize 的
 *   明确选择，自动拉回 fit 会把它抹掉（S-8「手动态不打扰」）。
 *
 * 判定只有这一条，故写成显式函数而不是组件里内联的 `if`：它是规格里要断言的那条规则
 * （重置回 pristine 的入口——`refit` 与内容切换——留在组件的一侧）。
 */
export function shouldRefitOnResize(pristine: boolean): boolean {
  return pristine
}

/* ===== 标签 ===== */

/**
 * 节点标签截断。SVG 的 `<text>` **不会**自动截断，长了就压到隔壁节点上。
 *
 * 用 `[...text]` 迭代（按**码点**，不是 UTF-16 码元）——本仓符号名全是 ASCII，
 * 但标签来自用户仓库，CJK / emoji 都可能出现，按码元切会把代理对切成乱码。
 * 全文不减：`<title>` 与 aria-label 都带完整标签。
 */
export function clipLabel(text: string, max = 22): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/* ===== 第二行标注（v12 F1 / SPEC-1.8：R-1「看清 file:line」的闭合点） ===== */

/** 第二行的显隐阈值：倍率 ≥ 1.5 才画（低倍率交给 `<title>` 悬停与查询面板清单）。 */
export const ANNOTATION_SCALE = 1.5

/** 倍率是否已到「画第二行」的档（SPEC-1.8）。 */
export function annotationVisible(ratio: number): boolean {
  return ratio >= ANNOTATION_SCALE
}

/**
 * 节点第二行标注：`id · file:line`，**不截断**（不套 `clipLabel`）。
 *
 * **不猜**（本模块的头注同源）：数据里没有 file/line 就没有第二行——
 * - `relations` 的**关系节点**有 id（`other`）+ 定位 → 有第二行；
 * - `relations` 的**中心节点**只有 id，响应里没有它的 file/line → 无第二行；
 * - `path.chain` 是 graphify 切出来的符号串（无 id / 无定位）→ 无第二行。
 * 拿不到就返回 `null`，绝不拼个空壳或拿 label 顶 id。
 */
export function annotationLine(id: string, file: string, line: string): string | null {
  const at = formatLocation(file, line)
  if (at === '') return null
  const name = id.trim()
  return name === '' ? at : `${name} · ${at}`
}

/* ===== affected 分组 ===== */

export interface AffectedGroup {
  /** 分组键 = 边的 `relation` 原值；空串归 `''`（渲染层用「其他关系」文案兜底）。 */
  relation: string
  items: GraphAffected['nodes']
}

/**
 * 受影响节点分组。
 *
 * ⚠ **分组键是 `relation`，不是设计稿写的「方向」**：`GET /api/graph/affected` 的响应只有
 * `{ label, relation, location }`（`packages/server/src/graph/graphify.ts` 的 `graphAffected`），
 * **没有方向字段**——该查询本身只有一个语义（「改动 X 会波及谁」），回来的节点同向。
 * 硬造一个方向分组会产出假信息，故取现有数据能表达的**最细粒度**：同向之内按关系类型分。
 * 待后端核对项（见交付报告）：若后端补 `dir`，这里换成分组键即可（渲染层不动）。
 *
 * 组序 = **首次出现顺序**（不排序）：服务端回的顺序就是 graphify 的遍历顺序，
 * 重排会平白丢掉「谁先被波及」这条信息。
 */
export function groupAffected(nodes: GraphAffected['nodes']): AffectedGroup[] {
  const groups: AffectedGroup[] = []
  const at = new Map<string, AffectedGroup>()
  for (const node of nodes) {
    let group = at.get(node.relation)
    if (group === undefined) {
      group = { relation: node.relation, items: [] }
      at.set(node.relation, group)
      groups.push(group)
    }
    group.items.push(node)
  }
  return groups
}

/* ===== 时序图导出寻址 ===== */

/**
 * 导出时序图的**寻址 id**。拿不到就返回 `undefined`（按钮随之禁用 + 说明），不拿 label 顶替。
 *
 * 依据（design-v10 F5-2）：寻址一律用**节点 id**——本仓 159/2063 个 label 跨多文件，
 * 按名寻根会**静默选错文件**。而四模式响应里只有 `relations` 带 id：
 * - `relations`：`node` 是命中节点 id（`graphify.ts` 的 `graphRelations` 里 `node: target.id`）
 *   → 可用；**多义**时 `node` 是查询原串（没有命中节点）→ 不可用；
 * - `path`：只有 `chain: string[]`（graphify 输出切出来的符号串，没有 id）→ 不可用；
 * - `affected`：只有 `label` → 不可用。
 * 两种不可用都是**数据缺口**，不是实现偷懒——故禁用而非「尽力猜一个」。
 */
export function sequenceAddress(result: GraphQueryResult): string | undefined {
  if (result.kind !== 'relations') return undefined
  const value: GraphRelations = result.value
  if (value.candidates !== undefined && value.candidates.length > 0) return undefined
  const id = value.node.trim()
  return id === '' ? undefined : id
}

/* ===== 导出错误 → 文案键 ===== */

/**
 * 判据词。**用转义写**：`src/**` 里除字典外不许有裸 CJK（`scripts/check-hardcoded-cjk.mjs`），
 * 而这两个词是**服务端消息的片段**、不是界面文案——不能进字典，只能转义。
 * 原词：`ROOT_FILE` = 「根文件」，`CALLS_EDGE` = 「calls 边」。
 */
const ROOT_FILE = '\u6839\u6587\u4ef6'
const CALLS_EDGE = 'calls \u8fb9'

/**
 * 导出失败 → i18n 键。分派分**两层**（后端冻结的错误码，见
 * `v10-backend-report.md` 的「契约冻结」节 + `packages/server/src/http/routes/arch.ts`）：
 *
 * **第一层：按码分派**（可靠，不依赖文案）——`project_root_missing` 是**独立码**，不是
 * `bad_request` 的变体：它由 `resolveArchPlacement` → `assertProjectRoot`
 * （`packages/server/src/graph/arch-placement.ts:69`）在「项目已注册、但根目录被删/被移」
 * 时抛，与「节点/图内容有问题」是两回事（用户能自己修，故文案要指向修法）。
 *
 * **第二层：`bad_request` 内按消息关键字分派**（刻意的**契约耦合**，只此一处）：
 * 后端把 `buildSequenceIr` 的两条抛错原样包进同一个 `bad_request`，信封里没有更细的
 * 判别位，故只能按消息里的**唯一词**分：
 * - 含「根文件」= `指定的根文件没有跨文件调用边`（`packages/agents/src/arch/graph-ir.ts:715`；
 *   本仓 27.6% 节点命中，**高频路径**，F5-1 专门点名）；
 * - 含「calls 边」= `图谱没有跨文件 calls 边，无法派生时序图`（同文件 `:702`；后端
 *   `arch.ts` 的 from-graph 分支已把该句后半段「改用 architecture/dataflow」改写成
 *   **本入口可执行**的指引，判别词本身不变——见 `arch.ts` 的 catch 注记，派修 P2-2）。
 *
 * 其余（含 `bad_request` 里认不出的那些、`not_found`、网络错）一律 `null` → 调用方
 * 走 `graph.seq.failed` 的**原文透出**。后端若改这两条文案，这里会静默退化成原文透出
 * ——听得懂的前提是看得见原文，不会假报成功。核对项记在交付报告里。
 */
export function sequenceExportErrorKey(message: string): DictKey | null {
  if (message.startsWith('project_root_missing')) return 'graph.seq.noProjectRoot'
  if (!message.startsWith('bad_request')) return null
  if (message.includes(ROOT_FILE)) return 'graph.seq.noRootEdge'
  if (message.includes(CALLS_EDGE)) return 'graph.seq.noCalls'
  return null
}

/* ===== 既有纯函数（自 `GraphQuery.tsx` 迁入） ===== */

/** 调用点定位文本（`file:line`；两段都可缺，缺哪段不显示哪段——不做拼接假象）。 */
export function formatLocation(file: string, line: string): string {
  if (file === '' && line === '') return ''
  if (file === '') return line
  if (line === '') return file
  return `${file}:${line}`
}
