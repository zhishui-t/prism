/**
 * **CLI 命令面**防漂移测试：`README.md` §5 命令树、`doc/requirements/cli-mcp-surface.md` §1
 * 命令树 vs `packages/cli/src/commands/{role,team,skill}.ts` 的实际 `case` 分派。
 *
 * 背景：v6（`62e4082`）把 role/team 统一为增删改查并移除 `install|import` 后，两份文档的
 * 命令树先后静默滞后（第三轮同类漂移）。MCP 工具面已有 `tool-surface-drift.test.ts`
 * 守住（server 侧），CLI 命令面此前无人守。
 *
 * 口径：子命令集合**双向一致**——文档树不得列出不存在的命令（幽灵命令），实际分派的
 * 命令不得漏出文档树（宿主可发现）。`⚠ 已废弃` / `❌ 未实现` 标注行是刻意保留的决策
 * 痕迹，跳过；但未标注的滞后行会被任一侧抓到。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/** 读仓库根下相对路径的文件（测试跑在 `packages/cli/test/`）。 */
function readRepoFile(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')
}

/** 从命令源码提取实际子命令（`case 'x':` 分派标签）。 */
function dispatchedIn(src: string): Set<string> {
  return new Set([...src.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]))
}

/** README §5 单行式命令树：`├── role       list | show | …`（截去行尾注释）。 */
function readmeTreeEntries(readme: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const line of readme.split('\n')) {
    const m = line.match(/^├── (role|team|skill)\s+(.+)$/)
    if (!m) continue
    const items = m[2]
      .split('|')
      .map((s) => s.trim().split(/\s/)[0])
      .filter((s) => s.length > 0)
    out.set(m[1], new Set(items))
  }
  return out
}

/**
 * cli-mcp-surface §1 多行式命令树：组头 `├── role`，子项 `│   ├── x  说明`。
 * `⚠`（已废弃/更名）与 `❌`（未实现）标注行跳过——v5 取齐说明口径。
 */
function surfaceDocTreeEntries(doc: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  let current: string | null = null
  for (const line of doc.split('\n')) {
    const head = line.match(/^├── (\w+)/)
    if (head) {
      current = ['role', 'team', 'skill'].includes(head[1]) ? head[1] : null
      continue
    }
    if (current === null || line.includes('⚠') || line.includes('❌')) continue
    const child = line.match(/^│\s+[├└]── ([a-z-]+)/)
    if (child) {
      const set = out.get(current) ?? new Set<string>()
      set.add(child[1])
      out.set(current, set)
    }
  }
  return out
}

const sources = {
  role: dispatchedIn(readRepoFile('packages/cli/src/commands/role.ts')),
  team: dispatchedIn(readRepoFile('packages/cli/src/commands/team.ts')),
  skill: dispatchedIn(readRepoFile('packages/cli/src/commands/skill.ts')),
}

describe('README §5 命令树 vs CLI 实际分派（防漂移）', () => {
  const tree = readmeTreeEntries(readRepoFile('README.md'))

  for (const group of ['role', 'team', 'skill'] as const) {
    it(`group ${group} 双向一致`, () => {
      const doc = tree.get(group)
      expect(doc, `README §5 命令树缺 ${group} 分组`).toBeDefined()

      const ghosts = [...doc!].filter((c) => !sources[group].has(c))
      expect(ghosts, `README 列出不存在的 ${group} 子命令: ${ghosts.join(', ')}`).toEqual([])

      const missing = [...sources[group]].filter((c) => !doc!.has(c))
      expect(missing, `README 漏列的 ${group} 子命令: ${missing.join(', ')}`).toEqual([])
    })
  }
})

describe('cli-mcp-surface §1 命令树 vs CLI 实际分派（防漂移）', () => {
  const tree = surfaceDocTreeEntries(readRepoFile('doc/requirements/cli-mcp-surface.md'))

  for (const group of ['role', 'team', 'skill'] as const) {
    it(`group ${group} 双向一致（⚠/❌ 标注行除外）`, () => {
      const doc = tree.get(group)
      expect(doc, `cli-mcp-surface §1 命令树缺 ${group} 分组`).toBeDefined()

      const ghosts = [...doc!].filter((c) => !sources[group].has(c))
      expect(ghosts, `§1 列出未标注的幽灵 ${group} 子命令: ${ghosts.join(', ')}`).toEqual([])

      const missing = [...sources[group]].filter((c) => !doc!.has(c))
      expect(missing, `§1 漏列的 ${group} 子命令（漏标）: ${missing.join(', ')}`).toEqual([])
    })
  }
})
