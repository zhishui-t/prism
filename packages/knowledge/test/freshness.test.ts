/**
 * F-B1：把 DB `freshness` 列**读出来**（此前只落库、从不读出）。
 *
 * 关键断言：不是「返回了默认 1.0」，而是**手改 DB 列 / 手改 frontmatter 后能读到新值**——
 * 只有真读列才能通过（若实现写成常量 1.0 会红）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeService(): PrismKnowledgeService {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-fresh-'))
  dirs.push(home)
  return new PrismKnowledgeService({ home })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('新鲜度接通（F-B1）', () => {
  it('deposit 默认 freshness=1.0，get/search 都返回该字段', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'F-1',
        title: '缓存笔记',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '缓存必须设置过期时间。',
      })
      expect((await kb.get('F-1'))?.freshness).toBe(1)
      const [hit] = await kb.search({ q: '缓存' })
      expect(hit?.id).toBe('F-1')
      expect(hit?.freshness).toBe(1)
    } finally {
      kb.close()
    }
  })

  it('DB 列被改后 get/search 读出**新值**（证明真读列，而非常量）', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'F-2',
        title: '缓存策略',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '缓存策略正文。',
      })
      kb.persistence.knowledge.raw
        .prepare('UPDATE knowledge_entries SET freshness = ? WHERE id = ?')
        .run(0.25, 'F-2')

      expect((await kb.get('F-2'))?.freshness).toBe(0.25)
      expect((await kb.search({ q: '缓存策略' }))[0]?.freshness).toBe(0.25)
    } finally {
      kb.close()
    }
  })

  it('frontmatter freshness 经 reindex 重建后仍生效（文件为真相）', async () => {
    const kb = makeService()
    try {
      const deposited = await kb.deposit({
        id: 'F-3',
        title: '过期规则',
        type: 'rule',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '过期规则正文。',
      })
      const text = readFileSync(deposited.path, 'utf-8')
      writeFileSync(deposited.path, text.replace('freshness: 1', 'freshness: 0.3'), 'utf-8')
      // 先确认 DB 里的旧值还在（未被文件自动同步）
      expect((await kb.get('F-3'))?.freshness).toBe(1)

      await kb.reindex()
      expect((await kb.get('F-3'))?.freshness).toBe(0.3)
    } finally {
      kb.close()
    }
  })
})
