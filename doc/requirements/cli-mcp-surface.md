# Prism CLI 与 MCP 命令面（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：完整的 CLI 子命令与 MCP 工具清单。

> ## ⚠ v4 修订（2026-09-11，功能迭代第二轮）
>
> 本文下方仍是 2026-09-09 的讨论稿；以下为**当前实现增量**，与下方冲突时以本节与 `README.md` 为准：
>
> **新增 CLI**：`team init <id>`（建队脚手架 + 自动校验 + 写守卫）、`kb structure show|generate|freeze`（书结构：总纲/模块清单/固化/继承）、`kb versions <id>`（条目版次历史）、`kb deposit`（按团队沉淀策略落库）、`skill effective --role [--team]`（Skill 有效集）、`task report --deposit`（终态沉淀建议 + 一步落库）。
> **新增 MCP 工具**（4）：`prism_kb_versions`、`prism_kb_book_structure`、`prism_skill_effective`、`prism_team_create`——**工具总数以 `tools/list` 实测为准**（本轮由 31 增至 35）。
> **新增/变更 HTTP**：`GET /api/kb/versions/:id`、`GET|POST /api/kb/book-structure`、`GET /api/skills/effective?role=&team=`、`POST /api/teams`（`teams_dir` 必填、无 env 回落）、`GET /api/teams` 增只读 `teamsDir`、`GET /api/kb/context-pack` 增 `layers/books/symbols/max_excerpt_chars`。
> **已废弃**：工作队列（`prism_work_*` 工具、`work` 命令、`/api/work/*`）——见 `work-queue.md` 顶部；下方 §1 的 `work` 分组与 §2.5 已失效。同理 `uninit` / `harness detect` / `skill sync` 均未实现。

---

## 1. CLI 命令

```
prism
├── init                    接入初始化（注册 MCP + 复制 Skill + 建目录骨架）
├── uninit                  撤销接入
├── serve                   启动服务（控制台 + MCP HTTP）
├── doctor                  环境自检（ZCode 探测、目录、权限、版本）
│
├── harness
│   ├── show                显示 ZCode 适配器约定
│   └── detect              探测本机 ZCode
│
├── role
│   ├── list                列出角色
│   ├── show <role>         查看角色定义
│   ├── render <role>       渲染 ZCode 格式（预览，不写盘）
│   ├── install <role>      复制到 ~/.zcode/agents/
│   ├── import              从 ~/.zcode/agents/ 导入
│   └── validate            校验角色定义
│
├── team
│   ├── list                列出团队
│   ├── show <team>         查看团队定义
│   ├── install <team>      装配：批量复制成员角色
│   ├── activate <team>     启用：输出运行时配置（含装配状态）
│   └── validate <team>     校验（角色存在、工作流引用合法）
│
├── skill
│   ├── list                列出 Prism Skill
│   ├── sync                同步复制到 ~/.zcode/skills/
│   └── validate            校验 SKILL.md frontmatter
│
├── kb                      知识库
│   ├── import <file>       导入（anydoc 转换 → 落库）
│   ├── search <query>      检索
│   ├── get <id>[@version]  取单条
│   ├── tree [layer/book]   浏览结构
│   ├── deposit             落库（从 stdin/文件）
│   ├── stats               统计
│   ├── graph [id]          知识图谱邻域/概览（--depth/--limit/--relations）
│   ├── path <from> <to>    两节点最短路径
│   └── reindex             以文件为真相重建索引（手工改过知识文件后用）
│
├── arch                    架构图谱（Archify 子工程）
│   ├── types               列出五类图
│   ├── validate <type> <ir.json>   校验 IR（schema + 布局）
│   └── render <type> <ir.json>     渲染为自包含 HTML
│
├── graph                   代码图谱（Python 版 graphify）
│   ├── build <project>     建图（graphify <root> + cluster-only --no-label，零 LLM）
│   ├── query <q>           BFS 遍历查询
│   ├── path <a> <b>        最短路径
│   ├── explain <node>      节点解释
│   ├── affected <node>     变更影响面（--depth）
│   ├── god-nodes           枢纽节点（--top）
│   ├── summary             图谱规模统计
│   └── status              陈旧状态
│
├── task
│   ├── list [--dag --status]   任务台账（被动记录）
│   ├── show <task>             任务详情
│   ├── graph <dag>             依赖图（文本）
│   ├── register --dag <id> --file <dag.json>   批量登记 DAG（不触发执行）
│   ├── report <task> --to <S> --by <who>       状态回报（状态机校验）
│   └── stats                   台账统计
│
├── work
│   ├── pending [--kind]    列出待办工作（拉取式）
│   ├── enqueue --kind <k> --payload <json>  入队
│   ├── claim <id> --by <who>                认领（签发 attempt token）
│   ├── complete <id> --token <t> --result <json>
│   ├── fail <id> --token <t>                显式失败（未超重试上限则回收）
│   ├── reclaim             超时回收
│   └── stats               队列水位
│
└── audit
    └── query               审计查询
```

