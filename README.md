# Prism（棱镜）

> **团队的知识与协作控制面**：把规范、红线、架构、代码结构、专家角色组织成可查询、可装配、可审计的资产，通过 MCP / HTTP / 文件注入供宿主 agent 使用。
>
> **它不执行、不调度、不调 LLM。**

Prism 是**纯控制面**：一个 CLI + 自带 Web 控制台，服务一个宿主 harness（默认 ZCode）的多个会话。知识库、代码图谱、架构图谱、角色/团队定义、工作队列、任务台账都归它管；真正的 agent 调度仍由宿主自己负责。

---

## 1. 为什么需要它

AI 编码团队跑起来后，会反复遇到四个问题：

| 问题 | Prism 的答案 |
| :--- | :--- |
| 规范、红线散落在各个文档里，agent 读不到 | **知识库**：层→书→模块→条目，中文全文检索，MCP 拉取 |
| 代码结构没人说得清，改一处不知道影响哪 | **代码图谱**：tree-sitter AST 建图，零 token；路径/影响面查询 |
| 架构图靠人画，画完就过期 | **架构图谱**：五类图由 JSON-IR 自动渲染，IR 是源、HTML 是派生 |
| 专家角色、团队工作流每次口头交代 | **角色/团队定义**：决策契约 + 固定工作流 + 沉淀规则，装进宿主目录 |

关键约束（都来自实际踩坑）：

- **不侵入宿主调度**——宿主（ZCode 等）有自己的子 agent 管理，Prism 不碰；
- **不调 LLM**——需要 LLM 的活（向量化/摘要/实体抽取/图表 IR）落成**工作队列**待办，宿主自己拉取执行；
- **不做审核**——宿主说落库就落库，Prism 只记录、可视化、审计；
- **绝不把全图/全库塞进上下文**——检索返回子集，尊重预算。

---

## 2. 快速开始

### 2.1 环境要求

| 依赖 | 版本 | 说明 |
| :--- | :--- | :--- |
| Node.js | **≥ 22.5** | 依赖内置 `node:sqlite`（`DatabaseSync`） |
| pnpm | ≥ 9 | workspace 管理 |
| Python | ≥ 3.10 | 仅代码图谱需要（vendored graphify 子工程） |

### 2.2 安装

```bash
git clone https://github.com/zhishui-t/prism.git
cd prism
pnpm install
pnpm run 3rd:build     # 安装 graphify 的 Python 依赖（archify 免构建）
```

### 2.3 接入宿主

```bash
# 注册 MCP + 安装 Skill + 建目录骨架
prism init --zcode-dir ~/.zcode

# 启动控制台（http://127.0.0.1:7777）
prism serve
```

`prism init` 会：① 探测宿主目录 ② 建 `<PRISM_HOME>` 骨架 ③ 安装 Prism Skill ④ 写 MCP 注册到宿主的 `cli/config.json` ⑤ 提示重启会话。

> **写守卫**：目标是默认宿主目录且未显式指定时，所有写命令会拒绝执行（`guard_required`），需加 `--yes` 或显式 `--zcode-dir`。防止误写你的真实宿主配置。

### 2.4 打包部署

```bash
pnpm run package       # 产出 dist/prism-<version>.tgz
```

解压即用，无需重新安装依赖：

```bash
tar -xzf dist/prism-0.1.0.tgz && cd prism-0.1.0
node bin/prism.js --version
node bin/prism.js serve
```

---

## 3. 仓库结构

```
prism/
├── packages/
│   ├── core/          # 14 态任务状态机 · SQLite(单写队列/WAL) · 审计 · 熔断 · HarnessAdapter · 工作队列 · 任务台账
│   ├── knowledge/     # 层→书→模块→条目 · FTS5(bigram) 检索 · 版次制 · 知识图谱边表 · reindex
│   ├── agents/        # 角色/团队定义解析校验渲染 · ZCode 适配器 · 目录解析(prism.yaml)
│   ├── skills/        # Prism 内置 Skill · 校验 · 安装到宿主 Skill 目录
│   ├── server/        # HTTP API · MCP(21 工具) · Graphify/Archify 封装 · 控制台静态服务
│   └── cli/           # prism 命令行（init/serve/doctor/kb/graph/arch/role/team/skill/work/task/harness）
├── apps/web/          # React 控制台（9 页）
├── 3rd/               # vendored 子工程：archify v2.16.0（自包含）· graphify v0.9.56（Python）
├── doc/requirements/  # 需求与设计文档（15 篇，含决策记录）
└── test/              # 端到端测试
```

