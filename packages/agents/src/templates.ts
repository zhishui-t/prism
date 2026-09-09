/**
 * 内置角色模板（装配语义简化：`role init` 的模板源；模板仍保留在包内）。
 * `{{name}}` 占位符在初始化时替换。
 */

export const ROLE_TEMPLATE_NAME_PLACEHOLDER = '{{name}}'

/** 通用角色模板（role-definition §3.3 骨架；核心第一原则/职责/边界留待填写）。 */
export const ROLE_TEMPLATE_MD = `---
name: "{{name}}"
description: "TODO：一句话说清职责 + 适用于 + 不适用于（派遣决策依据）。"
skills: []
knowledge:
  layers: [global, project]
---

# {{name}}

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
