/**
 * 目录解析（装配语义简化，用户已批准）：**直接住在宿主目录**。
 *
 * `<PRISM_HOME>/prism.yaml`（可选配置，四个标量键）覆盖适配器默认值；
 * 无配置 → 用 ZCode 适配器默认（开箱即"所见即所得"）：
 *   harness:    <默认 zcode>（运行时激活的宿主适配器）
 *   roles_dir:  <默认 ~/.zcode/agents>
 *   teams_dir:  <默认 ~/.zcode/teams>（roles_dir 的**同级** teams/，不在 agents/ 内）
 *   skills_dir: <默认 ~/.zcode/skills>
 *
 * **teams_dir 为何不在 agents/ 下（R3 实测，返工单 B7）**：ZCode 的角色扫描
 * `collectAgentMarkdownPaths` 会**递归**遍历 `~/.zcode/agents/` 下全部 `.md`
 * （源码见 D:\Program Files\ZCode\resources\app.asar → /out/host/index.js），
 * 团队文件 frontmatter 恰好含 `name`+`description`（ZCode 注册 agent 的判据），
 * 会被静默注册成一个假 agent，污染宿主 agent 命名空间。故团队落在 roles_dir 的
 * **同级** `teams/`：仍在宿主目录树内可被人工查看，但不在任何 agent 扫描路径上。
 *
 * prism.yaml 解析为**最小实现**：逐行 `key: value`，只认上述四个标量键；
 * `#` 注释与空行忽略，值可带单/双引号，未知键忽略（宽松，不做完整 YAML parser）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, dirname, join } from 'node:path'

import { prismHome } from '@prism/core'

import { DEFAULT_ZCODE_DIR } from './adapters/zcode.js'
import { DEFAULT_HARNESS_ID } from './harness-id.js'

/** prism.yaml 的标量键（仅这些键，多余键忽略）。 */
export interface PrismDirConfig {
  /** 运行时激活的宿主适配器 id（默认 zcode；见 deployment-model.md §1）。 */
  harness?: string
  roles_dir?: string
  teams_dir?: string
  skills_dir?: string
}

/** 目录键（不含 harness）。 */
export type PrismDirKey = 'roles_dir' | 'teams_dir' | 'skills_dir'

/** 解析后的目录集。 */
export interface ResolvedDirs {
  /** 角色受管目录（默认宿主 `~/.zcode/agents`，扁平 <role>.md）。 */
  rolesDir: string
  /** 团队定义受管目录（默认 `~/.zcode/teams`——roles_dir 的同级，不在 agents/ 扫描路径内）。 */
  teamsDir: string
  /** Skill 受管目录（默认宿主 `~/.zcode/skills`）。 */
  skillsDir: string
  /** 来源：'config' = prism.yaml 存在（键缺省仍回落默认）；'default' = 无配置文件。 */
  source: 'config' | 'default'
  /** 运行时激活的宿主适配器 id（prism.yaml `harness` 键；缺省 zcode）。 */
  harness: string
  /** 作为默认推导基准的 ZCode 根。 */
  zcodeDir: string
  /**
   * **写守卫（B6）**：逐键标记该目录是否取自「默认链」——
   * 即既非 prism.yaml 显式配置、也非调用方显式指定 zcodeDir，而是回落到真实宿主默认（~/.zcode）。
   * guard=true 的目录**写前必须确认**（CLI：--yes / --zcode-dir / prism.yaml）。
   */
  guard: {
    roles: boolean
    teams: boolean
    skills: boolean
  }
}

/** 读 `<PRISM_HOME>/prism.yaml`（home 缺省用 prismHome()）；文件不存在 → null。 */
export function loadPrismConfig(home?: string): PrismDirConfig | null {
  const file = join(home ?? prismHome(), 'prism.yaml')
  if (!existsSync(file)) return null
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null // 不可读按无配置处理（与"可选配置"语义一致）
  }
  return parsePrismConfig(raw)
}

