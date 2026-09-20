/**
 * Skill 工具清单与实际 MCP 工具**防漂移**测试。
 *
 * 背景：Skill 的「工具速查」表曾写「31 个」而实际已是 36 个（漏了 graph_merge /
 * team_create / skill_effective / kb_versions / kb_book_structure）——宿主按 Skill
 * 检索能力时会以为某些工具不存在。文档漂移属高发问题，故用测试锁定。
 *
 * v6（2026-09-12）：角色 / 团队补齐增删改，`prism_team_create` 更名 `prism_team_new`，
 * 新增 `role_new|edit|rm`、`team_list|edit|rm|render` → 36 → **43**。
 * v6.2（2026-09-12）：补 MCP Skill 写入口（`prism_skill_list|install|uninstall`）→ **46**。
 * v10（2026-09-14）：架构图谱接 MCP（`prism_arch_generate` 统一入口，五类图全自动派生）→ **47**。
 * 其后：任务中心（任务台账 `prism_task_*` 三工具）整体移除 → **44**。
 * v8 F7（2026-09-16）：技能分类（`prism_skill_categorize` 写入 + `prism_skill_list` 合并
 * `category`）→ **45**。
 * v12 F4（2026-09-17）：技能分类**清单**增删改（`prism_skill_category_add|rename|rm`，
 * 与 HTTP 三路由 / CLI `prism skill category add|rename|rm` 同名同位）→ **48**。
 * v15 B-4（2026-09-18）：外部技能删除（`prism_skill_rm`，与 HTTP
 * `DELETE /api/skills/external/:name` / CLI `prism skill rm` 同一域单点）→ **49**。
 *
 * 口径：从 Skill 正文（SKILL.md + references/*）提取全部 `prism_*` 工具名，
 * 与实际 `createMcpTools` 产出的工具集合比对（双向）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
  it('实际工具数 = 49', () => {
    const tools = createMcpTools({ home: 'X:/unused' })
    expect(tools).toHaveLength(49)
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
    expect(text).toContain('49 个 MCP 工具')
    // 分组小计之和 = 49
    const groups = [...text.matchAll(/(知识库|代码图谱|架构图谱|角色团队)（(\d+)）/g)].map((m) =>
      Number(m[2]),
    )
    expect(groups.length).toBe(4)
    expect(groups.reduce((a, b) => a + b, 0)).toBe(49)
  })

  /**
   * v12 F4（SPEC-4.9）：技能分类清单三动作在 **MCP 与 HTTP 两面对齐**。
   *
   * 单锁一侧（只数 MCP 工具名、或只看路由）都发现不了「加了路由忘了加工具」这类半拉子。
   * 这里用**成对硬编码**（`_add` ↔ `POST`、`_rename` ↔ `PATCH`、`_rm` ↔ `DELETE`）双向断言：
   * 该对两侧都存在才算过——既防某侧缺失，也防两侧动词名漂移。
   */
  it('技能分类三动作：MCP 工具 ↔ HTTP 路由 一一对应', () => {
    const readRepoFile = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')

    // HTTP 侧：从装配处读实测注册（不靠注释/文档），构成 `METHOD /path` 集合
    const app = readRepoFile('packages/server/src/app.ts')
    const routes = new Set(
      [...app.matchAll(/router\.add\('(GET|POST|PATCH|DELETE)', '(\/api\/skills\/categories[^']*)'/g)].map(
        (m) => `${m[1]} ${m[2]}`,
      ),
    )

    const mcpTools = new Set(createMcpTools({ home: 'X:/unused' }).map((t) => t.name))

    const pairs: Array<[string, string]> = [
      ['prism_skill_category_add', 'POST /api/skills/categories'],
      ['prism_skill_category_rename', 'PATCH /api/skills/categories/:name'],
      ['prism_skill_category_rm', 'DELETE /api/skills/categories/:name'],
    ]
    for (const [tool, route] of pairs) {
      expect(mcpTools.has(tool), `MCP 缺工具 ${tool}`).toBe(true)
      expect(routes.has(route), `HTTP 缺路由 ${route}`).toBe(true)
    }

    // 反向：分类家族的三条**写**路由不得多出第四条（读路由 GET 不算）
    const mutating = [...routes].filter((r) => !r.startsWith('GET '))
    expect(mutating.sort()).toEqual(pairs.map(([, route]) => route).sort())
  })
})
