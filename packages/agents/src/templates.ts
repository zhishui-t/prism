/**
 * 内置角色正文骨架（`prism role new` 的正文源）。
 *
 * **2026-09-12 形态收口**：原 `ROLE_TEMPLATE_MD` 是一份**带 frontmatter 的整文件模板**，
 * 其 frontmatter 含 Prism 私有键 `skills` / `knowledge`。这与两个适配器自述的落盘约定都冲突：
 * - workbuddy 插件：`frontmatterFields: ['name', 'description']`；
 * - zcode 内置：白名单六字段，且注释写明「Prism 扩展一律放正文，frontmatter 只含白名单字段」。
 *
 * 现在 frontmatter 交给适配器的 `renderRole` 生成（宿主原生形态），本文件只提供**正文骨架**；
 * Prism 扩展（skills 白名单 / 知识绑定）由渲染器落到正文的
 * `## 能力（Skill 白名单）` / `## 知识绑定` 两节。
 */

export const ROLE_TEMPLATE_NAME_PLACEHOLDER = '{{name}}'

/** 角色正文骨架（`{{name}}` 占位符在写入时替换）。 */
export const ROLE_BODY_SKELETON = `# {{name}}

## 核心第一原则
**TODO：一句话，可裁决、有张力、域内专属、可检验。**

TODO：它在什么冲突下做出什么牺牲（没有取舍的原则是口号）。

## 职责
- TODO：做什么

## 边界（禁止）
- TODO：不做什么（边界比职责更重要——防止越界）

## 协作位置
- 上游输入：TODO
- 下游消费者：TODO
- 受阻回流：升级队长

## 完成判定
- TODO：可检验的"做完了"，不是感觉
`
