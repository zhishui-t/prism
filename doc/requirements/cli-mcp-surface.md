# Prism CLI 与 MCP 命令面（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：完整的 CLI 子命令与 MCP 工具清单。

> ## ⚠ v4 修订（2026-09-11，功能迭代第二轮）
>
> 本文下方仍是 2026-09-09 的讨论稿；以下为**当前实现增量**，与下方冲突时以本节与 `README.md` 为准：
>
> **新增 CLI**：`team new <id>`（建队脚手架 + 自动校验 + 写守卫；v6 由 `team init` 更名）、`kb structure show|generate|freeze`（书结构：总纲/模块清单/固化/继承）、`kb versions <id>`（条目版次历史）、`kb deposit`（按团队沉淀策略落库）、`skill effective --role [--team]`（Skill 有效集）、`task report --deposit`（终态沉淀建议 + 一步落库）。
> **新增 MCP 工具**（4）：`prism_kb_versions`、`prism_kb_book_structure`、`prism_skill_effective`、`prism_team_create`（v6 更名 `prism_team_new`）——**工具总数以 `tools/list` 实测为准**（v4 由 31 增至 35；v5 多项目图谱合并（F-C2）再增至 36；**v6 角色/团队补齐增删改，36 → 43**；**v6.2 补 MCP Skill 写入口 `skill_list|install|uninstall`，43 → 46**；**v10 架构图谱接 MCP `prism_arch_generate`，46 → 47**）。
> **新增/变更 HTTP**：`GET /api/kb/versions/:id`、`GET|POST /api/kb/book-structure`、`GET /api/skills/effective?role=&team=`、`POST /api/teams`（`teams_dir` 必填、无 env 回落）、`GET /api/teams` 增只读目录字段、`GET /api/kb/context-pack` 增 `layers/books/symbols/max_excerpt_chars`。
> **v6 写路由补齐（2026-09-12）**：`POST /api/roles`、`PATCH|DELETE /api/roles/:name`、`PATCH|DELETE /api/teams/:id`；`GET /api/roles` 返回体由裸数组改为 `{ roles, … }`（与 `/api/teams` **同形**）。写路径的 `roles_dir` / `teams_dir` **必填**。
> **v6 CLI 命令面统一（2026-09-12）**：role/team 统一为增删改查——`role init` / `team init` 更名 `new`，新增 `edit|rm`（team 另有 `render`）；**移除** `role install|import`、`team install`（装配语义移除，角色/团队直接住宿主目录，见 `harness-adapters.md` 顶部）。§1 树已按 v5 体例标注。
> **v6.1 参数契约统一（2026-09-12）**：读写两侧的**目录键名一律 snake_case 且同名**——`GET /api/roles` → `{ roles, roles_dir }`、`GET /api/teams` → `{ teams, teams_dir }`（旧 camel `rolesDir`/`teamsDir` 前端仍兼容，但它已不是契约）；`prism_role_list` 的 `agents_dir` 更名为 `roles_dir`（zcode 遗留名，与写参数不同名会让宿主回填失败）。`prism_team_new` / `POST /api/teams` 新增**可选** `roles_dir`（成员角色校验用；缺省才回落默认角色库）。
> **v7 控制台交互重构（2026-09-14）**：新增 `GET /api/skills/:name`（单技能详情，控制台「点行看详情」用）。**注册顺序是硬约束**——必须排在 `/api/skills/usage`、`/api/skills/effective` **之后**，因为路由器首个匹配即命中，`:name` 会把这两条静态路由吞掉。**界面口径（非接口变更）**：`book`（书）是知识库的**内部模型概念，不对外扩散**——控制台不再暴露该层级，知识库界面只呈现 `项目 → 主题 → 知识`；`GET|POST /api/kb/book-structure` 等按书维度的接口**保持不变**，仅前端不再展示，`--book` 亦不再出现在界面提示文案里。
> **v8 扫描范围接入 `.gitignore`（2026-09-14）**：`prism kb sync` 与 MCP `prism_kb_import` 默认读**项目根 `.gitignore`**，跳过其中忽略的目录/文件——此前只按内置的 18 个通用目录名（`DEFAULT_IGNORE_DIRS`）过滤，**项目自定义的忽略一律不生效**。报告新增 `ignored_dirs: string[]`（不递归展开）与 `ignored_files: number`（**在扩展名过滤之后**计数，只有「本来会被扫」的文件才算被挡掉）；MCP 工具加可选 `respect_gitignore`（默认 `true`）。只读根这一处 `.gitignore`，**不读** `.git/info/exclude` 与全局 `core.excludesFile`。明细见 `knowledge-base.md §6.6`。
> **v9 架构图 IR 契约可得（2026-09-14）**：新增 `prism arch schema <type|common>`——打印 Archify 的 IR JSON Schema（`$defs` 走 `common`）。动因：五类图只有 `workflow` 有生成器（`prism arch from-team <team_id>`，IR 是纯函数产物），其余四类（`architecture` / `sequence` / `lifecycle` / `dataflow`）的 IR 要由**宿主按契约生成**；此前宿主取不到 schema（只能翻 `3rd/archify/archify/schemas/`，打包后连路径都摸不到），于是回头让用户手写 JSON——与 R7「IR 是派生视图」相悖。**没有 MCP 等价工具**（架构图谱全线只有 CLI/HTTP）。同步补齐 `prism` Skill：`references/arch.md` 增「IR 由谁产」表与宿主生成链路，SKILL.md 快速判定表与 CLI 速查一并更新。
> **v10 五类图全自动派生（2026-09-14，本版取代 v9 的「宿主手搓」口径）**：v9 只是把「让用户写 JSON」降级成「让宿主按 schema 写 JSON」，**机械活还在** —— 与 R7 只差半步。本版把 `architecture` / `sequence` / `lifecycle` / `dataflow` 四类也做进 Prism，IR 一律由**纯函数从既有真相派生**，宿主与用户都不再产 IR。数据源与入口：
>
> | type | 数据源 | 入口 |
> | :--- | :--- | :--- |
> | `workflow` | 团队 DAG 工作流定义 | `prism arch from-team <team_id>`（原有） |
> | `architecture` | 已注册项目的代码图谱（社区聚类 + 依赖边） | `prism arch from-graph architecture <project>` |
> | `sequence` | 代码图谱的跨文件 CALLS 边 | `prism arch from-graph sequence <project>` |
> | `dataflow` | 代码图谱的目录角色分层 + 跨层依赖边 | `prism arch from-graph dataflow <project>` |
> | `lifecycle` | Prism 任务状态机（14 态 36 转移） | `prism arch from-state` |
>
> 新增 CLI 子命令 `from-graph`（`--out/--top/--limit`）与 `from-state`（`--out/--title`）；新增 MCP `prism_arch_generate`（统一入口，按 `type` 分派，见 §2.3）。`prism arch schema` **保留但降级**——从「生成 IR 的依据」变为「核对/调试契约」。
> **v9 F1 落点**：`from-graph` 的 `architecture|sequence|dataflow` **缺省**落 `<projectRoot>/.prism/arch/<type>/`（与 MCP/HTTP 同口径，`--out` 完全接管）；`from-team`/`from-state`（workflow/lifecycle）仍落 `<PRISM_HOME>/archify/<type>/`。
> **两处口径说明**（都不是缺陷，是有理由的拒画或改名）：① `dataflow` 图谱里**没有 reads/writes 边**，无法画真正的数据读写流，故改口径为**依赖流向视图**（按目录角色分层 + 依赖边跨层流动，层次压缩后只留命中层）；② 生成器在真实图谱上**可能明确拒画**并给出理由（同目录扁平仓库无处分层、图谱无跨文件 CALLS 边、层数不足两级），此时报错而非产出坏图。派生逻辑硬约束见 `knowledge-base.md §4.4`。
> **渲染器踩坑已被生成器吸收**（不再要求使用者知道）：节点文本不换行需自收敛、连线侧向契约（给了 `via` 即跳过 `endpoint-side-direction` 校验）、`edge-through-node` 无法靠命名通道避让（唯一解是自给 `via`）、标签默认落线段中点常压节点（需自定 `labelAt`）、各类最短段阈值（architecture 24px / dataflow 34px / lifecycle 32px）、同层节点净空 10px。生成器内部用「Hanan 网格 + Dijkstra（折点优先）」正交布线自动解这些约束。
>
> **v8 F7 技能分类三入口（2026-09-16，design-v8 §3）**：新增 `skill categorize <name...> [--category <分类>]`（CLI）、`prism_skill_categorize`（MCP）、`GET /api/skills/categories` + `POST /api/skills/categorize`（HTTP）；`GET /api/skills` 与 `prism_skill_list` 响应**合并 `category` 字段**（R-v8-5，技能页语义分组的唯一数据源；映射里没有的技能**不加该键**）。映射落 `<PRISM_HOME>/skill-categories.json`（tmp + rename 原子写、每次访问重读磁盘、坏文件降级空表），**不校验技能是否存在**（R3 不做审核——分类判断归宿主；也不碰宿主技能文件）。`category` 省略 / 空串 = 清除；`names` 必填非空。⚠ `GET /api/skills/categories` 必须注册在 `/api/skills/:name` **之前**（路由器首个匹配即命中）。
>
> **v10 F3/F5/F9 服务端面（2026-09-17，design-v10）**：
>
> - **F3 外部技能删除（数据安全轨）**：新增 `DELETE /api/skills/external/:name` —— 删**外部技能**（人写在 `skills_dir` 下、非 Prism 产物的技能目录）：整目录搬进回收站，**200 + `{ skills_dir, removed: [目录], trash_id }`**（`trash_id` 供 UI 提示 3 天内可 `prism trash restore <id>` 还原）。错误：SKILL.md 含 Prism marker → **409 `id_conflict`**（提示走卸载）；目录不存在 / 存在但无 SKILL.md → **404**（非技能目录不可删）；`:name` 为空串 / `.` / `..` / 含路径分隔符 → **400**。`skills_dir` 取**配置解析后**的同源值（`resolveDirsFromHome(home,{rootExplicit:true}).skillsDir`，与 `GET /api/skills`、`installedSkillNames` 同源，**不用 `harnessPaths`**——prism.yaml 覆盖 `skills_dir` 时它会读错目录）；外部判定**按落点文件**（有 SKILL.md 且无 marker），**不查内置清单**——否则会误伤「复制内置后改写的人写同名技能」。`GET /api/skills/usage` 每行增只读 **`external_removable`**（= 有 SKILL.md 且无 marker；无 SKILL.md/未落盘/Prism 产物恒 `false`），供 UI 区分「删除」与「卸载」。
> - **F5 导出时序图（调用链轨）**：`POST /api/arch/render` 增 **`mode: 'from-graph'`** 分支——入参 `{ mode, type: 'sequence', project, node }`（`node` = **图谱节点 id**，即四模式查询结果的 `other`，**不是符号名**：label 跨文件重名会静默选错）。服务端读 graph.json 一次 → 该节点 `source_file` 作 rootFile → `buildSequenceIr` → `renderDiagram`，响应沿用既有结构（`preview` URL 新标签打开）。三类 **`bad_request`**：节点 id 不存在 / 图谱无跨文件 calls 边 / **指定根文件无跨文件 calls 边**（高频路径，文案指引换起点）。产物名 `sequence-<消毒 id>-<yyyyMMdd-HHmmss>-<sha256(原始 id) 前 8 位>.html`（CJK 符号消毒后会同名互覆，靠短哈希防撞），落**项目源** `<projectRoot>/.prism/arch/sequence/`，**不落**全局 archify 目录（避免 arch 页双源列表堆积无归属噪音）。
> - **F9 分层聚合·逐级探索（性能轨）**：新增 `GET /api/graph/rollup?project=&level=community|dir|file|symbol&parent=<合成 id?>` → `{ level, parent, total, truncated, nodes: [{ id, label, kind, symbol_count, community? }], edges: [{ from, to, weight }] }`（**不含 `project`**，形状钉死给前端）。合成 id 编码 `community:<n>` / `dir:<path>` / `file:<path>`（正斜杠）；community 层无 parent，dir/file/symbol 层 parent 必填。三层是**独立投影、非包含树**（同一文件的符号可属多个社区：dir 层计数只数该父社区成员，file/symbol 层是全图口径——下钻计数变化是设计语义，不是 bug）。`weight` = **跨组 calls 族边条数**（`calls`/`invokes`；**不计 `imports`/`re_exports` 等结构边**，与边自带的 `weight` 字段无关）。单层 >500 节点按 `symbol_count` 降序（label 字典序次级）截断，`total` = 截断前全量、`truncated` 标记，**edges 只保留两端都在返回节点集内的**（无悬挂边）。level 非法 / 该层缺 parent → **400**；parent 反解后在图中无对应实体 → **404**。`level=symbol&parent=file:<path>` 是 file 节点的**只读出口**：`nodes[].id` 是**真实图谱节点 id**（合成节点在四模式查询里必 404），`kind='symbol'`，`edges` 恒 `[]`。读图带**进程内缓存**（只包 read+parse、不缓存聚合结果，失效键 `path+mtime+size`）。
>
> **已废弃**：工作队列（`prism_work_*` 工具、`work` 命令、`/api/work/*`）——见 `work-queue.md` 顶部；下方 §1 的 `work` 分组与 §2.7 已失效。同理 `uninit` / `harness detect` / `skill sync` 均未实现。

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
├── init                    接入初始化（注册 MCP + 复制 Skill + 建目录骨架；加 --yes 写默认宿主配置，
│                           --harness-root 覆盖落点为测试/CI 专用）
├── uninit                  撤销接入  ❌ 未实现
├── serve                   控制台（HTTP API + web UI）：前台起；--ensure 后台幂等 / --check 查状态 / --stop 停
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
│   ├── rm <name>           删除角色文件本体（搬进回收站，默认 3 天后彻底清除；v6 新增）
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
│   ├── rm <id>             删除团队文件本体（搬进回收站，默认 3 天后彻底清除；v6 新增）
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
│   ├── rm <name>           删除外部技能（人写、无 Prism marker）整目录进回收站（v15 B-4）
│   ├── effective           有效集（global ∪ team ∪ role；v4）
│   ├── categorize          技能分类映射（写 <PRISM_HOME>/skill-categories.json；v8 F7）
│   ├── category            分类清单增 / 改名 / 删（add <名称> | rename <旧名> <新名> | rm <名称>；v12 F4）
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
│   └── reindex [--chunks]  以文件为真相重建索引；--chunks 只补段级索引（存量库迁移，可中断重跑）
│
├── arch                    架构图谱（Archify 子工程）
│   ├── types               列出五类图
│   ├── schema <type|common>        IR 的 JSON Schema（IR 是全自动派生，schema 只作核对/调试）
│   ├── validate <type> <ir.json>   校验 IR（schema + 布局）
│   ├── render <type> <ir.json>     渲染为自包含 HTML（--book/--module 归到书内）
│   ├── from-team <team_id>         由团队定义自动派生工作流图（IR 是纯函数产物，零手写）
│   ├── from-graph <type> <project> 由代码图谱派生 architecture|sequence|dataflow（--top/--limit；缺省落 <project>/.prism/arch/）
│   └── from-state [--title <t>]    由 Prism 任务状态机派生生命周期图（14 态 36 转移）
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

