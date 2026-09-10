import type { PrismSkill, SkillAsset } from '../types.js'
import { PRISM_MARKER_PREFIX, prismSkillMarker } from '../marker.js'

/**
 * `prism` 元 skill（skill-loading.md §6.5 / prism-skill.md）：
 * 教宿主**如何使用 Prism**——六大模块的 MCP 工具、CLI、团队启用链路、知识沉淀约定。
 *
 * 组织原则（prism-skill.md §4 渐进披露）：主 SKILL.md 只放判定表与骨架，
 * 细节进 `references/`，按需读取——避免每次触发都把全部细节塞进上下文。
 * - name kebab-case；description 含触发词且 ≤1024 字符（含冒号 → 必须 YAML 双引号）；
 * - marker 写在 frontmatter 之后的独立 HTML 注释行（design-v3 §5 P12）。
 */
const PRISM_SKILL_CONTENT = `---
name: prism
description: "使用 Prism 平台能力时触发：检索/沉淀知识（kb）、查询知识图谱与代码图谱（graph）、渲染架构图（arch）、启用团队与派发角色（team/role）、领取 LLM 待办（work）、登记与回报任务（task）。或用户提到 prism、PRISM_HOME、知识库、落库、代码图谱、影响面、架构图、启用团队、任务台账时使用。注意：纯代码结构问答优先 graphify；本 Skill 负责 Prism 服务接入与资产消费。"
---

${prismSkillMarker('prism')}

# Prism 使用手册（元 Skill）

Prism 是本机的**研发效能控制面**：知识库、知识图谱、代码图谱、架构图谱、专家角色与团队、工作队列、任务台账。
**它不执行任务、不调 LLM、不调度 agent**——只提供资产与台账；执行归宿主（你）。

## 0. 快速路径：先看状态，再决定查还是建

**回答任何「项目怎么做的 / 规范是什么 / 谁调用谁」之前，先确认资产存在**，不要盲目重建：

| 要查什么 | 先看状态 | 有产物 → | 没产物 → |
| :--- | :--- | :--- | :--- |
| 知识（规范/红线/决策） | \`prism_kb_stats\` | 直接 \`prism_kb_search\` | 告知「知识库为空」，问用户是否导入 |
| 代码结构（调用/影响面） | \`prism_graph_status\` | 直接 \`prism_graph_query\` | 提示先 \`prism graph build <项目根>\` |

**关键**：\`graphify-out/graph.json\` 已存在且用户只是问问题 → **直接查询，不要重新建图**。
建图只在这些情况发生：用户明确要求、产物不存在、或 \`status\` 报陈旧且用户同意重建。

## 1. 快速判定：什么时候用哪个

| 用户意图 | 用什么 | 细节 |
| :--- | :--- | :--- |
| 查规范 / 安全红线 / 架构决策 | \`prism_kb_search\` → \`prism_kb_get\` | [references/knowledge.md](references/knowledge.md) |
| 用户说「记住 / 沉淀 / 落库」 | \`prism_kb_deposit\`（必带来源） | [references/knowledge.md](references/knowledge.md) |
| 知识之间的引用关系 / 找关联条目 | \`prism_kb_graph\` | [references/knowledge.md](references/knowledge.md) |
| 谁调用谁 / 影响面 / 最短路径 | \`prism_graph_query/path/affected/explain/god-nodes\` | [references/graph.md](references/graph.md) |
| 画架构图 / 时序图 / 数据流图 | \`prism arch render\`（CLI） | [references/arch.md](references/arch.md) |
| 派团队干活 | 先 \`prism_team_activate\` 看 dispatch，再派发 | [references/team.md](references/team.md) |
| 有需要 LLM 的活（向量化/摘要/抽取） | \`prism_work_pending\` → claim → complete | [references/work.md](references/work.md) |
| 登记任务 / 回报状态 / 看依赖图 | \`prism_task_register/report/status\` | [references/task.md](references/task.md) |
| 环境自检 / 换宿主 / 打包 | \`prism doctor\` / \`prism harness show\` | [references/cli.md](references/cli.md) |

## 1.5 第一次接入：从零到能用

\`\`\`bash
prism init --zcode-dir <宿主根>   # ①探测 ②建骨架 ③装本 Skill ④写 MCP 注册 ⑤提示重启
prism doctor                       # 自检：Node 版本 / 目录 / DB / graphify / 端口
prism serve --port 7777            # 起 HTTP 服务 + 控制台
\`\`\`

**验收标准**（\`prism doctor\` 应全绿）：
- Node ≥ 22.5；\`PRISM_HOME\`（默认 \`~/.prism\`）可写；
- \`graphify\` 可调用（\`3rd/graphify\` 或 PATH）；
- MCP 注册已写入宿主配置；Skill 已装到 \`skills_dir\`。

**装完必须重启宿主**——MCP 工具与 Skill 在会话启动时加载，当前会话看不到。
**首次建图**：\`prism graph build <项目根> --name <项目名>\`（Python graphify，零 LLM）。
**首次导入知识**：\`prism kb import <file.md> --layer global --book <书>\`。

## 2. 团队启用链路（最关键，别搞错）

1. \`prism_team_activate { team_id }\` 返回 \`members[].dispatch\`：
   - \`native\`：角色已装进宿主目录，直接 \`subagent_type: "<角色名>"\` 派发；
   - \`fallback\`：未装——用 \`general-purpose\` 派发，并把它返回的 \`definition\`（核心契约 + 职责）粘进 prompt 开头；交付报告须注明「降级派发」。
2. 角色文件在**会话启动时扫描一次**：新装/改写的角色要**下一会话**才能 native 派发。
3. 装配：\`prism role import --from <宿主agents目录> --zcode-dir <宿主根>\`，或 \`prism role init <name>\`。

## 3. 硬约定（违反会被评审打回）

| 约定 | 说明 |
| :--- | :--- |
| **先查后答** | 回答「项目怎么做的/规范是什么」前先 \`prism_kb_search\`，不要凭空编 |
| **标注来源** | 引用知识必须带来源地址：\`层[/owner]/书/模块/ID@版次\` |
| **沉淀带来源** | \`prism_kb_deposit\` 必带 \`deposited_by\`（谁/团队）；安全红线类强制 \`layer: global\` |
| **图谱换 token** | 用查询拿子图，**绝不读全图**；先 \`prism_graph_status\` 看是否陈旧 |
| **不抢调度** | Prism 不派发任务；派发是宿主的活 |
| **不调 LLM** | 需要 LLM 的活落成 work_request，由你（宿主）拉取执行 |

## 4. 四个「不」（边界）

- **不侵入调度**：子 agent 管理归宿主，Prism 不碰；
- **不调 LLM**：Prism 零 API key，LLM 工作走工作队列；
- **不做审核**：宿主说落库就落库，Prism 只记录/可视化/审计；
- **不管版本控制**：Prism **不读 git、不提交、不推送、不写 .gitignore**。
  它只回答「文件在不在」；提交/更新是宿主的职责——**宿主做完任务后自行提交，
  再触发 \`prism kb sync\` / \`prism graph build\` 刷新索引**。

## 4.5 诚实规则（引用 Prism 数据时必须遵守）

- **查不到就说查不到**：\`prism_kb_search\` 无命中 → 明确告知「知识库没有这条」，**不要用常识补全**；
- **引用必带来源地址**：格式 \`层[/owner]/书/模块/ID@版次\`，便于人回溯；
- **陈旧要标注**：\`prism_graph_status\` 报 \`stale: true\` 或知识条目 \`freshness\` 低 → 回答时说明「可能已过期」；
- **不编边**：图谱没有的关系不要推断；\`confidence\` 字段（EXTRACTED/INFERRED）照实呈现；
- **不读全图**：用查询拿子图（\`limit\`/\`depth\` 有界），避免把整张图塞进上下文。

## 5. 工具速查（30 个 MCP 工具）

| 分组 | 工具 |
| :--- | :--- |
| 知识库（11） | \`prism_kb_search\` \`prism_kb_get\` \`prism_kb_deposit\` \`prism_kb_graph\` \`prism_kb_tree\` \`prism_kb_stats\` \`prism_kb_catalog\` \`prism_kb_path\` \`prism_kb_remove\` \`prism_kb_conflicts\` \`prism_kb_resolve_conflict\` |
| 代码图谱（7） | \`prism_graph_query\` \`prism_graph_path\` \`prism_graph_explain\` \`prism_graph_affected\` \`prism_graph_god_nodes\` \`prism_graph_summary\` \`prism_graph_status\` |
| 角色团队（6） | \`prism_role_list\` \`prism_role_get\` \`prism_role_render\` \`prism_context_pack\` \`prism_team_get\` \`prism_team_activate\` |
| 工作队列（3） | \`prism_work_pending\` \`prism_work_claim\` \`prism_work_complete\` |
| 任务台账（3） | \`prism_task_register\` \`prism_task_report\` \`prism_task_status\` |

> **MCP 与 CLI 的分工**：需要结构化调用（宿主 agent 用）优先 MCP；一次性/交互式操作（人在终端用）
> 走 CLI。架构图渲染（\`prism arch render\`）只有 CLI/HTTP，没有 MCP 工具。

## 6. CLI 速查

\`\`\`
prism init [--zcode-dir <宿主根>] [--yes]     # 接入：注册 MCP + 装 Skill + 建骨架
prism serve [--port 7777]                     # HTTP API + 控制台
prism doctor                                   # 环境自检
prism harness list | show                      # 运行时宿主适配器
prism kb     import/sync/search/get/tree/stats/graph/path/remove/conflicts/resolve/export/reindex
prism graph  build/query/path/explain/affected/god-nodes/summary/export/status
prism project add/list/show/remove          项目台账（登记后 kb sync 可扫）
prism arch   types/validate/render             # 架构图谱（五类图）
prism role   list/show/init/import/validate/render/install
prism team   list/show/validate/install/activate
prism skill  list/install
prism work   pending/enqueue/claim/complete/fail/reclaim/stats
prism task   list/show/graph/register/report/stats
\`\`\`

**写守卫**：目标是默认宿主目录且未显式指定时会拒绝（\`guard_required\`），需 \`--yes\` 或显式 \`--zcode-dir\`。
`

