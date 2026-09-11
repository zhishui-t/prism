/**
 * 团队校验（design-v3 §4.2，逐条落实 team-definition.md §2/§3）。
 */

import type { RoleDefinition, TeamDefinition, ValidationIssue, ValidationResult } from '../types.js'

export const KNOWLEDGE_LAYERS = ['global', 'project', 'role'] as const

/** knowledge EntryType（镜像 @prism/knowledge types.ts；agents 不依赖 knowledge）。 */
export const ENTRY_TYPES: readonly string[] = [
  'rule', 'doc', 'guide', 'pitfall', 'pattern', 'diagram', 'summary', 'other',
]

/**
 * 编排角色白名单：工作流 `roles[]` 中命中则豁免 members 校验（design-v3 §4.2 P1 修订）。
 * 队长是编排角色，不属于被派遣成员。
 */
export const ORCHESTRATOR_ROLES: readonly string[] = ['leader', '队长']

export interface ValidateTeamOptions {
  /** 角色库（校验 members[].role 与工作流引用是否存在）。 */
  roles: RoleDefinition[]
  /** 提供时校验团队 skills 引用是否已存在（未命中 → warning）。 */
  knownSkills?: string[]
}

/** 去掉实例记号：`dev-1#2` → `dev-1`（工作流元素语法见 types.ts WorkflowStage）。 */
export function stripInstanceMarker(roleRef: string): string {
  return roleRef.split('#')[0].trim()
}

