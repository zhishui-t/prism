---
workflow: design-verify-flow
name: 设计文档开发前验证
level: role
binds: []
skills: [design-verify, spec-vs-impl-checker, spec-verify, spec-writer]
---

# 设计文档开发前验证（design-verify-flow）

> 本工作流的**载体是 skill**：`examples/design-verify/SKILL.md` 是唯一真相源，六步/裁决分级/质检点/工具选型一律以 skill 文件为准——本单元只登记输入输出与交接接口，不重写内容。`binds` 留空：承接者随步骤变化（队长指挥 / 独立实例复核 / 人守三个位置），见步骤表。

## 步骤表

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 锁定业务真相源 | 队长执笔（只读子代理收集）｜**人**确认 | design-verify | 需求文档/工单/测试/git log/系统行为 | `.design-verify/behavior-contract.md` | 有专家签字，或无专家路径显式降级（裁决上限 Go with Gaps） | 真相未定 → No-Go |
| 2 | 事实锚定 | 队长提取（图优先 resolve-symbols）→ 脚本机械层 → **独立实例**语义层 → **人**抽 5 条质检 | design-verify | 设计文档 | anchors.md → verdict.md + semantic-review.md | BLOCKER 清零 + 质检点通过 | BLOCKER → 修复 → `--only` 定向复验 |
| 3 | 跨文档闭环 | 队长（可派 tester-whitebox） | spec-vs-impl-checker | 实际文档集 + anchors 代码锚点 | trace-matrix.md + backlog.md | 核心链路断头路清零；第六类只记不堵 | 缺口①-③ → 补设计回 2 |
| 4 | 技术风险红队 | **新会话独立实例**（不看原文）｜人抽样反证 | design-verify | 队长整理的决策清单 | redteam-report.md | P0 风险每条有验证方式或修复方案 | P0 未处置 → 修复复验 |
| 5 | 门禁裁决 | **人**签 | design-verify | 全部产物 | gate.md | Go / Go with Gaps（缺口记负责人+期限）/ No-Go | 未过项 → 第 6 步 |
| 6 | 修复与复验 | 队长 + 独立实例定向复核 | design-verify | 修复项 | gate.md 复验记录 | 只查修复项及影响面，不全量重跑 | — |
| 7 | 交接开发 | 队长 | — | gate.md + trace-matrix.md | tasks.md 任务卡种子（→ delivery 阶段 5） | trace-matrix 闭环行逐条转任务卡；gate.md 并入 `.design_ok` 证据链 | — |

## 硬性约束

- 派遣判定：本会话参与写文档 → 语义层必须独立实例；外部文档小任务 → 可内联自核但 verdict 标注「非独立实例」；红队永远新会话；机械层永远脚本
- 轻重路径：需求级路由（全流程/轻量）触发条件见 `examples/pipeline.md` 统一路由表
- 接 delivery 时 `.design-verify/` 产物并入 `.agent-team/`；独立使用保持 `.design-verify/`

## 被谁引用

- 主干位置：`examples/pipeline.md` 主干地图「验证设计」段（delivery 阶段 2-3 的前置强化件）
- 团队引用：任意团队的设计审核环节均可挂（delivery 为「严格执行」团队，以其自身口径为准）
