/**
 * `team init` 的内置团队骨架模板（design-v4 §F-C1 / §3.3）。
 *
 * 与 `packages/server/src/roles/templates.ts` 的 `CORE_DEV_TEAM_MD` **互为独立资产**：
 * 后者是 server 侧导出的完整样本（`prism init` 自 2026-09-11 起**不再播种团队**），
 * 本文件服务 `prism team init` 的脚手架渲染，**不做合并**
 * （design-v4 §F-C1 明确：避免跨包搬运；agents 不依赖 server）。
 *
 * 占位符在渲染前替换（`{{team_id}}` / `{{name}}` / `{{description}}`），
 * 替换值一律用 JSON 双引号标量（与 `emitScalar` 口径一致），避免描述里的冒号/引号破坏 YAML。
 */

export const TEAM_TEMPLATE_TEAM_ID_PLACEHOLDER = '{{team_id}}'
export const TEAM_TEMPLATE_NAME_PLACEHOLDER = '{{name}}'
export const TEAM_TEMPLATE_DESCRIPTION_PLACEHOLDER = '{{description}}'

/**
 * 最小可用团队骨架（默认模板）：1 个 dev-1 + 1 个 tester，3 阶段工作流
 * （开发 → 测试 → 收口；收口由编排角色「队长」承担，校验豁免 members）。
 */
export const MINIMAL_TEAM_MD = `---
team_id: {{team_id}}
name: {{name}}
description: {{description}}
default: false
members:
  - role: dev-1
    count: 1
  - role: tester
    count: 1
skills: []
knowledge:
  layers: [global, project]
deposit:
  enabled: true
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: true
arbitration: [requirement, quality, progress]
rework_limit: 2
---

# {{name}}

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 开发 | dev-1 | 串行 | 任务书 | patch | 自验通过 | 卡死 2 次 → 队长 |
| 2 | 测试 | tester | 串行 | patch | test-report.md | 全项有运行证据 | bug → 开发 → 回归 |
| 3 | 收口 | 队长 | 串行 | 全部产物 | DELIVERY.md | 用户验收 | 超范围 → 返工（≤2 轮） |

## 沉淀规则

- 任务收口（CLOSED）时由负责角色按 deposit 配置落库；
- 安全红线类知识强制 layer: global；
- 沉淀必须带来源（任务 ID + 角色）。

## 优先级

知识检索与注入的优先级：role > project > global（同相关性下）。
`

/**
 * 核心研发团队骨架（`--template core-dev`）：5 成员 7 阶段，
 * 形状对齐出厂 `core-dev`，但成员由 `--members` 覆盖（缺省即下表）。
 */
export const CORE_DEV_TEAM_MD = `---
team_id: {{team_id}}
name: {{name}}
description: {{description}}
default: false
members:
  - role: dev-1
    count: 1
  - role: dev-2
    count: 1
  - role: super-dev
    count: 1
  - role: tester
    count: 1
  - role: qa-checker
    count: 1
skills: []
knowledge:
  layers: [global, project]
deposit:
  enabled: true
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: true
  rules:
    - match: { type: rule }
      set: { layer: global, priority: high }
    - match: { tags: [security] }
      set: { layer: global, priority: high }
arbitration: [safety, requirement, quality, progress]
rework_limit: 2
---

# {{name}}

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 + dev-2 | 并行 | 任务书 | exploration.md | 结论落盘 | 缺资料 → 补调研 |
| 2 | 设计 | 队长 | 串行 | exploration.md | design.md | 需求全覆盖 | — |
| 3 | 设计审核 | qa-checker | 串行 | design.md | design-review.md | 门禁落盘 | 架构级 → 队长 |
| 4 | 开发 | dev-1 + dev-2 + super-dev | 并行 | design.md | stream-N.md | 自验通过 | 卡死 2 次 → super-dev |
| 5 | 测试 | tester | 串行 | 任务书 + 各流报告 | test-report.md | 全项有运行证据 | bug → 对应流 → 回归 |
| 6 | 总审 | qa-checker | 串行 | 全部 | qa-report.md | 门禁落盘 | 超范围 → 返工（≤2 轮） |
| 7 | 交付 | 队长 | 串行 | 全部 | DELIVERY.md | 用户验收 | — |

## 沉淀规则

- 任务收口（CLOSED）时由负责角色按 deposit 配置落库；
- 安全红线类知识强制 layer: global；
- 沉淀必须带来源（任务 ID + 角色）。

## 优先级

知识检索与注入的优先级：role > project > global（同相关性下）。
`

/** 模板 id → 骨架（`team init --template`）。 */
export const TEAM_TEMPLATES: Record<'minimal' | 'core-dev', string> = {
  minimal: MINIMAL_TEAM_MD,
  'core-dev': CORE_DEV_TEAM_MD,
}

/**
 * 占位符替换（渲染前一步）。
 *
 * frontmatter 里的值一律 `JSON.stringify`（合法 YAML 双引号标量）——描述含 `:`/`"`/换行
 * 也不会破坏结构；正文标题里的 `{{name}}` 用**原文**（不加引号）。
 * 空串 → `""`（parse 仍是空串，由校验器报 `description_required`）。
 */
export function fillTeamTemplate(
  skeleton: string,
  values: { teamId: string; name: string; description: string },
): string {
  return skeleton
    .replaceAll(`team_id: ${TEAM_TEMPLATE_TEAM_ID_PLACEHOLDER}`, `team_id: ${JSON.stringify(values.teamId)}`)
    .replaceAll(`name: ${TEAM_TEMPLATE_NAME_PLACEHOLDER}`, `name: ${JSON.stringify(values.name)}`)
    .replaceAll(
      `description: ${TEAM_TEMPLATE_DESCRIPTION_PLACEHOLDER}`,
      `description: ${JSON.stringify(values.description)}`,
    )
    // 其余出现（如正文标题 `# {{name}}`）用原文
    .replaceAll(TEAM_TEMPLATE_NAME_PLACEHOLDER, values.name)
}
