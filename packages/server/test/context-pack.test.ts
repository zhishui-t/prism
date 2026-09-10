import { describe, expect, it } from 'vitest'

import { buildContextPack, estimateTokens } from '../src/kb/context-pack.js'
import { MemoryKb } from './helpers.js'

/** 造一个带检索的桩（MemoryKb 的 search 已支持 bigram）。 */
async function seededKb(): Promise<MemoryKb> {
  const kb = new MemoryKb()
  await kb.deposit({
    id: 'SEC-RED-007',
    title: '禁止明文存储凭证',
    type: 'rule',
    layer: 'global',
    book: 'security-redline',
    module: 'credential',
    content: '凭证必须加密存储，禁止明文写入日志或配置文件。',
  })
  await kb.deposit({
    id: 'PRJ-AUTH-1',
    title: '本项目鉴权约定',
    type: 'rule',
    layer: 'project',
    owner: 'proj',
    book: 'auth',
    module: 'token',
    content: '项目鉴权令牌必须校验过期时间。',
  })
  return kb
}

/** 上下文包（knowledge-injection.md §4 模式 B）。 */
describe('buildContextPack', () => {
  it('按知识绑定的 layers 限定范围', async () => {
    const kb = await seededKb()
    // 只绑 global → 项目层条目不该出现
    const pack = await buildContextPack(kb, {
      role: 'security-auditor',
      binding: { layers: ['global'] },
      task: '凭证',
    })
    expect(pack.items.every((i) => i.layer === 'global')).toBe(true)
  })

  it('books 绑定收窄到指定书', async () => {
    const kb = await seededKb()
    const pack = await buildContextPack(kb, {
      role: 'security-auditor',
      binding: { layers: ['global', 'project'], books: ['security-redline'] },
      task: '凭证',
    })
    expect(pack.items.every((i) => i.book === 'security-redline')).toBe(true)
  })

  it('预算截断：小预算下 items 更少且 truncated=true', async () => {
    const kb = await seededKb()
    const full = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global', 'project'] },
      task: '凭证',
      budgetTokens: 100000,
    })
    const small = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global', 'project'] },
      task: '凭证',
      budgetTokens: 1, // 极小预算
    })
    expect(full.items.length).toBeGreaterThanOrEqual(small.items.length)
    expect(small.truncated).toBe(true)
    expect(small.total_tokens).toBeLessThanOrEqual(1 + 100) // 允许单项超一点（不在中途半塞）
  })

  it('分层权重：同相关度下 role 层靠前', async () => {
    const kb = new MemoryKb()
    // 两条内容相同、层级不同
    await kb.deposit({ id: 'G', title: '规则甲', type: 'rule', layer: 'global', book: 'b', content: '相同的规则内容' })
    await kb.deposit({ id: 'R', title: '规则甲', type: 'rule', layer: 'role', owner: 'role-x', book: 'b', content: '相同的规则内容' })

    const pack = await buildContextPack(kb, {
      role: 'role-x',
      binding: { layers: ['global', 'role'] },
      task: '规则甲',
      budgetTokens: 100000,
    })
    // role 层权重 1.0 > global 0.72 → 应排在前面
    const roleIdx = pack.items.findIndex((i) => i.layer === 'role')
    const globalIdx = pack.items.findIndex((i) => i.layer === 'global')
    if (roleIdx >= 0 && globalIdx >= 0) {
      expect(roleIdx).toBeLessThan(globalIdx)
    } else {
      expect(pack.items.length).toBeGreaterThan(0)
    }
  })

  it('空 layers 绑定 → 空包（不做检索）', async () => {
    const kb = await seededKb()
    const pack = await buildContextPack(kb, { role: 'r', binding: { layers: [] }, task: '凭证' })
    expect(pack.items).toEqual([])
    expect(pack.truncated).toBe(false)
  })

  it('无命中 → 空包；sources 与 items 一一对应', async () => {
    const kb = await seededKb()
    const none = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: 'zzzz不存在的词yyyy',
    })
    expect(none.items).toEqual([])

    const pack = await buildContextPack(kb, { role: 'r', binding: { layers: ['global'] }, task: '凭证' })
    expect(pack.sources.length).toBe(pack.items.length)
    expect(pack.sources[0]).toContain('SEC-RED-007')
  })

  it('estimateTokens：CJK 约 1 token/字，英文约 1/4', () => {
    expect(estimateTokens('中文')).toBe(2)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })
})

