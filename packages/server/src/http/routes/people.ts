import { listBuiltinSkills } from '@prism/skills'
import { PrismError } from '@prism/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { fail, ok, type Envelope } from '../envelope.js'
import type { GraphStatusDetail } from '../../graph/registry.js'
import type { RouteContext } from '../router.js'
import {
  activateTeam,
  createRoleDefinition,
  createTeamDefinition,
  deleteRoleDefinition,
  deleteTeamDefinition,
  installedSkillNames,
  installBuiltinSkillDefinitions,
  loadEffectiveSkills,
  loadRole,
  loadRoles,
  loadTeam,
  loadTeams,
  resolveDirsFromHome,
  harnessPaths,
  roleNotFoundMessage,
  roleRendererFor,
  teamNotFoundMessage,
  uninstallSkillDefinitions,
  updateRoleDefinition,
  updateTeamDefinition,
  type NewTeamBody,
  type RoleWriteBody,
  type SkillWriteBody,
  type UpdateTeamBody,
} from '../../roles/index.js'

export interface PeopleDeps {
  /** PRISM_HOME（prism.yaml 配置源：<home>/prism.yaml 的 roles_dir/teams_dir/skills_dir） */
  home: string
  /** 宿主根目录（默认推导基准；AppOptions.harnessRoot → env → **配置激活适配器的默认根**） */
  harnessRoot: string
  /**
   * F-C3：**只读**图谱状态查询（项目名 → 状态；未注册项目 → null）。
   * 缺省不注入 → `activate` 的 `graph_status` 恒为 `null`（不伪造）。
   */
  graphStatus?: (project: string) => Promise<GraphStatusDetail | null>
  /**
   * F-C3：**显式**建图（仅 `?build=1` 时调用）。
   * 守 R1「不抢调度」：缺省绝不建图；不注入则 `?build=1` 报错而非静默跳过。
   */
  requestGraphBuild?: (project: string) => Promise<{ job_id: string }>
}

/**
 * 角色与团队路由（design-v3 §3.4 F11，P6/P9 修订；design-v4 F-C3/F-D2 增量）：
 * - 数据源与 CLI **同源**：resolveDirs（prism.yaml 覆盖 → 默认宿主目录），
 *   不再固定 `<home>/roles|teams`（返工单 B8：装配语义简化后 CLI 已住宿主目录，
 *   server 若仍读 <home> 会出现控制台与 CLI 数据源分裂）
 * - 角色/团队返回携带 issues（校验结果），供 F12 页面展示
 * - /api/teams/:id/activate 返回 TeamActivation（dispatch 仅由 installed 推导，P8）
 * - /api/skills 返回内置 PrismSkill[]；/api/skills/effective 返回有效集（F-D2）
 * - 读路由一律只读；写路由（`POST|PATCH|DELETE /api/roles[/:name]`、`/api/teams[/:id]`）只写 body
 *   显式给出的 `roles_dir` / `teams_dir`，**绝不复用** `dirs` 的默认宿主目录（写路径不得回落）。
 * - v6.1：读返回的目录字段统一为 snake_case（`roles_dir` / `teams_dir`），与写参数同名。
 */
