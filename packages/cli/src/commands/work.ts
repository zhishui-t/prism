/**
 * `prism work`（work-queue.md §4）：拉取式工作队列的命令行面。
 *
 * Prism 不调 LLM——需要 LLM 的工作（embed/summarize/classify/extract_entities/diagram_ir）
 * 落成 work_request，由宿主/人拉取执行后回填。
 */
import {
  openPersistence,
  WorkQueue,
  WORK_KINDS,
  BUILTIN_VALIDATORS,
  isPrismError,
  type WorkKind,
} from '@prism/core'

import type { ArgValues, CommandContext } from '../argv.js'

/** 组装队列（每次命令独立打开持久化，随命令结束关闭）。 */
function makeQueue(ctx: CommandContext): { queue: WorkQueue; close: () => void } {
  const persistence = ctx.persistence ?? openPersistence({ home: ctx.home })
  const queue = new WorkQueue({ persistence })
  for (const kind of WORK_KINDS) {
    queue.registerValidator(kind, BUILTIN_VALIDATORS[kind])
  }
  return {
    queue,
    close: () => {
      if (ctx.persistence === undefined) persistence.close()
    },
  }
}

/** `prism work <pending|enqueue|claim|complete|fail|reclaim|stats> ...`。 */
export async function runWork(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const { queue, close } = makeQueue(ctx)
  try {
    switch (sub) {
      case 'pending':
        return await workPending(ctx, queue, values)
      case 'enqueue':
        return await workEnqueue(ctx, queue, rest, values)
      case 'claim':
        return await workClaim(ctx, queue, rest, values)
      case 'complete':
        return await workComplete(ctx, queue, rest, values)
      case 'fail':
        return await workFail(ctx, queue, rest, values)
      case 'reclaim':
        return await workReclaim(ctx, queue)
      case 'stats':
        return await workStats(ctx, queue)
      default:
        ctx.stderr(
          `用法: prism work <pending|enqueue|claim|complete|fail|reclaim|stats> ...\n` +
            `  pending [--kind --limit --priority-min]   列出待办\n` +
            `  enqueue --kind <k> --payload <json> [--priority N] [--id ID]\n` +
            `  claim <id> --by <who>                    认领（签发 token）\n` +
            `  complete <id> --token <t> --result <json>\n` +
            `  fail <id> --token <t> [--error <msg>]\n` +
            `  reclaim                                  超时回收\n` +
            `  stats                                    队列水位`,
        )
        return 1
    }
  } finally {
    close()
  }
}

async function workPending(ctx: CommandContext, queue: WorkQueue, values: ArgValues): Promise<number> {
  const items = await queue.pending({
    ...(values.kind !== undefined ? { kind: values.kind as WorkKind } : {}),
    ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
    ...(values['priority-min'] !== undefined ? { priority_min: Number(values['priority-min']) } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: items }))
    return 0
  }
  if (items.length === 0) {
    ctx.stdout('（无待办）')
    return 0
  }
  for (const item of items) {
    ctx.stdout(`[${item.priority}] ${item.id}  ${item.kind}  ${item.created_at}`)
    ctx.stdout(`    payload: ${JSON.stringify(item.payload)}`)
  }
  ctx.stdout(`共 ${items.length} 条待办`)
  return 0
}

async function workEnqueue(
  ctx: CommandContext,
  queue: WorkQueue,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const kind = values.kind ?? args[0]
  if (kind === undefined) {
    ctx.stderr('用法: prism work enqueue --kind <summarize|classify|extract_entities|diagram_ir> --payload <json>')
    return 1
  }
  let payload: unknown = {}
  if (values.payload !== undefined) {
    try {
      payload = JSON.parse(String(values.payload))
    } catch (error) {
      ctx.stderr(`错误 [bad_request] --payload 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  const created = await queue.enqueue({
    kind: kind as WorkKind,
    payload,
    ...(values.priority !== undefined ? { priority: Number(values.priority) } : {}),
    ...(values.id !== undefined ? { id: String(values.id) } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: created }))
  } else {
    ctx.stdout(`已入队 ${created.id}  kind=${created.kind}  priority=${created.priority}`)
  }
  return 0
}

async function workClaim(
  ctx: CommandContext,
  queue: WorkQueue,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const id = args[0]
  const by = values.by ?? 'cli'
  if (id === undefined) {
    ctx.stderr('用法: prism work claim <id> [--by <who>]')
    return 1
  }
  const claim = await queue.claim(id, String(by))
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: claim }))
  } else {
    ctx.stdout(`已认领 ${claim.id}`)
    ctx.stdout(`  attempt_token: ${claim.attempt_token}`)
    ctx.stdout(`  deadline: ${claim.deadline}`)
    ctx.stdout(`  payload: ${JSON.stringify(claim.payload)}`)
    ctx.stdout('执行完成后: prism work complete ' + claim.id + ' --token <token> --result <json>')
  }
  return 0
}

async function workComplete(
  ctx: CommandContext,
  queue: WorkQueue,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const id = args[0]
  if (id === undefined || values.token === undefined) {
    ctx.stderr('用法: prism work complete <id> --token <token> --result <json>')
    return 1
  }
  let result: unknown
  try {
    result = values.result === undefined ? null : JSON.parse(String(values.result))
  } catch (error) {
    ctx.stderr(`错误 [bad_request] --result 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const done = await queue.complete({ id, attempt_token: String(values.token), result })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: done }))
  } else {
    ctx.stdout(`已完成 ${done.id}  status=${done.status}`)
  }
  return 0
}

async function workFail(
  ctx: CommandContext,
  queue: WorkQueue,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const id = args[0]
  if (id === undefined || values.token === undefined) {
    ctx.stderr('用法: prism work fail <id> --token <token> [--error <msg>]')
    return 1
  }
  const failed = await queue.fail(id, String(values.token), values.error ?? '执行失败')
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: failed }))
  } else {
    ctx.stdout(`已标记失败 ${failed.id}  status=${failed.status}  fail_count=${failed.fail_count}`)
    if (failed.status === 'pending') ctx.stdout('（未超重试上限，已回收为待办）')
  }
  return 0
}

async function workReclaim(ctx: CommandContext, queue: WorkQueue): Promise<number> {
  const { reclaimed } = await queue.reclaimExpired()
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { reclaimed } }))
  } else {
    ctx.stdout(reclaimed.length === 0 ? '（无超时认领）' : `已回收 ${reclaimed.length} 条: ${reclaimed.join(', ')}`)
  }
  return 0
}

async function workStats(ctx: CommandContext, queue: WorkQueue): Promise<number> {
  const stats = await queue.stats()
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: stats }))
  } else {
    const age = stats.oldest_pending_age_ms
    ctx.stdout(`待办 ${stats.pending}  认领中 ${stats.claimed}  已完成 ${stats.completed}  失败 ${stats.failed}`)
    ctx.stdout(`最老待办年龄: ${age === null ? '—' : `${Math.round(age / 1000)}s`}`)
  }
  return 0
}

/** 统一错误输出（CLI 顶层也会兜，但此处给出稳定错误码）。 */
export function reportWorkError(ctx: CommandContext, error: unknown): number {
  if (isPrismError(error)) {
    ctx.stderr(`错误 [${error.code}] ${error.message}`)
    return 1
  }
  throw error
}
