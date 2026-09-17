/**
 * 团队表单的**纯逻辑**（T5 补充：从合并后的 TeamForm 抽出，以守住「单文件 ≤450 行」）。
 *
 * 只依赖 api / templates / errors，不碰 React——表单组件负责状态与渲染，这里负责
 * 校验、请求体构造、创建后回读比对、PATCH 字段差集。
 */

import {
  teamApi,
  type DepositPolicy,
  type NewTeamInput,
  type RoleDefinition,
  type TeamDefinition,
  type TeamMember,
  type UpdateTeamInput,
} from '../../api-team.ts'
import type { TFunc } from './errors.ts'
import { DEPOSIT_LAYER_KEYS, ID_RE, TEMPLATE_STAGES } from './templates.ts'
import { workflowEqual, workflowInput, type WorkflowDraft } from './workflow-model.ts'

/** 表单值（create / edit 共用超集；edit 用不到的字段保持初值）。 */
export interface TeamFormValues {
  /** 仅 create：团队 ID（edit 时身份不可改，表单里没有这一项）。 */
  teamId: string
  name: string
  description: string
  counts: Record<string, number>
  filter: string
  /** 仅 create：工作流模板。 */
  template: 'minimal' | 'core-dev' | 'custom'
  /**
   * 工作流编排草稿（v11 F2）：create 由所选模板预填、edit 由 `adaptWorkflowParse` 得来。
   * 提交路径见 `buildCreateInput` / `buildUpdatePatch`（web 只产出阶段模型，
   * **md 表格由服务端 serialize 生成**，R-v11-9）。
   */
  workflow: WorkflowDraft
  /**
   * 仅 edit：GET 拿到的文件 mtime（design-v11 §3 的 `if_match`）。
   * 服务端还没下发 ⇒ `undefined` ⇒ **不带该字段**（不带 ≠ 带 undefined 的字符串）。
   */
  sourceMtime?: number
  depositEnabled: boolean
  defaultLayer: string
  defaultType: string
  priority: string
  requireNote: boolean
  teamsDir: string
}

export function depositPolicy(v: TeamFormValues): DepositPolicy {
  return {
    enabled: v.depositEnabled,
    default_layer: v.defaultLayer,
    default_type: v.defaultType,
    priority: v.priority,
    require_note: v.requireNote,
  }
}

/** create 专用：全字段校验 → 逐字段错误（配 `FIELD_ORDER` 定位）。 */
export function validateCreate(
  t: TFunc,
  v: TeamFormValues,
  members: TeamMember[],
  roles: RoleDefinition[],
  existingIds: string[],
): Record<string, string> {
  const e: Record<string, string> = {}
  const id = v.teamId.trim()
  if (id === '') e.teamId = t('teams.v.idRequired')
  else if (!ID_RE.test(id)) e.teamId = t('teams.v.idInvalid')
  else if (id.length > 40) e.teamId = t('teams.v.idLong')
  else if (existingIds.includes(id)) e.teamId = t('teams.v.idTaken', { id })

  if (v.name.trim() === '') e.name = t('teams.v.nameRequired')
  else if (v.name.trim().length > 40) e.name = t('teams.v.nameLong')

  if (v.description.length > 200) e.description = t('teams.v.descLong')

  if (members.length === 0) e.members = t('teams.v.membersRequired')
  else if (members.some((m) => m.count < 1 || m.count > 9)) e.members = t('teams.v.membersRange')
  else {
    const unknown = members.find((m) => !roles.some((r) => r.name === m.role))
    if (unknown !== undefined) e.members = t('teams.v.memberUnknown', { role: unknown.role })
  }

  if (v.teamsDir.trim() === '') e.teamsDir = t('teams.v.dirRequired')
  if (v.depositEnabled && !DEPOSIT_LAYER_KEYS.some((l) => l.value === v.defaultLayer)) {
    e.defaultLayer = t('teams.v.layerRequired')
  }
  return e
}

/** create 请求体（custom 本轮不做模板 → 不传模板，服务端按最小可用骨架落盘）。 */
export function buildCreateInput(v: TeamFormValues, members: TeamMember[]): NewTeamInput {
  return {
    team_id: v.teamId.trim(),
    name: v.name.trim(),
    members,
    deposit: depositPolicy(v),
    teams_dir: v.teamsDir.trim(),
    ...(v.description.trim() === '' ? {} : { description: v.description.trim() }),
    ...(v.template === 'custom' ? {} : { workflow_template: v.template as 'minimal' | 'core-dev' }),
    // 编排器里的工作流（列集 + 阶段；模板预填 + 用户增删改）。零阶段（custom 且用户把
    // 起点的空白卡也删光了）= 不发，让服务端走自己的骨架——「什么都不说」与「说我要零个阶段」是两件事。
    ...(v.workflow.cards.length > 0 ? { workflow: workflowInput(v.workflow) } : {}),
  }
}

/**
 * 创建后**回读比对**：服务端若未采用某些字段 / 跳过某些阶段，必须可见而不是静默。
 * 返回可直接拼进提示条的 warning（空串 = 无差异）。
 */
