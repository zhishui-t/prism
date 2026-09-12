/**
 * 角色/团队 wiring（返工单 B4）：server 侧**只保留加载与信封适配**，
 * 解析/校验/渲染/启用一律委托 `@prism/agents`（消除契约镜像漂移）。
 *
 * glue 职责（均为对 agents API 的组合，不含重复实现）：
 * - loadRoles/loadRole/loadTeams/loadTeam：目录式数据源加载 + issues 挂载（P9；
 *   角色走 agents RoleRegistry（含重名检查），团队在 agents validateTeam 上补 issues）
 * - harnessPaths/defaultHarnessRoot：路径约定取自 agents ZCode 适配器（configFile 是 init 域约定，适配器没有）
 * - installedSkillNames：已装 skill 名单（knownSkills 校验输入）
 *
 * 2026-09-11：`installTeam` / `parseRoleFile` / `renderPrismRole` 已随「装配/导入」语义一并移除
 * （角色/团队就直接住在宿主目录，没有第二份副本可搬运；建角色走 `role new` 或直接写文件）。
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  harnessLayout,
  resolveHarness,
  computeEffectiveSkills,
  createRoleRegistry,
  createTeamRegistry,
  loadPrismConfig,
  parseRoleMarkdown,
  parseTeamMarkdown,
  resolveTeamExtends,
  validateRole,
  validateTeam,
  type EffectiveSkillSet,
  type RoleDefinition,
  type TeamDefinition,
} from '@prism/agents'
import { PrismError, type McpConvention } from '@prism/core'
import { listBuiltinSkills } from '@prism/skills'

// ---------------------------------------------------------------------------
// 路径约定（agents ZCode 适配器推导；P14：子路径只在此处出现）
// ---------------------------------------------------------------------------

/** MCP 注册形态缺省：适配器未声明 `mcp` 时按 ZCode 嵌套形态处理（历史行为）。 */
const DEFAULT_MCP_FORMAT: McpConvention['format'] = 'mcp-servers-json'
/** MCP 服务条目名缺省。 */
const DEFAULT_MCP_SERVER_NAME = 'prism'

export interface HarnessPaths {
  root: string
  /** `<root>/agents`（角色产物目录 = adapter.agent.globalDir） */
  agentsDir: string
  /** 团队定义产物目录 = adapter.agent.teamDir；未约定则 <root>/teams（不在 agents/ 内，避开宿主递归扫描 B7） */
  teamDir: string
  /** Skill 安装目录 = adapter.skill.nativeDir；不支持则 <root>/skills */
  skillsDir: string
  /**
   * MCP 注册配置文件（= adapter.mcp.configFile）；
   * **null = 该 harness 无 MCP 注册机制**（init 跳过注册并提示）。
   */
  configFile: string | null
  /**
   * MCP 注册写入形态（= adapter.mcp.format）——决定条目放 JSON 的哪一层。
   * configFile 为 null 时无意义。
   */
  mcpFormat: McpConvention['format']
  /** MCP 服务条目名（= adapter.mcp.serverName；缺省 `prism`）。 */
  mcpServerName: string
}

/**
 * 适配器路径约定。经 `resolveHarness` 激活当前配置的适配器
 * （优先级：`PRISM_HARNESS` 环境变量 > `prism.yaml: harness` > 默认项）——
 * 路径全部由适配器自述，接入其他 harness 时自动跟随，调用方无需改动。
 *
 * **`home` 必须由调用方显式传入**才能读到 `prism.yaml` 的 `harness` 键——这是刻意的：
 * 早期实现只传 harnessRoot，`resolveHarness` 看不到 prism.yaml，若 prism.yaml 声明了插件
 * 适配器会**静默回落到内置 zcode**（MCP 注册写错位置）；但不传 home 时若反过来去读
 * 标准 PRISM_HOME，单测就会被**运行机器的真实配置**左右（这类"环境泄漏"正是历史上
 * 间歇假红的来源）。故取「显式传入才生效」——生产调用方（init/role/people/mcp）都传。
 *
 * @param harnessRoot harness 根目录（显式指定或由适配器 defaultRoot 推导）
 * @param home        PRISM_HOME（prism.yaml 所在目录）；缺省 → 不读 prism.yaml（仅 env 决定）
 */
/**
 * 解析当前激活的适配器（口径与 `harnessPaths` 完全一致：env `PRISM_HARNESS` > prism.yaml `harness` > 默认）。
 * 写盘前需要「宿主原生形态」的渲染器时用它——渲染规则归适配器，server 不自造。
 */
