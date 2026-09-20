# Prism（棱镜）

> **团队的知识与协作控制面**：把规范、红线、架构、代码结构、专家角色组织成可查询、可装配、可审计的资产，通过 MCP / HTTP / 文件注入供宿主 agent 使用。
>
> **它不执行、不调度、不调 LLM。**

Prism 是**纯控制面**：一个 CLI + 自带 Web 控制台，服务一个宿主 harness（默认 ZCode）的多个会话。知识库、知识图谱、代码图谱、架构图谱、角色/团队定义都归它管；真正的 agent 调度仍由宿主自己负责。

---

## 1. 为什么需要它

AI 编码团队跑起来后，会反复遇到四个问题：

| 问题 | Prism 的答案 |
| :--- | :--- |
| 规范、红线散落在各个文档里，agent 读不到 | **知识库**：层→书→模块→条目，中文全文检索 + 向量混合召回，MCP 拉取 |
| 代码结构没人说得清，改一处不知道影响哪 | **代码图谱**：tree-sitter AST 建图，零 token；路径/影响面查询 |
| 架构图靠人画，画完就过期 | **架构图谱**：五类图 IR **全自动派生**（团队定义 / 代码图谱 / 任务状态机），IR 是源、HTML 是派生 |
| 专家角色、团队工作流每次口头交代 | **角色/团队定义**：决策契约 + 固定工作流 + 沉淀规则，装进宿主目录 |

关键约束（都来自实际踩坑）：

- **不侵入宿主调度**——宿主（ZCode 等）有自己的子 agent 管理，Prism 不碰；
- **不调 LLM**——需要 LLM 的活（摘要/分类/实体抽取/图表 IR）由**宿主产出结果后调 `prism_kb_enrich` 直接回写**（无队列、无轮询）；
- **向量化自理**——embedding 用 Prism **内置模型**（BGE-M3 / Qwen3，按算力自动分档），不依赖宿主；
- **OCR 内置**——扫描版 PDF / 图片转文本（PP-OCRv5 server + RapidOCR，**本地判别模型零 LLM**），模型按需安装；
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
pnpm run 3rd:setup     # 下 anydoc 平台二进制 + llama.cpp 编译/模型 + OCR 模型（可选，按需）

# 已 clone 过、但没带 --recurse-submodules：
pnpm run 3rd:init      # = git submodule update --init --recursive
```

> `anydoc`（文档转 Markdown）与向量化运行时是**平台相关**的：**源码**由 submodule 引入，
> **二进制**在开发机由 `3rd:setup` 按本机平台生成（见 [3rd/README.md](./3rd/README.md)）；
> 发布时二者都会**随平台包分发**（§2.5），目标机因此不需要额外下载。

### 2.3 接入宿主

```bash
# 注册 MCP + 安装 Skill + 建目录骨架（写入你真实的宿主目录，故要 --yes 确认）
prism init --yes

