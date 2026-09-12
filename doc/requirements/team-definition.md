# Prism 团队定义设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：团队定义格式、成员编排、固定工作流、沉淀规则、优先级、团队 Skill。
> 原则：服从控制面定位——**Prism 只定义与校验，不执行调度**。
>
> **v4 修订（2026-09-11）：`team install` / `role import` / `role install` 已移除。**
> 角色与团队**直接住在宿主目录**（`<roles_dir>` / `<teams_dir>`），Prism 不持有第二份副本——
> 原「装配」（把团队定义 + 成员角色写进宿主目录）默认的「资产在别处、需要搬到这里」前提不再成立
> （"别处"与"这里"已是同一处）。建团队 = `prism team init` / web `POST /api/teams` /
> MCP `prism_team_create`；建角色 = `prism role init <name>` 或直接写 `<roles_dir>/<name>.md`。
> **下文正文中凡涉及 install/import 的步骤均保留为历史决策记录，实现以本注记口径为准。**
>
> **v6 修订（2026-09-12）：角色 / 团队命令面 = 增删改查，三入口同名同位。**
> `init` → `new`（CLI `role new` / `team new`；MCP `prism_role_new` / `prism_team_new`；
> HTTP `POST /api/roles` / `POST /api/teams`），并补齐 `edit` / `rm`（MCP `prism_role_edit|rm`、
> `prism_team_edit|rm`；HTTP `PATCH|DELETE /api/roles/:name`、`/api/teams/:id`）。
> - `new` = 按**宿主原生形态**渲染落盘（适配器 `renderRole`；frontmatter 只含宿主白名单字段，
>   skills / 知识绑定落正文小节）——原 `role init` 把 `skills`/`knowledge` 塞进 frontmatter，
>   与两个适配器自述都冲突，已废；
> - `edit` = **外科式字段补丁**，只动点名字段，正文与未知 frontmatter 键原样保留；
>   改 `--members` 时工作流表**就地按名册收窄**（`workflow_pruned` warning）；
> - `rm` = **硬删**文件本体（不可逆）：CLI 在默认宿主目录下需 `--yes`，MCP / HTTP 的
>   `roles_dir` / `teams_dir` **必填**（写路径一律显式参数化）。
> 原 `prism_team_create` 更名为 `prism_team_new`。MCP 工具总数 36 → 43。

---

## 1. 团队是什么

**团队 = 从专家角色库中选出的成员 + 固定工作流 + 团队级约定。**

| 组成 | 说明 |
| :--- | :--- |
| 成员 | 引用角色库（`<PRISM_HOME>/roles/`）中的专家角色，可指定数量 |
| 固定工作流 | 阶段、串并行、输入输出、完成判定、回流路径、门禁 |
| 团队约定 | 沉淀规则、优先级、团队 Skill 绑定 |
| 团队 Skill | 仅本团队可用的技能 |

### 1.1 与 agent-team 的分工（关键）

用户此前定："Agent-Team 可以内置好，也可以主会话临时组建。" 两种形态分工：

| 形态 | 承载者 | 特征 |
| :--- | :--- | :--- |
| **内置团队** | **Prism 团队定义** | 固定成员、固定工作流，可复用、可装配、可版本化 |
| **临时组建** | `agent-team` Skill | 队长按任务动态挑人，工作流临时定 |

**两者不冲突**：Prism 团队定义可被 agent-team 当作"预设花名册"读取；临时组队时可以不读。

---

## 2. 文件位置与格式

**团队定义放在 harness 的 agents 目录下**（用户 2026-09-09 确认）——因为团队定义是 **harness 绑定的**（引用该 harness 的角色名、工作流、派发机制），脱离 harness 就是没人消费的文本：

```
~/.zcode/agents/                  # ZCode 子 agent 目录
├── dev-1.md                      # 角色（ZCode 扫描并可派发）
├── qa-checker.md
└── teams/                        # 团队定义（Prism 管理）
    └── core-dev.md
```

