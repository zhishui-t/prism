# Pipeline —— 端到端总图与团队组合总纲

> 回答三个问题：**一套流程从头到尾怎么走**（主干地图）、**东西怎么衔接**（工件链注册表 + 团队三衔接面）、
> **什么时候走重什么时候走轻**（统一路由表）。本文是 examples 的组合总纲——各 skill、团队定义、
> 工作流单元是真相源，本文做映射与索引，冲突时以「严格执行」团队定义为准。

## 1. 五层组合模型

```
记忆层    Prism KB（global / project / role 三层）——跨团队跨轮次的唯一共享记忆
          开工装载 prism_context_pack（按角色知识绑定）｜验收沉淀 prism_kb_deposit（按团队 deposit 规则）
能力层    skill —— 干什么（能力载体，挂在角色白名单或团队 frontmatter）
工作流层  workflow —— 怎么干（过程单元，可复用；examples/workflows/）
          角色级：绑定单一角色（前端三段 / 测试双路五步 / 开发先红后绿 / 安全审计 / 设计验证六步）
          团队级：编排角色的阶段表，阶段里用「引用:」语法调角色级单元
契约层    角色声明「本角色工作流」；团队 = 编制 + 工作流 + 门禁 + 沉淀规则 + 仲裁链
实例层    agent-team 队长手册执行：派发只给文件路径（任务卡/工作流/黑板），子代理自己读，不转述
```

**接口只有两种：工件（文件）和门禁（带完成判定的工件）。** 会话永不跨角色堆叠上下文、永不跨团队共享——一切交接走文件。

## 2. 多团队模型：独立单元 + 三个衔接面

团队是**独立单元，各有自己的输入源**，不是流水线上游下游：

| 团队 | intake（输入源） | 黑板 | 产出门禁 |
| :-- | :-- | :-- | :-- |
| 交付团队（delivery） | 用户需求 | `.agent-team/` | `.design_ok` / `.code_ok` / 验收 |
| 漏洞响应（vuln-response） | 漏洞报告 / 扫描结果 / 用户通报——**不是**开发团队的输出 | `.vuln/` | `.sec_ok` |
| 未来的安全 / 独立测试团队 | 各自的审计请求 / 任意团队的交付物 | 自定 | 自定 |

独立团队之间只有三个衔接面：

1. **工件面**（需要协作时）：共享工件命名与黑板约定。例：漏洞团队的问题条目 → 开发团队任务卡（六要素）；各自黑板留痕，靠文件交接。
2. **知识面**（常态，最重要）：任何团队沉淀的知识进 KB——漏洞团队关单沉淀 security 规则（deposit 规则自动路由 global 层 high），开发团队任何角色开工 `context_pack` 装载 global 层即获得。**上一轮的教训自动变成下一轮的防线，无需任何人通知。**
3. **门禁面**（交接时）：A 团队产物被 B 团队消费，必须带可核对门禁（完成判定 + 证据）。例：审计开发交付物前核对其 `.design_ok` / `.code_ok` / `test-report.md` 存在且通过——门禁缺失 = 材料不齐，退回不猜。

## 3. 主干地图（单需求全流程）

```
用户 ──需求──▶ ①需求澄清（卡点① 任务书定稿）
                    │
              ②设计文档开发前验证（design-verify 六步，gate.md = Go 才放行）
                    │  gate.md + trace-matrix.md 并入 .agent-team/（.design_ok 证据链）
              ③交付流水线（delivery 十阶段：2需求设计→3四文档→4设计审核→5任务分解
                    │  →5开发自测→6代码检视→7规格验证→8双路测试→9验收）
              ④交付验收（卡点④）──▶ 沉淀进 KB，关单
```

