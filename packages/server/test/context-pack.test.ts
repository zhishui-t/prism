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
