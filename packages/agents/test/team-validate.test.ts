import { describe, expect, it } from 'vitest'

import { stripInstanceMarker, validateTeam } from '../src/team/validate.js'
import type { RoleDefinition, TeamDefinition, WorkflowStage } from '../src/types.js'

function makeRole(name: string, skills: string[] = []): RoleDefinition {
  return {
    name,
    description: `${name} 的描述。适用于：本职工作。`,
    skills,
    knowledge: { layers: ['global', 'project'] },
    principle: '原则。',
    body: '正文',
  }
}

function makeTeam(overrides: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    team_id: 'core-dev',
    name: '核心研发团队',
    description: '负责设计、开发、测试与质量收口。',
    default: false,
    extends: null,
    members: [
      { role: 'dev-1', count: 2 },
      { role: 'tester', count: 1 },
    ],
    skills: [],
    knowledge: { layers: ['global', 'project'] },
    deposit: {
      enabled: true,
      default_layer: 'project',
      default_type: 'pitfall',
      priority: 'medium',
      require_note: true,
    },
    arbitration: ['safety', 'quality'],
    rework_limit: 2,
    workflow: [],
    body: '正文',
    ...overrides,
  }
}

const ROLES = [makeRole('dev-1'), makeRole('tester'), makeRole('qa-checker')]
const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code)

function stage(order: number, roles: string[]): WorkflowStage {
  return { order, stage: `阶段${order}`, roles, mode: 'serial', input: 'in', output: 'out', done: 'done', reflow: '—' }
}

