import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer } from '../src/app.js'
import { resolveWebDistDir } from '../src/http/routes/console.js'
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
})
