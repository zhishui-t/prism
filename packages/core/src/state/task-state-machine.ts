import { PrismError } from './errors.js'
import type { TaskDag, TaskRecord, TaskStatus } from './types.js'

/** 失败终态：FAILED / BANNED / LOOP_TERMINATED / CANCELLED，触发下游 SKIPPED 传播。 */
export const FAILURE_TERMINALS: readonly TaskStatus[] = [
  'FAILED',
  'BANNED',
  'LOOP_TERMINATED',
  'CANCELLED',
] as const

const FAILURE_TERMINAL_SET: ReadonlySet<TaskStatus> = new Set(FAILURE_TERMINALS)

/** SKIPPED 重激活 / 失败传播的迭代保护上限。 */
export const MAX_ACTIVATION_ITERATIONS = 100

export interface StatusTransition {
  from: TaskStatus
  to: TaskStatus
}

/**
 * 32 条合法转移（权威矩阵）。
 * 失败传播（WAITING/BLOCKED→SKIPPED）与 SKIPPED 重激活为派生规则
 * （propagateFailure / reactivateSkipped），不计入本矩阵。
 */
export const TASK_TRANSITIONS: readonly StatusTransition[] = [
  // 依赖图调度
  { from: 'WAITING', to: 'BLOCKED' },
  { from: 'BLOCKED', to: 'WAITING' },
  { from: 'WAITING', to: 'RUNNING' },
  // RUNNING 结局
  { from: 'RUNNING', to: 'COMPLETED' },
  { from: 'RUNNING', to: 'FAILED' },
  { from: 'RUNNING', to: 'BANNED' },
  { from: 'RUNNING', to: 'LOOP_TERMINATED' },
  { from: 'RUNNING', to: 'INTERRUPTED' },
  { from: 'RUNNING', to: 'CANCELLED' },
  // 保温期
  { from: 'COMPLETED', to: 'AWAITING_FEEDBACK' },
  { from: 'AWAITING_FEEDBACK', to: 'REVISION_RUNNING' },
  { from: 'REVISION_RUNNING', to: 'COMPLETED' },
  { from: 'REVISION_RUNNING', to: 'FAILED' },
  { from: 'REVISION_RUNNING', to: 'CANCELLED' },
  { from: 'AWAITING_FEEDBACK', to: 'CLOSED' },
  { from: 'AWAITING_FEEDBACK', to: 'CANCELLED' },
  { from: 'CLOSED', to: 'AWAITING_FEEDBACK' },
  // 失败终态 → retry / skip / cancel
  { from: 'FAILED', to: 'WAITING' },
  { from: 'FAILED', to: 'SKIPPED' },
  { from: 'BANNED', to: 'COOLDOWN' },
  { from: 'BANNED', to: 'SKIPPED' },
  { from: 'LOOP_TERMINATED', to: 'WAITING' },
  { from: 'LOOP_TERMINATED', to: 'SKIPPED' },
  { from: 'INTERRUPTED', to: 'WAITING' },
  { from: 'INTERRUPTED', to: 'SKIPPED' },
  { from: 'INTERRUPTED', to: 'CANCELLED' },
  { from: 'CANCELLED', to: 'WAITING' },
  { from: 'CANCELLED', to: 'SKIPPED' },
  // COOLDOWN
  { from: 'COOLDOWN', to: 'WAITING' },
  { from: 'COOLDOWN', to: 'SKIPPED' },
  // 主动取消
  { from: 'WAITING', to: 'CANCELLED' },
  { from: 'BLOCKED', to: 'CANCELLED' },
]

export interface PropagationResult {
  iterations: number
  changed: number
  skipped: string[]
}

export interface ReactivationResult {
  iterations: number
  changed: number
  reactivated: string[]
}

/**
 * 任务状态机：唯一权威的转移判定 + 失败传播 / SKIPPED 重激活。
 * 纯函数式实现（不持有任务状态），便于测试与序列化。
 */
export class TaskStateMachine {
  static readonly TRANSITIONS: readonly StatusTransition[] = TASK_TRANSITIONS
  static readonly MAX_ITERATIONS = MAX_ACTIVATION_ITERATIONS

  static isFailureTerminal(status: TaskStatus): boolean {
    return FAILURE_TERMINAL_SET.has(status)
  }