> **v6.2 取齐说明**（2026-09-12）：工具总数 = **49**（`packages/server/src/mcp/server.ts` 内
> `name: 'prism_*'` 逐条计数）。v4 由 31 增至 35；v5 多项目图谱合并（F-C2）新增 `prism_graph_merge`
> （代码图谱 7 → 8）到 **36**；v6 把「角色 / 团队」补齐成**增删改查**（`new|edit|rm` 在 CLI / HTTP / MCP
> 三入口**同名同位**）——新增 `prism_role_new|edit|rm`、`prism_team_list|edit|rm|render` 共 7 个，
> 并把 `prism_team_create` **更名**为 `prism_team_new`（团队与角色对称）到 **43**；
> v6.2 补上 **Skill 写入口**（`prism_skill_list|install|uninstall`）——此前宿主 agent
> 无法经 MCP 装 Skill，是接口审查中唯一确认的**真能力缺口**，补齐后 skill 装/卸三入口齐。
> **v10 架构图谱接 MCP**：新增 `prism_arch_generate`（五类图统一入口）到 **47**，架构图谱
> 从「CLI-only」升级为**双入口**；同时四类图（architecture / sequence / lifecycle / dataflow）
> 的 IR 由「宿主按 schema 手搓」改为 **Prism 纯函数派生**，`prism arch schema` 降级为核对/调试用途。
> 下文原文缺漏的工具已在各节补齐；
> `❌ 未实现` = 全仓 grep 0 命中、**从未存在**的工具。
> **任务中心（任务台账）整体移除**：`prism_task_register|report|status` 三工具随任务中心
> 一并删除（第七轮 F2），**47 → 44**。
> **v8 F7 技能分类**：新增 `prism_skill_categorize`（Skill 4 → 5），**44 → 45**；
> 同时 `prism_skill_list` 响应合并 `category` 字段（与 HTTP `GET /api/skills` 同口径）。
> **v12 F4 分类清单增删改**：新增 `prism_skill_category_add|rename|rm`（Skill 5 → 8），**45 → 48**；
> 与 CLI `prism skill category add|rename|rm`、HTTP `POST|PATCH|DELETE /api/skills/categories[/:name]`
> 三面**同名同位**（`add`/`rename`/`rm`），实现同一 `SkillCategoryStore`；重名 / 改名目标重名
> = `409 id_conflict`，源分类不存在 = `404 not_found`，名字 trim 后为空 = `400 bad_request`。
> 同时 `GET /api/skills/categories` 与 categorize 响应迁为**双节** `{categories: string[], mapping}`。
> **v15 B-4 外部技能删除三面对称**：新增 `prism_skill_rm { name, skills_dir }`（Skill 8 → 9），**48 → 49**；
> 外部技能（有 `SKILL.md` 且**无** Prism marker）整目录进回收站（`kind=skill` + `trash_id`），
> Prism 产物 → `409 id_conflict`（指路卸载）、不存在 / 无 `SKILL.md` → `404 not_found`、
> 非法名 → `400 bad_request`——与 HTTP `DELETE /api/skills/external/:name`、
> CLI `prism skill rm <name>` 三面**同一域单点** `deleteExternalSkillDefinition`（仅 trigger 不同）。
>
> **口径已入守卫**：本文件与 `README.md` 的「总数 + 分组小计」由
> `packages/server/test/tool-surface-drift.test.ts` 对着 `createMcpTools` 实测锁定——
> 改工具集时两处会红，不再静默漂移。

