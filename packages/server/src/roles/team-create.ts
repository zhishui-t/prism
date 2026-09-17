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

import { existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  editTeam,
  parseTeamMarkdown,
  patchTeamRaw,
  removeTeam,
  renderTeamScaffold,
  renderZcodeTeam,
  TeamWriteError,
  WorkflowSectionMissingError,
} from '@prism/agents'
import { PrismError } from '@prism/core'
import type { TrashStore, TrashTrigger } from '@prism/core'

import {
  loadRoles,
  type DepositPolicy,
  type TeamMember,
  type ValidationIssue,
  type WorkflowSerializeRow,
} from './index.js'

/** 新建团队请求体（ui-spec-v4 §2.5 `NewTeamInput` / MCP `prism_team_new` 入参）。 */
export interface NewTeamBody {
  team_id?: unknown
  name?: unknown
  description?: unknown
  members?: unknown
  deposit?: unknown
  /** 工作流模板（ui-spec 口径；映射到 agents `renderTeamScaffold` 的 `template`） */
  workflow_template?: unknown
  /**
   * **结构化工作流**（v11 收口）：`{ stages: [...] }`，形状与 PATCH 的 `workflow` **同一单点**
   * ({@link parseWorkflowPatch})。编排器产出的结构化工作流在新建时不再被丢弃。
   *
   * 模板恒有 `## 工作流` 表格 → 提交 stages 无 `rowId`（新建无「原行身份」）= 模板行全换为提交行。
   * 省略 = 模板工作流原样（产物 byte 级不变）。
   */
  workflow?: unknown
  /** **必填**：写入目录（无 env 回落，绝不回落到默认宿主目录） */
  teams_dir?: unknown
  /**
   * 成员角色校验用的角色库（v6.1）。
   *
   * 原实现无条件用**默认宿主角色库**，与 `edit`/`PATCH` 强制显式 `roles_dir` 的口径不一致：
   * 隔离场景（teams_dir 指向别处、角色也在别处）会误报 `member_role_unknown`。
   * 现在显式优先，缺省才回落到调用方给的默认角色库（CLI 二者同源，行为不变）。
   */
  roles_dir?: unknown
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
 * `workflow_invalid`（结构化工作流形状非法）/ 校验未通过（不落盘）/ `id_conflict`（已存在不覆盖）。
 *
 * v11 收口：可选 `workflow`（`{ stages }`）在模板渲染后经 agents `patchTeamRaw` 写回工作流表
 * （编排器产出的结构化工作流不再被静默丢弃）；省略 = 模板工作流原样。
 */
export async function createTeamDefinition(
  body: NewTeamBody,
  fallbackRolesDir: string,
): Promise<CreateTeamResult> {
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

  // ④ 角色存在（大小写不敏感，与 agents `validateTeam` 同口径）
  // 角色库：显式 `roles_dir` 优先，缺省沿用调用方给的默认库（v6.1，见 `NewTeamBody.roles_dir`）
  const rolesDir = asNonEmptyString(body.roles_dir) ?? fallbackRolesDir
  const roles = await loadRoles(rolesDir)
  const known = new Set(roles.map((role) => role.name.toLowerCase()))
  const missing = members.filter((member) => !known.has(member.role.toLowerCase())).map((member) => member.role)
  if (missing.length > 0) {
    throw new PrismError(
      'bad_request',
      `member_role_unknown：角色不在角色库中：${missing.join(', ')}（角色库 ${rolesDir}）`,
    )
  }

  // ⑤ 结构化工作流形状校验（v11 收口）：与 PATCH 共用同一单点，非法 → 400 `workflow_invalid`
  const workflow = parseWorkflowPatch(body.workflow)

  // ⑥ 渲染（与 CLI `prism team new` 同一实现；只渲染不落盘）
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

  // ⑦ 沉淀策略（ui-spec §2.5 表单会提交并**回读核对**；忽略即静默丢弃用户输入 → 必须采用）
  let markdown = applyDepositOverride(scaffold.markdown, body.deposit)

  // ⑦′ 结构化工作流（v11 收口）：模板恒有 `## 工作流` 表格 → 提交 stages 无 `rowId` = 模板行
  // 全换为提交行（复用 agents `patchTeamRaw`，不重写序列化逻辑）。**无 workflow 时不触碰 markdown**
  // ——保证与既有 POST 产物 byte 级一致。
  if (workflow !== undefined) {
    const patched = patchTeamRaw(markdown, { workflow })
    markdown = patched.markdown
    issues.push(...patched.issues)
  }

  // ⑧ 落盘：`<teams_dir>/<team_id>.md`（扁平形态；registry/wiring 双形态均识别）
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
  /**
   * **结构化保存工作流**（v11 F2 / R-v11-13）：`{ stages: [...] }`。
   *
   * 形状见 {@link parseWorkflowPatch}；**raw 底账不采信客户端**——由 agents `editTeam` 重读
   * 文件、按 `rowId` 合并未映射列（缩信任面 + 缩并发窗口）。
   */
  workflow?: unknown
  /**
   * 陈旧写防护（R-v11-15）：取 `GET /api/teams/:id` 的 `source_mtime`（epoch 毫秒整数）。
   * 与写前磁盘 mtime 不符 → 409 `stale_write`（不静默 lost update）。
   */
  if_match?: unknown
  /** **必填**：目标目录（无 env 回落，绝不回落到默认宿主目录） */
  teams_dir?: unknown
  /** 改 `members` 时用于校验角色是否存在（同样必须显式给出） */
  roles_dir?: unknown
}

/**
 * `PATCH /api/teams/:id` / `prism_team_edit`：按字段补丁修改既有团队。
 *
 * - 改 `members` 复用 agents `editTeam` 的名册收窄（工作流表就地裁剪，保列集）；
 * - 给 `workflow` → 结构化保存（与 `members` 同给时 **workflow 胜**，见 agents `patchTeamRaw`）；
 * - 给 `if_match` → 陈旧写防护（不匹配 409 `stale_write`）；
 * - 无 `## 工作流` 小节而给 `workflow` → 400 `workflow_section_missing`。
 */
export async function updateTeamDefinition(
  teamId: string,
  body: UpdateTeamBody,
): Promise<{ path: string; issues: ValidationIssue[]; source_mtime: number }> {
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
  const workflow = parseWorkflowPatch(body.workflow)
  const ifMatch = parseIfMatch(body.if_match)
  if (
    name === undefined &&
    description === undefined &&
    members === undefined &&
    deposit === undefined &&
    workflow === undefined
  ) {
    // v11 F2：workflow 亦计有效字段——旧守卫只认 name/description/members/deposit，
    // 「只存工作流」的编辑器保存会被 400 team_patch_empty 挡下。
    throw new PrismError(
      'bad_request',
      'team_patch_empty：未给出任何要修改的字段（name/description/members/deposit/workflow）',
    )
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
        ...(workflow !== undefined ? { workflow } : {}),
      },
      ...(ifMatch !== undefined ? { ifMatch } : {}),
    })
    const path = result.written[0]!
    // 写后 mtime：客户端可直接续用为下一次 PATCH 的 `if_match`（省一次 GET）
    return { path, issues: result.issues, source_mtime: Math.round(statSync(path).mtimeMs) }
  } catch (err) {
    if (err instanceof TeamWriteError) {
      if (err.code === 'stale_write') {
        throw new PrismError('stale_write', err.message, { path: err.path })
      }
      throw new PrismError(err.code === 'team_not_found' ? 'not_found' : 'bad_request', err.message, { path: err.path })
    }
    if (err instanceof WorkflowSectionMissingError) {
      throw new PrismError('workflow_section_missing', err.message)
    }
    throw err
  }
}

