# Prism 设计总览（讨论稿 v0.1）

> 状态：**设计讨论收口**
> 日期：2026-09-09
> 说明：本文是所有需求文档的索引与决策汇总。各模块细节见 `doc/requirements/` 对应文件。

---

## 0. 一句话定位

**Prism 是团队的知识与协作控制面**：把规范、红线、架构、代码结构、专家角色组织成可查询、可装配、可审计的资产，通过 MCP/HTTP/文件注入供宿主 agent 使用。**它不执行、不调度、不调 LLM。**

---

## 1. 文档索引

| 文档 | 内容 |
| :--- | :--- |
| `knowledge-base.md` | 知识库：层→书→模块→条目、检索、导入、落库、护栏 |
| `role-definition.md` | 角色定义：决策契约、核心第一原则、白名单、知识绑定 |
| `team-definition.md` | 团队定义：成员引用、固定工作流、沉淀规则、Skill 指定 |
| `harness-adapters.md` | ZCode 适配：原生约定 + Prism 叠加、装配、启用生命周期、model 冲突 |
| `skill-loading.md` | Skill 管理：直接装在宿主 Skill 目录，抽象在代码层 |
| `init-and-registration.md` | 接入初始化：`prism init` 注册 MCP + 复制 Skill |
| `prism-skill.md` | Prism 自身 Skill：装配器 + 使用入口 |
| `knowledge-injection.md` | 注入：MCP 拉取 / 上下文包 / AGENTS.md 静态注入 |
| `deployment-model.md` | 部署：多 harness（内置+运行期插件）/ 单激活、多会话共享、WAL 并发 |
| `code-graph.md` | 代码图谱：用 Graphify 工具/页面，产物放项目根 |
| ~~`work-queue.md`~~ | **已废弃**（工作队列移除；富化改宿主直付，见该文顶部） |
| `task-center.md` | 任务中心：被动台账、依赖图、回报协议 |
| `cli-mcp-surface.md` | CLI 与 MCP 完整命令面 |
| `model-negotiation.md` | 边界声明：Prism 不参与子 agent 管理与模型选择 |

---

## 2. 核心决策汇总

### 2.1 定位与边界

| # | 决策 |
| :--- | :--- |
| 1 | **纯控制面**：不侵入宿主 agent 调度 |
| 2 | **不调 LLM**：LLM 工作经工作队列委派宿主 |
| 3 | **不参与子 agent 管理**：各 harness 管理方式不同，不猜 |
| 4 | **只接受宿主推来的信息**，不主动伸手拉 |
| 5 | **编译期支持多 harness，运行期只服务一个**（单实例服务该 harness 的多个会话） |

### 2.2 知识库

| # | 决策 |
| :--- | :--- |
| 6 | 内容模型：**层→书→模块→条目**，每层各带总纲/知识图谱/架构图谱/规则 |
| 7 | 设计公理：**分类分层给定位、图谱联系给发现**（单一边表 + 多视图） |
| 8 | 三层：**global / project / role**（不含 instance） |
| 9 | 存储：**文件为真相、数据库为索引**；存 `<PRISM_HOME>/knowledge/` |
| 10 | 检索：**bigram 切分 + unicode61**（trigram 检索不了两字中文词） |
| 11 | 版次制：更新产生新版次；**检索默认只返回最新版** |
| 12 | 落库：**Prism 不审核**，宿主说落就落；沉淀规则写团队定义 |
| 13 | 模块划分：**社区发现自动建议 + 人工固化** |
| 14 | 层间冲突：就近覆盖 + 显式 `overrides` |

### 2.3 角色与团队

| # | 决策 |
| :--- | :--- |
| 15 | 角色 = **决策契约**；核心第一原则为种子 |
| 16 | 能力：**Skill 白名单**；知识绑定：**层 + 书可选** |
| 17 | 团队：**成员引用角色库 + 固定工作流 + 沉淀规则 + 优先级** |
| 18 | 与 agent-team 分工：内置团队归 Prism，临时组队归 agent-team |
| 19 | **Skill 本身不分层**；在全局/团队/角色三处指定后叠加 |

### 2.4 ZCode 适配