| 段 | 谁执行 | 工作流 | 输入工件 | 输出工件 | 完成判定 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| ① 需求澄清 | 队长 + 用户 | agent-team 澄清协议 | 用户输入 + recon.md | task-brief.md | **卡点①**：用户批准 |
| ② 验证设计 | 队长指挥 + 独立实例 + 人 | `workflows/design-verify-flow.md`（载体=design-verify skill） | 设计文档 + 代码库 | behavior-contract / anchors / verdict / trace-matrix / redteam-report / **gate.md** | gate.md 三态签署（人签） |
| ③ 实现 | delivery 团队 | delivery 十阶段（团队定义）+ 阶段 6 挂角色级单元 | gate.md=Go + trace-matrix | 四文档 / 代码 / 检视 / 对账矩阵 / test-report | 十阶段门禁逐个过 |
| ④ 验收沉淀 | 队长 + 用户 + 全员 | agent-team 交付协议 | 全部产物 | DELIVERY.md + KB 条目 | **卡点④**：用户验收；按 deposit 规则沉淀 |

**②→③ 的关键交接**（这是两套流程缝合的针脚）：

- trace-matrix 每个闭环行 → tasks.md 任务卡种子（六要素：目标 / 写域 / 验收标准=spec 条目 / 上下文 / 依赖 / 完成动作）
- 六类缺口 ①③④ → 补齐任务（先补文档再开发）；② → 裁范围回需求；⑤ → 修死测试；⑥ → backlog 不堵
- **开发完成后锚点 `--only` 定向复验 = 「代码符合设计」的机械证据**（与阶段 7 对账矩阵互为印证）

## 4. 统一路由表（什么时候走重，什么时候走轻）

**需求级**（进不进 design-verify 全流程，design-verify 口径）：

| 路径 | 触发条件 | 跑什么 |
| :-- | :-- | :-- |
| 全流程 | 新子系统 / 数据迁移 / 破坏性接口变更 / 核心交易链路 / **接手后第一份设计文档** | 第 0→5 步全跑 |
| 轻量 | 日常增量 / 非核心模块 / 局部重构 | 第 1 步（锚点核查+质检点）+ 第 4 步（简化门禁） |

**任务级**（开发期每个任务的轨别，delivery 口径）：

| 轨别 | 触发条件（默认嫌疑即入全量轨） | 待遇 |
| :-- | :-- | :-- |
| 全量轨 | 数据丢失 / 并发 / 安全 / 跨包契约改动 | 设计审核 → 对抗检视 → 双路测试 |
| 轻量轨 | 纯 UI 文案 / 样式 / 局部交互小改 | 合并检视（队长设计+reviewer 红线抽查）；黑盒只测新功能；白盒只跑受影响包 |

**升级规则**：轻量轮抓到数据级问题 → **立即升级全量轨**并记偏差（轨别误判是教训不是豁免）。

**效率纪律**（对全轨适用，摘自 delivery 效率约定）：增量门禁（改哪包跑哪包，六级阶梯只在白盒终检跑一次）；交付物前移（对账矩阵、DELIVERY 草稿并行起草）；队长非阻塞（等待窗口写文档/备下一棒）；提速来源限定往返次数、证据冗余、等待空转——**绝不来自砍阶段**。

## 5. 工件链注册表（模板衔接的唯一真相）

每个工件登记「谁产 → 谁消费」。模板衔接不靠记忆，靠查这张表。

