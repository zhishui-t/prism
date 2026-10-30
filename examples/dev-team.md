# 推荐开发团队工作流（dev-team playbook）

> 这是「拿来就用」的推荐配置：**用什么工具、每个角色挂什么技能、多 agent 怎么调度、谁在哪个阶段参与**，一套放好。
> 配套文件：团队定义 `teams/delivery.md`（严格模式）· 角色工作流单元 `workflows/` · 操作细则在 prism 技能的 agent-team 队长手册（触发词「组队 / 开团 / 点名团队」）。
> 全景图（多团队衔接、工件链、路由表）见 `pipeline.md`——本文只回答「一个开发团队怎么跑」。

## 0. 怎么启动

对宿主 agent（ZCode）说一句话：

```
用 delivery 团队严格模式做 <需求一句话>
```

这会触发 prism 技能 → 队长读 agent-team 手册 → 按四卡点走：需求定稿 → 花名册批准 → 设计确认 → 交付验收。
「严格模式」= 编制/工作流/门禁照 `teams/delivery.md` 原样执行，不增删改编。

## 1. 推荐编制与装配（一张表）

| 岗位 | 角色 | ×N | 怎么派（ZCode） | 挂载技能 | 挂载工作流单元 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 队长 | 主会话（你 + 宿主 agent） | 1 | — | `prism`（技能本体） | — |
| 开发 | `dev` | 2 | 子代理 `subagent_type: dev` | `spec-guard` | `dev-red-green` |
| 前端 | `frontend-dev` | 1 | 子代理 `subagent_type: frontend-dev` | `frontend-design`、`baoyu-design`、`design-taste-frontend` | `frontend-pipeline` |
| 杂务 | `junior-dev` | 1 | 子代理（按需，小事可不派） | —（照章办事，方法论在正文） | — |
| 审核 | `reviewer` | 1 | 子代理 `subagent_type: reviewer` | —（审核方法论在正文） | — |
| 白盒测试 | `tester-whitebox` | 1 | 子代理 `subagent_type: tester-whitebox` | `spec-vs-impl-checker`、`spec-verify` | `tester-dual-track`（白盒路） |
| 黑盒测试 | `tester-blackbox` | 1 | 子代理 `subagent_type: tester-blackbox` | `spec-verify`、`e2e-testing`、`playwright-cli`、`design-consistency-auditor` | `tester-dual-track`（黑盒路） |

技能与工作流的挂载写在各角色文件（`roles/*.md`）的「能力（Skill 白名单）」「工作流绑定」节——
控制台角色页可见，`prism_role_get` / `prism_skill_effective` 可核。**成员子代理不需要装 prism**：
队长派发时把工作流单元文件路径附进 prompt，成员自己读文件干活。

### 工具面（谁用什么）

| 谁 | 工具 |
| :-- | :-- |
| 队长 | ZCode 的 Agent 派发与 `SendMessage`（实例复用）· prism 技能（agent-team 手册）· MCP：`prism_team_activate`（装配）、`prism_team_runtime`（调度实况/缺口/交付门禁）、`prism_kb_*`（知识检索沉淀）、`prism_graph_*`（代码图谱/影响面）· `scripts/dag.mjs`（任务图） |
| 成员（dev / tester / reviewer…） | 本职工具（读写代码、跑测试、浏览器）+ 黑板文件（`.agent-team/<run>/`）读写。**没有团队协调工具**——一切交接靠文件，汇报落黑板，不许直接找别的角色聊天 |

## 2. 多 agent 调度协议（怎么跑起来不乱）

队长是唯一调度者（Prism 只提供定义与看板，不代调度——控制面红线）。六条纪律：

