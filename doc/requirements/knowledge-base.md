# Prism 知识库需求文档（讨论稿 v0.4）

> 状态：**讨论稿，待继续确认**
> 日期：2026-09-08
> 范围：本文只讲「知识库」模块。代码图谱、Agent-Team、团队定义等模块另文。
> 原则：本模块一切设计服从 **Prism 纯控制面定位**（不侵入宿主 agent 调度、不自己调 LLM）。

---

## 0. 已确认决策（v0.4 简化：Prism 不做审核）

| # | 决策项 | 结论 |
| :--- | :--- | :--- |
| D1 | 知识存储位置 | **Prism 运行数据目录**集中管理（不写进被分析的项目仓库） |
| D2 | 书内模块划分 | **自动建议 + 人工固化**：Graphify 社区发现出建议，人工确认后冻结 |
| D3 | 落库门禁 | **Prism 不判审**：宿主（或其团队流程）说落库就落库；Prism 只做校验与记录 |
| D4 | 富化默认开关 | **默认开启**（配预算护栏与队列积压上限） |
| D5 | 沉淀规则归属 | **写在团队定义（团队 AGENTS.md）里**：谁可沉淀、优先级、何时沉淀 |
| D6 | ~~能否自审~~ | 已废弃——Prism 不参与审核主体判定 |
| D7 | 人工导入 | 人在控制台导入直接落库；Prism 不额外加审 |
| D8 | 设计公理 | **分类分层给定位、图谱联系给发现**，两套正交系统（图书馆隐喻） |
| D9 | 书与 Graphify 语料粒度 | **一本书一个语料**；模块级/书级图谱是边表的过滤视图 |
| D10 | Archify 分发 | **vendor 进仓库**：CLI 自包含零运行时依赖，按路径调用 |
| D11 | 图表自动生成范围 | **五类图全自动**（能确定性推导的零 LLM，语义类走工作队列） |
| D12 | 中文检索实现 | **bigram 切分 + unicode61**（trigram 检索不了两字中文词，实测修正） |

---

## 1. 定位与边界

### 1.1 知识库是什么

Prism 知识库是**知识的存储、组织、检索与分发中心**。它不负责执行任务，只负责"把正确的知识，以正确的粒度，给到正确的角色"。

> **定位一句话**：Prism 是**库房管理员**，不是审核员。宿主说落库就落库；谁审、怎么排优先级是**团队自己的规矩**（写在团队定义里）。

### 1.2 职责边界

| 做 | 不做 |
| :--- | :--- |
| 存储知识（文件为真相 + 索引） | 不自己调 LLM（富化走工作队列交宿主） |
| 组织为 层→书→模块→条目 | 不侵入宿主 agent 调度 |
| 格式校验 + 冲突检测 + 留痕 | **不判断谁有权落库、不做审核链** |
| 检索与上下文包分发 | 不生成最终业务结论 |
| 图谱构建与上卷 | 不重写 Graphify/Archify 渲染器 |

### 1.3 三种入口

| 入口 | 触发方 | 落库条件 |
| :--- | :--- | :--- |
| 控制台导入 | 人上传文件 | 转换后直接落库 |
| agent 导入 | 宿主 agent 主动写入 | 宿主说落就落 |
| agent 沉淀 | 任务完成后宿主总结回填 | 宿主说落就落；沉淀规则见团队定义 |

---

## 2. 内容模型（核心）

### 2.1 设计公理：一座大图书馆

**分类分层（层级系统）与图谱联系（关系系统）是两套正交系统，缺一不可。**

- 层级系统回答「这条知识在哪、属于谁、谁可见」——给**定位**；
- 关系系统回答「哪些知识相关」——给**发现**。
- 只有层级 = 死目录；只有图谱 = 无根漂移。

| 图书馆 | Prism |
| :--- | :--- |
| 分馆/馆藏分区 | 层（global / project / role） |
| 书 | Book |
| 章节 | Module |
| 页/条目 | 知识条目 |
| 索书号 | 地址 `层/书/模块/规则ID` |
| 目录/导览 | 总纲报告 |
| 参见 / 互见 / 索引 | 知识图谱（双链 + 关系边） |
| 分类法 | 模块结构（`_modules.yaml`） |

