# Prism 知识与图谱注入设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：Prism 的知识库与代码图谱如何"进入"宿主 agent 的工作上下文。
> 原则：**Prism 负责产出上下文包，宿主负责决定是否注入、如何注入**（控制面定位）。

---

## 1. 问题

知识和图谱不会自动出现在 agent 的上下文里。Prism 必须通过 ZCode 真实支持的通道把内容送进去，否则知识库就是个孤岛。

**ZCode 侧可用的通道（已核实）**：

| 通道 | 证据 | 能力 |
| :--- | :--- | :--- |
| **MCP server** | `~/.zcode/cli/config.json` 的 `mcp.servers.<name>`（`type: stdio` + command/args/env） | 宿主 agent 可**主动调用** Prism 工具 |
| **AGENTS.md** | 项目级 `AGENTS.md` 被 ZCode 读取（weave 等仓库在用） | 静态约定、指引 |
| **Skills** | `~/.zcode/skills/` + `~/.agents/skills/`，`~/.zcode/cli/config.json` 有 `skills` 启用开关 | 可被触发的技能 |
| **角色文件正文** | `~/.zcode/agents/*.md` 正文即系统提示词 | 角色自带知识绑定声明 |

---

## 2. 三种注入模式

| 模式 | 机制 | 适用 | 谁决定 |
| :--- | :--- | :--- | :--- |
| **A. 拉取（Pull）** | 宿主 agent 主动调 MCP 工具 | 探索性查询、按需深挖 | **宿主/agent** |
| **B. 上下文包（Context Package）** | Prism 生成带预算的知识包，宿主注入子 agent prompt | 派发任务时的**保证性上下文** | Prism 产出，宿主注入 |
| **C. 静态注入（Static）** | 写入 AGENTS.md / skill 文件 / 角色正文 | 约定、指引、"该用什么工具" | Prism 写，ZCode 读 |

**三者互补**：C 告诉 agent"有什么可用"，A 让 agent 按需查，B 保证关键上下文不缺席。

---

## 3. 模式 A：MCP 拉取

### 3.1 接入配置

Prism 提供 `prism mcp install` 写入 ZCode 配置：

```json
// ~/.zcode/cli/config.json
{
  "mcp": {
    "servers": {
      "prism": {
        "type": "stdio",
        "command": "node",
        "args": ["<PRISM_HOME>/bin/prism-mcp.js"],
        "env": { "PRISM_HOME": "<PRISM_HOME>" },
        "timeoutMs": 60000
      }
    }
  }
}
```

### 3.2 工具面

| 工具 | 作用 |
| :--- | :--- |
| `prism_kb_search` | 检索知识（层/书/模块过滤，默认返回最新版次） |
| `prism_kb_get` | 取单条全文（可指定版次） |
| `prism_kb_tree` | 浏览 层→书→模块 结构 |
| `prism_kb_deposit` | 落库（宿主说落就落） |
| `prism_graph_query` | 代码图谱查询（BFS/DFS） |
| `prism_graph_path` | 两节点最短路径 |
| `prism_graph_explain` | 节点解释 |
| `prism_graph_affected` | 变更影响面（review-analysis） |
| `prism_team_activate` | 拉取团队运行时配置 |
| `prism_team_new` | 新建团队定义（写显式 `teams_dir`；与 HTTP `POST /api/teams` 同一实现；v6 由 `prism_team_create` 更名） |
| `prism_skill_effective` | 有效 Skill 集（角色 × 团队；与 HTTP `/api/skills/effective` 同一装配点） |
| `prism_kb_versions` | 条目版本历史（降序 + `is_latest`） |
| `prism_context_pack` | 生成上下文包（模式 B；入参见 §4.2） |

**关键**：每个返回都带**来源地址**（`层/书/模块/规则ID@版次` 或 `文件:行号`），便于 agent 引用与溯源。

---

## 4. 模式 B：上下文包

### 4.1 何时用

派发子 agent 任务时，某些知识**必须**在上下文里（如安全红线、编码规范）。让 agent 自己去查可能漏查。

### 4.2 生成方式

```
宿主：prism_context_pack {
  role: "security-auditor",
  task: "审计 src/auth.ts 的变更",
  budget_tokens: 4000,
  // 以下全部可选（缺省 = 用角色绑定 / 600 字符）；HTTP 同名 query 参数亦可
  layers: ["global", "project"],   // 显式覆盖角色绑定的层集合
  books: ["security-redline"],     // 显式覆盖角色绑定的书过滤
  symbols: ["validateToken", "src/auth.ts"],  // 代码符号/路径：命中 → relevance ×1.15
  max_excerpt_chars: 600
}
   ↓
Prism 按角色知识绑定 + 任务关键词检索，组装带预算的包
   ↓
返回 { items: [...], normalized_by, total_chars, truncated: bool, sources: [...] }
```

HTTP 等价面：`GET /api/kb/context-pack?role=&task=&budget_tokens=&layers=&books=&symbols=&max_excerpt_chars=`

### 4.3 包的结构

```json
{
  "role": "security-auditor",
  "task_summary": "审计 src/auth.ts 的变更",
  "items": [
    {
      "id": "SEC-RED-007",
      "version": 3,
      "title": "禁止明文存储凭证",
      "layer": "global",
      "book": "security-redline",
      "module": "credential",
      "excerpt": "...",
      "relevance": 0.91,
      "source": "global/security-redline/credential/SEC-RED-007@v3",
      "graph_hits": ["validateToken"]
    }
  ],
  "normalized_by": "candidate_max",
  "total_chars": 3820,
  "truncated": false
}
```

**`relevance` 是跨查询不可比的**：它以**本次候选**的最高 `score` 归一（`normalized_by: "candidate_max"`），
只用于包内排序，不可当绝对相关度存起来比较。

