import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  editTeam,
  parseMembersSpec,
  removeTeam,
  renderTeamScaffold,
  renderZcodeTeam,
  type ResolvedDirs,
} from '@prism/agents'
import {
  activateTeam,
  inspectGraphStatus,
  loadRoles,
  loadTeam,
  loadTeams,
  parseTeamMarkdown,
  ProjectRegistry,
  teamNotFoundMessage,
  validateTeam,
} from '@prism/server'
import type { GraphStatusDetail, TeamDefinition, TeamMember, ValidationIssue } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { guardWriteTarget, resolveTargetDirs } from '../argv.js'
import { graphBuild } from './graph.js'

/**
 * `prism team list/show/new/edit/rm/validate/render/activate`（design-v3 §3.5 F10；v5 对齐增删改）。
 * 团队受管目录 = resolveDirs().teamsDir（默认宿主根下 teams/，prism.yaml 可覆盖）；
 * 落点在 roles_dir 的**同级**而非 agents/ 内——ZCode 递归扫描 agents/ 下全部 .md，
 * 团队文件含 name+description 会被误注册成 agent（R3 实测 / B7）。
 *
 * 2026-09-11：原 `team install` 已移除（「装配/导入」语义整体失效，详见 `role.ts` 头注）。
 * 2026-09-12：`init` → `new`（同一动作在三入口同名：CLI `team new` / MCP `prism_team_new` /
 * HTTP `POST /api/teams`），并补齐 `edit` / `rm` / `render`，与角色侧严格对称。
 */
