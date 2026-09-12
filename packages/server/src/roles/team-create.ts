/**
 * 团队写盘的服务端入口（`POST|PATCH|DELETE /api/teams[/:id]` 与
 * MCP `prism_team_new` / `prism_team_edit` / `prism_team_rm` 共用）。
 *
 * 分工（写路径单点可审）：
 * - 渲染 = agents `renderTeamScaffold`（与 CLI `prism team new` 同一实现，只渲染不落盘）；
 * - 改/删 = agents `editTeam` / `removeTeam`（与 CLI `prism team edit|rm` 同一实现）；
 * - **校验 + 落点参数化 = 本模块**，且落点**恒为调用方显式给出的 `teams_dir`**：
 *   没有 env 回落，也绝不复用 `resolveDirsFromHome` 的默认宿主目录（R5/R6 延伸）。
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { editTeam, parseTeamMarkdown, removeTeam, renderTeamScaffold, renderZcodeTeam, TeamWriteError } from '@prism/agents'
import { PrismError } from '@prism/core'

import { loadRoles, type DepositPolicy, type TeamMember, type ValidationIssue } from './index.js'

/** 新建团队请求体（ui-spec-v4 §2.5 `NewTeamInput` / MCP `prism_team_new` 入参）。 */
export interface NewTeamBody {
  team_id?: unknown
  name?: unknown
  description?: unknown
  members?: unknown
  deposit?: unknown
  /** 工作流模板（ui-spec 口径；映射到 agents `renderTeamScaffold` 的 `template`） */
  workflow_template?: unknown
  /** **必填**：写入目录（无 env 回落，绝不回落到默认宿主目录） */
  teams_dir?: unknown
}

export interface CreateTeamResult {
  /** 落盘路径 `<teams_dir>/<team_id>.md` */
  path: string
  issues: ValidationIssue[]
}

/** 团队 id kebab-case（与 agents `install.ts`/`team/init.ts` 的 `KEBAB_CASE_RE` 同口径）。 */
const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 校验 → 渲染 → 写显式 `teams_dir`。
 *
 * 失败一律 `PrismError`（HTTP 走信封状态码；MCP 转 `isError` 文本）：
 * `teams_dir_required` / `team_id_invalid` / `members_invalid` / `member_role_unknown` /
 * 校验未通过（不落盘）/ `id_conflict`（已存在不覆盖）。
 */
export async function createTeamDefinition(body: NewTeamBody, rolesDir: string): Promise<CreateTeamResult> {
  // ① `teams_dir` 必填（无 env 回落；绝不复用默认宿主 teams 目录）
  const targetDir = asNonEmptyString(body.teams_dir)
  if (targetDir === undefined) {
    // 文案含 `teams_dir_required`：控制台据此给「写入目录」字段加红（ui-spec §2.4 / V3）
    throw new PrismError(
      'bad_request',
      'teams_dir_required：未指定团队目录（防误写真实宿主，写路径一律显式参数化）。请在「写入目录」填入 teams 目录后重试。',
    )
  }

  // ② team_id kebab-case（= 落盘文件名，天然阻断路径穿越）
  const teamId = asNonEmptyString(body.team_id)
  if (teamId === undefined || !KEBAB_CASE_RE.test(teamId)) {
    throw new PrismError(
      'bad_request',
      `team_id_invalid：团队 id 必须 kebab-case（小写字母/数字/连字符）：${String(body.team_id)}`,
    )
  }

  // ③ 成员非空 + 形状合法
  const members = parseMembers(body.members)
  if (members.length === 0) {
    throw new PrismError('bad_request', 'members_invalid：至少需要 1 个成员角色（形如 [{role,count}]）')
  }

  // ④ 角色存在（大小写不敏感，与 agents `validateTeam`/`installTeam` 同口径）
  const roles = await loadRoles(rolesDir)
  const known = new Set(roles.map((role) => role.name.toLowerCase()))
  const missing = members.filter((member) => !known.has(member.role.toLowerCase())).map((member) => member.role)
  if (missing.length > 0) {
    throw new PrismError(
      'bad_request',
      `member_role_unknown：角色不在角色库中：${missing.join(', ')}（角色库 ${rolesDir}）`,
    )
  }

  // ⑤ 渲染（与 CLI `prism team new` 同一实现；只渲染不落盘）
  const name = asNonEmptyString(body.name)
  const description = asNonEmptyString(body.description)
  const scaffold = renderTeamScaffold({
    teamId,
    teamsDir: targetDir,
    members,
    template: body.workflow_template === 'core-dev' ? 'core-dev' : 'minimal',
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
  })
  const issues: ValidationIssue[] = [...scaffold.issues]
  const errors = issues.filter((issue) => issue.level === 'error')
  if (errors.length > 0) {
    // error 存在 → 不落盘（design-v4 F-C1/F-C3）
    throw new PrismError(
      'bad_request',
      `团队定义校验未通过，未落盘：${errors.map((issue) => `${issue.code}：${issue.message}`).join('；')}`,
    )
  }

  // ⑥ 沉淀策略（ui-spec §2.5 表单会提交并**回读核对**；忽略即静默丢弃用户输入 → 必须采用）
  const markdown = applyDepositOverride(scaffold.markdown, body.deposit)

  // ⑦ 落盘：`<teams_dir>/<team_id>.md`（扁平形态；registry/wiring 双形态均识别）
  const path = join(targetDir, `${teamId}.md`)
  if (existsSync(path)) {
    throw new PrismError('id_conflict', `团队已存在，未覆盖：${path}（如需修改请直接编辑该文件）`)
  }
  await mkdir(targetDir, { recursive: true })
  await writeFile(path, markdown, 'utf-8')
  return { path, issues }
}

