import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { PrismError } from '@prism/core'

import { fail, sendJson } from '../envelope.js'
import { ProjectRegistry } from '../../graph/registry.js'
import type { RouteContext } from '../router.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/** 静态文件 MIME 表（studio 与控制台静态服务共用）。 */
export const MIME_TYPES: Record<string, string> = MIME

/**
 * GET /studio/:project/*（design.md §4）：
 * project 必须来自注册表；解析后的绝对路径必须仍在 `<root>/graphify-out/` 内（防穿越）。
 */
export function studioRoute(registry: ProjectRegistry) {
  return async (ctx: RouteContext): Promise<void> => {
    const project = ctx.params.project ?? ''
    const info = await registry.get(project)
    const base = resolve(join(info.root, 'graphify-out'))
    const rel = ctx.wildcard ?? ''
    const target = resolve(join(base, rel))

    if (!isInside(base, target)) {
      sendJson(ctx.res, 404, fail('not_found', '路径越界'))
      return
    }
    let targetStat
    try {
      targetStat = await stat(target)
    } catch {
      sendJson(ctx.res, 404, fail('not_found', `文件不存在: ${rel || 'index.html'}`))
      return
    }
    let filePath = target
    if (targetStat.isDirectory()) {
      filePath = join(target, 'index.html')
      try {
        targetStat = await stat(filePath)
      } catch {
        sendJson(ctx.res, 404, fail('not_found', `文件不存在: ${rel}/index.html`))
        return
      }
    }
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Length': targetStat.size, 'Cache-Control': 'no-cache' })
    createReadStream(filePath).pipe(ctx.res)
  }
}

/** 越界校验（Windows 大小写不敏感；统一 / 分隔符比较）。 */
export function isInside(base: string, target: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const b = norm(process.platform === 'win32' ? base.toLowerCase() : base)
  const t = norm(process.platform === 'win32' ? target.toLowerCase() : target)
  return t === b || t.startsWith(`${b}/`)
}

/** 供测试/CLI 复用的 studio 基目录解析（不存在目录不报错，serve 时才 404）。 */
export async function ensureStudioBase(root: string): Promise<string> {
  const base = resolve(join(root, 'graphify-out'))
  try {
    if (!(await stat(base)).isDirectory()) {
      throw new PrismError('graph_not_found', `studio 目录不存在: ${base}`)
    }
  } catch (error) {
    if (error instanceof PrismError) {
      throw error
    }
    throw new PrismError('graph_not_found', `studio 目录不存在: ${base}`)
  }
  return base
}