# 启动控制台（http://127.0.0.1:7777）
prism serve
```

`prism init` 会：① 探测宿主目录 ② 建 `<PRISM_HOME>` 骨架 ③ 安装 Prism Skill ④ 写 MCP 注册到宿主配置 ⑤ 注册 CLI 全局命令 `prism` ⑥ 提示重启会话。
正常接入只走**默认落点**；`--harness-root <路径>` 覆盖落点是**测试/CI 专用**（把配置写到临时目录，宿主不读那里）。
第 ⑤ 步按包形态选择安装物：发行包内跑 `npm install -g <发行根>`；仓库内跑写**全局 bin shim**
（`prism` / `prism.cmd` / `prism.ps1` → `node <仓库根>/packages/cli/dist/index.js`，零网络）。
不需要它（CI、容器、只临时用一次）时加 `--skip-cli`；注册失败只记报告 `cli` 节并给手动指引，不影响其余步骤。

> **写守卫**：目标是默认宿主目录且未显式指定时，所有写命令会拒绝执行（`guard_required`）。`prism init` 加 `--yes` 确认写入默认宿主配置（role/team/skill 等写命令另可用 `--harness-root` 或 `--yes`）。防止误写你的真实宿主配置。
>
> 清理：把 init 误指到项目目录后生成的 `cli/config.json` / `mcp.json` **可直接删除**（宿主不读该位置，删除不影响宿主里的注册）。

### 2.4 启用本地向量化（可选，但推荐）

```bash
prism embedding install     # 编译 llama.cpp + 按算力下载模型；有显卡自动装 GPU(Vulkan) 包
prism embedding status      # 查看后端(GPU/CPU)、档位、维度
prism embedding models      # 三档模型一览（small/default/large）
```

未安装时检索自动降级为纯关键词（BM25），**不报错、不阻断落库**。

### 2.5 打包部署

```bash
pnpm run package       # 产出 dist/prism-<version>_<platform>.tgz
pnpm run test:package  # 发行冒烟：打包 → 解压 → 在解压环境验证能力
pnpm run deploy        # 装到 <PRISM_HOME>/runtime/ + 校正宿主 MCP 注册 + 装登录自启
```

产物**按平台分别发布**——包内自带本平台的三方运行时与最小向量模型：

| 包名示例 | 含的运行时 |
| :--- | :--- |
| `prism-0.1.0-alpha_win_x64.tgz` | `llama-server.exe`（CPU 自编译 + Vulkan 预编译）、`anydoc.<platform>.node` |
| `prism-0.1.0-alpha_mac_arm64.tgz` | `llama-server`（Metal 随包分发）、`anydoc.darwin-arm64.node` |

**为什么要分平台**：llama 二进制与 anydoc 原生绑定都**不可跨平台复用**，所以 mac 版必须另出一个
`_mac_arm64` / `_mac_x64` 包。`os` / `cpu` 字段已写进包内 `package.json`，包名也带平台后缀。

**解压即用，无需 git、无需联网**（目标机不再需要 `git submodule update`，也不会去 GitHub 下载）：

```bash
tar -xzf dist/prism-0.1.0-alpha_win_x64.tgz && cd prism-0.1.0-alpha_win_x64
node bin/prism.js --version   # prism 0.1.0-alpha
node bin/prism.js doctor      # 三方件 + 向量运行时一次自检
node bin/prism.js serve --ensure   # 后台起控制台（--check 看状态 / --stop 停它）
```

**装到本机并接上宿主**只需一条命令（推荐，取代手工解压 + 手改注册）：

```bash
pnpm run deploy
```

它做四件事：解包到**恒定路径** `~/.prism/runtime/`（不含版本号 → 升级只换目录内容，**MCP 注册不用动**）、
自检 `bin/prism.js --version`（跑不起来自动回滚）、校正宿主 MCP 注册、把登录自启装进「启动文件夹」。

> **关于「重启后 Prism 不启动」**：Prism 接宿主走的是 **MCP 的 stdio 形态**——宿主启动时自己拉起、
> 宿主退出时自动结束，**本来就不需要开机自启**。真正会出问题的是**注册指向的路径失效**
> （部署目录被清理，或指到了开发布局 `packages/server/dist/…`）。`deploy` 用恒定路径就是为根治它。
> 控制台（web UI，默认 `127.0.0.1:7777`）需要常驻，靠两条路：**宿主启动时 MCP 顺带 `ensure` 拉起**
> （零配置）+ **登录自启**（`deploy` 装的启动项）。关掉自动拉起：`PRISM_SERVE_AUTOSTART=0`。

包内含：应用与 CLI、控制台静态资源、`3rd/archify` 与 `3rd/graphify` 源码（免构建）、
`3rd/llama-runtime/{bin,bin-vulkan,models/bge-small-zh-v1.5-q8_0.gguf}`、
`3rd/anydoc-runtime/`、宿主适配器示例，以及 `PRISM-MANIFEST.json`（版本/平台/运行时清单）
与 `SHA256SUMS`（校验和）。

**不随包、需目标机自理的三项**：

- **大档向量模型**（`bge-m3` / `Qwen3-Embedding`，各 600MB+）：默认只带最小档
  `bge-small-zh-v1.5`（26MB，512 维，CPU）。要更大档位跑
  `prism embedding install --tier default|large`（需联网），或打包加 `--models all`。
- **graphify 的 Python 依赖**（`tree-sitter` 系列 + `networkx` / `numpy` / `rapidfuzz`）：
  Python 环境无法可靠内嵌，目标机需 `pnpm run 3rd:build`（即 `python -m pip install`）。
  **未装时只有代码图谱降级，知识库检索与文档转换照常可用。**
- **OCR 模型**（PP-OCRv5 server 三件套，约 180MB）与 OCR 的 pip 依赖：不随包。目标机按需
  `node scripts/setup-ocr.mjs`（`pnpm run 3rd:setup` 已含此步）联网补装。
  **未装时扫描版 PDF / 图片维持原 `unsupported` 行为**，其余能力不受影响。

为控制体积，打包排除了 `3rd/llama.cpp` 源码（173MB，只有「源码编译」路径需要）与
`3rd/llama-runtime/build` 编译中间产物（95MB），以及 3rd 子模块里与运行无关的
docs/examples/tests（约 46MB）。`--full-3rd` 可保留 3rd 子模块的全部内容。

---

## 3. 仓库结构

```
prism/
├── packages/
│   ├── core/          # 14 态任务状态机 · SQLite(单写队列/WAL) · 审计 · 熔断 · HarnessAdapter
│   ├── knowledge/     # 层→书→模块→条目 · FTS5(bigram)+向量混合检索 · 版次制 · 知识图谱边表 · reindex
│   ├── agents/        # 角色/团队定义解析校验渲染 · harness 适配器 + 运行期插件 · 目录解析
│   ├── skills/        # Prism 内置 Skill · 校验 · 安装到宿主 Skill 目录
│   ├── server/        # HTTP API · MCP(44 工具) · Graphify/Archify/embedding 封装 · 控制台静态服务
│   └── cli/           # prism 命令行（init/serve/doctor/kb/graph/arch/role/team/skill/harness/embedding/project/inject/audit）
├── apps/web/          # React 控制台（6 页 · 浅/深主题 · 中/英 · hash 深链）
├── 3rd/               # git submodule（锁定上游发布 tag，见 3rd/README.md）
│   ├── archify/       # v2.16.0（自包含 Node CLI，免构建）
│   ├── graphify/      # v0.9.57（Python，免构建）
│   ├── llama.cpp/     # b10883（C++，本地编译 → 3rd/llama-runtime/）
│   ├── anydoc/        # v0.2.4（Rust/napi，平台预编译 → 3rd/anydoc-runtime/）
│   └── ocr/           # Prism 自有（非 submodule）：OCR 工具（PP-OCRv5 server + RapidOCR）
├── doc/requirements/  # 需求与设计文档（16 篇，含决策记录）
└── test/              # 端到端测试
```

---

## 4. 核心模块

### 4.1 知识库

**内容模型**：`层 → 书 → 模块 → 条目`。三层是 `global / project / role`；条目未归类落 `_inbox/`。

**两类知识**：`owned`（Prism 落盘为真相）与 `indexed`（项目文件为真相，Prism 只存索引 + 检索副本，**只读原件**）。

**检索**：FTS5 **bigram 切分 + unicode61**（实测 trigram 检索不了两字中文词如「性能」，bigram 可以）+ **本地向量余弦**，两路经 RRF 融合。换 embedding 档位后旧向量自动失效，跑 `prism embedding reindex` 重算。

**版次制**：更新产生新版次（`version+1`），检索默认只返回最新版；内容哈希相同则不产生新版次（重复导入不堆叠）。软删（`deprecated`）保留审计，可 `restore` 恢复；**版次历史可查**（`prism kb versions <id>`，条目详情的「版本」标签）。

**书结构**：`_modules.yaml`（模块清单，可 `freeze` 固化、支持 `inherits` 跨书继承）+ `_summary.md`（书级与模块级总纲），由条目与边表**零 LLM 推导**（`prism kb structure show|generate|freeze`），表 `book_structures` 只做索引。

**文件为真相，数据库为索引**：手工改过文件后跑 `prism kb reindex` 重建索引。

```bash
prism kb import 规范.md --layer global --book java-standards --module exception
prism kb search 性能 --layer global
prism kb sync myproj                 # 扫项目文档建「引用型」索引（不改原件）
prism kb convert report.docx --out report.md   # 任意文档转 Markdown（anydoc，零 LLM）
prism kb tree --layer project
prism kb structure generate --layer global --book java-standards   # 生成 _modules.yaml + _summary.md
prism kb structure freeze --layer global --book java-standards --modules exception,logging
prism kb versions JAVA-01-002        # 条目版次历史
prism kb deposit 说明.md --title 禁止吞异常 --type rule --team core-dev --note 来源说明
prism kb reindex
prism kb reindex --chunks            # 存量库迁移：只补段级索引（段行/段 FTS/段向量），可中断重跑
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