**全局选项**：`--home <path>`（覆盖 PRISM_HOME）、`--json`（机器可读输出）。

---

## 2. MCP 工具清单

### 2.1 知识库

| 工具 | 作用 |
| :--- | :--- |
| `prism_kb_search` | 检索（层/书/模块过滤，默认最新版次） |
| `prism_kb_get` | 取单条（可指定版次） |
| `prism_kb_tree` | 浏览 层→书→模块 结构 |
| `prism_kb_deposit` | 落库（宿主说落就落） |
| `prism_kb_graph` | 查询知识图谱（邻域/概览；relations 过滤） |

### 2.2 代码图谱

| 工具 | 作用 |
| :--- | :--- |
| `prism_graph_query` | 查询（BFS/DFS） |
| `prism_graph_path` | 最短路径 |
| `prism_graph_explain` | 节点解释 |
| `prism_graph_affected` | 变更影响面 |
| `prism_graph_summary` | 图谱统计（节点/边/社区） |
| `prism_graph_god_nodes` | 枢纽节点排行 |

### 2.3 团队与角色

| 工具 | 作用 |
| :--- | :--- |
| `prism_team_activate` | 拉取团队运行时配置（含装配状态） |
| `prism_team_get` | 查看团队定义 |
| `prism_role_get` | 查看角色定义 |
| `prism_role_list` | 列出角色 |

### 2.4 上下文

| 工具 | 作用 |
| :--- | :--- |
| `prism_context_pack` | 生成带预算的上下文包 |

### 2.5 工作队列

| 工具 | 作用 |
| :--- | :--- |
| `prism_work_pending` | 列出待办 |
| `prism_work_claim` | 认领 |
| `prism_work_complete` | 回填 |

### 2.6 任务台账

| 工具 | 作用 |
| :--- | :--- |
| `prism_task_register` | 批量登记 DAG |
| `prism_task_report` | 回报状态 |
| `prism_task_status` | 查询状态 |

### 2.7 宿主声明

| 工具 | 作用 |
| :--- | :--- |
| `prism_host_declare` | 宿主声明模型清单与能力（可选） |

### 2.8 会话

| 工具 | 作用 |
| :--- | :--- |
| `prism_session_attach` | 声明会话身份（HTTP 模式） |

---

## 3. 设计约束

| 约束 | 说明 |
| :--- | :--- |
| 返回带来源 | 知识带 `层/书/模块/ID@版次`；图谱带 `文件:行号` |
| 不返回全量 | 检索/图谱返回子集，尊重预算 |
| 幂等 | init / sync / deposit 重复执行结果一致 |
| 校验前置 | 所有写操作先校验（状态机/schema/frontmatter） |
| 审计 | 关键操作写审计日志 |

---

## 4. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | CLI 命令分组 | ⏳ 待定稿 |
| 2 | MCP 工具命名前缀 | ✅ `prism_` |
| 3 | 是否提供 `--json` 全局选项 | ✅ 是 |
| 4 | MCP 传输 | ⏳ stdio / HTTP / 两者 |
| 5 | 是否暴露图谱 Studio 静态路由 | ⏳ 是（控制台需要） |
