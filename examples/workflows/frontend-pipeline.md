---
workflow: frontend-pipeline
name: 前端三段流水线
level: role
binds: [frontend-dev]
skills: [frontend-design, baoyu-design, design-taste-frontend]
---

# 前端三段流水线（frontend-pipeline）

> 界面任务从方向到成品的过程单元：方向未定不动手，抛光不改方向。同一任务的三个阶段由**同一个 frontend-dev 实例贯穿**——方向原样流进制作与抛光，不靠转述。

## 步骤表

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 定方向 | frontend-dev | frontend-design | task-brief.md / tasks.md 任务卡 | `.agent-team/design-brief.md`（4–6 个命名 hex 色板、字体与角色分配、布局概念含 ASCII 线框、差异化原则） | **只出简报不写码**；自查「生成感」默认样式；每个视觉决定说得出来源 | 方向被否 → 改简报再呈队长 |
| 2 | 制作 | frontend-dev | baoyu-design | design-brief.md（+ SKILL 指路文件） | 可运行界面代码/原型 | **简报即约束**：色板/字体/布局不得临时发挥 | 需要简报外的新样式 → 回 1 补简报，不许就地发挥 |
| 3 | 抛光 | frontend-dev | design-taste-frontend | 代码 + design-brief.md | 抛光变更清单（修了什么/为什么/剩余开放项） | 以审计者身份过 AI Tells 清单 + Pre-Flight Check，违规 `[位置] 问题 → 修法` 逐条清零 | 发现**方向性**错误 → 停手上报队长，不悄悄重设计 |

## 硬性约束

- **串行不跳步**：阶段 2 不得先跑；抛光不得推翻方向
- **简报落盘是跨阶段接口**：阶段 2/3 派发时附路径；它同时是 reviewer 检视界面的对照物、tester-blackbox 视觉审计的基线（tester-dual-track 步骤 5）
- **降级**：小修小补（改间距/补空态/修对齐）直接走阶段 3；纯 bug 修复不走本流水线（归 dev-red-green）
- 长任务（阶段 2）可后台跑，队长不空等

## 被谁引用

- 角色绑定：`examples/roles/frontend-dev.md`
- 团队引用：delivery 阶段 6（frontend-dev 分流，以其团队定义口径为准）
