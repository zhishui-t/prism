import { ok, type Envelope } from '../envelope.js'
import type { RouteContext } from '../router.js'

export interface ServerMeta {
  version: string
  startedAt: number
  /** 实际使用的 PRISM_HOME（app 组装时注入） */
  home: string
}

/** GET /api/health → { ok, version, home, uptime }（design.md §4）。 */
export function healthRoute(meta: ServerMeta) {
  return (_ctx: RouteContext): Envelope => {
    return ok({
      version: meta.version,
      home: meta.home,
      uptime: Math.round((Date.now() - meta.startedAt) / 1000),
    })
  }
}