---

## 4. 核心模块

### 4.1 知识库

**内容模型**：`层 → 书 → 模块 → 条目`。三层是 `global / project / role`；条目未归类落 `_inbox/`。

**检索**：FTS5 + **bigram 切分 + unicode61**。为什么不用 trigram？——实测 trigram 检索不了两字中文词（如「性能」），bigram 可以。

**版次制**：更新产生新版次（`version+1`），检索默认只返回最新版；历史版可 `get(id, 版本号)` 精确取回。

**文件为真相，数据库为索引**：正文是 Markdown 文件，DB 只是索引。手工改过文件后跑 `prism kb reindex` 重建索引。

```bash
prism kb import 规范.md --layer global --book java-standards --module exception
prism kb search 性能 --layer global
prism kb tree --layer project
prism kb reindex
```

### 4.2 知识图谱

**单一边表 + 多视图**（图书馆公理：分类分层给定位、图谱联系给发现）。

边来自确定性抽取，零 LLM：
- `references`：正文双链 `[[条目id]]`
- `overrides`：frontmatter 显式层间覆盖

```bash
prism kb graph [[id]]              # 邻域/概览
prism kb path <from> <to>          # 最短路径
```

控制台「知识图谱」页有 SVG 可视化（点击节点下钻邻域）。

### 4.3 代码图谱

用 **Graphify**（vendored 子工程，Python 版）做 tree-sitter AST 建图，**代码零 token**；产物落 `<项目根>/graphify-out/`。

```bash
prism graph build ./my-project --name myproj   # 建图（零 LLM）
prism graph query "谁调用了 handler" --project myproj
prism graph path "run()" "validate()" --project myproj
prism graph affected "validate()" --depth 2 --project myproj
prism graph god-nodes --top 10 --project myproj
prism graph summary --project myproj
prism graph status myproj                       # 陈旧检测（manifest 哈希）
```

控制台「代码图谱」页 iframe 嵌 Graphify 自带可视化。

### 4.4 架构图谱

用 **Archify**（vendored 子工程，MIT v2.16.0）把 JSON-IR 渲染成自包含 HTML。五类图：

| 类型 | 数据来源 |
| :--- | :--- |
| `architecture` | 模块聚类 + 依赖边 → 组件/边界/连接 |
| `sequence` | CALLS 边 + Graphify flows → 参与者/消息 |
| `lifecycle` | 状态机（如 14 态任务机）→ 泳道/状态/转移 |
| `dataflow` | 数据读写边 → 阶段/节点/流转 |
| `workflow` | 团队 DAG 工作流 → 泳道/节点/边 |

```bash
prism arch types
prism arch validate architecture ir.json
prism arch render architecture ir.json --out out.html
```

控制台「架构图谱」页 iframe 预览。IR 是源、HTML 是派生，两者都可作为 `type: diagram` 条目沉淀。

### 4.5 角色与团队

**角色 = 决策契约**：核心第一原则决定冲突时牺牲什么；能力用 Skill 白名单；知识绑到层与书。

**团队 = 成员引用角色库 + 固定工作流 + 沉淀规则 + 优先级**。

角色/团队**直接住在宿主目录**（`~/.zcode/agents/`、`~/.zcode/teams/`），源与产物合一——因为运行时只服务一个 harness，不需要装配复制。

```bash
prism role import --from ~/.zcode/agents
prism role validate dev-1
prism team validate core-dev
prism team activate core-dev    # 返回运行时配置（含每个角色的装配状态）
```