export function peopleRoutes(deps: PeopleDeps): {
  roles: (ctx: RouteContext) => Promise<Envelope>
  role: (ctx: RouteContext) => Promise<Envelope>
  createRole: (ctx: RouteContext) => Promise<Envelope>
  updateRole: (ctx: RouteContext) => Promise<Envelope>
  deleteRole: (ctx: RouteContext) => Promise<Envelope>
  teams: (ctx: RouteContext) => Promise<Envelope>
  team: (ctx: RouteContext) => Promise<Envelope>
  teamActivate: (ctx: RouteContext) => Promise<Envelope>
  skills: (ctx: RouteContext) => Promise<Envelope>
  skillUsage: (ctx: RouteContext) => Promise<Envelope>
  skillsEffective: (ctx: RouteContext) => Promise<Envelope>
  skillInstall: (ctx: RouteContext) => Promise<Envelope>
  skillUninstall: (ctx: RouteContext) => Promise<Envelope>
  createTeam: (ctx: RouteContext) => Promise<Envelope>
  updateTeam: (ctx: RouteContext) => Promise<Envelope>
  deleteTeam: (ctx: RouteContext) => Promise<Envelope>
} {
  const dirs = resolveDirsFromHome(deps.home, { harnessRoot: deps.harnessRoot, rootExplicit: true })
  const rolesDir = dirs.rolesDir
  const teamsDir = dirs.teamsDir

  /** 已装 skill 名单（`<harnessRoot>/skills/*`，只读）；目录不存在 → undefined（跳过引用校验）。 */
  const knownSkills = (): Promise<string[] | undefined> => installedSkillNames(deps.harnessRoot, deps.home)

  /**
   * 角色库（v5 / S5）：每个角色补**只读** `installed`——宿主 agents 目录里有没有该角色
   * 定义（控制台据此标「已装 / 未装」，ui-spec-v4 §2.1）。
   *
   * - 判定与 `packages/agents/src/team/activate.ts:62-70` 的 `isInstalled` **同源**
   *   （该函数未导出，故按同一规则在此重写；两处不一致会与「团队启用」显示打架）；
   * - **只在 server 侧包装**——不改 `packages/agents` 的冻结类型（v5 裁决 3）；
   * - 返回体仍是**数组**（既有消费方 `apps/web/src/api-team.ts` 的 `teamApi.roles()`
   *   依赖数组形态；只加字段、不改容器）。
   * 形状（v6.1）：`{ roles, roles_dir }`——`roles_dir` 与写参数同名，控制台新建表单预填且可改，
   * 与 `GET /api/teams` 的 `{ teams, teams_dir }` **同形**。仍只读、不写盘；
   * 写路径只认 `POST /api/roles` 的显式 `roles_dir`。历史裸数组与旧 camel `rolesDir`
   * 均由前端 `normalizeRoles` 兼容。
   */
  const roles = async (): Promise<Envelope> => {
    const agentsDir = harnessPaths(deps.harnessRoot, deps.home).agentsDir
    const list = await loadRoles(rolesDir, { knownSkills: await knownSkills() })
    return ok({
      roles: list.map((role) => ({ ...role, installed: isInstalledInHost(agentsDir, rolesDir, role.name) })),
      // v6.1：键名统一 snake_case（= 写参数名，读回即可回填；旧 camel `rolesDir` 前端仍兼容）
      roles_dir: rolesDir,
    })
  }

  const role = async (ctx: RouteContext): Promise<Envelope> => {
    const name = ctx.params.name ?? ''
    const found = await loadRole(rolesDir, name, { knownSkills: await knownSkills() })
    return found === null ? fail('not_found', roleNotFoundMessage(rolesDir, name)) : ok(found)
  }

  /**
   * 团队列表（F-C3 / ui-spec §8-D1）：返回体增**只读** `teamsDir`（受管目录绝对路径），
   * 供控制台新建表单预填且可改。仍只读、不写盘；写路径只认 `POST /api/teams` 的显式 `teams_dir`。
   *
   * 形状（v6.1）：`{ teams, teams_dir }`——与写参数同名（`ui-spec` 的 `normalizeTeams` 兼容
   * 旧的裸数组与 camel `teamsDir`）。
   */
  const teams = async (): Promise<Envelope> =>
    ok({
      teams: await loadTeams(teamsDir, { rolesDir, knownSkills: await knownSkills() }),
      teams_dir: teamsDir,
    })

  /**
   * 单个团队（ui-spec §8-D5：错误文案指向真实源 `<teams_dir>/<id>.md`，目录式仅作兼容形态）。
   */
  const team = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    const found = await loadTeam(teamsDir, id, { rolesDir, knownSkills: await knownSkills() })
    return found === null ? fail('not_found', teamNotFoundMessage(teamsDir, id)) : ok(found)
  }

  /**
   * 团队启用（F-C3 增量）：返回体额外带**只读** `graph_status`（可空）。
   *
   * - `?project=<名>` 给出时查该项目图谱状态（**快分支**：只比 mtime，不全量哈希）；
   *   未注册 → `not_found`（不静默给个假状态）。
   * - `graph_status` 字段**恒存在**（无项目时为 `null`），消费方不必判 `in`。
   * - `?build=1` 才建图，且**必须**同时给 `project`——不猜项目（守 R1「不抢调度」）。
   * - 包装在 server 侧完成，**不改** `packages/agents` 的 `TeamActivation` 冻结契约
   *   （与 S5 的 `/api/roles` 补 `installed` 同一口径）。
   */
  const teamActivate = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    const found = await loadTeam(teamsDir, id, { rolesDir, knownSkills: await knownSkills() })
    if (found === null) {
      return fail('not_found', teamNotFoundMessage(teamsDir, id))
    }
    const activation = await activateTeam(found, {
      rolesDir,
      targetDir: harnessPaths(deps.harnessRoot, deps.home).agentsDir,
    })

    const project = (ctx.query.get('project') ?? '').trim()
    const build = ctx.query.get('build') === '1'

    if (build && project === '') {
      throw new PrismError('bad_request', '?build=1 需同时指定 ?project=<名>（Prism 不猜项目，守 R1）')
    }

    let graphStatus: GraphStatusDetail | null = null
    if (project !== '') {
      const status = (await deps.graphStatus?.(project)) ?? null
      if (status === null) {
        return fail('not_found', `未注册的图谱项目: ${project}（可经 prism project add / prism graph build 登记）`)
      }
      graphStatus = status
    }

    let graphBuild: { job_id: string } | undefined
    if (build) {
      if (deps.requestGraphBuild === undefined) {
        throw new PrismError('bad_request', '当前服务未启用建图（无建图 runner）')
      }
      graphBuild = await deps.requestGraphBuild(project)
    }

    return ok({
      ...activation,
      graph_status: graphStatus,
      ...(graphBuild !== undefined ? { graph_build: graphBuild } : {}),
    })
  }

  const skills = async (): Promise<Envelope> => ok(listBuiltinSkills())

  /**
   * 技能使用视图（team-definition.md §6.3 合并公式）：
   * 每个技能 → 谁在用它（角色白名单 / 团队声明）+ 是否已装。
   *
   * 设计裁决：Skill 本身不分层、不遮蔽；「层」只体现在**谁指定了它**。
   * 这里把三份数据（内置清单、角色 skills、团队 skills、宿主已装）合成一张视图。
   */
  const skillUsage = async (): Promise<Envelope> => {
    const [roleList, teamList, installed] = await Promise.all([
      loadRoles(rolesDir),
      loadTeams(teamsDir),
      knownSkills(),
    ])
    const usage = new Map<string, { name: string; builtin: boolean; installed: boolean; roles: string[]; teams: string[] }>()
    const ensure = (name: string) => {
      let entry = usage.get(name)
      if (entry === undefined) {
        entry = { name, builtin: false, installed: false, roles: [], teams: [] }
        usage.set(name, entry)
      }
      return entry
    }
    for (const skill of listBuiltinSkills()) {
      ensure(skill.name).builtin = true
    }
    for (const name of installed ?? []) {
      ensure(name).installed = true
    }
    for (const role of roleList) {
      for (const name of role.skills ?? []) {
        ensure(name).roles.push(role.name)
      }
    }
    for (const team of teamList) {
      for (const name of team.skills ?? []) {
        ensure(name).teams.push(team.team_id)
      }
    }
    return ok([...usage.values()].sort((a, b) => a.name.localeCompare(b.name)))
  }

  /** F-D2：有效 Skill 集（HTTP 面；三入口共用 `loadEffectiveSkills`）。 */
  const skillsEffective = async (ctx: RouteContext): Promise<Envelope> =>
    await skillsEffectiveRoute(ctx, deps, { teamsDir, rolesDir })

  /**
   * Skill 写（v6.2 补齐）：`POST /api/skills/install` / `POST /api/skills/uninstall`。
   * 与 MCP `prism_skill_install|uninstall`、CLI `prism skill install|uninstall` 共用
   * `roles/skill-create.ts` 的单点——body 的 `skills_dir` **必填**，绝不复用 `dirs` 的默认宿主目录。
   */
  const skillInstall = async (ctx: RouteContext): Promise<Envelope> =>
    ok(await installBuiltinSkillDefinitions((await ctx.body()) as SkillWriteBody))

  const skillUninstall = async (ctx: RouteContext): Promise<Envelope> =>
    ok(await uninstallSkillDefinitions((await ctx.body()) as SkillWriteBody))

  /** F-C3：新建团队。只传 `rolesDir`——写路径不得看见默认 `teamsDir`。 */
  const createTeam = async (ctx: RouteContext): Promise<Envelope> => await createTeamRoute(ctx, rolesDir)

  return {
    roles,
    role,
    createRole: (ctx) => roleCreateRoute(ctx, deps),
    updateRole: (ctx) => roleUpdateRoute(ctx, deps),
    deleteRole: (ctx) => roleDeleteRoute(ctx),
    teams,
    team,
    teamActivate,
    skills,
    skillUsage,
    skillsEffective,
    skillInstall,
    skillUninstall,
    createTeam,
    updateTeam: (ctx) => teamUpdateRoute(ctx),
    deleteTeam: (ctx) => teamDeleteRoute(ctx),
  }
}

