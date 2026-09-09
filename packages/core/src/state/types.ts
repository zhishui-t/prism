/** 任务状态枚举（14 态，吸收自 Weave 任务状态机 TDD 2.1.1）。 */
export type TaskStatus =
  | 'WAITING'
  | 'BLOCKED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'AWAITING_FEEDBACK'
  | 'REVISION_RUNNING'
  | 'CLOSED'
  | 'FAILED'
  | 'BANNED'
  | 'LOOP_TERMINATED'
  | 'INTERRUPTED'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'COOLDOWN'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'WAITING',
  'BLOCKED',
  'RUNNING',
  'COMPLETED',
  'AWAITING_FEEDBACK',
  'REVISION_RUNNING',
  'CLOSED',
  'FAILED',
  'BANNED',
  'LOOP_TERMINATED',
  'INTERRUPTED',
  'CANCELLED',
  'SKIPPED',
  'COOLDOWN',
]

/** 任务记录（与 tasks 表列一一对应）。 */
export interface TaskRecord {
  id: string
  dag_id: string
  session_id: string
  team_id: string
  project_id: string
  version: string
  description: string
  stage: string
  dependencies: string[]
  /** 写域前缀（advisory：与执行中任务重叠时调度器只警告不阻断）。 */
  write_scopes: string[]
  /** 乐观并发版本号：治理写入与 attempt 写回每次 +1。 */
  revision: number
  /** attempt 句柄：claim(RUNNING) 签发 UUID，重派/取消/恢复时作废。 */
  attempt_token: string | null
  assigned_agent: string | null
  executor: string | null
  status: TaskStatus
  revision_count: number
  max_revisions: number
  feedback_timeout_seconds: number
  feedback_expires_at: string | null
  skip_override: boolean
  skip_reason: string | null
  fail_count: number
  result: string | null
  error_type: string | null
  created_at: string
  updated_at: string
}

/** DAG 边。 */
export interface TaskEdge {
  from: string
  to: string
}

/** 任务依赖图。 */
export interface TaskDag {
  dag_id: string
  tasks: TaskRecord[]
  edges: TaskEdge[]
  status: 'created' | 'running' | 'completed' | 'failed'
}
