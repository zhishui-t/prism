/**
 * Skill 工具清单与实际 MCP 工具**防漂移**测试。
 *
 * 背景：Skill 的「工具速查」表曾写「31 个」而实际已是 36 个（漏了 graph_merge /
 * team_create / skill_effective / kb_versions / kb_book_structure）——宿主按 Skill
 * 检索能力时会以为某些工具不存在。文档漂移属高发问题，故用测试锁定。
 *
 * v6（2026-09-12）：角色 / 团队补齐增删改，`prism_team_create` 更名 `prism_team_new`，
 * 新增 `role_new|edit|rm`、`team_list|edit|rm|render` → 36 → **43**。
 *
 * 口径：从 Skill 正文（SKILL.md + references/*）提取全部 `prism_*` 工具名，
 * 与实际 `createMcpTools` 产出的工具集合比对（双向）。
 */
import { listBuiltinSkills } from '@prism/skills'

import { describe, expect, it } from 'vitest'

import { createMcpTools } from '../src/mcp/server.js'

/** Skill 全部文本（正文 + 附带文件）。 */
function skillText(): string {
  const skill = listBuiltinSkills().find((s) => s.name === 'prism')
  expect(skill, '未找到内置 prism skill').toBeDefined()
  const assets = (skill!.assets ?? []).map((a) => a.content).join('\n')
  return `${skill!.content}\n${assets}`
}

/** 从文本提取出现的 prism_* 工具名（去重）。 */
function toolsMentionedIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const m of text.matchAll(/prism_[a-z_]+/g)) {
    // 过滤掉非工具名的前缀提及（如 `prism_kb_*` 这类统称、`prism_work_` 已废前缀）
    if (m[0].endsWith('_')) continue
    found.add(m[0])
  }
  return found
}

describe('Skill 工具清单 vs 实际 MCP 工具（防漂移）', () => {
  it('实际工具数 = 43', () => {
    const tools = createMcpTools({ home: 'X:/unused' })
    expect(tools).toHaveLength(43)
  })

  it('Skill 提到的每个工具都真实存在（无幽灵工具）', () => {
    // 常见误写：把已移除的工具（prism_work_*）或拼错的名字留在 Skill 里
    const actual = new Set(createMcpTools({ home: 'X:/unused' }).map((t) => t.name))
    const mentioned = toolsMentionedIn(skillText())
    // 已知的历史/统称提及（不属于当前工具集，但文中作为说明出现）
    const allowances = new Set<string>([
      'prism_work_pending', // 文中说明「已移除」的对照
      'prism_llm_enrich', // 若出现拼写变体（防御）
    ])
    const ghosts = [...mentioned].filter((n) => !actual.has(n) && !allowances.has(n))
    expect(ghosts, `Skill 提到的工具不存在: ${ghosts.join(', ')}`).toEqual([])
  })

  it('实际工具都被 Skill 收录（宿主可发现）', () => {
    const actual = createMcpTools({ home: 'X:/unused' }).map((t) => t.name)
    const mentioned = toolsMentionedIn(skillText())
    const missing = actual.filter((n) => !mentioned.has(n))
    expect(missing, `Skill 未收录的工具: ${missing.join(', ')}`).toEqual([])
  })

  it('声明的总数与表格分组一致', () => {
    const text = skillText()
    expect(text).toContain('43 个 MCP 工具')
    // 分组小计之和 = 43
    const groups = [...text.matchAll(/(知识库|代码图谱|角色团队|任务台账)（(\d+)）/g)].map((m) => Number(m[2]))
    expect(groups.length).toBe(4)
    expect(groups.reduce((a, b) => a + b, 0)).toBe(43)
  })
})