控制台「知识库」页内嵌星图可视化（点击节点下钻主题：总纲/知识图谱/架构图/条目），可全屏沉浸（Esc 退出）。**界面口径**：`book`（书）是内部模型概念、不对外扩散——控制台不暴露该层级，只呈现 `项目 → 主题 → 知识`；按书维度的接口（如 `kb structure`）不受影响，仅前端不再展示。

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

用 **Archify**（子模块，MIT v2.16.0）把 JSON-IR 渲染成自包含 HTML。五类图的 IR **全部由 Prism 自动派生**（agents 包纯函数，零 IO / 零时钟 / 零随机）：

| 类型 | 数据来源 | 入口 |
| :--- | :--- | :--- |
| `workflow` | 团队 DAG 工作流 → 泳道/节点/边 | `prism arch from-team <team_id>` |
| `architecture` | 已注册项目的代码图谱（社区聚类 + 依赖边） | `prism arch from-graph architecture <project>` |
| `sequence` | 代码图谱的**跨文件 calls 边** | `prism arch from-graph sequence <project>` |
| `lifecycle` | Prism 任务状态机（14 态 36 转移） | `prism arch from-state` |
| `dataflow` | 代码图谱目录角色分层 + 跨层依赖边（口径 = 依赖流向） | `prism arch from-graph dataflow <project>` |