/**
 * PATCH `workflow` 的形状校验（v11 F2 / R-v11-13；v11 派修 M-2 增 `columns`）。
 *
 * - 未给出（`undefined`/`null`）→ `undefined`（该字段不参与补丁）；
 * - `{ stages: [] }` = **清空工作流**（显式给出才允许，编辑器所见即所存；守卫层面算有效字段）；
 * - `columns`（可选）= 提交**列集**（含未映射列，保持列序）：必须是非空字符串数组、
 *   trim 后唯一，非法 400 `workflow_invalid`（列名重复会造成按列名寻址歧义）；
 * - 逐项校验，**非法项 400**（`workflow_invalid`），缺省值按 agents 口径补：
 *   `roles←[]`、`mode←'serial'`、`input/output/done/reflow←''`。
 */
export function parseWorkflowPatch(raw: unknown): { stages: WorkflowSerializeRow[]; columns?: string[] } | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PrismError('bad_request', 'workflow_invalid：workflow 必须是对象 { stages: [...] }')
  }
  const stages = (raw as { stages?: unknown }).stages
  if (!Array.isArray(stages)) {
    throw new PrismError(
      'bad_request',
      'workflow_invalid：workflow.stages 必填且必须是数组（空数组 = 清空工作流；省略 stages 无法表达「不改」与「清空」之别）',
    )
  }
  const columns = parseWorkflowColumns((raw as { columns?: unknown }).columns)
  return {
    stages: stages.map((item, index) => parseWorkflowStage(item, index)),
    ...(columns !== undefined ? { columns } : {}),
  }
}

