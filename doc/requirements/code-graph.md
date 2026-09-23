# Prism 代码图谱模块设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 结论：**能力用 Graphify 工具、显示用 Graphify 页面、产物放项目根目录。**

> ## ⚠ v5 修订（2026-09-11，功能迭代第三轮）
> 本文件下方仍是 2026-09-09 的讨论稿；以下为**与 Python 版 graphify（`3rd/graphify`）实测对齐的事实**，与下方冲突时以本节为准：
> - **全量建图**：`graphify <项目根> --code-only --exclude .prism`（裸路径即 `extract`，`3rd/graphify/graphify/cli.py:4725-4731`）。`--code-only` 是红线 R2 的护栏：不加它时树内有 doc/paper/image 会使 `needs_llm=True`（`cli.py:3642`）——无 LLM key 直接 exit 1、有 key **真会调 LLM**。裁决 D1：Prism 建图永不调 LLM，**不提供「含文档」开关**。
>   - `--exclude .prism` 是 **v9 F1 防自污染**：arch 产物落 `<项目根>/.prism/arch/`，而 graphify 的 `_SKIP_DIRS`（`detect.py:827-851`）只认 `graphify-out`/`.graphify`，**不认 `.prism`**——不排除就会把 Prism 自己写的 `.ir.json`/`.meta.json` 当源码扫进图里。该 flag 只有 `extract` 接受且会被持久化（`cli.py:3384-3392`），后续 `update` 复用同一 exclude 集，故增量子命令**不带**它（`update` 拒收其它 `-` 开头参数，`cli.py:2400-2414`）。
> - **聚类**：`graphify cluster-only <项目根> --no-label`（跳过 LLM 社区命名）。
> - **增量**：`graphify update <项目根>`（只重建代码、本就零 LLM；只接受 `--force/--no-cluster`，`cli.py:2400-2414`）。
> - **产物**：`graph.json` / `manifest.json` / `graph.html` / `GRAPH_REPORT.md`。**没有** `flows.json`，**没有** `studio/`。
> - **不存在的旧 flag**：`--no-description`（Python 版无此参数）；`--no-label` 只对 `cluster-only` 生效（`extract` 会静默忽略未知参数）。
> - **查询命令**：`graphify affected <node>`（**没有** `affected-flows` 子命令）。
> - **多项目合并**：`graphify merge-graphs <g1> <g2> [...] --out <out.json>`（`cli.py:2603-2621`，<2 输入报错）；Prism 封装为 `prism graph merge`，产物落 `<PRISM_HOME>/graphify-merged/`（裁决 D2：**绝不落任何项目根**）。

---

## 1. 三条原则

| 原则 | 说明 |
| :--- | :--- |
| **能力用工具** | 不重造解析器。建图/查询/解释调 `graphify` CLI；**最短路径是唯一例外**（v17 C-8）——服务端直读 `graph.json` 自求 BFS，见 §4 |
| **显示用工具页面** | 不重画图谱。控制台 iframe 嵌 Graphify Studio |
| **产物放项目根目录** | 图谱落 `<项目根>/graphify-out/`（Python 版 graphify 实测） |

**Prism 只做编排**：触发建图、管理产物、提供查询入口、标记陈旧。**不做解析、不做渲染。**

---

## 2. 产物与落点（已实测）

| 项 | 事实 |
| :--- | :--- |
| 落点 | `<项目根>/graphify-out/`（Python 版 graphify 实测） |
| 实测项目 | pixo / RawFlow / weave 均如此 |
| 核心文件 | `graph.json`（图谱）、`manifest.json`（文件哈希）、`graph.html`（可视化）、`GRAPH_REPORT.md`（报告） |
| 默认 graph 路径 | graphify 自身默认解析到 `<cwd>/graphify-out/graph.json` |
| 产物目录位置 | graphify 按 `<cwd>/graphify-out/` 落盘；Prism 以项目根为 cwd 调用，故落在项目根下（`graphify.ts` 的 `defaultGraphPath`） |

### 2.1 为什么放项目根

- **Graphify 默认**：产物落 `<cwd>/graphify-out/`；Prism 以**项目根为 cwd** 调用（不传 `--out`）；
- **就近可见**：开发者在项目里直接能看到；
- **天然隔离**：每个项目独立图谱，不互相污染；
- **可 gitignore**：`graphify-out/` 通常不入版本库。

---

## 3. 建图

### 3.1 命令（封装 Graphify）

