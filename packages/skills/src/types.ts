/**
 * @prism/skills — 类型契约（design-v3.md §3.2 冻结，逐字对齐）。
 * ValidationResult / ValidationIssue 与 design §3.1 agents 包形状结构一致
 * （skills 与 agents 是平行依赖线，均只依赖 core，故各自最小声明、结构兼容）。
 */

/** Skill 附带文件（渐进披露：主 SKILL.md 精炼，细节按需读 references/）。 */
export interface SkillAsset {
  /** 相对 skill 目录的路径（如 `references/graph.md`）；禁止 `..` 越界。 */
  path: string
  content: string
}

/** Prism Skill（一个 skill = 一个目录 + SKILL.md + 可选附带文件）。 */
export interface PrismSkill {
  /** kebab-case */
  name: string
  /** ≤1024 字符，含触发词 */
  description: string
  /** SKILL.md 全文（含 frontmatter） */
  content: string
  /** 附带文件（references/ 等），随 SKILL.md 一起安装 */
  assets?: SkillAsset[]
  /** 内置 skill 的来源标识 */
  builtin: boolean
}

/** 校验问题（与 agents 包 ValidationIssue 结构一致）。 */
export interface SkillValidationIssue {
  level: 'error' | 'warning'
  code: string
  message: string
  where?: string
}

export interface SkillValidationResult {
  ok: boolean
  issues: SkillValidationIssue[]
}

export interface SkillInstallOptions {
  /** 安装目标目录（来自 --zcode-dir / adapter.skill.nativeDir 推导，绝不硬编码） */
  targetDir: string
  skills: PrismSkill[]
  /** 一律覆盖（design-v3 §5） */
  force?: boolean
}

export interface SkillInstallSkipped {
  path: string
  reason: string
}

export interface SkillInstallResult {
  written: string[]
  skipped: SkillInstallSkipped[]
}
