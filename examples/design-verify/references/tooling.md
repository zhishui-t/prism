# 工具选型 — 本地默认与外部后置

> 选型三条铁律：**同一道门只留一个**（同维度双跑是重复评审不是双保险）；**本地先行**（外部工具是实测更强的升级件，不提前采购）；**三方脚本运行前过目源码**（供应链卫生）。

## 1. 本地默认（零采购，今天可跑）

| 门 | 本地手段 | 说明 |
| :-- | :-- | :-- |
| 第 1 步·机械层 | `scripts/check-anchors.mjs`（本 skill 自带） | 零依赖 node 脚本，语义对齐 @nullius-inverba/claims 的核心子集 |
| 第 1 步·语义层 | **reviewer 角色**（独立实例）或挂 **spec-vs-impl-checker** 技能的实例 | 引文存在 ≠ 断言为真；与作者不同实例是前提 |
| 第 2 步·追溯对账 | **spec-vs-impl-checker**（正向需求↔代码对账）/ **spec-verify**（验收标准→测试） | tester-whitebox 的本职 |
| 第 3 步·红队 | **reviewer 新实例**（只给决策清单不给原文）；可选跨引擎第二意见（如 WorkBuddy 引擎跑同一清单） | 新会话、零继承；跨引擎错误不相关 |
| 第 0 步·事实收集 | 只读子代理（Explore / general-purpose）汇总测试断言 + git log + 运行行为 | 队长执笔蒸馏行为契约 |
| 规格写作（前置） | **spec-writer**（AI 产出规格文档时） | 产出时即要求逐条带 file:line 证据，验证成本减半 |
| 编排（可选外壳） | **agent-team**（delivery 团队卡点③质量审核可挂本 skill） | 本 skill 独立使用也完整自洽 |

## 2. 外部后置（升级件：实测抓到本地漏掉的真问题，才替换对应格）

> 以下信息**核实于 2026-10-23**（npm registry / GitHub / PyPI 实查），装前请自行复核——本项目早有教训：转述里的工具名命中率从不到八成到全对波动，唯一可靠的是装前自己看一眼。

| 工具 | 是什么（核实到的实情） | 替换哪格 | 何时值得 |
| :-- | :-- | :-- | :-- |
| **@nullius-inverba/claims** | Evidence Anchor 确定性检查器（npm，MIT，2026-08 首发，v0.13.0）：开文件、配引文、重跑搜索、比对计数，裁决 FABRICATED / WRONG-LINE / MISSING-FILE / COUNT-MISMATCH | 第 1 步·机械层 | 锚点量大、要多文档批量/审计模式（audit/witness）时；与本 skill 脚本同门，二选一 |
| **gsd-doc-verifier** | open-gsd（Get Shit Done）生态的文档核查 **agent**（对抗性探测，LLM 驱动，非确定性脚本） | 第 1 步·语义层 | 想要成体系的对抗核查时；与 claims 不同门可共存，与 reviewer 实例同门二选一 |
| **cc-sdd** | gotalab 的 SDD harness（requirements→design→tasks 带人工评审门禁，装为 Agent Skills） | 第 4 步·门禁规则 | 借鉴其「需求 ID 必须有设计组件支撑否则门禁不过」的硬规则——**可手工落进 gate.md，不必装全套** |
| **designdoc** | reddishz/designdoc：L0-L6 文档体系 + check_docs.py 机检（编码/状态/引用） | 第 2 步·结构自洽 | **新项目从零起文档体系时**；既有项目改造文档体系不值得（换体系 = 重写文档） |
| **RTMX** | 需求追溯矩阵工具（PyPI，Apache-2.0，**alpha v0.0.7**）：CSV 库 + pytest 标记 + MCP server | 第 2 步·矩阵维护 | 矩阵大到手工/表格维护不动时；注意 alpha 期稳定性与「谁维护 CSV」的人月成本 |
| **absolute-spec** | maddhruv/absolute 技能集：扫码库 → 3-5 问澄清 → 写 spec → 独立评分 → 停止 | 规格写作 | 全新核心功能冷启动；与 spec-writer + reviewer 同门，日常增量不值得跑完整评分链 |
| **wl-skills-design** | @agile-team npm 包：中文产品设计技能包（9 规范 + 9 skills，含集成评审/术语词典/数据库接口联动） | 第 3 步·集成评审 | 产品设计向文档（原型/数据库/接口三方联动）且实测比本地 reviewer 多抓真问题时；偏产品设计，对工程需求文档适配度需实测 |

## 3. 供应链纪律

- 任何三方脚本/npm 包**运行前过目源码**（入口、postinstall、网络调用、文件写点）；MIT/Apache 授权也要看代码，不看牌子
- 外部工具进场的唯一通道：**同一维度打一场比武**——拿一份真实设计文档，本地方案与外部工具各跑一遍，比真问题增量与误报数；外部没有明显多抓到真问题，就不值得为它多维护一条流程
- 工具信息会过期：上表是 2026-10 快照，半年后以「装前自行复核」为准
