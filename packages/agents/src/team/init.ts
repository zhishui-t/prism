/**
 * `team new` 脚手架渲染（design-v4 §F-C1 / §3.3）——**只渲染，不落盘**。
 *
 * 落盘由调用方负责（CLI 走 `guardWriteTarget` 写守卫；HTTP F-C3 显式传 `teams_dir`），
 * 使「写路径单点可审」。
 *
 * 输出走既有 `renderZcodeTeam`（不造第二个团队渲染器）：`<teamsDir>/<team_id>.md` 扁平形态，
 * `registry.ts` / `wiring.ts` 双形态均识别（design-v4 §F-C1 已核）。
 */

import { parseTeamMarkdown } from './parse.js'
import { renderZcodeTeam } from './render.js'
import { TEAM_TEMPLATES, fillTeamTemplate } from './templates.js'
import { ORCHESTRATOR_ROLES, stripInstanceMarker, validateTeam } from './validate.js'
import type { RoleDefinition, TeamDefinition, TeamMember, ValidationIssue, WorkflowStage } from '../types.js'

/** 与 `install.ts` 的 `KEBAB_CASE_RE` 同口径（团队 id = 文件名）。 */
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface TeamInitOptions {
  /** 新团队 id（必须 kebab-case；= 落盘文件名） */
  teamId: string
  /** 团队受管目录（调用方解析，**不在此推导宿主根**） */
  teamsDir: string
  /** 中文名；缺省 = `--from` 的名字，否则 = teamId */
  name?: string
  /** 描述；缺省 = `--from` 的描述，否则给可读占位（不能为空，否则校验不过） */
  description?: string
  /** 成员覆盖；缺省 = `--from` 的成员 / 模板成员 */
  members?: TeamMember[]
  /** 克隆源（CLI 经 `@prism/server` 的 `loadTeam` 载入；`extends` 保留） */
  from?: TeamDefinition
  /** 内置模板（缺省 `minimal`） */
  template?: 'minimal' | 'core-dev'
}

export interface TeamScaffold {
  /** 渲染出的 `<team_id>.md` 全文；硬失败（id 非法/模板未知）时为 `''` */
  markdown: string
  /**
   * 诊断。**error 存则调用方不得落盘**（design-v4 F-C1）。
   * 注意：这里只做**结构自检**（成员非空/count≥1/工作流角色在 members/deposit 枚举…），
   * 「成员角色是否存在于角色库」由调用方带真实角色库复跑 `validateTeam` 判定。
   */
  issues: ValidationIssue[]
}

/** 取第一个非空白字符串（都空则返回 fallback）。 */
function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * 渲染团队脚手架（纯函数，零 IO）。
 *
 * @example
 * renderTeamScaffold({ teamId: 'demo', teamsDir: '/tmp/teams', members: [{role:'dev-1',count:1}] })
 */
export function renderTeamScaffold(opts: TeamInitOptions): TeamScaffold {
  const issues: ValidationIssue[] = []
  const teamId = opts.teamId.trim()
  if (!KEBAB_CASE_RE.test(teamId)) {
    issues.push({
      level: 'error',
      code: 'team_id_invalid',
      message: `团队 id 必须 kebab-case（小写字母/数字/连字符）：${opts.teamId}`,
    })
    return { markdown: '', issues }
  }

  const name = firstNonEmpty(opts.name, opts.from?.name, teamId)
  const description = firstNonEmpty(
    opts.description,
    opts.from?.description,
    `${name}：由 prism team new 生成，请补充职责、适用与不适用边界。`,
  )

  let base: TeamDefinition
  if (opts.from !== undefined) {
    // 克隆：换 id/名/描述，其余（extends/skills/knowledge/deposit/workflow/body）原样继承
    base = {
      ...opts.from,
      team_id: teamId,
      name,
      description,
      members: opts.members ?? opts.from.members,
    }
  } else {
    const templateKey = opts.template ?? 'minimal'
    const skeleton: string | undefined = TEAM_TEMPLATES[templateKey]
    if (skeleton === undefined) {
      issues.push({
        level: 'error',
        code: 'team_template_unknown',
        message: `未知模板：${String(templateKey)}（可用：${Object.keys(TEAM_TEMPLATES).join('/')}）`,
      })
      return { markdown: '', issues }
    }
    let parsed: TeamDefinition
    try {
      parsed = parseTeamMarkdown(fillTeamTemplate(skeleton, { teamId, name, description }))
    } catch (error) {
      issues.push({
        level: 'error',
        code: 'team_template_invalid',
        message: `内置模板渲染后无法解析：${error instanceof Error ? error.message : String(error)}`,
      })
      return { markdown: '', issues }
    }
    base = {
      ...parsed,
      team_id: teamId,
      name,
      description,
      ...(opts.members !== undefined ? { members: opts.members } : {}),
    }
  }

  // 成员与工作流对齐：`--members` 收窄名册时，工作流里不属于成员的**非编排**角色会被剔除；
  // 因此整段消失的阶段随之删除并重编号（正文表格同步重渲染）——否则生成的文件立刻
  // `workflow_role_unknown`，且「error 不落盘」会让 `--members` 收窄名册成为死路。
  if (opts.members !== undefined) {
    const memberRoles = new Set(base.members.map((m) => m.role))
    const { stages, prunedStages, prunedRoles } = narrowWorkflow(base.workflow, memberRoles)
    if (prunedStages.length > 0 || prunedRoles.length > 0) {
      base = {
        ...base,
        workflow: stages,
        body: replaceWorkflowSection(base.body, renderWorkflowTable(stages)),
      }
      issues.push({
        level: 'warning',
        code: 'workflow_pruned',
        message:
          `按 --members 收窄工作流：剔除角色 ${[...new Set(prunedRoles)].join(', ') || '（无）'}` +
          `${prunedStages.length > 0 ? `；移除阶段 ${prunedStages.join(', ')}` : ''}`,
      })
    }
  }

  // 结构自检：用「成员自身」当角色库，避免 member_role_unknown 误报（角色库存在性由调用方判）
  const memberStubs: RoleDefinition[] = base.members.map((m) => ({
    name: m.role,
    description: '',
    skills: [],
    knowledge: { layers: ['global'] },
    principle: '',
    body: '',
  }))
  issues.push(...validateTeam(base, { roles: memberStubs }).issues)

  return { markdown: renderZcodeTeam(base), issues }
}