1. **四卡点强制**：需求不定稿不组队（①）；花名册不批不开工（②）；设计未经用户确认不写码（③）；交付不验收不收工（④）。
2. **任务分桶再派**：按「独立性 × 写域」分桶——独立任务拆开**并行**派（同角色多实例各接一桶：dev×2 按目录/模块切写域），只有同域小修才合并。写域重叠的桶必须加依赖串行化。
3. **任务单六要素，缺一不派**：目标 / 写域 / 验收标准 / 上下文 / 依赖 / 完成动作；粒度上限「单实例一次会话可完成」。
4. **任务契约可机械核**：`dag.json` 节点带 `kind / objective / acceptance / inScope / verify`，完成回填 `acceptanceResults / commandsRun / changedPaths`——`prism_team_runtime` 会当场报「标完成但没证据 / 改了写域外文件 / 并行写域冲突」。
5. **会话复用（一角色一实例）**：同一角色的后续跟进一律 `SendMessage` 给既有 agentId，**不许每棒新开**；实例「完成 ≠ 关闭」，已完成的仍可唤醒续用。登记在 `.agent-team/<run>/agents.md`。
6. **黑板按任务分目录**：`.agent-team/<run>/`（如 `20261029-ocr-fix`）——同项目并行两个任务互不覆盖；状态只认三件套（`context.md` 断点快照 / `agents.md` 登记 / `dag.json` 任务态），上下文压缩后按三件套恢复，不凭记忆。

**监控**：控制台「团队 → 运行时」看板（或 `prism_team_runtime`）——任务四态、**可派发集**（依赖就绪、现在该派谁）、会话登记对账、缺口清单、交付门禁（全部完成 + 审核 pass + 无失败才能交付）。

## 3. 阶段参与矩阵（十阶段，谁干什么怎么派）

| # | 阶段 | 参与 | 派发形态 |
| :-- | :-- | :-- | :-- |
| 1 | 需求收集 | 队长（+ 用户） | 现状不明 → 并行派 **dev 只读探索**（不出现在写域，只产侦察笔记） |
| 2 | 需求设计 | 队长 | 队长执笔 → **用户卡点：批准需求设计** |
| 3 | 软件设计/规格/任务 | 队长 | 四文档（software-design / spec / tasks / api）；大需求可先走 `workflows/design-verify-flow.md`（开发前验证） |
| 4 | 设计审核 | **reviewer** | 独立实例审文档 → `.design_ok` 门禁；驳回回 2（≤2 轮） |
| 5 | 任务分解 | 队长 | 逐条任务（负责角色/涉及文件/验收引用 spec 条目/依赖/写域）+ 分桶 → 建本任务 run 目录的 `dag.json` |
| 6 | 开发+自测 | **dev×2 + frontend-dev**（+ junior-dev） | **并行**：按桶各接一条流，写域互斥；每人按自己的工作流单元走（dev 按 `dev-red-green`：先红后绿、小步验证） |
| 7 | 代码检视 | **reviewer** | `SendMessage` 复用阶段 4 的实例（带着文档上下文审代码）→ blocker 当场小修（≤5 行）或退 dev |
| 8 | 规格符合性验证 | **tester-whitebox + tester-blackbox** | **并行双路**：白盒做需求↔代码对账矩阵（spec-vs-impl-checker）；黑盒产有效测试集（spec-verify） |
| 9 | 测试 | **tester-whitebox + tester-blackbox** | 白盒回归 + 黑盒 E2E（playwright-cli / e2e-testing）+ 界面任务视觉审计（design-consistency-auditor）；缺陷 → dev 修复 → 两路回归 |
| 10 | 验收 | 队长（+ 用户） | 全部产物过交付门禁 → `DELIVERY.md` → **用户确认交付** |

门禁文件（谁执笔谁负责）：`.design_ok`（reviewer，阶段 4）· `.code_ok`（reviewer，阶段 7）· `.qa_ok`（tester，阶段 9）。
返工上限 2 轮，超限走三出口：降范围 / 记技术债 / 请示用户。

## 4. 产物与交付件（每阶段落什么、最终交什么）

