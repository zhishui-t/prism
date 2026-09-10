# Prism（棱镜）

> **团队的知识与协作控制面**：把规范、红线、架构、代码结构、专家角色组织成可查询、可装配、可审计的资产，通过 MCP / HTTP / 文件注入供宿主 agent 使用。
>
> **它不执行、不调度、不调 LLM。**

Prism 是**纯控制面**：一个 CLI + 自带 Web 控制台，服务一个宿主 harness（默认 ZCode）的多个会话。知识库、知识图谱、代码图谱、架构图谱、角色/团队定义、任务台账都归它管；真正的 agent 调度仍由宿主自己负责。

---

## 1. 为什么需要它

AI 编码团队跑起来后，会反复遇到四个问题：

| 问题 | Prism 的答案 |
| :--- | :--- |
| 规范、红线散落在各个文档里，agent 读不到 | **知识库**：层→书→模块→条目，中文全文检索 + 向量混合召回，MCP 拉取 |
| 代码结构没人说得清，改一处不知道影响哪 | **代码图谱**：tree-sitter AST 建图，零 token；路径/影响面查询 |
| 架构图靠人画，画完就过期 | **架构图谱**：五类图由 JSON-IR 自动渲染，IR 是源、HTML 是派生 |
| 专家角色、团队工作流每次口头交代 | **角色/团队定义**：决策契约 + 固定工作流 + 沉淀规则，装进宿主目录 |

关键约束（都来自实际踩坑）：

- **不侵入宿主调度**——宿主（ZCode 等）有自己的子 agent 管理，Prism 不碰；
- **不调 LLM**——需要 LLM 的活（摘要/分类/实体抽取/图表 IR）由**宿主产出结果后调 `prism_kb_enrich` 直接回写**（无队列、无轮询）；
- **向量化自理**——embedding 用 Prism **内置模型**（BGE-M3 / Qwen3，按算力自动分档），不依赖宿主；
- **不做审核**——宿主说落库就落库，Prism 只记录、可视化、审计；
- **绝不把全图/全库塞进上下文**——检索返回子集，尊重预算。

---

## 2. 快速开始

### 2.1 环境要求

| 依赖 | 版本 | 说明 |
| :--- | :--- | :--- |
| Node.js | **≥ 22.5** | 依赖内置 `node:sqlite`（`DatabaseSync`） |
| pnpm | ≥ 9 | workspace 管理 |
| Python | ≥ 3.10 | 仅代码图谱需要（graphify 子模块） |
| CMake + MinGW-w64 | — | 仅本地编译向量化（`prism embedding install`；缺失时自动回落官方预编译包） |
| Git | — | 拉取子模块 |

### 2.2 安装

```bash
git clone --recurse-submodules https://github.com/zhishui-t/prism.git
cd prism
pnpm install
pnpm run 3rd:build     # 安装 graphify 的 Python 依赖（archify 免构建）
pnpm run 3rd:setup     # 下 anydoc 平台二进制 + llama.cpp 编译/模型（可选，按需）

# 已 clone 过、但没带 --recurse-submodules：
pnpm run 3rd:init      # = git submodule update --init --recursive
```

> `anydoc`（文档转 Markdown）与向量化运行时是**平台相关**的，不进仓库也不随包分发，
> 由 `3rd:setup` 在目标机按自身平台生成（见 [3rd/README.md](./3rd/README.md)）。

### 2.3 接入宿主

```bash
# 注册 MCP + 安装 Skill + 建目录骨架
prism init --harness-root ~/.zcode

# 启动控制台（http://127.0.0.1:7777）
prism serve
```

`prism init` 会：① 探测宿主目录 ② 建 `<PRISM_HOME>` 骨架 ③ 安装 Prism Skill ④ 写 MCP 注册到宿主配置 ⑤ 提示重启会话。

> **写守卫**：目标是默认宿主目录且未显式指定时，所有写命令会拒绝执行（`guard_required`），需加 `--yes` 或显式 `--harness-root`。防止误写你的真实宿主配置。

### 2.4 启用本地向量化（可选，但推荐）