| 工件 | 产（阶段） | 消费（下游） | 模板 / 规范 | 关联门禁 |
| :-- | :-- | :-- | :-- | :-- |
| task-brief.md | 需求澄清（队长） | 组队 / design-verify 第 0 步 | prism 技能配套件（`packages/skills/src/builtin/assets/agent-team/templates/`） | 卡点① |
| behavior-contract.md | dv 第 0 步 | gate.md；unverified 项 → anchors 重点核查 | `design-verify/templates/behavior-contract.md` | 真相确认或显式降级 |
| anchors.md | dv 第 1 步（图优先 resolve-symbols） | check-anchors 脚本 + 语义层 | `design-verify/templates/anchors.md` | — |
| verdict.md | check-anchors 脚本 | 质检点（人抽 5 条）/ gate.md | 脚本产出 | BLOCKER 清零 |
| semantic-review.md | dv 第 1 步语义层（独立实例） | gate.md | — | 语义层判 FABRICATED 计 BLOCKER |
| trace-matrix.md | dv 第 2 步 | gate.md；**→ tasks.md 任务卡种子** | `design-verify/templates/trace-matrix.md` | 核心链路断头路清零 |
| backlog.md | dv 第 2 步（缺口⑥） | 后续排期（不堵门禁） | — | — |
| redteam-report.md | dv 第 3 步（红队实例） | gate.md；人抽样反证 | `design-verify/templates/redteam-report.md` | P0 有处置 |
| gate.md | dv 第 4 步（**人签**） | 交接 delivery；并入 .design_ok 证据链 | `design-verify/templates/gate-decision.md` | Go / Go with Gaps / No-Go |
| requirements.md | delivery 2（队长） | 3 四文档 / dv 第 2 步矩阵 | 团队定义 | 用户卡点（批准需求设计） |
| software-design.md / spec.md | delivery 2b | reviewer 审 / dev 开工 / tester 对账 / dv 锚点提取源 | 团队定义 | — |
| tasks.md | delivery 4（队长） | dev / junior-dev / frontend-dev 派发 | 团队定义（任务卡六要素） | 每条可独立验证、可回溯 spec 条目 |
| design-review.md | delivery 3 / 6（reviewer） | 队长修订 / dev 修复 | — | .design_ok / .code_ok |
| .design_ok | reviewer（设计审核过） | 开发放行（+gate.md 并入） | — | 写码前置 |
| 自测报告 + 改动清单 | dev（阶段 6，dev-red-green） | 代码检视 | — | 构建+自测过 |
| .code_ok | reviewer（检视无 blocker） | 进规格验证 | — | — |
| spec-verify-matrix.md | tester-whitebox（阶段 8） | 阶段 9 定向补测 / 验收 | — | 无 MISSING/DEVIATED |
| spec-verify-tests.md | tester-blackbox（阶段 8） | 阶段 9 黑盒 | — | 变异校验 |
| test-report-{white,black}box.md → test-report.md | tester×2 → 队长合并 | 验收 | — | 全 F-ID 运行证据 |
| e2e-evidence/ + visual-audit.md | tester-blackbox（阶段 9） | 验收 | — | E2E 关键流程跑通 |
| register.md / sec-report.md / verify-report.md | vuln-response 1-5 | 处置路由 / 关单 | `workflows/vuln-response-flow.md` | .sec_ok 未过不关单 |
| .sec_ok | reviewer（sec-audit 过） | 关单 / 交接开发团队 | `workflows/sec-audit.md` | 红线一票驳回 |
| DELIVERY.md | 队长（交付） | 用户验收 / 下轮接手 | prism 技能配套件（同上 `templates/delivery-report.md`） | 卡点④ |
| context.md / agents.md / dag.json | 队长黑板 | 全员（派发时附） | prism 技能配套件（同上 `templates/`，DAG 脚本 `scripts/dag.mjs`） | 断点恢复依据 |

## 6. 证据链：怎么确保结果是对的，不是忽悠人的

**防假测试三闸**（tester-dual-track 内置）：① 变异校验——「永远为真」的假测试视为无效；② UNTESTED 不许留白——没证据必须显式标注，不许默认「应该没问题」；③ 证据唯一——截图与日志是唯一证据，推断不算；E2E 平台未适配不许静默跳过。

**防假实现对账**：spec-verify-matrix 每条需求带代码与测试**两行证据**，四态（VERIFIED/PARTIAL/MISSING/DEVIATED）不留死角；「代码符合设计」另有 dv 锚点 `--only` 复验做机械印证。

**贯穿原则：验证者也要被验证。** 队长对测试报告按 10% 抽样**亲自复跑命令**（与 design-verify 质检点同源——人抽 5 条锚点、抽测试命令、抽审计复现步骤）；复跑不符 → 该份报告作废重跑并查配置。没有这一条，前面所有闸门都只是工具的自述。

