import { describe, expect, it } from 'vitest'

import type { RoleDefinition } from '../src/api-team.ts'
import { buildRoleInput, splitList, type RoleFormValues } from '../src/pages/roles-form-logic.ts'

function values(over: Partial<RoleFormValues> = {}): RoleFormValues {
  return {
    name: 'dev-1',
    description: '一句话职责',
    color: '',
    model: '',
    thought: '',
    skills: 'a, b',
    layers: 'global, role',
    body: '# 正文',
    dir: '/tmp/prism-roles',
    ...over,
  }
}

/** 既有角色（编辑基线）：`knowledge` 是服务端读回值，`books` 有可能非空。 */
function role(books?: string[]): RoleDefinition {
  return {
    name: 'dev-1',
    description: '一句话职责',
    skills: ['a'],
    knowledge: books === undefined ? { layers: ['global'] } : { layers: ['global'], books },
    principle: '',
    body: '# 正文',
  }
}

describe('buildRoleInput（B1：PATCH 缺省 = 不改，表单没暴露的字段必须原样回传）', () => {
  /**
   * 回归锁：`RoleForm` 没有 books 编辑位，而服务端 `strictKnowledge` 在 edit 时
   * 「显式给出对象即全量写入、缺省补 `[]`」→ 旧的内联构造（只发 layers）会让
   * `knowledgeToOverlay` 重写 `## 知识范围` 小节时丢掉 `- books:` 行，静默清空绑定。
   */
  it('initial.knowledge.books 非空 → 原样保留在 payload 里', () => {
    const input = buildRoleInput('edit', role(['a.md', 'b.md']), values())
    expect(input.knowledge?.books).toEqual(['a.md', 'b.md'])
  })

  it('initial 无 books（缺省 / 空数组）→ payload 不含 books 键（交给服务端缺省，不写 []）', () => {
    for (const r of [role(), role([])]) {
      const input = buildRoleInput('edit', r, values())
      expect(Object.prototype.hasOwnProperty.call(input.knowledge, 'books')).toBe(false)
    }
  })

  it('layers 为空串 / 空白 → layers 为 []（清空语义不被顺手回归掉）', () => {
    expect(buildRoleInput('edit', role(), values({ layers: '' })).knowledge?.layers).toEqual([])
    expect(buildRoleInput('edit', role(), values({ layers: '  , , ' })).knowledge?.layers).toEqual([])
  })
})

describe('splitList', () => {
  it('逗号分隔 + 去空白 + 滤空串', () => {
    expect(splitList(' a , b ,, c ')).toEqual(['a', 'b', 'c'])
  })
})