```bash
prism arch types                              # 列出五类
prism arch from-team core-dev                 # 工作流图：由团队定义一键派生
prism arch from-graph architecture mini-snake # 架构图：由代码图谱派生（--top/--limit 控制规模）
prism arch from-state                         # 生命周期图：由任务状态机派生
prism arch schema architecture                # 契约核对/排障用（公共定义用 schema common）
prism arch validate architecture ir.json      # 校验一个现成 IR（schema + 布局）
prism arch render architecture ir.json --out out.html
```

MCP 等价：`prism_arch_generate { type, team?, project?, book?, module? }`（`workflow` 传 `team`，`architecture|sequence|dataflow` 传 `project`，`lifecycle` 无入参；可选 `book`/`module` 写进产物 sidecar）。

**产物归位（v9 F1）**：`architecture|sequence|dataflow` 三类项目图落 `<projectRoot>/.prism/arch/<type>/`（项目根经注册表解析——未注册拒绝；root 被删/被挪报 `project_root_missing` 且不重建目录）；`workflow|lifecycle` 落 `<PRISM_HOME>/archify/<type>/`；`--out`/`out` 完全接管落点。控制台列表 `GET /api/arch/diagrams` **双源**扫描两处（扫 `*.html` + sidecar 容错，缺 sidecar 的历史产物照常可见），条目带 `source`/`project` 并由服务端给出 `preview`/`ir` URL。`.prism` 已在知识库扫描忽略表，代码图谱侧由建图参数 `--exclude .prism` 挡住自污染。

IR 是源、HTML 是派生，两者都可作为 `type: diagram` 条目沉淀。**IR 是派生视图（R7）**：五类图都由**既有真相**（团队定义 / 代码图谱 / 任务状态机）纯函数派生，**宿主与用户都不产 IR**；`prism arch schema` 只作契约核对。真实图谱上可能**有理由地拒画**（同目录扁平仓库无处分层、图谱无跨文件 calls 边、层数不足两级）——报错并说明理由，不产出坏图。

### 4.5 角色与团队

**角色 = 决策契约**：核心第一原则决定冲突时牺牲什么；能力用 Skill 白名单；知识绑到层与书。

**团队 = 成员引用角色库 + 固定工作流 + 沉淀规则 + 优先级**。

角色/团队**直接住在宿主目录**（`<harness 根>/agents/`、`<harness 根>/teams/`），源与产物合一——运行时只服务一个 harness，不需要装配复制。

增删改查在三个入口**同名同位**：`new | edit | rm` ↔ MCP `prism_role_new|edit|rm` / `prism_team_new|edit|rm` ↔ HTTP `POST|PATCH|DELETE /api/roles[/:name]`、`/api/teams[/:id]`。