**推论一：单一边表 + 多视图。** 全库只有一张关系边表；book 级/模块级图谱只是它的过滤视图，不是各自独立的图谱存储。

**推论二：分类要稳，联系可动。** 分类结构人工固化（D2），图谱边随重建演化并给出建议 diff。

### 2.2 四层内容结构

```
Layer 层（global | project | role）
  └── Book 书（一个知识域）
        ├── 总纲报告
        ├── 知识图谱（book 级视图）
        ├── 架构图谱（Archify）
        └── Module 模块
              ├── 内容规则（rule_id + 正文）
              ├── 知识图谱（module 级视图）
              ├── Archify 图谱
              └── 子模块（可选，递归）
```

### 2.3 三个分层轴（不要混淆）

| 轴 | 分层 | 回答 |
| :--- | :--- | :--- |
| 知识库 | global / project / role | 这条知识**谁能看见** |
| Skill | global / team / role | 这个能力**谁有权限用** |
| 内容 | 层→书→模块→条目 | 知识**怎么组织** |

### 2.4 地址与溯源

```
global/java-standards/exception-handling/JAVA-01-002@v2
  │        │              │                 │      └─ 版次（见 §12.2）
  │        │              │                 └─ 规则编号（稳定 ID）
  │        │              └─ 模块
  │        └─ 书
  └─ 层
```

### 2.5 条目类型

| 类型 | 说明 |
| :--- | :--- |
| `rule` | 规则条目（带编号） |
| `doc` | 普通文档 |
| `guide` | 指南/教程 |
| `pitfall` | 踩坑记录 |
| `pattern` | 模式/最佳实践 |
| `diagram` | 图表（Archify IR + 渲染产物） |
| `summary` | 总纲报告 |
| `other` | 其他 |

### 2.6 生命周期

```
active ──→ deprecated
  │
  └──→ superseded（被新版次取代）

（candidate 为可选中间态，仅在团队启用人工过一道时使用）
```

### 2.7 模块划分机制（D2）

```
Graphify 社区发现 → 模块建议
        ↓ 人工确认/调整
      固化 _modules.yaml（含 revision、frozen_at、confirmed_by）
        ↓ 后续重建
   结构不变，只出"建议变更" diff
```

**未归类落点**：新条目若不属于任何已固化模块，落 **`_inbox/` 待归类暂存区**，不自动塞入已固化结构；由人工或后续确认归档（见 §12.1）。

---

## 3. 存储模型

### 3.1 文件为真相，数据库为索引

| 数据 | 载体 |
| :--- | :--- |
| 知识正文 | Markdown 文件（分层目录） |
| frontmatter | md 文件头部 |
| 全文索引 | SQLite FTS5（见 §5.1） |
| 元数据索引 | SQLite 表 |
| 双链/关系 | SQLite 单一边表 |
| 向量（可选） | 可插拔 `VectorIndex` |

### 3.2 存储位置（D1）

```
<PRISM_HOME>/
├── knowledge/
│   ├── global/<book>/...
│   ├── project/<project-id>/<book>/...
│   └── role/<role-id>/<book>/...
├── state/          # SQLite 索引与元数据
├── audit/          # 审计日志
└── teams/          # 团队定义
```

- `<PRISM_HOME>` 可用环境变量覆盖。
- **安全提示**：数据目录**不得**位于会被升级覆盖的程序目录内；默认实现程序目录与数据目录分离。

### 3.3 目录结构

```
knowledge/<layer>/<book-slug>/
├── _summary.md              # 总纲报告
├── _graph.json              # book 级图谱视图（由边表导出）
├── _modules.yaml            # 模块清单（D2 固化）
├── _inbox/                  # 待归类暂存区（§12.1）
└── <module-slug>/
    ├── _summary.md
    ├── _graph.json          # module 级视图
    ├── <rule-id>.md
    └── <doc-slug>.md
```

### 3.4 frontmatter 字段

