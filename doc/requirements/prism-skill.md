# Prism Skill 设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：Prism 自己作为 ZCode Skill 的形态、职责与内容。
> 与 harness 适配的关系：**这个 Skill 就是装配器 + 使用入口**（见 harness-adapters.md §10）。

---

## 1. 为什么 Prism 需要一个 Skill

宿主 agent 不会自动知道"有 Prism 可用"。Skill 是 ZCode 的原生机制，承担三件事：

| 职责 | 说明 |
| :--- | :--- |
| **装配器** | 拉取 Prism 角色/团队定义 → 补全 model/thoughtLevel → 写入 `~/.zcode/agents/` |
| **使用入口** | 告诉 agent 何时、如何调用 Prism 的 MCP 工具 |
| **约定载体** | 把知识分层、来源标注、图谱优先等约定注入 agent 行为 |

---

## 2. Skill 格式（已核实）

**frontmatter 只有两个字段**：

```yaml
---
name: prism
description: "……触发条件与能力描述……"
---
```

> 实测：`graphify` / `cangjie` / `agent-team` 的 frontmatter 都只有 `name` + `description`。**description 含冒号必须加引号**（本机 `find-skills` 就因此解析失败）。

**存放位置：直接装在宿主 Skill 目录**：

```
Prism 包内自带模板
├── SKILL.md
├── references/
│   ├── knowledge.md
│   ├── graph.md
│   ├── team.md
│   └── tools.md
├── templates/
│   ├── role-agents.md
│   └── team-agents.md
└── scripts/
    └── assemble.mjs
        ↓ prism skill install / prism init
~/.zcode/skills/prism/           ← 直接装在这里，Prism 管理
```

**为什么直接装**：运行时只服务一个 harness（ZCode），Skill 只有一个目标目录，**不需要"源 + 同步"的双份维护**。目标路径由适配器 `skill.nativeDir` 决定，抽象在代码层——换 harness 只改适配器。

**更新**：Prism 升级后 `prism skill update` 重新写入覆盖（Prism 装的文件）；若与用户手写 Skill 撞名则提示冲突不覆盖。

---

## 3. SKILL.md 草案

### 3.1 frontmatter

```yaml
---
name: prism
description: "接入 Prism 知识库与代码图谱，并装配专家角色/团队。用于：查编码规范与安全红线、查代码图谱与影响面、装配团队角色到 ZCode。触发词：「prism」「查规范」「查知识库」「代码图谱」「影响面」「装配团队」「启用团队」。注意：纯代码结构问答优先用 graphify；产品全流程用 itp；本 Skill 负责 Prism 服务接入与团队装配。"
---
```

**description 三要素**（照 agent-team/graphify 的写法）：
1. 能力陈述；
2. 触发词；
3. 与相邻 Skill 的分工（"用 X 而不是本 Skill"）。

### 3.2 正文骨架

```markdown
# Prism — 知识库 · 代码图谱 · 专家团队

Prism 是团队的知识与协作控制面：知识库（规范/红线/架构）、代码图谱、专家角色与团队。
它不执行任务，只供料与台账。

## 快速判定：什么时候用

| 用户意图 | 用什么 |
| :--- | :--- |
| 查编码规范/安全红线/架构决策 | `prism_kb_search` |
| 问代码结构、谁调用谁 | 优先 `graphify`；需影响面时用 `prism_graph_affected` |
| 派团队干活 | 先装配（§装配）再让队长派发 |
| 记录经验/沉淀知识 | `prism_kb_deposit` |

## 装配（把角色放进 ZCode）

ZCode 只在会话启动扫描 `~/.zcode/agents/`。装配步骤：
1. `prism_team_get <team>` 拉取团队与角色定义；
2. 按本机可用模型补全 model/thoughtLevel；
3. 写入 `~/.zcode/agents/<role>.md`；
4. 提示"**下一会话生效**"。

细节见 `references/team.md`。

## 知识库用法

- 分层：global（公司）/ project（本项目）/ role（专家专属）
- 检索默认返回最新版次；引用时标注来源地址
- 详见 `references/knowledge.md`

## 代码图谱用法

- 用查询换 token，**不要读全图**
- `prism_graph_query` / `prism_graph_path` / `prism_graph_explain` / `prism_graph_affected`
- 详见 `references/graph.md`

## 工具速查

见 `references/tools.md`。
```

---

## 4. 渐进披露（progressive disclosure）

照 graphify 的做法：**主文档只放骨架与判定表，细节进 `references/`**，需要时才读。

| 文件 | 何时读 |
| :--- | :--- |
| `references/knowledge.md` | 需要检索/落库/版本语义细节 |
| `references/graph.md` | 需要图谱查询/建图/陈旧检测 |
| `references/team.md` | 需要装配/启用团队 |
| `references/tools.md` | 需要完整 MCP 工具签名 |

**好处**：SKILL.md 保持精炼，不把全部细节塞进每次触发。

---

## 5. 装配脚本

```
scripts/assemble.mjs --team <team-id> [--dry-run] [--force]
```

| 步骤 | 行为 |
| :--- | :--- |
| 拉取 | MCP `prism_team_get` |
| 补全 | 读本机可用模型，按 `recommend.capabilities` 选 model/thoughtLevel |
| 渲染 | 生成 ZCode 格式 |
| 写入 | `~/.zcode/agents/<role>.md`（带 Prism marker） |
| 漂移 | 对比哈希；不一致自动重写（人写的文件不重写） |
| 输出 | 装配报告 + "下一会话生效"提示 |

---

## 6. Skill 与 MCP 的关系

| 层 | 作用 |
| :--- | :--- |
| **Skill** | 告诉 agent **何时/如何**用 Prism（行为约定、装配流程） |
| **MCP server** | 提供**实际能力**（工具调用） |

**Skill 是说明书，MCP 是工具箱。** 两者配合：Skill 触发后，agent 才知道去调哪些 MCP 工具。

---

## 7. 与已有 Skill 的分工

| Skill | 职责 | 边界 |
| :--- | :--- | :--- |
| **prism**（本 Skill） | Prism 接入、知识/图谱查询、团队装配 | 不做产品全流程、不做通用代码结构问答 |
| `graphify` | 代码库结构问答、建图 | 纯代码图谱；Prism 的知识与团队不归它 |
| `agent-team` | 动态组队协作（队长手册） | 负责"怎么干活"；Prism 负责"供什么料" |
| `itp` | 产品从想法到上线 | 全流程；与 Prism 的团队装配不同层 |

**注意交叉**：`agent-team` 也用 `~/.zcode/agents/` 的角色库。Prism 装配的角色**就是**那个角色库的内容——两者是同一批文件，不冲突，但文档要写清"Prism 装配的角色可被 agent-team 直接使用"。

---

## 8. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | Prism Skill 是否同时做装配器与使用入口 | ✅ 是 |
| 2 | Skill 存放位置 | ✅ **直接装在 `~/.zcode/skills/prism/`**（不维护副本） |
| 3 | Prism 自有 Skill 放哪 | ✅ 直接装宿主 Skill 目录，路径由适配器决定 |
| 4 | 是否含 scripts/assemble.mjs | ⏳ 含 / 装配走 CLI |
| 5 | 与 agent-team 的角色库共享关系 | ✅ 共享 `~/.zcode/agents/`（Prism 装配的角色可被 agent-team 直接用） |
| 6 | description 触发词 | ⏳ 待定稿 |
