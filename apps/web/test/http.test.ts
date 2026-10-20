/**
 * v20 HTTP 信封层：单一实现 + GET 在途合并。
 *
 * 这里只测网络边界（信封解包 / 错误前缀 / 合并 / 不合并写请求），页面行为由各自 DOM 测试覆盖。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { request } from '../src/http.ts'

function envelope<T>(value: T): Response {
  return { json: async () => ({ ok: true, value }) } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('http 信封层', () => {
  it('成功信封只返回 value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ n: 1 })))
    await expect(request('/api/http-ok')).resolves.toEqual({ n: 1 })
  })

  it('错误信封抛 `${code}: ${message}`（D-1 前缀契约不得改形）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ ok: false, error: { code: 'not_found', message: '没了' } }) }) as unknown as Response),
    )
    await expect(request('/api/http-err')).rejects.toThrow('not_found: 没了')
  })

  it('并发同路径 GET 只发一次；两个调用都拿到同一结果', async () => {
    let settle!: (res: Response) => void
    const pending = new Promise<Response>((resolve) => {
      settle = resolve
    })
    const fetchMock = vi.fn(() => pending)
    vi.stubGlobal('fetch', fetchMock)

    const a = request('/api/http-shared')
    const b = request('/api/http-shared')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    settle(envelope({ n: 2 }))
    await expect(a).resolves.toEqual({ n: 2 })
    await expect(b).resolves.toEqual({ n: 2 })
  })

  it('GET 结束后不保留缓存：下一次请求重新发', async () => {
    const fetchMock = vi.fn(async () => envelope({ n: 3 }))
    vi.stubGlobal('fetch', fetchMock)
    await request('/api/http-again')
    await request('/api/http-again')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('POST 不合并（写操作必须逐次到达）', async () => {
    const fetchMock = vi.fn(async () => envelope(1))
    vi.stubGlobal('fetch', fetchMock)
    await request('/api/http-write', { method: 'POST', body: '{}' })
    await request('/api/http-write', { method: 'POST', body: '{}' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('写请求作废在途 GET 合并：写后 reload 不会 join 写前的旧 GET', async () => {
    const pending: Array<(res: Response) => void> = []
    const fetchMock = vi.fn((_path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(envelope(0))
      return new Promise<Response>((resolve) => pending.push(resolve))
    })
    vi.stubGlobal('fetch', fetchMock)

    const before = request('/api/http-stale')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await request('/api/http-stale-write', { method: 'POST', body: '{}' })
    const after = request('/api/http-stale')
    // GET A + POST + GET B（B 没有 join A）
    expect(fetchMock).toHaveBeenCalledTimes(3)

    pending[0]?.(envelope({ n: 'before' }))
    pending[1]?.(envelope({ n: 'after' }))
    await expect(before).resolves.toEqual({ n: 'before' })
    await expect(after).resolves.toEqual({ n: 'after' })
  })

  it('调用方 headers 不会覆盖默认 content-type', async () => {
    const fetchMock = vi.fn(async () => envelope(1))
    vi.stubGlobal('fetch', fetchMock)
    await request('/api/http-headers', { headers: { 'x-trace': 't1' } })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-trace']).toBe('t1')
  })
})
