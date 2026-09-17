---
team_id: delivery
name: 交付团队
description: 需求→设计→审核→开发→检视→规格验证→测试→验收的完整交付流水线。队长（主会话）主导，子角色按工作流接力。
extends: null
members:
  - role: dev
    count: 2
  - role: frontend-dev
    count: 1
  - role: tester-whitebox
    count: 1
  - role: tester-blackbox
    count: 1
  - role: reviewer
    count: 1
  - role: junior-dev
    count: 1
skills: []
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
arbitration: [requirement, quality, progress]
rework_limit: 2
---

# 交付团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 需求收集 | 队长 | 串行 | 用户输入 + 代码库现状 | 需求要点清单 + 现状摘要（recon.md） | 用户逐条确认需求要点；现状不明未探明不进设计 | 有歧义 → 多维度追问；现状不明 → 并行派 dev 只读探索 |
| 2a | 需求设计 | 队长 | 串行 | 需求要点 + 侦察结论 | 需求设计文档 requirements.md（场景/目标/非目标/业务验收/轨别） | **用户卡点：用户批准需求设计**（2026-09-17 用户定稿） | 有歧义 → 追问用户；被否 → 改需求再呈批 |
| 2b | 软件设计/规格/任务 | 队长 | 串行 | **已批准的** requirements.md | software-design.md（架构/接口/数据/算法）+ spec.md（Given/When/Then）+ tasks.md（回溯 spec）+ api.md（如涉及） | 四份齐、逐条可追溯到 R-编号 | 缺项/断链 → 回 2a || 3 | 设计审核 | reviewer | 串行 | 三份文档 | review-意见清单 | 通过或有条件通过（≤2 轮） | 驳回 → 队长改设计 → 再审（≤2 轮） |
| 4 | 任务分解 | 队长 | 串行 | 已审的四文档 | 任务文档 tasks.md：逐条任务（负责角色/涉及文件/验收标准引用 spec 条目号/依赖关系/轨别） | 每条任务可独立验证且能回溯 spec 条目 | — |
| 5 | 开发+自测 | dev + junior-dev + frontend-dev | 并行 | 任务清单 + 设计文档 | 代码 + 自测报告 | 自测全过 + 编译/构建通过 | 卡住 → 队长拆小或换思路 |
| 6 | 代码检视 | reviewer | 串行 | 代码 diff + 设计文档 | 检视意见清单 | 无 blocker 级问题 | blocker → dev 修复 → 复检 |
| 7 | 规格符合性验证 | tester-whitebox + tester-blackbox | 并行 | 代码 + spec.md + design.md | 需求↔代码对账矩阵（VERIFIED/PARTIAL/MISSING/DEVIATED）+ 有效测试集（spec-verify） | 无 MISSING/DEVIATED（缺口清单交阶段 8 定向补） | 缺口 → dev 修复 → 复验 |
| 8 | 测试 | tester-whitebox + tester-blackbox | 并行 | 代码 + spec.md + 对账矩阵 | 测试报告（含缺陷清单）+ E2E 证据（playwright-cli / e2e-testing）+ 视觉审计（design-consistency-auditor，仅界面任务） | 全项有运行证据 | 缺陷 → dev 修复 → 两路 tester 回归 |
| 9 | 验收 | 队长 | 串行 | 全部产物 | 验收结论 | 用户确认交付 | — |

> **开发阶段分工**：dev ×2 承接核心编码（功能实现、bug 修复、重构）——两个 dev 实例
> 按**任务清单的依赖关系切两条互不冲突的流**（按目录/模块划分写域，避免同文件冲突），
> 各自独立会话并行；frontend-dev 承接**界面类任务**（新页面/组件的视觉设计与实现、
> 界面重设计、视觉打磨），走三段设计流水线（见下「前端三技能组合」）；junior-dev 承接
> 低强度开发任务（文档更新、配置调整、构建脚本、格式化、测试数据准备），并行推进。
> 任务路由：改样式/加页面/视觉问题 → frontend-dev；改逻辑/修 bug → dev；两者都涉及 →
> 拆成两条任务分别派。
> **开工门禁**：dev / frontend-dev 派发时在 prompt 附 `spec-guard` 技能路径
> （`~/.zcode/skills/spec-guard/SKILL.md`），动手前先过它的闭环——读文档、
> 对照 spec、圈定影响面；发现 spec 缺口 → 停下上报队长，不擅自扩范围。

