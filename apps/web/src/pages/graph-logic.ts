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

/**
 * 辐射图的画布（viewBox 坐标）。容器宽度无关：SVG 以 `width: 100%` 自适应，
 * 这里只定**内部比例**。560×340 选得比较紧：面板最窄约 380px 时缩放比 ≈0.68，
 * `--fs-200` 的 12px 会落到 ~8px——再宽就挤不进侧栏，再窄就该改布局了（记在报告里）。
 */
export const RADIAL_VIEW = { w: 560, h: 340 } as const

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

/** 画布高度：末行之下留一档（`--s-5` 的 24px）落白。 */
export function chainViewH(count: number): number {
  return chainY(Math.max(0, count - 1)) + CHAIN_NODE.h / 2 + 24
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
