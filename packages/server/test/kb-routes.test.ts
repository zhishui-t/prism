import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer } from '../src/app.js'
import { MemoryKb, makeTempDir } from './helpers.js'
import type { AppHandle } from '../src/app.js'

describe('kb 路由（注入内存桩，不依赖 @prism/knowledge）', () => {
  let app: AppHandle
  let base: string
  let home: string
  const kb = new MemoryKb()

  beforeAll(async () => {
    home = await makeTempDir('prism-kb-routes-')
    app = await startServer({ home, kb, port: 0 })
    base = `http://127.0.0.1:${app.port}`
    await kb.deposit({
      id: 'kb-perf',
      title: '性能优化守则',
      type: 'rule',
      layer: 'project',
      owner: 'prism',
      book: 'handbook',
      content: '遇到性能问题先量化，再做优化。',
      tags: ['性能'],
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /api/health → ok:true + version/home/uptime', async () => {
    const res = await fetch(`${base}/api/health`)
    const body = (await res.json()) as { ok: boolean; value: Record<string, unknown> }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.version).toBe('0.1.0')
    expect(body.value.home).toBe(home)
    expect(Number(body.value.uptime)).toBeGreaterThanOrEqual(0)
  })

  it('GET /api/kb/search?q= → 命中', async () => {
    const res = await fetch(`${base}/api/kb/search?q=${encodeURIComponent('性能')}`)
    const body = (await res.json()) as { ok: boolean; value: Array<{ id: string; source: string }> }
    expect(body.ok).toBe(true)
    expect(body.value.length).toBeGreaterThanOrEqual(1)
    expect(body.value[0].id).toBe('kb-perf')
    expect(body.value[0].source).toContain('kb-perf@1')
  })

  it('GET /api/kb/search 缺 q → bad_request', async () => {
    const res = await fetch(`${base}/api/kb/search`)
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })

  it('GET /api/kb/search?layers= 非法层 → bad_request', async () => {
    const res = await fetch(`${base}/api/kb/search?q=x&layers=badlayer`)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('bad_request')
  })

  it('GET /api/kb/get/:id → 条目', async () => {
    const res = await fetch(`${base}/api/kb/get/kb-perf`)
    const body = (await res.json()) as { ok: boolean; value: { id: string; version: number } }
    expect(body.ok).toBe(true)
    expect(body.value.version).toBe(1)
  })

  it('GET /api/kb/get/不存在 → not_found', async () => {
    const res = await fetch(`${base}/api/kb/get/nope`)
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })

  it('GET /api/kb/tree 与 /api/kb/stats', async () => {
    const tree = await fetch(`${base}/api/kb/tree`)
    expect(((await tree.json()) as { value: unknown[] }).value).toEqual([])
    const stats = await fetch(`${base}/api/kb/stats`)
    const statsBody = (await stats.json()) as { ok: boolean; value: { entries: number } }
    expect(statsBody.ok).toBe(true)
    expect(statsBody.value.entries).toBe(1)
  })

  it('POST /api/kb/deposit → {id,version,path}', async () => {
    const res = await fetch(`${base}/api/kb/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'kb-perf',
        title: '性能优化守则',
        type: 'rule',
        layer: 'project',
        owner: 'prism',
        book: 'handbook',
        content: '第二版内容。',
      }),
    })
    const body = (await res.json()) as { ok: boolean; value: { id: string; version: number } }
    expect(body.ok).toBe(true)
    expect(body.value.version).toBe(2)
  })

  it('POST /api/kb/deposit 缺必填字段 → bad_request', async () => {
    const res = await fetch(`${base}/api/kb/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '只有标题' }),
    })
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('必填')
  })

  it('POST /api/kb/deposit project 层缺 owner → bad_request', async () => {
    const res = await fetch(`${base}/api/kb/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', type: 'doc', layer: 'project', book: 'b', content: 'c' }),
    })
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('owner')
  })
})

describe('知识图谱路由（GET /api/kb/graph、/api/kb/path）', () => {
  let app: AppHandle
  let base: string
  let home: string
  const kb = new MemoryKb()

  beforeAll(async () => {
    home = await makeTempDir('prism-kb-graph-routes-')
    app = await startServer({ home, kb, port: 0 })
    base = `http://127.0.0.1:${app.port}`
    await kb.deposit({ id: 'G-A', title: 'A', type: 'rule', layer: 'global', book: 'b', content: 'A' })
    await kb.deposit({ id: 'G-B', title: 'B', type: 'rule', layer: 'global', book: 'b', content: 'B 引用 [[G-A]]' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /api/kb/graph?id= → 邻域节点 + 边', async () => {
    const res = await fetch(`${base}/api/kb/graph?id=G-B`)
    const body = (await res.json()) as {
      ok: boolean
      value: { root: string; nodes: Array<{ id: string }>; edges: Array<{ from_id: string; to_id: string }> }
    }
    expect(body.ok).toBe(true)
    expect(body.value.root).toBe('G-B')
    expect(body.value.edges.map((e) => `${e.from_id}->${e.to_id}`)).toContain('G-B->G-A')
  })

  it('GET /api/kb/graph → 概览', async () => {
    const res = await fetch(`${base}/api/kb/graph`)
    const body = (await res.json()) as { ok: boolean; value: { nodes: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.value.nodes.length).toBeGreaterThanOrEqual(2)
  })

  it('GET /api/kb/path?from&to → 路径；不可达 → 404', async () => {
    const found = await fetch(`${base}/api/kb/path?from=G-B&to=G-A`)
    const foundBody = (await found.json()) as { ok: boolean; value: { nodes: string[] } }
    expect(foundBody.ok).toBe(true)
    expect(foundBody.value.nodes).toEqual(['G-B', 'G-A'])

    const missing = await fetch(`${base}/api/kb/path?from=G-A&to=nope`)
    expect(missing.status).toBe(404)
    const missingBody = (await missing.json()) as { ok: boolean; error: { code: string } }
    expect(missingBody.ok).toBe(false)
    expect(missingBody.error.code).toBe('not_found')
  })

  it('GET /api/kb/path 缺参数 → bad_request', async () => {
    const res = await fetch(`${base}/api/kb/path?from=G-A`)
    expect(res.status).toBe(400)
  })

  it('GET /api/kb/graph?relations=非法 → bad_request', async () => {
    const res = await fetch(`${base}/api/kb/graph?relations=bogus`)
    expect(res.status).toBe(400)
  })
})
