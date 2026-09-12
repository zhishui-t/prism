/**
 * Skill 写盘的服务端入口（`POST /api/skills/install` / `POST /api/skills/uninstall`
 * 与 MCP `prism_skill_install` / `prism_skill_uninstall` 共用）。
 *
 * 分工（与 `role-create.ts` / `team-create.ts` 同一形状，写路径单点可审）：
 * - 实际写盘 = `@prism/skills` 的 `installSkills` / `uninstallSkills`
 *   （CLI `prism skill install|uninstall` 同一实现）；
 * - **校验 + 落点参数化 = 本模块**：落点**恒为调用方显式给出的 `skills_dir`**，
 *   没有 env 回落，也绝不复用 `resolveDirsFromHome` 的默认宿主目录（R5/R6 延伸）。
 *
 * 为什么补这块（2026-09-12 接口审查）：此前 skill 写侧是**唯一真缺口**——CLI 有
 * `skill install|uninstall`，而 MCP 只有只读的 `prism_skill_effective`、HTTP 只有 3 条只读路由，
 * 宿主 agent 无法经 MCP 装 Skill。补齐后三入口同名同位（`install` / `uninstall`）。
 */

import { PrismError } from '@prism/core'
import { installSkills, listBuiltinSkills, uninstallSkills } from '@prism/skills'

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
  removed: string[]
  kept: Array<{ name: string; path: string; reason: string }>
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

/** `POST /api/skills/uninstall` / `prism_skill_uninstall`：只删 Prism 产物（人写的一律不动）。 */
export async function uninstallSkillDefinitions(body: SkillWriteBody): Promise<SkillUninstallOutcome> {
  const targetDir = requireSkillsDir(body)
  const names = asStringList(body.names)
  const result = await uninstallSkills({ targetDir, ...(names !== undefined ? { names } : {}) })
  return { skills_dir: targetDir, ...result }
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
