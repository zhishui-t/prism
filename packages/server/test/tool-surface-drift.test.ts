/**
 * **文档工具口径**防漂移测试：`README.md` 与 `doc/requirements/cli-mcp-surface.md`。
 *
 * 背景：`skill-tools-drift.test.ts` 只锁住了 Skill 正文（`packages/skills`），未覆盖这两份文档。
 * `9641e5e`（v5 多项目图谱合并 F-C2）新增 `prism_graph_merge` 后，Skill 与代码同步到了 36，
 * 但 README 与 cli-mcp-surface 仍停留在 35（代码图谱 7）——两处口径静默漂移，无人发现。
 * 故把这两份文档的「总数 + 分组小计 + 工具名」一并纳入守卫。
 *
 * 口径：分组小计之和 = 实测工具数；正文点名的工具必须真实存在（无幽灵工具）；
 * 实测工具必须被正文收录（宿主可发现）。`❌ 未实现` 标注行是**刻意保留的决策痕迹**，跳过。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createMcpTools } from '../src/mcp/server.js'

/** 读仓库根下相对路径的文件（测试跑在 `packages/server/test/`）。 */
function readRepoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')
}

/** 从文本提取 `prism_*` 名字（过滤 `prism_kb_*` 这类统称——以 `_` 结尾）。 */
function namesIn(text: string): Set<string> {
  const found = new Set<string>()
  for (const m of text.matchAll(/prism_[a-z_]+/g)) {
    if (!m[0].endsWith('_')) found.add(m[0])
  }
  return found
}

/** 文档 §2 各节表格里点名的工具（跳过 `❌ 未实现` 行——那是刻意保留的决策痕迹）。 */
function toolsNamedInTables(doc: string): Set<string> {
  const found = new Set<string>()
  for (const line of doc.split('\n')) {
    if (line.includes('❌')) continue
    const m = line.match(/^\|\s*`(prism_[a-z_]+)`/)
    if (m) found.add(m[1])
  }
  return found
}

const actual = createMcpTools({ home: 'X:/unused' })
const actualNames = actual.map((t) => t.name)

describe('README / cli-mcp-surface 工具口径 vs 实际 MCP 工具（防漂移）', () => {
  it('README 声明的总数与分组小计 = 实测工具数', () => {
    const readme = readRepoFile('README.md')
    const line = readme.match(/MCP 工具\s*(\d+)\s*个\**：(.+?)（`tools\/list` 实测）/)
    expect(
      line,
      'README 未找到「MCP 工具 N 个：…（tools/list 实测）」口径行',
    ).not.toBeNull()

    expect(Number(line![1])).toBe(actual.length)

    const groups = [...line![2].matchAll(/(\d+)/g)].map((m) => Number(m[1]))
    expect(groups.length, 'README 未解析到分组小计').toBeGreaterThan(0)
    expect(groups.reduce((a, b) => a + b, 0)).toBe(actual.length)
  })

  it('README 点名的工具都真实存在（无幽灵工具）', () => {
    const mentioned = namesIn(readRepoFile('README.md'))
    const ghosts = [...mentioned].filter((n) => !actualNames.includes(n))
    expect(ghosts, `README 提到的工具不存在: ${ghosts.join(', ')}`).toEqual([])
  })

  it('cli-mcp-surface 声明的总数与分组小计 = 实测工具数', () => {
    const doc = readRepoFile('doc/requirements/cli-mcp-surface.md')

    const total = doc.match(/工具总数 = \*\*(\d+)\*\*/)
    expect(total, 'cli-mcp-surface 未找到「工具总数 = **N**」口径').not.toBeNull()
    expect(Number(total![1])).toBe(actual.length)

    const subs = [...doc.matchAll(/^### 2\.\d+ .*?（(\d+)）/gm)].map((m) => Number(m[1]))
    expect(subs.length, 'cli-mcp-surface §2 未解析到分组小计').toBeGreaterThan(0)
    expect(subs.reduce((a, b) => a + b, 0)).toBe(actual.length)
  })

  it('cli-mcp-surface §2 表格与实测工具集双向一致', () => {
    const named = toolsNamedInTables(readRepoFile('doc/requirements/cli-mcp-surface.md'))

    const ghosts = [...named].filter((n) => !actualNames.includes(n))
    expect(ghosts, `cli-mcp-surface 提到的工具不存在: ${ghosts.join(', ')}`).toEqual([])

    const missing = actualNames.filter((n) => !named.has(n))
    expect(missing, `cli-mcp-surface 未收录的工具: ${missing.join(', ')}`).toEqual([])
  })
})
