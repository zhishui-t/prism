import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { makeTempDir } from './helpers.js'

/** 合法架构图 IR（archify 要求显式 pos/size）。 */
const VALID_IR = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'HTTP 测试架构' },
  components: [
    { id: 'a', type: 'frontend', label: '前端', pos: [40, 200], size: [140, 68] },
    { id: 'b', type: 'backend', label: '后端', pos: [240, 200], size: [140, 68] },
  ],
  connections: [{ id: 'a-b', from: 'a', to: 'b', label: '调用' }],
}

describe('架构图谱路由（Archify 封装：types/validate/render/preview）', () => {
  let app: AppHandle
  let base: string

  beforeAll(async () => {
    const home = await makeTempDir('prism-arch-routes-')
    app = await startServer({ home, kb: undefined as never, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('GET /api/arch/types → 五类图', async () => {
    const body = (await (await fetch(`${base}/api/arch/types`)).json()) as {
      ok: boolean
      value: Array<{ type: string; label: string }>
    }
    expect(body.ok).toBe(true)
    expect(body.value.map((t) => t.type)).toEqual([
      'architecture',
      'sequence',
      'lifecycle',
      'dataflow',
      'workflow',
    ])
    expect(body.value[0]?.label).toBe('架构图')
  })

  it('POST /api/arch/validate → ok:true（合法 IR）；非法 IR → value.ok:false', async () => {
    const good = (await (await post('/api/arch/validate', { type: 'architecture', ir: VALID_IR })).json()) as {
      ok: boolean
      value: { ok: boolean; problems: unknown[] }
    }
    expect(good.ok).toBe(true)
    expect(good.value.ok).toBe(true)

    const bad = (await (
      await post('/api/arch/validate', {
        type: 'architecture',
        ir: { schema_version: 1, diagram_type: 'architecture', meta: { title: 'x' }, components: [], connections: [] },
      })
    ).json()) as { ok: boolean; value: { ok: boolean; problems: unknown[] } }
    expect(bad.ok).toBe(true)
    expect(bad.value.ok).toBe(false)
  })

  it('POST /api/arch/render → 落盘 HTML + IR；GET preview 可取回', async () => {
    const render = (await (
      await post('/api/arch/render', { type: 'architecture', ir: VALID_IR, name: 'demo' })
    ).json()) as {
      ok: boolean
      value: { type: string; name: string; bytes: number; preview: string }
    }
    expect(render.ok).toBe(true)
    expect(render.value.name).toBe('demo.html')
    expect(render.value.bytes).toBeGreaterThan(100_000)
    expect(render.value.preview).toBe('/api/arch/preview/architecture/demo.html')

    const preview = await fetch(`${base}${render.value.preview}`)
    expect(preview.status).toBe(200)
    expect(preview.headers.get('content-type')).toContain('text/html')
    const html = await preview.text()
    expect(html).toContain('<script')

    // 产物列表出现
    const list = (await (await fetch(`${base}/api/arch/diagrams`)).json()) as {
      ok: boolean
      value: Array<{ type: string; name: string }>
    }
    expect(list.value.map((d) => `${d.type}/${d.name}`)).toContain('architecture/demo.html')
  })

  it('preview 防穿越 / 非法类型 → 4xx', async () => {
    expect((await fetch(`${base}/api/arch/preview/architecture/..%2F..%2Fetc%2Fpasswd`)).status).toBeGreaterThanOrEqual(400)
    expect((await fetch(`${base}/api/arch/preview/bogus/x.html`)).status).toBe(400)
    expect((await fetch(`${base}/api/arch/preview/architecture/nope.html`)).status).toBe(404)
  })

  it('POST /api/arch/validate 缺 ir / 非法类型 → 400', async () => {
    expect((await post('/api/arch/validate', { type: 'architecture' })).status).toBe(400)
    expect((await post('/api/arch/validate', { type: 'bogus', ir: VALID_IR })).status).toBe(400)
  })

  it('render 带作用域 → sidecar 元数据落盘，diagrams 按 book/module 过滤', async () => {
    // 两个不同作用域的产物：java-standards/exception 与 java-standards/naming
    const a = (await (
      await post('/api/arch/render', {
        type: 'architecture',
        ir: VALID_IR,
        name: 'scoped-a',
        book: 'java-standards',
        module: 'exception',
        layer: 'global',
      })
    ).json()) as {
      ok: boolean
      value: { meta: { book?: string; module?: string; ir_hash: string; archify_version: string } }
    }
    expect(a.ok).toBe(true)
    expect(a.value.meta.book).toBe('java-standards')
    expect(a.value.meta.module).toBe('exception')
    expect(a.value.meta.archify_version).toBe('2.16.0')
    expect(a.value.meta.ir_hash).toMatch(/^[0-9a-f]{16}$/)

    await post('/api/arch/render', {
      type: 'architecture',
      ir: VALID_IR,
      name: 'scoped-b',
      book: 'java-standards',
      module: 'naming',
      layer: 'global',
    })
    // 另一本书，确保过滤真的按书隔离
    await post('/api/arch/render', {
      type: 'architecture',
      ir: VALID_IR,
      name: 'scoped-c',
      book: 'other-book',
      module: 'misc',
      layer: 'global',
    })

    const byBook = (await (
      await fetch(`${base}/api/arch/diagrams?book=${encodeURIComponent('java-standards')}`)
    ).json()) as { value: Array<{ name: string; book?: string; title?: string; has_ir: boolean }> }
    expect(byBook.value.map((d) => d.name).sort()).toEqual(['scoped-a.html', 'scoped-b.html'])
    expect(byBook.value.every((d) => d.book === 'java-standards')).toBe(true)
    // 标题取自 IR meta.title；IR 源存在
    expect(byBook.value[0]?.title).toBe('HTTP 测试架构')
    expect(byBook.value.every((d) => d.has_ir)).toBe(true)

    const byModule = (await (
      await fetch(`${base}/api/arch/diagrams?book=java-standards&module=exception`)
    ).json()) as { value: Array<{ name: string }> }
    expect(byModule.value.map((d) => d.name)).toEqual(['scoped-a.html'])

    // 未指定作用域的旧产物仍出现在全量列表
    const all = (await (await fetch(`${base}/api/arch/diagrams`)).json()) as { value: Array<{ name: string }> }
    expect(all.value.map((d) => d.name)).toContain('demo.html')
  })

  it('GET /api/arch/ir/:type/:file → IR 源 + 元数据；防穿越', async () => {
    const res = await fetch(`${base}/api/arch/ir/architecture/scoped-a.html`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      value: { ir: { meta: { title: string } }; meta: { book?: string; module?: string } | null }
    }
    expect(body.ok).toBe(true)
    expect(body.value.ir.meta.title).toBe('HTTP 测试架构')
    expect(body.value.meta?.book).toBe('java-standards')
    expect(body.value.meta?.module).toBe('exception')

    expect((await fetch(`${base}/api/arch/ir/architecture/..%2F..%2Fetc%2Fpasswd`)).status).toBeGreaterThanOrEqual(400)
    expect((await fetch(`${base}/api/arch/ir/architecture/nope.html`)).status).toBe(404)
  })
})
