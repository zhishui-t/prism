/**
 * 混合检索（变更 2）：注入假 embedding，验证 BM25 + 向量 RRF 融合行为。
 *
 * 关键场景：BM25 命中不了的**同义/跨语言**条目，靠向量召回补上（真实场景 =
 * 用户问「苹果」能找回「iPhone 手机壳」）；反向也验证 `hybrid: false` 可强制纯关键词。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'

/**
 * 假 embedding：按「语义桶」返回归一化 one-hot 向量。
 * 同一桶内文本余弦 = 1（视为同义），不同桶正交（余弦 = 0，低于 VECTOR_FLOOR 被过滤）。
 */
const BUCKETS: string[][] = [
  ['苹果', '手机', 'iPhone', 'apple', 'phone'],
  ['电脑', '笔记本', 'computer', 'laptop'],
  ['数据库', 'database', 'sql', '存储'],
]

function fakeEmbed(text: string): Promise<Float32Array | null> {
  const lower = text.toLowerCase()
  let bucket = -1
  for (let i = 0; i < BUCKETS.length; i++) {
    if (BUCKETS[i]!.some((kw) => lower.includes(kw.toLowerCase()))) {
      bucket = i
      break
    }
  }
  // 未命中任何桶 → 无向量（模拟「无法向量化」的降级路径）
  if (bucket < 0) return Promise.resolve(null)
  const v = new Float32Array(BUCKETS.length + 1)
  v[bucket] = 1
  return Promise.resolve(v)
}

let home: string | undefined
let service: PrismKnowledgeService | undefined

async function seed(): Promise<PrismKnowledgeService> {
  if (service) return service
  home = mkdtempSync(join(tmpdir(), 'prism-kb-hybrid-'))
  const svc = new PrismKnowledgeService({ home, embed: fakeEmbed })
  await svc.deposit({
    id: 'PHONE-1',
    title: 'iPhone 手机壳选购',
    type: 'doc',
    layer: 'global',
    book: 'gadgets',
    content: '适配 iPhone 15 的防摔手机壳，兼容 MagSafe。',
  })
  await svc.deposit({
    id: 'DB-1',
    title: '数据库连接池调优',
    type: 'guide',
    layer: 'global',
    book: 'backend',
    content: '连接池大小与慢查询排查。',
  })
  service = svc
  return svc
}

afterAll(() => {
  service?.close()
})

describe('混合检索（BM25 + 向量 RRF）', () => {
  it('BM25 命中不了的跨词条目，经向量召回补上', async () => {
    const svc = await seed()
    // 「苹果」不含于 PHONE-1 的任何 bigram → 纯 BM25 零命中
    const bm25Only = await svc.search({ q: '苹果', hybrid: false })
    expect(bm25Only).toHaveLength(0)
    // 向量把「苹果」与「手机/iPhone」映射到同一桶 → 召回 PHONE-1
    const hybrid = await svc.search({ q: '苹果' })
    expect(hybrid.map((r) => r.id)).toContain('PHONE-1')
  })

  it('不同语义桶（正交向量）不互相污染', async () => {
    const svc = await seed()
    // 「电脑」桶与「数据库」桶正交，余弦 0 < 阈值 → 不召回 DB-1
    const results = await svc.search({ q: '电脑' })
    expect(results.map((r) => r.id)).not.toContain('DB-1')
  })

  it('无向量命中时回落纯 BM25（结果与 hybrid:false 一致）', async () => {
    const svc = await seed()
    // 「连接池」无论 BM25 还是向量都只在 DB-1；这里验证关键词路径仍工作
    const results = await svc.search({ q: '连接池' })
    expect(results[0]?.id).toBe('DB-1')
  })

  it('未注入 embed → 纯 BM25（既有行为不变）', async () => {
    const soloHome = mkdtempSync(join(tmpdir(), 'prism-kb-hybrid-solo-'))
    const svc = new PrismKnowledgeService({ home: soloHome })
    await svc.deposit({
      id: 'X-1',
      title: '订单超时处理',
      type: 'rule',
      layer: 'global',
      book: 'b',
      content: '订单超时自动取消。',
    })
    expect((await svc.search({ q: '订单' })).length).toBe(1)
    expect((await svc.search({ q: '订单', hybrid: true })).length).toBe(1) // 无 embed，等价降级
    svc.close()
  })
})
