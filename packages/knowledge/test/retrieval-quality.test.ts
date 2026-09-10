/**
 * F-B3：检索质量回归集 + 候选池/权重参数化。
 *
 * 固定语料 + 固定查询，覆盖设计点名的三类场景：
 * 1. **两字中文词**（「性能」「日志」——trigram 时代搜不到，bigram + unicode61 才可）；
 * 2. **跨语言** query（英文问、中文条目答，靠向量路召回）；
 * 3. **超候选池**（> 50 条同桶候选，证明「尾部召不回」是**参数**而非缺陷）；
 * 外加：默认参数与显式传默认值**逐字节一致**（保护既有行为）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { HYBRID_CANDIDATES, RRF_K, VECTOR_FLOOR, VECTOR_RELATIVE } from '../src/vector.js'

const dirs: string[] = []

function makeService(embed?: (text: string) => Promise<Float32Array | null>): PrismKnowledgeService {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-quality-'))
  dirs.push(home)
  return new PrismKnowledgeService(embed === undefined ? { home } : { home, embed })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 固定语料（8 条；查询与期望见各用例）。 */
const CORPUS: Array<{ id: string; title: string; type: 'rule' | 'guide' | 'doc'; content: string }> = [
  { id: 'PERF-001', title: '性能优化指南', type: 'guide', content: '接口性能优化的第一步是建立基准，再谈缓存与并发。' },
  { id: 'PERF-002', title: '前端性能预算', type: 'rule', content: '首屏性能预算：包体不超过 200KB。' },
  { id: 'LOG-001', title: '日志规范', type: 'rule', content: '日志必须带 trace id；禁止打印敏感字段。' },
  { id: 'LOG-002', title: '日志采集', type: 'doc', content: '采集链路：应用日志 → 采集器 → 存储。' },
  { id: 'DB-001', title: '数据库连接池', type: 'guide', content: '连接池大小按并发峰值设定，慢查询要单独排查。' },
  { id: 'SEC-001', title: '密钥管理', type: 'rule', content: '密钥禁止入库明文，必须走密钥服务。' },
  { id: 'API-001', title: '接口命名', type: 'doc', content: 'REST 接口使用复数名词，动词交给 HTTP 方法。' },
  { id: 'MISC-1', title: '会议室预订', type: 'doc', content: '会议室预订需提前一天。' },
]

async function seedCorpus(): Promise<PrismKnowledgeService> {
  const kb = makeService()
  for (const entry of CORPUS) {
    await kb.deposit({
      id: entry.id,
      title: entry.title,
      type: entry.type,
      layer: 'global',
      book: 'handbook',
      module: 'core',
      content: entry.content,
    })
  }
  return kb
}

describe('检索质量回归集（F-B3：纯 BM25 固定语料）', () => {
  it('两字中文词「性能」→ 期望条目进 top-3', async () => {
    const kb = await seedCorpus()
    try {
      const ids = (await kb.search({ q: '性能', limit: 3 })).map((r) => r.id)
      expect(ids).toContain('PERF-001')
      expect(ids.some((id) => id.startsWith('PERF-'))).toBe(true)
    } finally {
      kb.close()
    }
  })

  it('两字中文词「日志」→ 期望条目进 top-3', async () => {
    const kb = await seedCorpus()
    try {
      const ids = (await kb.search({ q: '日志', limit: 3 })).map((r) => r.id)
      expect(ids).toContain('LOG-001')
      expect(ids).toContain('LOG-002')
    } finally {
      kb.close()
    }
  })

  it('精确多词 AND（「性能 缓存」）命中对应条目', async () => {
    const kb = await seedCorpus()
    try {
      const ids = (await kb.search({ q: '性能 缓存', limit: 5 })).map((r) => r.id)
      expect(ids).toEqual(['PERF-001'])
    } finally {
      kb.close()
    }
  })

  it('无关查询 → 空结果（不误召回）', async () => {
    const kb = await seedCorpus()
    try {
      expect(await kb.search({ q: '量子纠缠' })).toEqual([])
    } finally {
      kb.close()
    }
  })
})

/**
 * 假 embedding：按「语义桶」返回归一化 one-hot 向量（确定性、零依赖）。
 * 同桶余弦 = 1，不同桶正交（0 < VECTOR_FLOOR → 被过滤）。
 */
const BUCKETS: string[][] = [
  ['苹果', '手机', 'iphone', 'apple', 'phone'],
  ['database', 'sql', '数据库', '连接池', 'connection', 'pool'],
]

function fakeEmbed(text: string): Promise<Float32Array | null> {
  const lower = text.toLowerCase()
  for (let i = 0; i < BUCKETS.length; i++) {
    if (BUCKETS[i]!.some((kw) => lower.includes(kw))) {
      const v = new Float32Array(BUCKETS.length)
      v[i] = 1
      return Promise.resolve(v)
    }
  }
  return Promise.resolve(null)
}

