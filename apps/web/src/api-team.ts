/** 角色 / 团队 / 技能 相关 API（design-v3.md §3.3）。 */

import type { Envelope } from './api.ts'

export interface KnowledgeBinding {
  layers: string[]
  books?: string[]
}

export interface RoleDefinition {
  name: string
  description: string
  color?: string
  skills: string[]
  knowledge: KnowledgeBinding
  principle: string
  body: string
  model?: string
  thoughtLevel?: string
  sourcePath?: string
  /** 校验结果（服务端随列表/详情返回，P9） */
  issues?: ValidationIssue[]
}

export interface TeamMember {
  role: string
  count: number
}

export interface WorkflowStage {
  order: number
  stage: string
  /** 该阶段负责角色（多角色用 `name#N` 表示第 N 个实例） */
  roles: string[]
  mode: string
  input: string
  output: string
  done: string
  reflow: string
}

export interface DepositPolicy {
  enabled: boolean
  default_layer: string
  default_type: string
  priority: string
  require_note: boolean
}

export interface TeamDefinition {
  team_id: string
  name: string
  description: string
  default: boolean
  members: TeamMember[]
  skills: string[]
  knowledge: KnowledgeBinding
  deposit: DepositPolicy
  arbitration: string[]
  workflow: WorkflowStage[]
}

export interface TeamActivation {
  team_id: string
  members: Array<{
    role: string
    count: number
    installed: boolean
    dispatch: string
    hint?: string
  }>
  workflow: WorkflowStage[]
  deposit: DepositPolicy
}

export interface PrismSkill {
  name: string
  description: string
  builtin: boolean
}

export interface ValidationIssue {
  level: string
  code: string
  message: string
  where?: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = (await res.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${body.error.code}: ${body.error.message}`)
  return body.value
}

/** 技能使用视图（/api/skills/usage）。 */
export interface SkillUsage {
  name: string
  builtin: boolean
  installed: boolean
  roles: string[]
  teams: string[]
}

/** 团队列表 + 受管 teams 目录（design-v4 §3.4：GET /api/teams 增只读 teamsDir）。 */
export interface TeamsIndex {
  teams: TeamDefinition[]
  /** 受管 teams 目录绝对路径（只读）。仅用于新建表单预填，**不硬编码宿主路径**（R6）。 */
  teamsDir?: string
}

/**
 * GET /api/teams 形状兼容：历史为裸数组；design-v4 §3.4 要求返回体增只读 `teamsDir`
 * （数组上加字段不可表达，故可能改为 `{ teams, teamsDir }`）。两种形状都接受，
 * 避免与流 2 的落地形状耦合。
 */
function normalizeTeams(value: TeamDefinition[] | { teams: TeamDefinition[]; teamsDir?: string }): TeamsIndex {
  if (Array.isArray(value)) return { teams: value }
  return {
    teams: value.teams ?? [],
    ...(value.teamsDir !== undefined ? { teamsDir: value.teamsDir } : {}),
  }
}

/** 新建团队入参（ui-spec-v4 §2.5）。`teams_dir` 必须由调用方显式提供（无 env 回落）。 */
export interface NewTeamInput {
  team_id: string
  name: string
  description?: string
  members: TeamMember[]
  skills?: string[]
  deposit?: Partial<DepositPolicy>
  /** 工作流模板（后端缺省 = minimal）。 */
  workflow_template?: 'minimal' | 'core-dev'
  teams_dir: string
}

export interface NewTeamResult {
  ok: boolean
  path: string
  issues: ValidationIssue[]
}

/** Skill 有效集（F-D2，角色 × 团队 → 能用的 skill）。 */
export interface EffectiveSkill {
  name: string
  /** 声明来源，去重；顺序固定 global → team → role。 */
  sources: Array<'global' | 'team' | 'role'>
  /** 宿主是否已安装 */
  available: boolean
}

export interface EffectiveSkillSet {
  role: string
  team?: string
  skills: EffectiveSkill[]
  warnings: ValidationIssue[]
}

export const teamApi = {
  roles: () => request<RoleDefinition[]>('/api/roles'),
  role: (name: string) => request<RoleDefinition>(`/api/roles/${encodeURIComponent(name)}`),
  teams: () => request<TeamDefinition[] | { teams: TeamDefinition[]; teamsDir?: string }>('/api/teams').then(normalizeTeams),
  team: (id: string) => request<TeamDefinition>(`/api/teams/${encodeURIComponent(id)}`),
  activate: (id: string) => request<TeamActivation>(`/api/teams/${encodeURIComponent(id)}/activate`),
  skills: () => request<PrismSkill[]>('/api/skills'),
  skillUsage: () => request<SkillUsage[]>('/api/skills/usage'),

  /** 新建团队（F-C2 → POST /api/teams，F-C3 落地）。 */
  create: (input: NewTeamInput) =>
    request<NewTeamResult>('/api/teams', { method: 'POST', body: JSON.stringify(input) }),

  /** Skill 有效集（F-D2 → GET /api/skills/effective）。角色不存在时服务端 404 信封。 */
  effectiveSkills: (role: string, team?: string) => {
    const qs = new URLSearchParams({ role })
    if (team !== undefined && team !== '') qs.set('team', team)
    return request<EffectiveSkillSet>(`/api/skills/effective?${qs.toString()}`)
  },
}
