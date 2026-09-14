/**
 * Prism 任务状态机 → archify `lifecycle` IR。
 *
 * **纯函数**：零 IO、零时钟、零随机（红线 R7）。数据源是 `@prism/core` 的
 * `TASK_TRANSITIONS`（32 条权威矩阵）与 `DERIVED_TRANSITIONS`（4 条派生转移），
 * 二者都是编译期常量——所以这张图**永远不会与代码脱节**：改了状态机，
 * 重新生成即可，不需要去改 JSON。
 *
 * ## ⚠️ 先读这段：lifecycle 的布局不是「4 泳道 × 5 列」网格
 *
 * 实测 `renderers/lifecycle/render-lifecycle.mjs`：**泳道 id 决定的是「带」（band），不是行**——
 *
 * ```
 * bandFor(lane): 'main' → phase（顶部相带）; 'terminal' → outcome（底部终态带）;
 *                其余任意泳道 → event（中间事件带，全部挤在同一条带上）
 * ```
 *
 * 且每带的列坐标是**写死的**：
 * - `phaseXs   = [94, 248, 402, 556, 710]`（5 列）
 * - `eventXs   = [402, 556, 710]`（**只有 3 列**）
 * - `outcomeXs = [402, 556, 710]`（**只有 3 列**）
 *
 * 所以容量是 5 + 3 + 3 = 11，而任务状态机有 **14** 个状态 —— 必须靠
 * `yOffset` 在同一格里**竖着叠第二排**才放得下。别的路都走不通：
 * - 把多个状态塞进同一 `(band, col)` 且不设 `yOffset` → 坐标重合，
 *   渲染器直接报「less than 10px apart」，转移的走线也随之错乱；
 * - 多加泳道没用 —— 除 `main`/`terminal` 外的泳道**共用同一个 event 带**。
 *
 * 另外底部有硬边界：`state.y + height <= viewBox[1] - 122`，所以要叠第二排就得
 * **自己抬高 `meta.viewBox`**（默认 660 只够一排）。本文件用 `[980, 840]`。
 *
 * ## 为什么必须自己布线（`router.ts`）
 *
 * 几何定下来之后，36 条转移的**走线**才是真正的难关。archify 的自动布线在
 * 这个密度下几乎全数违反 `clean-flow/edge-through-node`（连线穿过无关状态）——
 * 实测首版 36 条里 50 条次穿节点。archify 给的替代手段 `channelX`/`channelY` **不是
 * 避让指令**（实测命名通道照样穿），唯一可行的是自给 `via` 路径点，于是有了
 * `./router.ts`：枚举 16 种「出口侧 × 入口侧」，本地碰撞检测后取最优正交路径。
 *
 * 附带一个额外好处：`render-lifecycle.mjs` 的 `shouldCheckRelation` 是
 * `!Array.isArray(via)` —— **给了 `via` 就跳过 `endpoint-side-direction` 校验**，
 * 所以布线器只需保证「不穿节点」，不必再迁就侧向契约（不过它照样按侧向布线，
 * 线更好看，换个渲染器也不会被拒）。
 *
 * 布线器内部是 Hanan 网格 + Dijkstra（折点优先、长度次之），16 种侧组合里择优。
 * 真的无解时才**丢弃该边**（宁缺毋滥），并把条数写进 `meta.subtitle` 声明——
 * 静默少画一条状态机的边等于谎报状态机。
 *
 * ## 落格表（见 `TASK_LIFECYCLE_CELLS`）
 *
 * | 带 | 泳道 | col 0 | col 1 | col 2 | col 3 | col 4 |
 * | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
 * | phase（上） | `main` | WAITING | RUNNING | COMPLETED | AWAITING_FEEDBACK | CLOSED |
 * | event（中） | `event` | BLOCKED | REVISION_RUNNING | INTERRUPTED | — | — |
 * | outcome 第一排 | `terminal` | FAILED | BANNED | LOOP_TERMINATED | — | — |
 * | outcome 第二排 | `terminal` | COOLDOWN | CANCELLED | SKIPPED | — | — |
 *
 * 口径依据：顶部相带走**主流程**（等待 → 执行 → 完成 → 待反馈 → 关闭）；
 * 中间带放**打断主流、但可能回到主流**的状态（阻塞 / 改稿 / 中断）；
 * 底部终态带放**终局**（失败、熔断、循环终止、取消、跳过、冷却）。
 * `COOLDOWN` 归终态带而非主流程——它只能由 `BANNED` 进入（熔断冷却）。
 *
 * ## 边的口径
 *
 * - 32 条**权威矩阵**转移 → 实线；
 * - 4 条 `DERIVED_TRANSITIONS`（失败传播 / SKIPPED 重激活）→ **虚线**，
 *   并在 `meta.subtitle` 里声明「只由系统派生函数产生，`report` 不接受」——
 *   这是 `task-state-machine.ts` 里写死的语义差别，图上不能混为一谈。
 */