```bash
# 建图（零 token、零 LLM：只做 AST 代码层，跳过 doc/paper/image 语义层）
# `--exclude .prism`：排除 Prism 自己的项目内产物目录（arch 的 .ir.json/.meta.json），防自污染（v9 F1）
graphify <项目根> --code-only --exclude .prism

# 聚类 + 渲染（--no-label 跳过 LLM 社区命名）
graphify cluster-only <项目根> --no-label
```

**零 token 的唯一护栏是 `--code-only`**：它跳过语义层（`cli.py:3550-3563`）；不加它则树内有文档就会要求 LLM key（或无 key 直接失败）。
`--no-description` 在 Python 版**不存在**，`--no-label` 只对 `cluster-only` 生效——两者都不能替代 `--code-only`。
`--out <目录>` 是 `extract` 的可选参数；Prism 不传，改用 cwd=项目根 的默认 `graphify-out/`。

### 3.2 触发方式

| 方式 | 场景 |
| :--- | :--- |
| `prism graph build <项目>` | 手动，**CLI 或 HTTP `POST /api/graph/build`**（控制台不提供建图按钮，见 §5） |
| 团队启用时 | 默认**只提示**，不自动动手（裁决 D3）；自动建图仅在显式参数时触发 |
| 增量 | `graphify update <项目根>`（只重建变更文件；零 LLM，manifest 哈希跳过未变文件） |

**Prism 不自动后台建图**（避免意外耗时），除非显式配置。

---

## 4. 查询面

Prism 把这些 Graphify 能力包成 MCP 工具：

| Prism 工具 | 底层命令 | 用途 |
| :--- | :--- | :--- |
| `prism_graph_query` | `graphify query "<q>" --graph ...` | 自然语言/BFS 查询 |
| `prism_graph_path` | **服务端读 `graph.json` + BFS**（v17 C-8；不再调 `graphify path`） | 两节点最短路径；响应含 `chain[{id,label,file,line,ambiguous?}]` |
| `prism_graph_explain` | `graphify explain <node>` | 节点解释 |
| `prism_graph_affected` | `graphify affected <node> --graph ...` | 变更影响面 |
| `prism_graph_summary` | 读 `graph.json` 统计 | 节点/边/社区计数 |
| `prism_graph_god_nodes` | `graphify god-nodes --graph ... --json` | 枢纽节点排行（v4 补） |
| `prism_graph_merge` | `graphify merge-graphs <g...> --out ...` | 多项目图谱合并（v5 F-C2；只读/生成型，**无 build 工具**） |

**统一约束**：返回**子图/摘要**，不返回全图（避免爆上下文）。

**v17 C-8：最短路径改由服务端自求（不再 spawn `graphify path`）**。动因：`graphify path` 只回**标签链**
（`[a, mid, b]`），而节点唯一可寻址的键是 **id**（F5-2 冻结裁决：label 跨文件重名，本仓实测 2340 节点
只有 2063 个唯一 label）。前端拿标签回查会选错节点，故把路径求解收进服务端：

- 读 `<projectRoot>/graphify-out/graph.json`（**进程内缓存**，失效键 `path+mtime+size`，只缓存 read+parse），
  建**有向**邻接（邻居按 id 排序去重，保证确定性），BFS 求最短路径；
- 入参仍是 `from`/`to`（**标签或 id 都可**）：先按 **id 精确命中**，否则按 **norm_label 唯一命中**；
  标签有歧义时取**图内节点顺序里第一个能落到 BFS 路径上的候选**（歧义端点该跳的 file/line 置空 + `ambiguous:true`，
  前端置灰）；
- 响应**新增** `chain: [{ id, label, file, line, ambiguous? }]`：每一跳的 `file`/`line` 取**发出该跳的 calls 边**
  的 `source_file`/`source_location`（末端节点无发出边 → 两者为空），既有字段（`raw`/`hops`/`found`）**全部保留**；
- `chain[].id` 可直接回喂 `prism_arch_generate.symbols`（见 `cli-mcp-surface.md §2.3` C-9）。
- **去留**：子进程封装 `graphPath` 与其单测已**删除**——三面（HTTP/MCP/CLI）全部改走 BFS 后零消费方，
  留着就是无测试覆盖的死契约面。

---

## 5. 显示

