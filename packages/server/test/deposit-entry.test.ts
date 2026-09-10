import { describe, expect, it, vi } from 'vitest'

import { applyDepositPolicy, type DepositPolicy, type PolicyDepositInput, type TeamDefinition } from '@prism/agents'

import { depositWithPolicy } from '../src/kb/deposit-entry.js'
import { buildDepositSuggestions, inferDepositKinds } from '../src/tasks/deposit-suggestions.js'
import type { DepositInput } from '../src/kb/port.js'
import { MemoryKb } from './helpers.js'

/**
 * F-E3 沉淀建议清单（纯函数，零 LLM）+ F-E2 共用落库入口（策略单点）。
 */

/**
 * design-v4 §1.1 A5：`source`/`deposited_by` 在 agents（`PolicyDepositInput`）与
 * knowledge（`DepositInput`）**两包镜像**，靠这道**静态一致性检查**防止漂移
 * （不引入 `agents → knowledge` 依赖；server 同时依赖两者，是唯一合法的检查点）。
 *
 * 互赋即可编译 = 除已知放宽（枚举 → `string`、`id`/`risk`/`visibility` 可选性）外逐字段同形；
 * 任一侧改名/改形 → `pnpm typecheck` 红。运行期断言只是让 vitest 有个用例名。
 */
function assertMirror(a: DepositInput, b: PolicyDepositInput): [DepositInput, PolicyDepositInput] {
  const toPolicy: PolicyDepositInput = a
  const toDeposit: DepositInput = b as DepositInput
  return [toDeposit, toPolicy]
}

describe('镜像形状一致性（design-v4 §1.1 A5）', () => {
  it('DepositInput ↔ PolicyDepositInput 互赋（source/deposited_by/origin_task 同形）', () => {
    const full: DepositInput = {
      id: 'X-1',
      title: 't',
      type: 'rule',
      layer: 'project',
      owner: 'p',
      book: 'b',
      module: 'm',
      content: 'c',
      tags: ['a'],
      risk: 'high',
      confidence: 0.9,
      overrides: ['LOW-1'],
      visibility: 'role',
      source: { kind: 'task', ref: 'r' },
      deposited_by: { subject: 's', team: 'tm', task_id: 'T-1' },
      origin_task: { task_id: 'T-1', dag_id: 'D-1', stage: 'dev', role: 'dev-1' },
    }
    const [roundTrip, asPolicy] = assertMirror(full, full)
    expect(roundTrip).toBe(full)
    expect(asPolicy).toBe(full)
    // 两包都认 `source.kind='task'`（本轮新增枚举值）
    const outcome = applyDepositPolicy(policy({ require_note: false }), asPolicy)
    expect(outcome.allowed).toBe(true)
    expect(outcome.input.source?.kind).toBe('task')
  })
})

const policy = (over: Partial<DepositPolicy> = {}): DepositPolicy => ({
  enabled: true,
  default_layer: 'project',
  default_type: 'pitfall',
  priority: 'medium',
  require_note: true,
  rules: [],
  ...over,
})

/** 团队定义桩（只用到 deposit 字段）。 */
const teamWith = (deposit: DepositPolicy): TeamDefinition =>
  ({ team_id: 't', name: 't', description: '', default: false, members: [], skills: [], knowledge: { layers: ['global'] }, deposit, arbitration: [], rework_limit: 2, workflow: [], body: '' }) as TeamDefinition

describe('inferDepositKinds（确定性关键词映射）', () => {
  it('命中已知关键词 → 保序返回（pitfall 优先于 rule）', () => {
    expect(inferDepositKinds('修复登录 bug，并补充规范')).toEqual(['pitfall', 'rule'])
  })

  it('大小写不敏感（英文关键词）', () => {
    expect(inferDepositKinds('PATTERN 复用')).toEqual(['pattern'])
  })

  it('空输入 / 无关键词 → 空数组', () => {
    expect(inferDepositKinds('')).toEqual([])
    expect(inferDepositKinds('   \n  ')).toEqual([])
    expect(inferDepositKinds('平平无奇的描述')).toEqual([])
  })

  it('同类型只出现一次（多个关键词命中同一类型）', () => {
    expect(inferDepositKinds('踩坑：这个陷阱是教训')).toEqual(['pitfall'])
  })
})

