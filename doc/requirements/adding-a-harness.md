# 新增一个 harness（宿主适配器）

> **结论：新增 harness = 只改一个文件 `packages/agents/src/harness-manifest.ts`**
> （在 `HARNESS_MANIFEST` 加一行 `{ id, create }`）。
> 适配器实现可放 `adapters/<id>.ts`，简单 harness 甚至能内联在清单里。
> 目录布局、CLI 根目录、MCP 数据源全部由适配器自述推导，其余文件无需改动。
> 若你发现要改 `harness.ts` / `dirs.ts` / `index.ts` / CLI / server，那是耦合 bug。

## 唯一登记点：`harness-manifest.ts`

```ts
// packages/agents/src/harness-manifest.ts
import { createMyAdapter, MY_ADAPTER_ID } from './adapters/my-harness.js'

export const HARNESS_MANIFEST: readonly HarnessEntry[] = [
  { id: ZCODE_ADAPTER_ID, create: createZcodeAdapter },
  { id: MY_ADAPTER_ID, create: createMyAdapter },   // ← 只加这一行
]
```

- `DEFAULT_HARNESS_ID` 自动取 `isDefault: true` 的条目（缺省取首项），**不需要**再维护
  一个 id 常量文件（旧的 `harness-id.ts` 已删除）。
- `index.ts` 无需为新 harness 追加命名导出——消费方用 `HARNESS_MANIFEST` /
  `resolveHarness()` / `harnessLayout()` 这些**通用符号**即可。

## 为什么能做到「只改一处」

历史坑（两轮才修完，2026-09-10）：
1. 目录名曾写死在 4 处（`dirs.ts` 的 `join(root,'agents'|'teams'|'skills')`、CLI 的
   `--zcode-dir`、server 的 `zcodePaths`/`defaultZcodeDir`、MCP 的 `~/.zcode` 兜底）；
2. 登记样板曾分散在 `harness.ts`（注册）+ `harness-id.ts`（id 常量/默认值）+
   `index.ts`（逐适配器导出）。

现在统一为**数据驱动 + 单一清单**：

| 关注点 | 唯一来源 | 消费方 |
| :--- | :--- | :--- |
| 登记项 / 默认项 | `HARNESS_MANIFEST` | `buildHarnessRegistry()` |
| 根目录默认 | `adapter.defaultRoot` | `harnessLayout()` → `defaultZcodeDir()` |
| 角色目录 | `adapter.agent.globalDir` | `resolveDirs()` |
| 团队目录 | `adapter.agent.teamDir` | `resolveDirs()` |
| Skill 目录 | `adapter.skill.nativeDir` | `resolveDirs()` / installSkills |
| 角色文件形态 | `adapter.agent.filePattern` / `frontmatterFields` | install / render |
| 派发/模型/指令文件 | `adapter.dispatch` / `.model` / `.instructions` | MCP 只读展示 |

## 步骤

### 1. 写适配器

新建 `packages/agents/src/adapters/<id>.ts`，实现 `HarnessAdapter<RoleDefinition, TeamDefinition>`
（接口见 `packages/core/src/harness/adapter.ts`，逐字段有注释）：

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessAdapter } from '@prism/core'
import type { RoleDefinition, TeamDefinition } from '../types.js'

export const MY_ADAPTER_ID = 'myharness'

export function createMyAdapter(opts: { root?: string; repoDir?: string } = {}): HarnessAdapter<RoleDefinition, TeamDefinition> {
  const root = opts.root ?? join(homedir(), '.myharness')
  return {
    id: MY_ADAPTER_ID,
    displayName: 'My Harness',
    defaultRoot: root,                       // ← 上层所有默认目录由它推导
    detect: async () => ({ installed: true, configDir: root }),
    agent: {
      globalDir: join(root, 'agents'),
      projectDir: opts.repoDir ? join(opts.repoDir, '.myharness', 'agents') : null,
      filePattern: '<role>.md',
      teamDir: join(root, 'teams'),          // 无独立团队目录可给 null（上层回落到 agents 同级 teams/）
      frontmatterFields: ['name', 'description'],
      bodyConvention: '## 核心契约',
      activation: 'session-start',           // 或 'immediate' | 'restart' | 'unknown'
      nameMustMatchFile: true,
    },
    dispatch: null,                          // 无子 agent 机制 → null
    model: null,                             // 不可声明模型 → null
    skill: { nativeDir: join(root, 'skills'), ecosystemDir: null, format: 'SKILL.md', supported: true },
    instructions: { file: 'AGENTS.md', projectFile: '<repo>/AGENTS.md' },
    renderRole: (role) => ({ path: join(root, 'agents', `${role.name}.md`), content: '...', format: 'markdown', writePolicy: 'overwrite', marker: '...' }),
    parseRole: (content, filename) => ({ /* 解析回 RoleDefinition */ } as RoleDefinition),
    renderTeamInstructions: (team) => null,
  }
}
```

### 2. 登记（唯一一处改动）

在 `packages/agents/src/harness-manifest.ts` 的 `HARNESS_MANIFEST` 加一行：

```ts
{ id: MY_ADAPTER_ID, create: createMyAdapter },
```

**不需要**改 `harness.ts`（自动遍历清单注册）、**不需要**加 id 常量文件、**不需要**
改 `index.ts` 导出。

### 3. 激活

```bash
PRISM_HARNESS=myharness prism harness show     # 环境变量（优先级最高）
# 或写入 <PRISM_HOME>/prism.yaml：harness: myharness
```

## 验证清单

- [ ] `pnpm -r typecheck && pnpm lint`
- [ ] `pnpm test`（`harness-layout.test.ts` + `harness-manifest.test.ts` 锁死
      「布局随适配器变」「清单加一行即可激活」）
- [ ] `PRISM_HARNESS=<id> prism harness show` 输出的目录与适配器自述一致
- [ ] `PRISM_HARNESS=<id> prism role install ...` 落到适配器声明的 `globalDir`
- [ ] 用适配器的 `parseRole` 跑通一次导入（往返一致）

## 已知的「不在适配器内」约定

以下与具体 harness 无关，属 Prism 自身/init 域，不必下沉到适配器：

- `prism.yaml` 里 `roles_dir`/`teams_dir`/`skills_dir` 的**显式覆盖**（优先级最高，用户说了算）；
- MCP 注册文件 `cli/config.json` 的形态（`zcodePaths().configFile`，init-and-registration §2）；
- **写守卫（B6）**：回落真实宿主默认根时写操作必须确认（`--yes` / 显式根目录 / prism.yaml）。