```bash
prism embedding install     # 编译 llama.cpp + 按算力下载模型；有显卡自动装 GPU(Vulkan) 包
prism embedding status      # 查看后端(GPU/CPU)、档位、维度
prism embedding models      # 三档模型一览（small/default/large）
```

未安装时检索自动降级为纯关键词（BM25），**不报错、不阻断落库**。

### 2.5 打包部署

```bash
pnpm run package       # 产出 dist/prism-<version>.tgz
```

解压即用，无需重新安装依赖（目标机首次跑 `prism embedding install` 生成向量运行时）：

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
│   ├── core/          # 14 态任务状态机 · SQLite(单写队列/WAL) · 审计 · 熔断 · HarnessAdapter · 任务台账
│   ├── knowledge/     # 层→书→模块→条目 · FTS5(bigram)+向量混合检索 · 版次制 · 知识图谱边表 · reindex
│   ├── agents/        # 角色/团队定义解析校验渲染 · harness 适配器 + 运行期插件 · 目录解析
│   ├── skills/        # Prism 内置 Skill · 校验 · 安装到宿主 Skill 目录
│   ├── server/        # HTTP API · MCP(31 工具) · Graphify/Archify/embedding 封装 · 控制台静态服务
│   └── cli/           # prism 命令行（init/serve/doctor/kb/graph/arch/role/team/skill/task/harness/embedding/project/inject/audit）
├── apps/web/          # React 控制台（7 页）
├── 3rd/               # git submodule（锁定上游发布 tag，见 3rd/README.md）
│   ├── archify/       # v2.16.0（自包含 Node CLI，免构建）
│   ├── graphify/      # v0.9.57（Python，免构建）
│   ├── llama.cpp/     # b10883（C++，本地编译 → 3rd/llama-runtime/）
│   └── anydoc/        # v0.2.4（Rust/napi，平台预编译 → 3rd/anydoc-runtime/）
├── doc/requirements/  # 需求与设计文档（16 篇，含决策记录）
└── test/              # 端到端测试
```

---

## 4. 核心模块

### 4.1 知识库

**内容模型**：`层 → 书 → 模块 → 条目`。三层是 `global / project / role`；条目未归类落 `_inbox/`。

**两类知识**：`owned`（Prism 落盘为真相）与 `indexed`（项目文件为真相，Prism 只存索引 + 检索副本，**只读原件**）。

**检索**：FTS5 **bigram 切分 + unicode61**（实测 trigram 检索不了两字中文词如「性能」，bigram 可以）+ **本地向量余弦**，两路经 RRF 融合。换 embedding 档位后旧向量自动失效，跑 `prism embedding reindex` 重算。

**版次制**：更新产生新版次（`version+1`），检索默认只返回最新版；内容哈希相同则不产生新版次（重复导入不堆叠）。软删（`deprecated`）保留审计，可 `restore` 恢复。

**文件为真相，数据库为索引**：手工改过文件后跑 `prism kb reindex` 重建索引。

```bash
prism kb import 规范.md --layer global --book java-standards --module exception
prism kb search 性能 --layer global
prism kb sync myproj                 # 扫项目文档建「引用型」索引（不改原件）
prism kb convert report.docx --out report.md   # 任意文档转 Markdown（anydoc，零 LLM）
prism kb tree --layer project
prism kb reindex
prism kb remove KB-1                 # 软删；prism kb restore KB-1 恢复
```

### 4.2 知识图谱

**单一边表 + 多视图**（图书馆公理：分类分层给定位、图谱联系给发现）。

边来自确定性抽取，零 LLM：
- `references`：正文双链 `[[条目id]]`
- `overrides`：frontmatter 显式层间覆盖
- `supersedes`：版次取代链

```bash
prism kb graph [[id]]              # 邻域/概览
prism kb path <from> <to>          # 最短路径
prism kb conflicts                 # 层间同名冲突（检测 global<project<role 全部更低层）
prism kb export --format obsidian  # 导出 Obsidian vault（借 Graphify）
```

控制台「知识库」页内嵌星图可视化（点击节点下钻书内：总纲/知识图谱/架构图/条目）。

### 4.3 代码图谱

用 **Graphify**（子模块，Python 版）做 tree-sitter AST 建图，**代码零 token**；产物落 `<项目根>/graphify-out/`。

```bash
prism graph build ./my-project --name myproj   # 建图（零 LLM）
prism graph query "谁调用了 handler" --project myproj
prism graph path "run()" "validate()" --project myproj
prism graph affected "validate()" --depth 2 --project myproj
prism graph god-nodes --top 10 --project myproj
prism graph summary --project myproj
prism graph export obsidian --project myproj
prism graph status myproj                       # 陈旧检测（manifest 哈希）
```

控制台「代码图谱」页 iframe 嵌 Graphify 自带可视化（**只读**——建图由宿主执行 `prism graph build`）。

### 4.4 架构图谱

用 **Archify**（子模块，MIT v2.16.0）把 JSON-IR 渲染成自包含 HTML。五类图：

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

IR 是源、HTML 是派生，两者都可作为 `type: diagram` 条目沉淀。

### 4.5 角色与团队

**角色 = 决策契约**：核心第一原则决定冲突时牺牲什么；能力用 Skill 白名单；知识绑到层与书。

**团队 = 成员引用角色库 + 固定工作流 + 沉淀规则 + 优先级**。

角色/团队**直接住在宿主目录**（`<harness 根>/agents/`、`<harness 根>/teams/`），源与产物合一——运行时只服务一个 harness，不需要装配复制。

```bash
prism role import --from ~/.zcode/agents
prism role validate dev-1
prism role render dev-1                # 渲染为当前 harness 原生格式
prism team validate core-dev
prism team activate core-dev           # 返回运行时配置（含每个角色的装配状态）
```

### 4.6 接入其他 harness（运行期插件，零代码侵入）

Prism 内置 ZCode 适配器，并支持**运行期插件**扩展——第三方**不必改 Prism 代码、不必重编译**，把适配包放进目录即自动注册：

```
<PRISM_HOME>/harnesses/<name>/
  harness.json       # { "id": "my-harness", "entry": "./index.mjs" }
  index.mjs          # 导出适配器（default function / createAdapter / adapter 实例）