/** `workflow.columns`：非空字符串数组、trim 后唯一；非法 → 400 `workflow_invalid`。 */
function parseWorkflowColumns(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((column) => typeof column !== 'string')) {
    throw new PrismError(
      'bad_request',
      'workflow_invalid：workflow.columns 必须是**非空**字符串数组（列集，含未映射列；空数组无法表达列集）',
    )
  }
  const columns = (raw as string[]).map((column) => column.trim())
  if (columns.some((column) => column === '')) {
    throw new PrismError('bad_request', 'workflow_invalid：workflow.columns 的列名去空白后不能为空')
  }
  if (new Set(columns).size !== columns.length) {
    throw new PrismError('bad_request', 'workflow_invalid：workflow.columns 去重后必须唯一（列名重复会造成按列名寻址歧义）')
  }
  return columns
}

/** 陈旧写参数：整数（epoch 毫秒）；非整数/非数字 → 400（不静默忽略防护）。 */
export function parseIfMatch(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new PrismError(
      'bad_request',
      'if_match_invalid：if_match 必须是整数（epoch 毫秒，取自 GET /api/teams/:id 的 source_mtime）',
    )
  }
  return raw
}

function parseWorkflowStage(raw: unknown, index: number): WorkflowSerializeRow {
  const at = `workflow.stages[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PrismError('bad_request', `workflow_invalid：${at} 必须是对象`)
  }
  const item = raw as Record<string, unknown>
  const bad = (detail: string): PrismError => new PrismError('bad_request', `workflow_invalid：${detail}`)

  const order = item['order']
  if (typeof order !== 'number' || !Number.isFinite(order)) throw bad(`${at}.order 必须是数字`)
  const stage = item['stage']
  if (typeof stage !== 'string') throw bad(`${at}.stage 必须是字符串`)

  const mode = item['mode']
  if (mode !== undefined && mode !== 'serial' && mode !== 'parallel') {
    throw bad(`${at}.mode 只能是 'serial' | 'parallel'`)
  }
  const roles = item['roles']
  if (roles !== undefined && (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string'))) {
    throw bad(`${at}.roles 必须是字符串数组`)
  }
  const rowId = item['rowId']
  if (rowId !== undefined && typeof rowId !== 'string') throw bad(`${at}.rowId 必须是字符串（原 raw 行身份）`)
  const extra = item['extra']
  if (extra !== undefined && (typeof extra !== 'object' || extra === null || Array.isArray(extra))) {
    throw bad(`${at}.extra 必须是 { 列名: 值 } 对象`)
  }
  const extraValues = (extra ?? {}) as Record<string, unknown>
  for (const [column, value] of Object.entries(extraValues)) {
    if (typeof value !== 'string') throw bad(`${at}.extra['${column}'] 必须是字符串`)
  }
  const text = (key: 'input' | 'output' | 'done' | 'reflow'): string => {
    const value = item[key]
    if (value !== undefined && typeof value !== 'string') throw bad(`${at}.${key} 必须是字符串`)
    return value === undefined ? '' : (value as string)
  }

  return {
    ...(rowId !== undefined ? { rowId: rowId as string } : {}),
    order,
    stage,
    roles: roles === undefined ? [] : [...(roles as string[])],
    mode: mode === undefined ? 'serial' : (mode as 'serial' | 'parallel'),
    input: text('input'),
    output: text('output'),
    done: text('done'),
    reflow: text('reflow'),
    ...(extra !== undefined ? { extra: { ...(extraValues as Record<string, string>) } } : {}),
  }
}

/**
 * `DELETE /api/teams/:id` / `prism_team_rm` / CLI `prism team rm`：把团队本体**搬进回收站**。
 *
 * v9 F3：原「直接删」改为 `TrashStore.put`（可 `prism trash restore <id>` 还原）。
 * 回收站由入口层按 `PRISM_HOME` 构造后注入（`trashStoreFor`），本模块只传 `trigger` 定界来源。
 */
export async function deleteTeamDefinition(
  teamId: string,
  teamsDir: unknown,
  trash: TrashStore,
  trigger: TrashTrigger,
): Promise<{ removed: string[]; trash_id: string }> {
  const targetDir = asNonEmptyString(teamsDir)
  if (targetDir === undefined) {
    throw new PrismError('bad_request', 'teams_dir_required：未指定团队目录（防误写真实宿主，写路径一律显式参数化）。')
  }
  const id = asNonEmptyString(teamId)
  if (id === undefined || !KEBAB_CASE_RE.test(id)) {
    throw new PrismError('bad_request', `team_id_invalid：团队 id 必须 kebab-case：${teamId}`)
  }
  try {
    const result = await removeTeam({ teamId: id, teamsDir: targetDir, trash, trigger })
    return { removed: result.removed, trash_id: result.trashId }
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
