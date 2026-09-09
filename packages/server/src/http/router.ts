import type { IncomingMessage, ServerResponse } from 'node:http'

import { fail, readJsonBody, sendJson, sendOptions, statusFor, toEnvelope, type Envelope } from './envelope.js'

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  /** 路径参数（:name 段） */
  params: Record<string, string>
  /** 查询串 */
  query: URLSearchParams
  /** POST 体（惰性解析，一次缓存） */
  body: () => Promise<unknown>
  /** 通配符 * 段（原始未解码，段间以 / 连接）；无 * 的路由为 undefined */
  wildcard?: string
}

export type RouteHandler = (ctx: RouteContext) => Promise<Envelope | void> | Envelope | void

interface Route {
  method: string
  segments: string[]
  hasWildcard: boolean
  handler: RouteHandler
}

/**
 * 零框架路由器（node:http）。
 * 模式语法：`/api/kb/get/:id`（单段参数）、`/studio/:project/*`（末尾通配，匹配其余所有段）。
 */
export class Router {
  readonly #routes: Route[] = []

  add(method: 'GET' | 'POST', pattern: string, handler: RouteHandler): this {
    const segments = pattern.split('/').filter((s) => s !== '')
    const hasWildcard = segments[segments.length - 1] === '*'
    if (hasWildcard) {
      segments.pop()
    }
    this.#routes.push({ method, segments, hasWildcard, handler })
    return this
  }

  /** 匹配并处理；返回 true 表示已响应（含 404/405 信封），false 仅当非 OPTIONS 的跨域预检等未处理情况。 */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (req.method === 'OPTIONS') {
      sendOptions(res)
      return true
    }
    const parts = pathname.split('/').filter((s) => s !== '')
    let methodMismatch = false
    for (const route of this.#routes) {
      const params = matchRoute(route, parts)
      if (params === null) {
        continue
      }
      if (route.method !== req.method) {
        methodMismatch = true
        continue
      }
      const wildcard = route.hasWildcard ? decodeWildcard(parts, route.segments.length) : undefined
      await this.#invoke(req, res, route, params, wildcard)
      return true
    }
    if (methodMismatch) {
      // 固定错误码集合无 method_not_allowed，归入 not_found，状态码保留 405
      sendJson(res, 405, fail('not_found', `不支持的方法: ${String(req.method)}`), 'GET, POST, OPTIONS')
      return true
    }
    return false
  }

  async #invoke(
    req: IncomingMessage,
    res: ServerResponse,
    route: Route,
    params: Record<string, string>,
    wildcard?: string,
  ): Promise<void> {
    let cached: unknown
    let parsed = false
    const ctx: RouteContext = {
      req,
      res,
      params,
      query: new URL(req.url ?? '/', 'http://localhost').searchParams,
      wildcard,
      body: async () => {
        if (!parsed) {
          cached = await readJsonBody(req)
          parsed = true
        }
        return cached
      },
    }
    try {
      const result = await route.handler(ctx)
      if (result !== undefined) {
        sendJson(res, statusFor(result), result, undefined)
      }
    } catch (error) {
      sendJson(res, statusFor(toEnvelope(error)), toEnvelope(error), undefined)
    }
  }
}

function matchRoute(route: Route, parts: string[]): Record<string, string> | null {
  if (route.hasWildcard ? parts.length < route.segments.length : parts.length !== route.segments.length) {
    return null
  }
  const params: Record<string, string> = {}
  for (let i = 0; i < route.segments.length; i++) {
    const pattern = route.segments[i]
    const actual = parts[i]
    if (pattern.startsWith(':')) {
      params[pattern.slice(1)] = safeDecode(actual)
    } else if (pattern !== actual) {
      return null
    }
  }
  return params
}

function decodeWildcard(parts: string[], offset: number): string {
  return parts
    .slice(offset)
    .map((p) => safeDecode(p))
    .join('/')
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
