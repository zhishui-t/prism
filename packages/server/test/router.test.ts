import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ERROR_CODES, fail, ok } from '../src/http/envelope.js'
import { Router } from '../src/http/router.js'
import { PrismError } from '@prism/core'

/** 起一个真实 http 服务测试路由（ephemeral port）。 */
async function startTestServer(router: Router): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const handled = await router.handle(req, res, pathname)
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(fail('not_found', `未知路由: ${pathname}`)))
      }
    })().catch(() => {
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

describe('信封（envelope）', () => {
  it('ok/fail 形态符合 design.md §4', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 })
    expect(fail('bad_request', 'x')).toEqual({ ok: false, error: { code: 'bad_request', message: 'x' } })
    expect(ERROR_CODES).toContain('build_in_progress')
  })
})

describe('Router（零框架路由）', () => {
  let app: { base: string; close: () => Promise<void> }

  beforeAll(async () => {
    const router = new Router()
    router.add('GET', '/api/ping', () => ok('pong'))
    router.add('GET', '/api/kb/get/:id', (ctx) => ok({ id: ctx.params.id, wildcard: ctx.wildcard }))
    router.add('GET', '/static/:name/*', (ctx) => ok({ name: ctx.params.name, rest: ctx.wildcard }))
    router.add('POST', '/api/echo', async (ctx) => ok(await ctx.body()))
    router.add('GET', '/api/boom', () => {
      throw new PrismError('id_conflict', '冲突了')
    })
    router.add('GET', '/api/unknown-error', () => {
      throw new Error('炸了')
    })
    app = await startTestServer(router)
  })

  afterAll(async () => {
    await app.close()
  })

  it('精确路径 + ok 信封', async () => {
    const res = await fetch(`${app.base}/api/ping`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, value: 'pong' })
  })

  it(':param 捕获与解码', async () => {
    const res = await fetch(`${app.base}/api/kb/get/%E6%80%A7%E8%83%BD`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, value: { id: '性能', wildcard: undefined } })
  })

  it('通配符 * 捕获多段路径', async () => {
    const res = await fetch(`${app.base}/static/js/a/b/c.js`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, value: { name: 'js', rest: 'a/b/c.js' } })
  })

  it('未知路由 → not_found 信封（404）', async () => {
    const res = await fetch(`${app.base}/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'not_found', message: expect.any(String) } })
  })

  it('方法不匹配 → 405', async () => {
    const res = await fetch(`${app.base}/api/echo`)
    expect(res.status).toBe(405)
  })

  it('POST 体解析', async () => {
    const res = await fetch(`${app.base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: '世界' }),
    })
    expect(await res.json()).toEqual({ ok: true, value: { hello: '世界' } })
  })

  it('非法 JSON 体 → bad_request', async () => {
    const res = await fetch(`${app.base}/api/echo`, { method: 'POST', body: '{oops' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: 'bad_request', message: expect.stringContaining('JSON') },
    })
  })

  it('PrismError 保留固定错误码', async () => {
    const res = await fetch(`${app.base}/api/boom`)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'id_conflict', message: '冲突了' } })
  })

  it('未知异常归 internal', async () => {
    const res = await fetch(`${app.base}/api/unknown-error`)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: { code: 'internal', message: expect.any(String) } })
  })

  it('CORS 头存在（控制台跨端口访问）', async () => {
    const res = await fetch(`${app.base}/api/ping`)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
