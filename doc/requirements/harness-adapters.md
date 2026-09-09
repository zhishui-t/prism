# Prism Harness 适配（讨论稿 v0.2）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：Prism 如何与宿主共存。
> 结论：**首批且仅支持 ZCode**（用户 2026-09-09 确认"就 zcode 就行"）。

---

## 1. 核心原则：harness 原生 + Prism 叠加

**不做替代，做叠加。** Prism **沿用 ZCode 的原生约定**，再在其上叠加自己的部分：

```
ZCode 原生约定（研究清楚、写死）
        +
Prism 叠加层（核心第一原则 / Skill 白名单 / 知识绑定 / 团队工作流 / 沉淀规则）
        =
harness + Prism 组合产物（ZCode 能直接读取）
```

**产物必须能被 ZCode 直接读取**——否则叠加无意义。

> **范围决定**：首批只支持 ZCode。适配器不做多 harness 抽象，直接按 ZCode 写死实现；其他 harness（Codex / Claude Code / Cursor / OpenCode）**不在当前范围**，未来若需要再逐个研究。

---

## 2. ZCode 约定（已核实）

| 项 | 事实 | 证据 |
| :--- | :--- | :--- |
| agent 定义目录 | `~/.zcode/agents/*.md`（扁平，一角色一文件） | 本机 9 个角色文件 |
| 项目级覆盖 | `<repo>/.zcode/agents/` | agent-team 文档 |
| frontmatter 字段 | `name`（=文件名）/`description`/`color`/`model`/`thoughtLevel`/`injectAgentsMd` | 实测 |
| 模型表达 | 供应商 ID，如 `custom:builtin%3Abigmodel-coding-plan:GLM-5.3-Flash` | 实测 |
| 内置角色覆盖 | `~/.zcode/v2/agents-state.json`（`builtInModelOverrides`/`builtInThoughtLevelOverrides`/`disabledAgentIds`） | 实测 |
| 子 agent 派发 | `subagent_type: "<角色名>"` | agent-team 文档 |
| 会话兜底 | `subagent_type: "general-purpose"` + 角色契约粘进 prompt；模型/档位跟随会话默认 | adding-agents.md |
| skill 目录 | `~/.zcode/skills/`（原生）、`~/.agents/skills/`（生态安装） | 实测 |
| 指令文件 | `AGENTS.md` | 实测 |
| 激活时机 | 角色文件在**会话启动时扫描一次**；新增/修改的下一会话才可派发 | adding-agents.md |

### 2.1 必须遵守的 ZCode 约束

| 约束 | 对 Prism 的影响 |
| :--- | :--- |
| 角色文件会话启动时扫描一次 | Prism 写入角色后需提示"下一会话生效" |
| `name` 必须与文件名一致 | 生成时强制校验 |
| frontmatter 是 ZCode 的字段集 | Prism 不得塞入自定义字段（会被忽略或报错）——叠加内容一律放**正文** |
| YAML 值含冒号必须加引号 | 本机 `find-skills` 已有此坑（description 未加引号导致解析失败） |
| 模型 ID 是供应商特定字符串 | Prism 不做能力判断，只透传；见 §3.3 |

---

## 3. 适配层接口（为扩展留缝）

> **实现只有 ZCode，但接口按"可扩展"设计。** 新增 harness = 实现一个适配器 + 注册，不改核心。

### 3.1 三个接口

```ts
/** 宿主适配器：描述某个 harness 的原生约定（只读描述，不含行为） */
interface HarnessAdapter {
  readonly id: string                      // 'zcode'
  readonly displayName: string

  /** 探测本机是否安装该 harness（只读：查配置目录，不调宿主） */
  detect(): Promise<HarnessPresence>

  /** agent 定义约定 */
  readonly agent: AgentConvention

  /** 子 agent 派发约定（只读描述，Prism 不实现派发） */
  readonly dispatch: DispatchConvention | null

  /** 模型声明约定（只读描述，Prism 不判断能力） */
  readonly model: ModelConvention | null

  /** skill 约定 */
  readonly skill: SkillConvention

  /** 指令文件约定 */
  readonly instructions: InstructionsConvention

  /** 把 Prism 角色定义渲染成该 harness 的原生文件内容 */
  renderRole(role: RoleDefinition): RenderedFile

  /** 把该 harness 的原生文件解析回 Prism 角色定义（导入） */
  parseRole(content: string, filename: string): RoleDefinition

  /** 团队约定的注入方式 */
  renderTeamInstructions(team: TeamDefinition): RenderedFile | null
}
```