### 2.1 知识库（17）

| 工具 | 作用 |
| :--- | :--- |
| `prism_kb_search` | 检索（层/书/模块/可见性过滤，默认最新版次；HTTP/MCP 可传 `hybrid=false` 强制纯关键词检索、跳过向量路，此时不计 `embedding_degraded`；HTTP 侧该参数**严格**只认 `0/1/true/false`，其余 400） |
| `prism_kb_get` | 取单条（可指定版次；返回 `deposited_by` / `provenance`） |
| `prism_kb_deposit` | 落库（宿主说落就落；可带团队沉淀策略） |
| `prism_kb_convert` | 文档转 Markdown（**不落库**，零 LLM/零网络） |
| `prism_kb_import` | 扫描项目目录建「引用型」索引（默认读项目根 `.gitignore` 并跳过其中路径；`respect_gitignore:false` 关闭。返回含 `ignored_dirs`/`ignored_files`） |
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

### 2.3 架构图谱（1）

> **v10 新增**：架构图谱此前只有 CLI/HTTP，**没有 MCP 工具**——宿主在会话里拿到图谱数据后
> 无法直接出图，只能反过来指导用户去敲 CLI。补 `prism_arch_generate` 一个统一入口即可闭环
> （五类图共用；IR 全部由 Prism 纯函数派生，宿主不再产 IR）。

