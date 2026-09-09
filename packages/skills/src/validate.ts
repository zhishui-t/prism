import type { PrismSkill, SkillValidationIssue, SkillValidationResult } from './types.js'

/** name kebab-case（skill-loading.md §4：否则被宿主忽略）。 */
const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** description 上限（design-v3 §3.2 硬约束）。 */
export const MAX_DESCRIPTION_LENGTH = 1024

/**
 * SKILL.md frontmatter 粗校验：内容必须以 `---` 开头的 frontmatter 块起步，
 * 且块内含 name/description（缺则被宿主丢弃并 warn —— skill-loading.md §4）。
 */
function frontmatterOf(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (match === null) {
    return {}
  }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (m !== null) {
      fields[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
    }
  }
  return fields
}

/**
 * 校验 Prism Skill（skill-loading.md §4 约束 + design-v3 §3.2）：
 * - name 必填且 kebab-case → error
 * - description 必填、≤1024 字符 → error
 * - content 非空、含 frontmatter 且 name/description 一致 → error / warning
 * ok = 无 error（warning 不阻断）。
 */
export function validateSkill(skill: PrismSkill): SkillValidationResult {
  const issues: SkillValidationIssue[] = []
  const where = 'frontmatter'

  if (typeof skill.name !== 'string' || skill.name === '') {
    issues.push({ level: 'error', code: 'skill_name_missing', message: 'name 必填', where })
  } else if (!KEBAB_CASE.test(skill.name)) {
    issues.push({
      level: 'error',
      code: 'skill_name_invalid',
      message: `name 必须 kebab-case（小写字母/数字，连字符分隔）: ${skill.name}`,
      where,
    })
  }

  if (typeof skill.description !== 'string' || skill.description.trim() === '') {
    issues.push({ level: 'error', code: 'skill_description_missing', message: 'description 必填', where })
  } else if (skill.description.length > MAX_DESCRIPTION_LENGTH) {
    issues.push({
      level: 'error',
      code: 'skill_description_too_long',
      message: `description 超 ${MAX_DESCRIPTION_LENGTH} 字符（当前 ${skill.description.length}）`,
      where,
    })
  } else if (!skill.builtin && skill.description.length < 20) {
    issues.push({
      level: 'warning',
      code: 'skill_description_short',
      message: 'description 过短，建议包含触发词（何时应使用该 skill）',
      where,
    })
  }

  if (typeof skill.content !== 'string' || skill.content.trim() === '') {
    issues.push({ level: 'error', code: 'skill_content_missing', message: 'content（SKILL.md 全文）必填', where: 'body' })
  } else {
    const fm = frontmatterOf(skill.content)
    if (fm['name'] === undefined && fm['description'] === undefined) {
      issues.push({
        level: 'error',
        code: 'skill_frontmatter_missing',
        message: 'content 缺少 frontmatter（宿主会丢弃无 frontmatter 的 skill）',
        where: 'body',
      })
    } else {
      if (fm['name'] !== undefined && fm['name'] !== skill.name) {
        issues.push({
          level: 'warning',
          code: 'skill_frontmatter_name_mismatch',
          message: `frontmatter name（${fm['name']}）与 skill.name（${skill.name}）不一致，宿主以目录名/frontmatter 为准`,
          where,
        })
      }
      if (fm['description'] !== undefined && fm['description'] !== skill.description) {
        issues.push({
          level: 'warning',
          code: 'skill_frontmatter_description_mismatch',
          message: 'frontmatter description 与 skill.description 不一致',
          where,
        })
      }
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues }
}
