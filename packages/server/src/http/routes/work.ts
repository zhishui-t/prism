import { PrismError, type WorkKind, type WorkQueue } from '@prism/core'

import { ok, type Envelope } from '../envelope.js'
import type { RouteContext } from '../router.js'

export interface WorkDeps {
  /** 惰性取工作队列（组合根装配；测试可注入内存实例） */
  getQueue: () => Promise<WorkQueue>
}

/**
 * 工作队列路由（work-queue.md §4）：拉取式。
 * - GET  /api/work/pending  列出待办（宿主主动拉）
 * - POST /api/work/claim    认领（签发 attempt token）
 * - POST /api/work/complete 回填（token + schema 校验）
 * - POST /api/work/fail     显式失败（重试未超限则回收为 pending）
 * - POST /api/work/reclaim  超时回收
 * - GET  /api/work/stats    队列水位
 * 全部薄封装，逻辑在 @prism/core WorkQueue。
 */
export function workRoutes(deps: WorkDeps): {
  pending: (ctx: RouteContext) => Promise<Envelope>
  claim: (ctx: RouteContext) => Promise<Envelope>
  complete: (ctx: RouteContext) => Promise<Envelope>
  fail: (ctx: RouteContext) => Promise<Envelope>
  reclaim: (ctx: RouteContext) => Promise<Envelope>
  stats: (ctx: RouteContext) => Promise<Envelope>
} {
  const pending = async (ctx: RouteContext): Promise<Envelope> => {
    const kind = ctx.query.get('kind')?.trim() || undefined
    const limitRaw = ctx.query.get('limit')
    const priorityRaw = ctx.query.get('priority_min')
    const query = {
      ...(kind !== undefined ? { kind: kind as WorkKind } : {}),
      ...(limitRaw !== null && limitRaw !== '' ? { limit: parsePositiveInt(limitRaw, 'limit', 200) } : {}),
      ...(priorityRaw !== null && priorityRaw !== ''
        ? { priority_min: parseInteger(priorityRaw, 'priority_min') }
        : {}),
    }
    return ok(await (await deps.getQueue()).pending(query))
  }

  const claim = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const id = requireString(body['id'], 'id')
    const claimedBy = requireString(body['claimed_by'], 'claimed_by')
    return ok(await (await deps.getQueue()).claim(id, claimedBy))
  }

  const complete = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const id = requireString(body['id'], 'id')
    const token = requireString(body['attempt_token'], 'attempt_token')
    const by = typeof body['by'] === 'string' ? (body['by'] as string) : undefined
    return ok(
      await (await deps.getQueue()).complete({
        id,
        attempt_token: token,
        result: body['result'],
        ...(by !== undefined ? { by } : {}),
      }),
    )
  }

  const fail = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const id = requireString(body['id'], 'id')
    const token = requireString(body['attempt_token'], 'attempt_token')
    const error = typeof body['error'] === 'string' ? (body['error'] as string) : '执行失败'
    return ok(await (await deps.getQueue()).fail(id, token, error))
  }

  const reclaim = async (): Promise<Envelope> => ok(await (await deps.getQueue()).reclaimExpired())

  const stats = async (): Promise<Envelope> => ok(await (await deps.getQueue()).stats())

  return { pending, claim, complete, fail, reclaim, stats }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PrismError('bad_request', `缺少必填字段: ${field}`)
  }
  return value.trim()
}

function parsePositiveInt(raw: string, name: string, max: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new PrismError('bad_request', `${name} 必须为 1~${max} 的整数: ${raw}`)
  }
  return value
}

function parseInteger(raw: string, name: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw new PrismError('bad_request', `${name} 必须为整数: ${raw}`)
  }
  return value
}
