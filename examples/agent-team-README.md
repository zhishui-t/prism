# Examples —— agent-team 协作编排全套配置

本目录是 Prism 交付团队（delivery）的完整协作编排示例：**一个组队技能 + 一份团队定义 + 六个角色契约**。
它们组合起来，把「主会话当队长 + 子智能体流水线」的交付流程跑通（需求定稿 → 组队 → 设计审核 →
开发 → 检视 → 双路测试 → 验收，四卡点拍板，DAG 可视化，断点可恢复）。

## 目录

| 路径 | 内容 | 装配到 |
| :--- | :--- | :--- |
| `agent-team/` | agent-team 技能（队长手册：六阶段流水线、四卡点、文件黑板、DAG 脚本） | `<技能目录>/agent-team/`（如 `~/.agents/skills/` 或 `~/.zcode/skills/`） |
| `teams/delivery.md` | 交付团队定义：7 编制（dev×2 / frontend-dev / tester-whitebox / tester-blackbox / reviewer / junior-dev）、9 阶段工作流、派发约定（会话复用+实例复用登记）、前端三技能流水线、双路测试流水线、门禁 | `~/.zcode/teams/delivery/AGENTS.md`（或宿主 teams 目录） |
| `roles/` | 六个角色契约文件 | `~/.zcode/agents/`（或宿主 roles 目录） |

## 角色一览

| 角色 | 执行 | 职责 |
| :--- | :--- | :--- |
| dev | ZCode 原生（GLM-5.3 · max） | 核心编码：功能实现、缺陷修复、重构；先让测试红再让测试绿 |
| frontend-dev | ZCode 原生（· high） | 界面任务；三段设计流水线 frontend-design 定方向 → baoyu-design 制作 → design-taste-frontend 抛光 |
| reviewer | ZCode 原生（· max，独立实例） | 设计审核 + 代码检视；签核即担责 |
| tester-whitebox | ZCode 原生 | 白盒路：需求↔代码对账（spec-vs-impl-checker）、单元/集成/契约测试 |
| tester-blackbox | ZCode 原生（多模态） | 黑盒路：可测化（spec-verify）、功能路径、E2E 截图（playwright-cli）、视觉审计 |
| junior-dev | ZCode 原生（· max） | 低强度机械任务：文档/打包/部署 |

> 2026-10-22 起**全部角色宿主原生执行**（自己读码、自己写、自己验证），不经 WorkBuddy
> 等外部引擎——原先的 wbdy-acp 中继、引擎会话复用（session_id 登记/透传）、异步轮询
> 纪律已全部移除；会话复用收敛为实例级（`SendMessage` 续用既有子代理，黑板文件恢复上下文）。
> 团队定义 frontmatter 声明 `skills: [agent-team]` 并在正文声明「**严格执行**」：启用
> delivery 时编制/工作流/门禁/卡点口径照团队定义原样执行，skill 只贡献操作手法
> （澄清协议、黑板、登记、DAG、恢复），不合并改编、不增减编制。

## 依赖

- **agent-team 技能**依赖队长会话有子智能体派发能力（如 ZCode Task/Agent 工具）
- **tester 双路**依赖技能：spec-vs-impl-checker / spec-verify / playwright-cli /
  e2e-testing / design-consistency-auditor（frontend 三技能：frontend-design / baoyu-design /
  design-taste-frontend）——按需安装到宿主技能目录
- **DAG 可视化**：`node examples/agent-team/scripts/dag.mjs <项目目录>` 生成
  `<项目>/.agent-team/dag.html`

## 装配（ZCode 宿主为例）

```bash
cp -r examples/agent-team ~/.agents/skills/agent-team      # 或 ~/.zcode/skills/
mkdir -p ~/.zcode/teams/delivery && cp examples/teams/delivery.md ~/.zcode/teams/delivery/AGENTS.md
cp examples/roles/*.md ~/.zcode/agents/
```

装配后新会话生效；对队长说「组队」「开团」「团队协作」，或点名团队「用交付团队」即可触发。

> 注意：团队/角色正文里的技能**绝对路径**（`C:/Users/.../skills/...`）指向编写本示例的
> 机器——子代理按绝对路径自读技能文件，跨机器装配时请把这些路径替换为你的技能目录。

> 角色与团队文件是 Prism 原生形态（frontmatter 白名单 + 正文契约），也可用
> `prism role/team` 系列命令导入管理（`prism team activate delivery` 校验编制与工作流一致性）。
