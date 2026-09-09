import type { IncomingMessage, ServerResponse } from 'node:http'

import { isPrismError, PrismError } from '@prism/core'

/** design.md §4 固定错误码集合（含工作队列护栏码，work-queue.md §6）。 */
export const ERROR_CODES = [
  'bad_request',
  'not_found',
  'id_conflict',
  'graph_not_found',
  'graphify_missing',
  'graphify_failed',
  'graphify_timeout',
  'build_in_progress',
  'work_already_claimed',
  'work_token_mismatch',
  'work_result_invalid',
  'work_backlog_full',
  'invalid_status_transition',
  'task_stale_revision',
  'archify_missing',
  'archify_failed',
  'archify_timeout',
  'archify_validation_failed',
  'harness_not_found',
  'internal',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** 响应信封：{ok,value} | {ok:false,error}（design.md §4）。 */
export type Envelope<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string } }

export const ok = <T>(value: T): Envelope<T> => ({ ok: true, value })

export const fail = (code: ErrorCode, message: string): Envelope<never> => ({
  ok: false,
  error: { code, message },
})

const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  id_conflict: 409,
  graph_not_found: 404,
  graphify_missing: 500,
  graphify_failed: 500,
  graphify_timeout: 504,
  build_in_progress: 409,
  work_already_claimed: 409,
  work_token_mismatch: 409,
  work_result_invalid: 422,
  work_backlog_full: 429,
  invalid_status_transition: 409,
  task_stale_revision: 409,
  archify_missing: 500,
  archify_failed: 500,
  archify_timeout: 504,
  archify_validation_failed: 422,
  harness_not_found: 400,
  internal: 500,
}

/** 任意异常 → 信封：PrismError 保留 code（仅固定集合内），其余归 internal。 */
export function toEnvelope(error: unknown): Envelope<never> {
  if (isPrismError(error)) {
    const code = (ERROR_CODES as readonly string[]).includes(error.code)
      ? (error.code as ErrorCode)
      : 'internal'
    return fail(code, error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  return fail('internal', message)
}

export function statusFor(envelope: Envelope<unknown>): number {
  return envelope.ok ? 200 : ERROR_STATUS[envelope.error.code]
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

/** JSON 响应（带 CORS——控制台 Vite 端口与 API 端口不同源）。 */
export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  method?: string,
): void {
  if (res.headersSent) {
    return
  }
  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
  }
  if (method != null) {
    headers['Allow'] = method
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(payload))
}

export function sendOptions(res: ServerResponse): void {
  res.writeHead(204, CORS_HEADERS)
  res.end()
}

/** 读取并解析 JSON 请求体；空体返回 {}，非法 JSON 抛 bad_request。 */
export async function readJsonBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) {
      throw new PrismError('bad_request', '请求体过大')
    }
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim()
  if (raw === '') {
    return {}
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw new PrismError('bad_request', '请求体不是合法 JSON')
  }
}
