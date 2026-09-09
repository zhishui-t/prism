import { join } from 'node:path'

import { installSkills, listBuiltinSkills, validateSkill } from '@prism/skills'

import type { ArgValues, CommandContext } from '../argv.js'
import { guardWriteTarget, resolveTargetDirs } from '../argv.js'

/**
 * `prism skill list/install`（design-v3 §3.5 F10；本期裁剪 update/uninstall/uninit）。
 * 安装目标 = resolveDirs().skillsDir（prism.yaml 可覆盖；默认 `<zcodeDir>/skills/`，
 * adapter.skill.nativeDir 约定），不硬编码。
 */
export async function runSkill(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const dirs = resolveTargetDirs(ctx, values)
  const skillsDir = dirs.skillsDir

  switch (sub) {
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
      ctx.stdout(`共 ${skills.length} 个内置 Skill（安装目标 ${skillsDir}/<name>/SKILL.md${dirs.source === 'config' ? '，prism.yaml' : ''}）`)
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

    default:
      ctx.stderr(`未知子命令: skill ${sub ?? ''}\n用法: prism skill list | install [name...] [--zcode-dir <dir>] [--force]`)
      return 1
  }
}
