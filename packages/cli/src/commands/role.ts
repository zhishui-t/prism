import { join } from 'node:path'

import {
  checkPrincipleConsistency,
  initRole,
  installedSkillNames,
  loadRole,
  loadRoles,
  loadTeams,
  renderZcodeRole,
  harnessPaths,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { expandHome, guardWriteTarget, resolveTargetDirs } from '../argv.js'

/**
 * `prism role list/show/init/validate/render`（design-v3 §3.5 F10）。
 * 目录统一走 resolveDirs：`<PRISM_HOME>/prism.yaml`（可选）覆盖适配器默认；`~` 由 CLI 层展开。
 *
 * 新模型（2026-09-11）：角色**直接住在 roles_dir**（默认宿主 agents 目录，即宿主自己读的那个位置），
 * Prism 不持有第二份副本 —— 因此**不存在「装配/导入」这个动作**：建角色 = 往该目录写文件
 * （`role init` 生成合法骨架供填写，或直接手写）。原 `role import` / `role install` 已移除。
 */
export async function runRole(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const dirs = resolveTargetDirs(ctx, values)
  const rolesDir = values.source !== undefined ? expandHome(values.source) : dirs.rolesDir
  // 根目录取自解析结果（未显式指定时 = 激活适配器的默认根，不再是硬编码 ~/.zcode）
  const harnessRoot = dirs.harnessRoot
  const zcode = harnessPaths(harnessRoot, ctx.home)

  switch (sub) {
    case 'list': {
      const roles = await loadRoles(rolesDir, { knownSkills: await installedSkillNames(harnessRoot, ctx.home) })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: roles }))
        return 0
      }
      if (roles.length === 0) {
        ctx.stdout(`角色库为空: ${rolesDir}（用 prism role init <name> 新建，或直接在该目录写 <name>.md）`)
        return 0
      }
      for (const role of roles) {
        const errors = (role.issues ?? []).filter((i) => i.level === 'error').length
        const warnings = (role.issues ?? []).filter((i) => i.level === 'warning').length
        const tag = errors + warnings > 0 ? `issues(${errors}E/${warnings}W)` : 'ok'
        ctx.stdout(`${role.name}  ${role.description.split('\n')[0].slice(0, 60)}  skills=[${role.skills.join(',') || '待填'}]  ${tag}`)
      }
      ctx.stdout(`共 ${roles.length} 个角色（数据源 ${rolesDir}）`)
      return 0
    }

    case 'show': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr('用法: prism role show <name> [--source <dir>]')
        return 1
      }
      const role = await loadRole(rolesDir, name, { knownSkills: await installedSkillNames(harnessRoot, ctx.home) })
      if (role === null) {
        ctx.stderr(`错误 [not_found] 角色不存在: ${name}（数据源 ${rolesDir}/<name>/AGENTS.md）`)
        return 1
      }
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: role }))
        return 0
      }
      ctx.stdout(`name: ${role.name}`)
      ctx.stdout(`description: ${role.description.split('\n')[0]}`)
      if (role.color !== undefined) ctx.stdout(`color: ${role.color}`)
      if (role.model !== undefined) ctx.stdout(`model: ${role.model}`)
      if (role.thoughtLevel !== undefined) ctx.stdout(`thoughtLevel: ${role.thoughtLevel}`)
      ctx.stdout(`skills: [${role.skills.join(', ')}]`)
      ctx.stdout(`knowledge.layers: [${role.knowledge.layers.join(', ')}]`)
      for (const issue of role.issues ?? []) {
        ctx.stdout(`${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
      }
      ctx.stdout('--- 正文 ---')
      ctx.stdout(role.body)
      return 0
    }

    case 'validate': {
      const roles = await loadRoles(rolesDir, { knownSkills: await installedSkillNames(harnessRoot, ctx.home) })
      // 原则一致性（role-definition.md §2.1）：跨角色 + 团队仲裁链的组合校验
      const teams = await loadTeams(dirs.teamsDir)
      const consistency = checkPrincipleConsistency({ roles, teams })
      const consistencyIssues: Array<{ role: string; level: string; code: string; message: string }> = []
      for (const [name, issues] of consistency.entries()) {
        for (const issue of issues) {
          consistencyIssues.push({ role: name, level: issue.level, code: issue.code, message: issue.message })
        }
      }
      const invalid = roles.filter((r) => (r.issues ?? []).some((i) => i.level === 'error'))
      if (ctx.json) {
        ctx.stdout(
          JSON.stringify({
            ok: invalid.length === 0,
            value: {
              roles: roles.map((r) => ({
                name: r.name,
                ok: (r.issues ?? []).every((i) => i.level !== 'error'),
                issues: [...(r.issues ?? []), ...(consistency.get(r.name) ?? [])],
              })),
              consistency: consistencyIssues,
            },
          }),
        )
      } else {
        for (const role of roles) {
          const issues = role.issues ?? []
          if (issues.length === 0) {
            ctx.stdout(`${role.name}: ok`)
          }
          for (const issue of issues) {
            ctx.stdout(`${role.name}: ${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
          }
        }
        for (const issue of consistencyIssues) {
          ctx.stdout(`${issue.role}: WARN [${issue.code}] ${issue.message}`)
        }
        ctx.stdout(
          `校验 ${roles.length} 个角色: ${invalid.length === 0 ? '全部通过' : `${invalid.length} 个存在 error`}` +
            (consistencyIssues.length > 0 ? `（另 ${consistencyIssues.length} 条原则一致性提示）` : ''),
        )
      }
      return invalid.length === 0 ? 0 : 1
    }

    case 'render': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr('用法: prism role render <name> [--model <id>] [--thought-level low|high|max]')
        return 1
      }
      const role = await loadRole(rolesDir, name)
      if (role === null) {
        ctx.stderr(`错误 [not_found] 角色不存在: ${name}（数据源 ${rolesDir}/<name>/AGENTS.md）`)
        return 1
      }
      const env: { model?: string; thoughtLevel?: string } = {}
      if (values.model !== undefined) env['model'] = values.model
      if (values['thought-level'] !== undefined) env['thoughtLevel'] = values['thought-level']
      const content = renderZcodeRole(role, env)
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { name, target: join(zcode.agentsDir, `${name}.md`), content } }))
      } else {
        ctx.stdout(content)
      }
      return 0
    }

    case 'init': {
      const name = rest[0]
      if (name === undefined) {
        ctx.stderr('用法: prism role init <name> [--force]')
        return 1
      }
      // B6 写守卫：目标为默认宿主目录（未经显式指定）时需 --yes 确认
      if (!guardWriteTarget(ctx, values, dirs, 'roles', 1)) return 1
      if (!ctx.json) {
        ctx.stdout(`目标 roles_dir: ${dirs.rolesDir}${dirs.source === 'config' ? '（prism.yaml）' : '（适配器默认）'}`)
      }
      try {
        const result = await initRole({ name, rolesDir: dirs.rolesDir, force: values.force })
        if (ctx.json) {
          ctx.stdout(JSON.stringify({ ok: true, value: { rolesDir: dirs.rolesDir, name, ...result } }))
        } else {
          for (const p of result.written) ctx.stdout(`  已创建 ${p}`)
          for (const s of result.skipped) ctx.stdout(`  跳过 ${s.path}: ${s.reason}`)
          ctx.stdout(`角色 ${name} 初始化完成（下一步：填写核心第一原则/职责/边界）`)
          ctx.stdout('注意: ZCode 角色文件在会话启动时扫描一次——下一会话生效')
        }
        return 0
      } catch (error) {
        ctx.stderr(`错误 [${(error as { code?: string }).code ?? 'bad_request'}] ${error instanceof Error ? error.message : String(error)}`)
        return 1
      }
    }

    default:
      ctx.stderr(`未知子命令: role ${sub ?? ''}\n用法: prism role list|show|init|validate|render`)
      return 1
  }
}