/**
 * `POST /api/roles`：按**宿主原生形态**（激活适配器 `renderRole`）写**显式** `roles_dir`。
 * 实现单点在 `roles/role-create.ts`（MCP `prism_role_new` 共用，保证「两入口同校验同落盘」）。
 */
async function roleCreateRoute(ctx: RouteContext, deps: PeopleDeps): Promise<Envelope> {
  const body = (await ctx.body()) as RoleWriteBody
  return ok(await createRoleDefinition(body, { renderRole: roleRendererFor(deps.harnessRoot, deps.home) }))
}

/** `PATCH /api/roles/:name`：字段补丁（外科式，正文不重排）。 */
async function roleUpdateRoute(ctx: RouteContext, deps: PeopleDeps): Promise<Envelope> {
  const body = (await ctx.body()) as RoleWriteBody
  return ok(await updateRoleDefinition(ctx.params.name ?? '', body, { renderRole: roleRendererFor(deps.harnessRoot, deps.home) }))
}

/** `DELETE /api/roles/:name`：删除角色文件本体（`?roles_dir=` 必填；不落默认宿主目录）。 */
async function roleDeleteRoute(ctx: RouteContext): Promise<Envelope> {
  const body = await ctx.body().catch(() => ({}))
  const rolesDir = (body as { roles_dir?: unknown }).roles_dir ?? ctx.query.get('roles_dir') ?? undefined
  return ok(await deleteRoleDefinition(ctx.params.name ?? '', rolesDir))
}