## 需求收集纪律（阶段 1）

需求收集**宁慢勿快**——没搞清楚不动手设计：

- **先摸项目现状**：队长先自评「对项目当前状态的掌握够不够」。不够 → 并行派多个 dev
  按模块切分**只读探索**代码库（目录结构 / 既有实现 / 可复用点 / 已知坑），汇总成
  《现状摘要》落盘 `.agent-team/recon.md`。探索只读，不改任何代码。
- **多维度问询用户**：逐维度把需求问透，至少覆盖——① 功能边界（做什么 / 明确不做什么）
  ② 用户与场景（谁用、嵌在什么流程里）③ 数据与接口（输入输出、上下游依赖）④ 非功能
  （性能 / 安全 / 兼容 / 部署约束）⑤ 验收口径（怎么算做完）。问一轮汇总一轮再问下一
  维度，别一次性甩十个问题。
- **进入设计的门槛**：需求要点清单经用户**逐条确认**（默认无异议 ≠ 确认）才进阶段 2；
  确有未决项要带进设计的，必须用户点头并在 spec.md 标注「待定」。

## 派发约定（会话复用）

### 核心原则：**一条路、一遍活、两级复用、能合并**

**一条路**——有角色归属的任务一律派子代理；**WorkBuddy 系角色的活由子代理直接调
`mcp__wbdy-acp__workbuddy_task` 执行**（内容产出在引擎会话里，子代理只做组装与回收），
队长不绕开子代理另调引擎：

- WorkBuddy 系：**dev / reviewer / frontend-dev**——含前端三段流水线（同一个
  frontend-dev 实例、同一条引擎会话贯穿三段）。
- 宿主原生：tester-whitebox / tester-blackbox / junior-dev。
- 例外：无角色归属的一次性任务，队长可直接调 `workbuddy_task`（用完即弃，不登记）。

**一遍活**——同一件事只执行一遍，**禁止任何双跑**：WorkBuddy 系角色的代码 / 评审结论 /
设计稿一律由引擎会话产出——「子代理先自己扫一遍、审一遍，再让 WorkBuddy 重做一遍」
明令禁止。子代理读产物、确认路径是装载上下文的必要动作，不算重复；内容产出才算。
结论以唯一执行路为准。

**两级复用**——
- **实例级**：同一角色的阶段衔接、修复跟进、复审回归一律 `SendMessage` 续用既有
  子代理实例——不是每棒都新开；
- **引擎级**：派发时把该角色的 `workbuddy_session_id` 写进 prompt（队长从
  `.agent-team/agents-<轮次>.md` 取），子代理定义要求**原样透传**复用、汇报第一行
  写回新 id；实例死亡重建时先接回登记的 session_id 再补「当前状态速览」。只有跨轮次
  或两层都失效才真正新建。

**能合并**——同一角色的多个任务合并成一次派发（prompt 里用编号列表分条）；每次派发
必须**自包含**：文件路径、关键决策、上一步结论摘要；不要「先问一下能不能做」再
「正式派发」——直接一次给全。

### 跨阶段上下文传递

- 设计文档是所有后续阶段的**唯一真相源**——落盘后 dev/tester/reviewer 各自读文件，
  不在 prompt 里重复全文；
- 每个阶段的产物（设计/检视意见/测试报告）写 `.agent-team/<阶段>.md`，下一阶段派发时
  给路径即可；
- 队长维护一份 `context.md`（关键决策 + 当前状态），每次派发附上。

### 实例复用登记（2026-09-17 增补，v7 复盘）

- 队长在黑板维护 `.agent-team/agents-<轮次>.md` 三列表：**角色 → 子代理 agentId → WorkBuddy session_id**；子代理每次汇报 session_id，队长随手更新
- 同一角色的**阶段衔接、修复跟进、复审回归一律 `SendMessage` 续用既有实例**——实例里已有的上下文不重述；只有跨轮次或实例死亡/超时才开新实例
- 实例死亡重建时：先读登记表把 WorkBuddy session_id 接上（引擎级记忆不丢），再补一份「当前状态速览」——v7 曾因实例死亡+无登记，接手代理花整轮侦察才摸清前代理只做了 40%
- 产物文件照旧落盘：文件是跨会话的可靠记忆，实例复用省的是「重读重述」不是「不落盘」

### 效率约定（2026-09-17 增补，v8/v9 复盘——用户批准三条）

