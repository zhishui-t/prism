import { rm, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { PrismError } from '@prism/core'
import { installSkills, listBuiltinSkills, validateSkill } from '@prism/skills'
import { PRISM_MARKER_PREFIX } from '@prism/skills'
import { loadEffectiveSkills } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { dirProvenanceLabel, guardWriteTarget, resolveTargetDirs } from '../argv.js'

/**
 * `prism skill list/install`（design-v3 §3.5 F10；本期裁剪 update/uninstall/uninit）。
 * 安装目标 = resolveDirs().skillsDir（prism.yaml 可覆盖；默认 `<harnessRoot>/skills/`，
 * adapter.skill.nativeDir 约定），不硬编码。
 */
export async function runSkill(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const dirs = resolveTargetDirs(ctx, values)
  const skillsDir = dirs.skillsDir

  switch (sub) {
    case 'effective':
      return await skillEffective(ctx, values, dirs)

    case 'list': {
      const skills = listBuiltinSkills()
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: skills }))
        return 0
      }
      for (const skill of skills) {
        const validation = validateSkill(skill)
        const errors = validation.issues.filter((i) => i.level === 'error').length
        ctx.stdout(`${skill.name}  builtin  desc=${skill.description.length}字符  ${errors === 0 ? 'ok' : `${errors}E`}`)
        ctx.stdout(`  ${skill.description}`)
      }
      ctx.stdout(`共 ${skills.length} 个内置 Skill（安装目标 ${skillsDir}/<name>/SKILL.md，来源：${dirProvenanceLabel(dirs.provenance.skills)}）`)
      return 0
    }

    case 'install': {
      const names = rest.filter((n) => !n.startsWith('-'))
      const all = listBuiltinSkills()
      const skills = names.length === 0 ? all : all.filter((s) => names.includes(s.name))
      const missing = names.filter((n) => !all.some((s) => s.name === n))
      if (missing.length > 0) {
        ctx.stderr(`错误 [not_found] 未知内置 Skill: ${missing.join(', ')}（可用: ${all.map((s) => s.name).join(', ')}）`)
        return 1
      }
      // B6 写守卫：默认宿主 skills_dir 需 --yes 确认
      if (!guardWriteTarget(ctx, values, dirs, 'skills', skills.length)) return 1
      const result = await installSkills({ targetDir: skillsDir, skills, force: values.force })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { targetDir: skillsDir, ...result } }))
      } else {
        for (const path of result.written) {
          ctx.stdout(`  已写 ${path}`)
        }
        for (const s of result.skipped) {
          ctx.stdout(`  跳过 ${s.path}: ${s.reason}`)
        }
        ctx.stdout(`Skill 安装完成（${result.written.length} 写 / ${result.skipped.length} 跳过）→ ${join(skillsDir, '<name>', 'SKILL.md')}`)
        ctx.stdout('注意: 请重启 ZCode 会话使 Skill 生效')
      }
      return 0
    }

    case 'validate': {
      // 校验内置 Skill（kebab-case / description 长度 / frontmatter 一致）
      const all = listBuiltinSkills()
      const names = rest.filter((n) => !n.startsWith('-'))
      const target = names.length === 0 ? all : all.filter((s) => names.includes(s.name))
      const missing = names.filter((n) => !all.some((s) => s.name === n))
      if (missing.length > 0) {
        ctx.stderr(`错误 [not_found] 未知内置 Skill: ${missing.join(', ')}`)
        return 1
      }
      let errors = 0
      const results = target.map((skill) => {
        const validation = validateSkill(skill)
        const errs = validation.issues.filter((i) => i.level === 'error')
        errors += errs.length
        return { name: skill.name, ok: errs.length === 0, issues: validation.issues }
      })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: errors === 0, value: results }))
      } else {
        for (const r of results) {
          ctx.stdout(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`)
          for (const issue of r.issues) {
            ctx.stdout(`     [${issue.level}] ${issue.message}`)
          }
        }
        ctx.stdout(`共 ${results.length} 个，${errors} 个错误`)
      }
      return errors === 0 ? 0 : 1
    }

    case 'update': {
      // 等价 install --force：重装内置 Skill（幂等覆盖 Prism 产物）
      const all = listBuiltinSkills()
      const names = rest.filter((n) => !n.startsWith('-'))
      const skills = names.length === 0 ? all : all.filter((s) => names.includes(s.name))
      if (!guardWriteTarget(ctx, values, dirs, 'skills', skills.length)) return 1
      const result = await installSkills({ targetDir: skillsDir, skills, force: true })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { targetDir: skillsDir, ...result } }))
      } else {
        ctx.stdout(`已更新 ${result.written.length} 个 Skill（跳过 ${result.skipped.length}）→ ${skillsDir}`)
        ctx.stdout('注意: 请重启 ZCode 会话使更新生效')
      }
      return 0
    }

    case 'uninstall': {
      // 只删 Prism 产物（SKILL.md 含 marker）；人写的 Skill 一律不动
      const names = rest.filter((n) => !n.startsWith('-'))
      let targets = names
      if (targets.length === 0) {
        if (!existsSync(skillsDir)) {
          ctx.stdout('（skills_dir 不存在，无需卸载）')
          return 0
        }
        const entries = await readdir(skillsDir, { withFileTypes: true })
        targets = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      }
      if (!guardWriteTarget(ctx, values, dirs, 'skills', targets.length)) return 1

      const removed: string[] = []
      const kept: string[] = []
      for (const name of targets) {
        const dir = join(skillsDir, name)
        const skillFile = join(dir, 'SKILL.md')
        if (!existsSync(skillFile)) {
          kept.push(`${name}（无 SKILL.md）`)
          continue
        }
        const text = await readFile(skillFile, 'utf-8')
        if (!text.includes(PRISM_MARKER_PREFIX)) {
          kept.push(`${name}（非 Prism 产物，保留）`)
          continue
        }
        await rm(dir, { recursive: true, force: true })
        removed.push(name)
      }
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { removed, kept } }))
      } else {
        for (const name of removed) ctx.stdout(`  已卸载 ${name}`)
        for (const name of kept) ctx.stdout(`  跳过 ${name}`)
        ctx.stdout(`卸载完成（${removed.length} 删 / ${kept.length} 跳过）`)
        ctx.stdout('注意: 请重启 ZCode 会话使卸载生效')
      }
      return 0
    }

    default:
      ctx.stderr(
        `未知子命令: skill ${sub ?? ''}\n用法: prism skill list | install | update | uninstall | validate [name...] | effective --role <r> [--team <t>] [--harness-root <dir>] [--force]`,
      )
      return 1
  }
}

/**
 * `prism skill effective --role <r> [--team <t>] [--json]`（design-v4 §F-D2 CLI 面）。
 *
 * 有效集 = 全局已装 ∪ 团队声明 ∪ 角色声明（去重 + 来源标注 + 缺失告警）。
 * 装配走 `@prism/server` 的 `loadEffectiveSkills`（§3.4 冻结的唯一装配点）——
 * **与 MCP `prism_skill_effective` / HTTP `GET /api/skills/effective` 同一实现**，
 * 故「四处同输入同输出」由单点保证（纯计算在 `@prism/agents` 的 `computeEffectiveSkills`）。
 */
async function skillEffective(ctx: CommandContext, values: ArgValues, dirs: ReturnType<typeof resolveTargetDirs>): Promise<number> {
  const roleId = values.role
  if (roleId === undefined || roleId === '') {
    ctx.stderr('用法: prism skill effective --role <r> [--team <t>] [--json]')
    return 1
  }
  try {
    const effective = await loadEffectiveSkills({
      roleId: String(roleId),
      ...(values.team !== undefined ? { teamId: String(values.team) } : {}),
      teamsDir: dirs.teamsDir,
      rolesDir: dirs.rolesDir,
      harnessRoot: dirs.harnessRoot,
      home: ctx.home,
    })
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ok: true, value: effective }))
      return 0
    }
    ctx.stdout(`生效 Skill：role=${effective.role}${effective.team !== undefined ? `  team=${effective.team}` : ''}`)
    if (effective.skills.length === 0) {
      ctx.stdout('  （空：角色与团队都没有声明 skill）')
    }
    for (const skill of effective.skills) {
      ctx.stdout(`  ${skill.available ? '已装' : '未装'}  ${skill.name.padEnd(24)} [${skill.sources.join('+')}]`)
    }
    for (const issue of effective.warnings) {
      ctx.stdout(`WARN [${issue.code}] ${issue.message}`)
    }
    ctx.stdout(`共 ${effective.skills.length} 个生效 Skill（${effective.warnings.length} 条缺失告警）`)
    return 0
  } catch (error) {
    const code = error instanceof PrismError ? error.code : 'bad_request'
    ctx.stderr(`错误 [${code}] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
