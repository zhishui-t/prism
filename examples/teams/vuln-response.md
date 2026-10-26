---
team_id: vuln-response
name: 漏洞响应团队
description: 独立 intake 的漏洞处置流水线：受理登记→复现定级→深度审计→处置路由→修复复验→知识沉淀。与开发团队通过工件面/门禁面/知识面衔接，不共享会话。
extends: null
members:
  - role: reviewer
    count: 1
  - role: dev
    count: 1
  - role: tester-whitebox
    count: 1
skills: [prism]
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
    - match: { tags: [security] }
      set: { layer: global, priority: high }
    - match: { type: rule }
      set: { layer: global, priority: high }
arbitration: [security, quality, progress]
rework_limit: 2
---

# 漏洞响应团队

> **队长手册绑定**：启用本团队 = 队长（主会话）加载 `prism` 技能的《Prism Agent Team》队长手册，
> 手册贡献操作手法（澄清协议、文件黑板、会话登记、DAG、断点恢复、异常兜底）。**流程内容以本文件
> 与所引用的工作流单元为准**（`~/.zcode/workflows/vuln-response-flow.md`）。

## 独立 intake（本团队与开发团队的根本区别）

本团队的输入**不是**开发团队的输出，而是三类外部事件：**漏洞报告**（用户/外报）、**扫描结果**
（周期扫描/依赖审计）、**用户通报**。开发团队的交付物只是**可选输入之一**（如审计其 diff）。
黑板用 `.vuln/`（与 `.agent-team/`、`.design-verify/` 互不干扰）。

## 工作流

> 完整步骤表、硬性约束见 `vuln-response-flow.md`（团队级工作流单元，本表为其登记视图）。
> 「引用:」= 该阶段照被引角色级工作流的步骤表与硬性约束执行。

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 受理登记 | 队长 | 串行 | intake（漏报/扫描/通报） | `.vuln/register.md` | 每漏洞一行，重复合并 | — |
| 2 | 复现定级 | reviewer | 串行 | register 条目 | 复现步骤 + 严重度 | 可复现给步骤；不能复现标「待证」升级用户 | 误报 → 关闭留痕 |
| 3 | 深度审计 | reviewer | 串行 | 复现结论 + 范围代码 | `.vuln/sec-report.md` + `.sec_ok` | **引用: workflows/sec-audit.md** 五步走完 | 红线 → 紧急处置 |
| 4 | 处置路由 + 修复 | 队长 + dev | 串行 | sec-report + 定级 | 修复任务卡 + 修复 diff（**引用: dev-red-green**） | 紧急·高派 dev 修复；中·低排期；误报关闭 | 修复卡住 → 升级攻关路由 |
| 5 | 修复复验 | tester-whitebox | 串行 | 修复 diff + 复现步骤 | `.vuln/verify-report.md` | 复现重跑转绿 + 定向回归，证据落盘 | 未过 → 回 4（≤2 轮） |
| 6 | 沉淀关闭 | 队长 | 串行 | 全部产物 | KB 条目 + 关单 | security→global；**未过 .sec_ok 不关单** | — |

> 修复阶段派 dev 时附 `workflows/dev-red-green.md` 路径（**引用:** dev-red-green）与
> `spec-guard` 技能路径——先过开工闭环再动手。

## 派发约定

从队长手册：一条路（角色归属任务派子代理，队长不代劳）、一遍活（禁双跑）、实例复用
（同角色续棒 SendMessage 既有 agentId，登记 `.vuln/agents.md`）、按独立性分桶。
四段式 prompt（任务/工作流位置/输入/输出），修复任务卡六要素：目标/写域/验收标准（=复现步骤
转绿+回归）/上下文/依赖/完成动作。

## 与开发团队的衔接（三衔接面）

- **工件面**：本团队产出 `.sec_ok` + `sec-report.md`；需要开发团队修复时，问题条目转成
  开发团队任务卡（六要素），双方黑板各自留痕，靠文件交接
- **门禁面**：消费开发团队交付物做审计时，核对其 `.design_ok` / `.code_ok` / `test-report.md`
  存在且结论通过——门禁缺失 = 材料不齐，退回不猜
- **知识面（常态，最重要）**：本团队每次关单沉淀 security 知识（deposit 规则自动路由 global 层
  high）；开发团队任何角色开工 `prism_context_pack` 装载 global 层即获得这些规则——
  上一轮漏洞的教训自动变成下一轮开发的防线，**无需任何人主动通知**

## 知识钩子

- 开工（阶段 2/3 前）：`prism_context_pack(role=reviewer, task=<漏洞摘要>)` 装载既有安全规则
- 关单（阶段 6）：按团队 deposit 规则沉淀——漏洞根因与修复模式（project 层 pitfall）、
  可复用的安全规则（security tag → global 层 high）
- 团队 frontmatter `knowledge.layers: [global, project]` 已声明装载绑定

## 上下文压缩与恢复（状态在黑板，不在记忆）

- **状态载体**：`.vuln/register.md` 的状态列（每漏洞一行：受理→已复现→已定级→审计中→修复中→复验中→已关闭）+ `.vuln/agents.md` 实例登记 + 各阶段产物文件
- **恢复动作**（同 agent-team 队长手册三步）：读 register + agents 登记 + 最近产物 → 对照 vuln-response-flow 步骤表判定每条漏洞当前步骤 → 向用户简报断点。**不凭压缩摘要继续派发**
- 子代理实例各持上下文，不受队长压缩影响；实例死亡按登记表 `SendMessage` 探活，确认死后从黑板（register + 该角色最近产物）重建，不重新侦察

## 门禁

- `.sec_ok` 未写 → 不关单、不进复验结论「已修复」
- 复验证据缺失（只有结论没有重跑命令与输出）→ 不关单
- 红线级问题不允许降级放行（仲裁链 security > quality > progress）
- 待证漏洞不静默丢弃：升级用户或记录保留
