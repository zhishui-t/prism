/**
 * v15 B-4（SPEC-4.2 / SPEC-4.4）：`prism skill rm <name>` + **三面一致**。
 *
 * - SPEC-4.2：CLI 逐字对齐 `role rm` / `team rm` 守卫模式——`guardWriteTarget`（默认宿主目录
 *   需 `--yes`）+ trash 入站 + `trash_id` 回显；外部判定与 HTTP/MCP **同源**（域单点
 *   `deleteExternalSkillDefinition`）；
 * - SPEC-4.4：同一形态的外部技能分别经 **HTTP / MCP / CLI** 删除 → 回收站单元 `kind=skill`
 *   且 `original_paths` 相同（**trigger 允许不同**——入口溯源参数）。
 *
 * 全部临时目录（红线 R5），零真实宿主污染。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditLog, TrashStore } from '@prism/core'
import { prismSkillMarker } from '@prism/skills'
import { createMcpTools, handleRpcRequest, startServer, type AppHandle } from '@prism/server'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

/** 人写的 SKILL.md（无 Prism marker）。 */
const HANDWRITTEN = '# 规格验证\n\n人写的技能正文。\n'

describe('v15 B-4：prism skill rm（外部技能进回收站）', () => {
  let tmp: string
  let home: string
  let harnessRoot: string
  let skillsDir: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-skillrm-'))
    cleanup.push(tmp)
    home = join(tmp, 'home')
    harnessRoot = join(tmp, 'zcode')
    skillsDir = join(tmp, 'managed-skills')
    await mkdir(home, { recursive: true })
    // prism.yaml 覆盖 skills_dir → source='config'（守卫放行），全部落临时目录（R5）
    const slash = home.replaceAll('\\', '/')
    await writeFile(
      join(home, 'prism.yaml'),
      `skills_dir: ${skillsDir.replaceAll('\\', '/')}\nroles_dir: ${slash}/roles\nteams_dir: ${slash}/teams\n`,
      'utf-8',
    )
    lines = []
    ctx = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home,
    }
  })

  afterEach(async () => {
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    cleanup.length = 0
  })

  const trashStore = (): TrashStore => new TrashStore({ trashDir: join(home, 'trash') })

  async function writeSkill(name: string, content: string = HANDWRITTEN, dir = skillsDir): Promise<void> {
    await mkdir(join(dir, name), { recursive: true })
    await writeFile(join(dir, name, 'SKILL.md'), content, 'utf-8')
  }

  it('rm：搬进回收站（trash_id 回显 + 单元落 <home>/trash）；再次 rm → not_found', async () => {
    await writeSkill('spec-verify')
    const path = join(skillsDir, 'spec-verify')

    lines = []
    expect(await runCommand(ctx, ['skill', 'rm', 'spec-verify'])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('已移入回收站')
    expect(output).toContain('进回收站')
    expect(output).toContain('prism trash restore')
    expect(existsSync(path)).toBe(false)

    const units = await trashStore().list('skill')
    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ kind: 'skill', name: 'spec-verify', managedRoot: skillsDir })
    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ kind: 'skill', trigger: 'CLI', paths: [path] })

    lines = []
    expect(await runCommand(ctx, ['skill', 'rm', 'spec-verify'])).toBe(1)
    expect(lines.join('\n')).toContain('not_found')
  })

  it('rm：Prism 产物（含 marker）→ 报 id_conflict 指路卸载，不动盘', async () => {
    await writeSkill(
      'prism-made',
      `---\nname: prism-made\ndescription: "Prism 装的"\n---\n${prismSkillMarker('prism-made')}\n\n# 正文\n`,
    )
    lines = []
    expect(await runCommand(ctx, ['skill', 'rm', 'prism-made'])).toBe(1)
    expect(lines.join('\n')).toContain('id_conflict')
    expect(lines.join('\n')).toContain('uninstall')
    expect(existsSync(join(skillsDir, 'prism-made', 'SKILL.md'))).toBe(true)
    expect(await trashStore().list('skill')).toEqual([])
  })

  it('rm：缺 name → 用法错误（退出非零，不写盘）', async () => {
    lines = []
    expect(await runCommand(ctx, ['skill', 'rm'])).toBe(1)
    expect(lines.join('\n')).toContain('用法: prism skill rm')
  })

  it('rm 写守卫：默认宿主目录链无 --yes → guard_required 拒绝删除', async () => {
    const envRoot = await mkdtemp(join(tmpdir(), 'prism-skillrm-env-'))
    cleanup.push(envRoot)
    const noConfigHome = await mkdtemp(join(tmpdir(), 'prism-skillrm-noconf-'))
    cleanup.push(noConfigHome)
    const savedEnv = process.env['PRISM_HARNESS_ROOT']
    process.env['PRISM_HARNESS_ROOT'] = envRoot
    try {
      await writeSkill('ghost', HANDWRITTEN, join(envRoot, 'skills'))
      const guarded: CommandContext = { ...ctx, home: noConfigHome }

      lines = []
      expect(await runCommand(guarded, ['skill', 'rm', 'ghost'])).toBe(1)
      expect(lines.join('\n')).toContain('guard_required')
      expect(existsSync(join(envRoot, 'skills', 'ghost', 'SKILL.md'))).toBe(true)

      // --yes 放行（仍写临时 envRoot，非真实宿主）
      lines = []
      expect(await runCommand(guarded, ['skill', 'rm', 'ghost', '--yes'])).toBe(0)
      expect(existsSync(join(envRoot, 'skills', 'ghost'))).toBe(false)
    } finally {
      if (savedEnv === undefined) delete process.env['PRISM_HARNESS_ROOT']
      else process.env['PRISM_HARNESS_ROOT'] = savedEnv
    }
  })

  it('SPEC-4.4 三面一致：同一形态技能经 HTTP / MCP / CLI 删除 → trash 单元 kind=skill 且 original_paths 相同', async () => {
    // 三个**同形态**外部技能（隔离到各自一次删除，避免第二次 404）
    await writeSkill('via-http')
    await writeSkill('via-mcp')
    await writeSkill('via-cli')

    // ① HTTP：DELETE /api/skills/external/:name（落点 = prism.yaml 配置目录）
    const app: AppHandle = await startServer({ home, harnessRoot, port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/api/skills/external/via-http`, { method: 'DELETE' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { value: { removed: string[]; trash_id: string } }
      expect(body.value.removed).toEqual([join(skillsDir, 'via-http')])

      // ② MCP：prism_skill_rm { name, skills_dir }
      const tools = createMcpTools({ home, harnessRoot })
      const mcp = await handleRpcRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_skill_rm', arguments: { name: 'via-mcp', skills_dir: skillsDir } } },
        tools,
      )
      const mcpResult = mcp?.result as { isError: boolean; content: Array<{ text: string }> }
      expect(mcpResult.isError).toBe(false)
      const mcpValue = JSON.parse(mcpResult.content[0]!.text) as { removed: string[]; trash_id: string }
      expect(mcpValue.removed).toEqual([join(skillsDir, 'via-mcp')])

      // ③ CLI：prism skill rm <name>
      lines = []
      expect(await runCommand(ctx, ['skill', 'rm', 'via-cli'])).toBe(0)

      // 三单元的「形态」逐字段一致（trigger 允许不同）
      const units = await trashStore().list('skill')
      expect(units).toHaveLength(3)
      for (const unit of units) {
        expect(unit.kind).toBe('skill')
        expect(unit.originalPaths).toEqual([join(skillsDir, unit.name)])
        expect(unit.managedRoot).toBe(skillsDir)
      }
      expect(units.map((u) => u.name).sort()).toEqual(['via-cli', 'via-http', 'via-mcp'])

      const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
      expect(new Set(audit.map((a) => a.trigger))).toEqual(new Set(['HTTP', 'MCP', 'CLI']))
    } finally {
      await app.close()
    }
  })
})
