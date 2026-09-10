import { describe, expect, it } from 'vitest'

import { computeEffectiveSkills } from '../src/skill-effective.js'

/**
 * F-D1：Skill 有效集（design-v4 §F-D1 / §3.3）。
 * 覆盖验收清单：叠加 / 重复（sources 累积）/ 缺失两类 / 排序 / 空输入 / installed·known 缺省。
 */
describe('computeEffectiveSkills（F-D1）', () => {
  it('三层叠加：全局已装 ∪ 团队 ∪ 角色（去重保序 global→team→role）', () => {
    const out = computeEffectiveSkills({
      installed: ['prism', 'code_review'],
      teamSkills: ['code_review', 'team_only'],
      roleSkills: ['taint_trace', 'prism'],
      known: ['prism', 'code_review', 'team_only', 'taint_trace'],
      role: 'dev-1',
      team: 'core-dev',
    })
    expect(out.role).toBe('dev-1')
    expect(out.team).toBe('core-dev')
    // 按 name 升序
    expect(out.skills.map((s) => s.name)).toEqual(['code_review', 'prism', 'taint_trace', 'team_only'])
    // sources 累积：code_review 既全局装了也被团队声明；prism 全局 + 角色
    const byName = new Map(out.skills.map((s) => [s.name, s]))
    expect(byName.get('code_review')?.sources).toEqual(['global', 'team'])
    expect(byName.get('prism')?.sources).toEqual(['global', 'role'])
    expect(byName.get('taint_trace')?.sources).toEqual(['role'])
    expect(byName.get('team_only')?.sources).toEqual(['team'])
    // 只有宿主已装的才是 available；未装的两个给 skill_not_installed
    expect(out.skills.map((s) => [s.name, s.available])).toEqual([
      ['code_review', true],
      ['prism', true],
      ['taint_trace', false],
      ['team_only', false],
    ])
    expect(out.warnings.map((w) => [w.code, w.message.includes('taint_trace') ? 'taint_trace' : 'team_only'])).toEqual([
      ['skill_not_installed', 'taint_trace'],
      ['skill_not_installed', 'team_only'],
    ])
  })

  it('重复来源不重复累积（同层内重复名字只算一次）', () => {
    const out = computeEffectiveSkills({
      installed: ['a', 'a'],
      teamSkills: ['a', 'a'],
      roleSkills: ['a'],
      known: ['a'],
    })
    expect(out.skills).toHaveLength(1)
    expect(out.skills[0]?.sources).toEqual(['global', 'team', 'role'])
  })

  it('缺失：声明了但宿主未装 → skill_not_installed（warning）', () => {
    const out = computeEffectiveSkills({
      installed: ['prism'],
      roleSkills: ['ghost_skill'],
      known: ['prism', 'ghost_skill'],
    })
    expect(out.skills.map((s) => [s.name, s.available])).toEqual([
      ['ghost_skill', false],
      ['prism', true],
    ])
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toMatchObject({ level: 'warning', code: 'skill_not_installed' })
    expect(out.warnings[0]?.message).toContain('ghost_skill')
  })

  it('缺失：库/内置都不存在 → skill_unknown（warning），且不再重复报 not_installed', () => {
    const out = computeEffectiveSkills({
      installed: ['prism'],
      roleSkills: ['ghost_skill'],
      known: ['prism'],
    })
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toMatchObject({ level: 'warning', code: 'skill_unknown' })
  })

  it('已知但未装 + 未知混合 → 两条告警各一', () => {
    const out = computeEffectiveSkills({
      installed: ['prism'],
      teamSkills: ['known_but_missing', 'totally_ghost'],
      roleSkills: [],
      known: ['prism', 'known_but_missing'],
    })
    expect(out.warnings.map((w) => w.code).sort()).toEqual(['skill_not_installed', 'skill_unknown'])
  })

  it('排序：按 name 升序（与声明顺序/来源顺序无关）', () => {
    const out = computeEffectiveSkills({
      installed: ['zeta', 'alpha'],
      teamSkills: ['mike'],
      roleSkills: ['bravo'],
    })
    expect(out.skills.map((s) => s.name)).toEqual(['alpha', 'bravo', 'mike', 'zeta'])
  })

  it('空输入：全空 → 空集，无告警', () => {
    const out = computeEffectiveSkills({ roleSkills: [] })
    expect(out.skills).toEqual([])
    expect(out.warnings).toEqual([])
    expect(out.role).toBe('')
    expect(out.team).toBeUndefined()
  })

  it('installed 缺省（宿主 skills 目录不存在）→ available 全 true 且不报 not_installed', () => {
    const out = computeEffectiveSkills({ roleSkills: ['x'], teamSkills: ['y'], known: ['x', 'y'] })
    expect(out.skills.every((s) => s.available)).toBe(true)
    expect(out.warnings).toEqual([])
    expect(out.skills.find((s) => s.name === 'x')?.sources).toEqual(['role'])
  })

  it('known 缺省 → 不判 skill_unknown（只按 installed 判 not_installed）', () => {
    const out = computeEffectiveSkills({ installed: ['prism'], roleSkills: ['ghost'] })
    expect(out.warnings.map((w) => w.code)).toEqual(['skill_not_installed'])
  })

  it('known 与 installed 都缺省 → 零告警（与现状兼容）', () => {
    const out = computeEffectiveSkills({ roleSkills: ['a'], teamSkills: ['b'] })
    expect(out.warnings).toEqual([])
    expect(out.skills.map((s) => s.name)).toEqual(['a', 'b'])
    expect(out.skills.every((s) => s.available)).toBe(true)
  })

  it('空白名字被忽略（不产生幽灵条目）', () => {
    const out = computeEffectiveSkills({ roleSkills: ['  ', 'ok'], teamSkills: [''], installed: [] })
    expect(out.skills.map((s) => s.name)).toEqual(['ok'])
    expect(out.skills[0]?.sources).toEqual(['role'])
  })

  it('团队可选：未传 team → 输出无 team 字段', () => {
    const out = computeEffectiveSkills({ roleSkills: ['a'], role: 'r1' })
    expect(out.role).toBe('r1')
    expect('team' in out).toBe(false)
  })
})
