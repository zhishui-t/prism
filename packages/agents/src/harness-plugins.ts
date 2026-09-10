/**
 * **Harness 适配器插件**：运行期从 `<PRISM_HOME>/harnesses/` 自动发现并注册。
 *
 * 目标（用户诉求）：Prism 发布后，第三方**不改 Prism 代码、不重新编译**，只把适配器
 * 打包丢进运行目录即可被自动注册。
 *
 * ## 目录约定
 *
 * ```
 * <PRISM_HOME>/harnesses/
 *   my-harness/
 *     harness.json          # { "id": "my-harness", "entry": "./index.mjs" }
 *     index.mjs             # 导出适配器（工厂或实例）
 *     ...（插件自带的依赖/资源）
 * ```
 *
 * 清单可用 `harness.json`，或 package.json 的 `prismHarness` 字段：
 * `{ "prismHarness": { "id": "...", "entry": "./index.mjs" } }`。
 *
 * ## 入口导出（按序探测）
 *
 * 1. `export default function createAdapter(opts)` —— **推荐**（可拿到 root/repoDir）
 * 2. `export function createAdapter(opts)`
 * 3. `export default { ...adapter }` —— 直接给实例（忽略 opts）
 * 4. `export const adapter = { ...adapter }`
 *
 * ## 健壮性 / 安全
 *
 * - **加载即执行第三方代码**（插件机制的本质）。只扫描指定目录，不追踪任意路径。
 * - 任一插件失败（清单缺字段 / 导入异常 / 形状不合法 / id 与内置冲突）**只记录、不抛出**，
 *   绝不影响 Prism 启动与其它插件。
 * - 关闭开关：`PRISM_NO_HARNESS_PLUGINS=1`；目录覆盖：`PRISM_HARNESS_DIR`。
 * - 加载是**异步**的，但只在启动时做一次；`buildHarnessRegistry()` 保持同步（读缓存）。
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { prismPaths, type PrismPaths } from '@prism/core'

import { HARNESS_MANIFEST, type HarnessEntry, type HarnessFactoryOptions, type PrismHarnessAdapter } from './harness-manifest.js'

/** 已成功加载的外部适配器（供同步的 buildHarnessRegistry 读取）。 */
let externalEntries: HarnessEntry[] = []
let loaded = false

/** 加载报告（doctor / harness list 展示）。 */
export interface HarnessPluginLoad {
  /** 实际扫描目录 */
  dir: string
  /** 成功加载的适配器 */
  loaded: Array<{ id: string; dir: string; displayName?: string }>
  /** 失败项（不影响启动） */
  errors: Array<{ dir: string; reason: string }>
}

let lastLoad: HarnessPluginLoad | null = null

/** 插件目录（`PRISM_HARNESS_DIR` 可覆盖）。 */
export function harnessPluginsDir(home?: string): string {
  const override = process.env['PRISM_HARNESS_DIR']?.trim()
  if (override !== undefined && override !== '') return override
  return prismPaths(home).harnessesDir
}

function pluginsDisabled(): boolean {
  const v = process.env['PRISM_NO_HARNESS_PLUGINS']
  return v === '1' || v === 'true' || v === 'yes'
}

/** 已加载的外部适配器条目（同步；未加载过则为空——此时仅内置适配器可用）。 */
export function harnessPluginEntries(): readonly HarnessEntry[] {
  return externalEntries
}

/** 上次加载报告（未加载过 → null）。 */
export function harnessPluginReport(): HarnessPluginLoad | null {
  return lastLoad
}

/** 已加载的外部适配器 id 集合（判断某 id 是否来自插件）。 */
export function externalHarnessIds(): ReadonlySet<string> {
  return new Set(externalEntries.map((e) => e.id))
}

/**
 * 扫描并加载插件（幂等：重复调用会**替换**外部适配器集合）。
 * 返回加载报告；**无论成败都不抛**（除极端 IO 外）。
 */
export async function loadHarnessPlugins(home?: string): Promise<HarnessPluginLoad> {
  const dir = harnessPluginsDir(home)
  const report: HarnessPluginLoad = { dir, loaded: [], errors: [] }

  if (pluginsDisabled()) {
    externalEntries = []
    loaded = true
    lastLoad = report
    return report
  }
  if (!existsSync(dir)) {
    externalEntries = []
    loaded = true
    lastLoad = report
    return report
  }

  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch (error) {
    report.errors.push({ dir, reason: `读取插件目录失败: ${msg(error)}` })
    externalEntries = []
    loaded = true
    lastLoad = report
    return report
  }

  const builtinIds = new Set(HARNESS_MANIFEST.map((e) => e.id))
  const next: HarnessEntry[] = []
  const seen = new Set<string>()

  for (const name of names.sort()) {
    const pluginDir = join(dir, name)
    try {
      const entry = await loadOne(pluginDir, builtinIds, seen)
      if (entry !== null) {
        next.push(entry)
        report.loaded.push({ id: entry.id, dir: pluginDir })
      } else {
        // loadOne 已把原因写进 errors（无清单的目录静默跳过，返回 null 且不报错）
      }
    } catch (error) {
      report.errors.push({ dir: pluginDir, reason: msg(error) })
    }
  }

  externalEntries = next
  loaded = true
  lastLoad = report
  return report
}

/** 是否已执行过加载（bootstrap 用；避免重复扫描）。 */
export function harnessPluginsLoaded(): boolean {
  return loaded
}