| 界面 | 内容 |
| :--- | :--- |
| **代码图谱页（独立一级页）** | iframe 嵌 `/studio/<项目名>/graph.html`（源文件 `<项目根>/graphify-out/graph.html`）；上方 Prism 工具栏（项目选择、**新窗口打开**、陈旧标记、查询框、导出）。**离线化**：graphify HTML 依赖 unpkg CDN 的 vis-network，studio 路由代理到仓库 `assets/vis-network.min.js` 并改写引用（B12） |
| 建图入口 | **控制台不提供建图按钮**（用户裁决 2026-09-10：建图与导入是宿主的职责，Web 只读）；建图走 CLI 或 `POST /api/graph/build` |
| 导出 | `POST /api/graph/export` / `prism graph export <格式>`：obsidian / wiki / svg / graphml / neo4j / falkordb / callflow-html |
| 陈旧标记 | 用 `manifest.json` 的文件哈希判断"图谱落后 M 个文件变更"（**不读 git**，见 §7） |

**Prism 不重画图谱**——Python 版 graphify 产出**自包含 `graph.html`**，Prism 的 studio 路由只做静态 serve + CDN 离线化（没有旧 npm fork 的 `studio/` SPA）。

**已知限制**：iframe 是黑盒，Prism 注入不了交互。工具栏放上方，联动（点节点→在 Prism 打开）待验证 Studio 是否支持 postMessage。

---

## 6. 多项目

| 项 | 做法 |
| :--- | :--- |
| 项目选择 | 控制台项目切换器，切换所 serve 的 `graphify-out/` |
| 项目清单 | `<PRISM_HOME>/graph/projects.json` 记录项目名 → 根路径、建图时间、扫描时间（`ProjectRegistry`） |
| 并发建图 | 同一项目同时只允许一个构建（进程内 Set + 跨进程 `<项目根>/.prism/build.lock`，30min 过期接管），其余报 `build_in_progress` |
| **多项目合并** | `prism graph merge <名...> [--out-dir <目录>]`：输入为已注册项目（各自须有 `graphify-out/graph.json`），调 `graphify merge-graphs <g1> <g2> [...] --out <out>` 后经 `cluster-only` 渲染；产物落 `<PRISM_HOME>/graphify-merged/`，**绝不落任何项目根**（裁决 D2）。节点 id 会带 repo 前缀 |

---

## 7. 陈旧检测

| 判据 | 说明 |
| :--- | :--- |
| 源文件哈希 | `manifest.json` 记录；对比当前文件内容（SHA-256/SHA-1/MD5，或 mtime） |
| 展示 | "建图于 X，M 个文件已变更" |

> **不读 git（用户裁决 2026-09-10）**：Prism 不执行 `git` 命令、不读 HEAD、不判断提交。
> 它只回答「文件内容变没变」。提交/更新是宿主的职责——**宿主做完任务后自行提交，
> 再触发 `prism graph build` / `prism kb sync` 刷新**。

**注意**：Prism 的建图**只做代码层**（全量固定 `--code-only`，见 v5 修订与裁决 D1）；文档语义提取由宿主自行用 graphify 完成，Prism 不经手（无工作队列、不调 LLM）。

---

## 8. 与知识库的联动

| 联动 | 说明 |
| :--- | :--- |
| 知识引用代码符号 | 条目可引用 `<文件>:<行号>`；图谱命中可反查关联知识 |
| 图谱命中加权 | 上下文包里，代码符号命中的知识加权 |
| 关系边统一 | 知识↔代码的关系边进同一张全局边表（图书馆公理） |

---

## 9. 边界

| 做 | 不做 |
| :--- | :--- |
| 调 graphify 建图/查询 | 不重写 AST 解析器 |
| serve 图谱页面（`graph.html`） | 不重画图谱 |
| 管理产物与陈旧标记 | 不自动后台建图（除显式配置） |
| 封装查询为 MCP 工具 | 不把全图塞进上下文 |

---

## 10. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 能力来源 | ✅ 用 Graphify 工具 |
| 2 | 显示方式 | ✅ 用 graphify 自带的 `graph.html`（iframe 预览） |
| 3 | 产物落点 | ✅ `<项目根>/graphify-out/`（合并产物例外：`<PRISM_HOME>/graphify-merged/`，裁决 D2） |
| 4 | 默认建图参数 | ✅ **全量固定 `--code-only --exclude .prism`**（零 token、零 LLM；裁决 D1，v5 落地；`--exclude .prism` 为 v9 F1 防自污染）；**无「含文档」开关** |
| 5 | 建图触发 | ⏳ 默认仅手动；团队启用时**只提示**（裁决 D3，F-C3 落地）；自动建图仅在显式参数时触发 |
| 6 | 多项目图谱合并 | ✅ 用 `graphify merge-graphs`（v5 F-C2 落地：`prism graph merge` / `POST /api/graph/merge` / `prism_graph_merge`） |
