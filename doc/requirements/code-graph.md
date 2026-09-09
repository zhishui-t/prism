# Prism 代码图谱模块设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 结论：**能力用 Graphify 工具、显示用 Graphify 页面、产物放项目根目录。**

---

## 1. 三条原则

| 原则 | 说明 |
| :--- | :--- |
| **能力用工具** | 不重造解析器。建图/查询/路径/解释全部调 `graphify` CLI |
| **显示用工具页面** | 不重画图谱。控制台 iframe 嵌 Graphify Studio |
| **产物放项目根目录** | 图谱落 `<项目根>/graphify-out/`（Python 版 graphify 实测） |

**Prism 只做编排**：触发建图、管理产物、提供查询入口、标记陈旧。**不做解析、不做渲染。**

---

## 2. 产物与落点（已实测）

| 项 | 事实 |
| :--- | :--- |
| 落点 | `<项目根>/.graphify/` |
| 实测项目 | pixo / RawFlow / weave 均如此 |
| 核心文件 | `graph.json`（图谱）、`GRAPH_REPORT.md`（报告）、`studio/`（可视化）、`flows.json`（执行流）、`manifest.json`（文件哈希） |
| 默认 graph 路径 | graphify 自身默认解析到 `<cwd>/.graphify/graph.json` |

### 2.1 为什么放项目根

- **Graphify 默认**：`graphify extract <src> --out <项目根>`；
- **就近可见**：开发者在项目里直接能看到；
- **天然隔离**：每个项目独立图谱，不互相污染；
- **可 gitignore**：`.graphify/` 通常不入版本库（Weave 的 `.gitignore` 就是这么做的）。

---

## 3. 建图

### 3.1 命令（封装 Graphify）

```bash
# 建图（零 token：跳过 LLM 富化）
graphify extract <项目根或src> --out <项目根> --no-description --no-label

# 执行流（供 sequence 图与影响面分析用）
graphify flows build --graph <项目根>/.graphify/graph.json
```

**默认零 token**：`--no-description --no-label` 跳过 LLM 富化，代码走 AST。这是 Weave 验证过的做法。

### 3.2 触发方式

| 方式 | 场景 |
| :--- | :--- |
| `prism graph build <项目>` | 手动，控制台按钮或 CLI |
| 团队启用时 | 若图谱缺失则提示/自动建 |
| 增量 | `graphify extract --update` 或重跑（manifest 哈希跳过未变文件） |

**Prism 不自动后台建图**（避免意外耗时），除非显式配置。

---

## 4. 查询面

Prism 把这些 Graphify 能力包成 MCP 工具：

| Prism 工具 | 底层命令 | 用途 |
| :--- | :--- | :--- |
| `prism_graph_query` | `graphify query "<q>" --graph ...` | 自然语言/BFS 查询 |
| `prism_graph_path` | `graphify path <a> <b>` | 两节点最短路径 |
| `prism_graph_explain` | `graphify explain <node>` | 节点解释 |
| `prism_graph_affected` | `graphify affected-flows --files ...` | 变更影响面 |
| `prism_graph_summary` | 读 `graph.json` 统计 | 节点/边/社区计数 |

**统一约束**：返回**子图/摘要**，不返回全图（避免爆上下文）。

---

## 5. 显示

| 界面 | 内容 |
| :--- | :--- |
| **代码图谱页（独立一级页）** | iframe 嵌 `<项目根>/.graphify/studio/index.html`；上方 Prism 工具栏（项目选择、建图按钮、陈旧标记、查询框） |
| 单文件导出 | `studio/studio.html`（自包含，供分享） |
| 陈旧标记 | 用 `manifest.json` 的文件哈希 + git HEAD 判断"图谱落后 N 次提交" |

**Prism 不重画图谱**——Studio 是 Graphify 预编译的 SPA，直接 serve。

**已知限制**：iframe 是黑盒，Prism 注入不了交互。工具栏放上方，联动（点节点→在 Prism 打开）待验证 Studio 是否支持 postMessage。

---

## 6. 多项目

| 项 | 做法 |
| :--- | :--- |
| 项目选择 | 控制台项目切换器，切换所 serve 的 `.graphify/` |
| 项目清单 | Prism 记录已建图的项目（含路径、建图时间、哈希） |
| 并发建图 | 同一项目同时只允许一个构建（文件锁），其余等待/拒绝 |

---

## 7. 陈旧检测

| 判据 | 说明 |
| :--- | :--- |
| 源文件哈希 | `manifest.json` 记录；对比当前文件 |
| git HEAD | 图谱构建时的 commit vs 当前 HEAD |
| 展示 | "建图于 X，落后 N 次提交 / M 个文件变更" |

**注意**：代码图谱可用 AST 增量重建（便宜），文档语义提取贵（走工作队列），两者分开标记。

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
| serve Studio 页面 | 不重画图谱 |
| 管理产物与陈旧标记 | 不自动后台建图（除显式配置） |
| 封装查询为 MCP 工具 | 不把全图塞进上下文 |

---

## 10. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 能力来源 | ✅ 用 Graphify 工具 |
| 2 | 显示方式 | ✅ 用 Graphify Studio 页面（iframe） |
| 3 | 产物落点 | ✅ `<项目根>/.graphify/` |
| 4 | 默认建图参数 | ⏳ `--no-description --no-label`（零 token）/ 含富化 |
| 5 | 建图触发 | ⏳ 仅手动 / 团队启用时自动 |
| 6 | 多项目图谱合并 | ⏳ 用 `graphify merge-graphs` / 不合并 |