describe('buildDepositSuggestions', () => {
  it('enabled=false → 空（不打扰）', () => {
    expect(buildDepositSuggestions({ policy: policy({ enabled: false, rules: [{ match: { type: 'rule' }, set: {} }] }) })).toEqual([])
  })

  it('团队无规则 → 空（不打扰）', () => {
    expect(buildDepositSuggestions({ policy: policy({ rules: [] }), description: '规范' })).toEqual([])
  })

  it('match{type:rule} + 任务含「规范」→ kind=rule/layer=global/priority=high，reason 可解释', () => {
    const suggestions = buildDepositSuggestions({
      policy: policy({ rules: [{ match: { type: 'rule' }, set: { layer: 'global', priority: 'high' } }] }),
      stage: '设计',
      description: '制定接口命名规范',
    })
    expect(suggestions).toEqual([
      { kind: 'rule', layer: 'global', priority: 'high', reason: '团队规则 match{type:rule}', require_note: true },
    ])
  })

  it('match{tags:[security]} 命中描述里的标签 → 采用 set，kind 回落到 default_type', () => {
    const suggestions = buildDepositSuggestions({
      policy: policy({ rules: [{ match: { tags: ['security'] }, set: { layer: 'global', priority: 'high' } }] }),
      description: '补充 security 相关约定',
    })
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ kind: 'pitfall', layer: 'global', priority: 'high' })
    expect(suggestions[0]!.reason).toBe('团队规则 match{tags:security}')
  })

  it('组合键（type+tags）必须同时满足；不满足则回落默认配置一条', () => {
    const p = policy({
      rules: [{ match: { type: 'rule', tags: ['security'] }, set: { layer: 'global' } }],
    })
    const hit = buildDepositSuggestions({ policy: p, description: '规范 security 红线' })
    expect(hit[0]).toMatchObject({ kind: 'rule', layer: 'global' })
    const miss = buildDepositSuggestions({ policy: p, description: '规范（但没有那个标签）' })
    expect(miss[0]!.reason).toBe('团队默认配置（default_type/default_layer）')
  })

  it('match{layer:...} 在「任务行」上下文不可判定 → 不猜，回落默认配置', () => {
    const suggestions = buildDepositSuggestions({
      policy: policy({ rules: [{ match: { layer: 'global' }, set: { priority: 'high' } }] }),
      description: '规范',
    })
    expect(suggestions[0]!.reason).toBe('团队默认配置（default_type/default_layer）')
    expect(suggestions[0]!.priority).toBe('medium')
  })

  it('多规则命中 → 按 kind|layer 去重（不堆重复建议）', () => {
    const suggestions = buildDepositSuggestions({
      policy: policy({
        rules: [
          { match: { type: 'rule' }, set: { layer: 'global' } },
          { match: { type: 'rule', tags: [] }, set: { layer: 'global', priority: 'high' } },
        ],
      }),
      description: '规范',
    })
    expect(suggestions).toHaveLength(1)
  })

  it('命中明确类型（bug → pitfall）而规则只覆盖 rule → 回落默认配置时带上推断类型', () => {
    const suggestions = buildDepositSuggestions({
      policy: policy({ rules: [{ match: { type: 'rule' }, set: { layer: 'global' } }] }),
      description: '修复一个 bug',
    })
    expect(suggestions[0]).toMatchObject({ kind: 'pitfall', layer: 'project', priority: 'medium' })
  })
})

describe('depositWithPolicy（F-E2 共用入口）', () => {
  it('无 team_id → 直传落库，且不触碰团队加载器', async () => {
    const kb = new MemoryKb()
    const loadTeam = vi.fn()
    const result = await depositWithPolicy(
      { kb: async () => kb, loadTeam },
      { title: 'T', type: 'doc', layer: 'global', book: 'b', content: 'c' },
    )
    expect(result.id).toBeDefined()
    expect(loadTeam).not.toHaveBeenCalled()
  })

  it('team_id 有值 → 调策略并落库（未声明 team_id 不写进条目）', async () => {
    const kb = new MemoryKb()
    const outcome = await depositWithPolicy(
      { kb: async () => kb, loadTeam: async () => teamWith(policy({ rules: [{ match: { type: 'rule' }, set: { layer: 'global' } }] })) },
      { title: 'T', type: 'rule', layer: 'project', owner: 'p', book: 'b', content: 'c', team_id: 't' },
    )
    const entry = await kb.get(outcome.id)
    expect(entry!.layer).toBe('global') // 团队规则覆盖
  })

  it('require_note 未满足（content 空且无 source.ref）→ bad_request', async () => {
    const kb = new MemoryKb()
    await expect(
      depositWithPolicy(
        {
          kb: async () => kb,
          loadTeam: async () => teamWith(policy({ require_note: true, rules: [{ match: {}, set: {} }] })),
        },
        { title: 'T', type: 'doc', layer: 'global', book: 'b', content: '   ', team_id: 't' },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('enabled=false → 拒绝（错误码 bad_request，消息含原因）', async () => {
    const kb = new MemoryKb()
    await expect(
      depositWithPolicy(
        { kb: async () => kb, loadTeam: async () => teamWith(policy({ enabled: false })) },
        { title: 'T', type: 'doc', layer: 'global', book: 'b', content: 'c', team_id: 't' },
      ),
    ).rejects.toThrow(/沉淀策略拒绝/)
  })
})
