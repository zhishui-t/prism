/**
 * 角色/团队 wiring（返工单 B4）：server 侧**只保留装配点与信封适配**，
 * 解析/校验/渲染/装配/启用一律委托 `@prism/agents`（消除契约镜像漂移）。
 *
 * glue 职责（均为对 agents API 的组合，不含重复实现）：
 * - loadRoles/loadRole/loadTeams/loadTeam：目录式数据源加载 + issues 挂载（P9；
 *   角色走 agents RoleRegistry（含重名检查），团队在 agents validateTeam 上补 issues）
 * - installTeam：成员角色装配 + 团队定义装配的组合（前置成员存在性校验）
 * - parseRoleFile：agents parseRoleMarkdown 的签名兼容 shim（filename 回落）
 * - renderPrismRole：Prism 原生角色序列化（agents renderMarkdownFile 组合；agents 无等价物，CLI 导入落盘用）
 * - zcodePaths/defaultZcodeDir：路径约定取自 agents ZCode 适配器（configFile 是 init 域约定，适配器没有）
 * - installedSkillNames：已装 skill 名单（knownSkills 校验输入）
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DEFAULT_ZCODE_DIR,
  createRoleRegistry,
  createTeamRegistry,
  createZcodeAdapter,
  installRoles as installAgentsRoles,
  installTeamDefinitions,
  parseRoleMarkdown,
  parseTeamMarkdown,
  renderMarkdownFile,
  validateRole,
  validateTeam,
  type FrontmatterData,
  type InstallResult,
  type RoleDefinition,
  type TeamDefinition,
} from '@prism/agents'
import { PrismError } from '@prism/core'

// ---------------------------------------------------------------------------
// 路径约定（agents ZCode 适配器推导；P14：子路径只在此处出现）
// ---------------------------------------------------------------------------

export interface ZcodePaths {
  root: string
  /** `~/.zcode/agents`（角色产物目录 = adapter.agent.globalDir） */
  agentsDir: string
  /** `~/.zcode/teams`（团队定义产物目录 = adapter.agent.teamDir；不在 agents/ 内，避开宿主递归扫描 B7） */
  teamDir: string
  /** `~/.zcode/skills`（Skill 安装目录 = adapter.skill.nativeDir） */
  skillsDir: string
  /** `~/.zcode/cli/config.json`（MCP 注册；init-and-registration §2，适配器约定之外） */
  configFile: string
}

export function zcodePaths(zcodeDir: string): ZcodePaths {
  const adapter = createZcodeAdapter({ zcodeDir })
  return {
    root: zcodeDir,
    agentsDir: adapter.agent.globalDir,
    teamDir: adapter.agent.teamDir ?? join(zcodeDir, 'teams'),
    skillsDir: adapter.skill.nativeDir ?? join(zcodeDir, 'skills'),
    configFile: join(zcodeDir, 'cli', 'config.json'),
  }
}

/** 默认 ZCode 目录（探测起点；不存在时调用方警告但继续，design-v3 §3.6 ①）。 */
export function defaultZcodeDir(): string {
  return process.env['ZCODE_DIR'] ?? DEFAULT_ZCODE_DIR
}