describe('validateTeam（design-v3 §4.2 逐条）', () => {
  it('正例：合法团队 ok=true 无 issue', () => {
    const result = validateTeam(makeTeam(), { roles: ROLES })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('team_id / name / description 必填（error）', () => {
    const result = validateTeam(makeTeam({ team_id: '', name: '', description: '' }), { roles: ROLES })
    expect(codes(result.issues)).toEqual(expect.arrayContaining(['team_id_required', 'name_required', 'description_required']))
  })

  it('members 非空、count ≥ 1、成员角色必须在角色库（error）', () => {
    const empty = validateTeam(makeTeam({ members: [] }), { roles: ROLES })
    expect(codes(empty.issues)).toContain('members_empty')

    const result = validateTeam(
      makeTeam({
        members: [
          { role: 'ghost', count: 1 },
          { role: 'dev-1', count: 0 },
        ],
      }),
      { roles: ROLES },
    )
    expect(codes(result.issues)).toContain('member_role_unknown')
    expect(codes(result.issues)).toContain('member_count_invalid')
    expect(result.ok).toBe(false)
  })

  it('成员引用与角色库 name 大小写不一致 → 命中不报错（qa 总审修复：队长裁决口径，如 QA-checker/qa-checker）', () => {
    // 复现出厂模板 core-dev 引用 qa-checker、角色库导入后 name=QA-checker 的真实场景
    const library = [makeRole('QA-checker'), ...ROLES]
    const team = makeTeam({
      members: [
        { role: 'dev-1', count: 2 },
        { role: 'qa-checker', count: 1 },
      ],
    })
    const result = validateTeam(team, { roles: library })
    expect(codes(result.issues)).not.toContain('member_role_unknown')
    expect(result.ok).toBe(true)
  })

  it('工作流引用 members 内角色 + 实例记号剥壳后命中 → ok（P1 修订）', () => {
    const team = makeTeam({ workflow: [stage(1, ['dev-1#1', 'dev-1#2']), stage(2, ['tester'])] })
    const result = validateTeam(team, { roles: ROLES })
    expect(result.ok).toBe(true)
  })

  it('工作流引用不在 members 的角色 → error', () => {
    const team = makeTeam({ workflow: [stage(1, ['dev-1#1']), stage(2, ['qa-checker'])] })
    const result = validateTeam(team, { roles: ROLES })
    expect(result.ok).toBe(false)
    expect(codes(result.issues)).toContain('workflow_role_unknown')
  })

  it('leader 豁免：队长不在 members 也合法（P1 修订；出厂模板可过校验）', () => {
    const team = makeTeam({
      // 引用 tester 的阶段仅为满足「成员都参与流程」——否则会触发 unused_member（见下组用例）
      workflow: [stage(1, ['dev-1#1', 'dev-1#2']), stage(2, ['队长']), stage(3, ['leader']), stage(4, ['tester'])],
    })
    const result = validateTeam(team, { roles: ROLES })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('成员未出现在任何工作流阶段 → warning（不影响 ok；让「编制悬空」显式可见）', () => {
    const team = makeTeam({
      members: [
        { role: 'dev-1', count: 2 },
        { role: 'tester', count: 1 },
      ],
      workflow: [stage(1, ['dev-1#1', 'dev-1#2'])], // 只用了 dev-1，tester 未参与
    })
    const result = validateTeam(team, { roles: ROLES })
    expect(result.ok).toBe(true) // warning 不影响放行（可能是有意预留的机动位）
    const issue = result.issues.find((i) => i.code === 'unused_member')
    expect(issue?.level).toBe('warning')
    expect(issue?.message).toContain('tester')
  })

  it('unused_member 大小写不敏感；工作流为空时不报（那是另一个问题，不该放大成 N 条告警）', () => {
    const library = [makeRole('QA-checker'), ...ROLES]
    const cased = validateTeam(
      makeTeam({
        members: [
          { role: 'qa-checker', count: 1 },
          { role: 'dev-1', count: 1 },
        ],
        workflow: [stage(1, ['QA-checker', 'dev-1'])],
      }),
      { roles: library },
    )
    expect(codes(cased.issues)).not.toContain('unused_member')

    const noWorkflow = validateTeam(makeTeam(), { roles: ROLES })
    expect(codes(noWorkflow.issues)).not.toContain('unused_member')
  })

  it('deposit 枚举校验：default_layer / default_type（EntryType）/ priority（error）', () => {
    const base = { deposit: { ...makeTeam().deposit } }
    const layer = validateTeam(makeTeam({ ...base, deposit: { ...base.deposit, default_layer: 'universe' as never } }), { roles: ROLES })
    expect(codes(layer.issues)).toContain('deposit_layer_invalid')

    const type = validateTeam(makeTeam({ deposit: { ...base.deposit, default_type: 'not_a_type' } }), { roles: ROLES })
    expect(codes(type.issues)).toContain('deposit_type_invalid')
    const okType = validateTeam(makeTeam({ deposit: { ...base.deposit, default_type: 'rule' } }), { roles: ROLES })
    expect(codes(okType.issues)).not.toContain('deposit_type_invalid')

    const priority = validateTeam(makeTeam({ deposit: { ...base.deposit, priority: 'urgent' as never } }), { roles: ROLES })
    expect(codes(priority.issues)).toContain('deposit_priority_invalid')
  })

  it('deposit.rules[].match/.set 必须为对象（error）', () => {
    const team = makeTeam({
      deposit: {
        ...makeTeam().deposit,
        rules: [
          { match: { type: 'rule' }, set: { layer: 'global' } },
          { match: 'not-object' as never, set: { layer: 'global' } },
          { match: { tags: ['security'] }, set: null as never },
        ],
      },
    })
    const result = validateTeam(team, { roles: ROLES })
    expect(result.issues.filter((i) => i.code === 'deposit_rule_invalid')).toHaveLength(2)
    expect(result.ok).toBe(false)
  })

  it('rework_limit 正整数（error；非整数/零/负数都报）', () => {
    for (const bad of [0, -1, 1.5]) {
      const result = validateTeam(makeTeam({ rework_limit: bad }), { roles: ROLES })
      expect(codes(result.issues)).toContain('rework_limit_invalid')
    }
    const ok = validateTeam(makeTeam({ rework_limit: 3 }), { roles: ROLES })
    expect(codes(ok.issues)).not.toContain('rework_limit_invalid')
  })

  it('arbitration 空 → warning（不影响 ok）', () => {
    const result = validateTeam(makeTeam({ arbitration: [] }), { roles: ROLES })
    expect(result.ok).toBe(true)
    const issue = result.issues.find((i) => i.code === 'arbitration_empty')
    expect(issue?.level).toBe('warning')
  })

  it('团队 skills 引用不存在 → warning；与成员角色重复声明 → 信息性 warning', () => {
    const result = validateTeam(makeTeam({ skills: ['ghost_skill', 'code_review'] }), {
      roles: [makeRole('dev-1', ['code_review']), ...ROLES.slice(1)],
      knownSkills: ['code_review'],
    })
    expect(result.ok).toBe(true)
    expect(result.issues.find((i) => i.code === 'skill_unknown')?.level).toBe('warning')
    const redundant = result.issues.find((i) => i.code === 'skill_redundant')
    expect(redundant?.message).toContain('dev-1')
  })
})

describe('stripInstanceMarker（实例记号语法）', () => {
  it('dev-1#2 → dev-1；无记号原样', () => {
    expect(stripInstanceMarker('dev-1#2')).toBe('dev-1')
    expect(stripInstanceMarker('dev-1')).toBe('dev-1')
    expect(stripInstanceMarker('队长')).toBe('队长')
  })
})