```ts
/** 渲染产物：内容 + 目标路径 + 写入策略 */
interface RenderedFile {
  path: string                 // 目标绝对路径
  content: string              // 文件内容
  format: 'markdown' | 'json' | 'toml' | 'jsonc'
  /** 写入策略：overwrite=可覆盖 / no-clobber=人写的不动 / merge=合并 */
  writePolicy: 'overwrite' | 'no-clobber' | 'merge'
  /** 生成标记（用于识别 Prism 产物，安全覆盖） */
  marker: string
}
```

```ts
/**
 * 适配器注册表：编译期登记全部适配器，**运行期只激活一个**。
 * 不做运行时多 harness 路由（见 deployment-model.md §1）。
 */
interface HarnessRegistry {
  register(adapter: HarnessAdapter): void
  /** 运行时按配置选定唯一适配器 */
  activate(id: string): HarnessAdapter
  /** 当前激活的适配器 */
  active(): HarnessAdapter
  list(): HarnessAdapter[]   // 已编译进来的全部（供 harness list 展示）
}
```

### 3.2 约定类型（字段级抽象）

```ts
interface AgentConvention {
  globalDir: string            // '~/.zcode/agents'
  projectDir: string | null    // '<repo>/.zcode/agents'
  filePattern: string          // '<role>.md'
  /** 团队定义目录（宿主根下、独立于 agent 扫描路径，如 '~/.zcode/teams'） */
  teamDir: string | null
  /** 该 harness 支持的 frontmatter 字段集；Prism 扩展不得越界 */
  frontmatterFields: readonly string[]
  /** 正文约定首节标题，如 '## 核心契约' */
  bodyConvention: string
  /** 激活时机：写入后何时生效 */
  activation: 'session-start' | 'immediate' | 'restart' | 'unknown'
  /** 名字与文件名是否必须一致 */
  nameMustMatchFile: boolean
}

interface DispatchConvention {
  mechanism: string            // 'subagent_type 名称派发'
  fallback?: string            // 'general-purpose + 契约粘入 prompt'
}

interface ModelConvention {
  declarable: boolean
  overridePath: string | null
  format: 'vendor-id' | 'model-id' | 'alias'
  capabilitySource: 'host-config' | 'unknown'
}

interface SkillConvention {
  /** Skill 安装目录（如 ~/.zcode/skills） */
  nativeDir: string | null
  /** 生态共享目录（如 ~/.agents/skills），可选 */
  ecosystemDir: string | null
  format: 'SKILL.md' | string
  /** 宿主是否支持 Skill（不支持则走上下文注入） */
  supported: boolean
}
}

interface InstructionsConvention {
  file: string                 // 'AGENTS.md'
  projectFile: string          // '<repo>/AGENTS.md'
}

type HarnessPresence =
  | { installed: true; configDir: string; version?: string }
  | { installed: false; reason: string }
```

### 3.3 Skill 安装方式（适配器决定）

不同 harness 的 Skill 位置与格式不同，Prism 按适配器声明的 `nativeDir` 安装：

| 项 | 说明 |
| :--- | :--- |
| 目标目录 | `skill.nativeDir`（ZCode：`~/.zcode/skills/`） |
| 安装方式 | **直接写入该目录**（运行时只服务一个 harness，不维护副本） |
| 换 harness | 改适配器 → 换目标目录，管理逻辑不变 |

