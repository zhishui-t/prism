/**
 * @prism/skills — Prism Skill 管理（design-v3 F08）
 * 内置 skill（prism 元 skill）+ SKILL.md 校验 + 安装（§5 冲突策略）。
 */

export type {
  PrismSkill,
  SkillValidationIssue,
  SkillValidationResult,
  SkillInstallOptions,
  SkillInstallResult,
  SkillInstallSkipped,
  SkillUninstallOptions,
  SkillUninstallKept,
  SkillUninstallResult,
} from './types.js'

export { validateSkill, MAX_DESCRIPTION_LENGTH } from './validate.js'
export { installSkills } from './install.js'
export { uninstallSkills } from './uninstall.js'
export { PRISM_MARKER_PREFIX, prismSkillMarker, hasPrismMarker } from './marker.js'
export { prismSkill } from './builtin/index.js'

import { builtinSkills } from './builtin/index.js'

/** design-v3 §3.2：listBuiltinSkills() 返回内置 skill。 */
export function listBuiltinSkills(): typeof builtinSkills {
  return builtinSkills
}
