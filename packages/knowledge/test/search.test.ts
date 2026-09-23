import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { isPrismError, prismTmpPrefix } from '@prism/core'

import { setOcrHooks, toMarkdown } from '../src/convert.js'
import { PrismKnowledgeService } from '../src/service.js'

let home: string | undefined

function makeService(): PrismKnowledgeService {
  home = mkdtempSync(join(tmpdir(), prismTmpPrefix('kb-search')))
  return new PrismKnowledgeService({ home })
}

let service: PrismKnowledgeService | undefined
let perfId = ''
let exceptionId = ''

async function seed(): Promise<PrismKnowledgeService> {
  if (service) return service
  service = makeService()
  perfId = (
    await service.deposit({
      id: 'PERF-001',
      title: '性能优化指南',
      type: 'guide',
      layer: 'global',
      book: 'perf-book',
      module: 'performance',
      content: '提升性能要从缓存入手：接口性能优化的第一步是建立基准，再谈性能调优。',
      tags: ['perf'],
    })
  ).id
  exceptionId = (
    await service.deposit({
      id: 'JAVA-01-002',
      title: '禁止吞掉异常',
      type: 'rule',
      layer: 'project',
      owner: 'prism-demo',
      book: 'java-standards',
      module: 'exception-handling',
      content: '全局异常处理器必须统一捕获并记录日志，禁止在 catch 块里静默吞掉业务异常。',
      risk: 'high',
      confidence: 0.9,
    })
  ).id
  await service.deposit({
    id: 'DOC-LOG-1',
    title: 'Logging handbook',
    type: 'doc',
    layer: 'global',
    book: 'handbooks',
    content: 'Structured logging with database trace id correlation.',
  })
  return service
}

afterAll(() => {
  service?.close()
})

describe('中文检索（F02 验收：两字/四字词必须命中）', () => {
  it('两字词「性能」命中含该词的条目', async () => {
    const svc = await seed()
    const results = await svc.search({ q: '性能' })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((r) => r.id === perfId)).toBe(true)
  })

  it('两字词「日志」命中正文含日志的条目', async () => {
    const svc = await seed()
    const results = await svc.search({ q: '日志' })
    expect(results.some((r) => r.id === exceptionId)).toBe(true)
  })

  it('四字词「异常处理」命中', async () => {
    const svc = await seed()
    const results = await svc.search({ q: '异常处理' })
    expect(results.some((r) => r.id === exceptionId)).toBe(true)
  })

  it('查询串按同样 bigram 规则处理（中英混排）', async () => {
    const svc = await seed()
    const results = await svc.search({ q: '性能优化' })
    expect(results.some((r) => r.id === perfId)).toBe(true)
  })

  it('英文大小写不敏感', async () => {
    const svc = await seed()
    const results = await svc.search({ q: 'database' })
    expect(results.some((r) => r.id === 'DOC-LOG-1')).toBe(true)
  })

  it('无关词返回空数组而不是报错', async () => {
    const svc = await seed()
    const results = await svc.search({ q: '区块链元宇宙' })
    expect(results).toEqual([])
  })
})