/** prism.yaml 最小解析：只认 harness/roles_dir/teams_dir/skills_dir 四个标量键。 */
export function parsePrismConfig(raw: string): PrismDirConfig {
  const config: PrismDirConfig = {}
  const KNOWN: readonly string[] = ['harness', 'roles_dir', 'teams_dir', 'skills_dir']
  for (const rawLine of raw.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!KNOWN.includes(key)) continue
    let value = line.slice(idx + 1).trim()
    // 去行尾注释（值内不得含 " #"——这些键都是路径/标识，足够）
    const hash = value.indexOf(' #')
    if (hash !== -1) value = value.slice(0, hash).trim()
    if (value === '') continue
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    if (key === 'harness') config.harness = value
    else if (key === 'roles_dir') config.roles_dir = value
    else if (key === 'teams_dir') config.teams_dir = value
    else if (key === 'skills_dir') config.skills_dir = value
  }
  return config
}

/** 展开 `~` 前缀为用户主目录（prism.yaml 里的路径可能是 ~ 形式；非 ~ 开头原样返回）。 */
export function expandTildePath(path: string): string {
  if (path === '~') return homedir()
  if (path === '~/' || path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2))
  }
  return path
}

/**
 * 解析目录集：prism.yaml 显式键 > 适配器默认（由 zcodeDir 推导）。
 * @param config prism.yaml 解析结果（null/undefined = 无配置文件，全默认）
 * @param opts.zcodeDir 适配器根（缺省 ~/.zcode；CLI 显式 --zcode-dir 也从这里进）
 * @param opts.zcodeDirExplicit 调用方是否显式指定了 zcodeDir（仅 CLI 的 --zcode-dir / prism.yaml 键算显式；
 *   env ZCODE_DIR 只重定向默认链落点、**不算显式**——守卫保持生效，测试可用它安全隔离；
 *   false 且键无配置 → guard=true，写前需确认，B6 防护）
 */
export function resolveDirs(
  config?: PrismDirConfig | null,
  opts: { zcodeDir?: string; zcodeDirExplicit?: boolean } = {},
): ResolvedDirs {
  const zcodeDir = opts.zcodeDir ?? DEFAULT_ZCODE_DIR
  const explicit = opts.zcodeDirExplicit === true
  const rolesDir = join(zcodeDir, 'agents')
  const resolved: ResolvedDirs = {
    rolesDir,
    // teams 落在 roles_dir 的**同级**（默认 ~/.zcode/teams），避开 ZCode 对 agents/ 的递归扫描（B7）
    teamsDir: join(dirname(rolesDir), 'teams'),
    skillsDir: join(zcodeDir, 'skills'),
    source: config !== null && config !== undefined ? 'config' : 'default',
    harness: config?.harness !== undefined && config.harness !== '' ? config.harness : DEFAULT_HARNESS_ID,
    zcodeDir,
    guard: { roles: true, teams: true, skills: true },
  }
  const has = (key: keyof PrismDirConfig): boolean =>
    config !== null && config !== undefined && config[key] !== undefined && config[key] !== ''
  // 显式 zcodeDir → 全部放行；否则逐键按「prism.yaml 是否配置」判定（teams 缺省跟随 roles_dir 落点）
  if (!explicit) {
    resolved.guard.roles = !has('roles_dir')
    resolved.guard.teams = !has('teams_dir') && !has('roles_dir')
    resolved.guard.skills = !has('skills_dir')
  } else {
    resolved.guard = { roles: false, teams: false, skills: false }
  }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value === undefined || value === '') continue
    const expanded = expandTildePath(value)
    const absolute = isAbsolute(expanded) ? expanded : join(zcodeDir, expanded) // 相对路径相对 ZCode 根解释
    if (key === 'roles_dir') resolved.rolesDir = absolute
    else if (key === 'teams_dir') resolved.teamsDir = absolute
    else if (key === 'skills_dir') resolved.skillsDir = absolute
  }
  // teams_dir 未显式配置时跟随 roles_dir 的**同级** teams/ ——与 guard.teams 的判定口径保持一致
  // （guard 按「roles_dir 已配置 → teams 视为显式跟随」放行，落点必须同样跟随，否则守卫放行却写默认宿主，qa 快审实测踩中）
  if (!has('teams_dir') && has('roles_dir')) {
    resolved.teamsDir = join(dirname(resolved.rolesDir), 'teams')
  }
  return resolved
}

/** 便捷组合：读 `<home>/prism.yaml` 并解析（CLI/server 共用入口）。 */
export function resolveDirsFromHome(
  home?: string,
  opts: { zcodeDir?: string; zcodeDirExplicit?: boolean } = {},
): ResolvedDirs {
  return resolveDirs(loadPrismConfig(home), opts)
}