```yaml
---
id: JAVA-01-002
version: 2                  # 版次（§12.2）
title: 禁止吞掉异常
type: rule
layer: global
book: java-standards
module: exception-handling
status: active              # candidate|active|deprecated|superseded
risk: high                  # low|medium|high（供团队规则/优先级使用，Prism 不据此判审）
confidence: 0.9
tags: [java, exception]
created: 2026-09-08
updated: 2026-09-08
freshness: 0.95
source:
  kind: import|agent|manual
  ref: 阿里Java规范.pdf#p12
  commit: <git-sha>
visibility: global
overrides: []               # 显式覆盖的低层规则 ID（§12.3）
supersedes: null            # 被本版次取代的 id@version
deposited_by:               # 落库来源记录（非审核）
  subject: dev-1
  team: team-a
  at: 2026-09-08T10:00:00Z
---
```

---

## 4. 图谱模型

| 级别 | 内容 | 来源 |
| :--- | :--- | :--- |
| 条目级 | 条目间引用/双链 | Prism 边表 |
| 模块级 | 模块内关系 | 边表过滤视图 + 可选 Graphify |
| 书级 | 书整体图谱 | Graphify（语料 = 一本书，D9） |

> **落地方式（2026-09-10 实测）**：Graphify 处理**文档**需 LLM API key（实测报 `no LLM API key found`），与「不调 LLM」红线冲突。故改为：**Prism 零 LLM 抽边 → 转成 Graphify 的 graph.json → 交 Graphify 做社区发现/HTML 渲染/Obsidian 导出**（这些环节纯计算）。入口 `prism kb export --format html|obsidian|svg|graphml|wiki`、`POST /api/kb/export`、控制台「知识图谱」页导出下拉。产物落 `<PRISM_HOME>/graphify-kb/`。

- 模块图 → 书图用 `graphify merge-graphs` 上卷；跨书关系由 Prism 边补充。

### 4.4 架构图谱（Archify）——五类图全自动（D11）

**五类图与 IR 规格**（已从 `tt-a1i/archify` 仓库 schema 核准）：

| diagram_type | 结构数组（item 必填） | Prism 数据源 | 生成方式 |
| :--- | :--- | :--- | :--- |
| `architecture` | `components[id,type,label]` / `boundaries[kind,label,wraps]` / `connections[from,to]` | 代码图谱模块聚类 + 依赖边 | **确定性，零 LLM** |
| `sequence` | `participants[id,type,label]` / `messages[from,to,y,label]` | 代码图谱 `CALLS` 边 + Graphify `flows` | **确定性，零 LLM** |
| `lifecycle` | `lanes[id,label]` / `states[id,type,label,lane,col]` / `transitions[from,to]` | 任务状态机（14 态 32 转移）等 | **确定性，零 LLM** |
| `dataflow` | `stages[label]` / `nodes[id,type,label,stage,row]` / `flows[from,to,label]` | 图谱数据读写/存储边 | 半确定性（复杂语义走队列） |
| `workflow` | `lanes[id,label]` / `nodes[id,lane,col,type,label]` / `edges[from,to]` | 团队 DAG 工作流定义 | 半确定性（业务语义走队列） |

**关键字段**：

- `meta.title` 必填；`locale` 支持 `zh-CN`；`animation: "trace"` 开启动效；`visual_preset` 有 classic/signal-flow/blueprint/editorial。
- `architecture.meta.repository` 含 `url` + `revision`（**40 位 SHA**）→ 图表可钉到代码提交，是 Delta 对比的基础。

**渲染与对比**（CLI 自包含，零运行时依赖，node ≥18）：

```
archify validate <type> <file> --json     # 原子校验：schema/layout/HTML/SVG/route/标签避让
archify deliver  <type> <file> <out.html> # 只有校验通过才原子替换落盘
archify compare  architecture base.json head.json delta.html --json  # Before/Delta/After
```

> `compare` **只报事实，不推断影响/风险/合并安全性**——影响面分析由 Prism 图谱分析提供，Archify 只负责把差异画清楚。

**分发（D10，2026-09-10 落地）**：Archify **未发布 npm**（`archify` 这个 npm 名属另一个无关包；上游 `private: true`）。故以**子工程形式**引入 `3rd/archify/`（**v2.16.0**，MIT）：保留 `bin/` + `schemas/` + `renderers/` + `assets/` + `delta/` + `migrations/` + `scripts/` + `examples/*.json`，裁剪 `test/`、`recipes/`、`references/`、`brand-marks/` 与示例 HTML 产物。调用 `node 3rd/archify/bin/archify.mjs`（自包含零运行时依赖）。Graphify 同以子工程引入 `3rd/graphify/`（**v0.9.56**，Python 版 Graphify-Labs 上游，免构建 `python -m graphify`）；两者均见 `3rd/README.md`。

