# Prism CLI 与 MCP 命令面（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：完整的 CLI 子命令与 MCP 工具清单。

> ## ⚠ v4 修订（2026-09-11，功能迭代第二轮）
>
> 本文下方仍是 2026-09-09 的讨论稿；以下为**当前实现增量**，与下方冲突时以本节与 `README.md` 为准：
>
> **新增 CLI**：`team new <id>`（建队脚手架 + 自动校验 + 写守卫；v6 由 `team init` 更名）、`kb structure show|generate|freeze`（书结构：总纲/模块清单/固化/继承）、`kb versions <id>`（条目版次历史）、`kb deposit`（按团队沉淀策略落库）、`skill effective --role [--team]`（Skill 有效集）、`task report --deposit`（终态沉淀建议 + 一步落库）。
> **新增 MCP 工具**（4）：`prism_kb_versions`、`prism_kb_book_structure`、`prism_skill_effective`、`prism_team_create`（v6 更名 `prism_team_new`）——**工具总数以 `tools/list` 实测为准**（v4 由 31 增至 35；v5 多项目图谱合并（F-C2）再增至 36；**v6 角色/团队补齐增删改，36 → 43**；**v6.2 补 MCP Skill 写入口 `skill_list|install|uninstall`，43 → 46**）。
> **新增/变更 HTTP**：`GET /api/kb/versions/:id`、`GET|POST /api/kb/book-structure`、`GET /api/skills/effective?role=&team=`、`POST /api/teams`（`teams_dir` 必填、无 env 回落）、`GET /api/teams` 增只读目录字段、`GET /api/kb/context-pack` 增 `layers/books/symbols/max_excerpt_chars`。
> **v6 写路由补齐（2026-09-12）**：`POST /api/roles`、`PATCH|DELETE /api/roles/:name`、`PATCH|DELETE /api/teams/:id`；`GET /api/roles` 返回体由裸数组改为 `{ roles, … }`（与 `/api/teams` **同形**）。写路径的 `roles_dir` / `teams_dir` **必填**。
> **v6 CLI 命令面统一（2026-09-12）**：role/team 统一为增删改查——`role init` / `team init` 更名 `new`，新增 `edit|rm`（team 另有 `render`）；**移除** `role install|import`、`team install`（装配语义移除，角色/团队直接住宿主目录，见 `harness-adapters.md` 顶部）。§1 树已按 v5 体例标注。
> **v6.1 参数契约统一（2026-09-12）**：读写两侧的**目录键名一律 snake_case 且同名**——`GET /api/roles` → `{ roles, roles_dir }`、`GET /api/teams` → `{ teams, teams_dir }`（旧 camel `rolesDir`/`teamsDir` 前端仍兼容，但它已不是契约）；`prism_role_list` 的 `agents_dir` 更名为 `roles_dir`（zcode 遗留名，与写参数不同名会让宿主回填失败）。`prism_team_new` / `POST /api/teams` 新增**可选** `roles_dir`（成员角色校验用；缺省才回落默认角色库）。
> **已废弃**：工作队列（`prism_work_*` 工具、`work` 命令、`/api/work/*`）——见 `work-queue.md` 顶部；下方 §1 的 `work` 分组与 §2.5 已失效。同理 `uninit` / `harness detect` / `skill sync` 均未实现。

---

## 1. CLI 命令

> **v5 取齐说明**（2026-09-11，逐条核对 `packages/cli/src/commands/*`）：下文用
> `❌ 未实现` 标注**从来不存在**的命令、用 `⚠ 已废弃` 标注被移除的分组——**保留原文以留决策痕迹**，
> 但不要把它们当可用命令。
>
> **v6 取齐说明**（2026-09-12）：role/team 统一为增删改查（`new|edit|rm`），下方 role/team 两棵树
> 已就地补齐现行命令并标注更名/移除；当前命令面以 `README.md` §5 为准。

