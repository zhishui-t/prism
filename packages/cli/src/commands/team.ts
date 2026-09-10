import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  activateTeam,
  installTeamDefinitions,
  loadRoles,
  loadTeam,
  loadTeams,
  migrateTeams,
  validateTeam,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { guardWriteTarget, resolveTargetDirs } from '../argv.js'

/**
 * `prism team list/show/validate/install/activate`（design-v3 §3.5 F10 + 装配语义简化）。
 * 团队受管目录 = resolveDirs().teamsDir（默认宿主 ~/.zcode/teams，prism.yaml 可覆盖）；
 * 落点在 roles_dir 的**同级**而非 agents/ 内——ZCode 递归扫描 agents/ 下全部 .md，
 * 团队文件含 name+description 会被误注册成 agent（R3 实测 / B7）。
 * 旧 Prism 源目录 `<PRISM_HOME>/teams/` 中的团队在 install 时**一次性迁移**过去（源目录废弃）。
 * `team install` 不再复制成员角色——成员已直接住在 roles_dir，只做 ①校验 ②确保团队文件 ③激活指引。
 */
export async function runTeam(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const home = ctx.home ?? '.'
  const dirs = resolveTargetDirs(ctx, values)
  const teamsDir = dirs.teamsDir
  const rolesDir = dirs.rolesDir
  const legacyTeamsDir = join(home, 'teams')

  switch (sub) {
    case 'list': {
      const teams = await loadTeams(teamsDir, { rolesDir })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: teams }))
        return 0
      }
      if (teams.length === 0) {
        ctx.stdout(`团队库为空: ${teamsDir}（prism init 会落出厂模板 core-dev）`)
        return 0
      }
      for (const team of teams) {
        const errors = (team.issues ?? []).filter((i) => i.level === 'error').length
        const tag = (team.issues ?? []).length > 0 ? `issues(${errors}E/${team.issues!.length - errors}W)` : 'ok'
        ctx.stdout(`${team.team_id}  ${team.name}  成员=${team.members.length}  阶段=${team.workflow.length}  ${tag}`)
      }
      ctx.stdout(`共 ${teams.length} 个团队（数据源 ${teamsDir}）`)
      return 0
    }

    case 'show': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism team show <id>')
        return 1
      }
      const team = await loadTeam(teamsDir, id, { rolesDir })
      if (team === null) {
        ctx.stderr(`错误 [not_found] 团队不存在: ${id}（数据源 ${teamsDir}/<id>/AGENTS.md）`)
        return 1
      }
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: team }))
        return 0
      }
      ctx.stdout(`team_id: ${team.team_id}（${team.name}）`)
      ctx.stdout(`description: ${team.description}`)
      ctx.stdout(`members: ${team.members.map((m) => `${m.role}×${m.count}`).join(', ')}`)
      ctx.stdout(`skills: [${team.skills.join(', ')}]`)
      ctx.stdout(`knowledge.layers: [${team.knowledge.layers.join(', ')}]`)
      ctx.stdout(`deposit: ${team.deposit.default_layer}/${team.deposit.default_type}/${team.deposit.priority}（enabled=${team.deposit.enabled}）`)
      ctx.stdout(`arbitration: ${team.arbitration.join(' > ') || '（空）'}`)
      ctx.stdout(`rework_limit: ${team.rework_limit}`)
      for (const issue of team.issues ?? []) {
        ctx.stdout(`${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
      }
      ctx.stdout('--- 工作流 ---')
      for (const stage of team.workflow) {
        ctx.stdout(`#${stage.order} ${stage.stage} [${stage.mode}] ${stage.roles.join('+')} | ${stage.input} → ${stage.output} | 判定: ${stage.done} | 回流: ${stage.reflow}`)
      }
      return 0
    }

    case 'validate': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism team validate <id>')
        return 1
      }
      const team = await loadTeam(teamsDir, id, { rolesDir })
      if (team === null) {
        ctx.stderr(`错误 [not_found] 团队不存在: ${id}（数据源 ${teamsDir}/<id>/AGENTS.md）`)
        return 1
      }
      const result = validateTeam(team, { roles: await loadRoles(rolesDir) })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: result.ok, value: { team_id: team.team_id, ...result } }))
      } else {
        if (result.issues.length === 0) {
          ctx.stdout(`${team.team_id}: ok`)
        }
        for (const issue of result.issues) {
          ctx.stdout(`${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
        }
        ctx.stdout(`校验团队 ${team.team_id}: ${result.ok ? '通过' : '存在 error'}`)
      }
      return result.ok ? 0 : 1
    }

    case 'install': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism team install <id> [--force]')
        return 1
      }
      // ① 定位团队定义：受管 teams_dir 优先；不在则回落旧 Prism 源目录（<home>/teams），
      //    标记**待迁移**——实际迁移动作在写守卫之后（B6）。
      let team = await loadTeam(teamsDir, id, { rolesDir })
      let pendingMigration = false
      if (team === null && existsSync(legacyTeamsDir)) {
        team = await loadTeam(legacyTeamsDir, id, { rolesDir })
        pendingMigration = team !== null
      }
      if (team === null) {
        ctx.stderr(`错误 [not_found] 团队不存在: ${id}（受管 ${teamsDir}；旧源 ${legacyTeamsDir}）`)
        return 1
      }
      // ② 校验团队与成员：成员角色必须已住在 roles_dir（大小写不敏感，2026-09-09 裁决口径）。
      //    缺失时**不产生任何写入**（B5 类"装配范围"缺陷随复制语义一并消失）。
      const library = await loadRoles(rolesDir)
      const missing = [...new Set(team.members.map((m) => m.role))].filter(
        (name) => !library.some((r) => r.name.toLowerCase() === name.toLowerCase()),
      )
      if (missing.length > 0) {
        ctx.stderr(
          `错误 [bad_request] 成员角色不在 roles_dir（${rolesDir}）: ${missing.join(', ')}；先 prism role import --from <宿主agents目录> / prism role init <name>`,
        )
        return 1
      }
      // ③ 确保团队文件存在于 teams_dir（迁移或补写）；写守卫在动作之前（B6）
      let migratedFrom: string | null = null
      let teamWritten = 0
      const alreadyManaged = existsSync(join(teamsDir, `${id}.md`)) || existsSync(join(teamsDir, id, 'AGENTS.md'))
      if (pendingMigration) {
        if (!guardWriteTarget(ctx, values, dirs, 'teams', 1)) return 1
        const migration = await migrateTeams({ fromDir: legacyTeamsDir, teamsDir, teamId: id, force: values.force })
        migratedFrom = legacyTeamsDir
        teamWritten = migration.written.length
      } else if (!alreadyManaged) {
        if (!guardWriteTarget(ctx, values, dirs, 'teams', 1)) return 1
        const result = await installTeamDefinitions({ targetDir: dirs.harnessRoot, teamsDir, teams: [team], force: values.force })
        teamWritten = result.written.length + result.skipped.length
      }
      if (ctx.json) {
        ctx.stdout(
          JSON.stringify({
            ok: true,
            value: { teamsDir, rolesDir, team_id: team.team_id, members: team.members.length, migratedFrom, teamWritten },
          }),
        )
      } else {
        if (migratedFrom !== null) {
          ctx.stdout(`  团队定义已从 ${migratedFrom} 迁移到 ${teamsDir}（旧源目录已废弃，可自行删除）`)
        } else if (teamWritten > 0) {
          ctx.stdout(`  团队定义已写入 ${teamsDir}`)
        } else {
          ctx.stdout(`  团队定义已在受管位置 ${teamsDir}`)
        }
        ctx.stdout(`  成员角色已直接住在 roles_dir（${rolesDir}），共 ${team.members.length} 个成员——无需装配复制`)
        ctx.stdout('激活: prism team activate ' + team.team_id)
        ctx.stdout('注意: 下一会话生效')
      }
      return 0
    }

    case 'activate': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism team activate <id>')
        return 1
      }
      const team = await loadTeam(teamsDir, id, { rolesDir })
      if (team === null) {
        ctx.stderr(`错误 [not_found] 团队不存在: ${id}（受管 ${teamsDir}）`)
        return 1
      }
      // 装配语义简化：installed = roles_dir（即宿主目录）中存在该角色文件；不再区分"源/目标"两个目录
      const activation = await activateTeam(team, { rolesDir })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: activation }))
      } else {
        ctx.stdout(`团队已启用: ${activation.team_id}（${activation.team_name}）`)
        for (const m of activation.members) {
          const tag = m.dispatch === 'native' ? 'native' : `fallback（${m.hint ?? '未装配'}）`
          ctx.stdout(`  ${m.role}×${m.count}  ${m.installed ? '已装配' : '未装配'}  派发: ${tag}`)
        }
        ctx.stdout(`工作流 ${activation.workflow.length} 阶段；仲裁链: ${activation.arbitration.join(' > ') || '（空）'}；返工上限 ${activation.rework_limit} 轮`)
        ctx.stdout('dispatch 判定仅由 installed 推导；native 派发需重启会话后扫描生效')
        ctx.stdout(`提示: prism inject <项目根> 可把 Prism 指引写进项目 AGENTS.md（标记块，不动手写内容）`)
      }
      return 0
    }

    default:
      ctx.stderr(`未知子命令: team ${sub ?? ''}\n用法: prism team list|show|validate|install|activate`)
      return 1
  }
}