import { DERIVED_TRANSITIONS, TASK_STATUSES, TASK_TRANSITIONS, type TaskStatus } from '@prism/core'

import { freeTracks, planRoute, type RouterBox, type RouterSide } from './router.js'
import { allocateId, fitUnits } from './text.js'
import type { ArchifyMeta } from './types.js'

/** archify `lifecycle.schema.json` 的 `states[].type` 枚举。 */
export type LifecycleStateType =
  | 'start'
  | 'active'
  | 'waiting'
  | 'decision'
  | 'success'
  | 'failure'
  | 'neutral'
  | 'external'

export interface LifecycleIrLane {
  id: string
  label: string
}

export interface LifecycleIrState {
  id: string
  type: LifecycleStateType
  label: string
  sublabel?: string
  tag?: string
  step?: string
  lane: string
  col: number
  yOffset?: number
}

export interface LifecycleIrTransition {
  from: string
  to: string
  variant?: 'default' | 'emphasis' | 'security' | 'dashed' | 'return'
  /** 出口侧（`router.ts` 算出，非手写） */
  fromSide?: RouterSide
  /** 入口侧 */
  toSide?: RouterSide
  /** 正交路径的**中间**折点（首末点由渲染器按侧取锚点，重复给会被判成零长线段） */
  via?: Array<[number, number]>
  route?: 'straight'
}

export interface LifecycleIr {
  schema_version: 1
  diagram_type: 'lifecycle'
  meta: ArchifyMeta & { viewBox?: [number, number] }
  lanes: LifecycleIrLane[]
  states: LifecycleIrState[]
  transitions: LifecycleIrTransition[]
}

/**
 * 泳道（= 带）。三个就够：`main` / `terminal` 是保留 id（渲染器按 id 定带），
 * 其余泳道一律落中间事件带，所以**加泳道不会加容量**。
 */
const LANES: readonly LifecycleIrLane[] = [
  { id: 'main', label: '主流程' },
  { id: 'event', label: '中断与修订' },
  { id: 'terminal', label: '终态' },
]

interface Cell {
  lane: string
  col: number
  /** 同格第二排：event/outcome 带各只有 3 列，14 态必须叠排 */
  yOffset: number
  type: LifecycleStateType
  label: string
  tag: string
}

/**
 * `render-lifecycle.mjs` 的 `layout` 常量（**必须逐字复刻**）。
 *
 * 这些值决定了每个状态的矩形；布线器要先知道盒子在哪，才能算避让路径。
 * 渲染器不接受坐标输入（只有 `lane`/`col`/`yOffset`），所以除此之外没有别的办法。
 */
const LC_GEOM = {
  phaseY: 126,
  eventY: 278,
  outcomeY: 450,
  phaseW: 118,
  phaseH: 62,
  eventW: 126,
  eventH: 58,
  outcomeW: 118,
  outcomeH: 58,
  phaseXs: [94, 248, 402, 556, 710],
  eventXs: [402, 556, 710],
  outcomeXs: [402, 556, 710],
} as const

/** 泳道 → 带。除 `main`（相带）/ `terminal`（终态带）外，**所有泳道共用 event 带**。 */
function bandOf(lane: string): 'phase' | 'event' | 'outcome' {
  if (lane === 'main') return 'phase'
  if (lane === 'terminal') return 'outcome'
  return 'event'
}