export function harnessAdapterOf(harnessRoot: string, home?: string): ReturnType<typeof resolveHarness>['adapter'] {
  const configuredId = home !== undefined && home !== '' ? loadPrismConfig(home)?.harness : undefined
  return resolveHarness({
    harnessRoot,
    ...(configuredId !== undefined && configuredId !== '' ? { configuredId } : {}),
  }).adapter
}

/**
 * 角色渲染器（宿主原生形态；`role new` 写盘前取）。
 * frontmatter 只含该适配器声明的白名单字段，Prism 扩展落正文 overlay 小节。
 */
export function roleRendererFor(harnessRoot: string, home?: string): (role: RoleDefinition) => string {
  const adapter = harnessAdapterOf(harnessRoot, home)
  return (role: RoleDefinition): string => adapter.renderRole(role).content
}

export function harnessPaths(harnessRoot: string, home?: string): HarnessPaths {
  const adapter = harnessAdapterOf(harnessRoot, home)
  return {
    root: harnessRoot,
    agentsDir: adapter.agent.globalDir,
    teamDir: adapter.agent.teamDir ?? join(harnessRoot, 'teams'),
    skillsDir: adapter.skill.nativeDir ?? join(harnessRoot, 'skills'),
    configFile: adapter.mcp?.configFile ?? null,
    mcpFormat: adapter.mcp?.format ?? DEFAULT_MCP_FORMAT,
    mcpServerName: adapter.mcp?.serverName ?? DEFAULT_MCP_SERVER_NAME,
  }
}

/**
 * 默认 harness 根目录（探测起点；不存在时调用方警告但继续，design-v3 §3.6 ①）。
 *
 * 覆盖优先级：`PRISM_HARNESS_ROOT`（通用） > **配置激活的适配器** `defaultRoot`（`prism.yaml: harness`
 * 或 env `PRISM_HARNESS`）> 内置 zcode。
 * 注意：`ZCODE_DIR` **不在此生效**——它是 ZCode 专属旧变量，由 zcode 适配器自己消费
 * （见 adapters/zcode.ts），否则会泄漏到其它 harness。
 *
 * **`home` 必须由调用方显式传入**才能读到 `prism.yaml` 的 `harness` 键（口径同 `harnessPaths`）；
 * 不传则只认 env。这不是可选优化——适配器工厂把传入的 root 当 `opts.root`，会**覆盖插件自述的
 * `defaultRoot`**：早期实现硬用 `harnessLayout()`（= 内置 zcode），在 prism.yaml 声明插件适配器时
 * 会把 `~/.zcode` 塞给插件，于是 MCP 注册与 Skill 全部落到 **zcode 目录**（实测：WorkBuddy 宿主上
 * `~/.zcode/mcp.json` 被写出，而 `~/.workbuddy/skills/prism` 从未更新）。
 */
export function defaultHarnessRoot(home?: string): string {
  const envRoot = process.env['PRISM_HARNESS_ROOT']
  if (envRoot !== undefined && envRoot !== '') return envRoot
  const configuredId = home !== undefined && home !== '' ? loadPrismConfig(home)?.harness : undefined
  return harnessLayout(configuredId).root
}

/** 已安装 skill 名单（读 `<harnessRoot>/skills/*` 目录名，只读）；目录不存在 → undefined（跳过引用校验）。 */
export async function installedSkillNames(harnessRoot: string, home?: string): Promise<string[] | undefined> {
  const dir = harnessPaths(harnessRoot, home).skillsDir
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

/** 加载单个团队：双形态探测 `<teamsDir>/<id>/AGENTS.md` 与 `<teamsDir>/<id>.md`（目录式 / 扁平均识别）；不存在 → null。 */
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
  const declared = new Set<string>()
  const parsed = parseTeamMarkdown(await readFile(file, 'utf-8'), { sourcePath: file, declaredKeys: declared })
  // extends 解析（team-definition.md §2.1）：父级做基底，子级显式声明覆盖
  const team =
    parsed.extends !== null && parsed.extends !== ''
      ? await resolveTeamExtends({ team: parsed, declared }, async (id) => await loadTeamRaw(teamsDir, id))
      : parsed
  return { ...team, issues: validateTeam(team, { roles, knownSkills: opts.knownSkills }).issues }
}

/**
 * 「团队不存在」文案单点（ui-spec-v4 §8-D5）。
 *
 * **真实落点在前**：`<teamsDir>/<id>.md` 是 `team new` / MCP `prism_team_new`
 * 的落盘形态；
 * 目录式 `<id>/AGENTS.md` 仍可被 `loadTeam` 双形态探测到，故只作**兼容形态**附带说明。
 * HTTP / MCP / KB 三面共用本函数——文案曾是三个变体（显式镜像漂移），收敛到此处。
 */