**1 · 增量门禁**：
- 开发/检视/修复各棒只跑**受影响范围的定向验证**（改哪包跑哪包的 typecheck + 定向 vitest；
  apps/web 改动 = web typecheck + build + `vitest run apps/web/test`），不跑全量阶梯
- 六级阶梯（typecheck/test/lint/build/e2e/package）**只在白盒终检跑一次**
- reviewer 复检只验证修复项+受影响面，不全面重审

**2 · 风险分级流程**（轨别由队长在任务书标注）：
- **全量轨**（数据丢失/并发/安全/跨包契约改动，默认嫌疑即入）：设计审核 → effort=max
  对抗检视 → 双路测试（v9 的 TrashStore 即此轨）
- **轻量轨**（纯 UI 文案/样式/局部交互小改）：跳过独立设计审核（队长设计 + reviewer
  红线抽查合并为一次检视）；黑盒只测新功能不回归全页；白盒只跑受影响包
- 轻量轮抓到数据级问题 → **立即升级全量轨**并记偏差（轨别误判是教训不是豁免）

**3 · 交付物前移**：对账矩阵骨架、DELIVERY 草稿在开发/测试期并行起草，不等测试全完；
队长非阻塞调度——等待测试结果的时间窗用来写文档/更新 DAG，不空转

> 明确不采纳：并发测试模板前移（用户裁决不加）。

**4 · 提速不减档（2026-09-17 增补，效率约定 v2 修订版——用户裁决：要审核、要做设计、
工作流九阶段不能变）**：
- **九阶段一律保留**：设计→设计审核→开发→检视→规格验证→测试，任何轮次不跳档不合并阶段
- **检视修复合一**：reviewer 对 ≤5 行小修当场自己改（记录进报告），仅 BLOCKER/大改派修
  ——检视阶段不变，砍的是修复循环的派发往返
- **证据瘦身**：黑盒每轮截图上限 8 张（只拍用户新界面）；矩阵与阶梯每轮照做
- **队长非阻塞**：代理后台跑，等待窗口写交付/DAG/下一棒 prompt，不干等
- 提速来源限定：往返次数、证据冗余、等待空转——**绝不来自砍阶段**

## 前端三技能组合（frontend-dev 专属流水线）

frontend-dev 的三个技能**按序组合成一条流水线**，同一任务的三个阶段**复用同一个
WorkBuddy session_id**——方向原样流进制作与抛光，不靠转述。技能文件在宿主磁盘上
（`~/.zcode/skills/<name>/SKILL.md`），prompt 里给**绝对路径**让
WorkBuddy 自己读，不要转述内容。

| 阶段 | 技能 | 做什么 | 产物 |
| :--- | :--- | :--- | :--- |
| 1 定方向 | frontend-design | 读简报推断设计语境，产出差异化设计方向 | 设计简报（色板 hex/字体角色/布局线框/原则），**只出简报不写码** |
| 2 制作 | baoyu-design | 按其方法论实现，**简报即约束** | 可运行的界面代码/原型 |
| 3 抛光 | design-taste-frontend | 以审计者身份过 AI Tells 清单 + Pre-Flight Check | 变更清单（修了什么/为什么/剩余开放项） |

组合规则：

- **串行不跳步**：方向未定不动手（阶段 2 不得先跑）；抛光不改方向（阶段 3 发现方向
  错误 → 停下上报队长，不悄悄重设计）。
- **简报落盘**：阶段 1 的简报写入 `.agent-team/design-brief.md`，阶段 2/3 派发时附
  路径——文件是跨阶段的可靠记忆，也是 reviewer 检视界面的对照物。
- **降级**：小修小补（改间距/补空态/修对齐）直接走阶段 3；纯 bug 修复不走流水线
  （那是 dev 的活）。
- **长任务异步**：阶段 2（制作）预计超 15 分钟时 `async: true` + `workbuddy_task_poll`
  轮询，不同步死等。
- 界面任务进入测试阶段后，tester-blackbox 的截图验收以**设计简报**为视觉基线。

## tester 技能流水线（阶段 7 规格验证 + 阶段 8 测试）

测试由两个专职子智能体**并行承接**：**tester-whitebox**（白盒，面向代码与契约）、
**tester-blackbox**（黑盒，面向需求与用户视角）——独立会话各跑各的，靠产物落盘衔接。
各自挂载的技能与职责**已内置在子智能体定义里**（`~/.zcode/agents/tester-whitebox.md`、
`tester-blackbox.md`），派发时只需给阶段产物路径与任务范围，不必转述技能内容。

