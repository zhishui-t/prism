/**
 * 角色表单的**纯逻辑**（B1 修复：从 `Roles.tsx` 抽出 payload 构造，使「编辑不清空
 * 未在表单里暴露的字段」这条 PATCH 语义可被单测锁定）。
 *
 * 只依赖 `api-team.ts` 的类型，不碰 React。
 *
 * **F1（v11）**：`skills` 从逗号文本框升级为**多选选取器**（数组），`knowledge.books`
 * 从「表单外、原样回传」升级为**可编辑的选取器**——于是 payload 的两处语义随之改成
 * 「表单值就是白名单的真相」：
 * - 列表操作（去重 / 移除 / 切换）抽成纯函数，chips 与弹层勾选共用同一处判据；
 * - 表单初值抽成 `seedRoleFormValues`（**唯一的播种处**）：它是「载入已有角色 → 表单 →
 *   payload」这条往返链上的一环，books 不再需要从 `initial` 二次回传。
 */

import type { RoleDefinition, RoleWriteInput } from '../api-team.ts'

/** 表单值（new / edit 共用超集；`initial` 之外的字段都由组件 state 提供）。 */
export interface RoleFormValues {
  name: string
  description: string
  color: string
  model: string
  thought: string
  /** 技能白名单（F1：多选选取器的结果，**保持选取顺序**，不重排）。 */
  skills: string[]
  /** 知识层（仍是对称于前台输入框的逗号分隔文本）。 */
  layers: string
  /** 知识书目（F1 起有编辑位；空 = 不写该键，服务端缺省补 `[]` = 清空绑定）。 */
  books: string[]
  body: string
  dir: string
}

/** 逗号分隔文本 → 去空串数组（表单里 `layers` 输入框用）。 */
export function splitList(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * 追加一项（**去重、去空白、忽略空串**）：已是成员时原样返回**同一个数组引用**——
 * `setState` 收到同一引用不会重渲染，语义上就是「什么也没发生」（重复点击「添加」不该有副作用）。
 */
export function appendToList(list: readonly string[], name: string): string[] {
  const trimmed = name.trim()
  if (trimmed === '' || list.includes(trimmed)) return list as string[]
  return [...list, trimmed]
}

/** 移除一项（不在列内时同样返回同一引用）。 */
export function removeFromList(list: readonly string[], name: string): string[] {
  if (!list.includes(name)) return list as string[]
  return list.filter((x) => x !== name)
}

/** 勾选 / 取消勾选（选取器每一行都走它；两个方向都幂等）。 */
export function toggleInList(list: readonly string[], name: string): string[] {
  return list.includes(name) ? removeFromList(list, name) : appendToList(list, name)
}

/**
 * 表单初值（**唯一播种处**）：`rolesDir` 来自 `GET /api/roles` 的读回值，
 * `initial` 是编辑时的角色定义（new 传 `null`）。
 *
 * 为什么单独抽出来：F1 之前 books 不在表单里，靠 `buildRoleInput` 从 `initial` 回传
 * （B1 那次修复）；现在 books 有编辑位了，往返链变成
 * 「定义 → 本函数 → 表单 state → buildRoleInput」，故**这一环也要有回归锁**
 * ——丢了它，编辑一次描述就会静默清空 books（原缺陷换了个位置复发）。
 */
export function seedRoleFormValues(rolesDir: string, initial: RoleDefinition | null): RoleFormValues {
  return {
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    color: initial?.color ?? '',
    model: initial?.model ?? '',
    thought: initial?.thoughtLevel ?? '',
    skills: [...(initial?.skills ?? [])],
    layers: (initial?.knowledge?.layers ?? ['global']).join(', '),
    books: [...(initial?.knowledge?.books ?? [])],
    body: initial?.body ?? '',
    dir: rolesDir,
  }
}

/**
 * 表单值 → 请求体（`POST /api/roles` 与 `PATCH /api/roles/:name` 共用）。
 *
 * **PATCH 语义（B1）**：服务端 `strictKnowledge` 在 edit 下「显式给出 knowledge 对象
 * 即视为**全量写入**，缺省字段补 `[]`」，随后 `knowledgeToOverlay` 重写整个
 * `## 知识范围` 小节——所以发给它什么，这个角色的知识绑定就变成什么。
 * F1 起表单**同时暴露 layers 与 books**，两个字段都由表单值直接给：
 * - `books` 空 ⇒ **不发该键**（服务端缺省补 `[]`，即「清空绑定」）——这正是用户显式
 *   在选取器里移光所有书目的语义，与「未暴露的字段被顺手清掉」是两件事；
 * - `books` 非空 ⇒ 原样发出（选取顺序）。
 */
export function buildRoleInput(mode: 'new' | 'edit', v: RoleFormValues): RoleWriteInput {
  const books = v.books
  const input: RoleWriteInput = {
    description: v.description.trim(),
    skills: v.skills,
    knowledge: {
      layers: splitList(v.layers),
      // 空 = 不写 `books: []`（交给服务端缺省，语义等价于清空）
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
