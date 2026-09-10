/**
 * `prism audit query`（cli-mcp-surface.md §1）——审计查询面。
 *
 * 此前 AuditLog.query 是死代码：没有任何 CLI/HTTP/MCP 入口。
 * 审计已接线落盘（task/work 状态变更），这个命令让它们可查。
 */
import { AuditLog, prismPaths } from '@prism/core'
import type { AuditEventType } from '@prism/core'

import type { ArgValues, CommandContext } from '../argv.js'

/** `prism audit query [--type a,b] [--task <id>] [--request <id>] [--limit N]`。 */
export async function runAudit(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub] = args
  if (sub !== 'query') {
    ctx.stderr('用法: prism audit query [--type task.status_changed,work.completed] [--task <id>] [--request <id>] [--limit 50]')
    return 1
  }
  const types = values.audit_type !== undefined
    ? (String(values.audit_type).split(',').map((t) => t.trim()).filter((t) => t !== '') as AuditEventType[])
    : undefined
  const audit = new AuditLog({ dir: prismPaths(ctx.home ?? undefined).auditDir })
  const events = await audit.query({
    ...(types !== undefined && types.length > 0 ? { types } : {}),
    ...(values.task !== undefined ? { taskId: String(values.task) } : {}),
    ...(values.request !== undefined ? { requestId: String(values.request) } : {}),
    ...(values.knowledge !== undefined ? { knowledgeId: String(values.knowledge) } : {}),
    ...(values.session !== undefined ? { sessionId: String(values.session) } : {}),
  })

  const limit = values.limit !== undefined ? Number(values.limit) : 50
  const shown = Number.isFinite(limit) ? events.slice(-limit) : events.slice(-50)

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { total: events.length, events: shown } }))
    return 0
  }
  if (events.length === 0) {
    ctx.stdout('（没有审计事件）')
    return 0
  }
  for (const e of shown) {
    const at = (e.occurred_at ?? '').replace('T', ' ').slice(0, 19)
    const target =
      'task_id' in e ? String(e.task_id) : 'request_id' in e ? String(e.request_id) : 'knowledge_id' in e ? String(e.knowledge_id) : '—'
    ctx.stdout(`${at}  ${e.type.padEnd(24)} ${target}`)
  }
  ctx.stdout(`显示最近 ${shown.length} 条 / 共 ${events.length} 条 · 目录 ${prismPaths(ctx.home ?? undefined).auditDir}`)
  return 0
}