**存储**：IR 是源、HTML 是派生，两者都作为 `type: diagram` 条目；frontmatter 记录 `archify_version` + IR 哈希 + 来源图谱 commit。

---

## 5. 检索与分发

### 5.1 中文检索（实测修正）

**结论：必须用 bigram 切分 + `unicode61`，不能用 trigram。**

实测（`node:sqlite`，Node 24.15）：

| 查询 | trigram | unicode61 | bigram+unicode61 |
| :--- | :--- | :--- | :--- |
| 异常处理（4字） | ✅ | ❌ | ✅ |
| 性能 / 日志 / 接口（2字） | ❌ **0 条** | ❌ | ✅ |
| 敏感信息（4字） | ✅ | ❌ | ✅ |

原因：trigram 按 3 字符滑窗，**两字中文词永远无法命中**；而两字词是中文技术文档的主流查询。

实现：

```sql
CREATE VIRTUAL TABLE kb_fts USING fts5(body, seg, tokenize='unicode61');
-- 写入：seg = bigram(标题+正文)；查询：查询串同样 bigram 化
-- 保留 body 原文列用于高亮/摘要；英文与代码符号走 unicode61 原词
```

纯 JS 零依赖；实测全部两字/四字查询正确命中，bm25 排序可用。

### 5.2 检索能力

| 能力 | 依赖 | 状态 |
| :--- | :--- | :--- |
| 关键词/BM25 | FTS5（bigram + unicode61） | **默认，零依赖** |
| 分层/书/模块过滤 | 元数据索引 | 默认 |
| 双链/图谱邻近度 | 边表 | 默认 |
| 语义/向量 | 可插拔 `VectorIndex` | 可选（D4 默认开启富化） |
| 混合排序（RRF） | BM25 + 向量 + 图谱 | 有向量后启用 |

### 5.3 分发：上下文包

- 按 token 预算截断；
- 每条带来源地址（`层/书/模块/规则ID@版次`）；
- 按分层权重 + 新鲜度排序；
- 按角色定制（global + 项目 + 自己的 role 层）。

---

## 6. 导入与沉淀

### 6.1 流程

```
上传/写入 → 白名单校验 → anydoc 本地转换 → 预览 → 落库
  → 建索引/图谱 → 富化入队（D4）
```

### 6.2 状态机

```
uploaded → converting → converted → previewing → active
                                        ├→ cancelled
                                        └→ failed
```

> `candidate` 状态保留为可选中间态（团队若要人工过一道时使用），但 **Prism 不强制**。

### 6.3 落库规则（D3/D5/D7）

**Prism 是库房管理员，不是审核员。** 宿主（或人工）说落库，Prism 就落库，只做三件事：

1. **格式校验**：frontmatter 必填字段、ID 唯一性、层/书/模块存在性、类型合法。
2. **冲突检测**：层间冲突（§12.3）记录并提示，不阻断落库。
3. **留痕**：记录 `deposited_by`（谁、哪个团队、何时）与内容哈希，供追溯与回滚。

**"谁有权沉淀、优先级怎么排、要不要过 QA"——这些规则写在团队定义里**（团队 `AGENTS.md`），由团队自己的工作流执行。Prism 不实现审核链，不判断主体资格，不设降级。

**可选门禁**：若团队希望 Prism 强制某类知识必须带某个标记才允许落库，可在团队定义里声明 `deposit_policy`（如"rule 类型必须 `confirmed: true`"）；Prism 按声明校验，规则本身仍由团队提供。

### 6.4 转换（本地、零 LLM）

- 引擎：`@firecrawl/anydoc`（MIT，零依赖，已实测）。
- 支持：doc/docx/pdf/ppt/xlsx/epub/csv/rtf/odt → GFM Markdown。
- **边界**：图片型扫描 PDF 返回 `unsupported`，需外部 OCR（可选增强）。

