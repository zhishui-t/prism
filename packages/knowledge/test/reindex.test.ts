import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

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
