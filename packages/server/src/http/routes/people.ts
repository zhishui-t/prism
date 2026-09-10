import { listBuiltinSkills } from '@prism/skills'

import { fail, ok, type Envelope } from '../envelope.js'
import type { RouteContext } from '../router.js'
import {
  activateTeam,
  installedSkillNames,
  loadRole,
  loadRoles,
  loadTeam,
  loadTeams,
  resolveDirsFromHome,
  zcodePaths,
} from '../../roles/index.js'

export interface PeopleDeps {
  /** PRISM_HOME（prism.yaml 配置源：<home>/prism.yaml 的 roles_dir/teams_dir/skills_dir） */
  home: string
  /** ZCode 根目录（默认推导基准；AppOptions.zcodeDir → env → ~/.zcode） */
  zcodeDir: string
}

/**
 * 角色与团队路由（design-v3 §3.4 F11，P6/P9 修订）：
 * - 数据源与 CLI **同源**：resolveDirs（prism.yaml 覆盖 → 默认宿主目录），
 *   不再固定 `<home>/roles|teams`（返工单 B8：装配语义简化后 CLI 已住宿主目录，
 *   server 若仍读 <home> 会出现控制台与 CLI 数据源分裂）
 * - 角色/团队返回携带 issues（校验结果），供 F12 页面展示
 * - /api/teams/:id/activate 返回 TeamActivation（dispatch 仅由 installed 推导，P8）
 * - /api/skills 返回内置 PrismSkill[]
 * 全部 GET 只读（server 不写宿主目录，故不涉及写守卫）。
 */
export function peopleRoutes(deps: PeopleDeps): {
  roles: (ctx: RouteContext) => Promise<Envelope>
  role: (ctx: RouteContext) => Promise<Envelope>
  teams: (ctx: RouteContext) => Promise<Envelope>
  team: (ctx: RouteContext) => Promise<Envelope>
  teamActivate: (ctx: RouteContext) => Promise<Envelope>
  skills: (ctx: RouteContext) => Promise<Envelope>
  skillUsage: (ctx: RouteContext) => Promise<Envelope>
} {
  const dirs = resolveDirsFromHome(deps.home, { zcodeDir: deps.zcodeDir, zcodeDirExplicit: true })
  const rolesDir = dirs.rolesDir
  const teamsDir = dirs.teamsDir

  /** 已装 skill 名单（`<zcodeDir>/skills/*`，只读）；目录不存在 → undefined（跳过引用校验）。 */
  const knownSkills = (): Promise<string[] | undefined> => installedSkillNames(deps.zcodeDir)

  const roles = async (): Promise<Envelope> => ok(await loadRoles(rolesDir, { knownSkills: await knownSkills() }))

  const role = async (ctx: RouteContext): Promise<Envelope> => {
    const name = ctx.params.name ?? ''
    const found = await loadRole(rolesDir, name, { knownSkills: await knownSkills() })
    return found === null ? fail('not_found', `角色不存在: ${name}（数据源 ${rolesDir}/<name>/AGENTS.md）`) : ok(found)
  }

  const teams = async (): Promise<Envelope> =>
    ok(await loadTeams(teamsDir, { rolesDir, knownSkills: await knownSkills() }))

  const team = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    const found = await loadTeam(teamsDir, id, { rolesDir, knownSkills: await knownSkills() })
    return found === null ? fail('not_found', `团队不存在: ${id}（数据源 ${teamsDir}/<id>/AGENTS.md）`) : ok(found)
  }

  const teamActivate = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    const found = await loadTeam(teamsDir, id, { rolesDir, knownSkills: await knownSkills() })
    if (found === null) {
      return fail('not_found', `团队不存在: ${id}（数据源 ${teamsDir}/<id>/AGENTS.md）`)
    }
    return ok(await activateTeam(found, { rolesDir, targetDir: zcodePaths(deps.zcodeDir).agentsDir }))
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

  return { roles, role, teams, team, teamActivate, skills, skillUsage }
}
