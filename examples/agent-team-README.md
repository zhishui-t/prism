# Examples —— 交付团队（delivery）协作编排配置

本目录是 Prism 交付团队（delivery）的协作编排示例：**一份团队定义 + 六个角色契约**。
组队技能（队长手册）已并入 **prism 内置技能**——`prism skill install prism`（或 `prism init`）
装出的 `prism` 技能自带《Prism Agent Team》手册（`references/agent-team.md`）与配套件
（澄清/派发/异常细则、任务书与登记表模板、DAG 脚本），源头在
`packages/skills/src/builtin/assets/agent-team/`，不再放在本目录。

组合起来，把「主会话当队长 + 子智能体流水线」的交付流程跑通（需求定稿 → 组队 →
设计审核 → 开发 → 检视 → 双路测试 → 验收，用户卡点拍板，DAG 可视化，断点可恢复）。

## 目录

| 路径 | 内容 | 装配到 |
| :--- | :--- | :--- |
| `teams/delivery.md` | 交付团队定义：7 编制（dev×2 / frontend-dev / tester-whitebox / tester-blackbox / reviewer / junior-dev）、9 阶段工作流、派发约定（按独立性分桶 + 实例复用登记）、前端三技能流水线、双路测试流水线、门禁；frontmatter `skills: [prism]` 绑定队长手册并声明「严格执行」 | `~/.zcode/teams/delivery/AGENTS.md`（或宿主 teams 目录） |
| `roles/` | 六个角色契约文件（全部宿主原生执行，不经外部引擎） | `~/.zcode/agents/`（或宿主 roles 目录） |

## 角色一览

| 角色 | 执行 | 职责 |
| :--- | :--- | :--- |
| dev | ZCode 原生（GLM-5.3 · max） | 核心编码：功能实现、缺陷修复、重构；先让测试红再让测试绿 |
| frontend-dev | ZCode 原生（· high） | 界面任务；三段设计流水线 frontend-design 定方向 → baoyu-design 制作 → design-taste-frontend 抛光 |
| reviewer | ZCode 原生（· max，独立实例） | 设计审核 + 代码检视；签核即担责 |
| tester-whitebox | ZCode 原生 | 白盒路：需求↔代码对账（spec-vs-impl-checker）、单元/集成/契约测试 |
| tester-blackbox | ZCode 原生（多模态） | 黑盒路：可测化（spec-verify）、功能路径、E2E 截图（playwright-cli）、视觉审计 |
| junior-dev | ZCode 原生（· max） | 低强度机械任务：文档/打包/部署 |

## 依赖

- **prism 技能**（含 Prism Agent Team 队长手册）：`prism skill install prism`——队长会话需有子智能体派发能力（如 ZCode Task/Agent 工具）
- **tester 双路**依赖技能：spec-vs-impl-checker / spec-verify / playwright-cli /
  e2e-testing / design-consistency-auditor（frontend 三技能：frontend-design / baoyu-design /
  design-taste-frontend）——按需安装到宿主技能目录
- **DAG 可视化**：`node <技能目录>/prism/scripts/dag.mjs <项目目录>` 生成
  `<项目>/.agent-team/dag.html`（脚本随 prism 技能安装）

## 装配（ZCode 宿主为例）

```bash
prism skill install prism                              # 队长手册（含全部配套件）
mkdir -p ~/.zcode/teams/delivery && cp examples/teams/delivery.md ~/.zcode/teams/delivery/AGENTS.md
cp examples/roles/*.md ~/.zcode/agents/
```

装配后新会话生效；对队长说「组队」「开团」「团队协作」，或点名团队「用交付团队」即可触发。

> 注意：团队/角色正文里的技能**绝对路径**（`C:/Users/.../skills/...`）指向编写本示例的
> 机器——子代理按绝对路径自读技能文件，跨机器装配时请把这些路径替换为你的技能目录。

> 角色与团队文件是 Prism 原生形态（frontmatter 白名单 + 正文契约），也可用
> `prism role/team` 系列命令导入管理（`prism team activate delivery` 校验编制与工作流一致性）。