**出厂模板在 Prism 包内**（`templates/teams/*.md`），`prism team install` 安装到上述目录。安装后**宿主目录就是唯一受管位置**，不在 PRISM_HOME 保留副本。

> **v3 修订（2026-09-09，design-v3 §3.3 P3）**：实际实现为**双向**——Prism 侧保留可版本化的源（`<PRISM_HOME>/teams/<team-id>/AGENTS.md`，server API `/api/teams` 与 MCP `prism_team_get` 由此读取，不依赖宿主即可工作）；`prism team install` 装配时将成员角色文件与团队定义写入上述宿主目录（ZCode 消费的唯一位置）。装配是单向动作（Prism 源 → 宿主产物），不做双向同步。

**读取方式**：Prism 从适配器声明的路径读取（`HarnessAdapter.agent.teamDir`），经 MCP 提供；宿主也可直接读文件。路径可配，不硬编码。

> **待实测**：ZCode 是否递归扫描 `agents/` 子目录。若递归，`teams/` 下的文件会被误当角色解析 → 改用与 `agents/` 平级的 `~/.zcode/teams/`。适配器把路径做成配置项，切换成本为零。

### 2.3 目录位置可配置，默认宿主目录（装配语义简化，2026-09-09 用户批准）

团队定义的受管位置直接就是宿主目录 `teams_dir`（默认 `~/.zcode/teams`，roles_dir 同级——**不在 agents/ 内**，因 ZCode 递归扫描 agents/ 下全部 .md 会把团队文件误注册成 agent，R3 实测 B7），`<PRISM_HOME>/prism.yaml` 的 `teams_dir` 键可覆盖（无配置文件时用适配器默认）。出厂模板仍在 Prism 包内；`prism team install` 语义变更为：① 校验团队与成员 ② 若团队定义尚在旧 Prism 源目录（`<PRISM_HOME>/teams/`）则一次性迁移复制到 teams_dir 并提示源目录废弃 ③ 输出激活指引。成员角色不再被复制装配——它们直接住在 `roles_dir`（默认宿主 agents 目录）。上文"宿主目录就是唯一受管位置"与本节同口径。

> **`prism init` 不建团队（2026-09-11 定）**：初始化只创建空的 `teams_dir`，不播种任何团队定义——
> 是否建团队、建几个、用什么编制，由使用者自己决定。需要出厂那套编排时运行
> `prism team init <id> --template core-dev`（脚手架渲染 + 自动校验，error 不落盘）。

### 2.1 frontmatter

```yaml
---
team_id: core-dev
name: 核心研发团队
description: 负责本项目的设计、开发、测试与质量收口；内置固定工作流。
default: false                     # 是否为默认团队
extends: null                      # 可选：继承另一个团队定义
members:
  - role: dev-1
    count: 1                       # 该角色几个实例
  - role: dev-2
    count: 1
  - role: super-dev
    count: 1
  - role: tester
    count: 1
  - role: qa-checker
    count: 1
skills:                            # 团队级 Skill（在成员自身 Skill 之外附加）
  - code_review
knowledge:                         # 团队级知识绑定（在角色绑定之外附加）
  layers: [global, project]
  books: []
deposit:                           # 知识沉淀规则（见 §5）
  enabled: true
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: true               # 沉淀时必须带一句说明
arbitration:                       # 团队仲裁链（角色冲突时用）
  - safety
  - requirement
  - quality
  - progress
rework_limit: 2                    # 返工上限（轮）
---
```

### 2.2 正文：固定工作流