/** 附带文件：按需读取的细节（渐进披露）。 */
const PRISM_SKILL_ASSETS: SkillAsset[] = [
  {
    path: 'references/knowledge.md',
    content: `# 知识库（prism_kb_*）

## 内容模型

\`层 → 书 → 模块 → 条目\`。三层：\`global\`（公司级）/ \`project\`（项目级）/ \`role\`（专家专属）。
未归类的条目落 \`_inbox/\`（DB \`module=''\`）。

## 检索（prism_kb_search）

- 中文检索用 **bigram + unicode61**——两字词（如「性能」）能命中，四字词也行；
- 默认**只返回每个 id 的最新版次**；要全部版次传 \`all_versions: true\`；
- 过滤：\`layers\` / \`owner\` / \`book\` / \`module\` / \`limit\`；
- 每条结果带 \`source\`（\`层[/owner]/书/模块/ID@版次\`）与 \`excerpt\`。

**回答时必须标注来源**，让用户能溯源。

## 取单条（prism_kb_get）

- 不带版本 → 最新版；
- 带版本（\`ID@vN\`）→ 该版次；若已 superseded 会附带 \`superseded_by\`。

## 落库（prism_kb_deposit）

必填：\`title\` \`type\` \`layer\` \`book\` \`content\`；\`project\`/\`role\` 层必填 \`owner\`。

- 同 \`id\` 再次落库 → **版次 +1**（旧版置 superseded，不覆盖历史）；
- \`type\`：rule / doc / guide / pitfall / pattern / diagram / summary / other；
- \`risk\`：low / medium / high（供团队规则用，Prism 不据此判审）；
- **沉淀必须带 \`deposited_by\`**（\`{ subject, team? }\`）；
- 安全红线类知识强制 \`layer: global\`。

## 结构树（prism_kb_tree / prism kb tree）

\`层→书→模块\` 的计数结构，用于回答「知识库里有什么」。MCP 工具 \`prism_kb_tree\` 与 CLI \`prism kb tree [--layer <层>]\` 等价。

## 知识图谱（prism_kb_graph）

单一边表 + 多视图。边来自确定性抽取（零 LLM）：

| relation | 来源 |
| :--- | :--- |
| \`references\` | 正文双链 \`[[条目id]]\` |
| \`overrides\` | frontmatter 显式层间覆盖 |

- 不给 \`id\` → 全图概览（按度数排序）；
- 给 \`id\` → 该节点 BFS 邻域（\`depth\` 1-3）；
- 节点带 \`in_degree\`/\`out_degree\`；悬空引用保留在边上但不进节点列表。

## 手工改过文件后

正文是**真相**、DB 只是索引。手工编辑过 Markdown 后跑 \`prism kb reindex\` 重建索引与边表。
`,
  },
  {
    path: 'references/graph.md',
    content: `# 代码图谱（prism_graph_*）

引擎：**Graphify**（vendored 子工程，tree-sitter AST，**代码零 token**）。
产物：\`<项目根>/graphify-out/\`（graph.json / manifest.json / graph.html / GRAPH_REPORT.md）。

## 先看状态（prism_graph_status）

返回 \`stale\` / \`changed_files\` / \`total_files\`。**陈旧就先建图**（或提示用户）。

**没建图时**（\`graph_not_found\` 或 \`graph_exists: false\`）：
不要反复重试查询——直接告诉用户「该项目还没建图」，并给出命令
\`prism graph build <项目根> --name <项目名>\`。建图是**显式动作**，由用户决定何时执行。

## 查询工具

| 工具 | 用途 | 关键参数 |
| :--- | :--- | :--- |
| \`prism_graph_query\` | BFS 遍历找相关节点 | \`q\`、\`dfs\` |
| \`prism_graph_path\` | 两节点最短路径 | \`from\` \`to\` |
| \`prism_graph_explain\` | 单节点及其邻居 | \`node\` |
| \`prism_graph_affected\` | **变更影响面**（反向遍历） | \`node\` \`depth\`（默认 2） |
| \`prism_graph_god_nodes\` | 枢纽节点排行 | \`top\` |
| \`prism_graph_summary\` | 规模统计（节点/边/社区） | — |

节点标签形如 \`handler()\`（函数）、\`app.py\`（文件）；返回带 \`src=文件 loc=行号\`。

## 使用原则

- **用查询换 token，不要读全图**；
- 影响面分析用 \`prism_graph_affected\`（反向遍历），不要自己猜；
- 改代码前先 \`affected\` 看波及范围，改完提示重新建图。

## CLI 等价

\`\`\`bash
prism graph build <目录> --name <项目名>      # 建图（零 LLM）
prism graph query "<问题>" --project <名>
prism graph path "A" "B" --project <名>
prism graph affected "<节点>" --depth 2 --project <名>
\`\`\`

## 与 graphify Skill 的分工

纯代码结构问答（「这个函数干嘛的」）优先用宿主自带的 **graphify** Skill；
需要**影响面 / 与 Prism 知识关联 / 跨会话台账**时用 Prism 的图谱工具。
`,
  },
  {
    path: 'references/team.md',
    content: `# 角色与团队（prism_role_* / prism_team_*）

## 概念

- **角色 = 决策契约**：核心第一原则（冲突时牺牲什么）+ 职责 + 边界 + 能力白名单（Skill）+ 知识绑定（层/书）；
- **团队 = 成员引用角色 + 固定工作流 + 沉淀规则 + 优先级 + 仲裁链**。

角色/团队**直接住在宿主目录**（\`<roles_dir>/*.md\`、\`<teams_dir>/<id>/AGENTS.md\`）。

## 启用链路（照做）

1. \`prism_team_activate { team_id }\` → 返回：
   - \`members[]\`：每个角色的 \`installed\`（是否已装）+ \`dispatch\`（\`native\`/\`fallback\`）；
   - \`workflow\` / \`deposit\` / \`arbitration\` / \`rework_limit\`。
2. 按 \`dispatch\` 派发：
   - \`native\` → \`subagent_type: "<角色名>"\`；
   - \`fallback\` → \`general-purpose\` + 把返回的 \`definition\`（核心契约 + 职责）粘进 prompt；报告注明「降级派发」。
3. **角色文件在会话启动扫描一次**——新装角色要下一会话才 native。

## 查看定义

- \`prism_role_list\`：角色库（含 \`issues\` 校验警告）；
- \`prism_role_render { name, model?, thought_level? }\`：渲染成宿主格式（含 \`target\` 路径）；
- \`prism_team_get { team_id }\`：团队定义全文。

## 装配（CLI）

\`\`\`bash
prism role import --from ~/.zcode/agents --zcode-dir ~/.zcode   # 从宿主目录导入
prism role init my-role                                          # 从模板新建
prism role validate dev-1                                        # 校验
prism team install core-dev                                      # 校验成员 + 确保团队文件
\`\`\`

## 沉淀规则（团队定义里）

团队定义含 \`deposit\`：默认层/类型/优先级/是否必带说明 + 匹配规则。
完成任务时按团队规则 \`prism_kb_deposit\`，**带来源（任务 ID + 角色）**。
`,
  },
  {
    path: 'references/work.md',
    content: `# 工作队列（prism_work_*）

## 为什么有它

Prism **不调 LLM**（零 API key）。需要 LLM 的活落成待办，由**你（宿主）拉取执行**：

| kind | 用途 |
| :--- | :--- |
| \`embed\` | 知识向量化（RAG） |
| \`summarize\` | 知识摘要 |
| \`classify\` | 标签/分类 |
| \`extract_entities\` | 实体/关系抽取（进知识图谱） |
| \`diagram_ir\` | Archify 图表 IR 撰写 |

## 拉取式流程

\`\`\`
prism_work_pending { kind?, limit? }        → 列出待办（优先级降序）
prism_work_claim { id, claimed_by }         → 认领，拿 attempt_token + deadline
   ↓ 你用自己的 LLM 执行
prism_work_complete { id, attempt_token, result }  → 回填（Prism 校验后入库）
\`\`\`

## 并发与护栏

- **同一任务不会被两个宿主认领**（原子迁移 + token）；
- 回填必须带 \`attempt_token\`，迟到的回填会被拒；
- 结果按 kind 做 **schema 校验**（如 \`embed\` 校验维度与数值有限），失败置 failed 并附原因；
- 认领超时（默认 30min）会回收为待办；失败未超上限（默认 3 次）也会回收；
- 积压超上限（默认 1000）停止入队。

## 什么时候检查待办

完成任务后、会话结束时，可调 \`prism_work_pending\` 看有没有 Prism 委派的活。
`,
  },
  {
    path: 'references/task.md',
    content: `# 任务台账（prism_task_*）

## 定位

**被动台账**——任务由你（宿主/队长）创建推进，Prism 只记录、可视化、审计。
Prism **不派发、不推进、不重试**。

## 登记 DAG（prism_task_register）

\`\`\`
{ dag_id, session_id, team_id, project_id, version, difficulty,
  tasks: [{ id, description, depends_on?, write_scopes?, assigned_agent?, stage? }] }
\`\`\`

- 校验：任务 id 唯一、\`depends_on\` 必须同批内存在、**无环**（Kahn 拓扑排序）；
- 同 \`dag_id\` 重复登记是**幂等**的（不重复写）；
- 登记**不触发执行**。

## 回报状态（prism_task_report）

\`\`\`
{ task_id, to_status, by, from_status?, expected_revision?, result?, error_type? }
\`\`\`

- **状态机判定**：14 态、32 条合法转移；非法转移直接拒绝（\`invalid_status_transition\`）；
- **乐观并发**：\`from_status\` / \`expected_revision\` 不符 → \`task_stale_revision\`；
- 每次回报 \`revision + 1\`，写审计。

常见转移：\`WAITING → RUNNING → COMPLETED\`；\`RUNNING → FAILED\`；\`FAILED → WAITING\`（重试）。

## 查询（prism_task_status）

- 带 \`task_id\` → 单任务；
- 带 \`dag_id\` → 该 DAG 的任务 + 依赖图（\`edges\`）；
- 都不带 → 列表 + 统计。

## CLI 等价

\`\`\`bash
prism task register --dag d1 --file dag.json --session s1 --team core-dev --project prism
prism task report T-1 --to RUNNING --by dev-1
prism task graph d1
\`\`\`
`,
  },
  {
    path: 'references/arch.md',
    content: `# 架构图谱（prism arch，CLI）

引擎：**Archify**（vendored 子工程，MIT）。IR 是源、HTML 是派生。

## 五类图

| type | 数据来源 |
| :--- | :--- |
| \`architecture\` | 模块聚类 + 依赖边 → 组件/边界/连接 |
| \`sequence\` | CALLS 边 + flows → 参与者/消息 |
| \`lifecycle\` | 状态机 → 泳道/状态/转移 |
| \`dataflow\` | 数据读写边 → 阶段/节点/流转 |
| \`workflow\` | 团队 DAG 工作流 → 泳道/节点/边 |

## 用法

\`\`\`bash
prism arch types                              # 列出五类
prism arch validate architecture ir.json      # 校验 IR（schema + 布局）
prism arch render architecture ir.json        # 渲染自包含 HTML
prism arch render architecture ir.json --book order-platform --module order   # 归到书/模块
\`\`\`

**产物归属**：\`--book/--module\` 把产物归到知识库的书/模块下，渲染时同时写
\`<name>.meta.json\`（作用域 + archify 版本 + IR 哈希 + 标题）。界面在
「知识库 → 点开书 → 架构图」按作用域过滤显示，子标签 [预览 | IR | 元数据]。
不带 \`--book\` 的产物不属于任何书，只出现在全量列表里。

## IR 要点

- 必填 \`schema_version: 1\`、\`diagram_type\`、\`meta.title\`；
- \`architecture\` 组件类型枚举：\`frontend/backend/database/cloud/security/messagebus/external\`；
- 组件需显式 \`pos: [x,y]\` + \`size: [w,h]\`（或用 \`layout.mode: grid\` + \`cols\`）；
- 校验不通过**不会产出坏图**（\`archify_validation_failed\`）。

## HTTP 等价

\`POST /api/arch/render { type, ir, name?, book?, module? }\` → 落 \`<PRISM_HOME>/archify/<type>/<name>.html\`；
\`GET /api/arch/diagrams?book=&module=\` 按作用域列出产物；
\`GET /api/arch/ir/:type/:file\` 取 IR 源 + 元数据；
\`GET /api/arch/preview/:type/:file\` 可在控制台 iframe 预览。
`,
  },
  {
    path: 'references/cli.md',
    content: `# CLI 与运维

## 接入初始化

\`\`\`bash
prism init --zcode-dir <宿主根>    # ①探测 ②建骨架 ③装 Skill ④写 MCP 注册 ⑤提示重启
prism doctor                        # 环境自检（Node/目录/DB/graphify/端口）
\`\`\`

**写守卫**：目标为默认宿主目录且未显式指定 → 拒绝（\`guard_required\`）；加 \`--yes\` 或显式 \`--zcode-dir\`。

## 运行时宿主适配器（prism harness）

Prism 编译期支持多 harness、**运行期只激活一个**：

优先级：\`PRISM_HARNESS\` 环境变量 > \`<PRISM_HOME>/prism.yaml\` 的 \`harness\` 键 > 默认 \`zcode\`。

\`\`\`bash
prism harness list     # 已编译适配器 + 当前激活项 + 来源
prism harness show     # 当前适配器约定（角色目录/团队目录/Skill 目录/派发机制/模型声明）
\`\`\`

## 配置（<PRISM_HOME>/prism.yaml）

\`\`\`yaml
harness: zcode
roles_dir: ~/.zcode/agents
teams_dir: ~/.zcode/teams     # roles_dir 同级——不在 agents/ 内（避免被宿主当 agent 扫到）
skills_dir: ~/.zcode/skills
\`\`\`

\`PRISM_HOME\` 默认 \`~/.prism\`，可用环境变量覆盖。

## 服务与控制台

\`\`\`bash
prism serve --port 7777
\`\`\`

控制台页面：知识库 / 代码图谱 / 角色 / 团队 / 技能 / 任务中心 / 工作队列。
（知识图谱与架构图谱**没有一级页**——它们归入「知识库 → 点开一本书 → 详情面板」。）

## 打包

\`\`\`bash
pnpm run package      # → dist/prism-<version>.tgz（解压即用，无需 pnpm install）
\`\`\`
`,
  },
]

