/**
 * 宿主适配器注册表（deployment-model.md §1）：
 * **编译期登记清单里的全部适配器，运行期只激活一个**。
 *
 * 选择优先级：`PRISM_HARNESS` 环境变量 > `prism.yaml: harness` 键 > 默认项。
 * 不做运行时多 harness 路由——换 harness = 改配置重启。
 *
 * 新增 harness **只改 `harness-manifest.ts`**（加一行）；本文件无需改动。
 */

import { createHarnessRegistry, PrismError, type HarnessAdapter } from '@prism/core'

import {
  DEFAULT_HARNESS_ID,
  HARNESS_ENV_VAR,
  HARNESS_MANIFEST,
  type HarnessEntry,
  type HarnessFactoryOptions,
  type PrismHarnessAdapter,
} from './harness-manifest.js'

export type { PrismHarnessAdapter } from './harness-manifest.js'

export interface BuildHarnessRegistryOptions {
  /** harness 根目录（如 ZCode 的 ~/.zcode）；缺省用适配器 `defaultRoot`。 */
  root?: string
  /** @deprecated 用 `root`（保留兼容旧调用）。 */
  zcodeDir?: string
  /** 项目根（renderTeamInstructions 注入 <repo>/AGENTS.md 用）。 */
  repoDir?: string
  /** 清单覆盖（测试用；缺省 HARNESS_MANIFEST）。 */
  manifest?: readonly HarnessEntry[]
}

/**
 * 构建注册表：把清单里登记的全部适配器注册进来（**不激活**）。
 * 调用方用 `resolveHarness()` 决定激活哪个。**新增 harness 不必改本函数**——
 * 只在 `harness-manifest.ts` 的 `HARNESS_MANIFEST` 加一行。
 */
export function buildHarnessRegistry(
  options: BuildHarnessRegistryOptions = {},
): ReturnType<typeof createHarnessRegistry> {
  const registry = createHarnessRegistry()
  const root = options.root ?? options.zcodeDir
  const createOptions: HarnessFactoryOptions = {}
  if (root !== undefined) createOptions.root = root
  if (options.repoDir !== undefined) createOptions.repoDir = options.repoDir
  for (const entry of options.manifest ?? HARNESS_MANIFEST) {
    registry.register(entry.create(createOptions) as unknown as HarnessAdapter)
  }
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

/** 目录布局（由适配器推导；上层不得硬编码宿主目录名）。 */
export interface HarnessLayout {
  /** harness id */
  id: string
  /** 解析后的 harness 根目录 */
  root: string
  /** 角色受管目录（如 ZCode 的 <root>/agents） */
  rolesDir: string
  /** 团队定义目录；适配器未约定则 null（调用方回落到 rolesDir 同级 teams/） */
  teamsDir: string | null
  /** Skill 安装目录；适配器不支持 Skill 则 null */
  skillsDir: string | null
}

/**
 * 解析某个 harness 的目录布局——**新增 harness 的唯二改动点之一**
 * （另一个是 `buildHarnessRegistry` 注册适配器）。
 *
 * @param id   harness id；缺省用默认适配器
 * @param root 根目录覆盖；缺省用适配器 `defaultRoot`
 */
export function harnessLayout(id?: string, root?: string): HarnessLayout {
  const registry = buildHarnessRegistry(root !== undefined ? { root } : {})
  const target = id !== undefined && id !== '' ? id : DEFAULT_HARNESS_ID
  const adapter = registry.activate(target) as unknown as PrismHarnessAdapter
  return {
    id: adapter.id,
    root: root ?? adapter.defaultRoot,
    rolesDir: adapter.agent.globalDir,
    teamsDir: adapter.agent.teamDir,
    skillsDir: adapter.skill.nativeDir,
  }
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