export function teamNotFoundMessage(teamsDir: string, teamId: string): string {
  return `团队不存在: ${teamId}（数据源 ${teamsDir}/<id>.md，兼容 <id>/AGENTS.md 双形态）`
}

/**
 * 「角色不存在」文案单点（与 {@link teamNotFoundMessage} 同口径）。
 *
 * 补此函数的理由（2026-09-12）：团队侧已收敛到单点，但**角色侧没有单点**——
 * `loadEffectiveSkills` 内联一份（目录式在前），CLI 又各自硬编码**只报目录式**
 * （`role.ts` / `team.ts` 共四处），同一错误出现三种形态；而 CLI 报的恰好是
 * 已被降级为**兼容形态**的那种，与「扁平 `<name>.md` 才是落盘形态」相矛盾。
 */
export function roleNotFoundMessage(rolesDir: string, roleId: string): string {
  return `角色不存在: ${roleId}（数据源 ${rolesDir}/<name>.md，兼容 <name>/AGENTS.md 双形态）`
}

/** 不做 extends/校验的原样加载（extends 链的父级解析用，避免递归校验）。 */
async function loadTeamRaw(teamsDir: string, teamId: string): Promise<TeamDefinition | null> {
  const candidates = [join(teamsDir, teamId, 'AGENTS.md'), join(teamsDir, `${teamId}.md`)]
  const file = candidates.find((c) => existsSync(c))
  if (file === undefined) return null
  const declared = new Set<string>()
  const parsed = parseTeamMarkdown(await readFile(file, 'utf-8'), { sourcePath: file, declaredKeys: declared })
  if (parsed.extends === null || parsed.extends === '') return parsed
  return await resolveTeamExtends({ team: parsed, declared }, async (id) => await loadTeamRaw(teamsDir, id))
}

// ---------------------------------------------------------------------------
// Skill 有效集装配（F-D2 / design-v4 §3.4：「四处口径一致」的唯一保证）
// ---------------------------------------------------------------------------

export interface LoadEffectiveSkillsInput {
  /** 角色 id（不存在 → `PrismError('not_found')`，HTTP 侧即 404 信封） */
  roleId: string
  /** 团队 id（可选；提供但不存在 → 同样 `not_found`，不静默降级为「无团队」） */
  teamId?: string
  teamsDir: string
  rolesDir: string
  harnessRoot: string
  /** PRISM_HOME（读 prism.yaml 的 harness 键，决定 skills 目录归属）；缺省 → 标准 PRISM_HOME。 */
  home?: string
}

/**
 * 有效 Skill 集装配：取角色定义 + （可选）团队定义 + 已装名单 → 调纯函数
 * `computeEffectiveSkills`（`@prism/agents`）。**MCP / HTTP / CLI 三入口共用本函数**，
 * 因此「同角色同团队 → 同输出」可判定、可测试（design-v4 §F-D1/F-D2）。
 *
 * `installed` 缺省（宿主 skills 目录不存在）→ 不判 `skill_not_installed`，与既有
 * `installedSkillNames()` 语义一致；`known` = 内置清单 ∪ 已装（判 `skill_unknown`）。
 */
export async function loadEffectiveSkills(input: LoadEffectiveSkillsInput): Promise<EffectiveSkillSet> {
  const installed = await installedSkillNames(input.harnessRoot, input.home)
  const known = [...listBuiltinSkills().map((skill) => skill.name), ...(installed ?? [])]

  const role = await loadRole(input.rolesDir, input.roleId)
  if (role === null) {
    throw new PrismError('not_found', roleNotFoundMessage(input.rolesDir, input.roleId))
  }

  const teamId = input.teamId !== undefined && input.teamId !== '' ? input.teamId : undefined
  let teamSkills: string[] | undefined
  if (teamId !== undefined) {
    const team = await loadTeam(input.teamsDir, teamId, { rolesDir: input.rolesDir })
    if (team === null) {
      throw new PrismError('not_found', teamNotFoundMessage(input.teamsDir, teamId))
    }
    teamSkills = team.skills
  }

  return computeEffectiveSkills({
    roleSkills: role.skills ?? [],
    ...(teamSkills !== undefined ? { teamSkills } : {}),
    ...(installed !== undefined ? { installed } : {}),
    known,
    role: input.roleId,
    ...(teamId !== undefined ? { team: teamId } : {}),
  })
}

// ---------------------------------------------------------------------------
// 2026-09-11：`parseRoleFile` / `renderPrismRole` 兼容 shim 已移除
// —— 二者的唯二消费者是 `prism role import`（已删）与测试；导入语义废弃后无生产用途。
// ---------------------------------------------------------------------------
