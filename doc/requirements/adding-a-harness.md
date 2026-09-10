# 新增一个 harness（宿主适配器）

> **结论：不必改 Prism 代码、不必重新编译。** 把适配器包放进
> `<PRISM_HOME>/harnesses/<你的名字>/`，Prism 启动时**自动发现并注册**。
> 目录只要一个 `harness.json`（或 package.json 的 `prismHarness` 字段）+ 一个入口 `.mjs`。
>
> 想让某个 harness 成为内置默认，才需要改 Prism 源码（见文末「内置适配器」）。

## 插件方式（推荐）

```
<PRISM_HOME>/harnesses/
  my-harness/
    harness.json       # { "id": "my-harness", "entry": "./index.mjs" }
    index.mjs          # 导出适配器
```

`index.mjs` 导出适配器，任选一种：

```js
// ① 推荐：工厂（能拿到 root/repoDir）
export default function createAdapter(opts) {
  const root = opts.root ?? '/Users/me/.my-harness'
  return {
    id: 'my-harness',
    displayName: 'My Harness',
    defaultRoot: root,                       // 未显式指定根时用它
    detect: async () => ({ installed: true, configDir: root }),
    agent: {
      globalDir: root + '/agents',
      projectDir: opts.repoDir ? opts.repoDir + '/.my-harness/agents' : null,
      filePattern: '<role>.md',
      teamDir: root + '/teams',              // 可 null（回落到 agents 同级 teams/）
      frontmatterFields: ['name', 'description'],
      bodyConvention: '## 核心契约',
      activation: 'session-start',
      nameMustMatchFile: true,
    },
    dispatch: null,                          // 无子 agent 机制 → null
    model: null,                             // 不可声明模型 → null
    skill: { nativeDir: root + '/skills', ecosystemDir: null, format: 'SKILL.md', supported: true },
    instructions: { file: 'AGENTS.md', projectFile: '<repo>/AGENTS.md' },
    renderRole: (role) => ({ path: '', content: '', format: 'markdown', writePolicy: 'overwrite', marker: '' }),
    parseRole: (content, filename) => ({}),
    renderTeamInstructions: () => null,
  }
}
```

```js
// ② 也可：export function createAdapter(opts) {...}
// ③ 也可：export const adapter = { ...实例... }（忽略 opts）
// ④ 也可：export default { ...实例... }
```

激活：

```bash
PRISM_HARNESS=my-harness prism harness show    # 或写入 prism.yaml：harness: my-harness
```

查询：

```bash
prism harness list          # 内置 + 插件（标注来源），并显示插件目录
prism doctor                # harness_plugins 检查：加载了几个、有无失败
```

### 骨架约定（`harness.json`）

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `id` | ✅ | 适配器 id，须与入口导出的 `id` 一致，且**不得与内置冲突** |
| `entry` | | 入口文件，相对插件目录；缺省 `index.mjs` |
| `displayName` | | 仅展示用（入口里的 `displayName` 优先） |

也可用 `package.json`：`"prismHarness": { "id": "my-harness", "entry": "./index.mjs" }`
（省略 `id` 时取 package `name`）。

### 健壮性与安全

- **插件加载即执行其代码**（插件机制的本质）。Prism 只扫描 `harnesses/` 目录，不追踪任意路径。
- 任一插件失败（清单缺字段 / 入口不存在 / id 与内置冲突 / 结构不合法）**只记录、不抛出**，
  不影响 Prism 启动与其它插件；`prism harness list` / `prism doctor` 会显示失败原因。
- 结构校验：`id`/`displayName`/`defaultRoot`/`agent.globalDir`/`skill.format` 必填，
  `detect`/`renderRole`/`parseRole` 必须是函数。

### 环境变量

| 变量 | 作用 |
| :--- | :--- |
| `PRISM_HARNESS` | 激活哪个适配器（优先级最高） |
| `PRISM_HARNESS_DIR` | 覆盖插件目录（缺省 `<PRISM_HOME>/harnesses`） |
| `PRISM_NO_HARNESS_PLUGINS=1` | 禁用插件加载（仅用内置） |
| `PRISM_HARNESS_ROOT` | 覆盖 harness 根目录 |

## 内置适配器（改源码，仅当要进 Prism 发行版）

若某 harness 要成为**内置**（随 Prism 发布、无插件目录也默认可用）：

1. 在 `packages/agents/src/adapters/<id>.ts` 写适配器实现；
2. 在 `packages/agents/src/harness-manifest.ts` 的 `HARNESS_MANIFEST` 加一行
   `{ id, create }`（`isDefault: true` 可设默认项）。

内置与插件走**同一套接口**，插件方式的一切约定（目录自述等）都适用。

## 为什么能做到「零侵入」

历史坑（两轮才修完，2026-09-10）：
1. 目录名曾写死在 4 处（`dirs.ts` 的 `join(root,'agents'|'teams'|'skills')`、CLI 的
   `--zcode-dir`、server 的 `zcodePaths`/`defaultZcodeDir`、MCP 的 `~/.zcode` 兜底）；
2. 登记样板曾分散在 `harness.ts`（注册）+ `harness-id.ts`（id 常量/默认值）+
   `index.ts`（逐适配器导出）；
3. 适配器曾是**编译期**清单，第三方必须改源码重编译。

现在统一为**数据驱动 + 运行期插件**：

| 关注点 | 唯一来源 | 消费方 |
| :--- | :--- | :--- |
| 登记项（内置/插件） | `HARNESS_MANIFEST` + `harnesses/` | `buildHarnessRegistry()` |
| 默认项 | 清单 `isDefault`（缺省首项） | `resolveHarness()` |
| 根目录默认 | `adapter.defaultRoot` | `harnessLayout()` |
| 角色目录 | `adapter.agent.globalDir` | `resolveDirs()` |
| 团队目录 | `adapter.agent.teamDir` | `resolveDirs()` |
| Skill 目录 | `adapter.skill.nativeDir` | `resolveDirs()` / installSkills |
| 角色文件形态 | `adapter.agent.filePattern` / `frontmatterFields` | install / render |
| 派发/模型/指令文件 | `adapter.dispatch` / `.model` / `.instructions` | MCP 只读展示 |


## 已知的「不在适配器内」约定

以下与具体 harness 无关，属 Prism 自身/init 域，不必下沉到适配器：

- `prism.yaml` 里 `roles_dir`/`teams_dir`/`skills_dir` 的**显式覆盖**（优先级最高，用户说了算）；
- MCP 注册文件 `cli/config.json` 的形态（`zcodePaths().configFile`，init-and-registration §2）；
- **写守卫（B6）**：回落真实宿主默认根时写操作必须确认（`--yes` / 显式根目录 / prism.yaml）。