/** 落格 → 矩形（与 `measureState` 同口径；盒子越界由渲染器照常报错，这里不兜底）。 */
function stateBox(cell: Cell): RouterBox {
  const band = bandOf(cell.lane)
  const xs = band === 'phase' ? LC_GEOM.phaseXs : band === 'outcome' ? LC_GEOM.outcomeXs : LC_GEOM.eventXs
  const width = band === 'phase' ? LC_GEOM.phaseW : band === 'outcome' ? LC_GEOM.outcomeW : LC_GEOM.eventW
  const height = band === 'phase' ? LC_GEOM.phaseH : band === 'outcome' ? LC_GEOM.outcomeH : LC_GEOM.eventH
  const cx = xs[cell.col] ?? xs[xs.length - 1]!
  const y =
    (band === 'phase' ? LC_GEOM.phaseY : band === 'outcome' ? LC_GEOM.outcomeY : LC_GEOM.eventY) +
    cell.yOffset
  return { x0: cx - width / 2, x1: cx + width / 2, y0: y, y1: y + height }
}

/**
 * 14 态的落格表（`TASK_STATUSES` 的每一项都必须在这里，缺项即测试失败）。
 *
 * 这是唯一的口径来源——改布局只改这张表，`buildTaskLifecycleIr` 不含任何硬编码坐标。
 * 约束见文件头：`main` 带 5 列、`event`/`terminal` 带各 3 列，容量不足处用第二排
 * （`yOffset = 96`）。
 *
 * **为什么是 96 不是 86**：终态带第一排底边 `450 + 58 = 508`，第二排顶边 `450 +
 * yOffset`。渲染器要求转移两端锚点距离 ≥ 32px，而同列上下两个终态（如
 * `loop_terminated → skipped`）的最短通路就是这两个锚点之间——`yOffset = 86`
 * 只给出 28px，直接被判 `too short`。96 给出 38px，稳过 32px 闸门。
 */
export const TASK_LIFECYCLE_CELLS: Readonly<Record<TaskStatus, Cell>> = {
  // —— 顶部相带：主流程 ——
  WAITING: { lane: 'main', col: 0, yOffset: 0, type: 'waiting', label: '等待', tag: '待命' },
  RUNNING: { lane: 'main', col: 1, yOffset: 0, type: 'active', label: '执行中', tag: '执行' },
  COMPLETED: { lane: 'main', col: 2, yOffset: 0, type: 'success', label: '已完成', tag: '交付' },
  AWAITING_FEEDBACK: { lane: 'main', col: 3, yOffset: 0, type: 'decision', label: '待反馈', tag: '交付' },
  CLOSED: { lane: 'main', col: 4, yOffset: 0, type: 'success', label: '已关闭', tag: '终态' },
  // —— 中间事件带：打断主流但可能回流 ——
  BLOCKED: { lane: 'event', col: 0, yOffset: 0, type: 'waiting', label: '阻塞', tag: '等待' },
  REVISION_RUNNING: { lane: 'event', col: 1, yOffset: 0, type: 'active', label: '修订中', tag: '修订' },
  INTERRUPTED: { lane: 'event', col: 2, yOffset: 0, type: 'failure', label: '中断', tag: '中断' },
  // —— 底部终态带第一排 ——
  FAILED: { lane: 'terminal', col: 0, yOffset: 0, type: 'failure', label: '失败', tag: '失败' },
  BANNED: { lane: 'terminal', col: 1, yOffset: 0, type: 'failure', label: '熔断', tag: '失败' },
  LOOP_TERMINATED: { lane: 'terminal', col: 2, yOffset: 0, type: 'failure', label: '循环终止', tag: '失败' },
  // —— 底部终态带第二排 ——
  COOLDOWN: { lane: 'terminal', col: 0, yOffset: 96, type: 'waiting', label: '冷却', tag: '恢复' },
  CANCELLED: { lane: 'terminal', col: 1, yOffset: 96, type: 'neutral', label: '已取消', tag: '终态' },
  SKIPPED: { lane: 'terminal', col: 2, yOffset: 96, type: 'neutral', label: '已跳过', tag: '终态' },
}

/**
 * `meta.viewBox`。
 *
 * 默认 660 只够一排终态（底部硬边界 = `viewBox[1] - 122`），第二排会被判越界，
 * 故显式抬高到 840：`840 - 122 = 718`，第二排底边 594 留有余量。
 * 宽度沿用官方示例的 980（5 列相带的最右节点右边缘 769 < 980-32）。
 */
const VIEW_BOX: [number, number] = [980, 840]

/** 状态文本上限（phase 宽 118 / event·outcome 宽 126，口径 `textUnits*6.2 <= 宽+6`）。 */
const LIFE_TEXT = { label: 16, sublabel: 18, tag: 8 } as const