```

```bash
prism harness list     # 内置 + 插件适配器 + 当前激活项 + 插件目录
prism harness show     # 当前适配器约定（角色/团队/Skill 目录、MCP 注册位置、派发机制…）
PRISM_HARNESS=my-harness prism harness show   # 激活某个适配器
```

适配器自述全部宿主约定：根目录、角色/团队/Skill 目录、MCP 注册文件位置与形态、产物渲染格式、指令文件。细节见 [doc/requirements/adding-a-harness.md](doc/requirements/adding-a-harness.md)。

### 4.7 富化与向量化

**富化（宿主直付）**：需要 LLM 的活（摘要/分类/实体抽取/图表 IR）由宿主用自己的 LLM 产出，再调 `prism_kb_enrich` 直接回写——Prism 只做确定性落库，**无队列、无轮询、不调 LLM**。

```
宿主读文档 → 自己的 LLM 提取 → prism_kb_enrich { kind, payload, result } → Prism 落库
```

不落库的文档转换走 `prism_kb_convert`（anydoc 本地转换，零 LLM、零网络）。

**向量化（Prism 内置）**：BGE-M3（多语言基线）或 Qwen3-Embedding（更强）经 llama.cpp 常驻服务提供，按算力自动选档——无显卡用轻量 `small`（512 维），有显卡用 `large`（1024 维，快约 170 倍）。落库自动向量化。

### 4.8 任务台账

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
├── init / serve / doctor
├── embedding  install | status | start | stop | models | use | reindex
├── harness    list | show                              宿主适配器（内置 + 运行期插件）
├── role       list | show | init | import | validate | render | install
├── team       list | show | validate | install | activate
├── skill      list | install | update | uninstall | validate
├── kb         import | sync | search | get | tree | stats | graph | path
│              | export | remove | restore | conflicts | resolve | history | reindex
│              | convert | enrich
├── graph      build | query | path | explain | affected | god-nodes | summary | status | export
├── arch       types | validate | render
├── project    add | list | show | remove
├── inject     <项目根> [--team <id>] [--remove]        把 Prism 指引写进项目 AGENTS.md
├── harness / audit
└── task       list | show | graph | register | report | stats
```