describe('过滤与结果形态', () => {
  it('layer 过滤：project 层查不到 global 条目', async () => {
    const svc = await seed()
    const results = await svc.search({ q: '性能', layers: ['project'] })
    expect(results.some((r) => r.id === perfId)).toBe(false)
    const byOwner = await svc.search({ q: '异常', owner: 'prism-demo' })
    expect(byOwner.some((r) => r.id === exceptionId)).toBe(true)
    const wrongOwner = await svc.search({ q: '异常', owner: 'other-project' })
    expect(wrongOwner).toEqual([])
  })

  it('book/module 过滤', async () => {
    const svc = await seed()
    const byBook = await svc.search({ q: '性能', book: 'perf-book' })
    expect(byBook.some((r) => r.id === perfId)).toBe(true)
    const wrongBook = await svc.search({ q: '性能', book: 'no-such-book' })
    expect(wrongBook).toEqual([])
    const byModule = await svc.search({ q: '异常', module: 'exception-handling' })
    expect(byModule.some((r) => r.id === exceptionId)).toBe(true)
  })

  it('limit 生效（默认 10）', async () => {
    const svc = await seed()
    for (let i = 0; i < 12; i++) {
      await svc.deposit({
        id: `BULK-${String(i).padStart(2, '0')}`,
        title: `缓存笔记 ${i}`,
        type: 'doc',
        layer: 'global',
        book: 'bulk',
        content: `缓存性能笔记第 ${i} 篇`,
      })
    }
    const defaultResults = await svc.search({ q: '缓存' })
    expect(defaultResults.length).toBe(10)
    const limited = await svc.search({ q: '缓存', limit: 3 })
    expect(limited.length).toBe(3)
  })

  it('SearchResult 形态：excerpt 摘录命中词、source 为 层[/owner]/书/模块/ID@vN', async () => {
    const svc = await seed()
    // 两词 AND：性能 + 基准 同时出现（bigram AND 语义 = 连续子串包含）
    const [hit] = await svc.search({ q: '性能 基准' })
    expect(hit.id).toBe(perfId)
    expect(hit.excerpt).toContain('基准')
    expect(hit.score).toBeGreaterThan(0)
    const [owned] = await svc.search({ q: '吞掉异常' })
    expect(owned.source).toBe('project/prism-demo/java-standards/exception-handling/JAVA-01-002@v1')
    const [globalHit] = await svc.search({ q: '性能优化指南' })
    expect(globalHit.source).toBe('global/perf-book/performance/PERF-001@v1')
  })

  it('空检索词抛 bad_request', async () => {
    const svc = await seed()
    await expect(svc.search({ q: '' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(svc.search({ q: '  ' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(svc.search({ q: '!!!' })).rejects.toMatchObject({ code: 'bad_request' })
    try {
      await svc.search({ q: '' })
    } catch (error) {
      expect(isPrismError(error)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// v17 A3.1 / A4.2：占位与内嵌图 OCR 文本**进 FTS**（口径声明——无需特殊代码路径）
// ---------------------------------------------------------------------------

afterEach(() => {
  setOcrHooks(null)
})

describe('v17 公式占位与内嵌图文本可检索（A3.1 / A4.2）', () => {
  it('`[公式]` 与 `> [图片 N]` 是正文文本：搜「公式」「图片」均命中', async () => {
    const svc = new PrismKnowledgeService({ home: mkdtempSync(join(tmpdir(), prismTmpPrefix('kb-v17'))) })
    try {
      await svc.deposit({
        id: 'PLACEHOLDER-1',
        title: '公式与内嵌图文档',
        type: 'doc',
        layer: 'global',
        book: 'v17-docs',
        content: '推导过程如下。\n\n[公式]\n\n> [图片 1] 这段是内嵌截图里的说明文字。\n',
      })
      // 占位符本身是内容：「公式在此」可检索（SPEC-A3.1 口径声明）
      expect((await svc.search({ q: '公式' })).some((r) => r.id === 'PLACEHOLDER-1')).toBe(true)
      // 引用块标记可检索（SPEC-A4.2）
      expect((await svc.search({ q: '图片' })).some((r) => r.id === 'PLACEHOLDER-1')).toBe(true)
    } finally {
      svc.close()
    }
  })

  it('docx 内嵌图 OCR 文本落库后可检索（A4.1 → A4.2 端到端）', async (ctx) => {
    const path = fileURLToPath(new URL('../../../3rd/ocr/fixtures/embed-image.docx', import.meta.url))
    if (!existsSync(path)) return ctx.skip() // 生成脚本：python 3rd/ocr/gen_docx_fixtures.py

    setOcrHooks({
      available: () => true,
      run: async () => ({ ok: true, markdown: '## 第 1 页\n\n截图里的关键结论' }),
    })
    const converted = await toMarkdown(new Uint8Array(readFileSync(path)), '报告.docx')
    setOcrHooks(null)
    expect(converted.status).toBe('converted')
    expect(converted.markdown).toContain('> [图片 1] 截图里的关键结论')

    const svc = new PrismKnowledgeService({ home: mkdtempSync(join(tmpdir(), prismTmpPrefix('kb-v17'))) })
    try {
      await svc.deposit({
        id: 'EMBED-1',
        title: '内嵌图文档',
        type: 'doc',
        layer: 'global',
        book: 'v17-docs',
        content: converted.markdown,
      })
      // OCR 出来的图内文字与正常文本同口径，可检索
      expect((await svc.search({ q: '截图' })).some((r) => r.id === 'EMBED-1')).toBe(true)
      expect((await svc.search({ q: '图片' })).some((r) => r.id === 'EMBED-1')).toBe(true)
    } finally {
      svc.close()
    }
  })
})