export interface LifecycleIrOptions {
  title?: string
  /** 是否带上 4 条派生转移（虚线）；默认 true */
  includeDerived?: boolean
}

/**
 * 任务状态机 → `lifecycle` IR。
 *
 * @throws Error 落格表缺项或 id 不合法时抛出（内部错误——说明表与 `TASK_STATUSES` 脱节了，
 *   必须显式失败而不是产出缺状态的图）。
 */
export function buildTaskLifecycleIr(options: LifecycleIrOptions = {}): LifecycleIr {
  const used = new Set<string>()
  const idByStatus = new Map<TaskStatus, string>()
  const cellById = new Map<string, Cell>()
  const states: LifecycleIrState[] = []

  TASK_STATUSES.forEach((status, index) => {
    const cell = TASK_LIFECYCLE_CELLS[status]
    if (cell === undefined) {
      throw new Error(`内部错误：任务状态 ${status} 未在 TASK_LIFECYCLE_CELLS 中落格`)
    }
    const id = allocateId(status.toLowerCase(), used, 'state')
    idByStatus.set(status, id)
    cellById.set(id, cell)
    states.push({
      id,
      type: cell.type,
      label: fitUnits(cell.label, LIFE_TEXT.label),
      // 中文名给业务读者，枚举名给要 grep 代码的人——两者都保留
      sublabel: fitUnits(status, LIFE_TEXT.sublabel),
      tag: fitUnits(cell.tag, LIFE_TEXT.tag),
      // step 按 TASK_STATUSES 的声明顺序编号（常量顺序 = 枚举声明顺序）
      step: String(index + 1).padStart(2, '0'),
      lane: cell.lane,
      col: cell.col,
      ...(cell.yOffset !== 0 ? { yOffset: cell.yOffset } : {}),
    })
  })

  const idOf = (status: TaskStatus): string => idByStatus.get(status)!

  const raw: Array<{ from: string; to: string; variant?: 'dashed' }> = TASK_TRANSITIONS.map((transition) => ({
    from: idOf(transition.from),
    to: idOf(transition.to),
  }))

  if (options.includeDerived !== false) {
    for (const transition of DERIVED_TRANSITIONS) {
      raw.push({ from: idOf(transition.from), to: idOf(transition.to), variant: 'dashed' })
    }
  }

  // 去重：权威矩阵与派生表理论上不重叠，但真重叠了也不该出重边
  const seen = new Set<string>()
  const unique = raw.filter((transition) => {
    const key = `${transition.from}\u0000${transition.to}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // —— 布线 ——
  const boxes = new Map<string, RouterBox>()
  for (const state of states) {
    boxes.set(state.id, stateBox(cellById.get(state.id)!))
  }
  const obstacles = [...boxes.values()]
  const tracks = freeTracks(obstacles, 30)

  const transitions: LifecycleIrTransition[] = []
  let unrouted = 0
  for (const transition of unique) {
    const from = boxes.get(transition.from)
    const to = boxes.get(transition.to)
    if (from === undefined || to === undefined) {
      unrouted += 1
      continue
    }
    const plan = planRoute(from, to, obstacles, tracks)
    if (plan === null) {
      unrouted += 1
      continue
    }
    transitions.push({
      from: transition.from,
      to: transition.to,
      ...(transition.variant === 'dashed' ? { variant: 'dashed' as const } : {}),
      fromSide: plan.fromSide,
      toSide: plan.toSide,
      route: plan.route,
      via: plan.via,
    })
  }

  const derivedCount = transitions.filter((transition) => transition.variant === 'dashed').length

  return {
    schema_version: 1,
    diagram_type: 'lifecycle',
    meta: {
      title: options.title ?? 'Prism 任务状态机',
      subtitle:
        `源自 @prism/core TASK_TRANSITIONS（${TASK_TRANSITIONS.length} 条权威矩阵）` +
        (derivedCount > 0
          ? ` + DERIVED_TRANSITIONS（${derivedCount} 条派生，虚线：只由传播/重激活函数产生，report 不接受）`
          : '') +
        `｜ 顶部相带 = 主流程，中间事件带 = 中断与修订，底部终态带 = 终局` +
        (unrouted > 0 ? `｜ ⚠️ ${unrouted} 条转移因无法正交避让被略去` : ''),
      viewBox: VIEW_BOX,
    },
    lanes: [...LANES],
    states,
    transitions,
  }
}
