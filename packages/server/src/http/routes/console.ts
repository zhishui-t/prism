import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fail, sendJson } from '../envelope.js'
import { isInside, MIME_TYPES } from './studio.js'
import type { RouteContext } from '../router.js'

/** 控制台 dist 候选解析（返工单 F03）：env 覆盖 → 仓库内 apps/web/dist 推算；均不存在 → null（404 可读提示）。 */
export function resolveWebDistDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.PRISM_WEB_DIST?.trim()
  if (fromEnv !== undefined && fromEnv !== '') {
    return resolve(fromEnv)
  }
  // 本文件编译后在 packages/server/dist/http/routes/，源码在 packages/server/src/http/routes/，
  // 两种布局向上 5 级都是仓库根。
  const repoGuess = fileURLToPath(new URL('../../../../../apps/web/dist', import.meta.url))
  return resolve(repoGuess)
}

/**
 * 控制台静态路由（design.md F05 配套，返工单 F03）：
 * `GET /*` 兜底 serve apps/web/dist（SPA 回退 index.html）。
 * 注册顺序在 /api、/studio 之后，不劫持 API 与 studio。
 */
export function consoleRoute(distDir: string | null) {
  return async (ctx: RouteContext): Promise<void> => {
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
