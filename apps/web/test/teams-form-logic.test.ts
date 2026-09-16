import { beforeEach, describe, expect, it } from 'vitest'

import { setLang, t } from '../src/i18n.ts'
import { validateCreate, type TeamFormValues } from '../src/pages/teams/form-logic.ts'
import type { RoleDefinition } from '../src/api-team.ts'

beforeEach(() => setLang('zh'))

function values(over: Partial<TeamFormValues> = {}): TeamFormValues {
  return {
    teamId: 'core-dev',
    name: 'Core Dev',
    description: '',
    counts: {},
    filter: '',
    template: 'minimal',
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