**落点约定**：过程产物全部落 `.agent-team/<run>/`（**文件落盘 = 交接完成**）；代码改动落仓库本身。
多轮修订加 `-vN` 后缀（如 `design-v3.md`）；模板在 prism 技能配套件（`agent-team/templates/`）。

| 阶段 | 产物 | 谁产 | 落点 |
| :-- | :-- | :-- | :-- |
| 1 | `task-brief.md`（任务书）· `recon.md`（现状侦察） | 队长 · dev（只读探索） | run 目录 |
| 2 | `requirements.md`（需求设计） | 队长 | run 目录 |
| 3 | `software-design.md` · `spec.md` · `api.md`（如涉及） | 队长 | run 目录 |
| 4 | `design-review.md` + **`.design_ok`** | reviewer | run 目录 |
| 5 | `tasks.md`（任务卡定稿）· `dag.json` · `team-manifest.md` | 队长 | run 目录 |
| 6 | 代码 diff · 自测报告（命令+结果）· 改动文件清单（逐文件：改了什么/为什么） | dev×2 · frontend-dev | 仓库 · run 目录 |
| 7 | `code-review.md` + **`.code_ok`** | reviewer | run 目录 |
| 8 | `spec-verify-matrix.md`（需求↔代码对账）· `spec-verify-tests.md`（有效测试集） | 双 tester | run 目录 |
| 9 | `test-report.md`（双路合并）· `e2e-evidence/` · `visual-audit.md`（界面任务）+ **`.qa_ok`** | 双 tester | run 目录 |
| 10 | `DELIVERY.md` · `agents.md`（终版会话登记） | 队长 | run 目录 |

### 交付件（阶段 10 用户拿到的一揽子）

1. **`DELIVERY.md` 交付报告**——做了什么 / 怎么验的 / 遗留问题与后续建议
2. **代码改动清单**——仓库 diff + 逐文件「改了什么、为什么」
3. **验证证据包**——自测报告（命令+结果）、双路 test-report、E2E 证据、视觉审计（界面任务）
4. **规格对账**——`spec-verify-matrix.md`（每条需求 VERIFIED / PARTIAL / MISSING / DEVIATED）
5. **门禁文件**——`.design_ok` / `.code_ok` / `.qa_ok`（谁执笔谁负责，缺失 = 对应环节重跑）
6. **断点续接材料**——`context.md` + `agents.md` + `dag.json`（下轮恢复不重新侦察）

**交付门禁（机械判定，不看叙述）**：`prism_team_runtime` 的 `deliveryGate` = 全部任务完成 +
审核全 pass + 无失败任务；任务带契约字段时另核验收证据 / 验证命令 / 写域审计。门禁不过不进阶段 10。

> 完整工件链（跨团队产消关系、design-verify / vuln-response 的工件）见 `pipeline.md` §5 注册表。

## 5. 什么时候不用这套

- **小改动/单文件修复**：不组队，主会话直接干（走 `pipeline.md` §4 的轻路径）。
- **纯安全审计/漏洞处置**：用 `teams/vuln-response.md`（独立 intake，不占开发团队）。
- **纯界面抛光**：只派 frontend-dev 单实例（其工作流单元自带三段流水线）。

## 6. 引用索引

| 要看什么 | 去哪 |
| :-- | :-- |
| 端到端全景（多团队、工件链、路由） | `pipeline.md` |
| 团队定义（严格模式的十阶段原文） | `teams/delivery.md` |
| 角色定义（含技能/工作流挂载） | `roles/*.md` |
| 工作流单元（每角色的操作手册） | `workflows/`（README 有选型索引） |
| 队长操作细则（派遣模板/恢复/纪律） | prism 技能 → `references/agent-team.md` |
| 运行时看板与任务契约字段 | 控制台「团队 → 运行时」；`prism_team_runtime` |
| 工件模板（任务书/登记表/交付报告） | prism 技能配套件 `agent-team/templates/` |