export async function runTeam(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const home = ctx.home ?? '.'
  const dirs = resolveTargetDirs(ctx, values)
  const teamsDir = dirs.teamsDir
  const rolesDir = dirs.rolesDir

  switch (sub) {
    case 'new': {
      return await teamNew(ctx, rest, values, dirs)
    }

    case 'list': {
      const teams = await loadTeams(teamsDir, { rolesDir })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: teams }))
        return 0
      }
      if (teams.length === 0) {
        ctx.stdout(`团队库为空: ${teamsDir}（用 prism team new 创建你的团队）`)
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
        ctx.stderr(`错误 [not_found] ${teamNotFoundMessage(teamsDir, id)}`)
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
        ctx.stderr(`错误 [not_found] ${teamNotFoundMessage(teamsDir, id)}`)
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

    case 'activate': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism team activate <id> [--project <名>|--build-project <名>]')
        return 1
      }
      const team = await loadTeam(teamsDir, id, { rolesDir })
      if (team === null) {
        ctx.stderr(`错误 [not_found] 团队不存在: ${id}（受管 ${teamsDir}）`)
        return 1
      }
      // 装配语义简化：installed = roles_dir（即宿主目录）中存在该角色文件；不再区分"源/目标"两个目录
      const activation = await activateTeam(team, { rolesDir })

      // F-C3：只读图谱状态 + 显式建图（守 R1「不抢调度」——缺省两件事都不做）
      const project = values.project !== undefined ? String(values.project) : ''
      const buildProject = values['build-project'] !== undefined ? String(values['build-project']) : ''
      if (project !== '' && buildProject !== '') {
        ctx.stderr('错误 [bad_request] --project（只读）与 --build-project（显式建图）互斥')
        return 1
      }
      const target = buildProject !== '' ? buildProject : project
      let graphStatus: GraphStatusDetail | null = null
      if (target !== '') {
        const registry = new ProjectRegistry(home)
        let info = (await registry.list()).find((p) => p.project === target)
        if (info === undefined) {
          ctx.stderr(`错误 [not_found] 未注册的图谱项目: ${target}（可经 prism graph build <根> 登记）`)
          return 1
        }
        if (buildProject !== '') {
          const code = await graphBuild(ctx, [info.root], { ...values, name: buildProject })
          if (code !== 0) return code
          info = (await registry.list()).find((p) => p.project === target) ?? info
        }
        // 快分支：只比 mtime，不全量哈希（大项目不卡）
        graphStatus = await inspectGraphStatus(info.project, info.root, info.built_at, { quick: true })
      }

      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { ...activation, graph_status: graphStatus } }))
      } else {
        ctx.stdout(`团队已启用: ${activation.team_id}（${activation.team_name}）`)
        for (const m of activation.members) {
          const tag = m.dispatch === 'native' ? 'native' : `fallback（${m.hint ?? '未装配'}）`
          ctx.stdout(`  ${m.role}×${m.count}  ${m.installed ? '已装配' : '未装配'}  派发: ${tag}`)
        }
        ctx.stdout(`工作流 ${activation.workflow.length} 阶段；仲裁链: ${activation.arbitration.join(' > ') || '（空）'}；返工上限 ${activation.rework_limit} 轮`)
        ctx.stdout('dispatch 判定仅由 installed 推导；native 派发需重启会话后扫描生效')
        if (graphStatus !== null) {
          const state = graphStatus.graph_exists ? (graphStatus.stale ? '已陈旧' : '可用') : '未建图'
          ctx.stdout(
            `图谱（${graphStatus.project}）: ${state}；变更 ${graphStatus.changed_files}/${graphStatus.total_files} 个文件；build 于 ${graphStatus.built_at ?? '—'}`,
          )
          if (graphStatus.note !== undefined) ctx.stdout(`  ${graphStatus.note}`)
        } else {
          ctx.stdout('图谱: 未指定项目（加 --project <名> 只读查看；--build-project <名> 显式建图；缺省不动手）')
        }
        ctx.stdout(`提示: prism inject <项目根> 可把 Prism 指引写进项目 AGENTS.md（标记块，不动手写内容）`)
      }
      return 0
    }

    case 'edit': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr(TEAM_EDIT_USAGE)
        return 1
      }
      let members: TeamMember[] | undefined
      if (values.members !== undefined) {
        const parsed = parseMembersSpec(String(values.members))
        const errors = parsed.issues.filter((i) => i.level === 'error')
        if (errors.length > 0) {
          for (const issue of errors) ctx.stderr(`错误 [${issue.code}] ${issue.message}`)
          return 1
        }
        members = parsed.members
      }
      const patch = {
        ...(values.name !== undefined ? { name: String(values.name) } : {}),
        ...(values.description !== undefined ? { description: String(values.description) } : {}),
        ...(members !== undefined ? { members } : {}),
      }
      if (Object.keys(patch).length === 0) {
        ctx.stderr('错误 [bad_request] 未给出任何要修改的字段')
        ctx.stderr(TEAM_EDIT_USAGE)
        return 1
      }
      if (!guardWriteTarget(ctx, values, dirs, 'teams', 1)) return 1
      try {
        const result = await editTeam({ teamId: id, teamsDir, patch })
        // `--json`：issue 走 JSON payload（`...result` 已含 issues），stdout 保持整体可解析
        if (!ctx.json) {
          for (const issue of result.issues) {
            ctx.stdout(`${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
          }
        }
        if (ctx.json) {
          ctx.stdout(JSON.stringify({ ok: true, value: { teamId: id, teamsDir, ...result, fields: Object.keys(patch) } }))
          return 0
        }
        for (const p of result.written) ctx.stdout(`  已更新 ${p}`)
        ctx.stdout(`团队 ${id} 已更新（改动字段: ${Object.keys(patch).join(', ')}）`)
        return 0
      } catch (error) {
        ctx.stderr(`错误 [${(error as { code?: string }).code ?? 'bad_request'}] ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }

    case 'rm': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism team rm <id> [--harness-root <dir>|--yes]')
        return 1
      }
      if (!guardWriteTarget(ctx, values, dirs, 'teams', 1, 'delete')) return 1
      try {
        const result = await removeTeam({ teamId: id, teamsDir })
        if (ctx.json) {
          ctx.stdout(JSON.stringify({ ok: true, value: { teamId: id, removed: result.removed } }))
          return 0
        }
        for (const p of result.removed) ctx.stdout(`  已删除 ${p}`)
        ctx.stdout(`团队 ${id} 已删除（不可逆；宿主在会话启动时扫描——下一会话生效）`)
        return 0
      } catch (error) {
        ctx.stderr(`错误 [${(error as { code?: string }).code ?? 'bad_request'}] ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }

    case 'render': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism team render <id>')
        return 1
      }
      const team = await loadTeam(teamsDir, id, { rolesDir })
      if (team === null) {
        ctx.stderr(`错误 [not_found] ${teamNotFoundMessage(teamsDir, id)}`)
        return 1
      }
      const content = renderZcodeTeam(team)
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { team_id: id, target: join(teamsDir, `${id}.md`), content } }))
      } else {
        ctx.stdout(content)
      }
      return 0
    }

    default:
      ctx.stderr(`未知子命令: team ${sub ?? ''}\n用法: prism team list|show|new|edit|rm|validate|render|activate`)
      return 1
  }
}

const TEAM_EDIT_USAGE =
  '用法: prism team edit <id> [--name <名>] [--description <述>] [--members <role[:n],...>] [--harness-root <dir>|--yes]'

const TEAM_NEW_USAGE =
  '用法: prism team new <id> [--from <team>|--members <role[:n],...>] [--name <名>] [--description <述>] [--template minimal|core-dev] [--harness-root <dir>|--yes]'

/**
 * `prism team new <id>`（design-v4 §F-C1）：
 * 渲染团队脚手架（`renderTeamScaffold`，只渲染）→ 解析回定义 → **自动 validateTeam**
 * （error 则不落盘）→ 写守卫 → 落 `<teams_dir>/<id>.md`（扁平形态，registry/wiring 双形态均识别）。
 *
 * - `--from <team>`：复用 `@prism/server` 的 `loadTeam`（**不自造第二个 loader**），`extends` 保留；
 * - `--members`：收窄名册时自动裁剪工作流（并出 `workflow_pruned` warning）；
 * - 已存在 → skipped（不覆盖，对齐 `role new` 语义）；
 * - 写守卫口径 = `--harness-root` / prism.yaml（**不引入 `--teams-dir`**）。
 */
async function teamNew(
  ctx: CommandContext,
  rest: string[],
  values: ArgValues,
  dirs: ResolvedDirs,
): Promise<number> {
  const teamsDir = dirs.teamsDir
  const rolesDir = dirs.rolesDir
  const id = rest[0]
  if (id === undefined) {
    ctx.stderr(TEAM_NEW_USAGE)
    return 1
  }
  const flatPath = join(teamsDir, `${id}.md`)
  const dirPath = join(teamsDir, id, 'AGENTS.md')

  // 已存在 → skipped（绝不覆盖人写文件；要重建请先删或换 id）
  const existing = existsSync(flatPath) ? flatPath : existsSync(dirPath) ? dirPath : null
  if (existing !== null) {
    if (ctx.json) {
      ctx.stdout(
        JSON.stringify({
          ok: true,
          value: { teamId: id, teamsDir, written: [], skipped: [{ path: existing, reason: '团队定义已存在（不覆盖）' }] },
        }),
      )
    } else {
      ctx.stdout(`  跳过 ${existing}: 团队定义已存在（不覆盖；如需重建请先删除或换 id）`)
      ctx.stdout(`团队 ${id} 已存在，未做任何改动`)
    }
    return 0
  }

  // --from：读既有团队（复用 server loadTeam）
  let from: TeamDefinition | undefined
  if (values.from !== undefined) {
    const loaded = await loadTeam(teamsDir, String(values.from), { rolesDir })
    if (loaded === null) {
      ctx.stderr(`错误 [not_found] --from 团队不存在: ${values.from}（数据源 ${teamsDir}）`)
      return 1
    }
    from = loaded
  }

  // --members 解析
  let members: TeamMember[] | undefined
  if (values.members !== undefined) {
    const parsed = parseMembersSpec(String(values.members))
    const parseErrors = parsed.issues.filter((i) => i.level === 'error')
    if (parseErrors.length > 0) {
      for (const issue of parseErrors) ctx.stderr(`错误 [${issue.code}] ${issue.message}`)
      return 1
    }
    members = parsed.members
  }

  const template = values.template !== undefined ? String(values.template) : undefined
  if (template !== undefined && template !== 'minimal' && template !== 'core-dev') {
    ctx.stderr(`错误 [bad_request] --template 只支持 minimal|core-dev（收到 ${template}）`)
    return 1
  }

  const scaffold = renderTeamScaffold({
    teamId: id,
    teamsDir,
    ...(values.name !== undefined ? { name: String(values.name) } : {}),
    ...(values.description !== undefined ? { description: String(values.description) } : {}),
    ...(members !== undefined ? { members } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(template !== undefined ? { template: template as 'minimal' | 'core-dev' } : {}),
  })
  // 诊断打印：**去重**（同一行只打一次）。
  // 原因：渲染侧（renderTeamScaffold）与落盘前校验侧（parseTeamMarkdown + validateTeam）
  // 会各跑一轮重叠的检查，`unused_member` 这类告警**逐字重复两行**，
  // 看起来像两个不同的悬空成员——2026-09-12 实测（`团队: demo-role×1`）。
  const printed = new Set<string>()
  const printIssue = (issue: ValidationIssue): void => {
    // `--json`：issue 一律走 JSON payload（下方 `issues`），stdout 必须**整体可被 JSON.parse**——
    // 早前无条件打自由文本，`team new --json` 的 stdout 是「WARN 行 + JSON」两段，
    // 调用方 `JSON.parse(stdout)` 直接失败（e2e 里就这么炸过）。
    if (ctx.json) return
    const line = `${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`
    if (printed.has(line)) return
    printed.add(line)
    ctx.stdout(line)
  }

  // 渲染诊断（warning 照打，便于看见「工作流按名册收窄」之类动作）
  for (const issue of scaffold.issues) printIssue(issue)
  const hardErrors = scaffold.issues.filter((i) => i.level === 'error')
  if (hardErrors.length > 0) {
    ctx.stderr(`错误 [${hardErrors[0]!.code}] 脚手架渲染失败，未落盘`)
    return 1
  }

  // 生成后自动校验：解析回定义 → 用**真实角色库**跑 validateTeam（error 则不落盘）
  let definition: TeamDefinition
  try {
    definition = parseTeamMarkdown(scaffold.markdown)
  } catch (error) {
    ctx.stderr(`错误 [team_parse_failed] 渲染产物无法解析：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const library = await loadRoles(rolesDir)
  const validation = validateTeam(definition, { roles: library })
  for (const issue of validation.issues) printIssue(issue)
  if (!validation.ok) {
    ctx.stderr(
      `错误 [team_invalid] 团队 ${id} 校验存在 error，未落盘（成员角色需先在 roles_dir：prism role new <name>）`,
    )
    return 1
  }

  // 写守卫：目标是默认宿主目录（非 --harness-root / prism.yaml 显式指定）时需 --yes
  if (!guardWriteTarget(ctx, values, dirs, 'teams', 1)) return 1
  try {
    mkdirSync(teamsDir, { recursive: true })
    writeFileSync(flatPath, scaffold.markdown, 'utf-8')
  } catch (error) {
    ctx.stderr(`错误 [team_write_failed] 团队定义写入失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        value: {
          teamId: id,
          teamsDir,
          rolesDir,
          written: [flatPath],
          skipped: [],
          issues: [...scaffold.issues, ...validation.issues],
        },
      }),
    )
  } else {
    ctx.stdout(`  已创建 ${flatPath}`)
    ctx.stdout(`团队 ${id} 初始化完成（成员 ${definition.members.map((m) => `${m.role}×${m.count}`).join(', ')}）`)
    ctx.stdout('下一步: prism team validate ' + id + ' / prism team activate ' + id)
    ctx.stdout('注意: 宿主在会话启动时扫描团队定义——下一会话生效')
  }
  return 0
}
