import { describe, expect, it } from 'vitest'

import { validateRole, validateRoleUniqueness } from '../src/role/validate.js'
import type { RoleDefinition } from '../src/types.js'

function makeRole(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    name: 'dev-1',
    description: '一般开发：常规功能开发。适用于：功能编码。不适用于：架构攻关。',
    skills: ['code_review'],
    knowledge: { layers: ['global', 'project'] },
    principle: '交付可运行的增量，绝不扩大战场。',
    body: '# dev-1\n\n## 核心第一原则\n**交付可运行的增量。**',
    ...overrides,
  }
}

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code)

describe('validateRole（design-v3 §4.1 逐条）', () => {
  it('正例：合法角色 ok=true 无 issue', () => {
    const result = validateRole(makeRole(), { knownSkills: ['code_review'] })
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('name 必填（error）；kebab-case 违反降为 warning 不阻断（队长裁决 2026-09-09）', () => {
    expect(codes(validateRole(makeRole({ name: '' })).issues)).toContain('name_required')
    // 非 kebab-case → warning，不阻断（QA-checker 实机案例：ZCode 可用，建议统一）
    for (const notKebab of ['Dev 1', 'QA-checker']) {
      const result = validateRole(makeRole({ name: notKebab }))
      expect(result.ok, notKebab).toBe(true)
      const issue = result.issues.find((i) => i.code === 'role_name_not_kebab')
      expect(issue?.level, notKebab).toBe('warning')
      expect(issue?.message, notKebab).toContain('ZCode 可用但建议统一为 kebab-case')
    }
    expect(codes(validateRole(makeRole({ name: 'dev-1' })).issues)).not.toContain('role_name_not_kebab')
  })

  it('name 与目录名比对大小写不敏感（QA-checker/qa-checker → 0 error）；完全不匹配仍 error', () => {
    // 实机案例：frontmatter "QA-checker" vs 文件 qa-checker.md → 大小写差异不算不一致，可有 warning、无 error
    const caseOnlyDiff = validateRole(makeRole({ name: 'QA-checker' }), { dirname: 'qa-checker' })
    expect(caseOnlyDiff.ok).toBe(true)
    expect(caseOnlyDiff.issues.filter((i) => i.level === 'error')).toHaveLength(0)
    // 完全不匹配 → 仍 error
    const mismatch = validateRole(makeRole({ name: 'foo' }), { dirname: 'bar' })
    expect(mismatch.ok).toBe(false)
    expect(codes(mismatch.issues)).toContain('name_dirname_mismatch')
    const same = validateRole(makeRole({ name: 'dev-1' }), { dirname: 'dev-1' })
    expect(same.ok).toBe(true)
  })

  it('description 必填、≤1024 字符（error）', () => {
    expect(codes(validateRole(makeRole({ description: '' })).issues)).toContain('description_required')
    const long = validateRole(makeRole({ description: '长'.repeat(1025) }))
    expect(codes(long.issues)).toContain('description_too_long')
    expect(long.ok).toBe(false)
    const exactly = validateRole(makeRole({ description: 'a'.repeat(1024) }))
    expect(codes(exactly.issues)).not.toContain('description_too_long')
  })

  it('核心第一原则非空（error）——缺原则/名不符文件必须报错（F07 验收）', () => {
    const result = validateRole(makeRole({ principle: '' }))
    expect(result.ok).toBe(false)
    expect(codes(result.issues)).toContain('principle_missing')
  })

  it('skills 空数组 = warning（不是 error，未声明能力合法）', () => {
    const result = validateRole(makeRole({ skills: [] }))
    expect(result.ok).toBe(true)
    expect(codes(result.issues)).toContain('skills_empty')
    expect(result.issues.find((i) => i.code === 'skills_empty')?.level).toBe('warning')
  })

  it('skills 引用不存在 → warning（knownSkills 提供时）', () => {
    const result = validateRole(makeRole({ skills: ['code_review', 'ghost_skill'] }), {
      knownSkills: ['code_review'],
    })
    expect(result.ok).toBe(true)
    expect(result.issues.filter((i) => i.code === 'skill_unknown')).toHaveLength(1)
  })

  it('knowledge.layers ⊆ {global,project,role} 且非空（error）', () => {
    expect(codes(validateRole(makeRole({ knowledge: { layers: [] } })).issues)).toContain('knowledge_layers_empty')
    expect(codes(validateRole(makeRole({ knowledge: { layers: ['global', 'universe' as never] } })).issues)).toContain(
      'knowledge_layers_invalid',
    )
  })

  it('color ∈ RoleColor（若提供，error）', () => {
    expect(codes(validateRole(makeRole({ color: 'red' })).issues)).not.toContain('color_invalid')
    const bad = validateRole(makeRole({ color: '#ff0000' as never }))
    expect(codes(bad.issues)).toContain('color_invalid')
    expect(bad.ok).toBe(false)
  })

  it('thoughtLevel ∈ {low,high,max}（若提供，error）', () => {
    expect(codes(validateRole(makeRole({ thoughtLevel: 'max' })).issues)).not.toContain('thoughtLevel_invalid')
    const bad = validateRole(makeRole({ thoughtLevel: 'ultra' as never }))
    expect(codes(bad.issues)).toContain('thoughtLevel_invalid')
  })
})

describe('validateRoleUniqueness（角色库内 name 唯一，registry 层面）', () => {
  it('重名 → error 并指出来源', () => {
    const roles = [makeRole(), makeRole({ body: '另一份' })]
    const result = validateRoleUniqueness(roles)
    expect(result.ok).toBe(false)
    expect(result.issues[0].code).toBe('role_duplicate')
  })

  it('无重名 → ok', () => {
    expect(validateRoleUniqueness([makeRole(), makeRole({ name: 'writer' })]).ok).toBe(true)
  })
})
