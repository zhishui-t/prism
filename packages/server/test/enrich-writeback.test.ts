import { describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '@prism/knowledge'

import { writeEnrichment } from '../src/kb/enrich-writeback.js'
import { makeTempDir } from './helpers.js'

/** 富化结果回写（work→kb 流程⑤）。 */
describe('writeEnrichment', () => {
  it('summarize → 落 SUMMARY 条目并双链原条目', async () => {
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-wb-') })
    await kb.deposit({ id: 'E-1', title: '原条目', type: 'rule', layer: 'global', book: 'b', content: '正文' })

    const report = await writeEnrichment(kb, {
      kind: 'summarize',
      payload: { entry_id: 'E-1', book: 'b' },
      result: { summary: '这是一段摘要。' },
    })
    expect(report?.action).toBe('created')

    const summary = await kb.get('SUMMARY-E-1')
    expect(summary?.type).toBe('summary')
    expect(summary?.content).toContain('[[E-1]]')
    // 双链建边
    const graph = await kb.graph({ id: 'SUMMARY-E-1', depth: 1 })
    expect(graph.edges.some((e) => e.from_id === 'SUMMARY-E-1' && e.to_id === 'E-1')).toBe(true)
    kb.close()
  })

  it('classify → 标签合并回原条目；标签未变不产生新版次', async () => {
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-wb-') })
    await kb.deposit({ id: 'E-1', title: 'T', type: 'rule', layer: 'global', book: 'b', content: 'x', tags: ['a'] })

    const first = await writeEnrichment(kb, {
      kind: 'classify',
      payload: { entry_id: 'E-1' },
      result: { labels: ['b', 'c'] },
    })
    expect(first?.action).toBe('updated')
    expect((await kb.get('E-1'))?.tags.sort()).toEqual(['a', 'b', 'c'])

    // 重复回写相同标签 → unchanged（去重生效）
    const again = await writeEnrichment(kb, {
      kind: 'classify',
      payload: { entry_id: 'E-1' },
      result: { labels: ['a', 'b', 'c'] },
    })
    expect(again?.action).toBe('unchanged')
    kb.close()
  })

  it('extract_entities → 实体条目 + relations 双链边', async () => {
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-wb-') })
    const report = await writeEnrichment(kb, {
      kind: 'extract_entities',
      payload: { book: 'proj' },
      result: {
        entities: [
          { id: 'OrderService', type: 'class', label: '订单服务' },
          { id: 'PayService', type: 'class', label: '支付服务' },
        ],
        relations: [{ from: 'OrderService', to: 'PayService', relation: 'calls' }],
      },
    })
    expect(report?.action).toBe('written')
    expect(report?.detail).toContain('实体 2')
    expect(report?.detail).toContain('关系边 1')

    expect(await kb.get('ENT-OrderService')).not.toBeNull()
    // 关系边经双链建立
    const graph = await kb.graph({ id: 'ENT-OrderService', depth: 1 })
    expect(graph.edges.some((e) => e.from_id === 'ENT-OrderService' && e.to_id === 'ENT-PayService')).toBe(true)
    kb.close()
  })

  it('payload 缺 entry_id（summarize）→ skipped 不炸', async () => {
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-wb-') })
    const report = await writeEnrichment(kb, {
      kind: 'summarize',
      payload: {},
      result: { summary: 'x' },
    })
    expect(report?.action).toBe('skipped')
    kb.close()
  })

  it('原条目不存在（classify）→ skipped', async () => {
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-wb-') })
    const report = await writeEnrichment(kb, {
      kind: 'classify',
      payload: { entry_id: 'ghost' },
      result: { labels: ['x'] },
    })
    expect(report?.action).toBe('skipped')
    kb.close()
  })

  it('embed（无回写消费端）→ 返回 null', async () => {
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-wb-') })
    const report = await writeEnrichment(kb, {
      kind: 'embed',
      payload: { entry_id: 'x' },
      result: { vector: [0.1, 0.2] },
    })
    expect(report).toBeNull()
    kb.close()
  })
})
