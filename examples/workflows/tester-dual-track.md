---
workflow: tester-dual-track
name: 测试双路五步
level: role
binds: [tester-whitebox, tester-blackbox]
skills: [spec-vs-impl-checker, spec-verify, playwright-cli, e2e-testing, design-consistency-auditor]
---

# 测试双路五步（tester-dual-track）

> 白盒（面向代码与契约）∥ 黑盒（面向需求与用户视角）两路独立会话并行，靠产物落盘衔接。防「测试全绿但需求做偏」，也防「测试本身是假的绿」。

## 步骤表

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 需求对账 | tester-whitebox | spec-vs-impl-checker | spec.md + software-design.md + 代码 | `.agent-team/spec-verify-matrix.md`（每条需求带代码与测试**两行证据**） | 缺口矩阵四态（VERIFIED/PARTIAL/MISSING/DEVIATED）全覆盖；无证据处显式标 UNTESTED，**不许留白** | MISSING/DEVIATED → dev 修复 → 复验（计 rework） |
| 2 | 可测化 | tester-blackbox | spec-verify | spec.md（Given/When/Then） | `.agent-team/spec-verify-tests.md` | **变异校验**不过关的测试视为无效——「永远为真」的假测试不算数 | — |
| 3 | 白盒补测 | tester-whitebox | 本职 + 项目测试栈 | 对账矩阵 + 代码 | `.agent-team/test-report-whitebox.md` | 缺口定向补：单元/集成、分支与边界、接口契约；单测量大可请 dev 协助 | 缺陷入清单回流 dev |
| 4 | 黑盒补测 + E2E | tester-blackbox | playwright-cli（Web）/ e2e-testing（App） | spec-verify-tests.md + 代码 | `.agent-team/test-report-blackbox.md` + `e2e-evidence/` | **截图与日志是唯一证据，推断不算**；平台未适配不许静默跳过——记录未覆盖原因并上报 | 缺陷入清单回流 dev；两路 tester 回归 |
| 5 | 视觉一致性 | tester-blackbox | design-consistency-auditor | design-brief.md（视觉基线）+ 界面 | `.agent-team/visual-audit.md` | 间距/颜色/圆角/组件不偏离设计系统与简报；纯后端任务跳过但**写明原因** | 违规项回流 frontend-dev 阶段 3 |

## 硬性约束

- **两路并行不合并**：各派一个子代理、各自自包含（产物路径 + 任务范围）；whitebox 只管代码侧，blackbox 只管需求侧；交叉发现的缺陷统一记缺陷清单回流 dev，不私下转派
- **防假绿三闸**：变异校验（步骤 2）｜ UNTESTED 不许留白（步骤 1）｜ 证据唯一=截图/日志（步骤 4）——外加「没有运行证据的通过等于造假」的兜底契约
- 步骤 1+2 属规格符合性验证（并行），3+4+5 属测试（并行）；两路报告由队长合并成 `test-report.md` 供验收
- **平台路由**：Web E2E 用 playwright-cli；Flutter/RN/iOS/Android 用 e2e-testing（需 flutter-skill MCP，未装则降级记录并上报，不静默跳过）
- 实现正确但 spec 写错 → 上报队长裁决改 spec 并留痕，不悄悄改需求文档

## 被谁引用

- 角色绑定：`examples/roles/tester-whitebox.md`、`examples/roles/tester-blackbox.md`
- 团队引用：delivery 阶段 7（步骤 1+2）与阶段 8（步骤 3+4+5，以其团队定义口径为准）
