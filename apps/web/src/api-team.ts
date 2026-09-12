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
  /** 只读：宿主 agents 目录里是否已有该角色定义（server 侧包装，v5/S5） */
  installed?: boolean
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

/* ==================== 角色增删改（v5 三入口对齐） ==================== */

const ROLE_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const

export type RoleColor = (typeof ROLE_COLORS)[number]

/** 合法角色色（与服务端 `packages/agents/src/role/validate.ts` 的 `ROLE_COLORS` 同口径）。 */
export const ROLE_COLOR_OPTIONS: readonly RoleColor[] = ROLE_COLORS

/** `GET /api/roles` 返回体（v5：由裸数组改为 `{ roles, rolesDir }`，与 `/api/teams` 同形）。 */
export interface RolesIndex {
  roles: RoleDefinition[]
  /** 受管 roles 目录绝对路径（只读）。仅用于新建表单预填，**不硬编码宿主路径**（R6）。 */
  rolesDir?: string
}

/** 裸数组（历史形状）与 `{roles, rolesDir}` 都接受——避免与后端落地形状耦合。 */
function normalizeRoles(
  value: RoleDefinition[] | { roles: RoleDefinition[]; rolesDir?: string },
): RolesIndex {
  if (Array.isArray(value)) return { roles: value }
  return {
    roles: value.roles ?? [],
    ...(value.rolesDir !== undefined ? { rolesDir: value.rolesDir } : {}),
  }
}

/** 新建/修改角色入参。`roles_dir` 必须由调用方显式提供（无 env 回落，R5/R6）。 */
export interface RoleWriteInput {
  name?: string
  description?: string
  /** 能力白名单；`[]` = 清空（仅 PATCH 有意义） */
  skills?: string[]
  knowledge?: KnowledgeBinding
  /** 正文（Markdown）。`new` 时省略 → 用内置骨架；`update` 时给出即整体替换正文。 */
  body?: string
  /** `''` / `null` = 清除该 frontmatter 键（仅 PATCH 有意义） */
  color?: RoleColor | '' | null
  model?: string | null
  thought_level?: ThoughtLevel | '' | null
  /** **必填**：写入目录 */
  roles_dir: string
  /** 仅 `create` 认：目标已存在时是否覆盖。 */
  force?: boolean
}

/** 思考档位（与 `packages/agents/src/types.ts` 的 `RoleDefinition.thoughtLevel` 同口径）。 */
export type ThoughtLevel = 'low' | 'high' | 'max'

export const THOUGHT_LEVELS: readonly ThoughtLevel[] = ['low', 'high', 'max']

/** 角色写盘结果（`POST/PATCH /api/roles`）。 */
export interface RoleWriteResult {
  path: string
  /** 是否发生了覆盖（`force: true`）。 */
  overwritten: boolean
}

/** `DELETE /api/roles/:name` 结果。 */
export interface RoleRemoveResult {
  removed: string[]
}

/** 修改团队入参（`PATCH /api/teams/:id`）。改 `members` 时须同时给 `roles_dir`。 */
export interface UpdateTeamInput {
  name?: string
  description?: string
  members?: TeamMember[]
  deposit?: Partial<DepositPolicy>
  /** **必填**：目标 teams 目录 */
  teams_dir: string
  /** 改 `members` 时必填（校验角色存在） */
  roles_dir?: string
}

/** `DELETE /api/teams/:id` 结果。 */
export interface RemoveResult {
  removed: string[]
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
  roles: () =>
    request<RoleDefinition[] | { roles: RoleDefinition[]; rolesDir?: string }>('/api/roles').then(normalizeRoles),
  role: (name: string) => request<RoleDefinition>(`/api/roles/${encodeURIComponent(name)}`),
  teams: () => request<TeamDefinition[] | { teams: TeamDefinition[]; teamsDir?: string }>('/api/teams').then(normalizeTeams),
  team: (id: string) => request<TeamDefinition>(`/api/teams/${encodeURIComponent(id)}`),
  activate: (id: string) => request<TeamActivation>(`/api/teams/${encodeURIComponent(id)}/activate`),
  skills: () => request<PrismSkill[]>('/api/skills'),
  skillUsage: () => request<SkillUsage[]>('/api/skills/usage'),

  /** 新建团队（F-C2 → POST /api/teams，F-C3 落地）。 */
  create: (input: NewTeamInput) =>
    request<NewTeamResult>('/api/teams', { method: 'POST', body: JSON.stringify(input) }),

  /** 修改团队（v5 → PATCH /api/teams/:id）。改 members 时服务端会就地收窄工作流。 */
  updateTeam: (id: string, input: UpdateTeamInput) =>
    request<{ path: string; issues: ValidationIssue[] }>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /** 删除团队（v5 → DELETE /api/teams/:id）。**硬删**，`teams_dir` 必填。 */
  deleteTeam: (id: string, teamsDir: string) =>
    request<RemoveResult>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ teams_dir: teamsDir }),
    }),

  /** 新建角色（v5 → POST /api/roles），按宿主原生形态落盘。 */
  createRole: (input: RoleWriteInput) =>
    request<RoleWriteResult>('/api/roles', { method: 'POST', body: JSON.stringify(input) }),

  /** 修改角色（v5 → PATCH /api/roles/:name），外科式字段补丁，正文不重排。 */
  updateRole: (name: string, input: RoleWriteInput) =>
    request<RoleWriteResult>(`/api/roles/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /** 删除角色（v5 → DELETE /api/roles/:name）。**硬删**，`roles_dir` 必填。 */
  deleteRole: (name: string, rolesDir: string) =>
    request<RoleRemoveResult>(`/api/roles/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: JSON.stringify({ roles_dir: rolesDir }),
    }),

  /** Skill 有效集（F-D2 → GET /api/skills/effective）。角色不存在时服务端 404 信封。 */
  effectiveSkills: (role: string, team?: string) => {
    const qs = new URLSearchParams({ role })
    if (team !== undefined && team !== '') qs.set('team', team)
    return request<EffectiveSkillSet>(`/api/skills/effective?${qs.toString()}`)
  },
}
