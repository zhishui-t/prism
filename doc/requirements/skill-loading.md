# Prism Skill 管理（讨论稿 v0.4）

> 状态：**讨论稿，待确认**
> 日期：2026-09-09
> 结论：**Skill 直接装在宿主 Skill 目录里管理；抽象放在代码层（适配器）。**

---

## 1. 结论

**运行时只服务一个 harness，所以 Skill 就装在它的目录里直接管理，不做"源目录 + 同步"的双份维护。**

| 项 | 结论 |
| :--- | :--- |
| Skill 位置 | **宿主 Skill 目录**（ZCode：`~/.zcode/skills/<name>/`） |
| 管理方式 | Prism 直接写入/更新该目录 |
| 抽象层 | **代码里**（`HarnessAdapter.skill.nativeDir` 决定路径） |
| 不做 | PRISM_HOME 里的副本、漂移检测、双向同步 |

> 之前设计的"真相源 `<PRISM_HOME>/skills/` + 复制到宿主 + 哈希漂移检测"是**为多目标同步付的成本**。运行时只有一个 harness，这个成本不必要。

---

## 2. 为什么可以简化

| 前提 | 推论 |
| :--- | :--- |
| 运行时只激活一个 harness（见 `deployment-model.md`） | Skill 只有一个目标目录 |
| 目标目录由适配器声明 | 换 harness 只改适配器，不改管理逻辑 |
| Prism 升级时可重跑 install | 不需要"源"来对账 |

**抽象在代码**：`HarnessAdapter.skill.nativeDir` + `provisionSkill()` 决定"装到哪、怎么装"；管理逻辑不硬编码 ZCode 路径。

---

## 3. 安装与更新

```
Prism 包内自带 skill 模板
        ↓ prism skill install / prism init
~/.zcode/skills/<name>/SKILL.md     ← 直接装在这里
```

| 动作 | 行为 |
| :--- | :--- |
| `prism init` | 安装 Prism 全部自带 Skill |
| `prism skill install <name>` | 安装/更新单个 |
| `prism skill update` | 重新写入（Prism 升级后刷新） |
| `prism skill uninstall <name>` | 删除 |

**覆盖策略**：Prism 装的文件直接覆盖；若该 skill 名已被用户手写的 Skill 占用（无 Prism 标记），提示冲突不覆盖。

---

## 4. 约束（ZCode 已核实）

| 约束 | 说明 |
| :--- | :--- |
| 一个 Skill = 一个目录 + `SKILL.md` | `<root>/<name>/SKILL.md` 或 `<root>/<name>.md` |
| frontmatter 必须有 `name` + `description` | 缺则被丢弃并 warn |
| `name` 必须 kebab-case | 否则忽略 |
| 同名 Skill 只有发现顺序最靠前的生效 | 注意别和用户已有 Skill 撞名 |
| description 含冒号必须加引号 | 本机 `find-skills` 踩过此坑 |

---

## 5. 三类资产三种位置

| 资产 | 位置 | 说明 |
| :--- | :--- | :--- |
| MCP server | `~/.zcode/cli/config.json` → `mcp.servers.prism` | 注册 |
| **Skill** | **`~/.zcode/skills/<name>/`** | **直接管理** |
| 角色文件 | `~/.zcode/agents/<role>.md` | 直接管理 |

**统一为"直接写宿主目录"**——由适配器提供路径，Prism 不维护副本。

### 5.1 目录位置可配置，默认宿主目录（装配语义简化，2026-09-09 用户批准）

Skill 的受管位置直接就是宿主目录 `skills_dir`（默认 `~/.zcode/skills`），`<PRISM_HOME>/prism.yaml`（可选）可覆盖三个键：`roles_dir` / `teams_dir` / `skills_dir`；无配置文件时用适配器默认，开箱即"所见即所得"。目录解析入口：`@prism/agents` 的 `resolveDirsFromHome(home, { zcodeDir })`；CLI 的 `prism skill install` 目标目录即取该值，不硬编码。

---

## 6. 待确认项

| # | 问题 | 状态 |
| :--- | :--- | :--- |
| 1 | Skill 直接在宿主目录管理 | ✅ 是 |
| 2 | 是否保留 PRISM_HOME 副本 | ✅ **不保留** |
| 3 | 是否做漂移检测 | ✅ **不做** |
| 4 | 抽象位置 | ✅ 代码层（适配器 `nativeDir` + `provisionSkill`） |
| 5 | Prism 自带 Skill 的模板来源 | ⏳ Prism 包内 / PRISM_HOME 模板 |
| 6 | 与用户手写 Skill 撞名 | ✅ 提示冲突不覆盖 |
