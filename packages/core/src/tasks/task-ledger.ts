/**
 * 任务台账服务（task-center.md）：**被动台账**——执行方回报状态，Prism 只记录、可视化、审计。
 *
 * | 做 | 不做 |
 * | :--- | :--- |
 * | 记录任务与依赖 | 不派发任务 |
 * | 可视化依赖图 | 不决定串并行 |
 * | 记录状态变更 | 不主动推进状态 |
 * | 审计留痕 | 不重试/取消（除非显式调用） |
 *
 * 写路径全部经 SingleWriterQueue + 事务；状态变更由 TaskStateMachine 判定合法性，
 * revision 乐观并发（回报须带 expected_revision），审计写 task.status_changed。
 */
import { randomUUID } from 'node:crypto'

import type { AuditLog } from '../audit/audit-log.js'
import type { PrismPersistence } from '../persistence/persistence.js'
import { PrismError } from '../state/errors.js'
import { TaskStateMachine } from '../state/task-state-machine.js'
import { TASK_STATUSES, type TaskStatus } from '../state/types.js'

/** 登记单个任务的输入。 */
export interface TaskRegisterItem {
  id: string
  description: string
  /** 依赖的任务 id（同 DAG 内） */
  depends_on?: string[]
  /** 写域前缀（advisory 冲突提醒，不阻断） */
  write_scopes?: string[]
  assigned_agent?: string
  executor?: string
  stage?: string
  /** 初始状态，默认 WAITING */
  status?: TaskStatus
}

/** 批量登记 DAG 的输入。 */
export interface DagRegisterInput {
  dag_id: string
  session_id: string
  team_id: string
  project_id: string
  version: string
  difficulty: string
  tasks: TaskRegisterItem[]
}

/** 状态回报输入。 */
export interface TaskReportInput {
  task_id: string
  /** 执行方声明的当前状态（乐观并发：与库内不符则拒绝） */
  from_status?: TaskStatus
  to_status: TaskStatus
  /** 回报者标识（审计用） */
  by: string
  /** 期望 revision（乐观并发守卫）；不传则不做并发校验 */
  expected_revision?: number
  result?: unknown
  error_type?: string
}

export interface TaskLedgerOptions {
  persistence: PrismPersistence
  audit?: AuditLog
  now?: () => Date
}

interface TaskRow {
  id: string
  dag_id: string
  session_id: string
  team_id: string
  project_id: string
  version: string
  description: string
  stage: string
  dependencies: string
  write_scopes: string
  revision: number
  attempt_token: string | null
  assigned_agent: string | null
  executor: string | null
  status: string
  revision_count: number
  max_revisions: number
  feedback_timeout_seconds: number
  feedback_expires_at: string | null
  skip_override: number
  skip_reason: string | null
  fail_count: number
  result: string | null
  error_type: string | null
  created_at: string
  updated_at: string
}

const TASK_COLUMNS = `id, dag_id, session_id, team_id, project_id, version, description, stage,
  dependencies, write_scopes, revision, attempt_token, assigned_agent, executor, status,
  revision_count, max_revisions, feedback_timeout_seconds, feedback_expires_at, skip_override,
  skip_reason, fail_count, result, error_type, created_at, updated_at`

/** 任务台账（被动记录 + 状态回报）。 */
export class TaskLedger {
  readonly #persistence: PrismPersistence
  readonly #audit: AuditLog | undefined
  readonly #now: () => Date

