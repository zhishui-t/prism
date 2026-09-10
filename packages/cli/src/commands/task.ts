/**
 * `prism task`（task-center.md §4）：被动台账的命令行面。
 *
 * Prism 不驱动任务——宿主/队长登记 DAG、回报状态，Prism 只记录、可视化、审计。
 */
import { AuditLog, prismPaths, openPersistence, TaskLedger, isPrismError, type TaskStatus } from '@prism/core'
import { readFile } from 'node:fs/promises'

import type { ArgValues, CommandContext } from '../argv.js'

/** 组装台账（每次命令独立打开持久化，随命令结束关闭）。 */
function makeLedger(ctx: CommandContext): { ledger: TaskLedger; close: () => void } {
  const persistence = ctx.persistence ?? openPersistence({ home: ctx.home })
  return {
    ledger: new TaskLedger({
      persistence,
      audit: new AuditLog({ dir: prismPaths(ctx.home).auditDir, queue: persistence.queue }),
    }),
    close: () => {
      if (ctx.persistence === undefined) persistence.close()
    },
  }
}

/** `prism task <list|show|graph|register|report|stats> ...`。 */
export async function runTask(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const { ledger, close } = makeLedger(ctx)
  try {
    switch (sub) {
      case 'list':
        return await taskList(ctx, ledger, values)
      case 'show':
        return await taskShow(ctx, ledger, rest)
      case 'graph':
        return await taskGraph(ctx, ledger, rest)
      case 'register':
        return await taskRegister(ctx, ledger, rest, values)
      case 'report':
        return await taskReport(ctx, ledger, rest, values)
      case 'stats':
        return await taskStats(ctx, ledger)
      default:
        ctx.stderr(
          `用法: prism task <list|show|graph|register|report|stats> ...\n` +
            `  list [--dag <id>] [--status <S>] [--session <id>]   台账列表\n` +
            `  show <task-id>                                     单任务\n` +
            `  graph <dag-id>                                     依赖图（文本）\n` +
            `  register --dag <id> --session <id> --team <id> --project <id> --dag-version <v> --difficulty <d> --file <dag.json>\n` +
            `  report <task-id> --to <STATUS> --by <who> [--from <STATUS>] [--revision N] [--result <json>] [--error-type <t>]\n` +
            `  stats                                              台账统计`,
        )
        return 1
    }
  } catch (error) {
    if (isPrismError(error)) {
      ctx.stderr(`错误 [${error.code}] ${error.message}`)
      return 1
    }
    throw error
  } finally {
    close()
  }
}

async function taskList(ctx: CommandContext, ledger: TaskLedger, values: ArgValues): Promise<number> {
  const rows = ledger.list({
    ...(values.dag !== undefined ? { dag_id: String(values.dag) } : {}),
    ...(values.status !== undefined ? { status: values.status as TaskStatus } : {}),
    ...(values.session !== undefined ? { session_id: String(values.session) } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: rows }))
    return 0
  }
  if (rows.length === 0) {
    ctx.stdout('（台账为空）')
    return 0
  }
  for (const row of rows) {
    ctx.stdout(`${row.status.padEnd(18)} ${row.id}  [${row.dag_id}]  r${row.revision}  ${row.description.slice(0, 40)}`)
  }
  ctx.stdout(`共 ${rows.length} 个任务`)
  return 0
}

async function taskShow(ctx: CommandContext, ledger: TaskLedger, args: string[]): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    ctx.stderr('用法: prism task show <task-id>')
    return 1
  }
  const row = ledger.get(id)
  ctx.stdout(JSON.stringify(ctx.json ? { ok: true, value: row } : row, null, 2))
  return 0
}

async function taskGraph(ctx: CommandContext, ledger: TaskLedger, args: string[]): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    ctx.stderr('用法: prism task graph <dag-id>')
    return 1
  }
  const graph = ledger.dag(id)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: graph }))
    return 0
  }
  ctx.stdout(`DAG ${graph.dag_id}（${graph.status}）：${graph.tasks.length} 任务 / ${graph.edges.length} 边`)
  for (const task of graph.tasks) {
    const deps = JSON.parse(task.dependencies || '[]') as string[]
    const depText = deps.length > 0 ? `  ← ${deps.join(', ')}` : ''
    ctx.stdout(`  ${task.status.padEnd(18)} ${task.id}${depText}`)
  }
  return 0
}

async function taskRegister(
  ctx: CommandContext,
  ledger: TaskLedger,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const dagId = values.dag ?? args[0]
  if (dagId === undefined || values.file === undefined) {
    ctx.stderr('用法: prism task register --dag <id> --session <id> --team <id> --project <id> --dag-version <v> --difficulty <d> --file <dag.json>')
    return 1
  }
  let parsed: { tasks?: unknown }
  try {
    parsed = JSON.parse(await readFile(String(values.file), 'utf-8')) as { tasks?: unknown }
  } catch (error) {
    ctx.stderr(`错误 [bad_request] 读取 --file 失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const result = await ledger.registerDag({
    dag_id: String(dagId),
    session_id: String(values.session ?? ''),
    team_id: String(values.team ?? ''),
    project_id: String(values.project ?? ''),
    version: String(values['dag-version'] ?? 'v1'),
    difficulty: String(values.difficulty ?? 'normal'),
    tasks: (parsed.tasks ?? []) as never,
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: result }))
  } else {
    ctx.stdout(`已登记 DAG ${result.dag_id}：${result.tasks} 任务 / ${result.edges} 边（被动记录，不触发执行）`)
  }
  return 0
}

async function taskReport(
  ctx: CommandContext,
  ledger: TaskLedger,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const id = args[0]
  if (id === undefined || values.to === undefined) {
    ctx.stderr('用法: prism task report <task-id> --to <STATUS> --by <who> [--from <STATUS>] [--revision N]')
    return 1
  }
  let result: unknown
  if (values.result !== undefined) {
    try {
      result = JSON.parse(String(values.result))
    } catch (error) {
      ctx.stderr(`错误 [bad_request] --result 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  const row = await ledger.report({
    task_id: id,
    to_status: String(values.to) as TaskStatus,
    by: String(values.by ?? 'cli'),
    ...(values.from !== undefined ? { from_status: String(values.from) as TaskStatus } : {}),
    ...(values.revision !== undefined ? { expected_revision: Number(values.revision) } : {}),
    ...(values['error-type'] !== undefined ? { error_type: String(values['error-type']) } : {}),
    ...(result !== undefined ? { result } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: row }))
  } else {
    ctx.stdout(`已回报 ${row.id} → ${row.status}（revision ${row.revision}）`)
  }
  return 0
}

async function taskStats(ctx: CommandContext, ledger: TaskLedger): Promise<number> {
  const stats = ledger.stats()
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: stats }))
    return 0
  }
  ctx.stdout(`任务 ${stats.total} 个，DAG ${stats.dags} 个`)
  for (const [status, count] of Object.entries(stats.by_status).sort()) {
    ctx.stdout(`  ${status.padEnd(20)} ${count}`)
  }
  return 0
}
