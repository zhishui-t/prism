/**
 * server 侧出厂团队模板（design-v3 §3.3 P3）。
 *
 * **`prism init` 不再使用它**：初始化只建空 `teams/`，是否建团队、建几个、用什么编制
 * 一律由使用者决定（2026-09-11 定：不替使用者做决定）。需要这套编排时走
 * `prism team new --template core-dev`（模板源在 `@prism/agents` 的 `TEAM_TEMPLATES['core-dev']`）。
 *
 * 仍保留导出：作为 server 入口可取到的 core-dev 完整样本（测试 fixture 亦依赖）。
 * 成员引用本机角色库角色名，`队长` 为编排角色（校验豁免）。
 */
export const CORE_DEV_TEAM_MD = `---
team_id: core-dev
name: 核心研发团队
description: 负责本项目的设计、开发、测试与质量收口；内置固定工作流。
default: true
extends: null
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
skills:
  - code_review
knowledge:
  layers: [global, project]
  books: []
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

# 核心研发团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 + dev-2 | 并行 | 任务书 | exploration.md | 结论落盘 | 缺资料 → 补调研 |
| 2 | 设计 | 队长 | 串行 | exploration.md | design.md | 需求全覆盖 | — |
| 3 | 设计审核 | qa-checker | 串行 | design.md | design-review.md + .design_ok | 门禁落盘 | 架构级 → 队长 |
| 4 | 开发 | dev-1 + dev-2 + super-dev | 并行 | design.md | stream-N.md | 自验通过 | 卡死 2 次 → super-dev |
| 5 | 测试 | tester | 串行 | 任务书 + 各流报告 | test-report.md | 全项有运行证据 | bug → 对应流 → 回归 |
| 6 | 总审 | qa-checker | 串行 | 全部 | qa-report.md + .qa_ok | 门禁落盘 | 超范围 → 返工（≤2 轮） |
| 7 | 交付 | 队长 | 串行 | 全部 | DELIVERY.md | 用户验收 | — |

## 门禁

| 门禁文件 | 执笔 | 放行条件 |
| :--- | :--- | :--- |
| .design_ok | qa-checker | 设计覆盖全部需求、可测、风险已识别 |
| .qa_ok | qa-checker | 需求逐条核对、测试证据齐全、遗留已分级 |

## 沉淀规则

- 任务完成时，由负责角色按 deposit 配置落库；
- 安全红线类知识强制 layer: global；
- 沉淀必须带来源（任务 ID + 角色）。

## 优先级

知识检索与注入的优先级：role > project > global（同相关性下）。
`
