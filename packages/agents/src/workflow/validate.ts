/**
 * 工作流单元校验（workflow-asset.md §校验）。
 *
 * 强弱口径刻意区分（避免假门禁）：
 * - **error**：结构性缺陷（id/名称/级别缺失、步骤表为空）与 `binds` 显式声明的角色不存在——
 *   binds 是 frontmatter 里白纸黑字写的绑定，错了必须拦；
 * - **warning**：`承接` 列的非角色词（合法值含「队长 / 人 / 独立实例」等编排语义，不做强校验）、
 *   skill 引用未安装、角色级单元 binds 为空（多承接者情形，提示改标 team 级或补 binds）。
 */

import type { RoleDefinition, ValidationIssue, ValidationResult, WorkflowDefinition } from '../types.js'

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** `承接` 列的豁免词（编排语义词，不是角色名——不参与 step_owner_unknown）。 */
export const STEP_OWNER_WORDS: readonly string[] = [
  '队长', 'leader', '主会话', '人', '人签', '独立实例', '新会话', '脚本', '全部', '全员', '—', '-', '',
]

export interface ValidateWorkflowOptions {
  /** 角色库（提供时校验 binds 存在性——小写不敏感，同 validateTeam 口径）。 */
  roles?: RoleDefinition[]
  /** 已安装 skill（提供时 frontmatter skills 引用未命中 → warning）。 */
  knownSkills?: string[]
}

/** 校验单个工作流单元。ok = 无 error 级 issue（warning 不影响 ok）。 */
export function validateWorkflow(wf: WorkflowDefinition, opts: ValidateWorkflowOptions = {}): ValidationResult {
  const issues: ValidationIssue[] = []

  if (wf.workflow.trim() === '') {
    issues.push({ level: 'error', code: 'workflow_id_required', message: 'frontmatter `workflow` 必填（= 文件名，kebab-case）' })
  } else if (!KEBAB_CASE_RE.test(wf.workflow)) {
    issues.push({
      level: 'warning',
      code: 'workflow_id_not_kebab',
      message: `workflow id 非 kebab-case：${wf.workflow}（建议统一为 kebab-case，= 文件名）`,
    })
  }

  if (wf.name.trim() === '') {
    issues.push({ level: 'error', code: 'workflow_name_required', message: 'frontmatter `name` 必填' })
  }

  if (wf.level !== 'role' && wf.level !== 'team') {
    issues.push({ level: 'error', code: 'workflow_level_invalid', message: `level 非法：${String(wf.level)}（合法：role/team）` })
  } else if (wf.level === 'role' && wf.binds.length === 0) {
    issues.push({
      level: 'warning',
      code: 'workflow_binds_empty',
      message: '角色级单元 binds 为空——多承接者单元建议改标 team 级，或补上绑定角色',
    })
  }

  if (wf.binds.length > 0 && opts.roles !== undefined) {
    const known = new Set(opts.roles.map((r) => r.name.toLowerCase()))
    for (const bind of wf.binds) {
      if (!known.has(bind.toLowerCase())) {
        issues.push({
          level: 'error',
          code: 'workflow_binds_role_unknown',
          message: `binds 声明的角色不存在：${bind}`,
          where: 'binds',
        })
      }
    }
  }

  if (wf.steps.length === 0) {
    issues.push({ level: 'error', code: 'workflow_steps_empty', message: '步骤表为空（## 步骤表 至少一行步骤）' })
  } else {
    // 「#」列需从 1 连续编号（order 是「回 N」规范形的寻址基准）；重复序号会让
    // 回流指向歧义、图编辑器重编号错乱——数据侧由 parse 的 step_order_defaulted
    // 兜非正整数，这里拦重复
    const seen = new Set<number>()
    for (const step of wf.steps) {
      if (seen.has(step.order)) {
        issues.push({
          level: 'error',
          code: 'workflow_step_order_duplicate',
          message: `步骤序号重复：${step.order}（「#」列需从 1 连续编号）`,
          where: `steps#${step.order}`,
        })
      }
      seen.add(step.order)
    }
  }

  if (opts.roles !== undefined) {
    const known = new Set(opts.roles.map((r) => r.name.toLowerCase()))
    const words = new Set(STEP_OWNER_WORDS.map((w) => w.toLowerCase()))
    for (const step of wf.steps) {
      for (const owner of step.owner) {
        if (!words.has(owner.toLowerCase()) && !known.has(owner.toLowerCase())) {
          issues.push({
            level: 'warning',
            code: 'workflow_step_owner_unknown',
            message: `步骤 ${step.order}「${step.step}」的承接「${owner}」不是角色库角色（若是编排语义如「独立实例」可忽略）`,
            where: `steps#${step.order}`,
          })
        }
      }
    }
  }

  if (wf.skills.length > 0 && opts.knownSkills !== undefined) {
    const known = new Set(opts.knownSkills)
    for (const skill of wf.skills) {
      if (!known.has(skill)) {
        issues.push({ level: 'warning', code: 'workflow_skill_unknown', message: `引用的 skill 未安装：${skill}` })
      }
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues }
}

/** 工作流库内 id 唯一（加载层使用）。 */
export function validateWorkflowUniqueness(workflows: WorkflowDefinition[]): ValidationResult {
  const seen = new Map<string, number>()
  const issues: ValidationIssue[] = []
  workflows.forEach((wf, index) => {
    const count = seen.get(wf.workflow) ?? 0
    if (count > 0) {
      issues.push({
        level: 'error',
        code: 'workflow_duplicate',
        message: `工作流 id 重复：${wf.workflow}（第 ${count + 1} 个与第 ${index + 1} 个）`,
        where: wf.sourcePath,
      })
    }
    seen.set(wf.workflow, count + 1)
  })
  return { ok: issues.length === 0, issues }
}