/** F-B1：新鲜度接通 + normalized_by + layers/books/max_excerpt_chars。 */
describe('buildContextPack — F-B1', () => {
  it('normalized_by = candidate_max（裁决 #5：跨查询不可比的语义显式声明）', async () => {
    const kb = await seededKb()
    const pack = await buildContextPack(kb, { role: 'r', binding: { layers: ['global'] }, task: '凭证' })
    expect(pack.normalized_by).toBe('candidate_max')
  })

  it('freshness 高 → 排序上升（同内容同层，只有新鲜度不同）', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'FRESH-LOW', title: '同题', type: 'rule', layer: 'global', book: 'b', content: '新鲜度对比内容' })
    await kb.deposit({ id: 'FRESH-HIGH', title: '同题', type: 'rule', layer: 'global', book: 'b', content: '新鲜度对比内容' })
    kb.setFreshness('FRESH-LOW', 0)
    kb.setFreshness('FRESH-HIGH', 1)
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: '新鲜度对比',
      budgetTokens: 100000,
    })
    const low = pack.items.find((i) => i.id === 'FRESH-LOW')!
    const high = pack.items.find((i) => i.id === 'FRESH-HIGH')!
    expect(high.relevance).toBeGreaterThan(low.relevance)
    expect(high.relevance).toBe(0.72)
    expect(low.relevance).toBe(0.648)
    expect(pack.items[0].id).toBe('FRESH-HIGH')
  })

  it('freshness 缺省 vs =1.0 → relevance 逐字节一致（回归：既有排序不变）', async () => {
    const mk = async (freshness?: number): Promise<MemoryKb> => {
      const kb = new MemoryKb()
      await kb.deposit({ id: 'FR-1', title: '规则', type: 'rule', layer: 'global', book: 'b', content: '同一内容' })
      if (freshness !== undefined) kb.setFreshness('FR-1', freshness)
      return kb
    }
    const opts = { role: 'r', binding: { layers: ['global' as const] }, task: '同一内容' }
    const none = await buildContextPack(await mk(), opts)
    const one = await buildContextPack(await mk(1), opts)
    expect(none.items[0].relevance).toBe(one.items[0].relevance)
    expect(none.items[0].relevance).toBe(0.72)
  })

  it('freshness 越界（>1 / <0）被 clamp 后不越界', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'OUT', title: 'T', type: 'rule', layer: 'global', book: 'b', content: '越界新鲜度' })
    kb.setFreshness('OUT', 9)
    const pack = await buildContextPack(kb, { role: 'r', binding: { layers: ['global'] }, task: '越界新鲜度' })
    expect(pack.items[0].relevance).toBe(0.72)
  })

  it('layers 显式覆盖角色绑定（binding=global → 实际只取 project）', async () => {
    const kb = await seededKb()
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: '校验',
      layers: ['project'],
      budgetTokens: 100000,
    })
    expect(pack.items.length).toBeGreaterThan(0)
    expect(pack.items.every((i) => i.layer === 'project')).toBe(true)
  })

  it('layers 覆盖为空数组 → 空包（明确的空集，不做检索）', async () => {
    const kb = await seededKb()
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global', 'project'] },
      task: '凭证',
      layers: [],
    })
    expect(pack.items).toEqual([])
  })

  it('books 显式覆盖角色绑定（binding=security-redline → 实际取 auth）', async () => {
    const kb = await seededKb()
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global', 'project'], books: ['security-redline'] },
      task: '校验',
      books: ['auth'],
      budgetTokens: 100000,
    })
    expect(pack.items.every((i) => i.book === 'auth')).toBe(true)
    expect(pack.items.map((i) => i.id)).toContain('PRJ-AUTH-1')
  })

  it('max_excerpt_chars 生效（缺省仍 600）', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'LONG', title: '长文', type: 'doc', layer: 'global', book: 'b', content: '甲'.repeat(300) })
    const small = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: '长文',
      maxExcerptChars: 10,
    })
    expect(small.items[0].excerpt.length).toBe(10)
    const dflt = await buildContextPack(kb, { role: 'r', binding: { layers: ['global'] }, task: '长文' })
    expect(dflt.items[0].excerpt.length).toBe(80) // MemoryKb 的 excerpt 上限 80
  })
})

