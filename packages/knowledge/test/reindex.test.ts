import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeService(): PrismKnowledgeService {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-reindex-'))
  dirs.push(home)
  return new PrismKnowledgeService({ home })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('kb reindex（Z2：以文件为真相重建索引）', () => {
  it('重建后检索命中手工编辑的标题与正文；索引与文件一致', async () => {
    const service = makeService()
    try {
      const v1 = await service.deposit({
        id: 'K-1',
        title: '异常处理规范',
        type: 'rule',
        layer: 'project',
        owner: 'team-a',
        book: 'java',
        module: 'exception',
        content: '异常必须记录上下文。',
      })
      // 手工改文件标题（模拟外部编辑）——DB 索引未变
      writeFileSync(
        v1.path,
        `---\nid: K-1\nversion: 1\ntitle: 异常处理铁律\ntype: rule\nlayer: project\nowner: team-a\nbook: java\nmodule: exception\nstatus: active\n---\n\n异常必须记录上下文 id。\n`,
        'utf-8',
      )
      // 重建前：旧标题仍可命中，新标题不可
      expect((await service.search({ q: '异常处理规范' })).length).toBeGreaterThan(0)
      expect(await service.search({ q: '铁律' })).toHaveLength(0)

      const report = await service.reindex()
      expect(report.scanned).toBe(1)
      expect(report.indexed).toBe(1)
      expect(report.skipped).toBe(0)

      // 重建后：新标题命中，owner 列由 frontmatter 落库
      const hits = await service.search({ q: '铁律' })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.title).toBe('异常处理铁律')
      expect(hits[0]?.owner).toBe('team-a')
      const entry = await service.get('K-1')
      expect(entry?.title).toBe('异常处理铁律')
      expect(entry?.owner).toBe('team-a')
    } finally {
      service.close()
    }
  })

  it('多版次：max(version) 判 is_latest，历史版 superseded；坏文件记入 errors 不中断', async () => {
    const service = makeService()
    try {
      await service.deposit({ id: 'K-2', title: 'T1', type: 'doc', layer: 'global', book: 'b', content: '第一版' })
      await service.deposit({ id: 'K-2', title: 'T2', type: 'doc', layer: 'global', book: 'b', content: '第二版' })
      // 落一个缺 frontmatter 的坏版次文件（无 module → _inbox 段）
      writeFileSync(join(service.knowledgeDir, 'global', 'b', '_inbox', 'K-2', 'v99.md'), '没有 frontmatter\n', 'utf-8')

      const report = await service.reindex()
      expect(report.scanned).toBe(3) // v01 + v02 + v99
      expect(report.indexed).toBe(2)
      expect(report.skipped).toBe(1)
      expect(report.errors[0]?.path).toContain('v99.md')

      expect((await service.get('K-2'))?.version).toBe(2)
      expect((await service.get('K-2', 1))?.status).toBe('superseded')
      expect((await service.get('K-2', 2))?.status).toBe('active')
    } finally {
      service.close()
    }
  })
})

/** F-A4：`EntryStatus` 4 值全量往返；4 值之外不静默（warning + 回落 active）。 */
describe('status 往返（F-A4）', () => {
  async function makeWithFile(status: string): Promise<{ kb: PrismKnowledgeService; file: string }> {
    const kb = makeService()
    const deposited = await kb.deposit({
      id: 'S-1',
      title: '状态往返',
      type: 'rule',
      layer: 'global',
      book: 'b',
      module: 'm',
      content: '状态往返正文。',
    })
    const text = readFileSync(deposited.path, 'utf-8')
    writeFileSync(deposited.path, text.replace('status: active', `status: ${status}`), 'utf-8')
    return { kb, file: deposited.path }
  }

  it('latest 版写 candidate → reindex 后仍为 candidate（不再被压平成 active）', async () => {
    const { kb } = await makeWithFile('candidate')
    try {
      expect((await kb.get('S-1'))?.status).toBe('active') // 未重扫前 DB 仍是旧值
      await kb.reindex()
      expect((await kb.get('S-1'))?.status).toBe('candidate')
    } finally {
      kb.close()
    }
  })

  it('latest 版写 superseded → reindex 后仍为 superseded', async () => {
    const { kb } = await makeWithFile('superseded')
    try {
      await kb.reindex()
      expect((await kb.get('S-1'))?.status).toBe('superseded')
    } finally {
      kb.close()
    }
  })

  it('4 值之外（candidate-x）→ warning + 回落 active（不静默）', async () => {
    const { kb } = await makeWithFile('candidate-x')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const report = await kb.reindex()
      expect(report.skipped).toBe(0) // 回落而非跳过
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('candidate-x')
      expect((await kb.get('S-1'))?.status).toBe('active')
    } finally {
      warn.mockRestore()
      kb.close()
    }
  })

  it('软删 → 改源 → 重扫 → 仍 deprecated（BLK-2 回归，status 不复活）', async () => {
    const kb = makeService()
    try {
      const deposited = await kb.deposit({
        id: 'S-2',
        title: '软删条目',
        type: 'rule',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '软删正文。',
      })
      await kb.remove('S-2')
      const text = readFileSync(deposited.path, 'utf-8')
      writeFileSync(deposited.path, text.replace('软删正文。', '软删正文（外部改过）。'), 'utf-8')
      await kb.reindex()
      expect((await kb.get('S-2'))?.status).toBe('deprecated')
    } finally {
      kb.close()
    }
  })
})

/** QA BLK-1 回归：reindex 只重建自有型，引用型必须存活。 */
describe('reindex 与引用型共存（BLK-1 回归）', () => {
  it('混合库 reindex 后：引用型仍在、自有型被重建', async () => {
    const { PrismKnowledgeService } = await import('../src/service.js')
    const { makeTempDir } = await import('../../server/test/helpers.js')
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-reindex-mix-') })

    // 自有型（写版次文件，reindex 会重建）
    await kb.deposit({ id: 'OWN-1', title: '自有规则', type: 'rule', layer: 'global', book: 'b', content: '自有内容' })
    // 引用型（不写版次文件，path 指向项目原件）
    await kb.index({
      id: 'IDX-1',
      title: '项目文档',
      layer: 'project',
      owner: 'p',
      book: 'p',
      path: 'D:/proj/README.md',
      source_hash: 'h1',
      content: '项目文档内容，含关键词 订单',
    })

    const report = await kb.reindex()
    expect(report.scanned).toBe(1) // 只有自有型的 v01.md
    expect(report.indexed).toBe(1)

    // 引用型必须存活（这是 BLK-1 的核心断言）
    const indexed = await kb.get('IDX-1')
    expect(indexed).not.toBeNull()
    expect(indexed?.origin).toBe('indexed')
    expect(indexed?.source_hash).toBe('h1')
    expect((await kb.search({ q: '订单' })).length).toBe(1)

    // 自有型重建后仍可检索
    expect((await kb.search({ q: '自有' })).length).toBe(1)
    kb.close()
  })
})