| 工具 | 作用 |
| :--- | :--- |
| `prism_arch_generate` | 由 `type` 分派生成五类图并落盘 —— `workflow`（需 `team`）、`architecture`/`sequence`/`dataflow`（需已注册 `project`）、`lifecycle`（无入参）。返回 `{ type, html, ir, bytes, title, subtitle, source, project?, book?, module? }`。**落盘（v9 F1）**：项目三类图缺省落 `<projectRoot>/.prism/arch/<type>/`（未注册 → not_found；root 被删/被挪 → `project_root_missing`，**不 mkdir 复活**），`workflow`/`lifecycle` 落 `<PRISM_HOME>/archify/<type>/`，可选 `out` 完全接管（跳过项目解析）。**写 sidecar** `*.meta.json`（含可选 `book`/`module` 作用域）——v9 起 MCP 与 CLI/HTTP 同口径 |

> **v9 F1 资产归位（HTTP 面）**：`GET /api/arch/diagrams` **双源**——各注册项目
> `<projectRoot>/.prism/arch/<type>/*.html` + 全局 `<PRISM_HOME>/archify/<type>/*.html`。
> 逐字段：`type, name, bytes, mtime, title?, layer?, owner?, book?, module?, archify_version?,
> has_ir, source: 'project'|'global', project?, preview, ir`（身份键 = `(type, name, source, project)`；
> `preview`/`ir` 由**服务端构造**，项目源带 `?project=`）。**扫 `*.html` + sidecar 容错**——
> 缺 meta 的历史产物不隐藏（title 回落 IR `meta.title`）。`GET /api/arch/preview|ir/:type/:file`
> 支持 `?project=`：限定则只在该项目源内解析（不存在 → 404，**不回落全局**）；未限定且同名命中
> 多源 → `bad_request` **歧义拒绝**（默认产物名 = 图类型，故同名是默认路径而非边缘）。
> HTTP `POST /api/arch/render` 亦接可选 `project`（落项目源），但其**不接任意 `out`**——
> `out` 的「完全接管」语义只在 MCP/CLI 两面存在，避免新增经 HTTP 的任意写入口。

