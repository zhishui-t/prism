import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fail, sendJson } from '../envelope.js'
import { isInside, MIME_TYPES } from './studio.js'
import type { RouteContext } from '../router.js'

/**
 * 控制台 dist 候选（返工单 F03）：env 覆盖 → 按布局逐个试，取**第一个存在的**。
 *
 * 历史上只算了一个相对位置（`../../../../../apps/web/dist`）。那个算式仅在**开发布局**成立
 * （模块在 `<repo>/packages/server/dist/http/routes/`）。打包产物里 `@prism/server` 被物化成
 * `node_modules/@prism/server/` 的真实副本，同一个算式会得到 `<installRoot>/node_modules/apps/web/dist`
 * ——而打包脚本把控制台放在 `<installRoot>/apps/web/dist`，于是**解压即用的产物控制台恒 404**。
 *
 * 故这里按「模块可能在哪」列出候选，谁存在用谁：
 * 1. 开发布局：`<repo>/packages/server/{src,dist}/http/routes` → `<repo>/apps/web/dist`
 * 2. 打包布局：`<installRoot>/node_modules/@prism/server/dist/http/routes` → `<installRoot>/apps/web/dist`
 */
export function webDistCandidates(): string[] {
  const here = import.meta.url
  return [
    fileURLToPath(new URL('../../../../../apps/web/dist', here)),
    fileURLToPath(new URL('../../../../../../apps/web/dist', here)),
  ]
    .map((p) => resolve(p))
    .filter((p, i, arr) => arr.indexOf(p) === i)
}

/** 是否为「接口面」路径（`/api`、`/studio`）——这些由各自路由独占，兜底不得接管。 */
function isApiLike(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/studio' ||
    pathname.startsWith('/studio/')
  )
}

/** 控制台 dist 解析：env 覆盖 → 候选中第一个存在的；都不在 → 首个候选（供 404 给出可读路径）。 */
export function resolveWebDistDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.PRISM_WEB_DIST?.trim()
  if (fromEnv !== undefined && fromEnv !== '') {
    return resolve(fromEnv)
  }
  const candidates = webDistCandidates()
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0] ?? null
}

/**
 * 控制台静态路由（design.md F05 配套，返工单 F03）：
 * `GET /*` 兜底 serve apps/web/dist（SPA 回退 index.html）。
 * 注册顺序在 /api、/studio 之后，不劫持 API 与 studio。
 */
export function consoleRoute(distDir: string | null) {
  return async (ctx: RouteContext): Promise<void> => {
    // 兜底路由只服务控制台自身资源。**未注册的 /api、/studio 路径不得落到 SPA 回退**——
    // 否则宿主或客户端把路径写错时拿到 200 + index.html（HTML），而不是可判定的 404 JSON，
    // 排查方向会被彻底带偏（实测：`GET /api/people/roles`（真实路径为 /api/roles）返回 HTML）。
    const pathname = new URL(ctx.req.url ?? '/', 'http://localhost').pathname
    if (isApiLike(pathname)) {
      sendJson(ctx.res, 404, fail('not_found', `未知路由: ${pathname}`))
      return
    }

    const missingEnvelope = (): { status: number; body: unknown } => ({
      status: 404,
      body: fail(
        'not_found',
        distDir === null
          ? '控制台不可用：未找到 apps/web/dist；可设置 PRISM_WEB_DIST 指向控制台构建产物，或在 apps/web 下构建'
          : `控制台不可用：dist 目录不存在 ${distDir}；可设置 PRISM_WEB_DIST 指向控制台构建产物`,
      ),
    })

    if (distDir === null) {
      const { status, body } = missingEnvelope()
      sendJson(ctx.res, status, body)
      return
    }
    const base = resolve(distDir)
    let baseStat
    try {
      baseStat = await stat(base)
    } catch {
      const { status, body } = missingEnvelope()
      sendJson(ctx.res, status, body)
      return
    }
    if (!baseStat.isDirectory()) {
      sendJson(ctx.res, 404, fail('not_found', `控制台不可用：PRISM_WEB_DIST 不是目录: ${base}`))
      return
    }

    const rel = ctx.wildcard ?? ''
    const target = resolve(join(base, rel === '' ? 'index.html' : rel))
    if (!isInside(base, target)) {
      sendJson(ctx.res, 404, fail('not_found', '路径越界'))
      return
    }

    let targetStat
    try {
      targetStat = await stat(target)
    } catch {
      // SPA 回退：非文件路径（无扩展名）回 index.html；带扩展名的静态资源缺失 → 404
      const lastSegment = rel.split('/').pop() ?? ''
      if (lastSegment.includes('.')) {
        sendJson(ctx.res, 404, fail('not_found', `文件不存在: ${rel}`))
        return
      }
      const indexHtml = join(base, 'index.html')
      try {
        targetStat = await stat(indexHtml)
      } catch {
        const { status, body } = missingEnvelope()
        sendJson(ctx.res, status, body)
        return
      }
      serveFile(ctx, join(base, 'index.html'), targetStat.size)
      return
    }
    if (targetStat.isDirectory()) {
      const indexHtml = join(target, 'index.html')
      try {
        targetStat = await stat(indexHtml)
      } catch {
        sendJson(ctx.res, 404, fail('not_found', `文件不存在: ${rel}/index.html`))
        return
      }
      serveFile(ctx, indexHtml, targetStat.size)
      return
    }
    serveFile(ctx, target, targetStat.size)
  }
}

function serveFile(ctx: RouteContext, filePath: string, size: number): void {
  const type = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'no-cache' })
  createReadStream(filePath).pipe(ctx.res)
}
