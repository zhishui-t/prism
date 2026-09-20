/**
 * D-v15-2 回归（v15 黑盒 major）：大内容 deposit/import 管线栈溢出。
 *
 * 缺陷：落库链上的 `bigram()` 用 `String.fromCodePoint(...cps.slice(i, j))` 展开
 * 整个连段成实参 → 单一连段 >~1.2e5 码点时 `internal: Maximum call stack size
 * exceeded`。黑盒在 268,868 字符上稳定复现（147k 级别成功），后果是 >262,144
 * 字符条目的**降级路径从未真实到达**（条目根本落不了库）。
 *
 * 本文件跑「落库 → 段切分 → 两路 FTS → 检索命中」的整链，且全部临时目录（R5）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'

/** web 侧「>256KB 降级源码视图」阈值的字节级口径（`apps/web/src/pages/Knowledge.tsx`）。 */
const WEB_DEGRADE_THRESHOLD = 262_144

/** 黑盒稳定复现长度：黑盒缺陷单里的原样样本。 */
const BLACKBOX_LEN = 268_868

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-large-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一份「总长 ≥ n、含独立可检索小节」的大正文——大而不单调，两路 FTS 都非空。 */
function bigDoc(n: number): string {
  const half = Math.ceil(n / 2)
  return `# 大文档\n\n${'甲'.repeat(half)}\n\n## 关键节\n独角鲸落在大文档尾部\n\n${'乙'.repeat(half)}\n`
}

describe('D-v15-2 大内容 deposit 全链（≥268,868 字符）', () => {
  it('deposit 不抛 internal，条目与段均可检索', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome() })
    try {
      const content = bigDoc(BLACKBOX_LEN)
      expect(content.length).toBeGreaterThanOrEqual(BLACKBOX_LEN)

      const result = await kb.deposit({
        id: 'BIG-DOC',
        title: '大文档落库',
        type: 'doc',
        layer: 'global',
        book: 'big',
        module: 'm',
        content,
      })
      expect(result.action).not.toBe('unchanged')

      // 正文逐字节落盘可取回（文件为真相 R7）
      const entry = await kb.get('BIG-DOC')
      expect(entry?.content).toBe(content)

      // 条目级 FTS + 段级 FTS 都有行 → 检索命中（标题词与正文词各验一次）
      const hits = await kb.search({ q: '独角鲸' })
      expect(hits.map((h) => h.id)).toContain('BIG-DOC')
      const byTitle = await kb.search({ q: '大文档落库' })
      expect(byTitle.map((h) => h.id)).toContain('BIG-DOC')

      // 段定位可用（W-2/W-3 的落点信息来自这两列）
      const chunkCount = kb.persistence.knowledge.raw
        .prepare('SELECT count(*) AS c FROM kb_chunks WHERE entry_id = ?')
        .get('BIG-DOC') as unknown as { c: number }
      expect(chunkCount.c).toBeGreaterThan(1)
    } finally {
      kb.close()
    }
  }, 60_000)

  it('黑盒报告的首个失败带（150,000 字符级）同样落库成功', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome() })
    try {
      const content = bigDoc(150_000)
      await kb.deposit({
        id: 'BIG-150K',
        title: '十五万字级文档',
        type: 'doc',
        layer: 'global',
        book: 'big',
        module: 'm',
        content,
      })
      expect((await kb.get('BIG-150K'))?.content.length).toBe(content.length)
    } finally {
      kb.close()
    }
  }, 60_000)

  it('>262,144 字符的条目现在真的落得下（web >256KB 降级路径可达）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome() })
    try {
      const content = bigDoc(BLACKBOX_LEN)
      await kb.deposit({
        id: 'BIG-THRESHOLD',
        title: '超阈值文档',
        type: 'doc',
        layer: 'global',
        book: 'big',
        module: 'm',
        content,
      })
      const entry = await kb.get('BIG-THRESHOLD')
      expect(entry).not.toBeNull()
      // 修前此处根本走不到（deposit 先抛 RangeError）→ 前端 >256KB 降级视图无数据可降
      expect(entry!.content.length).toBeGreaterThan(WEB_DEGRADE_THRESHOLD)
    } finally {
      kb.close()
    }
  }, 60_000)
})