### 2.4 团队与角色（13）

> **v6**：补齐增删改——`new|edit|rm` 与 CLI（`prism role|team new|edit|rm`）、
> HTTP（`POST|PATCH|DELETE /api/roles[/:name]`、`POST|PATCH|DELETE /api/teams[/:id]`）**同名同位**。
> 写路径的目录参数（`roles_dir` / `teams_dir`）**必填**——一律显式参数化，防误写真实宿主目录。
>
> **v6.1**：`prism_role_list` 返回 `roles_dir`（= 写参数名，读回即可回填）；`prism_team_new` 增**可选**
> `roles_dir`（成员角色校验用，与 `prism_team_edit` 对齐；缺省才回落当前角色目录）。
>
> **team_id 即唯一标识（v12 F3 同口径）**：团队一律以 `team_id` 标识与寻址——CLI 的位置参数
> （`prism team show|edit|rm|validate|activate <id>`）、MCP 与 HTTP 的 `team_id`/`:id` 入参都是它；
> `name` 仅作元数据（界面展示面已去 name 显示，frontmatter 读写不变）。故 CLI/MCP 面**本就以 id 交互**，
> 无需为「纯 id」另加参数或工具。

| 工具 | 作用 |
| :--- | :--- |
| `prism_role_list` | 列出角色库（数据源 = 当前角色目录）。返回 `{ count, roles, roles_dir }`——`roles_dir` 即要回填给 `prism_role_new\|edit\|rm` 的值（v6.1 由 `agents_dir` 更名） |
| `prism_role_get` | 查看角色定义（全文） |
| `prism_role_new` | 新建角色（按**宿主原生形态**落盘：frontmatter 只含适配器白名单字段，skills / 知识绑定落正文小节；v6 新增） |
| `prism_role_edit` | 修改角色（字段补丁：`description`/`skills`/`knowledge`/`body`/`color`/`model`/`thought_level`；正文不重排；v6 新增） |
| `prism_role_rm` | 删除角色文件本体（**搬进回收站**，可 `prism trash restore <trash_id>` 还原；默认 3 天后彻底清除、自动清除需 serve 运行；`roles_dir` 必填；v6 新增） |
| `prism_role_render` | 渲染宿主格式角色文件（原文漏列） |
| `prism_team_list` | 列出团队库（v6 新增） |
| `prism_team_get` | 查看团队定义；响应含只读 `workflow_raw`（被编辑文件本体的原始表：`columns`/`rows`/`rowIds`/`unmapped`/`prose`/`sectionMissing`/`proseText`，**不经 extends 合并**）与 `source_mtime`（epoch 毫秒整数）——与 HTTP `GET /api/teams/:id` 同一包装单点（v11 派修 M-3） |
| `prism_team_new` | 新建团队定义（`teams_dir` 必填；`roles_dir` 可选＝成员角色校验用；**可带 `workflow.stages` / `workflow.columns`（v11）**，`workflow_template` 语义不变；v4 新增为 `prism_team_create`，v6 更名） |
| `prism_team_edit` | 修改团队（`name`/`description`/`members`/`deposit`/`workflow`/`if_match`；改 `members` 时**工作流表按名册就地收窄**；`workflow`＝结构化保存（`stages` + 可选 `columns` 列集，与 `members` 同给时 **workflow 胜**）；`if_match`＝mtime 并发防护，不符 → 409 `stale_write`；v6 新增） |
| `prism_team_rm` | 删除团队文件本体（**搬进回收站**，可 `prism trash restore <trash_id>` 还原；默认 3 天后彻底清除、自动清除需 serve 运行；`teams_dir` 必填；v6 新增） |
| `prism_team_render` | 渲染宿主格式团队文件（v6 新增） |
| `prism_team_activate` | 拉取团队运行时配置（含装配状态） |

