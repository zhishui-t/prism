# Prism 接入初始化设计（讨论稿 v0.1）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 范围：Prism 首次接入 ZCode 时的一次性初始化动作。
> 结论：**接入时运行一次初始化，把 MCP server 与 Skill 注册写进 ZCode 配置。**
>
> **v4 修订（2026-09-11）**：`init` **不再播种任何团队**（是否建团队由使用者决定），
> 也不再预建 `<PRISM_HOME>/teams`（那是旧版团队源目录，非受管位置）；
> `team install` / `role import` / `role install` 已移除——角色/团队直接住在宿主目录。
> 下文 §1 表格与 §4 流程中的 install/装配步骤均作废，保留为历史记录。
>
> **v6 修订（2026-09-12）**：建角色 / 建团队的动作名 `init` → **`new`**，并补齐 `edit` / `rm`
> （CLI / MCP / HTTP 三入口同名同位）。本文档下文出现 `prism role init` / `prism team init`
> 之处一律读作 `role new` / `team new`。

---

## 1. 为什么需要初始化

Prism 的 MCP 工具和 Skill 都**不在 ZCode 的默认发现范围内**，必须显式接入：

| 资产 | ZCode 如何发现 | 初始化做什么 |
| :--- | :--- | :--- |
| MCP server | 读 `~/.zcode/cli/config.json` 的 `mcp.servers` | 写入 `mcp.servers.prism` |
| Skill | 扫描 `~/.zcode/skills/` 等固定目录 | **直接安装** Prism Skill 进去 |
| 角色文件 | 扫描 `~/.zcode/agents/` | **不代写**：由使用者/agent 直接写入（`prism role init` 或手写 `<name>.md`） |

**初始化 = 让 ZCode 知道 Prism 存在。**

> **纠错**：`~/.zcode/cli/config.json` 的 `skills` 段**不是注册机制**，而是**禁用覆盖**（disable overrides）。Skill 直接装进 ZCode 的 skills 目录（见 `skill-loading.md`）。

---

## 2. 配置文件结构（已核实）

`~/.zcode/cli/config.json`：

```json
{
  "mcp": { "servers": { ... } },
  "skills": { "<绝对路径>/SKILL.md": { "enable": false } },   // 仅禁用覆盖
  "plugins": { "enabledPlugins": { ... } }
}
```

结构分键，初始化可**合并写入**，不触碰 `plugins` 与其他 MCP server。

---

## 3. 初始化动作

```
prism init
  ① 探测 ZCode（~/.zcode 是否存在）
  ② 备份 ~/.zcode/cli/config.json
  ③ 合并写入 mcp.servers.prism
  ④ 安装 Prism Skill 到 ~/.zcode/skills/
  ⑤ 创建 <PRISM_HOME> 目录骨架
  ⑥ 输出报告（改了什么、如何回滚）
```

### 3.1 写入内容

```jsonc
// ~/.zcode/cli/config.json（合并，不覆盖其他键）
{
  "mcp": {
    "servers": {
      // 保留原有 photoshop 等
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

```yaml
# 安装（非配置）：Prism 自带 Skill → ~/.zcode/skills/<name>/
```

### 3.2 目录布局

```
Prism 包内（npm 包，只读模板）              # 出厂内容
├── templates/roles/*.md
├── templates/teams/*.md
├── templates/skills/*/SKILL.md
└── bin/prism-mcp.js

<PRISM_HOME>/                              # 运行时数据
├── knowledge/{global,project,role}        # 知识库（文件为真相）
├── state/                                 # SQLite
├── catalog/                               # 宿主声明的模型清单
└── audit/

~/.zcode/                                  # 宿主目录（安装目标，Prism 直接管理）
├── agents/<role>.md                       # 角色（ZCode 扫描）
├── teams/<team>.md                        # 团队定义（Prism 管理；不在 agents/ 内，避开宿主递归扫描）
├── skills/<name>/SKILL.md                 # Skill（ZCode 扫描）
└── cli/config.json                        # MCP 注册
```

**单向安装**：包内模板 → 宿主目录。**安装后宿主目录就是唯一受管位置**，PRISM_HOME 不再保留副本，也不做漂移检测。

---

## 4. 幂等与安全

| 项 | 策略 |
| :--- | :--- |
| **幂等** | 重复 `prism init` 结果一致（合并写入，不重复追加） |
| **备份** | 写入前备份 `config.json`（沿用本机惯例 `config.json.bak-<reason>-<ts>`） |
| **不覆盖** | 只增/改 `mcp.servers.prism`，其余键原样保留 |
| **冲突** | 若已存在但指向不同路径 → 提示并询问（`--force` 才覆盖） |
| **回滚** | `prism uninit` 移除 Prism 的配置项，恢复备份 |
| **格式** | JSON 读→解析→合并→写；YAML 数组追加（不用字符串拼接） |

---

## 5. 与其它命令的关系

| 命令 | 作用 | 时机 |
| :--- | :--- | :--- |
| `prism init` | 注册 MCP + Skill，建目录骨架 | **一次性**（首次接入 / 升级后重跑） |
| `prism team install <team>` | 装配角色文件到 `~/.zcode/agents/` | 每次团队变更 |
| `prism team activate <team>` | 返回运行时配置 | 每次干活 |
| `prism uninit` | 撤销注册 | 卸载时 |

**初始化不装配角色**——角色是团队维度的，由 `team install` 负责。

---

## 6. 升级场景

| 情况 | 处理 |
| :--- | :--- |
| Prism 升级后 MCP 入口路径变了 | 重跑 `prism init` 更新注册 |
| 新增 Prism Skill | 重跑 `prism init` 或 `prism skill register` |
| ZCode 配置被手动改动 | 初始化时检测漂移并提示 |

---

## 7. 首次使用的完整体验

```bash
# ① 初始化（一次性）
prism init
#   ✓ 已注册 MCP server: prism
#   ✓ 已注册 Skill: prism
#   ✓ 已创建 ~/.prism 目录骨架
#   ⚠ 请重启 ZCode 会话使配置生效

# ② 装配团队（把角色写进 ZCode）
prism team install core-dev
#   ✓ 装配 5 个角色到 ~/.zcode/agents/
#   ⚠ 请开新会话使角色生效

# ③ 开新会话后即可使用
#   宿主 agent 会自动看到 prism Skill 与 MCP 工具
```

---

## 8. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | 接入需要一次性初始化 | ✅ 是 |
| 2 | 初始化写什么 | ✅ MCP server + Skill 注册 + 目录骨架 |
| 3 | 是否自动备份 ZCode 配置 | ⏳ 自动备份 / 不备份 |
| 4 | MCP 传输默认 | ⏳ stdio / HTTP |
| 5 | 是否提供 `prism uninit` | ⏳ 提供 / 不提供 |
| 6 | 初始化是否也装配默认团队 | ⏳ 否（角色归 team install） / 是 |