### 6.5 富化（D4：默认开启，走工作队列）

| 类型 | 工作类型 | 执行方 |
| :--- | :--- | :--- |
| 摘要 | `summarize` | 宿主 agent |
| 标签/分类 | `classify` | 宿主 agent |
| 实体/关系抽取 | `extract_entities` | 宿主 agent |
| 向量化 | `embed` | 宿主 agent |

**护栏**：每层/每书可关闭；全局日预算（估算 token，§9-D4）；队列积压上限 + 降级（§12.5）；优先级由团队规则给定；富化失败不阻塞知识可用。

---

## 7. 控制台

| 页 | 内容 |
| :--- | :--- |
| 总览 | 分层统计、待富化、陈旧标记、队列水位 |
| 书详情 | 总纲、模块索引、book 级图谱、架构图 |
| 模块详情 | 条目列表、模块级图谱、架构图、规则编号 |
| 条目详情 | 正文 / 元数据 / 双链 / 版本历史 / 溯源 / 落库记录 |
| 导入向导 | 上传→转换→预览→落库 |
| 待归类 | `_inbox/` 暂存条目归档 |
| 模块建议 | 社区发现建议 vs 已固化结构 diff |
| 检索 | 全文检索 + 分层/书/模块过滤 |

**图谱显示**：**代码图谱是独立一级页**（不并入知识库，见 §11）；知识图谱在知识库内自绘（条目/模块/书切换）；架构图 iframe 预览 Archify HTML，标签页切 [预览 | IR | 元数据 | 版本历史]。

---

## 8. 对外接口

| 接口 | 用途 |
| :--- | :--- |
| MCP 工具 | 宿主 agent 检索/写入/沉淀（主通道） |
| HTTP API | 控制台与外部系统 |
| CLI | `prism kb import/search/...` |
| 文件注入 | 知识约定写入 AGENTS.md / 规则文件 |

### 8.1 MCP 工具草案

```
prism_kb_search      检索（层/书/模块过滤）
prism_kb_get         取单条（含全文，可指定版次）
prism_kb_tree        浏览 层→书→模块 结构
prism_kb_deposit     落库（写入/沉淀；带来源与团队标识）
prism_kb_graph       查询图谱（节点/路径）
prism_work_pending   列出待处理富化任务
prism_work_claim     认领
prism_work_complete  回填结果
```

> 没有 `prism_kb_review`——Prism 不做审核。

---

## 9. 已定与待定

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 存储位置 | ✅ D1 |
| 2 | 模块划分 | ✅ D2 |
| 3 | 落库门禁 | ✅ D3：Prism 不判审，宿主说落就落；沉淀规则写团队定义 |
| 4 | 富化默认 | ✅ D4 默认开启 + 预算护栏 |
| 5 | 项目知识随仓库提交 | ✅ 否 |
| 6 | instance 层 | ✅ 不保留，仅三层 |
| 7 | 书与 Graphify 语料粒度 | ✅ 一本书一个语料 |
| 8 | 规则编号 | ✅ 前缀模板 + 自动递增（`<BOOK>-<MODULE-序>-<NNN>`） |
| 9 | 富化预算口径 | ✅ 全局日预算（估算 token）+ 队列积压上限 |
| 10 | 版本与 supersede 语义 | ✅ 版次制（§12.2） |
| 11 | 层间冲突处理 | ✅ 就近覆盖 + 显式 `overrides`（§12.3） |
| 12 | 版次与检索交互 | ✅ 默认只返回最新版；显式 `ID@vN` 才命中历史版 |
| 13 | 授权主体资格 | ✅ 不需要——Prism 不判审（D3） |

---

## 10. 与其它模块的接口

| 模块 | 接口 |
| :--- | :--- |
| 代码图谱 | 条目可引用代码符号；图谱命中可反查关联知识。**代码图谱在控制台是独立一级页**（§11） |
| 架构图谱 | 图表作为 `type: diagram` 条目 |
| 专家 Agent | 按角色组装上下文包（层过滤 + Skill 授权） |
| Agent-Team | 团队工作流节点按需注入知识；沉淀规则写在团队定义里 |
| Skill 指定 | 知识可见性 × Skill 可用性双重校验 |
| 工作队列 | 富化任务交宿主执行 |
| 任务中心 | 任务完成 → 宿主按团队规则沉淀知识 |

