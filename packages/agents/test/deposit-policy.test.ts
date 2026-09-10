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

/**
 * F-E1 规则矩阵（design-v4 §F-E1 / §6）：
 * `match.layer` / `match.risk` / `match.book` / `match.module` / `set.type` / `set.visibility`
 * + priority 经 `outcome.priority` 生效 + 组合键 + 无命中回落 + 多规则后者胜。
 */
describe('applyDepositPolicy 规则矩阵（F-E1）', () => {
  it('match.layer 命中/未命中', () => {
    const p = policy({ rules: [{ match: { layer: 'role' }, set: { type: 'guide' } }] })
    expect(applyDepositPolicy(p, input({ layer: 'role' })).matched_rules).toEqual([0])
    expect(applyDepositPolicy(p, input({ layer: 'project' })).matched_rules).toEqual([])
  })

  it('match.risk 命中/未命中（含未声明的 risk）', () => {
    const p = policy({ rules: [{ match: { risk: 'high' }, set: { layer: 'global' } }] })
    expect(applyDepositPolicy(p, input({ risk: 'high' })).matched_rules).toEqual([0])
    expect(applyDepositPolicy(p, input({ risk: 'low' })).matched_rules).toEqual([])
    expect(applyDepositPolicy(p, input()).matched_rules).toEqual([]) // risk 缺省 ≠ 'high'
  })

  it('match.book 命中/未命中（F-E1 新增键）', () => {
    const p = policy({ rules: [{ match: { book: 'handbook' }, set: { layer: 'global' } }] })
    const hit = applyDepositPolicy(p, input({ book: 'handbook' }))
    expect(hit.matched_rules).toEqual([0])
    expect(hit.input.layer).toBe('global')
    expect(applyDepositPolicy(p, input({ book: 'other' })).matched_rules).toEqual([])
  })

  it('match.module 命中/未命中（F-E1 新增键；模块缺省不等于任何值）', () => {
    const p = policy({ rules: [{ match: { module: 'security' }, set: { visibility: 'role' } }] })
    const hit = applyDepositPolicy(p, input({ module: 'security' }))
    expect(hit.matched_rules).toEqual([0])
    expect(hit.input.visibility).toBe('role')
    expect(applyDepositPolicy(p, input({ module: 'other' })).matched_rules).toEqual([])
    expect(applyDepositPolicy(p, input()).matched_rules).toEqual([]) // module undefined
  })

  it('set.type / set.visibility 生效；未命中回落默认值', () => {
    const out = applyDepositPolicy(
      policy({
        rules: [
          { match: { book: 'b', module: 'm' }, set: { type: 'guide', visibility: 'global' } },
          { match: { book: 'nope' }, set: { type: 'doc' } },
        ],
      }),
      input({ book: 'b', module: 'm', type: 'rule', layer: '' }),
    )
    expect(out.matched_rules).toEqual([0])
    expect(out.input.type).toBe('guide')
    expect(out.input.visibility).toBe('global')
    expect(out.input.layer).toBe('project') // 无命中 → default_layer
    expect(out.priority).toBe(5) // 无 priority 覆盖 → 团队默认 medium
  })

  it('组合键（book+module+type+tags）必须全部满足', () => {
    const p = policy({
      rules: [{ match: { book: 'b', module: 'm', type: 'rule', tags: ['security'] }, set: { layer: 'global' } }],
    })
    expect(applyDepositPolicy(p, input({ book: 'b', module: 'm', type: 'rule', tags: ['security'] })).matched_rules).toEqual([0])
    // 少一个标签 → 不命中
    expect(applyDepositPolicy(p, input({ book: 'b', module: 'm', type: 'rule', tags: [] })).matched_rules).toEqual([])
    // 少一个模块 → 不命中
    expect(applyDepositPolicy(p, input({ book: 'b', type: 'rule', tags: ['security'] })).matched_rules).toEqual([])
  })

  it('priority 经 set.priority 生效于 outcome.priority', () => {
    const p = policy({ priority: 'low', rules: [{ match: { module: 'm' }, set: { priority: 'high' } }] })
    const out = applyDepositPolicy(p, input({ module: 'm' }))
    expect(out.priority).toBe(10)
    expect(out.input.priority).toBeUndefined() // priority 不进 input（无该字段，避免未定义形状）
  })

  it('enabled=false 时不评估规则（直接拒绝）', () => {
    const out = applyDepositPolicy(
      policy({ enabled: false, rules: [{ match: { type: 'rule' }, set: { layer: 'global' } }] }),
      input({ type: 'rule' }),
    )
    expect(out.allowed).toBe(false)
    expect(out.matched_rules).toEqual([])
  })

  it('PolicyDepositInput 扩至与 knowledge 同形（source.kind=task / deposited_by.task_id / origin_task）', () => {
    const out = applyDepositPolicy(policy(), {
      ...input(),
      source: { kind: 'task', ref: 'dag-1' },
      deposited_by: { subject: 'dev-1', team: 'core-dev', task_id: 'T-1' },
      origin_task: { task_id: 'T-1', dag_id: 'dag-1', stage: '开发' },
    })
    expect(out.allowed).toBe(true)
    expect(out.input.source?.kind).toBe('task')
    expect(out.input.deposited_by?.task_id).toBe('T-1')
    expect(out.input.origin_task?.dag_id).toBe('dag-1')
  })
})