/** 修改团队请求体（`PATCH /api/teams/:id` / MCP `prism_team_edit`；`teams_dir` 必填）。 */
export interface UpdateTeamBody {
  name?: unknown
  description?: unknown
  members?: unknown
  deposit?: unknown
  /** **必填**：目标目录（无 env 回落，绝不回落到默认宿主目录） */
  teams_dir?: unknown
  /** 改 `members` 时用于校验角色是否存在（同样必须显式给出） */
  roles_dir?: unknown
}

/**
 * `PATCH /api/teams/:id` / `prism_team_edit`：按字段补丁修改既有团队。
 * 改 `members` 时复用 agents `editTeam` 的名册收窄（工作流表就地裁剪），并校验每个角色都在角色库中。
 */
export async function updateTeamDefinition(
  teamId: string,
  body: UpdateTeamBody,
): Promise<{ path: string; issues: ValidationIssue[] }> {
  const targetDir = asNonEmptyString(body.teams_dir)
  if (targetDir === undefined) {
    throw new PrismError(
      'bad_request',
      'teams_dir_required：未指定团队目录（防误写真实宿主，写路径一律显式参数化）。',
    )
  }
  const id = asNonEmptyString(teamId)
  if (id === undefined || !KEBAB_CASE_RE.test(id)) {
    throw new PrismError('bad_request', `team_id_invalid：团队 id 必须 kebab-case：${teamId}`)
  }

  let members: TeamMember[] | undefined
  if (body.members !== undefined) {
    members = parseMembers(body.members)
    if (members.length === 0) {
      throw new PrismError('bad_request', 'members_invalid：至少需要 1 个成员角色（形如 [{role,count}]）')
    }
    const rolesDir = asNonEmptyString(body.roles_dir)
    if (rolesDir === undefined) {
      throw new PrismError('bad_request', 'roles_dir_required：改 members 需同时给出 roles_dir（用于校验角色存在）')
    }
    const known = new Set((await loadRoles(rolesDir)).map((role) => role.name.toLowerCase()))
    const missing = members.filter((member) => !known.has(member.role.toLowerCase())).map((member) => member.role)
    if (missing.length > 0) {
      throw new PrismError(
        'bad_request',
        `member_role_unknown：角色不在角色库中：${missing.join(', ')}（角色库 ${rolesDir}）`,
      )
    }
  }

  const name = asNonEmptyString(body.name)
  const description = asNonEmptyString(body.description)
  const deposit = typeof body.deposit === 'object' && body.deposit !== null ? (body.deposit as Partial<DepositPolicy>) : undefined
  if (name === undefined && description === undefined && members === undefined && deposit === undefined) {
    throw new PrismError('bad_request', 'team_patch_empty：未给出任何要修改的字段（name/description/members/deposit）')
  }

  try {
    const result = await editTeam({
      teamId: id,
      teamsDir: targetDir,
      patch: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(members !== undefined ? { members } : {}),
        ...(deposit !== undefined ? { deposit } : {}),
      },
    })
    return { path: result.written[0]!, issues: result.issues }
  } catch (err) {
    if (err instanceof TeamWriteError) {
      throw new PrismError(err.code === 'team_not_found' ? 'not_found' : 'bad_request', err.message, { path: err.path })
    }
    throw err
  }
}