/** 已安装 skill 名单（读 `<zcodeDir>/skills/*` 目录名，只读）；目录不存在 → undefined（跳过引用校验）。 */
export async function installedSkillNames(zcodeDir: string): Promise<string[] | undefined> {
  const dir = zcodePaths(zcodeDir).skillsDir
  if (!existsSync(dir)) {
    return undefined
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 加载 + issues 挂载（P9）
// ---------------------------------------------------------------------------

/** 加载角色库（agents RoleRegistry：双形态 + 目录名基准校验 + 重名检查；issues 已挂载）。 */
export async function loadRoles(rolesDir: string, opts: { knownSkills?: string[] } = {}): Promise<RoleDefinition[]> {
  const { roles } = await createRoleRegistry().importFromDirDetailed(rolesDir)
  if (opts.knownSkills === undefined) {
    return roles
  }
  // agents registry 校验不含 knownSkills：补跑一次并只并入 skill_unknown warning（其余码已挂载）
  return roles.map((role) => ({
    ...role,
    issues: [
      ...(role.issues ?? []),
      ...validateRole(role, { knownSkills: opts.knownSkills }).issues.filter((i) => i.code === 'skill_unknown'),
    ],
  }))
}

/** 加载单个角色：双形态探测 `<rolesDir>/<name>/AGENTS.md`（Prism 目录式）与 `<rolesDir>/<name>.md`（ZCode 扁平，装配语义简化后的默认 roles_dir 形态）；不存在 → null。 */
export async function loadRole(
  rolesDir: string,
  name: string,
  opts: { knownSkills?: string[] } = {},
): Promise<RoleDefinition | null> {
  const candidates = [join(rolesDir, name, 'AGENTS.md'), join(rolesDir, `${name}.md`)]
  const file = candidates.find((c) => existsSync(c))
  if (file === undefined) {
    return null
  }
  const role = parseRoleMarkdown(await readFile(file, 'utf-8'), { sourcePath: file })
  return { ...role, issues: validateRole(role, { dirname: name, knownSkills: opts.knownSkills }).issues }
}

/** 加载团队库（agents TeamRegistry）+ validateTeam 挂 issues（registry 不带角色库上下文）。 */
export async function loadTeams(
  teamsDir: string,
  opts: { roles?: RoleDefinition[]; rolesDir?: string; knownSkills?: string[] } = {},
): Promise<TeamDefinition[]> {
  const { teams } = await createTeamRegistry().loadFromDirDetailed(teamsDir)
  const roles = opts.roles ?? (opts.rolesDir !== undefined ? await loadRoles(opts.rolesDir) : [])
  return teams
    .map((team) => ({ ...team, issues: validateTeam(team, { roles, knownSkills: opts.knownSkills }).issues }))
    .sort((a, b) => a.team_id.localeCompare(b.team_id))
}

/** 加载单个团队：双形态探测 `<teamsDir>/<id>/AGENTS.md` 与 `<teamsDir>/<id>.md`（agents installTeamDefinitions 的产物形态）；不存在 → null。 */
export async function loadTeam(
  teamsDir: string,
  teamId: string,
  opts: { roles?: RoleDefinition[]; rolesDir?: string; knownSkills?: string[] } = {},
): Promise<TeamDefinition | null> {
  const candidates = [join(teamsDir, teamId, 'AGENTS.md'), join(teamsDir, `${teamId}.md`)]
  const file = candidates.find((c) => existsSync(c))
  if (file === undefined) {
    return null
  }
  const roles = opts.roles ?? (opts.rolesDir !== undefined ? await loadRoles(opts.rolesDir) : [])
  const team = parseTeamMarkdown(await readFile(file, 'utf-8'), { sourcePath: file })
  return { ...team, issues: validateTeam(team, { roles, knownSkills: opts.knownSkills }).issues }
}

// ---------------------------------------------------------------------------
// 装配组合
// ---------------------------------------------------------------------------

export interface InstallTeamOptions {
  /** 成员角色全量（已从角色库加载） */
  roles: RoleDefinition[]
  /** 团队定义（agents TeamDefinition） */
  team: TeamDefinition
  /** ZCode agents 目录（成员角色落点） */
  agentsDir: string
  /** 团队定义落点（默认 `<zcodeDir>/teams`；B7：绝不再写 `<agentsDir>/teams`，会被宿主误注册为 agent） */
  teamDir?: string
  env?: { model?: string; thoughtLevel?: string }
  force?: boolean
}

/**
 * 装配团队（design-v3 §3.3 P3）：成员角色 → `<agentsDir>/<role>.md`，
 * 团队定义 → `<teamDir ?? <agentsDir>/../teams>/<team_id>.md`（agents 冲突策略 §5）。装配后
 * 「下一会话生效」提示由调用方负责。
 */
export async function installTeam(opts: InstallTeamOptions): Promise<InstallResult> {
  const memberNames = new Set(opts.team.members.map((m) => m.role))
  // 大小写不敏感匹配（队长裁决 2026-09-09 口径；与 agents validateTeam 的成员解析一致，如 QA-checker/qa-checker 等价）
  const missing = [...memberNames].filter(
    (name) => !opts.roles.some((r) => r.name.toLowerCase() === name.toLowerCase()),
  )
  if (missing.length > 0) {
    throw new PrismError('bad_request', `团队成员角色缺失，无法装配: ${missing.join(', ')}；先 prism role import / 补齐角色定义`)
  }
  const rolesResult = await installAgentsRoles({
    targetDir: opts.agentsDir,
    roles: opts.roles,
    env: opts.env,
    force: opts.force,
  })
  const teamsDir = opts.teamDir ?? join(opts.agentsDir, '..', 'teams')
  const teamResult = await installTeamDefinitions({ targetDir: opts.agentsDir, teamsDir, teams: [opts.team], force: opts.force })
  return {
    written: [...rolesResult.written, ...teamResult.written],
    skipped: [...rolesResult.skipped, ...teamResult.skipped],
  }
}

// ---------------------------------------------------------------------------
// 兼容 shim / Prism 原生序列化（agents 无等价导出）
// ---------------------------------------------------------------------------

export interface ParseRoleOptions {
  /** 兼容参数：校验基准由 loadRole/loadRoles 的 validateRole({dirname}) 承担 */
  dirname?: string
  /** frontmatter 缺 name 时的回落名（ZCode 硬约束下仅防御性使用） */
  filename?: string
  sourcePath?: string
  /** 兼容参数：agents parseRoleMarkdown 内建双形态（导入缺省补 skills/knowledge） */
  mode?: 'prism' | 'zcode'
}

/** agents parseRoleMarkdown 的签名兼容 shim（filename 回落；导入缺省由 agents 内建）。 */
export function parseRoleFile(raw: string, opts: ParseRoleOptions = {}): RoleDefinition {
  const role = parseRoleMarkdown(raw, { sourcePath: opts.sourcePath })
  if (role.name === '' && opts.filename !== undefined) {
    role.name = opts.filename.replace(/\.md$/i, '')
  }
  return role
}

/**
 * 序列化为 Prism 原生角色定义（`<roles>/<id>/AGENTS.md`；role-definition §3.2 + §5 导入补全）：
 * frontmatter 含 skills 白名单与 knowledge 绑定（ZCode 格式放不下的 Prism 扩展都在这里）。
 * 基于 agents renderMarkdownFile/serializeFrontmatter 组合。
 */
export function renderPrismRole(role: RoleDefinition): string {
  const knowledge: FrontmatterData = { layers: [...role.knowledge.layers] }
  if (role.knowledge.books !== undefined) {
    knowledge['books'] = [...role.knowledge.books]
  }
  const fm: FrontmatterData = {
    name: role.name,
    description: role.description,
    skills: [...role.skills],
    knowledge,
  }
  if (role.color !== undefined) {
    fm['color'] = role.color
  }
  if (role.model !== undefined) {
    fm['model'] = role.model
  }
  if (role.thoughtLevel !== undefined) {
    fm['thoughtLevel'] = role.thoughtLevel
  }
  if (role.injectAgentsMd !== undefined) {
    fm['injectAgentsMd'] = role.injectAgentsMd
  }
  return renderMarkdownFile(fm, `${role.body.trim()}\n`)
}
