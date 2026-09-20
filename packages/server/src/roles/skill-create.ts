/**
 * Skill 写盘的服务端入口（`POST /api/skills/install` / `POST /api/skills/uninstall`
 * / `DELETE /api/skills/external/:name` 与 MCP `prism_skill_install` / `prism_skill_uninstall` 共用）。
 *
 * 分工（与 `role-create.ts` / `team-create.ts` 同一形状，写路径单点可审）：
 * - 实际写盘 = `@prism/skills` 的 `installSkills` / `uninstallSkills`
 *   （CLI `prism skill install|uninstall` 同一实现）；
 * - **校验 + 落点参数化 = 本模块**：落点**恒为调用方显式给出的 `skills_dir`**，
 *   没有 env 回落，也绝不复用 `resolveDirsFromHome` 的默认宿主目录（R5/R6 延伸）。
 *   例外说明：`DELETE /api/skills/external/:name` 的 `skills_dir` 由路由层按
 *   `resolveDirsFromHome(home, {rootExplicit:true})` 解析后传入（与 `installedSkillNames` /
 *   `GET /api/skills` 同源），本模块仍是「收目录、不解析 home」。
 *
 * 为什么补这块（2026-09-12 接口审查）：此前 skill 写侧是**唯一真缺口**——CLI 有
 * `skill install|uninstall`，而 MCP 只有只读的 `prism_skill_effective`、HTTP 只有 3 条只读路由，
 * 宿主 agent 无法经 MCP 装 Skill。补齐后三入口同名同位（`install` / `uninstall`）。
 * v10 F3 再补**外部技能删除**（marker 的反面，见 `deleteExternalSkillDefinition`）。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { isInside, PrismError } from '@prism/core'
import type { TrashStore, TrashTrigger } from '@prism/core'
import { hasPrismMarker, installSkills, listBuiltinSkills, uninstallSkills } from '@prism/skills'

/** 安装/卸载 Skill 请求体（MCP 与 HTTP 共用；`skills_dir` 必填）。 */
export interface SkillWriteBody {
  /** **必填**：目标目录（无 env 回落，绝不回落到默认宿主目录） */
  skills_dir?: unknown
  /** 要处理的 Skill 名；缺省或空数组 = 全部（安装=全部内置 / 卸载=扫描目录下全部） */
  names?: unknown
  /** 仅安装：覆盖人写的同名 Skill（缺省不覆盖，写 `.prism-new` 供对比） */
  force?: unknown
}

export interface SkillInstallOutcome {
  skills_dir: string
  written: string[]
  skipped: Array<{ path: string; reason: string }>
}

export interface SkillUninstallOutcome {
  skills_dir: string
  /** **实际落点**（整目录绝对路径；v9 F3 起不再是被卸的 Skill 名，见 `uninstallSkills` 注释）。 */
  removed: string[]
  kept: Array<{ name: string; path: string; reason: string }>
  /** 回收站单元 id（每个被卸 Skill 一个单元，与 `removed` 同序）。 */
  trash_ids: string[]
}

/** `POST /api/skills/install` / `prism_skill_install`：安装内置 Skill 到**显式** `skills_dir`。 */
export async function installBuiltinSkillDefinitions(body: SkillWriteBody): Promise<SkillInstallOutcome> {
  const targetDir = requireSkillsDir(body)
  const all = listBuiltinSkills()
  const names = asStringList(body.names) ?? []
  const missing = names.filter((n) => !all.some((s) => s.name === n))
  if (missing.length > 0) {
    throw new PrismError(
      'bad_request',
      `unknown_skill：未知内置 Skill: ${missing.join(', ')}（可用: ${all.map((s) => s.name).join(', ')}）`,
    )
  }
  const skills = names.length === 0 ? all : all.filter((s) => names.includes(s.name))
  if (skills.length === 0) {
    throw new PrismError('bad_request', 'no_skill_to_install：没有要安装的 Skill（内置清单为空）')
  }
  const result = await installSkills({ targetDir, skills, force: body.force === true })
  return { skills_dir: targetDir, ...result }
}

/**
 * `POST /api/skills/uninstall` / `prism_skill_uninstall` / CLI `prism skill uninstall`：
 * **只回收 Prism 产物**（人写的一律不动）。
 *
 * v9 F3：原「直接删」改为 `TrashStore.put`（可 `prism trash restore <id>` 还原）。
 * 回收站由入口层按 `PRISM_HOME` 构造后注入（`trashStoreFor`），本模块只传 `trigger` 定界来源。
 * 一个 Skill 一个回收站单元，故 `trash_ids` 是数组。
 */
export async function uninstallSkillDefinitions(
  body: SkillWriteBody,
  trash: TrashStore,
  trigger: TrashTrigger,
): Promise<SkillUninstallOutcome> {
  const targetDir = requireSkillsDir(body)
  const names = asStringList(body.names)
  const result = await uninstallSkills(
    { targetDir, ...(names !== undefined ? { names } : {}) },
    { trash, trigger },
  )
  return {
    skills_dir: targetDir,
    removed: result.removed,
    kept: result.kept,
    trash_ids: result.trashIds,
  }
}

export interface SkillExternalDeleteOutcome {
  skills_dir: string
  /** 实际落点（整目录绝对路径）。 */
  removed: string[]
  /** 回收站单元 id（可 `prism trash restore <id>` 还原）。 */
  trash_id: string
}

/** `SKILL.md` 侧的落点三态（按**文件**判定，与名字是否内置无关）。 */
export type ExternalSkillState = 'absent' | 'no_skill_md' | 'prism_product' | 'external'