```ts
interface HarnessAdapter {
  // ...
  /** 把 Prism 自带 Skill 安装/更新到本 harness 的 Skill 目录 */
  provisionSkill(skill: PrismSkill): Promise<SkillProvisionResult>
}

type SkillProvisionResult =
  | { mode: 'installed'; path: string }        // 直接安装（当前）
  | { mode: 'none'; fallback: 'mcp' | 'context-pack' }  // 宿主无 Skill 机制
```
```

**当前实现**：只有 ZCode，Skill 直接装到 `~/.zcode/skills/`。

### 3.4 扩展一个新 harness 的成本

| 步骤 | 工作 |
| :--- | :--- |
| 1 | 研究该 harness 的 agent 目录/格式/激活时机（查文档 + 实测） |
| 2 | 实现 `HarnessAdapter`（约定字段 + `renderRole`/`parseRole`） |
| 3 | 注册到 `HarnessRegistry` |
| 4 | 加测试 |

**核心代码零改动**——这就是"接口抽象好、方便拓展"的落点。

---

## 4. ZCode 适配器实现

### 4.1 固定约定（写死）

```ts
const ZCODE_ADAPTER: HarnessAdapter = {
  id: 'zcode',
  displayName: 'ZCode',
  detect: async () => { /* 查 ~/.zcode 是否存在 */ },
  agent: {
    globalDir: '~/.zcode/agents',
    projectDir: '<repo>/.zcode/agents',
    filePattern: '<role>.md',
    teamDir: '~/.zcode/teams',
    frontmatterFields: ['name', 'description', 'color', 'model', 'thoughtLevel', 'injectAgentsMd'],
    bodyConvention: '## 核心契约',
    activation: 'session-start',
    nameMustMatchFile: true,
  },
  dispatch: {
    mechanism: 'subagent_type 名称派发',
    fallback: 'general-purpose + 契约粘入 prompt',
  },
  model: {
    declarable: true,
    overridePath: '~/.zcode/v2/agents-state.json',
    format: 'vendor-id',
    capabilitySource: 'host-config',
  },
  skill: {
    nativeDir: '~/.zcode/skills',
    ecosystemDir: '~/.agents/skills',
    format: 'SKILL.md',
    supported: true,
  },
  instructions: { file: 'AGENTS.md', projectFile: '<repo>/AGENTS.md' },
  renderRole: (role) => { /* 见 §4.3 */ },
  parseRole: (content, filename) => { /* 见 §5 */ },
  renderTeamInstructions: (team) => { /* 注入 AGENTS.md */ },
}
```

### 4.2 Prism 叠加层 → 注入位置

| Prism 部分 | 注入位置 |
| :--- | :--- |
| 核心第一原则 | 正文 `## 核心契约`（ZCode 既有约定位） |
| 职责 / 边界 | 正文 |
| Skill 白名单 | **正文**（ZCode frontmatter 无此字段） |
| 知识绑定 | 正文 |
| 协作位置 / 完成判定 | 正文 |

**关键**：Prism 的扩展一律放正文，不污染 ZCode 的 frontmatter。

### 4.3 组合产物示例

Prism 生成 `~/.zcode/agents/security-auditor.md`：

```markdown
---
name: "security-auditor"
description: "白盒安全审计角色。适用于：代码变更的漏洞审计。不适用于：业务逻辑修复（只给建议）、性能优化、代替 QA 收口。"
color: red
model: "custom:builtin%3Abigmodel-coding-plan:GLM-5.3"
thoughtLevel: max
injectAgentsMd: true
---

# 安全审计师

## 核心契约
**存疑即阻断：漏报可以补，误放不可逆。**

面对"疑似漏洞但不确定"时，明确选择阻断而非"再看看"。

## 职责
- 对代码变更做白盒安全审计，输出带 CWE 编号与置信度的漏洞清单
- 核查变更是否触碰安全红线 TopN

## 边界（禁止）
- 不修业务逻辑（只给建议）
- 不代替 QA 做交付总审

## 能力（Skill 白名单）
taint_trace / payload_generate / cve_query

## 知识绑定
global（安全红线 TopN）+ role（Payload 字典）

## 协作位置
上游：dev 的代码变更 → 下游：QA 终审 → 受阻：升级队长

## 完成判定
- 每个发现带 CWE 编号 + 文件:行号 + 置信度 + 修复建议
```

> 上半段是 ZCode 原生字段，下半段是 Prism 结构。ZCode 直接可读可派发。

---

## 5. 导入（ZCode → Prism）

`parseRole` 把既有 ZCode 角色文件转成 Prism 角色定义：

| ZCode 字段/结构 | Prism 映射 |
| :--- | :--- |
| `name` / `description` / `color` | 直接保留 |
| `model` / `thoughtLevel` / `injectAgentsMd` | 保留（标记"环境属性"） |
| `## 核心契约` | `## 核心第一原则` |
| `## 职责` / `## 工作方式` / `## 边界（禁止）` | 直接保留 |
| — | 补 `skills`（白名单，导入时为空待填） |
| — | 补 `knowledge`（默认 `layers: [global, project]`） |
| — | 补 `协作位置` / `完成判定`（缺失则留空待填） |

**导入不覆盖原文**，只生成 Prism 角色定义。

---

## 6. 启用团队的生命周期（关键流程）

用户理解的大方向对：**宿主启用团队 → 拉取团队配置 → 拉取角色配置 → 创建子代理**。但这里有一个**关键分叉**，取决于角色是否已装进 ZCode 原生目录。