/** 确保已加载一次（启动/测试入口调用；重复调用无副作用）。 */
export async function ensureHarnessPluginsLoaded(home?: string): Promise<HarnessPluginLoad> {
  if (loaded) return lastLoad ?? { dir: harnessPluginsDir(home), loaded: [], errors: [] }
  return await loadHarnessPlugins(home)
}

/** 仅测试用：重置缓存（便于隔离用例）。 */
export function resetHarnessPlugins(): void {
  externalEntries = []
  loaded = false
  lastLoad = null
}

// ===== 内部 =====

interface PluginManifest {
  id: string
  entry: string
  displayName?: string
}

/** 读插件清单：`harness.json` 优先，其次 package.json#prismHarness。 */
async function readManifest(pluginDir: string): Promise<PluginManifest | null> {
  const harnessJson = join(pluginDir, 'harness.json')
  if (existsSync(harnessJson)) {
    const raw = JSON.parse(await readFile(harnessJson, 'utf-8')) as Record<string, unknown>
    return normalizeManifest(raw, pluginDir)
  }
  const pkgJson = join(pluginDir, 'package.json')
  if (existsSync(pkgJson)) {
    const raw = JSON.parse(await readFile(pkgJson, 'utf-8')) as Record<string, unknown>
    const field = raw['prismHarness']
    if (field !== undefined) {
      const obj = isRecord(field) ? field : {}
      // package.json 场景允许省略 id（用 name）
      return normalizeManifest({ id: obj['id'] ?? raw['name'], ...obj }, pluginDir)
    }
  }
  return null // 无清单 → 不是插件目录，静默跳过
}

function normalizeManifest(raw: Record<string, unknown>, pluginDir: string): PluginManifest {
  const id = typeof raw['id'] === 'string' ? raw['id'].trim() : ''
  if (id === '') throw new Error('清单缺 id（harness.json.id 或 package.json#prismHarness.id）')
  const entryRaw = typeof raw['entry'] === 'string' ? raw['entry'].trim() : ''
  const entry = entryRaw === '' ? 'index.mjs' : entryRaw
  const displayName = typeof raw['displayName'] === 'string' ? raw['displayName'] : undefined
  const entryAbs = resolve(pluginDir, entry)
  if (!existsSync(entryAbs)) throw new Error(`清单 entry 不存在: ${entry}（解析为 ${entryAbs}）`)
  return displayName !== undefined ? { id, entry, displayName } : { id, entry }
}

/** 加载单个插件目录，返回条目；无清单 → null（静默）。 */
async function loadOne(
  pluginDir: string,
  builtinIds: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): Promise<HarnessEntry | null> {
  const manifest = await readManifest(pluginDir)
  if (manifest === null) return null

  if (builtinIds.has(manifest.id)) {
    throw new Error(`适配器 id 与内置冲突: ${manifest.id}（插件不得覆盖内置，请换 id）`)
  }
  if (seen.has(manifest.id)) {
    throw new Error(`适配器 id 重复: ${manifest.id}（多个插件声明了同一 id）`)
  }

  const entryAbs = resolve(pluginDir, manifest.entry)
  const mod = (await import(pathToFileURL(entryAbs).href)) as Record<string, unknown>
  const create = resolveFactory(mod, manifest)
  // 立即试构造一次，尽早暴露形状错误（构造应廉价、无副作用）
  const probe = create({})
  assertAdapterShape(probe, manifest.id)

  return { id: manifest.id, create }
}

/** 从模块导出里解析出工厂函数。 */
function resolveFactory(state: Record<string, unknown>, manifest: PluginManifest): (opts: HarnessFactoryOptions) => PrismHarnessAdapter {
  const dflt = state['default']
  if (typeof dflt === 'function') return dflt as (opts: HarnessFactoryOptions) => PrismHarnessAdapter
  const named = state['createAdapter']
  if (typeof named === 'function') return named as (opts: HarnessFactoryOptions) => PrismHarnessAdapter
  if (isRecord(dflt)) return () => dflt as unknown as PrismHarnessAdapter
  const adapterObj = state['adapter']
  if (isRecord(adapterObj)) return () => adapterObj as unknown as PrismHarnessAdapter
  throw new Error(
    `入口未导出适配器（${manifest.entry}）：需 export default function createAdapter(opts) 或 export const adapter = {...}`,
  )
}

/** 结构校验：缺关键字段则视为非法插件。 */
function assertAdapterShape(a: unknown, expectedId: string): void {
  if (!isRecord(a)) throw new Error('适配器不是对象')
  if (typeof a['id'] !== 'string' || a['id'] === '') throw new Error('适配器缺 id')
  if (a['id'] !== expectedId) throw new Error(`适配器 id（${String(a['id'])}）与清单（${expectedId}）不一致`)
  if (typeof a['displayName'] !== 'string') throw new Error('适配器缺 displayName')
  if (typeof a['defaultRoot'] !== 'string' || a['defaultRoot'] === '') throw new Error('适配器缺 defaultRoot')
  const agent = a['agent']
  if (!isRecord(agent) || typeof agent['globalDir'] !== 'string' || agent['globalDir'] === '') {
    throw new Error('适配器缺 agent.globalDir')
  }
  const skill = a['skill']
  if (!isRecord(skill) || typeof skill['format'] !== 'string') throw new Error('适配器缺 skill.format')
  if (typeof a['detect'] !== 'function') throw new Error('适配器缺 detect()')
  if (typeof a['renderRole'] !== 'function') throw new Error('适配器缺 renderRole()')
  if (typeof a['parseRole'] !== 'function') throw new Error('适配器缺 parseRole()')
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 供外部复用的类型（插件作者可用）。 */
export type { PrismPaths }
