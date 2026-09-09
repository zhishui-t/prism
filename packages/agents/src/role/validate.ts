/**
 * 角色校验（design-v3 §4.1，逐条落实 role-definition.md §6）。
 */

import type { RoleColor, RoleDefinition, ValidationIssue, ValidationResult } from '../types.js'

export const ROLE_COLORS: readonly RoleColor[] = [
  'red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan',
]

export const THOUGHT_LEVELS = ['low', 'high', 'max'] as const

const KNOWLEDGE_LAYERS = ['global', 'project', 'role'] as const

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** description 长度上限（design-v3 §4.1；与 skill 描述同一约束口径）。 */
export const DESCRIPTION_MAX = 1024

export interface ValidateRoleOptions {
  /** 提供时校验 name 与目录名一致（Prism 原生目录式存储）。 */
  dirname?: string
  /** 提供时校验 skills 引用是否已存在（未命中 → warning）。 */
  knownSkills?: string[]
}

/** 校验单个角色。ok = 无 error 级 issue（warning 不影响 ok）。 */
export function validateRole(role: RoleDefinition, opts: ValidateRoleOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = []

  // name 必填（error）；kebab-case 违反降为 warning（队长裁决 2026-09-09：宿主实际约定宽于校验器
  // ——QA-checker 等在真实 ZCode 环境可正常派发，且 Windows 文件系统大小写不敏感，故不阻断）
  if (role.name.trim() === '') {
    issues.push({ level: 'error', code: 'name_required', message: 'name 必填' })
  } else if (!KEBAB_CASE_RE.test(role.name)) {
    issues.push({
      level: 'warning',
      code: 'role_name_not_kebab',
      message: `name 非 kebab-case：${role.name}（ZCode 可用但建议统一为 kebab-case）`,
    })
  }

  // name 与目录名一致（提供 dirname 时；大小写不敏感比对——Windows 文件系统口径；完全不匹配仍 error）
  if (opts.dirname !== undefined && role.name.toLowerCase() !== opts.dirname.toLowerCase()) {
    issues.push({
      level: 'error',
      code: 'name_dirname_mismatch',
      message: `name（${role.name}）与目录名（${opts.dirname}）不一致`,
    })
  }

  // description 必填、≤1024 字符
  if (role.description.trim() === '') {
    issues.push({ level: 'error', code: 'description_required', message: 'description 必填' })
  } else if (role.description.length > DESCRIPTION_MAX) {
    issues.push({
      level: 'error',
      code: 'description_too_long',
      message: `description 超过 ${DESCRIPTION_MAX} 字符（当前 ${role.description.length}）`,
    })
  }

  // 核心第一原则非空
  if (role.principle.trim() === '') {
    issues.push({ level: 'error', code: 'principle_missing', message: '核心第一原则缺失或为空（## 核心第一原则 / ## 核心契约）' })
  }

  // skills：空数组 = 未声明能力（warning，合法状态）；引用不存在（warning）
  if (role.skills.length === 0) {
    issues.push({ level: 'warning', code: 'skills_empty', message: 'skills 为空：未声明能力白名单（导入待填）' })
  } else if (opts.knownSkills !== undefined) {
    const known = new Set(opts.knownSkills)
    for (const skill of role.skills) {
      if (!known.has(skill)) {
        issues.push({ level: 'warning', code: 'skill_unknown', message: `引用的 skill 未安装：${skill}` })
      }
    }
  }

  // knowledge.layers ⊆ {global, project, role} 且非空
  if (role.knowledge.layers.length === 0) {
    issues.push({ level: 'error', code: 'knowledge_layers_empty', message: 'knowledge.layers 不能为空' })
  } else {
    const invalid = role.knowledge.layers.filter((l) => !KNOWLEDGE_LAYERS.includes(l))
    if (invalid.length > 0) {
      issues.push({
        level: 'error',
        code: 'knowledge_layers_invalid',
        message: `knowledge.layers 含非法层：${invalid.join(', ')}（合法：global/project/role）`,
      })
    }
  }

  // color ∈ RoleColor（若提供）
  if (role.color !== undefined && !ROLE_COLORS.includes(role.color)) {
    issues.push({ level: 'error', code: 'color_invalid', message: `color 非法：${role.color}（合法：${ROLE_COLORS.join('/')}）` })
  }

  // thoughtLevel ∈ {low, high, max}（若提供）
  if (role.thoughtLevel !== undefined && !THOUGHT_LEVELS.includes(role.thoughtLevel)) {
    issues.push({
      level: 'error',
      code: 'thoughtLevel_invalid',
      message: `thoughtLevel 非法：${role.thoughtLevel}（合法：${THOUGHT_LEVELS.join('/')}）`,
    })
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues }
}

/** 角色库内 name 唯一（design-v3 §4.1 末条，RoleRegistry 层面）。 */
export function validateRoleUniqueness(roles: RoleDefinition[]): ValidationResult {
  const seen = new Map<string, number>()
  const issues: ValidationIssue[] = []
  roles.forEach((role, index) => {
    const count = seen.get(role.name) ?? 0
    if (count > 0) {
      issues.push({
        level: 'error',
        code: 'role_duplicate',
        message: `角色名重复：${role.name}（第 ${count + 1} 个与第 ${index + 1} 个）`,
        where: role.sourcePath,
      })
    }
    seen.set(role.name, count + 1)
  })
  return { ok: issues.length === 0, issues }
}
