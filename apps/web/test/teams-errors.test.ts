import { beforeEach, describe, expect, it } from 'vitest'

import { setLang, t } from '../src/i18n.ts'
import { describeFailure, type TFunc } from '../src/pages/teams/errors.ts'

beforeEach(() => setLang('zh'))

const ID = 'core-dev'

describe('describeFailure · 非业务分支', () => {
  it('无 code（fetch 抛错 / 响应非 JSON）→ 连接失败文案，带原文', () => {
    const out = describeFailure(t, 'Failed to fetch', ID)
    expect(out).toBe(t('teams.err.connect', { msg: 'Failed to fetch' }))
    expect(out).toContain('Failed to fetch')
  })

  it('bad_request 且 message 里没有具体码 → 直接呈现服务端原因（不包通用壳）', () => {
    expect(describeFailure(t, 'bad_request: 成员数量超出上限', ID)).toBe('成员数量超出上限')
  })

  it('未知码 → 通用文案，code 与 message 都可见（不静默）', () => {
    const out = describeFailure(t, 'internal_error: boom', ID)
    expect(out).toBe(t('teams.err.generic', { code: 'internal_error', msg: 'boom' }))
    expect(out).toContain('internal_error')
    expect(out).toContain('boom')
  })
})

describe('describeFailure · 逐码分支', () => {
  it('teams_dir_required（具体码在 message 开头、全角冒号）', () => {
    expect(describeFailure(t, 'bad_request: teams_dir_required：未指定团队目录', ID)).toBe(t('teams.err.dirRequired'))
  })

  it('team_id_invalid', () => {
    expect(describeFailure(t, 'bad_request: team_id_invalid：只能用小写字母', ID)).toBe(t('teams.err.idInvalid'))
  })

  it('member_role_unknown → 从 detail 里抠出角色名', () => {
    const out = describeFailure(t, 'bad_request: member_role_unknown：角色不在角色库中：dev-9（可选 dev-1）', ID)
    expect(out).toBe(t('teams.err.roleUnknown', { role: 'dev-9' }))
    expect(out).toContain('dev-9')
  })

  it('设计期码 role_not_found（半角冒号）也认', () => {
    const out = describeFailure(t, 'bad_request: role_not_found: 角色不存在：dev-9', ID)
    expect(out).toContain('dev-9')
  })

  it('角色名抠不到时回落占位符，不崩也不谎报角色', () => {
    expect(describeFailure(t, 'bad_request: role_not_found: 未知原因', ID)).toBe(
      t('teams.err.roleUnknown', { role: '?' }),
    )
  })

  it('members_invalid → 带 detail', () => {
    const out = describeFailure(t, 'bad_request: members_invalid：count 3 out of range', ID)
    expect(out).toBe(t('teams.err.membersInvalid', { msg: 'count 3 out of range' }))
    expect(out).toContain('count 3 out of range')
  })

  it('设计期码 invalid_members 也认', () => {
    const out = describeFailure(t, 'bad_request: invalid_members：bad shape', ID)
    expect(out).toContain('bad shape')
  })

  it('id_conflict（业务码在信封上）→ 文案带被占用的 team_id', () => {
    const out = describeFailure(t, 'id_conflict: already exists', ID)
    expect(out).toBe(t('teams.err.exists', { id: ID }))
    expect(out).toContain(ID)
  })

  it('设计期码 team_exists 也认（两套都认，避免任一侧改动后静默失败）', () => {
    expect(describeFailure(t, 'team_exists: nope', ID)).toBe(t('teams.err.exists', { id: ID }))
  })
})

describe('describeFailure · 信封码优先于具体码', () => {
  it('message 开头的具体码决定分支，即使信封是别的码', () => {
    const out = describeFailure(t, 'internal_error: team_id_invalid：nope', ID)
    expect(out).toBe(t('teams.err.idInvalid'))
  })

  it('空 detail 时具体码仍生效', () => {
    expect(describeFailure(t, 'bad_request: teams_dir_required：', ID)).toBe(t('teams.err.dirRequired'))
  })
})

describe('describeFailure · 与 translate 无关', () => {
  it('只走传入的 t（语言由调用方决定，函数自身无全局状态）', () => {
    const seen: string[] = []
    const spy: TFunc = (key) => {
      seen.push(key)
      return `[${key}]`
    }
    expect(describeFailure(spy, 'id_conflict: x', ID)).toBe('[teams.err.exists]')
    expect(seen).toEqual(['teams.err.exists'])
  })
})
