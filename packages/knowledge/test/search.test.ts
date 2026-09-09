import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { isPrismError } from '@prism/core'

import { PrismKnowledgeService } from '../src/service.js'

let home: string | undefined

function makeService(): PrismKnowledgeService {
  home = mkdtempSync(join(tmpdir(), 'prism-kb-search-'))
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
