/**
 * 宿主适配器注册表（deployment-model.md §1）：
 * **编译期登记全部适配器，运行期只激活一个**。
 *
 * 选择优先级：`PRISM_HARNESS` 环境变量 > `prism.yaml: harness` 键 > 默认 `zcode`。
 * 不做运行时多 harness 路由——换 harness = 改配置重启。
 *
 * 目前只编译进 ZCode 适配器；未来新增 harness 在此注册即可，其余代码不动。
 */

import { createHarnessRegistry, PrismError, type HarnessAdapter } from '@prism/core'

import { createZcodeAdapter } from './adapters/zcode.js'
import { DEFAULT_HARNESS_ID, HARNESS_ENV_VAR } from './harness-id.js'
import type { RoleDefinition, TeamDefinition } from './types.js'

export type PrismHarnessAdapter = HarnessAdapter<RoleDefinition, TeamDefinition>

export interface BuildHarnessRegistryOptions {
  /** 适配器根目录（当前 = ZCode 根，如 ~/.zcode）；缺省用适配器默认。 */
  zcodeDir?: string
  /** 项目根（renderTeamInstructions 注入 <repo>/AGENTS.md 用）。 */
  repoDir?: string
}

/**
 * 构建注册表并登记全部已编译适配器（**不激活**）。
 * 调用方用 `resolveHarness()` 决定激活哪个。
 */
export function buildHarnessRegistry(
  options: BuildHarnessRegistryOptions = {},
): ReturnType<typeof createHarnessRegistry> {
  const registry = createHarnessRegistry()
  const adapterOptions: { zcodeDir?: string; repoDir?: string } = {}
  if (options.zcodeDir !== undefined) adapterOptions.zcodeDir = options.zcodeDir
  if (options.repoDir !== undefined) adapterOptions.repoDir = options.repoDir
  registry.register(createZcodeAdapter(adapterOptions) as unknown as HarnessAdapter)
  return registry
}

export interface ResolveHarnessOptions extends BuildHarnessRegistryOptions {
  /** prism.yaml 的 harness 键（优先级低于环境变量） */
  configuredId?: string
  /** 环境变量覆盖（缺省读 process.env.PRISM_HARNESS） */
  env?: NodeJS.ProcessEnv
}

export interface ResolvedHarness {
  adapter: PrismHarnessAdapter
  /** 实际激活的 id */
  id: string
  /** 来源：'env' | 'config' | 'default' */
  source: 'env' | 'config' | 'default'
  /** 全部已编译适配器 id（供 harness list 展示） */
  available: string[]
}

/**
 * 解析并激活唯一适配器。
 * 优先级：env `PRISM_HARNESS` > prism.yaml `harness` > 默认 zcode。
 * 未知 id → PrismError('harness_not_found')，附可用列表。
 */
export function resolveHarness(options: ResolveHarnessOptions = {}): ResolvedHarness {
  const registry = buildHarnessRegistry(options)
  const available = registry.list().map((a) => a.id)

  const envId = (options.env ?? process.env)[HARNESS_ENV_VAR]?.trim()
  const configured = options.configuredId?.trim()
  const id = envId !== undefined && envId !== '' ? envId : configured !== undefined && configured !== '' ? configured : DEFAULT_HARNESS_ID
  const source: ResolvedHarness['source'] =
    envId !== undefined && envId !== '' ? 'env' : configured !== undefined && configured !== '' ? 'config' : 'default'

  if (!available.includes(id)) {
    throw new PrismError(
      'harness_not_found',
      `未知 harness: ${id}（已编译: ${available.join(', ')}）；检查 prism.yaml 的 harness 键或 PRISM_HARNESS 环境变量`,
      { requested: id, available },
    )
  }
  const adapter = registry.activate(id) as unknown as PrismHarnessAdapter
  return { adapter, id, source, available }
}

/** 适配器约定摘要（供 `prism harness show` / MCP 展示）。 */
export function harnessSummary(adapter: PrismHarnessAdapter): {
  id: string
  displayName: string
  agent: PrismHarnessAdapter['agent']
  skill: PrismHarnessAdapter['skill']
  dispatch: PrismHarnessAdapter['dispatch']
  model: PrismHarnessAdapter['model']
  instructions: PrismHarnessAdapter['instructions']
} {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    agent: adapter.agent,
    skill: adapter.skill,
    dispatch: adapter.dispatch,
    model: adapter.model,
    instructions: adapter.instructions,
  }
}