**检视独立性**：reviewer 与实现者不同实例不同上下文；「没发现问题」和「验证了没有问题」必须区分表述——后者才配写进门禁。

## 7. KB 钩子（知识库嵌进流程两端）

| 时机 | 动作 | 工具 |
| :-- | :-- | :-- |
| 任何角色开工前 | 按角色知识绑定装载既有规则与教训（global/project 层） | `prism_context_pack(role, task)` |
| 关键节点（踩坑即沉淀） | 轨别误判、返工根因、平台坑——当场落库，不等收尾 | `prism_kb_deposit`（按团队 deposit 规则路由层与优先级） |
| 验收关单 | 根因与修复模式 → project 层 pitfall；可复用规则 → global 层 | 同上 |
| 跨团队（知识面衔接） | 漏洞团队 security 沉淀 → 开发团队 context_pack 自动装载 | deposit 规则 `tags:[security] → global high` |

团队 frontmatter 声明 `knowledge.layers` 与 `deposit.rules`，钩子按定义走，不靠人记。

## 8. 上下文压缩与恢复（状态在黑板，不在记忆）

队长的对话记忆随时可能被压缩，压缩后的摘要不可信——**一切进行中状态以黑板文件为准**。恢复动作按队长手册（prism 技能 `references/agent-team.md`「会话恢复与上下文压缩」）三步：读黑板 → 重读纪律与流程定义 → 向用户简报断点；**不凭压缩摘要继续派发**。

每条流程的最小状态集（恢复时读这些文件即可机械判定进度）：

| 流程 | 状态载体 | 进度判定 |
| :-- | :-- | :-- |
| design-verify 六步 | `.design-verify/` 各步产物 | 按文件存在与内容判定（状态判定表见其 SKILL.md） |
| delivery 十阶段 | context.md（断点快照）+ dag.json + agents.md + 门禁文件 | dag.json 首个未完成节点 |
| vuln-response | `.vuln/register.md` 状态列 + agents.md + 各阶段产物 | 每漏洞一行，对照 vuln-response-flow 步骤表 |
| 任意 workflows 单元 | 该单元的输出工件 + 所在黑板 | 步骤表「完成判定」列逐行从文件核对 |

**设计约束（写给未来新增工作流单元的人）**：步骤的完成判定必须落盘为可判定的文件状态（工件存在 / 门禁签署 / 状态列值），不得依赖对话记忆——否则压缩即断流。子代理实例各持上下文、不受队长压缩影响；实例死亡也要能从黑板重建（登记表探活 + 最近产物恢复 + 补「当前状态速览」，不重新侦察）。

## 9. 目录与装配索引

| 路径 | 内容 | 装配到 |
| :-- | :-- | :-- |
| `dev-team.md` | **推荐开发团队工作流总纲**（编制/工具/技能挂载/调度协议/阶段参与矩阵——拿来即用） | 文档，不装配 |
| （prism 内置技能） | 队长手册《Prism Agent Team》+ 澄清/派发/异常细则 + 任务书等模板 + DAG 脚本 | `prism skill install prism`——源在 `packages/skills/src/builtin/assets/agent-team/`，不再放 examples |
| `design-verify/` + `design-verify-README.md` | 设计验证 skill（六步 + 3 脚本） | `<技能目录>/design-verify/` |
| `workflows/` | 工作流单元库（本文 §1 的工作流层） | `~/.zcode/workflows/`（或宿主约定目录） |
| `roles/` | 角色契约（**含技能白名单与工作流挂载**——推荐配置见 `dev-team.md` §1） | `~/.zcode/agents/` |
| `teams/` | delivery（严格执行）+ vuln-response（独立 intake 示例） | `~/.zcode/teams/<id>/AGENTS.md` |

> 装配后把角色/团队文件里的 workflows 引用路径改为实际装配位置（同绝对路径提醒）。
