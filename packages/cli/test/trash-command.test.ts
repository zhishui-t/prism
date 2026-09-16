/**
 * `prism trash list | restore <id> | purge [--all]`（design-v9 §3 F3 的 CLI 面）+
 * CLI 三入口（role/team/skill）删除进回收站的接线与审计。
 *
 * 全部写临时目录（`--home` 指临时 home + prism.yaml 覆盖受管目录），绝不碰真实宿主（R5/R6）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditLog, TrashStore } from '@prism/core'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

const ROLE_MD = `---
name: dev-1
description: "开发角色：交付可运行增量。"
color: blue
---

# 开发 1

## 核心契约
**交付可运行的增量。**
`

describe('prism trash（回收站命令面）', () => {
  let home: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-trash-cli-'))
    cleanup.push(home)
    const slash = home.replaceAll('\\', '/')
    await writeFile(join(home, 'prism.yaml'), `roles_dir: ${slash}/roles\nteams_dir: ${slash}/teams\n`, 'utf-8')
    await mkdir(join(home, 'roles'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1.md'), ROLE_MD, 'utf-8')
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
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  const output = (): string => lines.join('\n')
  const trash = (): TrashStore => new TrashStore({ trashDir: join(home, 'trash') })
  const audit = (): AuditLog => new AuditLog({ dir: join(home, 'audit') })

  it('list：空回收站给出可读提示；删除后列出单元（含 broken 标记）且 --kind 可过滤', async () => {
    expect(await runCommand(ctx, ['trash', 'list'])).toBe(0)
    expect(output()).toContain('回收站为空')

    // 造两类单元：role（正常）+ team（缺 meta → broken）
    expect(await runCommand(ctx, ['role', 'rm', 'dev-1'])).toBe(0)
    await mkdir(join(home, 'trash', 'team', '20200101-000000-gone'), { recursive: true })

    lines = []
    expect(await runCommand(ctx, ['trash', 'list'])).toBe(0)
    expect(output()).toContain('role/')
    expect(output()).toContain('[broken]')
    expect(output()).toContain('共 2 个单元')

    lines = []
    expect(await runCommand(ctx, ['trash', 'list', '--kind', 'role'])).toBe(0)
    expect(output()).toContain('共 1 个单元')
    expect(output()).not.toContain('[broken]')

    lines = []
    expect(await runCommand(ctx, ['trash', 'list', '--json'])).toBe(0)
    const json = JSON.parse(lines[lines.length - 1]!) as { value: Array<{ id: string; kind: string; name: string }> }
    expect(json.value.map((u) => u.kind).sort()).toEqual(['role', 'team'])
  })

  it('restore：还原到原路径；目标已存在报 target_exists（--overwrite 才覆盖）；未知 id 友好报错', async () => {
    expect(await runCommand(ctx, ['role', 'rm', 'dev-1'])).toBe(0)
    const [unit] = await trash().list('role')
    expect(unit).toBeDefined()
    const id = unit!.id
    expect(existsSync(join(home, 'roles', 'dev-1.md'))).toBe(false)

    // 目标位置长出同名文件 → 拒绝
    await writeFile(join(home, 'roles', 'dev-1.md'), '占位\n', 'utf-8')
    lines = []
    expect(await runCommand(ctx, ['trash', 'restore', id])).toBe(1)
    expect(output()).toContain('target_exists')
    expect(output()).toContain('--overwrite')
    expect(await readFile(join(home, 'roles', 'dev-1.md'), 'utf-8')).toBe('占位\n')

    // --overwrite 真的覆盖
    lines = []
    expect(await runCommand(ctx, ['trash', 'restore', id, '--overwrite'])).toBe(0)
    expect(output()).toContain('已还原')
    expect(output()).toContain(join(home, 'roles', 'dev-1.md'))
    expect(await readFile(join(home, 'roles', 'dev-1.md'), 'utf-8')).toContain('name: dev-1')
    expect(await trash().list()).toEqual([])

    // 未知 id / 非法形状 → not_found + 提示去 list 取 id
    lines = []
    expect(await runCommand(ctx, ['trash', 'restore', 'role/20990101-000000-ghost'])).toBe(1)
    expect(output()).toContain('not_found')
    expect(output()).toContain('prism trash list')

    lines = []
    expect(await runCommand(ctx, ['trash', 'restore', '../../etc/passwd'])).toBe(1)
    expect(output()).toContain('not_found')
  })

  it('purge：[缺省] 只清到期单元；--all 清全部', async () => {
    // 一条「今天删的」（未到期）——用真实 rm 产生
    expect(await runCommand(ctx, ['role', 'rm', 'dev-1'])).toBe(0)
    // 一条「很久以前删的」——手工造单元（目录名 + meta 时间戳都在 2020 年）
    const oldUnitDir = join(home, 'trash', 'role', '20200101-000000-old-role')
    await mkdir(oldUnitDir, { recursive: true })
    await writeFile(
      join(oldUnitDir, 'trash-meta.json'),
      JSON.stringify(
        {
          original_paths: [join(home, 'roles', 'old-role.md')],
          managed_root: join(home, 'roles'),
          deleted_at: new Date('2020-01-01T00:00:00.000Z').toISOString(),
          trigger: 'CLI',
        },
        null,
        2,
      ),
      'utf-8',
    )

    lines = []
    expect(await runCommand(ctx, ['trash', 'purge'])).toBe(0)
    expect(output()).toContain('20200101-000000-old-role')
    // 未到期的仍在
    expect((await trash().list('role')).map((u) => u.name)).toEqual(['dev-1'])

    lines = []
    expect(await runCommand(ctx, ['trash', 'purge', '--all'])).toBe(0)
    expect(output()).toContain('共清除 1 个单元')
    expect(await trash().list()).toEqual([])

    lines = []
    expect(await runCommand(ctx, ['trash', 'purge'])).toBe(0)
    expect(output()).toContain('没有到期单元')
  })

  it('role rm / team rm / skill uninstall 三入口都进回收站，且审计三事件齐全（trigger=CLI）', async () => {
    // ① role rm（扁平形态）
    lines = []
    expect(await runCommand(ctx, ['role', 'rm', 'dev-1'])).toBe(0)
    expect(output()).toContain('进回收站')
    expect(output()).toContain('prism trash restore')

    // ② team rm（目录形态 → 整目录搬走，不留残目录）
    const teamDir = join(home, 'teams', 'demo')
    await mkdir(teamDir, { recursive: true })
    await writeFile(join(teamDir, 'AGENTS.md'), '---\nteam_id: demo\n---\n', 'utf-8')
    await writeFile(join(teamDir, 'notes.md'), '# 附带\n', 'utf-8')
    lines = []
    expect(await runCommand(ctx, ['team', 'rm', 'demo'])).toBe(0)
    expect(output()).toContain('进回收站')
    expect(existsSync(teamDir)).toBe(false)

    // ③ skill uninstall（只回收 Prism 产物：整目录）
    const skillsDir = join(home, 'skills')
    expect(await runCommand(ctx, ['skill', 'install', '--harness-root', home, '--json'])).toBe(0)
    await mkdir(join(skillsDir, 'handwritten'), { recursive: true })
    await writeFile(join(skillsDir, 'handwritten', 'SKILL.md'), '# 人写的\n', 'utf-8')
    lines = []
    expect(await runCommand(ctx, ['skill', 'uninstall', '--harness-root', home])).toBe(0)
    expect(output()).toContain('进回收站')
    expect(output()).toContain('跳过 handwritten')
    expect(existsSync(join(skillsDir, 'prism'))).toBe(false)
    expect(existsSync(join(skillsDir, 'handwritten', 'SKILL.md'))).toBe(true)

    // 三类单元齐
    expect((await trash().list()).map((u) => u.kind).sort()).toEqual(['role', 'skill', 'team'])

    // 删除（put）审计：一次 role、一次 team、一次 skill，trigger 全为 CLI
    const puts = await audit().query({ types: ['trash.put'], order: 'asc' })
    expect(puts.map((e) => (e as { kind: string }).kind).sort()).toEqual(['role', 'skill', 'team'])
    expect(puts.every((e) => (e as { trigger: string }).trigger === 'CLI')).toBe(true)
    expect(puts.every((e) => Array.isArray((e as { paths?: unknown }).paths))).toBe(true)

    // restore / purge 审计（同一条链路上补全三事件）
    const roleUnit = (await trash().list('role'))[0]!
    expect(await runCommand(ctx, ['trash', 'restore', roleUnit.id])).toBe(0)
    expect(await runCommand(ctx, ['trash', 'purge', '--all'])).toBe(0)

    const events = await audit().query({ types: ['trash.put', 'trash.restore', 'trash.purge'], order: 'asc' })
    // 计数口径：3 次删除各一条 put；1 次还原一条 restore；purge 是**单元级**粒度
    // （一次 purge --all 清两个单元 → 两条事件，否则多单元事件无法挂到具体单元）
    const counts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.type] = (acc[event.type] ?? 0) + 1
      return acc
    }, {})
    expect(counts).toEqual({ 'trash.put': 3, 'trash.restore': 1, 'trash.purge': 2 })
    const restore = events.find((e) => e.type === 'trash.restore') as unknown as Record<string, unknown>
    expect(restore).toMatchObject({ kind: 'role', unit_id: roleUnit.id, trigger: 'CLI' })
    const purge = events.find((e) => e.type === 'trash.purge') as unknown as Record<string, unknown>
    expect(purge?.['trigger']).toBe('CLI')
    expect(typeof purge?.['kind']).toBe('string')
    expect(typeof purge?.['unit_id']).toBe('string')
    expect(await trash().list()).toEqual([])
  })

  it('未知子命令 / 缺 id → rc 1 + 用法', async () => {
    lines = []
    expect(await runCommand(ctx, ['trash', 'nope'])).toBe(1)
    expect(output()).toContain('未知子命令: trash nope')
    expect(output()).toContain('prism trash list')

    lines = []
    expect(await runCommand(ctx, ['trash', 'restore'])).toBe(1)
    expect(output()).toContain('用法: prism trash')
  })
})