| 步骤 | 承接 | 技能 | 做什么 | 产物 |
| :--- | :--- | :--- | :--- | :--- |
| 1 对账 | tester-whitebox | spec-vs-impl-checker | 需求逐条追溯到代码，查接口契约，报差距 | 缺口矩阵（VERIFIED/PARTIAL/MISSING/DEVIATED） |
| 2 可测化 | tester-blackbox | spec-verify | 把 spec.md 的 Given/When/Then 验收标准变成可运行测试，变异校验防「永远为真」的假测试 | 有效测试集 + 有效性报告 |
| 3 白盒补测 | tester-whitebox | 本职 + 项目测试栈（可请 dev 协助单测） | 基于对账矩阵补单元/集成、分支与边界、接口契约测试 | 白盒测试证据 |
| 4 黑盒补测 + E2E | tester-blackbox | 本职 + playwright-cli（Web）/ e2e-testing（Flutter/RN/iOS/Android 等） | 基于需求的功能路径、异常与边界输入 + E2E 关键流程 | 黑盒测试证据 + E2E 证据（截图/日志） |
| 5 视觉一致性 | tester-blackbox | design-consistency-auditor | 审计间距/颜色/圆角/组件是否偏离设计系统与设计简报 | 视觉审计清单 |

步骤 1+2 属**阶段 7**（规格符合性验证，白盒对账 ∥ 黑盒可测化，两路并行），防止「测试全绿
但需求做偏」；步骤 3+4+5 属**阶段 8**（测试，白盒路 ∥ 黑盒路），两路派发都附
阶段 7 产物路径，只补缺口不重复全量。

组合规则：

- **两路并行不合并**：派发约定「能合并」（同角色多任务合并）**不适用**于两路测试——
  它们是并行承接的两路，各派一个子智能体、各自自包含（阶段产物路径 + 任务范围）。whitebox 只管代码
  侧（对账、白盒、契约），blackbox 只管需求侧（可测化、黑盒、E2E、视觉）；交叉发现的
  缺陷统一记入缺陷清单回流 dev，不私下转派。
- **平台路由**：Web 项目 E2E 用 `playwright-cli`；Flutter / React Native / iOS / Android
  等用 `e2e-testing`——它需要宿主 flutter-skill MCP server 才能驱动真机/模拟器，未装
  则该步降级为「记录未覆盖原因」并上报队长，不静默跳过。
- **视觉基线**：界面类任务以 `.agent-team/design-brief.md` 为视觉基线；纯后端/无界面
  变更的任务 blackbox 跳过步骤 5（步骤 4 视变更范围取舍），跳过要在测试报告里写明原因。
- **产物落盘与合并**：whitebox 写 `.agent-team/spec-verify-matrix.md`（阶段 7）+
  `.agent-team/test-report-whitebox.md`（阶段 8）；blackbox 写 `.agent-team/spec-verify-tests.md`
  （阶段 7）+ `.agent-team/test-report-blackbox.md` + `e2e-evidence/` +
  `visual-audit.md`（阶段 8）；队长把两路合并成 `.agent-team/test-report.md` 供验收
  阶段（阶段 9）使用。
- **回流**：MISSING/DEVIATED → dev 修复 → 复验（计入 rework_limit）；实现正确但 spec
  写错 → 上报队长裁决改 spec 并留痕，不悄悄改需求文档。


## 卡点口径（2026-09-17 用户裁决）

- 需求卡点保留：requirements.md 呈用户批准后才出下游文档
- **卡点③（设计确认）已取消**：设计审核门禁（.design_ok）通过即进开发，不再呈用户确认设计
- 交付验收卡点保留

## 门禁

- 设计审核不过 → 不进开发（最多 2 轮，超过由队长裁决）
- 代码检视有 blocker → 不进规格符合性验证
- 规格符合性验证有 MISSING/DEVIATED → 不进测试
- 测试有未修缺陷 → 不进验收
- E2E 关键流程未跑通 → 不进验收（Web 用 playwright-cli，App 用 e2e-testing；纯后端/无界面变更需用户同意豁免，豁免原因记入测试报告）
- 验收不通过 → 队长决定返工范围（≤ rework_limit 轮）