**MCP 工具 31 个**：知识库 15 · 代码图谱 7 · 角色团队 6 · 任务台账 3。

---

## 6. 配置

`<PRISM_HOME>/prism.yaml`（可选）：

```yaml
harness: zcode              # 激活哪个宿主适配器（默认取清单首项）
# 以下可选覆盖；不写则用激活适配器自述的目录
roles_dir: ~/.zcode/agents  # 角色受管目录
teams_dir: ~/.zcode/teams   # 团队受管目录（roles_dir 同级，不在 agents/ 内）
skills_dir: ~/.zcode/skills # Skill 受管目录
embedding_model: small      # 向量模型档位：small | default | large
```

**环境变量**：

| 变量 | 作用 |
| :--- | :--- |
| `PRISM_HOME` | 覆盖主目录（默认 `~/.prism`） |
| `PRISM_HARNESS` | 覆盖激活的 harness |
| `PRISM_HARNESS_ROOT` | 覆盖 harness 根目录 |
| `PRISM_HARNESS_DIR` | 覆盖插件目录（默认 `<PRISM_HOME>/harnesses`） |
| `PRISM_NO_HARNESS_PLUGINS=1` | 禁用插件加载 |
| `PRISM_EMBEDDING=off` | 强制纯 BM25（跳过向量） |
| `PRISM_EMBEDDING_MODEL` | 覆盖向量档位 |
| `ZCODE_DIR` | ZCode 专属旧变量（由 zcode 适配器消费） |

> **`teams_dir` 为什么不在 `agents/` 下**：ZCode 会**递归**扫描 `~/.zcode/agents/` 下所有 `.md`，团队文件含 `name`+`description` 会被静默注册成假 agent（实测确认）。故团队落在同级 `teams/`。

---

## 7. 开发

```bash
pnpm typecheck     # 7 包类型检查
pnpm test          # 535 单测
pnpm test:e2e      # 66 项端到端
pnpm lint          # ESLint
pnpm build         # 构建全部包 + web
pnpm run 3rd:init  # 初始化子模块（首次）
pnpm run 3rd:build # 安装 graphify Python 依赖
pnpm run 3rd:setup # 下 anydoc + 编译 llama.cpp（可选）
pnpm run package   # 打包 tarball
```

详见 [AGENTS.md](./AGENTS.md)（AI 协作者与贡献者指南）与 [3rd/README.md](./3rd/README.md)（子模块管理）。

---

## 8. 设计文档

`doc/requirements/` 下 16 篇，含全部决策记录与实测依据：

| 文档 | 内容 |
| :--- | :--- |
| `README.md` | 设计总览 + 核心决策索引 |
| `knowledge-base.md` | 知识库模型、检索、导入、护栏（顶部有实现状态修订） |
| `code-graph.md` / `knowledge-injection.md` | 代码图谱与知识注入 |
| `role-definition.md` / `team-definition.md` | 角色与团队定义 |
| `harness-adapters.md` / `adding-a-harness.md` | 宿主适配约定 + 新增 harness 配方 |
| `task-center.md` | 任务台账（被动台账 + 回报协议） |
| `deployment-model.md` | 部署形态（多 harness / 单激活、多会话共享） |
| `model-negotiation.md` | 边界声明：Prism 不参与子 agent 管理与模型选择 |
| ~~`work-queue.md`~~ | **已废弃**（工作队列移除；富化改宿主直付，见该文顶部） |

---

## 9. 许可证

MIT。`3rd/` 下是 git submodule，各自保留原始许可证（archify: MIT；graphify: Apache-2.0 + MIT 双许可；llama.cpp: MIT），再分发时须一并保留。