> **三入口的能力边界（有意不对称；2026-09-12 审查后明确，v6.2 收口）**：
>
> | 能力 | CLI | MCP | HTTP | 说明 |
> | :--- | :--- | :--- | :--- | :--- |
> | `render`（预览宿主形态） | ✅ role/team | ✅ | ❌ | 本地开发/排障工具，控制台不需要 |
> | `validate` | ✅ role（全量）/ team（单条） | ❌ | ❌ | 校验结果随 `list`/`detail` 的 `issues` 返回，无需独立入口 |
> | Skill 写（install/uninstall/update） | ✅ | ✅ | ✅ | **v6.2 已补齐**（原为唯一真缺口）：`skill list|install|uninstall` ↔ `prism_skill_list|install|uninstall` ↔ `POST /api/skills/install|uninstall` |
> | 外部 Skill 删（`DELETE /api/skills/external/:name`） | ✅ | ✅ | ✅ | **v15 B-4 补齐三面**（此前 v10 F3 起为「有意不对称」的 HTTP-only）：CLI `prism skill rm <name>` ↔ MCP `prism_skill_rm { name, skills_dir }` ↔ HTTP `DELETE /api/skills/external/:name` 共用域单点 `deleteExternalSkillDefinition`——只删人写技能（Prism 产物 → 409 指路卸载），整目录进回收站返回 `trash_id` |
> | `--from`（从既有定义复制） | ✅ role/team | ❌ | ❌ | 便于人手写；机器侧「读→改」即可 |
> | 指定写目录 | ✅ `--source`（role=roles_dir / team=teams_dir） | ✅ 必填 | ✅ 必填 | team 侧另可用 `--roles-dir` 指定成员校验库 |
>
> 其余不对称属**取舍**——文档不应把它们描述成「三入口全等」。
> 三入口真正严格对齐的是**动词与落盘语义**：`new|edit|rm` ↔ `POST|PATCH|DELETE`，同一实现单点。

