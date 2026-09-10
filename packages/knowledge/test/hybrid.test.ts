/**
 * 混合检索（变更 2）：注入假 embedding，验证 BM25 + 向量 RRF 融合行为。
 *
 * 关键场景：BM25 命中不了的**同义/跨语言**条目，靠向量召回补上（真实场景 =
 * 用户问「苹果」能找回「iPhone 手机壳」）；反向也验证 `hybrid: false` 可强制纯关键词。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { openPersistence } from '@prism/core'

import { PrismKnowledgeService } from '../src/service.js'
import { blobToVector, cosine } from '../src/vector.js'

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

  it('召回不受插入顺序影响：语义相关但插入靠后的条目也必须召回（候选池不限行）', async () => {
    // 回归：旧实现用 SQL `LIMIT 50` 取候选，库一大就任意截断，插入靠后的相关条目永远
    // 召不回。这里 60 条无关填充 + 目标条目最后插入，目标仍须被向量召回。
    const home = mkdtempSync(join(tmpdir(), 'prism-kb-pool-'))
    const svc = new PrismKnowledgeService({ home, embed: fakeEmbed })
    for (let i = 0; i < 60; i++) {
      await svc.deposit({
        id: `FILL-${i}`,
        title: `填充文档 ${i}`,
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: `无关内容第 ${i} 篇。`,
      })
    }
    await svc.deposit({
      id: 'TARGET',
      title: 'iPhone 手机壳',
      type: 'doc',
      layer: 'global',
      book: 'b',
      module: 'm',
      content: '防摔磁吸外壳。',
    })
    // 「苹果」与填充、目标都无词面重叠 → BM25 零命中
    expect((await svc.search({ q: '苹果', hybrid: false })).map((r) => r.id)).not.toContain('TARGET')
    // 向量把「苹果」映射到手机桶 → 必须召回 TARGET
    expect((await svc.search({ q: '苹果' })).map((r) => r.id)).toContain('TARGET')
    svc.close()
  })

  it('reindex 重算向量：手改知识文件后，向量跟文件走而非残留旧值', async () => {
    // 回归：旧 reindex 只重建 entries/fts/edges，不碰 kb_vectors——改了文件内容，
    // 旧向量仍残留并参与检索（entry_id/version 不变）。这里改「电脑桶→手机桶」，
    // 断言库里的向量从 [0,1] 变成 [1,0]。
    const home = mkdtempSync(join(tmpdir(), 'prism-kb-reidx-vec-'))
    const svc = new PrismKnowledgeService({ home, embed: fakeEmbed })
    const r = await svc.deposit({
      id: 'MUT',
      title: '笔记本电脑',
      type: 'doc',
      layer: 'global',
      book: 'b',
      module: 'm',
      content: '一台笔记本。',
    })
    const readVec = (): Float32Array => {
      const p = openPersistence({ home })
      const row = p.knowledge.raw
        .prepare('SELECT vec FROM kb_vectors WHERE entry_id = ? AND version = ?')
        .get('MUT', 1) as { vec: Buffer } | undefined
      p.close()
      return blobToVector(row!.vec)
    }
    expect(cosine(readVec(), Float32Array.from([0, 1]))).toBeCloseTo(1, 6) // 电脑桶

    // 手改版次文件正文（保留 frontmatter），把语义改成手机桶
    const raw = readFileSync(r.path, 'utf-8')
    writeFileSync(r.path, raw.replace('一台笔记本。', '一部 iPhone。'), 'utf-8')
    await svc.reindex()

    expect(cosine(readVec(), Float32Array.from([1, 0]))).toBeCloseTo(1, 6) // 手机桶
    svc.close()
  })
})