```markdown
# 核心研发团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 + dev-2 | 并行 | 任务书 | exploration.md | 结论落盘 | 缺资料 → 补调研 |
| 2 | 设计 | 队长 | 串行 | exploration.md | design.md | 需求全覆盖 | — |
| 3 | 设计审核 | qa-checker | 串行 | design.md | design-review.md + .design_ok | 门禁落盘 | 架构级 → 队长 |
| 4 | 开发 | dev-1 + dev-2 + super-dev | 并行 | design.md | stream-N.md | 自验通过 | 卡死 2 次 → super-dev |
| 5 | 测试 | tester | 串行 | 任务书 + 各流报告 | test-report.md | 全项有运行证据 | bug → 对应流 → 回归 |
| 6 | 总审 | qa-checker | 串行 | 全部 | qa-report.md + .qa_ok | 门禁落盘 | 超范围 → 返工（≤2 轮） |
| 7 | 交付 | 队长 | — | 全部 | DELIVERY.md | 用户验收 | — |

## 门禁

| 门禁文件 | 执笔 | 放行条件 |
| :--- | :--- | :--- |
| `.design_ok` | qa-checker | 设计覆盖全部需求、可测、风险已识别 |
| `.qa_ok` | qa-checker | 需求逐条核对、测试证据齐全、遗留已分级 |

## 沉淀规则

- 任务完成时，由负责角色按 `deposit` 配置落库；
- 安全红线类知识强制 `layer: global`；
- 沉淀必须带来源（任务 ID + 角色）。

## 优先级

知识检索与注入的优先级：`role > project > global`（同相关性下）。
```

---

## 3. 成员编排

| 字段 | 说明 |
| :--- | :--- |
| `role` | 引用 `<PRISM_HOME>/roles/<role-id>/AGENTS.md` |
| `count` | 实例数量（同角色多份并行） |

**校验规则**：

| 校验 | 不通过时 |
| :--- | :--- |
| 引用的角色存在 | 报错，列出缺失角色 |
| 角色 `skills` 白名单与团队 `skills` 兼容 | 警告 |
| 成员角色数量 ≥ 1 | 报错 |
| 工作流引用的角色都在成员里 | 报错（防止工作流派给不存在的成员） |
| 成员角色**至少出现在一个工作流阶段** | 警告 `unused_member`（防止编制挂空转角色；有意预留的机动位可保留此警告） |

---

## 4. 固定工作流

### 4.1 字段

| 字段 | 说明 |
| :--- | :--- |
| 阶段名 | 阶段标识 |
| 负责角色 | 必须来自 `members`；多角色用 ` + ` 分隔；`role/N` 是**实例记号**（展开为 `role#1`…`role#N`），**不是** `role` 与 `N` 两个角色 |
| 串/并行 | 决定同阶段内是否可同时进行 |
| 输入 / 输出 | 文件路径（黑板交接） |
| 完成判定 | 可检验的条件 |
| 回流路径 | 失败时回到哪个阶段 |

### 4.2 与 DAG 的关系

工作流是**声明式的**。宿主（或 agent-team）执行时把它转成 DAG：

```
团队工作流（声明）
   ↓ 宿主/队长读取
任务 DAG（运行时）
   ↓
子 agent 派发（宿主自己的机制）
```

**Prism 不做这个转换，也不驱动 DAG。** 它只保证工作流定义完整、可被读取。

### 4.3 门禁

门禁文件（`.design_ok` / `.qa_ok`）由**执笔角色**在完成后写入，Prism 只记录台账、不强制校验（因为 Prism 不在执行链路里）。

---

## 5. 沉淀规则与优先级（用户明确要求）

**沉淀规则写在团队定义里**，Prism 只按声明执行机械动作：

```yaml
deposit:
  enabled: true              # 本团队是否启用沉淀
  default_layer: project     # 默认落到哪一层
  default_type: pitfall      # 默认条目类型
  priority: medium           # 富化队列优先级
  require_note: true         # 必须带说明才允许落库
  rules:                     # 按内容特征覆盖默认值
    - match: { type: rule }        → { layer: global, priority: high }
    - match: { tags: [security] }  → { layer: global, priority: high }
```