```
prism
├── init                    接入初始化（注册 MCP + 复制 Skill + 建目录骨架）
├── uninit                  撤销接入  ❌ 未实现
├── serve                   启动服务（控制台 + MCP HTTP）
├── doctor                  环境自检（ZCode 探测、目录、权限、版本）
│
├── harness
│   ├── list                列出可用适配器
│   ├── show                显示当前适配器约定（agent/skill/dispatch/model/instructions）
│   └── detect              探测本机 ZCode  ❌ 未实现
│
├── role
│   ├── list                列出角色
│   ├── show <role>         查看角色定义
│   ├── new <name>          新建角色（写守卫；--from 复制既有定义；v6 由 init 更名）
│   ├── edit <name>         字段补丁（只改点名字段，正文不重排；v6 新增）
│   ├── rm <name>           删除角色文件本体（不可逆；v6 新增）
│   ├── validate            校验角色定义
│   ├── render <role>       渲染当前 harness 原生格式（预览，不写盘；target = 真实落点）
│   ├── install <role>      复制到 ~/.zcode/agents/  ⚠ 已废弃（v6 装配语义移除）
│   └── import              从 ~/.zcode/agents/ 导入  ⚠ 已废弃（v6 装配语义移除）
│
├── team
│   ├── list                列出团队
│   ├── show <team>         查看团队定义
│   ├── new <id>            建队脚手架（写守卫 + 自动校验；v6 由 init 更名）
│   ├── edit <id>           修改团队（改 members 时工作流按名册就地收窄；v6 新增）
│   ├── rm <id>             删除团队文件本体（不可逆；v6 新增）
│   ├── render <team>       渲染宿主格式团队文件（v6 新增）
│   ├── validate <team>     校验（角色存在、工作流引用合法）
│   ├── activate <team>     启用：输出运行时配置（含装配状态）
│   ├── init <id>           建队脚手架（写守卫 + 自动校验；v4 新增）⚠ v6 更名 team new
│   └── install <team>      装配：批量复制成员角色  ⚠ 已废弃（v6 装配语义移除）
│
├── skill
│   ├── list                列出 Prism Skill
│   ├── install             安装内置 Skill 到宿主 skills 目录
│   ├── update              强制覆盖重装（v4）
│   ├── uninstall           删除已装 Skill（v4）
│   ├── effective           有效集（global ∪ team ∪ role；v4）
│   ├── sync                同步复制到 ~/.zcode/skills/  ❌ 未实现
│   └── validate            校验 SKILL.md frontmatter
│
├── kb                      知识库
│   ├── import <file>       导入（anydoc 转换 → 落库）
│   ├── convert <file>      仅转换不落库（v4）
│   ├── enrich              宿主产出的富化结果回写（零 LLM，R2）
│   ├── search <query>      检索
│   ├── get <id>[@version]  取单条
│   ├── tree [layer/book]   浏览结构
│   ├── history [id]        条目/来源变更历史
│   ├── stats               统计
│   ├── deposit             落库（从 stdin/文件；按团队策略）
│   ├── sync <项目>         扫描项目目录建「引用型」索引（项目文件为真相）
│   ├── structure show|generate|freeze  书结构（总纲/模块清单/固化/继承；v4）
│   ├── versions <id>       条目版次历史（v4）
│   ├── graph [id]          知识图谱邻域/概览（--depth/--limit/--relations）
│   ├── path <from> <to>    两节点最短路径
│   ├── remove / restore    软删 / 恢复
│   ├── conflicts / resolve 层间冲突查看与解决
│   ├── export              导出（Graphify 图谱 / 全库）
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
│   ├── report <task> --to <S> --by <who>       状态回报（状态机校验；--deposit 一步沉淀）
│   └── stats                   台账统计
│
├── work                    ⚠ 已废弃（v4：工作队列移除，富化改宿主直付——见 work-queue.md 顶部）
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

> **v6.2 取齐说明**（2026-09-12）：工具总数 = **46**（`packages/server/src/mcp/server.ts` 内
> `name: 'prism_*'` 逐条计数）。v4 由 31 增至 35；v5 多项目图谱合并（F-C2）新增 `prism_graph_merge`
> （代码图谱 7 → 8）到 **36**；v6 把「角色 / 团队」补齐成**增删改查**（`new|edit|rm` 在 CLI / HTTP / MCP
> 三入口**同名同位**）——新增 `prism_role_new|edit|rm`、`prism_team_list|edit|rm|render` 共 7 个，
> 并把 `prism_team_create` **更名**为 `prism_team_new`（团队与角色对称）到 **43**；
> v6.2 补上 **Skill 写入口**（`prism_skill_list|install|uninstall`）——此前宿主 agent
> 无法经 MCP 装 Skill，是接口审查中唯一确认的**真能力缺口**，补齐后 skill 装/卸三入口齐。
> 下文原文缺漏的工具已在各节补齐；
> `❌ 未实现` = 全仓 grep 0 命中、**从未存在**的工具。
>
> **口径已入守卫**：本文件与 `README.md` 的「总数 + 分组小计」由
> `packages/server/test/tool-surface-drift.test.ts` 对着 `createMcpTools` 实测锁定——
> 改工具集时两处会红，不再静默漂移。

### 2.1 知识库（17）

| 工具 | 作用 |
| :--- | :--- |
| `prism_kb_search` | 检索（层/书/模块/可见性过滤，默认最新版次） |
| `prism_kb_get` | 取单条（可指定版次；返回 `deposited_by` / `provenance`） |
| `prism_kb_deposit` | 落库（宿主说落就落；可带团队沉淀策略） |
| `prism_kb_convert` | 文档转 Markdown（**不落库**，零 LLM/零网络） |
| `prism_kb_import` | 扫描项目目录建「引用型」索引 |
| `prism_kb_enrich` | 宿主产出的富化结果回写（零 LLM） |
| `prism_kb_graph` | 查询知识图谱（邻域/概览；relations 过滤） |
| `prism_kb_tree` | 浏览 层→书→模块 结构 |
| `prism_kb_stats` | 知识库统计 |
| `prism_kb_catalog` | 目录/清单视图 |
| `prism_kb_path` | 两节点最短路径 |
| `prism_kb_remove` | 删除（软删默认；被引用禁止硬删） |
| `prism_kb_restore` | 恢复软删条目 |
| `prism_kb_conflicts` | 层间冲突清单 |
| `prism_kb_resolve_conflict` | 解决冲突 |
| `prism_kb_versions` | 条目版次历史（v4 新增） |
| `prism_kb_book_structure` | 书结构（总纲/模块清单/固化/继承；v4 新增） |

### 2.2 代码图谱（8）

| 工具 | 作用 |
| :--- | :--- |
| `prism_graph_query` | 查询（BFS/DFS） |
| `prism_graph_path` | 最短路径 |
| `prism_graph_explain` | 节点解释 |
| `prism_graph_affected` | 变更影响面 |
| `prism_graph_summary` | 图谱统计（节点/边/社区） |
| `prism_graph_god_nodes` | 枢纽节点排行 |
| `prism_graph_status` | 陈旧状态（原文漏列） |
| `prism_graph_merge` | 多项目图谱合并（v5 / F-C2 新增） |

### 2.3 团队与角色（13）

> **v6**：补齐增删改——`new|edit|rm` 与 CLI（`prism role|team new|edit|rm`）、
> HTTP（`POST|PATCH|DELETE /api/roles[/:name]`、`POST|PATCH|DELETE /api/teams[/:id]`）**同名同位**。
> 写路径的目录参数（`roles_dir` / `teams_dir`）**必填**——一律显式参数化，防误写真实宿主目录。
>
> **v6.1**：`prism_role_list` 返回 `roles_dir`（= 写参数名，读回即可回填）；`prism_team_new` 增**可选**
> `roles_dir`（成员角色校验用，与 `prism_team_edit` 对齐；缺省才回落当前角色目录）。

| 工具 | 作用 |
| :--- | :--- |
| `prism_role_list` | 列出角色库（数据源 = 当前角色目录）。返回 `{ count, roles, roles_dir }`——`roles_dir` 即要回填给 `prism_role_new\|edit\|rm` 的值（v6.1 由 `agents_dir` 更名） |
| `prism_role_get` | 查看角色定义（全文） |
| `prism_role_new` | 新建角色（按**宿主原生形态**落盘：frontmatter 只含适配器白名单字段，skills / 知识绑定落正文小节；v6 新增） |
| `prism_role_edit` | 修改角色（字段补丁：`description`/`skills`/`knowledge`/`body`/`color`/`model`/`thought_level`；正文不重排；v6 新增） |
| `prism_role_rm` | 删除角色文件本体（**不可逆**；`roles_dir` 必填；v6 新增） |
| `prism_role_render` | 渲染宿主格式角色文件（原文漏列） |
| `prism_team_list` | 列出团队库（v6 新增） |
| `prism_team_get` | 查看团队定义 |
| `prism_team_new` | 新建团队定义（`teams_dir` 必填；`roles_dir` 可选＝成员角色校验用；v4 新增为 `prism_team_create`，v6 更名） |
| `prism_team_edit` | 修改团队（`name`/`description`/`members`/`deposit`；改 `members` 时**工作流表按名册就地收窄**；v6 新增） |
| `prism_team_rm` | 删除团队文件本体（**不可逆**；`teams_dir` 必填；v6 新增） |
| `prism_team_render` | 渲染宿主格式团队文件（v6 新增） |
| `prism_team_activate` | 拉取团队运行时配置（含装配状态） |

> **三入口的能力边界（有意不对称；2026-09-12 审查后明确，v6.2 收口）**：
>
> | 能力 | CLI | MCP | HTTP | 说明 |
> | :--- | :--- | :--- | :--- | :--- |
> | `render`（预览宿主形态） | ✅ role/team | ✅ | ❌ | 本地开发/排障工具，控制台不需要 |
> | `validate` | ✅ role（全量）/ team（单条） | ❌ | ❌ | 校验结果随 `list`/`detail` 的 `issues` 返回，无需独立入口 |
> | Skill 写（install/uninstall/update） | ✅ | ✅ | ✅ | **v6.2 已补齐**（原为唯一真缺口）：`skill list|install|uninstall` ↔ `prism_skill_list|install|uninstall` ↔ `POST /api/skills/install|uninstall` |
> | `--from`（从既有定义复制） | ✅ role/team | ❌ | ❌ | 便于人手写；机器侧「读→改」即可 |
> | 指定写目录 | ✅ `--source`（role=roles_dir / team=teams_dir） | ✅ 必填 | ✅ 必填 | team 侧另可用 `--roles-dir` 指定成员校验库 |
>
> 其余不对称属**取舍**——文档不应把它们描述成「三入口全等」。
> 三入口真正严格对齐的是**动词与落盘语义**：`new|edit|rm` ↔ `POST|PATCH|DELETE`，同一实现单点。

### 2.4 上下文（1）

| 工具 | 作用 |
| :--- | :--- |
| `prism_context_pack` | 生成带预算的上下文包（v4 增 `layers/books/symbols/max_excerpt_chars`） |

### 2.5 Skill（4）

| 工具 | 作用 |
| :--- | :--- |
| `prism_skill_effective` | Skill 有效集（global ∪ 团队声明 ∪ 角色声明；v4 新增） |
| `prism_skill_list` | 列出内置 Skill + 宿主是否已装；返回 `skills_dir`（= 写参数名，读回即可回填；v6.2 新增） |
| `prism_skill_install` | 安装内置 Skill 到显式 `skills_dir`（人写的同名 Skill 不覆盖，写 `.prism-new` 供对比；v6.2 新增） |
| `prism_skill_uninstall` | 卸载 Skill（**只删 Prism 产物**；人写的保留并记入 `kept`；v6.2 新增） |

### 2.6 工作队列 ⚠ 已废弃（0）

| 工具 | 作用 |
| :--- | :--- |
| `prism_work_pending` | 列出待办  ❌ 未实现（工作队列已于 v4 移除） |
| `prism_work_claim` | 认领  ❌ 未实现 |
| `prism_work_complete` | 回填  ❌ 未实现 |

### 2.7 任务台账（3）

| 工具 | 作用 |
| :--- | :--- |
| `prism_task_register` | 批量登记 DAG |
| `prism_task_report` | 回报状态（可一步沉淀） |
| `prism_task_status` | 查询状态 |

### 2.8 宿主声明 / 会话 ❌ 未实现（0）

| 工具 | 作用 |
| :--- | :--- |
| `prism_host_declare` | 宿主声明模型清单与能力  ❌ 未实现（全仓 grep 0 命中） |
| `prism_session_attach` | 声明会话身份（HTTP 模式）  ❌ 未实现（全仓 grep 0 命中） |

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

> **v5 收口（2026-09-11）**：下表 1/4/5 项按实现回填状态——CLI 分组以 §1 正文（已取齐）为准；
> MCP 传输**只实现了 stdio**（`packages/server/src/mcp/server.ts:1314/1358`，
> `node dist/mcp/server.js`），**无 `/mcp` HTTP 端点**（`packages/server/src/app.ts:140-141` 只注册了
> `/studio/:project`）；Studio 静态路由**已实现**（`http/routes/studio.ts:55`）。

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | CLI 命令分组 | ✅ 已随实现定稿（见 §1 取齐说明） |
| 2 | MCP 工具命名前缀 | ✅ `prism_` |
| 3 | 是否提供 `--json` 全局选项 | ✅ 是 |
| 4 | MCP 传输 | ✅ **stdio 已实现**；HTTP 端**未实现**（仍待定） |
| 5 | 是否暴露图谱 Studio 静态路由 | ✅ 是（控制台需要，已实现） |
