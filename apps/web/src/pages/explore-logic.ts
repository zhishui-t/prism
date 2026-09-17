/**
 * v10 F9ui 层级探索的**纯函数层**：路径语义、边强度归集、分页切片。
 *
 * 分工与 `./graph-logic.ts` 同款：判据与几何在这里（node 环境可直测），
 * 组件（`./GraphExplore.tsx`）只负责取数与摆放。
 *
 * 三条口径（改设计时同步改这里）：
 * 1. **三层是对同一批符号的独立投影，不是包含树**（交叉验证 F9-1：本仓 62/274 文件跨社区）。
 *    且三层的**计数口径不同**：`dir` 层的 `symbol_count` 是**该社区成员**按 `source_file` 的
 *    dirname（目录全路径）聚合出的条数——只数这个社区的人；`file` / `symbol` 层是**全图口径**
 *    （合成 id `dir:<path>` / `file:<path>` 不含社区段，下钻到它们自然回到全图）。所以
 *    「社区 → 目录」与「目录 → 文件」的计数**不相等是正常的**，下钻时计数变大也不奇怪
 *    （后端 `rollup.ts` 头注把这条写在最前面；口径裁决见 code-review-v10 §1 P1-2——**保持
 *    实现**）。UI **不得**把社区与目录渲染成父子归属，面包屑只表达**探索路径**。
 * 2. **`symbol` 不是网格层**：它是 `file` 的只读出口（列文件内符号后切到查询态），
 *    故不进面包屑（`GRID_LEVELS` 只有三层）。`drillTarget` 仍会给出 `symbol`——
 *    组件据此把「file 卡片」渲染成「查此节点」而不是「再下钻一层」。
 * 3. **服务端没有分页参数**（`graph-rollup.test.ts` 的「缺少 parent」一族里没有任何
 *    limit/offset），截断是 500 条硬上限 + `symbol_count` 降序。故 `truncated` 的余量
 *    **取不回来**：UI 如实呈现 `total` 与已返回条数，不假装「更多」能拉到剩下的
 *    （见 `GraphExplore.tsx` 的截断提示），长列表的「更多」只做**已取回数据**的客户端分页。
 */

import type { RollupEdge, RollupLevel } from '../api.ts'

/** 网格层（面包屑与卡片网格只在这三层）。 */
export const GRID_LEVELS: readonly RollupLevel[] = ['community', 'dir', 'file']

/**
 * 客户端一屏的卡片数（点「更多」每次追加这么多）。
 *
 * 为什么要客户端分页：服务端一层最多回 500 条（`symbol_count` 降序），
 * 本仓实测社区层可达数百——一次把 500 张卡片铺进 DOM 是没必要的重活。
 * 这只是**渲染**分页，不产生请求（口径见文件头注 3）。
 */
export const EXPLORE_PAGE = 60

/** 面包屑的一段 = 「用哪一层的聚合、以谁为 parent」。 */
export interface Crumb {
  level: RollupLevel
  parent: string | null
  /** 合成 id 对应的**人可读名**（社区名 / 目录路径 / 文件路径） */
  label: string
}

/**
 * 根面包屑：`label` 空串 = 渲染时回落 `t('graph.explore.root')`。
 *
 * 不在这里存文案：文案随语言切换要跟着变，而 `Crumb` 是组件 state（存了就是陈旧快照）。
 * 可下钻节点的 label 由服务端保证非空（后端 `communityLabel` / `labelOf` 都做了回落），
 * 故 `''` 只可能是这一处根节点。
 */
export const EXPLORE_ROOT: Crumb = { level: 'community', parent: null, label: '' }

/** 下一层；`null` = 已到最深（`symbol` 的出口是切到查询态，不是再下钻）。 */
export function drillTarget(level: RollupLevel): RollupLevel | null {
  switch (level) {
    case 'community':
      return 'dir'
    case 'dir':
      return 'file'
    case 'file':
      return 'symbol'
    case 'symbol':
      return null
  }
}