### 4.6 工作队列（不调 LLM 的落地机制）

Prism 干不了的活（向量化/摘要/分类/实体抽取/图表 IR）落成待办，宿主自己拉取执行：

```
Prism 落 work_request(pending)
   ↓ 宿主主动查询
prism_work_pending → prism_work_claim（签发 token）→ 宿主用自己的 LLM 执行
   ↓
prism_work_complete（校验后入库）
```

并发安全：认领用原子迁移 + attempt token，同一任务不会被两个宿主认领。护栏：积压上限、认领超时回收、失败重试上限。

### 4.7 任务台账

**被动台账**——任务由宿主创建推进，Prism 只记录、可视化、审计。

```bash
prism task register --dag d1 --file dag.json --session s1 --team core-dev --project prism
prism task report T-1 --to RUNNING --by dev-1
prism task graph d1          # 依赖图
```

状态回报走 14 态状态机校验（非法转移直接拒绝）+ 乐观并发（`expected_revision`）。控制台「任务中心」页有依赖图 SVG。

---

## 5. 命令面

```
prism
├── init / serve / doctor / package
├── harness  list | show                    宿主适配器（运行时配置选择）
├── role     list | show | init | import | validate | render | install
├── team     list | show | validate | install | activate
├── skill    list | install | validate
├── kb       import | search | get | tree | stats | graph | path | reindex
├── graph    build | query | path | explain | affected | god-nodes | summary | status
├── arch     types | validate | render
├── work     pending | enqueue | claim | complete | fail | reclaim | stats
└── task     list | show | graph | register | report | stats
```

MCP 工具 21 个：知识库 5 · 代码图谱 7 · 角色团队 4 · 工作队列 3 · 任务台账 3。

---

## 6. 配置

`<PRISM_HOME>/prism.yaml`（可选）：

```yaml
harness: zcode              # 运行时服务的宿主适配器（默认 zcode）
roles_dir: ~/.zcode/agents  # 角色受管目录
teams_dir: ~/.zcode/teams   # 团队受管目录（roles_dir 同级，不在 agents/ 内）
skills_dir: ~/.zcode/skills # Skill 受管目录
```

`<PRISM_HOME>` 默认 `~/.prism`，可用环境变量 `PRISM_HOME` 覆盖。

> **`teams_dir` 为什么不在 `agents/` 下**：ZCode 会**递归**扫描 `~/.zcode/agents/` 下所有 `.md`，团队文件含 `name`+`description` 会被静默注册成假 agent（实测确认）。故团队落在同级 `teams/`。

---

## 7. 开发

```bash
pnpm typecheck     # 7 包类型检查
pnpm test          # 382 单测
pnpm test:e2e      # 端到端测试
pnpm lint          # ESLint
pnpm build         # 构建全部包 + web
pnpm run 3rd:build # 安装 graphify Python 依赖
pnpm run package   # 打包 tarball
```

详见 [AGENTS.md](./AGENTS.md)（AI 协作者与贡献者指南）。

---

## 8. 设计文档

`doc/requirements/` 下 15 篇，含全部决策记录与实测依据：

| 文档 | 内容 |
| :--- | :--- |
| `README.md` | 设计总览 + 34 项核心决策索引 |
| `knowledge-base.md` | 知识库模型、检索、导入、护栏 |
| `code-graph.md` / `knowledge-injection.md` | 代码图谱与知识注入 |
| `role-definition.md` / `team-definition.md` | 角色与团队定义 |
| `harness-adapters.md` | 宿主适配约定与装配 |
| `work-queue.md` / `task-center.md` | 工作队列与任务台账 |
| `deployment-model.md` | 部署形态（编译期多 harness / 运行期单 harness） |
| `model-negotiation.md` | 边界声明：Prism 不参与子 agent 管理与模型选择 |

---

## 9. 许可证

MIT。`3rd/` 下的 vendored 子工程保留其原始许可证（archify: MIT；graphify: Apache-2.0 + MIT 双许可），再分发时须一并保留。