/** F-B2：代码符号命中加权（不做图谱邻近度，队长裁决 A3）。 */
describe('buildContextPack — F-B2 symbols', () => {
  it('命中 title+excerpt → relevance ×1.15 并写出 graph_hits', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'S1', title: 'wiring.ts 的装配约定', type: 'rule', layer: 'global', book: 'b', content: '改 wiring.ts 必须同步契约。' })
    const base = await buildContextPack(kb, { role: 'r', binding: { layers: ['global'] }, task: '装配' })
    const hit = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: '装配',
      symbols: ['wiring.ts'],
    })
    expect(base.items[0].graph_hits).toEqual([])
    expect(hit.items[0].graph_hits).toEqual(['wiring.ts'])
    expect(hit.items[0].relevance).toBe(Number((base.items[0].relevance * 1.15).toFixed(4)))
  })

  it('命中项排序上升（同 score 下符号命中项被推到前面）', async () => {
    // MemoryKb 的 score 恒为 1 → 次序只可能由 boost 改变
    const kb = new MemoryKb()
    await kb.deposit({ id: 'NOHIT', title: '普通约定', type: 'rule', layer: 'global', book: 'b', content: '符号加权测试内容' })
    await kb.deposit({ id: 'HIT', title: '普通约定 server.ts', type: 'rule', layer: 'global', book: 'b', content: '符号加权测试内容' })
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: '符号加权',
      symbols: ['server.ts'],
      budgetTokens: 100000,
    })
    expect(pack.items[0].id).toBe('HIT')
    expect(pack.items[0].graph_hits).toEqual(['server.ts'])
    expect(pack.items[1].graph_hits).toEqual([])
  })

  it('大小写敏感（WIRING.TS 不命中 wiring.ts）', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'CS', title: 'wiring.ts 约定', type: 'rule', layer: 'global', book: 'b', content: '大小写敏感' })
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: '大小写',
      symbols: ['WIRING.TS'],
    })
    expect(pack.items[0].graph_hits).toEqual([])
  })

  it('relevance ∈ [0,1]：role 层 1.0 × 1.15 被末尾 clamp 回 1', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'CLAMP', title: 'server.ts 规范', type: 'rule', layer: 'role', owner: 'r', book: 'b', content: 'clamp 测试' })
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['role'] },
      task: 'clamp',
      symbols: ['server.ts'],
    })
    expect(pack.items[0].graph_hits).toEqual(['server.ts'])
    expect(pack.items[0].relevance).toBe(1)
    expect(pack.items.every((i) => i.relevance >= 0 && i.relevance <= 1)).toBe(true)
  })

  it('symbols 重复/空串 → 去重且忽略空串；不传 symbols 时 relevance 与改动前一致', async () => {
    const kb = await seededKb()
    const pack = await buildContextPack(kb, {
      role: 'r',
      binding: { layers: ['global'] },
      task: '凭证',
      symbols: ['', '凭证', '凭证'],
    })
    expect(pack.items[0].graph_hits).toEqual(['凭证'])
    const none = await buildContextPack(kb, { role: 'r', binding: { layers: ['global'] }, task: '凭证' })
    expect(none.items.every((i) => i.graph_hits.length === 0)).toBe(true)
    // 回归：global 层权重 0.72 × 1.0（freshness 缺省）→ 未加权项相关度不变
    const plain = none.items.find((i) => i.id === 'SEC-RED-007')!
    expect(plain.relevance).toBe(0.72)
  })
})