/**
 * 点一个卡片：把「下一层 + 该节点的合成 id + 它的名字」压进路径。
 *
 * 返回**新数组**（不改入参）；已到最深（当前层是 `symbol`）返回原数组——
 * 调用方据此不再改 state（空操作不会触发重渲染）。
 * `label` 用节点的 `label`：`file` 卡片这一路走到符号列表时，标题要显示文件路径。
 */
export function pushCrumb(path: readonly Crumb[], current: RollupLevel, node: { id: string; label: string }): readonly Crumb[] {
  const next = drillTarget(current)
  if (next === null) return path
  return [...path, { level: next, parent: node.id, label: node.label }]
}

/**
 * 面包屑回退到第 `index` 段（点哪段回哪段）。
 *
 * 越界一律夹到合法区间：`index < 0` → 根；`index >= length` → 原样（末段本就是当前层，
 * 点它不该有任何变化）。夹取而不是抛，是因为调用方是用户点击。
 */
export function popTo(path: readonly Crumb[], index: number): readonly Crumb[] {
  const at = Math.min(Math.max(index, 0), path.length - 1)
  return path.slice(0, at + 1)
}

/** 当前层 = 路径末段。空路径按根处理（`useExplore` 的派生路径不会是空数组，防御而已）。 */
export function currentCrumb(path: readonly Crumb[]): Crumb {
  return path[path.length - 1] ?? EXPLORE_ROOT
}

/**
 * 缓存键：**带项目**，故换项目不必清缓存也不会串台（同名社区/路径在不同项目里是不同的东西）。
 * `community` 层的 parent 恒 `null`，键里不带 parent 段。
 */
export function cacheKey(project: string, level: RollupLevel, parent: string | null): string {
  return level === 'community' ? `${project}|community` : `${project}|${level}|${parent ?? ''}`
}

/** 单个节点的跨组边强度（后端只统计 calls 族，见 `rollup.ts` 的 `CALL_FAMILY_RELATIONS`）。 */
export interface EdgeTotal {
  /** 指向该节点的边条数（别处调用它） */
  in: number
  /** 从该节点发出的边条数（它调用别处） */
  out: number
}

/**
 * 把 `edges` 归集到节点上（**出/入分开**）。
 *
 * 只出现在返回节点集内的边才在 `edges` 里（后端 `finalize` 已滤掉悬挂边），
 * 故这里不必再判端点是否存在；仍用 `??` 兜底是为了不让一条畸形边把整层计数带崩。
 */
export function edgeTotals(edges: readonly RollupEdge[]): Map<string, EdgeTotal> {
  const out = new Map<string, EdgeTotal>()
  const bump = (id: string, side: 'in' | 'out'): void => {
    const hit = out.get(id)
    if (hit === undefined) out.set(id, { in: side === 'in' ? 1 : 0, out: side === 'out' ? 1 : 0 })
    else hit[side] += 1
  }
  for (const edge of edges) {
    bump(edge.from, 'out')
    bump(edge.to, 'in')
  }
  return out
}

/** 本层最强的一组跨组边（给卡片上的强度数字一把尺子；空表为 0）。 */
export function maxEdgeWeight(edges: readonly RollupEdge[]): number {
  return edges.reduce((max, edge) => (edge.weight > max ? edge.weight : max), 0)
}

/**
 * 客户端分页：取前 `shown` 条（负数/NaN 归零，超长按全长）。
 *
 * 只切**已取回**的数据，**不触发请求**——服务端没有分页参数，`truncated` 的余量
 * 取不回来（见文件头注口径 3）。
 */
export function pageOf<T>(items: readonly T[], shown: number): readonly T[] {
  const n = Number.isFinite(shown) ? Math.max(0, Math.floor(shown)) : 0
  return items.slice(0, n)
}