/** `DELETE /api/teams/:id` / `prism_team_rm`：删除团队文件本体。 */
export async function deleteTeamDefinition(teamId: string, teamsDir: unknown): Promise<{ removed: string[] }> {
  const targetDir = asNonEmptyString(teamsDir)
  if (targetDir === undefined) {
    throw new PrismError('bad_request', 'teams_dir_required：未指定团队目录（防误写真实宿主，写路径一律显式参数化）。')
  }
  const id = asNonEmptyString(teamId)
  if (id === undefined || !KEBAB_CASE_RE.test(id)) {
    throw new PrismError('bad_request', `team_id_invalid：团队 id 必须 kebab-case：${teamId}`)
  }
  try {
    return await removeTeam({ teamId: id, teamsDir: targetDir })
  } catch (err) {
    if (err instanceof TeamWriteError) {
      throw new PrismError(err.code === 'team_not_found' ? 'not_found' : 'bad_request', err.message, { path: err.path })
    }
    throw err
  }
}

/** 非空字符串（trim 后）；否则 undefined。 */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** `members: [{role, count?}]` → 规范化（同角色后者胜、`count` 缺省 1、非法项丢弃）。 */
export function parseMembers(raw: unknown): TeamMember[] {
  if (!Array.isArray(raw)) return []
  const byRole = new Map<string, number>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const role = asNonEmptyString((item as { role?: unknown }).role)
    if (role === undefined) continue
    const countRaw = (item as { count?: unknown }).count
    const count =
      typeof countRaw === 'number' && Number.isInteger(countRaw) && countRaw >= 1 && countRaw <= 99 ? countRaw : 1
    byRole.set(role, count)
  }
  return [...byRole.entries()].map(([role, count]) => ({ role, count }))
}

/**
 * 用请求体的 `deposit`（部分字段）覆盖脚手架里的沉淀策略后重渲染。
 *
 * 为什么需要：`renderTeamScaffold` 的冻结入参（§3.3）不含 `deposit`，而控制台表单会提交
 * 沉淀策略并**回读核对**（ui-spec §2.5）——不采用等于把用户输入静默丢弃。
 * 只认 `DepositPolicy` 的 5 个已知键；未知/非法值一律忽略（不猜、不崩）。
 */
function applyDepositOverride(markdown: string, raw: unknown): string {
  if (markdown === '' || typeof raw !== 'object' || raw === null) return markdown
  const patch = raw as Record<string, unknown>
  const overlay: Partial<DepositPolicy> = {}
  if (typeof patch['enabled'] === 'boolean') overlay.enabled = patch['enabled']
  const layer = patch['default_layer']
  if (layer === 'global' || layer === 'project' || layer === 'role') overlay.default_layer = layer
  const defaultType = asNonEmptyString(patch['default_type'])
  if (defaultType !== undefined) overlay.default_type = defaultType
  const priority = patch['priority']
  if (priority === 'low' || priority === 'medium' || priority === 'high') overlay.priority = priority
  if (typeof patch['require_note'] === 'boolean') overlay.require_note = patch['require_note']
  if (Object.keys(overlay).length === 0) return markdown

  const declared = new Set<string>()
  const parsed = parseTeamMarkdown(markdown, { declaredKeys: declared })
  return renderZcodeTeam({ ...parsed, deposit: { ...parsed.deposit, ...overlay } })
}
