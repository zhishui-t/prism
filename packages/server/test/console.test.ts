import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer } from '../src/app.js'
import { resolveWebDistDir, webDistCandidates } from '../src/http/routes/console.js'
import type { AppHandle } from '../src/app.js'

/** 伪造控制台 dist：index.html + assets/x.js。 */
async function makeFakeDist(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-web-dist-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><h1>FAKE CONSOLE</h1></body></html>', 'utf-8')
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'assets', 'x.js'), 'console.log("fake-asset")', 'utf-8')
  return dir
}

describe('控制台静态服务（GET /* 兜底，不劫持 /api 与 /studio）', () => {
  let app: AppHandle
  let base: string
  let dist: string
  const cleanups: string[] = []

  beforeAll(async () => {
    dist = await makeFakeDist()
    cleanups.push(dist)
    const empty = await mkdtemp(join(tmpdir(), 'prism-web-empty-'))
    cleanups.push(empty)
    app = await startServer({ home: empty, port: 0, webDist: dist })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    for (const dir of cleanups) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('GET / → index.html（200, text/html）', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('FAKE CONSOLE')
  })

  it('GET /assets/x.js → 200, js MIME', async () => {
    const res = await fetch(`${base}/assets/x.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(await res.text()).toContain('fake-asset')
  })

  it('SPA 回退：/knowledge（无扩展名、无此文件）→ index.html', async () => {
    const res = await fetch(`${base}/knowledge`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('FAKE CONSOLE')
  })

  it('缺失的带扩展名资源 → 404', async () => {
    const res = await fetch(`${base}/assets/nope.js`)
    expect(res.status).toBe(404)
  })

  it('路径穿越 → 404', async () => {
    const res = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)
    expect(res.status).toBe(404)
  })

  it('优先级：/api/health 不被静态兜底劫持', async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('未注册的 /api 路径 → 404 JSON（**不得**落到 SPA 回退返回 HTML）', async () => {
    for (const path of ['/api/people/roles', '/api/nope', '/api']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type') ?? '', path).toContain('application/json')
      const body = (await res.json()) as { ok: boolean; error?: { code: string } }
      expect(body.ok, path).toBe(false)
      expect(body.error?.code, path).toBe('not_found')
    }
  })

  it('未注册的 /studio 路径 → 404 JSON；普通 SPA 路径仍回退 index.html', async () => {
    const studio = await fetch(`${base}/studio/nope/deep`)
    expect(studio.status).toBe(404)
    expect(studio.headers.get('content-type') ?? '').toContain('application/json')

    const spa = await fetch(`${base}/knowledge`)
    expect(spa.status).toBe(200)
    expect(spa.headers.get('content-type') ?? '').toContain('text/html')
  })

  it('dist 不存在 → 404 + 可读提示（指向 PRISM_WEB_DIST）', async () => {
    const app2 = await startServer({
      home: await mkdtemp(join(tmpdir(), 'prism-web-home2-')),
      port: 0,
      webDist: join(tmpdir(), 'prism-web-dist-确实不存在-9x9'),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${app2.port}/`)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } }
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe('not_found')
      expect(body.error.message).toContain('PRISM_WEB_DIST')
    } finally {
      await app2.close()
    }
  })

  it('resolveWebDistDir：PRISM_WEB_DIST 优先于仓库推算', () => {
    const resolved = resolveWebDistDir({ PRISM_WEB_DIST: 'D:/custom/web-dist' })
    expect(resolved).toBe(resolve('D:/custom/web-dist'))
  })

  it('resolveWebDistDir：候选覆盖「开发布局」与「打包布局」（回归：打包产物控制台曾恒 404）', () => {
    const candidates = webDistCandidates()
    // 开发布局：<repo>/apps/web/dist（本用例跑在源码布局下，仓库已构建 → 必须命中）
    const repoDist = resolve(fileURLToPath(new URL('../../../apps/web/dist', import.meta.url)))
    expect(candidates).toContain(repoDist)
    expect(resolveWebDistDir({})).toBe(repoDist)

    // 打包布局候选：同为 `.../apps/web/dist`，但基准比开发布局多一级。
    // 注意：候选路径**随模块所在位置变化**——只有模块真的位于物化副本
    // `node_modules/@prism/server/dist/...` 时才带 `node_modules` 段；
    // 源码布局下它退化为仓库上一级的 `.../apps/web/dist`。故只断言可判定部分。
    const packaged = candidates.find((c) => c !== repoDist)
    expect(packaged).toBeDefined()
    expect(packaged?.endsWith(join('apps', 'web', 'dist'))).toBe(true)
    expect(candidates.every((c) => c.endsWith(join('apps', 'web', 'dist')))).toBe(true)
  })
})