/** 校验团队定义。ok = 无 error 级 issue（warning 不影响 ok）。 */
export function validateTeam(team: TeamDefinition, opts: ValidateTeamOptions): ValidationResult {
  const issues: ValidationIssue[] = []

  // team_id / name / description 必填
  if (team.team_id.trim() === '') issues.push({ level: 'error', code: 'team_id_required', message: 'team_id 必填' })
  if (team.name.trim() === '') issues.push({ level: 'error', code: 'name_required', message: 'name 必填' })
  if (team.description.trim() === '') {
    issues.push({ level: 'error', code: 'description_required', message: 'description 必填' })
  }

  // members 非空；成员数量 ≥ 1；成员角色必须在角色库存在
  if (team.members.length === 0) {
    issues.push({ level: 'error', code: 'members_empty', message: 'members 不能为空' })
  } else {
    // 角色引用解析大小写不敏感（队长裁决 2026-09-09：宿主约定宽于校验器，如 QA-checker/qa-checker 等价；
    // registry 层重名检查仍精确比对，QA-checker 与 qa-checker 可共存，此处取任一命中即视为存在）
    const known = new Set(opts.roles.map((r) => r.name.toLowerCase()))
    for (const member of team.members) {
      if (member.count < 1) {
        issues.push({
          level: 'error',
          code: 'member_count_invalid',
          message: `成员 ${member.role || '(空)'} 的 count 必须 ≥ 1（当前 ${member.count}）`,
        })
      }
      if (member.role.trim() === '') {
        issues.push({ level: 'error', code: 'member_role_required', message: 'members[].role 必填' })
        continue
      }
      if (!known.has(member.role.toLowerCase())) {
        issues.push({
          level: 'error',
          code: 'member_role_unknown',
          message: `成员角色在角色库不存在：${member.role}`,
        })
      }
    }
  }

  // 工作流每阶段 roles[] 的每个元素（去掉 #N 记号）必须在 members 里；leader/队长 豁免
  const memberRoles = new Set(team.members.map((m) => m.role))
  const referencedRoles = new Set<string>()
  team.workflow.forEach((stage) => {
    for (const roleRef of stage.roles) {
      const base = stripInstanceMarker(roleRef)
      referencedRoles.add(base)
      if (ORCHESTRATOR_ROLES.includes(base)) continue
      if (!memberRoles.has(base)) {
        issues.push({
          level: 'error',
          code: 'workflow_role_unknown',
          message: `工作流阶段「${stage.stage}」引用的角色不在 members：${roleRef}`,
          where: `workflow#${stage.order}`,
        })
      }
    }
  })

  // 反向校验（warning，不影响 ok）：声明了成员却未出现在**任何**工作流阶段。
  // 上面的校验只查「工作流引用的 ∈ members」，反方向不查 —— 于是「编制里挂了个不干活的
  // 角色」会静默通过。不判 error 是因为它可能是**有意预留的机动位**；但必须显式可见，
  // 不能靠沉默掩盖（如为预留，保留即可；若是笔误，删掉该成员）。
  // 工作流为空时不报（那是「没有流程定义」这个另一个问题，不该放大成 N 条成员告警）。
  const referencedLower = new Set([...referencedRoles].map((r) => r.toLowerCase()))
  if (team.workflow.length > 0) {
    for (const member of team.members) {
      if (member.role.trim() === '') continue
      if (referencedLower.has(member.role.toLowerCase())) continue
      issues.push({
        level: 'warning',
        code: 'unused_member',
        message: `成员 ${member.role} 未出现在任何工作流阶段：编制悬空（有意预留可忽略；若非有意请补阶段或移出 members）`,
      })
    }
  }

  // deposit：default_layer / default_type / priority 枚举；rules[].match/.set 为对象
  const deposit = team.deposit
  if (!KNOWLEDGE_LAYERS.includes(deposit.default_layer)) {
    issues.push({
      level: 'error',
      code: 'deposit_layer_invalid',
      message: `deposit.default_layer 非法：${String(deposit.default_layer)}（合法：global/project/role）`,
    })
  }
  if (!ENTRY_TYPES.includes(deposit.default_type)) {
    issues.push({
      level: 'error',
      code: 'deposit_type_invalid',
      message: `deposit.default_type 非法：${deposit.default_type}（合法：${ENTRY_TYPES.join('/')}）`,
    })
  }
  if (!['low', 'medium', 'high'].includes(deposit.priority)) {
    issues.push({
      level: 'error',
      code: 'deposit_priority_invalid',
      message: `deposit.priority 非法：${String(deposit.priority)}（合法：low/medium/high）`,
    })
  }
  for (const [index, rule] of (deposit.rules ?? []).entries()) {
    if (!isObject(rule.match)) {
      issues.push({ level: 'error', code: 'deposit_rule_invalid', message: `deposit.rules[${index}].match 必须是对象` })
    }
    if (!isObject(rule.set)) {
      issues.push({ level: 'error', code: 'deposit_rule_invalid', message: `deposit.rules[${index}].set 必须是对象` })
    }
  }

  // rework_limit 正整数
  if (!Number.isInteger(team.rework_limit) || team.rework_limit < 1) {
    issues.push({
      level: 'error',
      code: 'rework_limit_invalid',
      message: `rework_limit 必须是正整数（当前 ${String(team.rework_limit)}）`,
    })
  }

  // arbitration 非空（warning）
  if (team.arbitration.length === 0) {
    issues.push({ level: 'warning', code: 'arbitration_empty', message: 'arbitration 仲裁链为空：角色间冲突将无全局裁决依据' })
  }

  // skills 引用存在（warning）
  if (opts.knownSkills !== undefined) {
    const known = new Set(opts.knownSkills)
    for (const skill of team.skills) {
      if (!known.has(skill)) {
        issues.push({ level: 'warning', code: 'skill_unknown', message: `引用的 skill 未安装：${skill}` })
      }
    }
  }

  // 团队 skills 与成员角色 skills 冲突（仅信息性 warning；键小写化与成员校验同口径）
  const roleSkills = new Map<string, Set<string>>()
  for (const role of opts.roles) roleSkills.set(role.name.toLowerCase(), new Set(role.skills))
  for (const teamSkill of team.skills) {
    for (const member of team.members) {
      if (roleSkills.get(member.role.toLowerCase())?.has(teamSkill)) {
        issues.push({
          level: 'warning',
          code: 'skill_redundant',
          message: `团队 skill「${teamSkill}」已由成员角色 ${member.role} 声明（合并规则下冗余，仅提示）`,
        })
      }
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues }
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