describe('跨语言与候选池参数化（F-B3：混合检索）', () => {
  it('跨语言：英文 query 靠向量路召回中文条目（纯 BM25 零命中）', async () => {
    const kb = makeService(fakeEmbed)
    try {
      await kb.deposit({
        id: 'ZH-DB-1',
        title: '数据库连接池调优',
        type: 'guide',
        layer: 'global',
        book: 'backend',
        module: 'db',
        content: '连接池大小与慢查询排查。',
      })
      // 「database」与中文标题无词面重叠 → 纯 BM25 零命中
      expect(await kb.search({ q: 'database', hybrid: false })).toHaveLength(0)
      // 向量把 database/连接池 映射到同一桶 → 召回
      expect((await kb.search({ q: 'database' })).map((r) => r.id)).toContain('ZH-DB-1')
    } finally {
      kb.close()
    }
  })

  it('>50 候选：提高 hybrid_candidates 后尾部相关条目可被召回（截断是参数不是缺陷）', async () => {
    const kb = makeService(fakeEmbed)
    try {
      // 60 条同桶候选（都含「手机」）+ 目标条目最后插入（含「iPhone」→ 同桶）
      for (let i = 0; i < 60; i++) {
        await kb.deposit({
          id: `FILL-${String(i).padStart(2, '0')}`,
          title: `手机配件说明 ${i}`,
          type: 'doc',
          layer: 'global',
          book: 'gadgets',
          module: 'm',
          content: `第 ${i} 篇手机配件说明。`,
        })
      }
      await kb.deposit({
        id: 'TAIL-TARGET',
        title: 'iPhone 外壳选购',
        type: 'doc',
        layer: 'global',
        book: 'gadgets',
        module: 'm',
        content: '适配 iPhone 15 的防摔外壳。',
      })

      // 语料里没有任何条目含「苹果」→ BM25 路零命中，全部靠向量路；
      // 同桶余弦全为 1 → 向量序 = 扫描序，目标（最后插入）排第 61。
      // 注意：候选池 = max(limit, hybrid_candidates)，故两侧 limit 同步放宽——
      // 否则「窄池」下的截断其实是 limit 在起作用，证明不了候选池参数。
      const narrow = await kb.search({ q: '苹果', limit: 50, hybrid_candidates: 50 })
      const wide = await kb.search({ q: '苹果', limit: 100, hybrid_candidates: 100 })

      // 候选池窄（50）→ 目标（第 61 个同桶候选）被 `slice(0, pool)` 截掉
      expect(narrow.map((r) => r.id)).not.toContain('TAIL-TARGET')
      expect(narrow).toHaveLength(50)
      // 候选池放宽 → 同一份数据、同一个查询，目标被召回 → 证明是**参数**问题
      expect(wide.map((r) => r.id)).toContain('TAIL-TARGET')
      // 且窄池是宽池的前缀（同一排序，只是被截断）
      expect(wide.map((r) => r.id).slice(0, narrow.length)).toEqual(narrow.map((r) => r.id))
    } finally {
      kb.close()
    }
  })

  it('默认参数 = 显式传默认常量（逐字节一致，保护既有行为）', async () => {
    const kb = makeService(fakeEmbed)
    try {
      await kb.deposit({
        id: 'DEF-1',
        title: '苹果手机壳',
        type: 'doc',
        layer: 'global',
        book: 'gadgets',
        module: 'm',
        content: '适配苹果手机的防摔壳。',
      })
      const byDefault = await kb.search({ q: '苹果', limit: 10 })
      const explicit = await kb.search({
        q: '苹果',
        limit: 10,
        hybrid_candidates: HYBRID_CANDIDATES,
        rrf_k: RRF_K,
        vector_floor: VECTOR_FLOOR,
        vector_relative: VECTOR_RELATIVE,
        route_weights: { keyword: 1, vector: 1 },
      })
      expect(explicit.map((r) => `${r.id}:${r.score}`)).toEqual(byDefault.map((r) => `${r.id}:${r.score}`))
    } finally {
      kb.close()
    }
  })

  it('route_weights 生效：向量路权重置 0 → 只剩关键词路（BM25 命中项）', async () => {
    const kb = makeService(fakeEmbed)
    try {
      await kb.deposit({
        id: 'W-1',
        title: '苹果手机',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: '苹果手机配件。',
      })
      await kb.deposit({
        id: 'W-2',
        title: '手机壳手册',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: 'iPhone 配件说明。',
      })
      // 查询「苹果」：W-1 双路命中；W-2 与「苹果」无词面重叠 → 只被向量路召回
      const both = await kb.search({ q: '苹果', limit: 10 })
      expect(both.map((r) => r.id)).toContain('W-2')

      const keywordOnly = await kb.search({ q: '苹果', limit: 10, route_weights: { keyword: 1, vector: 0 } })
      expect(keywordOnly.map((r) => r.id)).toEqual(['W-1'])
      // W-1 原先是双路命中（两路各贡献 1/(k+1)）→ 关掉向量路后只剩关键词路那一份
      expect(keywordOnly[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10)
      expect(both.find((r) => r.id === 'W-1')!.score).toBeCloseTo(2 / (RRF_K + 1), 10)
    } finally {
      kb.close()
    }
  })

  it('非法参数 → bad_request（不静默吞掉，避免 SQL LIMIT 处难定位的错）', async () => {
    const kb = await seedCorpus()
    try {
      await expect(kb.search({ q: '性能', hybrid_candidates: 0 })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(kb.search({ q: '性能', rrf_k: -1 })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(kb.search({ q: '性能', vector_floor: Number.NaN })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(kb.search({ q: '性能', route_weights: { vector: -1 } })).rejects.toMatchObject({ code: 'bad_request' })
    } finally {
      kb.close()
    }
  })
})