| 字段 | 作用 |
| :--- | :--- |
| `enabled` | 团队是否允许沉淀 |
| `default_*` | 默认落点 |
| `priority` | 富化队列优先级（Prism 按此排序，不判断内容） |
| `require_note` | 落库必须带说明（机械校验） |
| `rules` | 按 `match` 匹配覆盖默认值（**解析 + 机械执行合并**，见下） |

> **v4 修订（2026-09-11，design-v4 F-E1）**：`rules[].match` 的可匹配键为
> `type` / `layer` / `risk` / `book` / `module` / `tags`（前五者精确相等，`tags` 要求「包含全部」）；
> **未知键一律不匹配**（保守，避免误覆盖）。执行顺序 = 声明顺序，**后者覆盖前者**；
> `set` 只认 `layer` / `type` / `risk` / `visibility`，`priority` 单独映射为队列优先级
> （不出现在落库输入里）。实现单点：`packages/agents/src/team/deposit-policy.ts`；
> 三入口（CLI `prism kb deposit --team` / MCP `prism_kb_deposit` / HTTP `POST /api/kb/deposit`）
> 共用 `@prism/server` 的 `depositWithPolicy`，故「同策略同结果」可判定。

> **v4 QA 核实（2026-09-10，`.qa_ok_v4` D-1）**：`require_note` 的判据是
> **`source.ref` 非空 _或_ `content` 非空**。但 **`content` 在三个入口都是硬要求**
> （CLI 正文必须非空、MCP `inputSchema.required` 含 `content`、HTTP 前置校验含 `content`），
> 且知识侧 `#validateAndNormalize` 在写库前**再校验一次**（`400 content 必填`）。
> 因此「空正文 + 只有 `source.ref`」这条路**在任何入口都到不了写库**——该 OR 分支是
> **纵深冗余**，不是「HTTP 面被绕过」。**空正文永远先被 `content 必填` 拦下**（HTTP 由入口
> 校验拦、CLI/MCP 由服务拦），这是三入口一致的**正确**行为；不需要改代码。
> 相关回归：`packages/server/test/stream-b.test.ts`（`enabled=false` 策略拒绝）、
> `test/run-e2e.mjs` 的 `19.8.4/19.8.5/19.8.6`（三入口 + 空正文口径记录）。

**注意**：Prism **不审核内容**，只做"声明→机械校验→落库"。规则本身由团队给。

---

## 6. Skill 的指定位置

**Skill 本身不分层**——分层是"在哪儿被指定"带来的效果，不是 Skill 的属性。

### 6.1 两类 Skill

| 类别 | 例子 | 存放 | 宿主如何获得 |
| :--- | :--- | :--- | :--- |
| **Prism 自有 Skill** | `taint_trace`、`code_review`、`payload_generate` | **`<PRISM_HOME>/skills/<id>/SKILL.md`**（唯一一份，不复制） | **启动团队时按绝对路径注册进 ZCode 配置**（见 §6.2） |
| **宿主原生 Skill** | `graphify`、`agent-team`、`cangjie` | `~/.zcode/skills/`、`~/.agents/skills/` | ZCode 自行发现 |

### 6.2 直接装在宿主 Skill 目录

**运行时只服务一个 harness，所以 Skill 直接装进它的目录管理**，不做"源 + 同步"的双份维护：

```
Prism 包内自带 skill 模板
        ↓ prism skill install / prism init
~/.zcode/skills/<name>/SKILL.md     ← 直接装在这里
```

抽象在**代码层**：`HarnessAdapter.skill.nativeDir` 决定目标目录，管理逻辑不硬编码路径。

### 6.3 三处指定

| 指定位置 | 语义 | 谁写 |
| :--- | :--- | :--- |
| 全局已装 | 环境基础，无需指定 | 安装即生效 |
| **团队定义 `skills:`** | 本团队**额外**授予的 Skill | 团队作者 |
| **角色定义 `skills:`** | 该角色**自身**的 Skill 白名单 | 角色作者 |