### 6.1 完整时序

```
① 人/宿主说「启用团队 X」
      ↓
② 宿主调 Prism MCP：prism_team_activate { team_id: "X" }
      ↓
③ Prism 返回团队配置 + 成员角色定义 + 工作流 + Skill 绑定
      ↓
④ 宿主检查：这些角色在 ZCode 原生目录里存在吗？
      ├─ 全部存在（已 install）→ 直接 subagent_type 派发
      └─ 有缺失 → 走「装配」分支（见 §6.2）
      ↓
⑤ 宿主按工作流创建/派发子代理，执行任务
      ↓
⑥ 执行结果经 MCP 回报 Prism（任务台账 + 沉淀知识）
```

### 6.2 关键分叉：角色是否已装进 ZCode

**ZCode 的角色文件在会话启动时扫描一次**——这意味着：

| 情况 | 后果 | Prism 的应对 |
| :--- | :--- | :--- |
| 角色**已装**在 `~/.zcode/agents/` | 本会话即可派发 | 正常流程 |
| 角色**未装** | 本会话**无法**用 `subagent_type` 派发 | 必须提前装 + 提示"下一会话生效" |

所以正确做法是：**Prism 在启用团队前，先把该团队所有角色渲染并写入 `~/.zcode/agents/`**（或提示用户执行 `prism role install`）。否则宿主拿到角色配置也创建不了子代理。

### 6.3 降级路径（角色未装但必须马上跑）

ZCode 自身已有兜底机制（`adding-agents.md` 记载）：

> `subagent_type: "general-purpose"`，把新角色的核心契约与职责粘进 prompt 开头，行为一致但**模型/思考档位跟随会话默认**。

因此：

| 路径 | 前提 | 保真度 |
| :--- | :--- | :--- |
| **原生派发** | 角色已装 + 会话已重启 | 完整（模型/档位/工具都生效） |
| **降级派发** | 角色未装或本会话新装 | 行为一致，**模型/档位不保证**，交付报告须注明 |

**Prism 的职责**：在 `prism_team_activate` 返回里**明确标注每个角色的装配状态**，让宿主知道走哪条路：

```json
{
  "team_id": "X",
  "members": [
    { "role": "dev-1", "installed": true,  "dispatch": "native" },
    { "role": "security-auditor", "installed": false, "dispatch": "fallback",
      "hint": "运行 prism role install security-auditor 并重启会话以启用原生派发" }
  ]
}
```

### 6.4 装配 vs 启用（两个不同动作）

| 动作 | 做什么 | 何时 |
| :--- | :--- | :--- |
| **装配**（install） | 把角色/团队文件写入 ZCode 目录 | 提前、一次性 |
| **启用**（activate） | 宿主拉配置并开始派发 | 每次干活时 |

**装配必须早于启用**，否则只能走降级路径。CLI 上分开：

```
prism team install X     # 装配：写角色文件到 ~/.zcode/agents/
prism team activate X    # 启用：返回运行时配置（供宿主/MCP 调用）
```

---

## 7. 团队定义的落点

**团队定义与角色放在同一个 harness 目录下**（用户 2026-09-09 确认）——团队定义是 **harness 绑定的**（引用该 harness 的角色名、工作流、派发机制），脱离 harness 就是没人消费的文本。

```
~/.zcode/agents/                  # ZCode 子 agent 目录
├── dev-1.md                      # 角色
├── qa-checker.md
└── teams/                        # 团队定义（Prism 管理）
    └── core-dev.md
```

| 项 | 落点 |
| :--- | :--- |
| 角色定义 | `~/.zcode/agents/<role>.md` |
| **团队定义** | `~/.zcode/teams/<team>.md`（**不在 agents/ 内**：ZCode 递归扫描 agents/ 下全部 .md，团队文件含 name+description 会被误注册为 agent，R3 实测 B7） |
| 团队约定传达 | 项目 `<repo>/AGENTS.md` 注入团队约定（ZCode 自动读取） |
| 团队 Skill | `~/.zcode/skills/` |

**读取方式**：Prism 从适配器声明的路径读（`HarnessAdapter.team.dir`），经 MCP 提供；宿主也可直接读文件。

> **待实测**：ZCode 是否递归扫描 `agents/` 子目录。若递归，`teams/` 下的文件会被误当角色解析 → 改用与 `agents/` 平级的 `~/.zcode/teams/`。适配器把路径做成配置项，切换成本为零。

---

