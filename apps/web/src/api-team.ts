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

/** 图 status 详情（镜像 server `graph/registry.ts` 的 `GraphStatusDetail`，只读展示用）。 */
export interface GraphStatusDetail {
  project: string
  root: string
  graph_exists: boolean
  built_at: string | null
  changed_files: number
  total_files: number
  stale: boolean
  note?: string
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
  /**
   * 只读图状态（server 侧附加，`?project=<名>` 给出时才有值，否则 `null`）。
   * 当前 UI 的 activate 调用**不带 project** → 恒为 `null`（不伪造）。
   */
  graph_status?: GraphStatusDetail | null
  /** `?build=1` 时返回的建图任务句柄。 */
  graph_build?: { job_id: string }
}

export interface PrismSkill {
  name: string
  description: string
  builtin: boolean
  /**
   * 分类（v8 F7 / design-v8 §3、R-v8-5）：服务端把 `PRISM_HOME/skill-categories.json`
   * 的映射**合并进 `/api/skills` 的每条技能**——**映射里没有该技能则不加这个键**
   * （与 MCP `prism_skill_list` 同口径），故消费方一律按 `skill.category ?? ''` 读。
   *
   * 它是技能页分组的**唯一数据源**：UI 不做「列表 + 独立映射表（`/api/skills/categories`）」
   * 的二次拼接。分类判断归宿主，Prism 只存映射、只读展示（R2/R3）。
   */
  category?: string
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

/**
 * 统一请求：解析信封，失败抛错（与 `api.ts` 的 `request()` 同一契约的第二处实现）。
 *
 * ⚠ **契约（debts D-1，不得更改）**：错误**必须**以 `` `${code}: ${message}` `` 抛成 `Error.message`
 * ——错误码靠这个前缀承载（消费方按 `startsWith('not_found')` 之类的判断分派）。
 * 改这里就必须同步 `api.ts` 的同名函数。
 */
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
  /**
   * 分类（v8 F7-1）：服务端已按与 `/api/skills` **完全一致**的口径逐条合并
   * `PRISM_HOME/skill-categories.json` 的映射——**映射里没有该技能则不加这个键**
   * （与 `PrismSkill.category` 同源同口径），故消费方一律按 `item.category ?? ''` 读。
   *
   * 它是**外部技能**唯一的分类来源：`/api/skills` 只列内置技能，宿主已装的外部技能
   * 只出现在 usage 路，分组时要靠这里补上（见 `Skills.tsx` 的 `row.category ??=`）。
   */
  category?: string
  /**
   * 外部可删态（v10 F3，design-v10 F3「UI 数据支撑」）：`true` = 该技能落点是宿主技能目录里
   * 一个**有 SKILL.md、且不带 Prism 标记**的目录 ⇒ 可以整目录搬进回收站（「删除」）。
   *
   * 判定在服务端（按**落点文件**判，不按名字查内置清单——否则「复制内置后改写的人写同名技能」
   * 在 UI 恒显「卸载」而卸载恒 `kept`）。服务端**不加该键**时按 `undefined` 读 ⇒ 与 `false`
   * 同档：保持现状（内置 / Prism 产物显「卸载」）。
   */
  external_removable?: boolean
}

/**
 * 外部技能删除结果（`DELETE /api/skills/external/:name`，design-v10 F3 契约冻结）。
 *
 * 与 v9 删除族同形：**200 + 返回体**（不是 204——信封层没有无 body 通道，且 `trash_id`
 * 是 UI「可恢复」提示的唯一来源）。
 */
export interface SkillExternalRemoveResult {
  /** 宿主技能目录（服务端配置解析后的同源值） */
  skills_dir: string
  /** 被搬走的目录（整目录，含 references/ 等子项） */
  removed: string[]
  /** 回收站单元 id，可 `prism trash restore <id>` 还原 */
  trash_id: string
}

/** 单个技能详情（GET /api/skills/:name）：正文 + 安装路径 + 引用方。 */
export interface SkillDetail {
  name: string
  description: string
  builtin: boolean
  installed: boolean
  /** 预期（或实际）安装目录：`<skills_dir>/<name>` */
  path: string
  roles: string[]
  teams: string[]
  /** SKILL.md 全文（含 frontmatter）；读不到为空串 */
  content: string
}

/**
 * 内置 Skill 清单响应（`GET /api/skills`，v7 改型）。
 *
 * 由裸数组改为 `{ skills, skills_dir }`：与 MCP `prism_skill_list` 对齐，
 * `skills_dir` 供安装/卸载表单回填（服务端 body 的 `skills_dir` **必填**）。
 */
export interface SkillListResult {
  skills: PrismSkill[]
  /** 宿主技能目录（服务端已解析；安装/卸载的原样入参） */
  skills_dir: string
}

/** 安装结果（`POST /api/skills/install`）——与 server 的 `SkillInstallOutcome` 同形。 */
export interface SkillInstallOutcome {
  skills_dir: string
  written: string[]
  skipped: Array<{ path: string; reason: string }>
}

