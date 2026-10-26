---
workflow: vuln-response-flow
name: 漏洞响应
level: team
binds: []
skills: [prism, spec-guard]
---

# 漏洞响应（vuln-response-flow）

> 团队级工作流，服务 vuln-response 团队。**独立 intake**：输入是漏洞报告/扫描结果/用户通报——不是开发团队的输出。示范团队级编排：阶段表用「引用:」调用角色级单元（sec-audit / dev-red-green / tester 复验步）。

## 步骤表

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 受理登记 | 队长 | — | intake（漏洞报告/扫描结果/用户通报） | `.vuln/register.md`（编号/来源/时间/影响面初判/可复现性=待证/**状态列**：受理→已复现→已定级→审计中→修复中→复验中→已关闭） | 每个漏洞一行；重复报告合并并标注 | — |
| 2 | 复现定级 | reviewer | — | register.md 条目 | register.md 更新（最小复现步骤 + 严重度：紧急/高/中/低） | 可复现的给步骤；不能复现 → 标「待证」，升级用户裁决是否处置 | 误报 → 关闭留痕 |
| 3 | 深度审计 | reviewer | **引用: workflows/sec-audit.md** | 复现结论 + 范围内代码/文档 | `.vuln/sec-report.md` + `.sec_ok` | sec-audit 五步走完；红线一票驳回 | 红线 → 阶段 4 紧急处置 |
| 4 | 处置路由 + 修复 | 队长路由，dev 执行 | — | sec-report + register 定级 | 修复任务卡 + 修复 diff | 紧急/高 → 派 dev（**引用: workflows/dev-red-green.md**，任务卡六要素）；中/低 → 登记排期；误报 → 关闭留痕 | dev 卡住 → 升级攻关路由 |
| 5 | 修复复验 | tester-whitebox | — | 修复 diff + 最小复现步骤 | `.vuln/verify-report.md` | **复现步骤重跑转绿** + 受影响面定向回归；证据落盘 | 未过 → 回 4 重修（≤ rework 2 轮，超限升级用户） |
| 6 | 沉淀关闭 | 队长 | prism（prism_kb_deposit） | 全部产物 | KB 条目 + 关单记录 | security tag → global 层 high（团队 deposit 规则自动路由）；修复模式 → project 层 pitfall；**未过 `.sec_ok` 不关单** | — |

## 硬性约束

- **独立 intake**：本流不吃开发团队的交付物；与开发团队只在三个衔接面碰（见 `examples/teams/vuln-response.md`）
- 修复阶段 dev 严守 dev-red-green 的「卡住即停/写域/不动 .git」
- 复验证据唯一：重跑命令 + 输出，「应该修好了」不算
- 待证漏洞不许静默丢弃——要么升级用户，要么记录保留

## 被谁引用

- 团队绑定：`examples/teams/vuln-response.md`（正文工作流表按本单元展开）
