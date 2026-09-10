/**
 * Skill 有效集计算（design-v4 §F-D1 / §3.3）——**纯函数，零 IO**。
 *
 * 合并口径：`installed`（全局已装）∪ `teamSkills`（团队声明）∪ `roleSkills`（角色声明），
 * 去重并按 **global → team → role** 顺序累积来源，同名条目合并 `sources`；输出按 `name` 升序。
 *
 * 缺失判定（两种码，均为 warning —— 与 `team/validate.ts` 的 `skill_unknown` 级别一致）：
 * - `skill_unknown`：名字既不在 `known`（内置清单 ∪ 已装）里（`known` 缺省 → 不判）；
 * - `skill_not_installed`：声明了但当前宿主未安装（`installed` 缺省 → 不判，保持与现状兼容：
 *   宿主 skills 目录不存在时 `installedSkillNames()` 返回 `undefined`）。
 *
 * **装配函数不在本文件**：`loadEffectiveSkills({roleId, teamId?, teamsDir, rolesDir, harnessRoot})`
 * 按 §3.4 归 `packages/server/src/roles/wiring.ts`（MCP/HTTP/CLI 共用的唯一装配点），
 * 本文件只保证「同输入 → 同输出」的纯计算。
 */

import type { ValidationIssue } from './types.js'

/** 一个生效 Skill：名字 + 来源标注 + 宿主是否已装。 */
export interface EffectiveSkill {
  name: string
  /** 去重后的来源（可能多个：既全局装了、团队也声明了） */
  sources: Array<'global' | 'team' | 'role'>
  /** 宿主已装？（`installed` 缺省视为 true，不产生缺失告警） */
  available: boolean
}

/** 有效集（角色可选绑定团队）。 */
export interface EffectiveSkillSet {
  /** 角色 id（输入未提供时为 `''`） */
  role: string
  /** 团队 id（未绑定时缺省） */
  team?: string
  /** 按 name 升序 */
  skills: EffectiveSkill[]
  /** `skill_unknown` / `skill_not_installed` */
  warnings: ValidationIssue[]
}

/** 计算输入（design-v4 §3.3 冻结形状；`role`/`team` 为可选补充，供输出回填）。 */
export interface ComputeEffectiveSkillsInput {
  /** 角色声明的 skills（必填，允许空数组） */
  roleSkills: string[]
  /** 团队声明的 skills（可选） */
  teamSkills?: string[]
  /** 宿主已装 skill 名单；缺省 = 宿主 skills 目录不存在（不判 `skill_not_installed`） */
  installed?: string[]
  /** 「确实存在」的名字集合（内置清单 ∪ 已装）；缺省 = 不判 `skill_unknown` */
  known?: string[]
  /** 角色 id（仅用于回填输出） */
  role?: string
  /** 团队 id（仅用于回填输出） */
  team?: string
}

/** 去重保序的字符串列表过滤（去掉空串与首尾空白）。 */
function clean(names: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of names ?? []) {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name !== '') out.push(name)
  }
  return out
}

/**
 * 计算生效 Skill 集（叠加 / 去重 / 缺失告警）。
 *
 * 示例：`installed=['prism','code_review']`、`teamSkills=['code_review']`、`roleSkills=['taint_trace']`
 * → `prism(global)`、`code_review(global+team)`、`taint_trace(role)`。
 */
export function computeEffectiveSkills(input: ComputeEffectiveSkillsInput): EffectiveSkillSet {
  const installed = input.installed !== undefined ? clean(input.installed) : undefined
  const known = input.known !== undefined ? clean(input.known) : undefined
  const installedSet = installed !== undefined ? new Set(installed) : undefined
  const knownSet = known !== undefined ? new Set(known) : undefined

  /** name → 条目（插入顺序 = global → team → role） */
  const merged = new Map<string, EffectiveSkill>()
  const add = (names: readonly string[] | undefined, source: 'global' | 'team' | 'role'): void => {
    for (const name of clean(names)) {
      const existing = merged.get(name)
      if (existing === undefined) {
        merged.set(name, {
          name,
          sources: [source],
          available: installedSet === undefined ? true : installedSet.has(name),
        })
        continue
      }
      if (!existing.sources.includes(source)) existing.sources.push(source)
      // available 与来源无关：同一名字全局同一判定，无需重算
    }
  }

  add(installed, 'global')
  add(input.teamSkills, 'team')
  add(input.roleSkills, 'role')

  // 输出排序：按 name 升序（设计 §3.3 冻结形状；不依赖 locale，保证跨环境确定）
  const skills = [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const warnings: ValidationIssue[] = []
  for (const skill of skills) {
    if (knownSet !== undefined && !knownSet.has(skill.name)) {
      warnings.push({
        level: 'warning',
        code: 'skill_unknown',
        message: `引用的 skill 不存在：${skill.name}（内置清单与已装名单都没有它）`,
      })
      continue
    }
    if (installedSet !== undefined && !installedSet.has(skill.name)) {
      warnings.push({
        level: 'warning',
        code: 'skill_not_installed',
        message: `skill 已声明但当前宿主未安装：${skill.name}（prism skill install ${skill.name}）`,
      })
    }
  }

  return {
    role: input.role ?? '',
    ...(input.team !== undefined ? { team: input.team } : {}),
    skills,
    warnings,
  }
}