  constructor(options: TaskLedgerOptions) {
    this.#persistence = options.persistence
    this.#audit = options.audit
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * 批量登记 DAG（§4.1）：被动记录，不触发执行。
   * 校验：dag_id 不重复（幂等）、任务 id 唯一、depends_on 必须同 DAG 内存在、无环。
   */
  async registerDag(input: DagRegisterInput): Promise<{ dag_id: string; tasks: number; edges: number }> {
    for (const field of ['dag_id', 'session_id', 'team_id', 'project_id', 'version', 'difficulty'] as const) {
      const value = input[field]
      if (typeof value !== 'string' || value.trim() === '') {
        throw new PrismError('bad_request', `registerDag 缺少必填字段: ${field}`)
      }
    }
    if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
      throw new PrismError('bad_request', 'registerDag 需要至少一个 task')
    }
    const ids = new Set<string>()
    for (const task of input.tasks) {
      if (typeof task.id !== 'string' || task.id.trim() === '') {
        throw new PrismError('bad_request', 'task.id 必填')
      }
      if (typeof task.description !== 'string' || task.description.trim() === '') {
        throw new PrismError('bad_request', `task.description 必填: ${task.id}`)
      }
      if (ids.has(task.id)) {
        throw new PrismError('bad_request', `任务 id 重复: ${task.id}`)
      }
      ids.add(task.id)
      if (task.status !== undefined && !TASK_STATUSES.includes(task.status)) {
        throw new PrismError('bad_request', `非法任务状态: ${String(task.status)}`, {
          allowed: TASK_STATUSES,
        })
      }
    }
    // 依赖必须指向同批任务
    for (const task of input.tasks) {
      for (const dep of task.depends_on ?? []) {
        if (!ids.has(dep)) {
          throw new PrismError('bad_request', `依赖的任务不在本批登记中: ${dep}（任务 ${task.id}）`)
        }
        if (dep === task.id) {
          throw new PrismError('bad_request', `任务不能依赖自己: ${task.id}`)
        }
      }
    }
    this.#assertAcyclic(input.tasks)

    const nowIso = this.#now().toISOString()
    return await this.#persistence.tasks.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const existing = raw.prepare('SELECT dag_id FROM dags WHERE dag_id = ?').get(input.dag_id)
        if (existing !== undefined) {
          // 幂等：已登记则原样返回计数，不重复写
          const count = (raw.prepare('SELECT COUNT(*) AS c FROM tasks WHERE dag_id = ?').get(input.dag_id) as { c: number }).c
          const edges = (raw.prepare('SELECT COUNT(*) AS c FROM edges WHERE dag_id = ?').get(input.dag_id) as { c: number }).c
          raw.exec('COMMIT')
          return { dag_id: input.dag_id, tasks: count, edges }
        }
        raw
          .prepare(
            `INSERT INTO dags (dag_id, team_id, project_id, version, difficulty, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`,
          )
          .run(input.dag_id, input.team_id, input.project_id, input.version, input.difficulty, nowIso, nowIso)

        const insertTask = raw.prepare(
          `INSERT INTO tasks (id, dag_id, session_id, team_id, project_id, version, description, stage,
             dependencies, write_scopes, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        const insertEdge = raw.prepare(
          'INSERT OR IGNORE INTO edges (dag_id, from_task_id, to_task_id) VALUES (?, ?, ?)',
        )
        let edges = 0
        for (const task of input.tasks) {
          insertTask.run(
            task.id,
            input.dag_id,
            input.session_id,
            input.team_id,
            input.project_id,
            input.version,
            task.description,
            task.stage ?? '',
            JSON.stringify(task.depends_on ?? []),
            JSON.stringify(task.write_scopes ?? []),
            task.status ?? 'WAITING',
            nowIso,
            nowIso,
          )
          for (const dep of task.depends_on ?? []) {
            const info = insertEdge.run(input.dag_id, dep, task.id)
            edges += Number(info.changes)
          }
        }
        raw.exec('COMMIT')
        return { dag_id: input.dag_id, tasks: input.tasks.length, edges }
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          // 事务已终止时忽略
        }
        throw error
      }
    })
  }

  /**
   * 状态回报（§4）：状态机判定合法 + 乐观并发 + 审计。
   * 非法转移 → invalid_status_transition；from/revision 不符 → task_stale_revision。
   */
  async report(input: TaskReportInput): Promise<TaskRow> {
    if (typeof input.by !== 'string' || input.by.trim() === '') {
      throw new PrismError('bad_request', 'report 需要 by（回报者标识）')
    }
    if (!TASK_STATUSES.includes(input.to_status)) {
      throw new PrismError('bad_request', `非法任务状态: ${String(input.to_status)}`, {
        allowed: TASK_STATUSES,
      })
    }
    const row = this.#requireTask(input.task_id)
    const from = row.status as TaskStatus
    if (input.from_status !== undefined && input.from_status !== from) {
      throw new PrismError(
        'task_stale_revision',
        `from_status 与台账不符（可能已被他人推进）: 期望 ${input.from_status}，实际 ${from}`,
        { task_id: input.task_id, actual: from },
      )
    }
    // 状态机判定（非法转移直接拒绝，不落库）
    TaskStateMachine.transition(from, input.to_status)
    if (input.expected_revision !== undefined && input.expected_revision !== row.revision) {
      throw new PrismError(
        'task_stale_revision',
        `revision 不符（可能已被他人推进）: 期望 ${input.expected_revision}，实际 ${row.revision}`,
        { task_id: input.task_id, actual: row.revision },
      )
    }

    const nowIso = this.#now().toISOString()
    const resultText = input.result === undefined ? row.result : JSON.stringify(input.result)
    const changes = await this.#persistence.tasks.run((raw) =>
      Number(
        raw
          .prepare(
            `UPDATE tasks
             SET status = ?, result = ?, error_type = ?, revision = revision + 1, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(input.to_status, resultText, input.error_type ?? row.error_type, nowIso, input.task_id, row.revision)
          .changes,
      ),
    )
    if (changes === 0) {
      throw new PrismError('task_stale_revision', `状态回报并发冲突: ${input.task_id}`)
    }
    await this.#audit?.record({
      type: 'task.status_changed',
      task_id: input.task_id,
      from,
      to: input.to_status,
      by: input.by,
    })

    // 派生规则（task-center.md §3，此前只有测试调用、生产断链）：
    // FAILED/CANCELLED → 下游 WAITING/BLOCKED 级联 SKIPPED；
    // SKIPPED 的上游恢复 WAITING（人工重开场景）→ SKIPPED 重激活为 WAITING。
    if (input.to_status === 'FAILED' || input.to_status === 'CANCELLED') {
      await this.#propagateFailure(row.dag_id, input.task_id, input.by)
    } else {
      // 离开失败终态（如 FAILED → WAITING 人工重开）→ 尝试重激活下游 SKIPPED。
      // 状态机自行判定「依赖是否已全部就绪」，不满足时无操作。
      const fromWasTerminalFailure = from === 'FAILED' || from === 'CANCELLED' || from === 'BANNED'
      if (fromWasTerminalFailure) {
        await this.#reactivateSkipped(row.dag_id, input.task_id, input.by)
      }
    }
    return this.#requireTask(input.task_id)
  }

  /** 装配当前 DAG 快照（状态机派生函数的输入形状：tasks + edges + skip_override）。 */
  #loadDagSnapshot(dagId: string): {
    tasks: Array<{ id: string; dependencies: string[]; status: string; skip_override?: boolean }>
    edges: Array<{ from: string; to: string }>
  } {
    const raw = this.#persistence.tasks.raw
    const tasks = raw
      .prepare('SELECT id, status, dependencies, skip_override FROM tasks WHERE dag_id = ?')
      .all(dagId) as Array<{ id: string; status: string; dependencies: string; skip_override: number }>
    const edges = raw
      .prepare('SELECT from_task_id, to_task_id FROM edges WHERE dag_id = ?')
      .all(dagId) as Array<{ from_task_id: string; to_task_id: string }>
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        skip_override: t.skip_override === 1,
        dependencies: ((): string[] => {
          try {
            const parsed = JSON.parse(t.dependencies) as unknown
            return Array.isArray(parsed) ? parsed.map(String) : []
          } catch {
            return []
          }
        })(),
      })),
      edges: edges.map((e) => ({ from: e.from_task_id, to: e.to_task_id })),
    }
  }

  /** 失败传播：下游 WAITING/BLOCKED → SKIPPED（写库 + 逐条审计）。 */
  async #propagateFailure(dagId: string, failedTaskId: string, by: string): Promise<string[]> {
    const dag = this.#loadDagSnapshot(dagId) as Parameters<typeof TaskStateMachine.propagateFailure>[0]
    const result = TaskStateMachine.propagateFailure(dag, failedTaskId)
    if (result.skipped.length === 0) return []
    const raw = this.#persistence.tasks.raw
    const nowIso = this.#now().toISOString()
    for (const id of result.skipped) {
      raw
        .prepare(`UPDATE tasks SET status = 'SKIPPED', revision = revision + 1, updated_at = ? WHERE id = ? AND status IN ('WAITING','BLOCKED')`)
        .run(nowIso, id)
      await this.#audit?.record({
        type: 'task.status_changed',
        task_id: id,
        from: 'WAITING',
        to: 'SKIPPED',
        by,
      })
    }
    return result.skipped
  }

  /** SKIPPED 重激活：恢复为 WAITING（上游被人工重开时）。 */
  async #reactivateSkipped(dagId: string, upstreamTaskId: string, by: string): Promise<string[]> {
    const dag = this.#loadDagSnapshot(dagId) as Parameters<typeof TaskStateMachine.reactivateSkipped>[0]
    const result = TaskStateMachine.reactivateSkipped(dag, upstreamTaskId)
    if (result.reactivated.length === 0) return []
    const raw = this.#persistence.tasks.raw
    const nowIso = this.#now().toISOString()
    for (const id of result.reactivated) {
      raw
        .prepare(`UPDATE tasks SET status = 'WAITING', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'SKIPPED'`)
        .run(nowIso, id)
      await this.#audit?.record({
        type: 'task.status_changed',
        task_id: id,
        from: 'SKIPPED',
        to: 'WAITING',
        by,
      })
    }
    return result.reactivated
  }

  /** 取单任务；不存在 → not_found。 */
  get(id: string): TaskRow {
    return this.#requireTask(id)
  }

  /** 任务列表（可按 dag_id / status / session_id 过滤）。 */
  list(query: { dag_id?: string; status?: TaskStatus; session_id?: string; limit?: number } = {}): TaskRow[] {
    const conds: string[] = []
    const params: Array<string | number> = []
    if (query.dag_id !== undefined) {
      conds.push('dag_id = ?')
      params.push(query.dag_id)
    }
    if (query.status !== undefined) {
      conds.push('status = ?')
      params.push(query.status)
    }
    if (query.session_id !== undefined) {
      conds.push('session_id = ?')
      params.push(query.session_id)
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 500)), 2000)
    return this.#persistence.tasks.raw
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks ${where} ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`)
      .all(...params, limit) as unknown as TaskRow[]
  }

  /** 依赖图（§5）：任务 + 边，供可视化。 */
  dag(dagId: string): { dag_id: string; status: string; tasks: TaskRow[]; edges: Array<{ from: string; to: string }> } {
    const dag = this.#persistence.tasks.raw
      .prepare('SELECT dag_id, status FROM dags WHERE dag_id = ?')
      .get(dagId) as { dag_id: string; status: string } | undefined
    if (dag === undefined) {
      throw new PrismError('not_found', `DAG 不存在: ${dagId}`)
    }
    const tasks = this.#persistence.tasks.raw
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE dag_id = ? ORDER BY id`)
      .all(dagId) as unknown as TaskRow[]
    const edges = this.#persistence.tasks.raw
      .prepare('SELECT from_task_id AS "from", to_task_id AS "to" FROM edges WHERE dag_id = ? ORDER BY from_task_id, to_task_id')
      .all(dagId) as Array<{ from: string; to: string }>
    return { dag_id: dag.dag_id, status: dag.status, tasks, edges }
  }

  /** 台账统计（按状态计数）。 */
  stats(): { total: number; by_status: Record<string, number>; dags: number } {
    const raw = this.#persistence.tasks.raw
    const rows = raw.prepare('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status').all() as Array<{
      status: string
      c: number
    }>
    const byStatus: Record<string, number> = {}
    for (const row of rows) byStatus[row.status] = row.c
    const total = rows.reduce((sum, row) => sum + row.c, 0)
    const dags = (raw.prepare('SELECT COUNT(*) AS c FROM dags').get() as { c: number }).c
    return { total, by_status: byStatus, dags }
  }

  #requireTask(id: string): TaskRow {
    const row = this.#persistence.tasks.raw
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id) as unknown as TaskRow | undefined
    if (row === undefined) {
      throw new PrismError('not_found', `任务不存在: ${id}`)
    }
    return row
  }

  /** 依赖环检测（Kahn 拓扑排序；有环抛 bad_request）。 */
  #assertAcyclic(tasks: TaskRegisterItem[]): void {
    // 入度 = 该任务自己的依赖数；出边 dep → 依赖它的任务
    const indegree = new Map<string, number>()
    const children = new Map<string, string[]>()
    for (const task of tasks) {
      indegree.set(task.id, (task.depends_on ?? []).length)
      for (const dep of task.depends_on ?? []) {
        if (!children.has(dep)) children.set(dep, [])
        children.get(dep)!.push(task.id)
      }
    }
    const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id)
    let visited = 0
    while (queue.length > 0) {
      const cur = queue.shift()!
      visited++
      for (const child of children.get(cur) ?? []) {
        const next = (indegree.get(child) ?? 0) - 1
        indegree.set(child, next)
        if (next === 0) queue.push(child)
      }
    }
    if (visited !== tasks.length) {
      throw new PrismError('bad_request', '任务依赖存在环')
    }
  }
}

/** 便捷工厂。 */
export function createTaskLedger(options: TaskLedgerOptions): TaskLedger {
  return new TaskLedger(options)
}

/** 生成任务 id（供调用方复用；格式 task-<uuid 前 8 位>）。 */
export function newTaskId(): string {
  return `task-${randomUUID().slice(0, 8)}`
}