/**
 * 校验技能名并解析出 `skillsDir` 内的**目标绝对路径**。
 *
 * - 消毒发生在路由器 `decodeURIComponent` **之后**（`..%2F..` 解码后含 `/`）：空串、`.`、`..`、
 *   含 `/` 或 `\` 一律 `bad_request`；
 * - **根保护**：`isInside` 会放行根自身（`===`），故必须**另断言** resolve 后不等于 `skillsDir`
 *   ——否则空名之类会让 `TrashStore` 把整个 `skills_dir` 搬走（`put` 不校验源路径，源守卫是
 *   调用方责任，见 `is-inside.ts` 与 store 注释）。
 */
export function resolveExternalSkillTarget(rawName: string, skillsDir: string): { name: string; target: string } {
  const name = rawName.trim()
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new PrismError(
      'bad_request',
      `invalid_skill_name：非法技能名 ${JSON.stringify(rawName)}（不接受空串、. / ..、路径分隔符）`,
    )
  }
  const root = resolve(skillsDir)
  const target = resolve(root, name)
  if (target === root || !isInside(root, target)) {
    throw new PrismError(
      'bad_request',
      `invalid_skill_name：技能名 ${JSON.stringify(rawName)} 解析后指向受管根自身或越界，拒绝执行`,
    )
  }
  return { name, target }
}

/** 读落点判三态；`SKILL.md` 读不出来（权限/损坏）按**无 marker** 处理——删除进回收站，可恢复。 */
async function externalSkillStateOf(target: string): Promise<ExternalSkillState> {
  if (!existsSync(target)) return 'absent'
  const skillFile = join(target, 'SKILL.md')
  if (!existsSync(skillFile)) return 'no_skill_md'
  const text = await readFile(skillFile, 'utf-8').catch(() => '')
  return hasPrismMarker(text) ? 'prism_product' : 'external'
}

/**
 * 是否「外部可删」= 有 `SKILL.md` 且**无** Prism marker。供 `GET /api/skills/usage` 逐行标注，
 * 让控制台区分「删除（外部技能）」与「卸载（Prism 产物）」。
 *
 * 只读面：单条异常（非法名/读失败）一律 `false`，绝不因一行让整张列表 500。
 */
export async function isExternalSkillRemovable(skillsDir: string, name: string): Promise<boolean> {
  try {
    const { target } = resolveExternalSkillTarget(name, skillsDir)
    return (await externalSkillStateOf(target)) === 'external'
  } catch {
    return false
  }
}

/**
 * `DELETE /api/skills/external/:name`（v10 F3 服务端）：把**外部技能**整目录搬进回收站。
 *
 * 与 `uninstallSkillDefinitions`（只回收 Prism 产物）**互补**——这里回收的是 marker 的反面。
 * 判定按**落点文件**，**不按名字查 `listBuiltinSkills`**：用户「复制内置 skill 后改写」得到的
 * 同名技能是人写的，必须可删；按名查内置清单会把它误判成 Prism 产物而拒绝。
 *
 * - 目录不存在 / 目录存在但无 `SKILL.md` → `not_found`（非技能目录不可删）；
 * - `SKILL.md` 含 Prism marker → `id_conflict`（提示走卸载，不在这里删）；
 * - 删除 = 整目录 `TrashStore.put`（含 `references/` 等子项，不留半目录）；
 * - `managedRoot` **必须是 `skills_dir`**：restore 的目标定界只信任它，误传 `PRISM_HOME`
 *   会让还原恒报 `trash_restore_escape`；
 * - 软链目录按 TrashStore 既有行为**只搬链接**、不追目标（`installedSkillNames` 用
 *   `isDirectory()` 过滤，软链技能本就不进控制台列表）；
 * - `skills_dir` **必填**（v15 B-4）：与 `deleteRoleDefinition` / `deleteTeamDefinition` 同参
 *   形态——`unknown` 入参 + trim 后非空校验，缺参即 `bad_request skills_dir_required`，绝不
 *   回落到默认宿主目录（MCP 第三面对称新增后，非法缺参不再以 TypeError 形式暴露）。
 */
export async function deleteExternalSkillDefinition(
  rawName: string,
  skillsDir: unknown,
  trash: TrashStore,
  trigger: TrashTrigger,
): Promise<SkillExternalDeleteOutcome> {
  const targetDir = asNonEmptyString(skillsDir)
  if (targetDir === undefined) {
    throw new PrismError(
      'bad_request',
      'skills_dir_required：未指定 Skill 目录（防误写真实宿主，写路径一律显式参数化）。',
    )
  }
  const { name, target } = resolveExternalSkillTarget(rawName, targetDir)
  const state = await externalSkillStateOf(target)
  if (state === 'absent') {
    throw new PrismError('not_found', `skill_not_found：${target} 不存在（skills_dir = ${targetDir}）`)
  }
  if (state === 'no_skill_md') {
    throw new PrismError(
      'not_found',
      `not_a_skill_dir：${target} 下没有 SKILL.md，不是技能目录，拒绝删除`,
    )
  }
  if (state === 'prism_product') {
    throw new PrismError(
      'id_conflict',
      `skill_is_prism_product：${name} 是 Prism 产物（SKILL.md 含 Prism marker），请走卸载（POST /api/skills/uninstall）`,
    )
  }
  const moved = await trash.put('skill', name, [target], { managedRoot: targetDir, trigger })
  return { skills_dir: targetDir, removed: moved.originalPaths, trash_id: moved.id }
}

function requireSkillsDir(body: SkillWriteBody): string {
  const dir = asNonEmptyString(body.skills_dir)
  if (dir === undefined) {
    throw new PrismError(
      'bad_request',
      'skills_dir_required：未指定 Skill 目录（防误写真实宿主，写路径一律显式参数化）。',
    )
  }
  return dir
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
}