export async function verifyCreated(t: TFunc, input: NewTeamInput, members: TeamMember[]): Promise<string> {
  const deposit = input.deposit
  if (deposit === undefined) return ''
  try {
    const actual = await teamApi.team(input.team_id)
    const want = members.map((m) => `${m.role}×${m.count}`).sort().join(',')
    const got = actual.members.map((m) => `${m.role}×${m.count}`).sort().join(',')
    const diff: string[] = []
    if (want !== got) diff.push('members')
    if (actual.deposit.enabled !== deposit.enabled) diff.push('deposit.enabled')
    if (actual.deposit.default_layer !== deposit.default_layer) diff.push('deposit.default_layer')
    if (actual.deposit.default_type !== deposit.default_type) diff.push('deposit.default_type')
    if (actual.deposit.priority !== deposit.priority) diff.push('deposit.priority')
    if (actual.deposit.require_note !== deposit.require_note) diff.push('deposit.require_note')
    const notes: string[] = []
    if (diff.length > 0) notes.push(t('teams.warn.readback', { fields: diff.join(' / ') }))
    // 服务端会跳过「模板里角色未入选」的阶段（实测：core-dev 7 阶段 + 仅 dev-1/tester → 落盘 5 阶段）
    // v11 F2：用户若是**自己编排**过阶段（带了 workflow），模板数就不再是预期值——那时不比对，
    // 否则会拿一个已经作废的模板去「警告」用户（模板只是起点）。
    if (input.workflow === undefined) {
      const expectedStages = TEMPLATE_STAGES[input.workflow_template ?? 'minimal'].length
      if (actual.workflow.length !== expectedStages) {
        notes.push(
          t('teams.warn.stages', {
            actual: actual.workflow.length,
            expected: expectedStages,
            stages: TEMPLATE_STAGES[input.workflow_template ?? 'minimal'].map((k) => t(k)).join(' → '),
          }),
        )
      }
    }
    return notes.join(' ')
  } catch (e) {
    return t('teams.warn.readbackFailed', { msg: e instanceof Error ? e.message : String(e) })
  }
}

export type PatchResult =
  | { ok: true; patch: UpdateTeamInput; fields: string[] }
  | { ok: false; error: string }

/**
 * edit 专用：算出**只提交改动过**的字段（PATCH 语义：缺省 = 不改）。
 * 顺序与改动前一致：先 dir/name/description 前置校验，再逐项试差集。
 */
export function buildUpdatePatch(
  t: TFunc,
  v: TeamFormValues,
  baseline: TeamFormValues,
  members: TeamMember[],
  team: TeamDefinition,
  rolesDir: string | undefined,
): PatchResult {
  const teamsDir = v.teamsDir.trim()
  if (teamsDir === '') return { ok: false, error: t('teams.v.dirRequired') }
  if (v.name.trim() === '') return { ok: false, error: t('teams.v.nameRequired') }
  if (v.name.trim().length > 40) return { ok: false, error: t('teams.v.nameLong') }
  if (v.description.length > 200) return { ok: false, error: t('teams.v.descLong') }
  if (members.length === 0) return { ok: false, error: t('teams.v.keepOne') }

  const patch: UpdateTeamInput = { teams_dir: teamsDir }
  const initialMembers = [...team.members].sort((a, b) => a.role.localeCompare(b.role))
  const fields: string[] = []

  if (v.name !== baseline.name) {
    patch.name = v.name.trim()
    fields.push('name')
  }
  if (v.description !== baseline.description) {
    patch.description = v.description
    fields.push('description')
  }
  const sameMembers =
    members.map((m) => `${m.role}×${m.count}`).join(',') ===
    initialMembers.map((m) => `${m.role}×${m.count}`).join(',')
  if (!sameMembers) {
    if (rolesDir === undefined || rolesDir.trim() === '') {
      return { ok: false, error: t('teams.form.rolesDirMissing') }
    }
    patch.members = members
    patch.roles_dir = rolesDir
    fields.push('members')
  }
  /**
   * 工作流段（design-v11 §3 / R-v11-13）。
   *
   * **members 与 workflow 同给时由服务端裁决（workflow 胜，跳过收窄）**——编辑器所见即所存。
   * 这里两个都给：谁赢是服务端的事，前端不预判（预判就等于把「收窄」这条服务端语义抄到 web，
   * 一旦服务端口径变了无从发现）。
   */
  if (!workflowEqual(v.workflow, baseline.workflow)) {
    // 列集与阶段同源（`workflowInput` 单点）——列编辑（增 / 删自定义列、补核心列）靠它上报，
    // 否则服务端只按 raw.columns 写回，用户的列改动被静默丢弃（M-2）。
    patch.workflow = workflowInput(v.workflow)
    fields.push('workflow')
  }
  // 乐观并发（R-v11-15）：只在**拿到过** mtime 时带——服务端未下发 source_mtime（旧响应）
  // 就不带，宁可没有防护也不拿编造的值去撞假冲突。
  if (v.sourceMtime !== undefined) patch.if_match = v.sourceMtime
  const depositChanged =
    v.depositEnabled !== baseline.depositEnabled ||
    v.defaultLayer !== baseline.defaultLayer ||
    v.defaultType !== baseline.defaultType ||
    v.priority !== baseline.priority ||
    v.requireNote !== baseline.requireNote
  if (depositChanged) {
    patch.deposit = depositPolicy(v)
    fields.push('deposit')
  }

  if (fields.length === 0) return { ok: false, error: t('teams.form.nothingChanged') }
  return { ok: true, patch, fields }
}