  /** 该转移是否合法（32 条矩阵）。 */
  static canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return TASK_TRANSITIONS.some((t) => t.from === from && t.to === to)
  }

  /** 执行转移；非法转移抛 PrismError('invalid_status_transition')。 */
  static transition(from: TaskStatus, to: TaskStatus): TaskStatus {
    if (!TaskStateMachine.canTransition(from, to)) {
      throw new PrismError('invalid_status_transition', `不允许的任务状态转移: ${from} → ${to}`, {
        from,
        to,
      })
    }
    return to
  }

  /** 从 failedTaskId 出发向所有 WAITING/BLOCKED 下游传播 SKIPPED，迭代至无变化（上限 100）。 */
  static propagateFailure(dag: TaskDag, failedTaskId: string): PropagationResult {
    const byId = TaskStateMachine.#index(dag)
    if (!byId.has(failedTaskId)) {
      throw new PrismError('task_not_found', `任务不存在: ${failedTaskId}`, { taskId: failedTaskId })
    }

    const skipped: string[] = []
    let changed = true
    let iterations = 0
    while (changed && iterations < MAX_ACTIVATION_ITERATIONS) {
      changed = false
      iterations++
      const snapshot = new Map(dag.tasks.map((t) => [t.id, t.status]))
      for (const task of dag.tasks) {
        if (task.status !== 'WAITING' && task.status !== 'BLOCKED') continue
        const dead = task.dependencies.some((d) => {
          const s = snapshot.get(d)
          return s === 'SKIPPED' || (s !== undefined && FAILURE_TERMINAL_SET.has(s))
        })
        if (dead) {
          task.status = 'SKIPPED'
          skipped.push(task.id)
          changed = true
        }
      }
    }
    return { iterations, changed: skipped.length, skipped }
  }

  /**
   * 上游 retry/skip 后重激活其下游中非 override 的 SKIPPED 任务：
   * 依赖全部 COMPLETED/CLOSED → WAITING，否则 → BLOCKED；
   * 任一依赖仍是失败终态或 SKIPPED → 保持 SKIPPED。迭代上限 100。
   */
  static reactivateSkipped(dag: TaskDag, upstreamTaskId: string): ReactivationResult {
    const byId = TaskStateMachine.#index(dag)
    if (!byId.has(upstreamTaskId)) {
      throw new PrismError('task_not_found', `任务不存在: ${upstreamTaskId}`, {
        taskId: upstreamTaskId,
      })
    }
    const reachable = TaskStateMachine.#downstreamFrom(dag, upstreamTaskId)

    const reactivated: string[] = []
    let changed = true
    let iterations = 0
    while (changed && iterations < MAX_ACTIVATION_ITERATIONS) {
      changed = false
      iterations++
      const snapshot = new Map(dag.tasks.map((t) => [t.id, t.status]))
      for (const task of dag.tasks) {
        if (task.status !== 'SKIPPED' || task.skip_override) continue
        if (!reachable.has(task.id)) continue
        const blockedByDead = task.dependencies.some((d) => {
          const s = snapshot.get(d)
          return s === 'SKIPPED' || (s !== undefined && FAILURE_TERMINAL_SET.has(s))
        })
        if (blockedByDead) continue
        const allDone =
          task.dependencies.length === 0 ||
          task.dependencies.every((d) => {
            const s = snapshot.get(d)
            return s === 'COMPLETED' || s === 'CLOSED'
          })
        task.status = allDone ? 'WAITING' : 'BLOCKED'
        reactivated.push(task.id)
        changed = true
      }
    }
    return { iterations, changed: reactivated.length, reactivated }
  }

  /** 构建 id → TaskRecord 索引。 */
  static #index(dag: TaskDag): Map<string, TaskRecord> {
    return new Map(dag.tasks.map((t) => [t.id, t]))
  }

  /** 构建下游邻接（task.dependencies + dag.edges 的并集）。 */
  static #downstream(dag: TaskDag): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    const addEdge = (from: string, to: string) => {
      const set = out.get(from) ?? new Set<string>()
      set.add(to)
      out.set(from, set)
    }
    for (const t of dag.tasks) for (const d of t.dependencies) addEdge(d, t.id)
    for (const e of dag.edges) addEdge(e.from, e.to)
    return out
  }

  /** 从指定任务出发可达的所有下游任务（含自身）。 */
  static #downstreamFrom(dag: TaskDag, rootId: string): Set<string> {
    const downstream = TaskStateMachine.#downstream(dag)
    const reachable = new Set<string>()
    const stack = [rootId]
    while (stack.length > 0) {
      const cur = stack.pop()
      if (cur === undefined || reachable.has(cur)) continue
      reachable.add(cur)
      for (const next of downstream.get(cur) ?? []) stack.push(next)
    }
    return reachable
  }
}