| # | 决策 |
| :--- | :--- |
| 20 | **仅支持 ZCode**，接口抽象留扩展缝（`HarnessAdapter` + `Registry`） |
| 21 | 角色文件：**复制到 `~/.zcode/agents/`**（ZCode 只扫描该目录） |
| 22 | Skill：**复制到 `~/.zcode/skills/`** 并同步 |
| 23 | MCP：写 `~/.zcode/cli/config.json` 的 `mcp.servers.prism` |
| 24 | Prism 扩展**只放正文**，不进 frontmatter |
| 25 | 装配（install）**必须先于**启用（activate） |
| 26 | 角色 model 冲突：由装配时在宿主环境内补全 |

### 2.5 注入

| # | 决策 |
| :--- | :--- |
| 27 | 三种模式：**MCP 拉取 / 上下文包 / AGENTS.md 静态注入** |
| 28 | 上下文包由**宿主主动调**（Prism 不介入派发） |
| 29 | **绝不把全图/全库塞进上下文** |

### 2.6 代码图谱

| # | 决策 |
| :--- | :--- |
| 30 | 能力用 **Graphify 工具**；显示用 **Graphify Studio 页面** |
| 31 | 产物放 **`<项目根>/graphify-out/`**（Python 版 graphify） |
| 32 | 默认零 token 建图（`--no-description --no-label`） |

### 2.7 工作队列与台账

| # | 决策 |
| :--- | :--- |
| 33 | 工作队列**拉取式**，claim 用 attempt token 防重复 |
| 34 | 任务中心**被动台账**，复用 14 态状态机 |

---

## 3. 待定项汇总

以下为各文档中尚未拍板的项（均不影响架构，可在实现时定）：

| 来源 | 待定项 |
| :--- | :--- |
| knowledge-base | 富化预算默认值、书结构继承 |
| role-definition | 原则一致性检查是警告还是阻断、角色能否跨团队复用 |
| team-definition | 团队定义是否支持 `extends`、多实例命名 |
| harness-adapters | 人写文件冲突策略（不覆盖/备份覆盖） |
| skill-loading | 同步目标 `~/.zcode/skills/` 还是 `~/.agents/skills/` |
| knowledge-injection | 上下文包默认预算 |
| code-graph | 建图触发（仅手动/团队启用自动）、多项目图谱合并 |
| ~~work-queue~~ | 已废弃（队列移除） |
| task-center | 是否批量登记、实时推送方式 |
| cli-mcp-surface | MCP 传输（stdio/HTTP） |

---

## 4. 当前实现状态

**已落地并验证**（2026-09-10）：`pnpm -r typecheck` 7 包通过 ｜ `pnpm test` 376/376 ｜ `pnpm lint` 0 错。

```
prism/
├── packages/core/          # 14 态状态机 + SQLite（单写队列/WAL）+ 审计 + 熔断 + HarnessAdapter + 工作队列 + 任务台账
├── packages/knowledge/     # 层→书→模块→条目 + FTS5(bigram) 检索 + 版次制 + 知识图谱边表 + reindex
├── packages/agents/        # 角色/团队定义解析校验渲染 + ZCode 适配器 + 目录解析（prism.yaml）
├── packages/skills/        # Prism 内置 Skill + 校验 + 安装到宿主 Skill 目录
├── packages/server/        # HTTP API + MCP（10 工具）+ Graphify 封装 + 控制台静态服务
├── packages/cli/           # prism init/serve/doctor/kb/graph/role/team/skill（含写守卫）
├── 3rd/                    # 第三方子工程：archify v2.16.0（自包含）/ graphify v0.9.56（Python，免构建）
└── apps/web/               # React 控制台：知识库/知识图谱/代码图谱/架构图谱/角色/团队/技能/任务中心/工作队列
```

**已实现模块**：知识库（检索/版次/导入/reindex）、**知识图谱**（单一边表：双链/覆盖/取代；邻域与路径查询 + SVG 可视化）、代码图谱（Graphify Python 版封装，仓库内子工程优先，产物 graphify-out/）、角色与团队（定义/校验/装配/激活）、Skill 安装、`prism init` 接入、任务台账（登记/回报/依赖图）、**工作队列**（拉取式：宿主经 MCP/HTTP 认领执行 LLM 工作，Prism 不调 LLM）。

**架构图谱**（Archify v2.16.0 vendored 子工程）：五类图 IR 校验与渲染 + 控制台 iframe 预览。

**设计文档中的功能模块已全部落地。**

---

## 5. 下一步

1. 上游升级：`pnpm run 3rd:build` 后跑 `pnpm run 3rd:check` + `pnpm test`（见 `3rd/README.md`）。
