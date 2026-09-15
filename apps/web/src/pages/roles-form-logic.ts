/**
 * 角色表单的**纯逻辑**（B1 修复：从 `Roles.tsx` 抽出 payload 构造，使「编辑不清空
 * 未在表单里暴露的字段」这条 PATCH 语义可被单测锁定）。
 *
 * 只依赖 `api-team.ts` 的类型，不碰 React。
 */

import type { RoleDefinition, RoleWriteInput } from '../api-team.ts'

/** 表单值（new / edit 共用超集；`initial` 之外的字段都由组件 state 提供）。 */
export interface RoleFormValues {
  name: string
  description: string
  color: string
  model: string
  thought: string
  skills: string
  layers: string
  body: string
  dir: string
}

/** 逗号分隔文本 → 去空串数组（表单里 `skills` / `layers` 两个输入共用）。 */
export function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * 表单值 → 请求体（`POST /api/roles` 与 `PATCH /api/roles/:name` 共用）。
 *
 * **PATCH 语义（B1）**：服务端 `strictKnowledge` 在 edit 下「显式给出 knowledge 对象
 * 即视为**全量写入**，缺省字段补 `[]`」，随后 `knowledgeToOverlay` 重写整个
 * `## 知识范围` 小节——所以发给它什么，这个角色的知识绑定就变成什么。
 * 本表单只有 `layers` 编辑位、**没有 books 编辑位**，故 `books` 必须从 `initial`
 * 原样回传；`initial` 无 books 时不发该键（服务端缺省补 `[]`，与「该角色本就没有
 * books」等价）。否则用户改个描述保存，就会静默清空 books 绑定（R7 红线）。
 */
export function buildRoleInput(
  mode: 'new' | 'edit',
  initial: RoleDefinition | null,
  v: RoleFormValues,
): RoleWriteInput {
  const books = initial?.knowledge?.books ?? []
  const input: RoleWriteInput = {
    description: v.description.trim(),
    skills: splitList(v.skills),
    knowledge: {
      layers: splitList(v.layers),
      // 表单无 books 编辑位 → 原样回传现有值；无值时不发键（不写 `books: []`）
      ...(books.length > 0 ? { books } : {}),
    },
    body: v.body,
    roles_dir: v.dir.trim(),
  }
  if (mode === 'new') input.name = v.name.trim()
  // 置空语义：新建时省略（用缺省），编辑时显式 null（清除该 frontmatter 键）
  if (v.color !== '') input.color = v.color as RoleWriteInput['color']
  else if (mode === 'edit') input.color = null
  if (v.model.trim() !== '') input.model = v.model.trim()
  else if (mode === 'edit') input.model = null
  if (v.thought !== '') input.thought_level = v.thought as RoleWriteInput['thought_level']
  else if (mode === 'edit') input.thought_level = null
  return input
}