/** `PATCH /api/teams/:id`：字段补丁（改名册时工作流就地收窄）。 */
async function teamUpdateRoute(ctx: RouteContext): Promise<Envelope> {
  const body = (await ctx.body()) as UpdateTeamBody
  return ok(await updateTeamDefinition(ctx.params.id ?? '', body))
}

/** `DELETE /api/teams/:id`：删除团队文件本体（`teams_dir` 必填；不落默认宿主目录）。 */
async function teamDeleteRoute(ctx: RouteContext): Promise<Envelope> {
  const body = await ctx.body().catch(() => ({}))
  const teamsDir = (body as { teams_dir?: unknown }).teams_dir ?? ctx.query.get('teams_dir') ?? undefined
  return ok(await deleteTeamDefinition(ctx.params.id ?? '', teamsDir))
}

/**
 * 角色是否已装到**宿主**（v5 / S5）。
 *
 * 与 `packages/agents/src/team/activate.ts:62-70` 的 `isInstalled` 同规则（该函数私有未导出）：
 * - `agentsDir !== rolesDir`（`prism.yaml` 把 `roles_dir` 指到受管目录）→ 只看宿主的扁平产物
 *   `<agentsDir>/<role>.md`（旧「复制装配」语义的落点）；
 * - 两者重合（默认：roles_dir 即宿主 agents 目录）→ 扁平 `<role>.md` 与目录式
 *   `<role>/AGENTS.md` 双形态都认。
 */
function isInstalledInHost(agentsDir: string, rolesDir: string, name: string): boolean {
  if (agentsDir !== rolesDir) return existsSync(join(agentsDir, `${name}.md`))
  return existsSync(join(agentsDir, `${name}.md`)) || existsSync(join(agentsDir, name, 'AGENTS.md'))
}

/**
 * F-D2 有效 Skill 集：`GET /api/skills/effective?role=&team=`。
 * 角色不存在 → `not_found`（404 信封）；团队不存在同样 404（不静默降级为「无团队」）。
 * 三入口（MCP/HTTP/CLI）共用 `loadEffectiveSkills`，口径一致由该单点保证。
 */
async function skillsEffectiveRoute(
  ctx: RouteContext,
  deps: PeopleDeps,
  dirs: { teamsDir: string; rolesDir: string },
): Promise<Envelope> {
  const roleName = ctx.query.get('role')?.trim() ?? ''
  if (roleName === '') {
    throw new PrismError('bad_request', '缺少 role 参数')
  }
  const teamId = ctx.query.get('team')?.trim() ?? ''
  return ok(
    await loadEffectiveSkills({
      roleId: roleName,
      teamsDir: dirs.teamsDir,
      rolesDir: dirs.rolesDir,
      harnessRoot: deps.harnessRoot,
      home: deps.home,
      ...(teamId !== '' ? { teamId } : {}),
    }),
  )
}

/**
 * `POST /api/teams`（F-C3）：校验 → 渲染（agents `renderTeamScaffold`，与 CLI `team new`
 * 同一实现）→ 写**显式** `teams_dir`。实现单点在 `roles/team-create.ts`
 * （MCP `prism_team_new` 共用，保证「三入口同校验同落盘」）。
 */
async function createTeamRoute(ctx: RouteContext, rolesDir: string): Promise<Envelope> {
  const body = (await ctx.body()) as NewTeamBody
  return ok(await createTeamDefinition(body, rolesDir))
}
