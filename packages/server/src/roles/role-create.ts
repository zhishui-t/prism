/**
 * 角色写盘的服务端入口（`POST /api/roles` / `PATCH /api/roles/:name` / `DELETE /api/roles/:name`
 * 与 MCP `prism_role_new` / `prism_role_edit` / `prism_role_rm` 共用）。
 *
 * 分工（与 `team-create.ts` 同一形状，写路径单点可审）：
 * - 实际写盘 = agents `newRole` / `editRole` / `removeRole`（CLI `prism role new|edit|rm` 同一实现）；
 * - **校验 + 落点参数化 = 本模块**：落点**恒为调用方显式给出的 `roles_dir`**，
 *   没有 env 回落，也绝不复用 `resolveDirsFromHome` 的默认宿主目录（R5/R6 延伸）。
 *
 * 渲染：`role new` 按宿主原生形态落盘，渲染器由调用方传入（HTTP 走 `roleRendererFor`）；
 * 缺省由 agents 回落到 `renderZcodeRole`。
 */

import { PrismError } from '@prism/core'
import {
  editRole,
  newRole,
  removeRole,
  RoleWriteError,
  type KnowledgeBinding,
  type RoleColor,
  type RoleRenderer,
} from '@prism/agents'

/** 新建/修改角色请求体（MCP 与 HTTP 共用；`roles_dir` 必填）。 */
export interface RoleWriteBody {
  name?: unknown
  description?: unknown
  skills?: unknown
  knowledge?: unknown
  body?: unknown
  /** `PATCH` 上 `''` / `null` = 清除该 frontmatter 键；缺省 = 不改。 */
  color?: unknown
  model?: unknown
  thought_level?: unknown
  /** **必填**：写入目录（无 env 回落，绝不回落到默认宿主目录） */
  roles_dir?: unknown
  force?: unknown
}

export interface RoleWriteOutcome {
  path: string
  /** 是否发生了覆盖（`--force` / `force: true`）。 */
  overwritten: boolean
}

const KNOWLEDGE_LAYERS = ['global', 'project', 'role'] as const

/** `POST /api/roles` / `prism_role_new`：新建角色（已存在且未 force → `id_conflict`）。 */
export async function createRoleDefinition(
  body: RoleWriteBody,
  opts: { renderRole?: RoleRenderer } = {},
): Promise<RoleWriteOutcome> {
  const targetDir = asNonEmptyString(body.roles_dir)
  if (targetDir === undefined) {
    throw new PrismError(
      'bad_request',
      'roles_dir_required：未指定角色目录（防误写真实宿主，写路径一律显式参数化）。请在「写入目录」填入角色目录后重试。',
    )
  }
  const name = asNonEmptyString(body.name)
  if (name === undefined) {
    throw new PrismError('bad_request', 'role_name_required：未指定角色名（kebab-case，即文件名）')
  }

  const input = {
    name,
    rolesDir: targetDir,
    ...(asNonEmptyString(body.description) !== undefined ? { description: String(body.description).trim() } : {}),
    ...(strArray(body.skills) !== undefined ? { skills: strArray(body.skills)! } : {}),
    ...(parseKnowledge(body.knowledge) !== undefined ? { knowledge: parseKnowledge(body.knowledge)! } : {}),
    ...(typeof body.body === 'string' ? { body: body.body } : {}),
    ...(asNonEmptyString(body.color) !== undefined ? { color: String(body.color).trim() as RoleColor } : {}),
    ...(asNonEmptyString(body.model) !== undefined ? { model: String(body.model).trim() } : {}),
    ...(asNonEmptyString(body.thought_level) !== undefined ? { thoughtLevel: String(body.thought_level).trim() } : {}),
    ...(body.force === true ? { force: true } : {}),
    ...(opts.renderRole !== undefined ? { renderRole: opts.renderRole } : {}),
  }

  const result = await run(() => newRole(input))
  if (result.written.length === 0) {
    const path = result.skipped[0]?.path ?? name
    throw new PrismError('id_conflict', `角色已存在，未覆盖：${path}（如需修改请用 prism role edit 或 PATCH /api/roles/:name）`)
  }
  return { path: result.written[0]!, overwritten: body.force === true }
}

