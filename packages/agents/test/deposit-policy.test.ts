import { describe, expect, it } from 'vitest'

import { applyDepositPolicy, priorityScore, type PolicyDepositInput } from '../src/team/deposit-policy.js'
import type { DepositPolicy } from '../src/types.js'

function policy(overrides: Partial<DepositPolicy> = {}): DepositPolicy {
  return {
    enabled: true,
    default_layer: 'project',
    default_type: 'pitfall',
    priority: 'medium',
    require_note: false,
    ...overrides,
  }
}

function input(overrides: Partial<PolicyDepositInput> = {}): PolicyDepositInput {
  return {
    title: 'T',
    type: 'rule',
    layer: 'project',
    book: 'b',
    content: '内容',
    ...overrides,
  }
}

/** 团队沉淀策略机械执行（team-definition.md §5）。 */
describe('applyDepositPolicy', () => {
  it('enabled=false → 拒绝落库', () => {
    const out = applyDepositPolicy(policy({ enabled: false }), input())
    expect(out.allowed).toBe(false)
    expect(out.errors[0]).toContain('未启用沉淀')
  })

  it('require_note=true 且无说明 → 拒绝', () => {
    const out = applyDepositPolicy(policy({ require_note: true }), input({ content: '   ' }))
    expect(out.allowed).toBe(false)
    expect(out.errors[0]).toContain('必须带说明')
  })

  it('require_note=true 且带 source.ref → 放行', () => {
    const out = applyDepositPolicy(
      policy({ require_note: true }),
      input({ content: '', source: { kind: 'agent', ref: 'README.md#L1' } }),
    )
    expect(out.allowed).toBe(true)
  })

  it('default_layer/default_type 填空值', () => {
    const out = applyDepositPolicy(policy(), input({ layer: '', type: '' }))
    expect(out.input.layer).toBe('project')
    expect(out.input.type).toBe('pitfall')
  })

  it('rules 按 type 匹配覆盖 layer 与 priority', () => {
    const out = applyDepositPolicy(
      policy({
        rules: [{ match: { type: 'rule' }, set: { layer: 'global', priority: 'high' } }],
      }),
      input({ type: 'rule' }),
    )
    expect(out.matched_rules).toEqual([0])
    expect(out.input.layer).toBe('global')
    expect(out.priority).toBe(10) // high
  })

  it('rules 按 tags 匹配（要求包含全部标签）', () => {
    const p = policy({ rules: [{ match: { tags: ['security', 'auth'] }, set: { layer: 'global' } }] })
    expect(applyDepositPolicy(p, input({ tags: ['security', 'auth', 'x'] })).matched_rules).toEqual([0])
    expect(applyDepositPolicy(p, input({ tags: ['security'] })).matched_rules).toEqual([])
  })

  it('多条规则按声明顺序覆盖（后者胜）', () => {
    const out = applyDepositPolicy(
      policy({
        rules: [
          { match: { type: 'rule' }, set: { layer: 'global' } },
          { match: { tags: ['security'] }, set: { layer: 'role' } },
        ],
      }),
      input({ type: 'rule', tags: ['security'] }),
    )
    expect(out.matched_rules).toEqual([0, 1])
    expect(out.input.layer).toBe('role')
  })

  it('未知 match 键不匹配（保守，避免误覆盖）', () => {
    const out = applyDepositPolicy(
      policy({ rules: [{ match: { unknown_key: 'x' }, set: { layer: 'global' } }] }),
      input(),
    )
    expect(out.matched_rules).toEqual([])
    expect(out.input.layer).toBe('project')
  })

  it('priorityScore 映射 low/medium/high → 0/5/10', () => {
    expect(priorityScore('low')).toBe(0)
    expect(priorityScore('medium')).toBe(5)
    expect(priorityScore('high')).toBe(10)
    expect(priorityScore('bogus')).toBe(5) // 未知回落 medium
  })
})