/**
 * 解析 `--members <role[:count],...>`。
 *
 * 语法：逗号分隔；`role` 必须非空；`count` 缺省 = 1，必须是 ≥1 的整数。
 * 同一角色重复声明 → **后者胜**（与团队规则「后者覆盖前者」同口径）。
 */
export function parseMembersSpec(spec: string): { members: TeamMember[]; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = []
  const byRole = new Map<string, number>()
  const parts = spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (parts.length === 0) {
    issues.push({
      level: 'error',
      code: 'members_invalid',
      message: '--members 为空（语法：<role>[:count]，逗号分隔）',
    })
    return { members: [], issues }
  }
  for (const part of parts) {
    const segments = part.split(':')
    const role = (segments[0] ?? '').trim()
    if (role === '' || segments.length > 2) {
      issues.push({ level: 'error', code: 'members_invalid', message: `成员语法非法：${part}（应为 <role>[:count]）` })
      continue
    }
    let count = 1
    const countRaw = segments[1]
    if (countRaw !== undefined) {
      const parsed = Number(countRaw.trim())
      if (!Number.isInteger(parsed) || parsed < 1) {
        issues.push({
          level: 'error',
          code: 'members_invalid',
          message: `成员 count 必须是 ≥1 的整数：${part}`,
        })
        continue
      }
      count = parsed
    }
    byRole.set(role, count)
  }
  return { members: [...byRole.entries()].map(([role, count]) => ({ role, count })), issues }
}

/**
 * 按成员名册收窄工作流：剔除不属于名册的**非编排**角色引用；
 * 整段被剔空（且不含编排角色）的阶段删除，其余阶段重编号（1..n）。
 * 返回被剔除的角色与被删除的阶段名，供调用方出 warning。
 */
export function narrowWorkflow(
  stages: WorkflowStage[],
  memberRoles: ReadonlySet<string>,
): { stages: WorkflowStage[]; prunedRoles: string[]; prunedStages: string[] } {
  const prunedRoles: string[] = []
  const prunedStages: string[] = []
  const kept: WorkflowStage[] = []
  for (const stage of stages) {
    const roles = stage.roles.filter((ref) => {
      const base = stripInstanceMarker(ref)
      const ok = ORCHESTRATOR_ROLES.includes(base) || memberRoles.has(base)
      if (!ok) prunedRoles.push(base)
      return ok
    })
    if (roles.length === 0) {
      prunedStages.push(stage.stage)
      continue
    }
    kept.push({ ...stage, roles })
  }
  return {
    stages: kept.map((stage, index) => ({ ...stage, order: index + 1 })),
    prunedRoles,
    prunedStages,
  }
}

/** 渲染工作流表格（与 `parseWorkflowTable` 的表头/列序严格对应，保证 parse 往返）。 */
export function renderWorkflowTable(stages: WorkflowStage[]): string {
  const header = '| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |'
  const separator = '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
  const rows = stages.map(
    (s) =>
      `| ${s.order} | ${s.stage} | ${s.roles.join(' + ') || '—'} | ${s.mode === 'parallel' ? '并行' : '串行'} | ${s.input} | ${s.output} | ${s.done} | ${s.reflow} |`,
  )
  return [header, separator, ...rows].join('\n')
}

/** 替换正文 `## 工作流` 小节内的表格（保留前后小节；无该小节时原样返回）。 */
export function replaceWorkflowSection(body: string, table: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const headingIdx = lines.findIndex((l) => l.trim() === '## 工作流')
  if (headingIdx === -1) return body
  let endIdx = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      endIdx = i
      break
    }
  }
  const before = lines.slice(0, headingIdx + 1)
  const after = lines.slice(endIdx)
  const rebuilt = [...before, '', table, '', ...after].join('\n')
  return `${rebuilt.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