/** 卸载结果（`POST /api/skills/uninstall`）——与 server 的 `SkillUninstallOutcome` 同形。 */
export interface SkillUninstallOutcome {
  skills_dir: string
  removed: string[]
  /** 未删的（人写的 Skill / 无 SKILL.md）：卸载只动 Prism 产物 */
  kept: Array<{ name: string; path: string; reason: string }>
}

/** 团队列表 + 受管 teams 目录（design-v4 §3.4：GET /api/teams 增只读 teamsDir）。 */
export interface TeamsIndex {
  teams: TeamDefinition[]
  /** 受管 teams 目录绝对路径（只读）。仅用于新建表单预填，**不硬编码宿主路径**（R6）。 */
  teamsDir?: string
}

/**
 * GET /api/teams 形状兼容：历史为裸数组 → `{ teams, teamsDir }`（v5）→ `{ teams, teams_dir }`（v6.1，
 * 键名与写参数 `teams_dir` 同名，读回即可回填）。三种形状都接受，避免与后端落地形状耦合。
 */
function normalizeTeams(
  value: TeamDefinition[] | { teams: TeamDefinition[]; teams_dir?: string; teamsDir?: string },
): TeamsIndex {
  if (Array.isArray(value)) return { teams: value }
  const dir = value.teams_dir ?? value.teamsDir
  return {
    teams: value.teams ?? [],
    ...(dir !== undefined ? { teamsDir: dir } : {}),
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

/** `GET /api/roles` 返回体（v6.1：`{ roles, roles_dir }`，键名与写参数同名，与 `/api/teams` 同形）。 */
export interface RolesIndex {
  roles: RoleDefinition[]
  /** 受管 roles 目录绝对路径（只读）。仅用于新建表单预填，**不硬编码宿主路径**（R6）。 */
  rolesDir?: string
}

/** 裸数组（历史形状）、`{roles, rolesDir}`（v5）与 `{roles, roles_dir}`（v6.1）都接受。 */
function normalizeRoles(
  value: RoleDefinition[] | { roles: RoleDefinition[]; roles_dir?: string; rolesDir?: string },
): RolesIndex {
  if (Array.isArray(value)) return { roles: value }
  const dir = value.roles_dir ?? value.rolesDir
  return {
    roles: value.roles ?? [],
    ...(dir !== undefined ? { rolesDir: dir } : {}),
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
    request<RoleDefinition[] | { roles: RoleDefinition[]; roles_dir?: string; rolesDir?: string }>('/api/roles').then(normalizeRoles),
  role: (name: string) => request<RoleDefinition>(`/api/roles/${encodeURIComponent(name)}`),
  teams: () =>
    request<TeamDefinition[] | { teams: TeamDefinition[]; teams_dir?: string; teamsDir?: string }>('/api/teams').then(
      normalizeTeams,
    ),
  team: (id: string) => request<TeamDefinition>(`/api/teams/${encodeURIComponent(id)}`),
  activate: (id: string) => request<TeamActivation>(`/api/teams/${encodeURIComponent(id)}/activate`),
  /** 内置 Skill 清单（v7 改型：`{ skills, skills_dir }`，与 MCP `prism_skill_list` 对齐）。 */
  skills: () => request<SkillListResult>('/api/skills'),
  skill: (name: string) => request<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`),
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

  /**
   * 安装内置 Skill（`POST /api/skills/install`，§4.3 S5）。
   *
   * - `skills_dir` **必填**且原样传给服务端——服务端绝不复用默认宿主目录（写路径不回落），
   *   所以 UI 必须把 `skills()` 返回的 `skills_dir` 带回来；
   * - `names` 省略/空 = 全部内置；
   * - `force` 缺省**不覆盖**人写的同名 Skill（服务端写 `.prism-new` 供对比）。
   */
  skillInstall: (input: { skills_dir: string; names?: string[]; force?: boolean }) =>
    request<SkillInstallOutcome>('/api/skills/install', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** 卸载 Skill（`POST /api/skills/uninstall`）。只删 Prism 产物，人写的记入 `kept`。 */
  skillUninstall: (input: { skills_dir: string; names?: string[] }) =>
    request<SkillUninstallOutcome>('/api/skills/uninstall', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * 删除**外部**技能（`DELETE /api/skills/external/:name`，v10 F3）。
   *
   * 与 `skillUninstall` 的分工：卸载只清 Prism 产物（外部技能恒 `kept`），本口才真把整个
   * 技能目录搬进回收站。服务端的失败面（UI 逐条映射人话，见 `skills-logic.ts`）：
   * - `id_conflict`（409）：落点 SKILL.md 带 Prism 标记 → 该走卸载；
   * - `not_found`（404）：目录不存在 / 没有 SKILL.md（非技能目录）；
   * - `bad_request`：`:name` 消毒没过（空串 / `.` / `..` / 含分隔符 / 根自身）。
   *
   * `:name` 走 `encodeURIComponent`（服务端在解码**之后**做消毒，两侧不重复表达同一条规则）。
   */
  skillDeleteExternal: (name: string) =>
    request<SkillExternalRemoveResult>(`/api/skills/external/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
}