### 2.5 上下文（1）

| 工具 | 作用 |
| :--- | :--- |
| `prism_context_pack` | 生成带预算的上下文包（v4 增 `layers/books/symbols/max_excerpt_chars`） |

### 2.6 Skill（9）

| 工具 | 作用 |
| :--- | :--- |
| `prism_skill_effective` | Skill 有效集（global ∪ 团队声明 ∪ 角色声明；v4 新增） |
| `prism_skill_list` | 列出内置 Skill + 宿主是否已装；返回 `skills_dir`（= 写参数名，读回即可回填；v6.2 新增）。**v8 F7**：每个 skill 合并 `category` 字段（映射里没有则**不加键**；与 `GET /api/skills` 同口径） |
| `prism_skill_install` | 安装内置 Skill 到显式 `skills_dir`（人写的同名 Skill 不覆盖，写 `.prism-new` 供对比；v6.2 新增） |
| `prism_skill_uninstall` | 卸载 Skill（**只删 Prism 产物**；人写的保留并记入 `kept`；v6.2 新增） |
| `prism_skill_rm` | 删除**外部 Skill**（有 `SKILL.md` 且无 Prism marker；v15 B-4）：整目录进回收站（`kind=skill` + `trash_id`）；Prism 产物 → `id_conflict` 指路卸载，不存在 / 无 `SKILL.md` → `not_found`；`{ name, skills_dir }`，`skills_dir` 必填。与 HTTP `DELETE /api/skills/external/:name`、CLI `prism skill rm` 同一域单点 |
| `prism_skill_categorize` | 技能分类映射（v8 F7）：写 `<PRISM_HOME>/skill-categories.json` 的 Prism 侧映射，**不校验技能是否存在、不碰宿主技能文件**；`category` 省略/空串 = 清除，`names` 必填非空 |
| `prism_skill_category_add` | 新建分类（v12 F4）：写 `categories` 清单**不写 mapping**（空分类要存得住）；空名 → `bad_request`，重名 → `id_conflict` |
| `prism_skill_category_rename` | 分类改名（v12 F4）：`{ from, to }`，**级联**改 mapping（原位替换保序）；`from` 不存在 → `not_found`，`to` 与另一分类重名 → `id_conflict`，`from === to` 幂等 no-op |
| `prism_skill_category_rm` | 删除分类（v12 F4）：从 `categories` 移除并清掉指向它的 mapping 条目（**组内技能回未分类**）；不存在 → `not_found` |