`graph_hits` 是**命中的 `symbols` 子串**（判定基 = 条目 `title` + `excerpt`，大小写敏感），
不是图谱节点。**边表邻近度（`graph_distance`）本轮未实现**（队长裁决 A3，记技术债，
见 `knowledge-base.md` §图谱联动的未实现承诺）。

### 4.4 宿主如何注入

**Prism 只产出包，不控制 prompt。** 宿主自行决定：

- 拼进子 agent 的 prompt 开头；
- 或作为附件文件让 agent 读取；
- 或只注入 `sources` 让 agent 按需查。

**Prism 的职责边界**：产出结构化包 + 标注来源；**不替宿主写 prompt**。

### 4.5 预算与排序

| 项 | 规则 |
| :--- | :--- |
| 预算 | 调用方给定 `budget_tokens`，Prism 截断并标 `truncated` |
| 相关度乘法链 | `base = min(1, score/maxScore)` → `× layerWeight` → `× freshnessFactor` → `× graphBoost` → **末尾 `clamp(0,1)`**（design-v4 F-B1/F-B2） |
| 分层权重 | `role 1.0 / project 0.85 / global 0.72`（同相关性下 role 层优先） |
| 新鲜度 | `freshnessFactor = 0.9 + 0.1 × clamp(freshness, 0, 1)`；**`freshness` 缺省视为 1.0 → 因子恰为 1.0**（不改变既有排序） |
| 图谱命中 | `symbols` 命中 `title`+`excerpt`（大小写敏感子串）→ `× 1.15`；命中的符号写进 `items[].graph_hits` |
| 版本 | 默认只取最新版次 |

---

## 5. 模式 C：静态注入

### 5.1 注入什么

| 目标 | 内容 | 作用 |
| :--- | :--- | :--- |
| 项目 `AGENTS.md` | 团队约定、可用 MCP 工具清单、"先查图谱再改代码"等指引 | 让宿主 agent 知道有什么 |
| 角色文件正文 | 该角色的知识绑定（层/书） | 角色自带范围声明 |
| Skill 文件 | Prism 的能力封装（如"如何用 Prism 查知识"） | 可触发的技能 |

### 5.2 AGENTS.md 注入示例

```markdown
<!-- prism:begin -->
## Prism 知识库与代码图谱

本项目已接入 Prism。回答架构/规范问题前，先查询 Prism：

- 知识检索：`prism_kb_search`（支持按层/书/模块过滤）
- 代码图谱：`prism_graph_query` / `prism_graph_path` / `prism_graph_explain`
- 变更影响面：`prism_graph_affected`
- 团队知识包：`prism_context_pack`

知识分层：global（公司规范）/ project（本项目）/ role（专家专属）。
引用时请标注来源地址（如 `global/java-standards/exception-handling/JAVA-01-002@v2`）。
<!-- prism:end -->
```

**用标记块包裹**，便于增量更新而不破坏用户手写内容。

### 5.3 冲突与安全

| 情况 | 处理 |
| :--- | :--- |
| AGENTS.md 已有 prism 块 | 只更新块内内容 |
| AGENTS.md 无 prism 块 | 追加到末尾 |
| AGENTS.md 不存在 | 创建 |
| 用户手改块内内容 | 下次更新会覆盖（块内视为 Prism 管辖） |

---

## 6. 代码图谱的注入特点

代码图谱与知识库不同：**它的数据量可能很大**（本机 weave 图谱 1450 节点 / 3003 边）。

| 方式 | 适用 | 说明 |
| :--- | :--- | :--- |
| MCP 查询（推荐） | 精确问题 | `query`/`path`/`explain` 返回子图，**不返回全图** |
| Studio 嵌入 | 人看 | iframe 嵌 Graphify Studio（控制台侧，不进 agent 上下文） |
| 图谱命中加权 | 上下文包 | 图谱命中代码符号时提升关联知识 |

**关键原则**：**绝不把全图塞进 agent 上下文**。图谱的价值是"用查询换 token"——这正是 Graphify 的 71.5 倍 token 节省来源。

---

## 7. 完整数据流

```
装配期（一次性）
  Prism → 写角色文件到 ~/.zcode/agents/
  Prism → 写 MCP 配置到 ~/.zcode/cli/config.json
  Prism → 写指引到项目 AGENTS.md（模式 C）

运行期
  宿主 agent 启动
    → 读 AGENTS.md（知道 Prism 可用）
    → 需要知识时调 MCP（模式 A）
    → 派发子 agent 时请求上下文包（模式 B）
    → 执行完经 MCP 回报 Prism（台账 + 沉淀）
```

---

## 8. 职责边界

| 做 | 不做 |
| :--- | :--- |
| 提供 MCP 工具 | 不替宿主决定何时调用 |
| 产出带预算的上下文包 | 不替宿主写 prompt |
| 写 AGENTS.md 指引块 | 不覆盖用户手写内容 |
| 返回来源地址供溯源 | 不把全图/全库塞进上下文 |

---

## 9. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 三种注入模式是否都要 | ⏳ 全要 / 先 A+C / 先 A |
| 2 | MCP 配置是否自动写入 `~/.zcode/cli/config.json` | ⏳ 自动写 / 提示手动 |
| 3 | AGENTS.md 注入是否默认开启 | ⏳ 默认开 / 需显式命令 |
| 4 | 上下文包默认预算 | ⏳ 4000 tokens / 按角色配 |
| 5 | 上下文包是否自动附加到派发 | ⏳ Prism 自动请求 / 宿主主动调 |
| 6 | 代码图谱是否也做上下文包 | ⏳ 只做 MCP 查询 / 也做包 |
