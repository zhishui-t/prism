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

| 角色 | 引擎 | 职责 |
| :--- | :--- | :--- |
| dev | WorkBuddy 中继（DeepSeek V4.1 Flash · high） | 核心编码；WorkBuddy 调用纪律：异步为默认 |
| frontend-dev | WorkBuddy 中继（同上） | 界面任务；三段设计流水线 frontend-design 定方向 → baoyu-design 制作 → design-taste-frontend 抛光 |
| reviewer | WorkBuddy 中继（· **max**，独立视角） | 设计审核 + 代码检视；签核即担责 |
| tester-whitebox | ZCode 原生 | 白盒路：需求↔代码对账（spec-vs-impl-checker）、单元/集成/契约测试 |
| tester-blackbox | ZCode 原生（多模态） | 黑盒路：可测化（spec-verify）、功能路径、E2E 截图（playwright-cli）、视觉审计 |
| junior-dev | ZCode 原生（· max） | 低强度机械任务：文档/打包/部署 |

## 依赖

- **agent-team 技能**依赖队长会话有子智能体派发能力（如 ZCode Task/Agent 工具）
- **WorkBuddy 中继角色**依赖 wbdy-acp MCP（`workbuddy_task` /
  `workbuddy_task_poll` 异步模式）；无此环境时角色仍可用，WorkBuddy 调用按角色文内回落条款降级
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

装配后新会话生效；对队长说「组队」「开团」「团队协作」即可触发 agent-team 技能。

> 注意：角色/团队正文里的技能**绝对路径**（`C:/Users/.../skills/...`）指向编写本示例的机器——
> WorkBuddy 引擎需要绝对路径读技能文件，跨机器装配时请把这些路径替换为你的技能目录。

> 角色与团队文件是 Prism 原生形态（frontmatter 白名单 + 正文契约），也可用
> `prism role/team` 系列命令导入管理（`prism team activate delivery` 校验编制与工作流一致性）。