/** `PATCH /api/roles/:name` / `prism_role_edit`：按字段补丁修改既有角色。 */
export async function updateRoleDefinition(
  name: string,
  body: RoleWriteBody,
  opts: { renderRole?: RoleRenderer } = {},
): Promise<RoleWriteOutcome> {
  void opts // edit 走外科式补丁，不需要渲染器
  const targetDir = asNonEmptyString(body.roles_dir)
  if (targetDir === undefined) {
    throw new PrismError(
      'bad_request',
      'roles_dir_required：未指定角色目录（防误写真实宿主，写路径一律显式参数化）。',
    )
  }
  const patch = {
    ...(asNonEmptyString(body.description) !== undefined ? { description: String(body.description).trim() } : {}),
    // edit 用**严格**解析：显式给出数组（含 `[]`）就是要写入的值 —— `[]` = 清空白名单
    // （`strArray` 会把 `[]` 折成 undefined，用在 edit 上会让「清空」静默失效）
    ...(strictStrArray(body.skills) !== undefined ? { skills: strictStrArray(body.skills)! } : {}),
    ...(strictKnowledge(body.knowledge) !== undefined ? { knowledge: strictKnowledge(body.knowledge)! } : {}),
    ...(typeof body.body === 'string' ? { body: body.body } : {}),
    // `color`/`model`/`thought_level` 的 edit 语义：缺省 = 不改；`''` 或 `null` = 清除该键
    ...(optionalClearable(body.color) !== undefined ? { color: optionalClearable(body.color)! } : {}),
    ...(optionalClearable(body.model) !== undefined ? { model: optionalClearable(body.model)! } : {}),
    ...(optionalClearable(body.thought_level) !== undefined
      ? { thoughtLevel: optionalClearable(body.thought_level)! }
      : {}),
  }
  if (Object.keys(patch).length === 0) {
    throw new PrismError('bad_request', 'role_patch_empty：未给出任何要修改的字段（description/skills/knowledge/body/color/model/thought_level）')
  }
  const result = await run(() => editRole({ name, rolesDir: targetDir, patch }))
  return { path: result.written[0]!, overwritten: false }
}

/** `DELETE /api/roles/:name` / `prism_role_rm`：删除角色文件本体。 */
export async function deleteRoleDefinition(name: string, rolesDir: unknown): Promise<{ removed: string[] }> {
  const targetDir = asNonEmptyString(rolesDir)
  if (targetDir === undefined) {
    throw new PrismError('bad_request', 'roles_dir_required：未指定角色目录（防误写真实宿主，写路径一律显式参数化）。')
  }
  return run(() => removeRole({ name, rolesDir: targetDir }))
}

/** 把 agents 的 `RoleWriteError` 归一为 `PrismError`（HTTP 走信封状态码、MCP 转 isError 文本）。 */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RoleWriteError) {
      const status = err.code === 'role_not_found' ? 'not_found' : 'bad_request'
      throw new PrismError(status, err.message, { path: err.path })
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

/** `skills` 形状容错：数组取字符串项，逗号串切分；空 → undefined。 */
export function strArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== '')
    return items.length > 0 ? items : undefined
  }
  const raw = asNonEmptyString(value)
  if (raw === undefined) return undefined
  const items = raw.split(',').map((v) => v.trim()).filter((v) => v !== '')
  return items.length > 0 ? items : undefined
}

/** `knowledge` 形状容错：`{layers:[...], books:[...]}`；非法层名丢弃；空 → undefined。 */
export function parseKnowledge(value: unknown): KnowledgeBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { layers?: unknown; books?: unknown }
  const layers = (Array.isArray(record.layers) ? record.layers : [])
    .filter((v): v is string => typeof v === 'string')
    .filter((v): v is (typeof KNOWLEDGE_LAYERS)[number] => (KNOWLEDGE_LAYERS as readonly string[]).includes(v))
  const books = (Array.isArray(record.books) ? record.books : []).filter((v): v is string => typeof v === 'string')
  if (layers.length === 0 && books.length === 0) return undefined
  return books.length > 0 ? { layers, books } : { layers }
}

/**
 * `skills` 的**严格**形状（仅 `PATCH /api/roles/:name` 用）：显式数组即为要写入的值。
 *
 * 与 `strArray` 的差别只有一处，但很关键：`[]` 在这里返回 `[]`（= 清空白名单），
 * 在 `strArray` 里被折成 `undefined`（= 不改）。新建时「空 = 用默认」，修改时「空 = 清空」。
 */
export function strictStrArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== '')
}

/** `knowledge` 的**严格**形状（仅 edit 用）：显式给对象即视为要写入，空绑定 = 清空。 */
export function strictKnowledge(value: unknown): KnowledgeBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { layers?: unknown; books?: unknown }
  const layers = (Array.isArray(record.layers) ? record.layers : [])
    .filter((v): v is string => typeof v === 'string')
    .filter((v): v is (typeof KNOWLEDGE_LAYERS)[number] => (KNOWLEDGE_LAYERS as readonly string[]).includes(v))
  const books = (Array.isArray(record.books) ? record.books : [])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '')
  return books.length > 0 ? { layers, books } : { layers }
}

/**
 * 可选字符串字段的 **edit 语义**（仅 `PATCH /api/roles/:name` 用）：
 * - 键缺省 / 非字符串非 null → `undefined`（不改）；
 * - `''`（trim 后空）或 `null` → `null`（**清除该 frontmatter 键**）；
 * - 非空字符串 → 该值。
 *
 * 与 `asNonEmptyString` 的差别：后者把「清除」和「不改」都压成 `undefined`，
 * 用在 PATCH 上会让「清除颜色/模型」静默失效。
 */
export function optionalClearable(value: unknown): string | null | undefined {
  if (value === undefined || (typeof value !== 'string' && value !== null)) return undefined
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
