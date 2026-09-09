import { describe, expect, it, vi } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { makeTempDir } from '../../server/test/helpers.js'

/** A4：deposit 后自动投递富化任务（默认不注入 = 不入队）。 */
describe('落库后自动入队（A4）', () => {
  it('未注入回调 → 不入队（保持既有行为）', async () => {
    const home = await makeTempDir('prism-a4-')
    const kb = new PrismKnowledgeService({ home })
    // 不抛即可——内部无队列调用
    const result = await kb.deposit({
      title: 'T',
      type: 'rule',
      layer: 'global',
      book: 'b',
      content: '内容',
    })
    expect(result.version).toBe(1)
    kb.close()
  })

  it('注入回调 → 每次落库调用一次，带 id/version/位置', async () => {
    const home = await makeTempDir('prism-a4-')
    const seen: Array<{ id: string; version: number; book: string; module: string; type: string }> = []
    const kb = new PrismKnowledgeService({
      home,
      enqueueEnrichment: async (entry) => {
        seen.push(entry)
      },
    })

    await kb.deposit({ id: 'E-1', title: 'T', type: 'rule', layer: 'global', book: 'b', content: 'v1' })
    await kb.deposit({ id: 'E-1', title: 'T', type: 'rule', layer: 'global', book: 'b', content: 'v2' })

    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ id: 'E-1', version: 1, book: 'b', type: 'rule' })
    expect(seen[1]).toMatchObject({ id: 'E-1', version: 2 })
    kb.close()
  })

  it('引用型 index() 不触发富化入队（它是索引不是落库）', async () => {
    const home = await makeTempDir('prism-a4-')
    const spy = vi.fn()
    const kb = new PrismKnowledgeService({ home, enqueueEnrichment: spy })

    await kb.index({
      id: 'IDX-a',
      title: 'A',
      layer: 'project',
      owner: 'p',
      book: 'p',
      path: 'D:/a.md',
      source_hash: 'h',
      content: '内容',
    })
    expect(spy).not.toHaveBeenCalled()
    kb.close()
  })

  it('enrichmentEnabled 读 prism.yaml 开关，默认关闭', async () => {
    const { enrichmentEnabled } = await import('../../server/src/kb/wiring.js')
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const off = await makeTempDir('prism-a4-')
    expect(enrichmentEnabled(off)).toBe(false)

    const on = await makeTempDir('prism-a4-')
    await writeFile(join(on, 'prism.yaml'), 'harness: zcode\nenrich_on_deposit: true\n', 'utf-8')
    expect(enrichmentEnabled(on)).toBe(true)

    const commented = await makeTempDir('prism-a4-')
    await writeFile(join(commented, 'prism.yaml'), '# enrich_on_deposit: true\n', 'utf-8')
    expect(enrichmentEnabled(commented)).toBe(false)
  })
})
