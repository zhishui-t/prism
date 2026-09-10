import { describe, expect, it } from 'vitest'

import { resolveTeamExtends, MAX_EXTENDS_DEPTH } from '../src/team/extends.js'
import { parseTeamMarkdown } from '../src/team/parse.js'
import type { TeamDefinition } from '../src/types.js'

function parseWithDeclared(raw: string): { team: TeamDefinition; declared: Set<string> } {
  const declared = new Set<string>()
  const team = parseTeamMarkdown(raw, { declaredKeys: declared })
  return { team, declared }
}

/** 父团队（被继承）。 */
const PARENT_MD = `---
team_id: base-team
name: 基础团队
description: 父级描述
default: false
members:
  - role: dev-1
    count: 2
skills: [code_review]
arbitration: [安全, 质量, 进度]
rework_limit: 3
---

## 核心契约
父级正文。
`

/** 子团队：extends + 只声明 members 与 team_id/name。 */
const CHILD_MD = `---
team_id: fast-team
name: 快速团队
extends: base-team
members:
  - role: dev-2
    count: 1
---

## 核心契约
子级正文。
`

/** 团队继承合并（team-definition.md §2.1 extends）。 */
describe('resolveTeamExtends', () => {
  it('子级继承父级标量，数组成员整体替换', async () => {
    const store = new Map<string, string>([
      ['base-team', PARENT_MD],
      ['fast-team', CHILD_MD],
    ])
    const { team, declared } = parseWithDeclared(store.get('fast-team')!)
    const merged = await resolveTeamExtends({ team, declared }, async (id) => {
      const raw = store.get(id)
      if (raw === undefined) return null
      return parseWithDeclared(raw).team
    })

    // 子级身份保留
    expect(merged.team_id).toBe('fast-team')
    expect(merged.name).toBe('快速团队')
    // 未声明 → 继承父级
    expect(merged.description).toBe('父级描述')
    expect(merged.arbitration).toEqual(['安全', '质量', '进度'])
    expect(merged.skills).toEqual(['code_review'])
    expect(merged.rework_limit).toBe(3)
    // 声明 members → 整体替换（不与父级拼接）
    expect(merged.members).toEqual([{ role: 'dev-2', count: 1 }])
    // 正文用子级
    expect(merged.body).toContain('子级正文')
  })

  it('extends 的父团队不存在 → not_found', async () => {
    const { team, declared } = parseWithDeclared(CHILD_MD)
    await expect(resolveTeamExtends({ team, declared }, async () => null)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('成环 → team_extends_cycle', async () => {
    const a = parseWithDeclared('---\nteam_id: a\nextends: b\n---\n\nx\n')
    const b = parseWithDeclared('---\nteam_id: b\nextends: a\n---\n\nx\n')
    const store = new Map([['a', a], ['b', b]])
    await expect(
      resolveTeamExtends({ team: a.team, declared: a.declared }, async (id) => store.get(id)?.team ?? null),
    ).rejects.toMatchObject({ code: 'team_extends_cycle' })
  })

  it('链超过最大深度 → team_extends_depth', async () => {
    // 构造超长链 t0 → t1 → … → t(N-1)（N = 上限 + 2，必然超深）
    const teams = new Map<string, { team: TeamDefinition; declared: Set<string> }>()
    const N = MAX_EXTENDS_DEPTH + 2
    for (let i = 0; i < N; i++) {
      const parentId = i + 1 < N ? `t${i + 1}` : null
      const fm = parentId !== null ? `extends: ${parentId}\n` : ''
      teams.set(`t${i}`, parseWithDeclared(`---\nteam_id: t${i}\n${fm}---\n\nx\n`))
    }
    const first = teams.get('t0')!
    await expect(
      resolveTeamExtends({ team: first.team, declared: first.declared }, async (id) => teams.get(id)?.team ?? null),
    ).rejects.toMatchObject({ code: 'team_extends_depth' })
  })

  it('无 extends → 原样返回', async () => {
    const { team, declared } = parseWithDeclared(PARENT_MD)
    const merged = await resolveTeamExtends({ team, declared }, async () => null)
    expect(merged.team_id).toBe('base-team')
  })
})