## 8. 写入与冲突处理

| 情况 | 处理 |
| :--- | :--- |
| 目标文件不存在 | 直接写入 |
| 目标文件由 Prism 生成（带 marker） | 覆盖 |
| 目标文件由人编写 | **不覆盖**，生成 `.prism-new` 供对比 |
| 角色文件新增/修改后 | 提示"**下一会话生效**" |

---

## 9. CLI 命令

```
prism harness show          # 显示 ZCode 适配器的固定约定
prism harness detect        # 探测本机是否装了 ZCode（只查配置目录）
prism role render <role>    # 渲染 ZCode 格式角色文件（预览）
prism role install <role>   # 写入 ~/.zcode/agents/
prism role import           # 从 ~/.zcode/agents/ 导入现有角色
prism team install <team>   # 装配：批量写入团队全部角色文件
prism team activate <team>  # 启用：输出运行时配置（含装配状态）
```

---

## 10. 装配：用 Skill 把角色放进宿主目录

### 10.1 硬约束

**Prism 的角色定义不落进 `~/.zcode/agents/`，ZCode 就找不到它。**

- ZCode 通过扫描 `~/.zcode/agents/*.md` 发现角色；
- 扫描只在**会话启动时**发生一次；
- 没落盘 = 定义不存在，`subagent_type` 派发会失败。

因此 **装配（install）是主路径，不是可选辅助**。

### 10.2 方案：Agent-Team Skill 作为装配器

**用一个 ZCode Skill 承担装配**（用户 2026-09-09 建议），而不是 Prism 进程直接伸手写宿主目录：

```
宿主会话内的 Agent-Team Skill
   ↓ ① 经 MCP 拉取 Prism 角色定义（环境无关的真相源）
   ↓ ② 在宿主环境内补齐 model / thoughtLevel（宿主最清楚本机有什么）
   ↓ ③ 渲染成 ZCode 格式，写入 ~/.zcode/agents/
   ↓ ④ 提示"下一会话生效"
```

**为什么这样更好**：

| 好处 | 说明 |
| :--- | :--- |
| **不侵入** | 写宿主目录的是宿主自己的 Skill，不是 Prism 进程——完全符合控制面定位 |
| **模型冲突自然化解** | Skill 运行在宿主环境里，能读本机可用模型，装配时填入 `model`/`thoughtLevel` |
| **环境正确** | 不同机器装配出的角色自动适配各自环境 |
| **符合 ZCode 约定** | Skill 是 ZCode 原生机制，不发明新通道 |

### 10.3 Skill 的职责

| 步骤 | 做什么 |
| :--- | :--- |
| 拉取 | `prism_role_list` / `prism_team_get`（MCP）取定义 |
| 补全 | 按宿主环境确定 `model` / `thoughtLevel`（角色声明 `recommend.capabilities` 作提示） |
| 渲染 | 调 `prism_role_render` 或本地渲染成 ZCode 格式 |
| 写入 | 写 `~/.zcode/agents/<role>.md`（冲突策略见 §8） |
| 校验 | `name` = 文件名、YAML 引号、frontmatter 字段白名单 |
| 提示 | "下一会话生效" |

### 10.4 漂移处理：自动重写

**用户确认：检测到定义与已装文件不一致时，自动重写。**

| 项 | 做法 |
| :--- | :--- |
| 记录 | Prism 记录每个已装角色的内容哈希（装配时写回） |
| 检测 | 拉取时对比定义哈希 vs 已装哈希 |
| 漂移 | **自动重写**文件（仍提示需重启会话才生效） |
| 保护 | 人编写的文件（无 Prism marker）不重写，只告警 |

> **注意**：自动重写只解决"文件内容"，不解决"ZCode 何时重扫"。**改完仍需新会话才生效**，这一点无法绕过。

### 10.5 范围：只做同机

**用户确认：只做同机。** Prism 与宿主在同一台机器，Skill 可直接写 `~/.zcode/agents/`。远程部署不在范围。

---

## 11. 冲突：角色文件里的 model 字段

### 10.1 冲突形态

| 事实 | 冲突 |
| :--- | :--- |
| ZCode 角色文件在 `~/.zcode/agents/`（**全局共享**） | — |
| ZCode 角色 frontmatter 的 `model`/`thoughtLevel` 是**角色级**字段 | 模型是环境属性 |
| 角色可被多个团队/项目复用 | 环境可能不同 |