### 2.7 工作队列 ⚠ 已废弃（0）

| 工具 | 作用 |
| :--- | :--- |
| `prism_work_pending` | 列出待办  ❌ 未实现（工作队列已于 v4 移除） |
| `prism_work_claim` | 认领  ❌ 未实现 |
| `prism_work_complete` | 回填  ❌ 未实现 |

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
>
> **v11（2026-09-14）宿主拉起机制**：既然 MCP 只有 stdio，**接入就不需要「开机自启」**——
> 宿主启动时自己 spawn `node dist/mcp/server.js`，宿主退出即结束。常见的「重启后 Prism 不启动」
> 不是缺自启，而是**注册路径漂了**（部署目录被清理，或指到了开发布局 `packages/server/dist/…`）。
> 故部署落点改为**恒定路径** `<PRISM_HOME>/runtime/`（`pnpm run deploy`）——升级只换目录内容，
> **注册不需要动**。控制台（HTTP + web UI）是另一件事，它需要常驻，靠两条路：
> **MCP 启动时顺带 `ensure` 拉起**（`serve --ensure`，幂等，`PRISM_SERVE_AUTOSTART=0` 可关）
> + **登录自启**（`deploy` 装进启动文件夹的 `PrismConsole.vbs`）。

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | CLI 命令分组 | ✅ 已随实现定稿（见 §1 取齐说明） |
| 2 | MCP 工具命名前缀 | ✅ `prism_` |
| 3 | 是否提供 `--json` 全局选项 | ✅ 是 |
| 4 | MCP 传输 | ✅ **stdio 已实现**；HTTP 端**未实现**（仍待定） |
| 5 | 是否暴露图谱 Studio 静态路由 | ✅ 是（控制台需要，已实现） |
