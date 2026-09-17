# 宿主适配器示例

Prism 支持**运行期插件**接入新宿主：不改 Prism 源码、不需重新编译，把适配器目录放进
`<PRISM_HOME>/harnesses/<id>/` 即可（见 `doc/requirements/adding-a-harness.md`）。

| 目录 | 宿主 | 说明 |
| :--- | :--- | :--- |
| `workbuddy/` | WorkBuddy | 平铺 `mcpServers` 形态的 MCP 注册 + `<root>/skills` Skill 目录 |

## 安装 WorkBuddy 适配器

```bash
cp -r examples/harnesses/workbuddy <PRISM_HOME>/harnesses/
# 激活（任选其一）
printf 'harness: workbuddy\n' >> <PRISM_HOME>/prism.yaml      # 持久
PRISM_HARNESS=workbuddy prism harness list                    # 临时

prism harness list        # 应看到 workbuddy [插件]
prism init --yes          # 落点是适配器自述的 defaultRoot（~/.workbuddy），故不需 --harness-root
```

`prism init` 会：把内置 Skill 装到 `~/.workbuddy/skills/`，并把 MCP 注册合并写入
`~/.workbuddy/mcp.json`（平铺形态，写前备份 `mcp.json.bak-prism-init-<ts>`）。

> `--harness-root` 在 init 语境是**测试/CI 专用**（把落点重定向到临时目录）。正常接入新宿主
> 走 `--yes`：落点由**激活适配器**的 `defaultRoot` 决定，给插件宿主硬传路径反而容易写错地方。
> init 误在项目目录生成的 `cli/config.json` / `mcp.json` **可直接删除**（宿主不读该位置）。

## 核实与未核实的约定

适配器自述的宿主约定分两类，**不要混读**：

- ✅ **已核实**：Skill 目录 `~/.workbuddy/skills/<name>/SKILL.md`；MCP 注册 `~/.workbuddy/mcp.json`
  的平铺 `mcpServers`；项目指令 `<repo>/AGENTS.md`。
- ⚠️ **未核实**：`~/.workbuddy/agents/*.md`（角色文件）。WorkBuddy 没有公开的「角色目录」约定，
  故 `prism role new` / 团队启用落在该目录的产物是**惰性产物**——流程完整、可审计，但不宣称被宿主加载。

`mcp.configFile` 的 JSON 形态由适配器 `mcp.format` 决定，`prism init` 按形态分派写入：

| format | 写入位置 | 条目形态 |
| :--- | :--- | :--- |
| `mcp-servers-json` | `{ mcp: { servers: { prism: {...} } } }` | 含 `type`/`timeoutMs`（ZCode） |
| `mcpServers-json` | `{ mcpServers: { prism: {...} } }` | 仅 `command`/`args`/`env`（WorkBuddy / VS Code） |

> 历史坑：`prism init` 曾把 ZCode 的嵌套形态写死。若用平铺形态的宿主，会**静默写到错误的层级**
> （宿主读不到，还往人家配置里塞了无意义的 `mcp` 键）。现已按 `mcp.format` 分派，并有
> `packages/cli/test/init-mcp-format.test.ts` 双向锁定。
