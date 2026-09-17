import { beforeEach, describe, expect, it } from 'vitest'

import { setLang, t } from '../src/i18n.ts'
import { buildUpdatePatch, validateCreate, type TeamFormValues } from '../src/pages/teams/form-logic.ts'
import { addCard, draftFromStages, removeCard, setCardField } from '../src/pages/teams/workflow-model.ts'
import type { RoleDefinition, TeamDefinition, WorkflowStage } from '../src/api-team.ts'

beforeEach(() => setLang('zh'))

function values(over: Partial<TeamFormValues> = {}): TeamFormValues {
  return {
    teamId: 'core-dev',
    name: 'Core Dev',
    description: '',
    counts: {},
    filter: '',
    template: 'minimal',
    workflow: draftFromStages([]),
    depositEnabled: false,
    defaultLayer: '',
    defaultType: 'rule',
    priority: 'medium',
    requireNote: false,
    teamsDir: '/tmp/prism-teams',
    ...over,
  }
}

const role = (name: string) => ({ name }) as RoleDefinition
const roles = [role('dev-1'), role('tester')]

describe('validateCreate（纯函数：t + 值对象 + 成员 + 角色库 + 已存在 ID）', () => {
  it('合法输入 → 零错误', () => {
    const errors = validateCreate(t, values(), [{ role: 'dev-1', count: 2 }], roles, ['other-team'])
    expect(errors).toEqual({})
  })

  it('缺 team_id 与成员 → 两处各自报错', () => {
    const errors = validateCreate(t, values({ teamId: '  ' }), [], roles, [])
    expect(errors.teamId).toBe(t('teams.v.idRequired'))
    expect(errors.members).toBe(t('teams.v.membersRequired'))
  })

  it('非法 team_id（大写+空格）→ idInvalid；成员数越界另一条', () => {
    const errors = validateCreate(t, values({ teamId: 'Core Dev' }), [{ role: 'dev-1', count: 0 }], roles, [])
    expect(errors.teamId).toBe(t('teams.v.idInvalid'))
    expect(errors.members).toBe(t('teams.v.membersRange'))
  })

  it('成员角色不在角色库 → 带角色名；开启沉淀但没选层 → layerRequired', () => {
    const errors = validateCreate(
      t,
      values({ depositEnabled: true, defaultLayer: '' }),
      [{ role: 'ghost', count: 1 }],
      roles,
      [],
    )
    expect(errors.members).toBe(t('teams.v.memberUnknown', { role: 'ghost' }))
    expect(errors.defaultLayer).toBe(t('teams.v.layerRequired'))
  })

  it('不依赖外部状态：同样的入参连调两次结果一致（无 teamId 查重副作用）', () => {
    const args = [t, values({ teamId: 'taken' }), [{ role: 'dev-1', count: 1 }], roles, ['taken']] as const
    expect(validateCreate(...args)).toEqual(validateCreate(...args))
    expect(validateCreate(...args).teamId).toBe(t('teams.v.idTaken', { id: 'taken' }))
  })
})

const stage = (over: Partial<WorkflowStage> = {}): WorkflowStage => ({
  order: 1,
  stage: '需求',
  roles: ['dev-1'],
  mode: 'serial',
  input: '',
  output: '',
  done: '',
  reflow: '',
  ...over,
})

/** 底账（PATCH 的比对基准）：GET 拿到的团队定义。 */
function team(over: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    team_id: 'core-dev',
    name: 'Core Dev',
    description: '',
    default: false,
    members: [{ role: 'dev-1', count: 1 }],
    skills: [],
    knowledge: { layers: [] },
    deposit: { enabled: false, default_layer: 'project', default_type: 'other', priority: 'medium', require_note: false },
    arbitration: [],
    workflow: [stage()],
    ...over,
  }
}

const MEMBERS = [{ role: 'dev-1', count: 1 }]

describe('buildUpdatePatch（v11 F2：工作流差集与乐观并发）', () => {
  it('只改名字 → 不带 workflow 段（省掉一次无谓的工作流重写）', () => {
    const base = values({ workflow: draftFromStages([stage()]) })
    const built = buildUpdatePatch(t, { ...base, name: 'Core Dev v2' }, base, MEMBERS, team(), '/tmp/roles')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.patch.name).toBe('Core Dev v2')
    expect('workflow' in built.patch).toBe(false)
  })

  it('改了阶段名 → patch 带 workflow.stages 且 fields 记上 workflow（order 按位置重编）', () => {
    const base = values({ workflow: draftFromStages([stage(), stage({ order: 2, stage: '设计' })]) })
    const v = { ...base, workflow: setCardField(base.workflow, 1, 'stage', '概要设计') }
    const built = buildUpdatePatch(t, v, base, MEMBERS, team(), '/tmp/roles')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.fields).toContain('workflow')
    expect(built.patch.workflow?.stages.map((s) => s.stage)).toEqual(['需求', '概要设计'])
    expect(built.patch.workflow?.stages.map((s) => s.order)).toEqual([1, 2])
  })

  it('「加了又删」= 草稿等价 → 不发 workflow 段（没有真改动就不产生重写）', () => {
    const base = values({ workflow: draftFromStages([stage()]) })
    const v = { ...base, workflow: removeCard(addCard(base.workflow), 1) }
    // 只有工作流被这么折腾过 ⇒ 整份 patch 空 ⇒ 前端拦下（不空跑一次 PATCH）
    expect(buildUpdatePatch(t, v, base, MEMBERS, team(), '/tmp/roles')).toEqual({
      ok: false,
      error: t('teams.form.nothingChanged'),
    })
  })

  it('拿到过 source_mtime → 带 if_match；没拿到 → 这个键根本不出现', () => {
    const base = values({ workflow: draftFromStages([stage()]) })
    const v = { ...base, name: 'Core Dev v2', sourceMtime: 111 }
    const withMtime = buildUpdatePatch(t, v, base, MEMBERS, team({ source_mtime: 111 }), '/tmp/roles')
    expect(withMtime.ok).toBe(true)
    if (withMtime.ok) expect(withMtime.patch.if_match).toBe(111)

    const withoutMtime = buildUpdatePatch(t, { ...base, name: 'Core Dev v2' }, base, MEMBERS, team(), '/tmp/roles')
    expect(withoutMtime.ok).toBe(true)
    if (withoutMtime.ok) expect('if_match' in withoutMtime.patch).toBe(false)
  })

  it('members 与 workflow 同给：两个都发（收窄与否由服务端裁决，前端不预判）', () => {
    const base = values({ workflow: draftFromStages([stage()]) })
    const v = { ...base, workflow: setCardField(base.workflow, 0, 'stage', '需求收集') }
    const built = buildUpdatePatch(t, v, base, [{ role: 'dev-1', count: 2 }], team(), '/tmp/roles')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.patch.members).toEqual([{ role: 'dev-1', count: 2 }])
    expect(built.patch.roles_dir).toBe('/tmp/roles')
    expect(built.patch.workflow).toBeDefined()
  })
})
