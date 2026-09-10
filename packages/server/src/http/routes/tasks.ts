import { AuditLog, openPersistence, prismPaths, PrismError, TaskLedger, type PrismPersistence, type TaskStatus } from '@prism/core'

import { fail, ok, type Envelope } from '../envelope.js'
import type { RouteContext } from '../router.js'

/**
 * 任务台账路由（task-center.md §5）：**被动台账**——执行方回报状态，Prism 只记录/可视化/审计。
 * - GET  /api/tasks              列表（dag_id/status/session_id 过滤）
 * - GET  /api/tasks/stats        台账统计
 * - GET  /api/tasks/:id          单任务
 * - GET  /api/dags/:id           依赖图（任务 + 边，供可视化）
 * - POST /api/tasks/register     批量登记 DAG（不触发执行）
 * - POST /api/tasks/report       状态回报（状态机校验 + 乐观并发）
 * 逻辑在 @prism/core TaskLedger；本层只做信封与参数解析。
 */
export function taskRoutes(home: string): {
  list: (ctx: RouteContext) => Promise<Envelope>
  get: (ctx: RouteContext) => Promise<Envelope>
  stats: (ctx: RouteContext) => Promise<Envelope>
  dag: (ctx: RouteContext) => Promise<Envelope>
  register: (ctx: RouteContext) => Promise<Envelope>
  report: (ctx: RouteContext) => Promise<Envelope>
  close: () => void
} {
  let persistence: PrismPersistence | null = null
  let ledger: TaskLedger | null = null
  const open = (): TaskLedger => {
    if (ledger === null) {
      persistence = openPersistence({ home })
      // 审计接线（此前从不传 audit → task.status_changed 从不落盘）
      ledger = new TaskLedger({
        persistence,
        audit: new AuditLog({ dir: prismPaths(home).auditDir, queue: persistence.queue }),
      })
    }
    return ledger
  }

  const list = async (ctx: RouteContext): Promise<Envelope> => {
    const dagId = ctx.query.get('dag_id')?.trim()
    const status = ctx.query.get('status')?.trim()
    const sessionId = ctx.query.get('session_id')?.trim()
    const rows = open().list({
      ...(dagId !== undefined && dagId !== '' ? { dag_id: dagId } : {}),
      ...(status !== undefined && status !== '' ? { status: status as TaskStatus } : {}),
      ...(sessionId !== undefined && sessionId !== '' ? { session_id: sessionId } : {}),
    })
    return ok(rows.map(decorate))
  }

  const get = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    try {
      return ok(decorate(open().get(id)))
    } catch (error) {
      if (isNotFound(error)) return fail('not_found', `任务不存在: ${id}`)
      throw error
    }
  }

  const stats = async (): Promise<Envelope> => ok(open().stats())

  const dag = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    try {
      const graph = open().dag(id)
      return ok({ ...graph, tasks: graph.tasks.map(decorate) })
    } catch (error) {
      if (isNotFound(error)) return fail('not_found', `DAG 不存在: ${id}`)
      throw error
    }
  }

  const register = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    for (const field of ['dag_id', 'session_id', 'team_id', 'project_id', 'version', 'difficulty'] as const) {
      requireString(body[field], field)
    }
    if (!Array.isArray(body['tasks'])) {
      throw new PrismError('bad_request', 'tasks 必须是数组')
    }
    const result = await open().registerDag({
      dag_id: String(body['dag_id']),
      session_id: String(body['session_id']),
      team_id: String(body['team_id']),
      project_id: String(body['project_id']),
      version: String(body['version']),
      difficulty: String(body['difficulty']),
      tasks: body['tasks'] as never,
    })
    return ok(result)
  }

  const report = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const taskId = requireString(body['task_id'], 'task_id')
    const toStatus = requireString(body['to_status'], 'to_status')
    const by = requireString(body['by'], 'by')
    const fromStatus = typeof body['from_status'] === 'string' ? (body['from_status'] as TaskStatus) : undefined
    const expectedRevision = typeof body['expected_revision'] === 'number' ? body['expected_revision'] : undefined
    const errorType = typeof body['error_type'] === 'string' ? (body['error_type'] as string) : undefined
    const updated = await open().report({
      task_id: taskId,
      to_status: toStatus as TaskStatus,
      by,
      ...(fromStatus !== undefined ? { from_status: fromStatus } : {}),
      ...(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}),
      ...(errorType !== undefined ? { error_type: errorType } : {}),
      ...(body['result'] !== undefined ? { result: body['result'] } : {}),
    })
    return ok(decorate(updated))
  }

  const close = (): void => {
    persistence?.close()
    persistence = null
    ledger = null
  }

  return { list, get, stats, dag, register, report, close }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PrismError('bad_request', `缺少必填字段: ${field}`)
  }
  return value.trim()
}

function isNotFound(error: unknown): boolean {
  return error instanceof PrismError && error.code === 'not_found'
}

/** JSON 文本列（dependencies/write_scopes/result）尽力解析；解析失败原样返回。 */
function decorate<T extends object>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const key of ['dependencies', 'write_scopes', 'result']) {
    const raw = out[key]
    if (typeof raw === 'string') {
      try {
        out[key] = JSON.parse(raw) as unknown
      } catch {
        // 保持原字符串
      }
    }
  }
  return out
}