**目录字段怎么取**：读接口返回的键名与写参数**同名**，读回即可回填——`GET /api/roles` → `{ roles, roles_dir }`、`prism_role_list` → `roles_dir`；`GET /api/teams` → `{ teams, teams_dir }`、`prism_team_list` → `teams_dir`。

**三入口的取舍（有意不对称，非缺陷）**：`render` 只有 CLI/MCP；`validate` 只有 CLI（校验结果随 `list`/`detail` 的 `issues` 返回）；`--from`（从既有定义复制）只有 CLI。**Skill 的装/卸三入口齐**：CLI `prism skill install|uninstall|update` ↔ MCP `prism_skill_install|uninstall` ↔ HTTP `POST /api/skills/install|uninstall`（写路径 `skills_dir` 必填；先用 `prism_skill_list` 拿回该目录）。三入口真正严格对齐的是**动词与落盘语义**。

```bash
prism role list
prism role list --source D:/tmp/roles           # --source 覆盖 roles_dir：role 的读写命令一律生效
prism role new dev-1 --description "开发角色：交付可运行增量。" --skills kb,graph
prism role edit dev-1 --skills kb,graph,arch   # 外科式字段补丁：只改点名字段，正文不重排
prism role rm dev-1 --yes                      # 硬删；默认宿主目录需 --yes
prism role validate
prism role render dev-1                # 渲染为当前 harness 原生格式（target = 真实落点）
prism team list
prism team list --source D:/tmp/teams           # --source 覆盖 teams_dir（读写一律生效）
prism team new my-team --members dev-1,tester   # 新建团队：脚手架 + 自动校验 + 写守卫
prism team new my-team --source D:/tmp/teams --roles-dir D:/tmp/roles --members dev-1   # 显式目录：隔离场景（无需 --yes）
prism team edit my-team --members dev-1         # 改名册 → 工作流表就地按名册收窄
prism team rm my-team --yes                     # 硬删；默认宿主目录需 --yes
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

---

## 5. 命令面

```
prism
├── init / serve / doctor
├── embedding  install | status | start | stop | models | use | reindex
├── harness    list | show                              宿主适配器（内置 + 运行期插件）
├── role       list | show | new | edit | rm | validate | render
├── team       list | show | new | edit | rm | validate | render | activate
├── skill      list | install | update | uninstall | validate | effective | categorize | category
├── kb         import | sync | search | get | tree | stats | graph | path
│              | export | remove | restore | conflicts | resolve | history | reindex [--chunks]
│              | convert | enrich | structure | versions | deposit
├── graph      build | query | path | explain | affected | god-nodes | summary | status | export
├── arch       types | validate | render
├── project    add | list | show | remove
├── inject     <项目根> [--team <id>] [--remove]        把 Prism 指引写进项目 AGENTS.md
└── harness / audit
```

**MCP 工具 48 个**：知识库 17 · 代码图谱 8 · 架构图谱 1 · 角色/团队/技能 21 · 上下文包 1（`tools/list` 实测）。

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
pnpm test          # 921 单测（93 文件）
pnpm test:e2e      # 158 项端到端
pnpm test:package  # 发行冒烟（打包→解压→在解压环境验证关键路径）
pnpm lint          # ESLint
pnpm build         # 构建全部包 + web
pnpm run 3rd:init  # 初始化子模块（首次）
pnpm run 3rd:build # 安装 graphify Python 依赖
pnpm run 3rd:setup # 下 anydoc + 编译 llama.cpp + OCR 模型（可选）
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
| `deployment-model.md` | 部署形态（多 harness / 单激活、多会话共享） |
| `model-negotiation.md` | 边界声明：Prism 不参与子 agent 管理与模型选择 |
| ~~`work-queue.md`~~ | **已废弃**（工作队列移除；富化改宿主直付，见该文顶部） |

---

## 9. 许可证

MIT。`3rd/` 下是 git submodule，各自保留原始许可证（archify: MIT；graphify: Apache-2.0 + MIT 双许可；llama.cpp: MIT），再分发时须一并保留。


## 检索接口破坏性变更（v13）

`/api/kb/search` 与 `prism_kb_search` 的 `value` 从裸结果数组改为 `{ results, chunk_scan_degraded?, hits_truncated? }` 信封（条目内新增可选 `hits` 段级命中）。控制台已适配；直接消费 HTTP 的第三方需改读 `value.results`。