实测：现有 9 个角色**全部写死了 model**（如 `custom:builtin%3Abigmodel-coding-plan:GLM-5.3-Flash`），即当前已经踩在这个冲突上。

### 10.2 关键区分：角色文件是渲染产物

Prism 的角色定义（**真相源**）与 ZCode 的角色文件（**渲染产物**）不是一回事：

```
Prism 角色定义（环境无关）
   + 环境配置（本机可用模型）
   ↓ renderRole()
ZCode 角色文件（环境特定，可重新生成）
```

**因此 model 是否写入产物、写什么，是渲染时决定的事**，不必焊进角色定义。

### 10.3 三个选项

| 选项 | 做法 | 优点 | 缺点 |
| :--- | :--- | :--- | :--- |
| **A. 不写** | 渲染时省略 `model`，ZCode 继承会话模型 | 最干净、真正环境无关 | 丢失"该用强模型"的意图 |
| **B. 环境填充** | 角色定义不写；渲染时从环境配置填入 | 意图与可移植兼得 | 多一个配置面；需 `prism role install` 知道目标环境 |
| **C. 角色自带** | 角色定义写 model，直接渲染 | 简单 | 复用到别的环境即错（当前现状） |

### 10.4 推荐

**选项 B**，但严格限定：**环境配置由人声明，Prism 只做机械填充，不判断能力**（与"Prism 不判断模型"一致）。

| 层 | 内容 |
| :--- | :--- |
| Prism 角色定义 | 不写 model；`recommend.capabilities` 声明意图（纯信息） |
| 环境配置 `<PRISM_HOME>/env.yaml` | 人声明本机可用模型与默认映射 |
| 渲染产物 | 按环境填入 model（或按选项 A 省略） |

若选 A，则角色定义与产物都无 model，完全交给 ZCode 会话默认。

### 10.5 导入既有角色时

现有 9 个角色带 model，导入时**保留为"环境特定属性"**并标注：

```yaml
# 导入结果
model: "custom:...:GLM-5.3-Flash"   # 环境特定（导入自 ~/.zcode/agents/dev-1.md）
```

**不自动清除**，但在控制台提示"此字段绑定当前环境，复用到其他环境需调整"。

---

## 14. 目录位置可配置，默认宿主目录（装配语义简化，2026-09-09 用户批准）

**裁决**：运行时只服务一个 harness，角色/团队/Skill 的受管位置**直接就是宿主目录**（"直接住在宿主目录"）。`install` 从"复制装配"退化为"模板初始化/迁移"，源与产物合一，"装配范围"类缺陷随复制语义一并消失。

- 目录来源：`<PRISM_HOME>/prism.yaml`（可选）三个标量键覆盖适配器默认——
  `roles_dir`（默认 `~/.zcode/agents`）、`teams_dir`（默认 `~/.zcode/teams`）、`skills_dir`（默认 `~/.zcode/skills`）；
- 无 prism.yaml 时用适配器默认，开箱即"所见即所得"；
- 解析入口：`@prism/agents` 的 `resolveDirsFromHome(home, { zcodeDir })`（CLI/server 共用）；
- `team install` 不再复制成员角色：① 校验团队与成员 ② 确保团队定义在 teams_dir（旧 Prism 源目录仅一次迁移，之后废弃）③ 输出激活指引；
- `activate` 的 `installed` = roles_dir 中存在该角色文件（扁平/目录式均可）。
- 本节与 §7（团队定义落点）、§10（装配）冲突处以本节为准。

---

## 12. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 采用"harness 原生 + Prism 叠加" | ✅ 是 |
| 2 | 当前支持哪些 harness | ✅ **仅 ZCode** |
| 3 | 接口是否为未来扩展预留 | ✅ 是（编译期多适配器，**运行期只激活一个**） |
| 4 | 角色文件怎么落到 `~/.zcode/agents/` | ✅ **由 Agent-Team Skill 装配**（在宿主环境内渲染并写入） |
| 5 | 人编写的文件冲突如何处理 | ✅ Prism 产物自动重写；人写的（无 marker）不重写只告警 |
| 6 | Prism 扩展是否允许写入 frontmatter | ✅ 不允许（一律放正文） |
| 7 | 角色文件里的 model 怎么处理 | ✅ **由 Skill 在宿主环境内补全**（含 thoughtLevel），化解"环境属性"冲突 |
| 8 | 定义漂移（改了没重扫） | ✅ 自动重写文件；仍需新会话才生效 |
| 9 | 是否支持跨机装配 | ✅ 只做同机 |

