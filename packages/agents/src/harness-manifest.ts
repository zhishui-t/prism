/**
 * Harness 适配器清单 —— **新增 harness 的唯一改动点**。
 *
 * 过去新增一个 harness 要改四处：写适配器 + `harness.ts` 注册 + `harness-id.ts` 加 id
 * 常量与默认值 + `index.ts` 加命名导出。后三处纯样板、易漏改。
 *
 * 现在只有两件事：
 *   1. 在 `adapters/<id>.ts` 写适配器实现（真实逻辑，无法省略）；
 *   2. **在下面 `HARNESS_MANIFEST` 加一行**：
 *      `{ id: MY_ID, create: createMyAdapter }`
 *
 * 简单 harness 甚至可把实现内联在这里，做到「只改一个文件」。
 * `DEFAULT_HARNESS_ID` 取 `isDefault: true` 者，缺省取首项——无需另设常量。
 *
 * 目录布局由适配器 `agent.globalDir` / `agent.teamDir` / `skill.nativeDir` 自述，
 * 上层（dirs / CLI / server / MCP）经 `harnessLayout()` 消费，均不硬编码。
 */

import type { HarnessAdapter } from '@prism/core'

import { createZcodeAdapter, ZCODE_ADAPTER_ID } from './adapters/zcode.js'
import type { RoleDefinition, TeamDefinition } from './types.js'

/** 适配器构造选项：所有 harness 通用（根目录 + 项目根）。 */
export interface HarnessFactoryOptions {
  /** harness 根目录（如 ZCode 的 ~/.zcode）；缺省用适配器 `defaultRoot`。 */
  root?: string
  /** 项目根（注入项目级指令文件用，如 <repo>/AGENTS.md）。 */
  repoDir?: string
  /** @deprecated 用 `root`（兼容旧调用）。 */
  zcodeDir?: string
}

/** 适配器类型（Role/Team 具体化）。 */
export type PrismHarnessAdapter = HarnessAdapter<RoleDefinition, TeamDefinition>

/** 清单条目：id + 构造函数。 */
export interface HarnessEntry {
  /** 适配器 id（`PRISM_HARNESS` / prism.yaml `harness` 键取值）。 */
  id: string
  /** 构造适配器。上层注入 root/repoDir。 */
  create: (opts: HarnessFactoryOptions) => PrismHarnessAdapter
  /** 是否为默认激活项；缺省取清单首项。 */
  isDefault?: boolean
}

/**
 * ⬇⬇⬇ 新增 harness：在数组里加一行即可 ⬇⬇⬇
 *
 * 例（假设已写 adapters/claude-code.ts 并导出 createClaudeCodeAdapter / CLAUDE_CODE_ADAPTER_ID）：
 *   import { createClaudeCodeAdapter, CLAUDE_CODE_ADAPTER_ID } from './adapters/claude-code.js'
 *   ...
 *   { id: CLAUDE_CODE_ADAPTER_ID, create: createClaudeCodeAdapter },
 */
export const HARNESS_MANIFEST: readonly HarnessEntry[] = [
  { id: ZCODE_ADAPTER_ID, create: createZcodeAdapter },
]

/** 默认激活的 harness id：显式 `isDefault` 优先，否则首项。 */
export const DEFAULT_HARNESS_ID: string =
  HARNESS_MANIFEST.find((e) => e.isDefault === true)?.id ?? HARNESS_MANIFEST[0]!.id

/** 临时覆盖 prism.yaml `harness` 键的环境变量名。 */
export const HARNESS_ENV_VAR = 'PRISM_HARNESS'
