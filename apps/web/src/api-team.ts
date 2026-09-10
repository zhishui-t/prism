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

async function request<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' } })
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

export const teamApi = {
  roles: () => request<RoleDefinition[]>('/api/roles'),
  role: (name: string) => request<RoleDefinition>(`/api/roles/${encodeURIComponent(name)}`),
  teams: () => request<TeamDefinition[]>('/api/teams'),
  team: (id: string) => request<TeamDefinition>(`/api/teams/${encodeURIComponent(id)}`),
  activate: (id: string) => request<TeamActivation>(`/api/teams/${encodeURIComponent(id)}/activate`),
  skills: () => request<PrismSkill[]>('/api/skills'),
  skillUsage: () => request<SkillUsage[]>('/api/skills/usage'),
}