/** prism 元 skill：教宿主如何使用 Prism（随 `prism init` / `prism skill install` 安装）。 */
export const prismSkill: PrismSkill = {
  name: 'prism',
  description:
    '使用 Prism 平台能力时触发：检索/沉淀知识（kb）、查询知识图谱与代码图谱（graph）、渲染架构图（arch）、启用团队与派发角色（team/role）、领取 LLM 待办（work）、登记与回报任务（task）。或用户提到 prism、PRISM_HOME、知识库、落库、代码图谱、影响面、架构图、启用团队、任务台账时使用。注意：纯代码结构问答优先 graphify；本 Skill 负责 Prism 服务接入与资产消费。',
  content: PRISM_SKILL_CONTENT,
  assets: PRISM_SKILL_ASSETS,
  builtin: true,
}

/** 断言内置 skill 自身合法（防模板被改坏后静默装出坏 skill）。 */
export function assertBuiltinSkillsValid(): void {
  for (const skill of builtinSkills) {
    const marker = `${PRISM_MARKER_PREFIX}skill: ${skill.name})`
    if (!skill.content.includes(marker)) {
      throw new Error(`内置 skill 缺少 Prism marker: ${skill.name}`)
    }
  }
}

/** 全部内置 skill（design-v3 §3.2 listBuiltinSkills）。 */
export const builtinSkills: PrismSkill[] = [prismSkill]
