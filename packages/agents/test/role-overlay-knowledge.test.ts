/**
 * SPEC-2.1–2.4：知识绑定 overlay 的 **books-only** 提取（v16 B-2 / R-2，全量轨·数据角落）。
 *
 * 根因（`packages/agents/src/role/parse.ts:151`）：
 *   `return layers.length > 0 ? (books.length > 0 ? { layers, books } : { layers }) : undefined`
 * —— `layers` 为空数组时整个绑定被判成「无绑定」，正文里明明写着的 `- books:` 行被静默丢弃。
 *
 * 后果链（**读侧漏、写侧早已修**）：
 *   1. `parseRoleMarkdown` → knowledge 回落到**导入默认层** `{layers:['global','project']}`，
 *      角色「绑了书却显示绑了两层」；
 *   2. CLI `role edit` 的读-改-写（`mergeKnowledge`）读到 `base.books === undefined`，
 *      于是后续任何 knowledge 变更（如再点名一次 `--layers`）会把 books **真删**。
 *      渲染侧（`render.composeBody` / `write.knowledgeToOverlay`）本就支持 books-only，
 *      漏的只有读侧这一处。
 *
 * 口径（审核钉死）：
 * - 返回 `{ layers, books? }`；**books 为空时不写该键**（返回 `books: []` 会搅动既有 `toEqual` 断言）；
 * - 「无绑定」= `undefined` 仅当**两维皆空**（节不存在 / 节在但 layers 与 books 都提取不到）。
 *
 * 已知状态变化（**有意为之**，design 已记录）：books-only 绑定在 `validateRole` 侧从「无告警」
 * 显性化为 1 条 `knowledge_layers_empty` error——修前靠导入默认层静默掩盖，修后如实报「没绑层」。
 */
import { describe, expect, it } from 'vitest'

import { extractOverlayKnowledge, parseRoleMarkdown } from '../src/role/parse.js'
import { validateRole } from '../src/role/validate.js'

/** 拼一份「指定 overlay 内容」的角色文件（无 frontmatter knowledge，故走 overlay 回收路径）。 */
function roleWithOverlay(overlay: string): string {
  return [
    '---',
    'name: dev-x',
    'description: 一般开发。',
    '---',
    '',
    '# dev-x',
    '',
    '## 核心第一原则',
    '**交付可运行的增量。**',
    '',
    '## 知识绑定',
    overlay,
  ].join('\n')
}

describe('SPEC-2.1 layers 空不吞 books（overlay 只有 books 行）', () => {
  it('直接提取：layers=[] 时 books 仍解析出来', () => {
    expect(extractOverlayKnowledge('## 知识绑定\n- books: a, b')).toEqual({ layers: [], books: ['a', 'b'] })
  })

  it('经 parseRoleMarkdown：不再回落导入默认层', () => {
    const role = parseRoleMarkdown(roleWithOverlay('- books: a, b'))
    expect(role.knowledge).toEqual({ layers: [], books: ['a', 'b'] })
    // 反证：默认两层不得混进来（否则「只绑这几本书」会被悄悄放大成「两层全部」）
    expect(role.knowledge.layers).toEqual([])
    // 且 books 键存在——「有绑定」与「无绑定」在返回值层面可区分
    expect('books' in role.knowledge).toBe(true)
  })

  it('单本 / 多本 / 带空项都稳健提取', () => {
    expect(extractOverlayKnowledge('## 知识绑定\n- books: only')).toEqual({ layers: [], books: ['only'] })
    expect(extractOverlayKnowledge('## 知识绑定\n- books: a, b, c')).toEqual({ layers: [], books: ['a', 'b', 'c'] })
    expect(extractOverlayKnowledge('## 知识绑定\n- books: a, , b')).toEqual({ layers: [], books: ['a', 'b'] })
  })
})

describe('SPEC-2.2 两维皆空 → 无绑定（undefined，与现状一致）', () => {
  it('无「知识绑定」节 → undefined', () => {
    expect(extractOverlayKnowledge('# dev-x\n\n## 职责\n- 前期探索')).toBeUndefined()
  })

  it('节存在但为空 → undefined', () => {
    expect(extractOverlayKnowledge('## 知识绑定\n\n## 职责\n- x')).toBeUndefined()
  })

  it('节存在但两维都提取不到 → undefined', () => {
    expect(extractOverlayKnowledge('## 知识绑定\n这里没有列表行')).toBeUndefined()
    expect(extractOverlayKnowledge('## 知识绑定\n- layers: universe')).toBeUndefined() // 非法层名丢弃 → 两维皆空
    expect(extractOverlayKnowledge('## 知识绑定\n- layers: \n- books: ')).toBeUndefined()
  })

  it('parseRoleMarkdown 侧：无绑定 → 仍按导入默认补两层（缺省语义不变）', () => {
    const role = parseRoleMarkdown('---\nname: dev-x\ndescription: d\n---\n\n## 核心第一原则\n**x**\n')
    expect(role.knowledge).toEqual({ layers: ['global', 'project'] })
  })
})

describe('SPEC-2.4 既有非空形态零回归（形状与现状一致）', () => {
  it('layers + books 同时给出', () => {
    expect(extractOverlayKnowledge('## 知识绑定\n- layers: global, role\n- books: x, y')).toEqual({
      layers: ['global', 'role'],
      books: ['x', 'y'],
    })
  })

  it('只有 layers → **不含 books 键**（不是 books: []）', () => {
    const binding = extractOverlayKnowledge('## 知识绑定\n- layers: project')
    expect(binding).toEqual({ layers: ['project'] })
    expect(Object.keys(binding ?? {})).toEqual(['layers'])
  })

  it('非法层名照旧被丢弃、合法层保留', () => {
    expect(extractOverlayKnowledge('## 知识绑定\n- layers: global, nope, role')).toEqual({ layers: ['global', 'role'] })
  })

  it('overlay 形态经 parseRoleMarkdown：knowledge 逐字段相等', () => {
    const role = parseRoleMarkdown(roleWithOverlay('- layers: global, project\n- books: x'))
    expect(role.knowledge).toEqual({ layers: ['global', 'project'], books: ['x'] })
  })
})

describe('SPEC-2.4 books-only 在 validate 侧显性化为 1E（已知、有意的状态变化）', () => {
  it('修前被导入默认层掩盖；修后 knowledge_layers_empty 恰好 1 条 error', () => {
    const role = parseRoleMarkdown(roleWithOverlay('- books: a'))
    expect(role.knowledge).toEqual({ layers: [], books: ['a'] })

    const result = validateRole(role)
    const layerIssues = result.issues.filter((i) => i.code === 'knowledge_layers_empty')
    expect(layerIssues).toHaveLength(1)
    expect(layerIssues[0].level).toBe('error')
    // 「绑了书却没绑层」是真的不完整状态 → 校验必须报出来（是显性化，不是回归）
    expect(result.ok).toBe(false)
  })
})
