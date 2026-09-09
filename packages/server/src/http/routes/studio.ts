import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { PrismError } from '@prism/core'

import { fail, sendJson } from '../envelope.js'
import { ProjectRegistry } from '../../graph/registry.js'
import { vendoredGraphifyDir } from '../../graph/graphify.js'
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
 * 离线化（B12）：graphify 生成的 graph.html 从 unpkg CDN 加载 vis-network，
 * 断网/离线即空白。此处把该请求代理到 vendored 副本（3rd/graphify/vendor/），
 * 并把 HTML 里的 CDN URL 改写为本地路径——**不重写 graphify 渲染器**（D9）。
 */
const VENDOR_PREFIX = 'vendor/'
const VIS_NETWORK_FILE = 'vis-network.min.js'
/** HTML 中需改写的外部脚本标签（与 graphify exporters/html.py 的引用一致）。 */
const CDN_SCRIPT_RE = /<script\s+src="https:\/\/unpkg\.com\/vis-network@[^"]+"[^>]*><\/script>/g

/**
 * GET /studio/:project/*（design.md §4）：
 * project 必须来自注册表；解析后的绝对路径必须仍在 `<root>/graphify-out/` 内（防穿越）。
 */
export function studioRoute(registry: ProjectRegistry) {
  return async (ctx: RouteContext): Promise<void> => {
    const rel = ctx.wildcard ?? ''

    // 离线化资源：/studio/:project/vendor/<file> → 3rd/graphify/vendor/<file>
    if (rel.startsWith(VENDOR_PREFIX)) {
      const name = rel.slice(VENDOR_PREFIX.length)
      if (name !== VIS_NETWORK_FILE) {
        sendJson(ctx.res, 404, fail('not_found', `未知 vendored 资源: ${name}`))
        return
      }
      const file = join(vendoredGraphifyDir(), 'vendor', VIS_NETWORK_FILE)
      try {
        const buf = await readFile(file)
        ctx.res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': String(buf.byteLength),
          'Cache-Control': 'public, max-age=86400',
        })
        ctx.res.end(buf)
      } catch {
        sendJson(ctx.res, 404, fail('not_found', `vendored 资源缺失: ${file}`))
      }
      return
    }

    const project = ctx.params.project ?? ''
    const info = await registry.get(project)
    const base = resolve(join(info.root, 'graphify-out'))
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
      // 目录默认页：graph.html（Python 版 graphify 产物）优先，兼容 index.html（旧 npm fork studio）
      const candidates = [join(target, 'graph.html'), join(target, 'index.html')]
      let found: string | null = null
      for (const candidate of candidates) {
        try {
          targetStat = await stat(candidate)
          found = candidate
          break
        } catch {
          // 继续试下一个
        }
      }
      if (found === null) {
        sendJson(ctx.res, 404, fail('not_found', `目录内无默认页: ${rel}`))
        return
      }
      filePath = found
    }
    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'

    // HTML 离线化：把 CDN 脚本引用改写为本地 vendored 路径（其余内容原样透传）
    if (type.startsWith('text/html')) {
      const raw = await readFile(filePath, 'utf-8')
      const dirUrl = (ctx.req.url ?? '').split('?')[0]!.split('/').slice(0, -1).join('/')
      const rewritten = raw.replace(CDN_SCRIPT_RE, `<script src="${dirUrl}/vendor/${VIS_NETWORK_FILE}"></script>`)
      const buf = Buffer.from(rewritten, 'utf-8')
      ctx.res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': String(buf.byteLength),
        'Cache-Control': 'no-cache',
      })
      ctx.res.end(buf)
      return
    }

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