**合并规则**：

```
某角色在某团队中的可用 Skill
  = 全局已装 + 团队定义 skills + 角色定义 skills
```

不需要"优先级遮蔽"——同名 Skill 只有一个实现，谁指定都指向它。

### 6.4 校验

| 引用来源 | 校验 |
| :--- | :--- |
| Prism 库中的 Skill | 存在即可 |
| 宿主原生 Skill | 检查是否已安装（否则警告） |

Prism **不做权限裁决**（那属于宿主）。

### 6.5 `prism` 元 Skill

`prism` 元 Skill（教宿主如何使用 Prism）同样**直接装在** `~/.zcode/skills/prism/`，随 `prism init` 安装。

---

## 7. 团队与装配/启用的关系

| 动作 | 涉及团队定义 |
| :--- | :--- |
| 新建 `prism team init <id>` | **脚手架**：从内置模板（`minimal` / `core-dev`）或 `--from <既有团队>` 渲染新团队定义 → 自动 `validateTeam`（有 error 不落盘）→ 写守卫 → 落 `<teams_dir>/<id>.md`（只渲染不落盘的实现：`@prism/agents` 的 `renderTeamScaffold`） |
| 装配 `prism team install` | 读团队定义 → 装配全部成员角色到 `~/.zcode/agents/` |
| 启用 `prism team activate` | 返回团队运行时配置（成员 + 工作流 + 沉淀规则 + 装配状态） |
| 注入 | 团队约定写入项目 `AGENTS.md` 标记块 |

> `prism team init` 的写守卫口径 = `--harness-root` / `prism.yaml`（与其它写命令一致）：目标是默认宿主
> `teams_dir` 且未显式指定时需 `--yes`。**不存在 `--teams-dir`**（`PRISM_TEAMS_DIR` 亦不存在），
> 写路径一律走已解析的 `teams_dir`。`--members <role[:n],...>` 收窄名册时，工作流里不属于成员的
> 非编排角色会被自动剔除（出 `workflow_pruned` warning），避免生成即 `workflow_role_unknown`。

---

## 8. 完整示例

```markdown
---
team_id: core-dev
name: 核心研发团队
description: 负责本项目的设计、开发、测试与质量收口；内置固定工作流。
default: true
members:
  - role: dev-1
    count: 1
  - role: dev-2
    count: 1
  - role: super-dev
    count: 1
  - role: tester
    count: 1
  - role: qa-checker
    count: 1
skills: [code_review]
knowledge:
  layers: [global, project]
deposit:
  enabled: true
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: true
  rules:
    - match: { type: rule }
      set: { layer: global, priority: high }
    - match: { tags: [security] }
      set: { layer: global, priority: high }
arbitration: [safety, requirement, quality, progress]
rework_limit: 2
---

# 核心研发团队

## 工作流
（见 §2.2 表格）

## 门禁
（见 §2.2 表格）

## 沉淀规则
安全红线类强制 global 层、high 优先级；其余落 project 层。
```

---

## 9. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 团队定义文件名 | ✅ `AGENTS.md` |
| 2 | 团队是否引用角色库 | ✅ 引用，不复制 |
| 3 | 工作流是否固定 | ✅ 内置团队固定；临时组队走 agent-team |
| 4 | 沉淀规则是否写团队定义 | ✅ 是 |
| 5 | 团队定义是否可继承 | ⏳ 支持 `extends` / 不支持 |
| 6 | 同一角色多实例如何区分 | ⏳ dev-1#1 / dev-1#2 / 自动编号 |
| 7 | 团队定义是否也支持项目级覆盖 | ⏳ 支持 / 仅全局 |
| 8 | 工作流阶段数与命名是否固定 | ⏳ 自由 / 模板约束 |