---

## 11. 控制台信息架构（一级导航）

| 一级页 | 内容 |
| :--- | :--- |
| 知识库 | 层→书→模块→条目、知识图谱、架构图、导入、待归类、检索 |
| **代码图谱** | **独立一级页**：项目选择、建图/增量、Graphify Studio 内嵌、查询（query/path/explain）、陈旧标记 |
| 团队与角色 | 团队定义（含工作流）、角色定义（AGENTS.md） |
| 任务中心 | 任务台账 + 依赖图（被动记录，状态由执行方回报） |
| 工作队列 | 待宿主执行的富化/图表任务、水位、超时回收 |
| 审计 | 事件流水 |
| 设置 | 目录、预算、富化开关、Skill 指定 |

> 三个图谱在显示上分属不同页面（代码图谱独立、知识图谱与架构图谱归知识库），但底层关系边都进同一张全局边表（图书馆公理）。

---

## 12. 边界与护栏（本轮识别的风险及处理）

### 12.1 未归类知识落点

新条目不属于任何已固化模块 → 落 `_inbox/` 待归类暂存区，**不自动塞入**已固化结构；控制台"待归类"页处理。

### 12.2 版本与 supersede（版次制）

- 条目更新**产生新版次**（`version+1`），不原地覆盖；
- `supersedes` 指向被取代的 `id@version`；
- 审查类场景可精确定位"当时那条规则"。

**默认返回最新版**（用户 2026-09-09 确认）：

| 场景 | 行为 |
| :--- | :--- |
| 检索（`prism_kb_search`） | **只返回每个 ID 的最新版次**；历史版次不进结果集（避免同一规则重复占位） |
| 取单条（`prism_kb_get`，不指定版次） | 返回最新版 |
| 取单条（`prism_kb_get`，指定 `ID@vN`） | 返回该版次；若该版已 `superseded`，**正常返回但附带 `superseded_by` 提示** |
| 版本历史 | 单独接口/页面列出该 ID 的全部版次 |
| 显式要求全部版次 | 检索可传 `all_versions: true` 覆盖默认行为 |

### 12.3 层间冲突

- 就近覆盖：project 层可覆盖 global 层；
- 但必须**显式声明** `overrides: [GLOBAL-RULE-ID]`；
- 未声明的冲突由**冲突检测器**记录并提示，不静默取胜（不阻断落库）。

### 12.4 落库质量风险

- Prism 不做审核，但**留痕**：记录 `deposited_by`（谁/团队/何时）+ 内容哈希，支持追溯与回滚；
- 条目被引用次数异常偏高时告警（可能已污染他人上下文）；
- 批量回滚能力（按落库批次）。

### 12.5 队列积压与饿死

- 工作队列设**积压上限**，超限停止入队并告警（不无限增长）；
- 优先级由团队规则给定（Prism 只执行不判定）；
- 宿主长期不拉取时，控制台显示队列水位与最老任务年龄。

### 12.6 删除与保留

- 默认**软删**（`status=deprecated` 或 `deleted` 标记），保留审计；
- 被引用过的条目禁止硬删；
- 硬删需显式二次确认 + 审计记录。

### 12.7 读写权限

- `visibility` 只管"读"；
- 写/删的授权由**团队定义**声明，Prism 按声明校验；未声明则默认允许（库房管理员语义）。

### 11.8 增量更新的一致性

改一个条目涉及：正文文件 → FTS 索引 → 元数据 → 边表 → 图谱视图 → 失效的 Archify 图。

- 定义**更新顺序**与**事务边界**（同一 SQLite 事务内完成索引类更新，文件写后触发）；
- 失败时保留旧状态并记录，不产生半更新；
- 图谱视图是**导出物**（可从边表重建），允许最终一致。

### 11.9 超长条目

- 单条超过阈值（建议 400–800 token 正文）强制**分块**，块保留父条目 ID 与序号；
- 规则类条目**必须**可独立引用，不因分块丢失编号；
- 分块只影响检索粒度，不影响地址与编号。
