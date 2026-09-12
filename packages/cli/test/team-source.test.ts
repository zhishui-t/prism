import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

const ROLE_DEV1 = `---
name: dev-1
description: "开发角色：交付可运行增量。"
color: blue
---

# 开发 1

## 核心契约
**交付可运行的增量。**
`

const ROLE_OTHER = ROLE_DEV1.replace(/dev-1/g, 'other-role')

/**
 * v6.2：`team` 侧目录参数对称（此前 team 是三入口里唯一不能指定目录的）。
 *
 * 口径与 `role --source` 一致：`--source` 覆盖**本命令的受管目录**（team = teams_dir），
 * 读写一律生效；显式给出即等同 `--harness-root`，解除写守卫（不再需要 `--yes`）。
 * `--roles-dir` 单独覆盖成员校验用的角色库（对齐 MCP `prism_team_new|edit` 的 `roles_dir`）。
 */
describe('prism team --source / --roles-dir（v6.2）', () => {
  let home: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-team-source-home-'))
    cleanup.push(home)
    const slash = home.replaceAll('\\', '/')
    await writeFile(join(home, 'prism.yaml'), `roles_dir: ${slash}/roles\nteams_dir: ${slash}/teams\n`, 'utf-8')
    await mkdir(join(home, 'roles'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1.md'), ROLE_DEV1, 'utf-8')
    await writeFile(join(home, 'roles', 'other-role.md'), ROLE_OTHER, 'utf-8')
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
    for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const mkSrc = async (prefix: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), prefix))
    cleanup.push(dir)
    return dir
  }

  it('new --source <dir>：落 <dir>/<id>.md；默认 teams_dir 不受影响', async () => {
    const src = await mkSrc('prism-team-source-new-')
    expect(await runCommand(ctx, ['team', 'new', 'alt', '--source', src, '--members', 'dev-1:1'])).toBe(0)
    expect(existsSync(join(src, 'alt.md'))).toBe(true)
    expect(existsSync(join(home, 'teams', 'alt.md'))).toBe(false)
    // 落点来源如实标注（不再误标为 prism.yaml）
    expect(lines.join('\n')).toContain('--source')
  })

  it('list / show --source <dir>：读侧同样生效（此前 team 连读都没有目录参数）', async () => {
    const src = await mkSrc('prism-team-source-list-')
    expect(await runCommand(ctx, ['team', 'new', 'alt', '--source', src, '--members', 'dev-1:1'])).toBe(0)

    lines = []
    expect(await runCommand(ctx, ['team', 'list', '--source', src])).toBe(0)
    expect(lines.join('\n')).toContain('alt')

    lines = []
    expect(await runCommand(ctx, ['team', 'show', 'alt', '--source', src])).toBe(0)
    expect(lines.join('\n')).toContain('team_id: alt')

    // 不带 --source：读的是 prism.yaml 的 teams_dir（那里没有 alt）
    lines = []
    expect(await runCommand(ctx, ['team', 'list'])).toBe(0)
    expect(lines.join('\n')).not.toContain('alt')
  })

  it('rm --source <dir>：只删该目录那份；默认目录的同名团队原封不动', async () => {
    const src = await mkSrc('prism-team-source-rm-')
    expect(await runCommand(ctx, ['team', 'new', 'dup', '--members', 'dev-1:1'])).toBe(0)
    expect(await runCommand(ctx, ['team', 'new', 'dup', '--source', src, '--members', 'dev-1:1'])).toBe(0)
    expect(existsSync(join(home, 'teams', 'dup.md'))).toBe(true)
    expect(existsSync(join(src, 'dup.md'))).toBe(true)

    lines = []
    expect(await runCommand(ctx, ['team', 'rm', 'dup', '--source', src])).toBe(0)
    expect(existsSync(join(src, 'dup.md'))).toBe(false)
    expect(existsSync(join(home, 'teams', 'dup.md'))).toBe(true)
  })

  it('--source 显式 → 解除写守卫（prism.yaml 缺席、目标非默认宿主目录时也无需 --yes）', async () => {
    const src = await mkSrc('prism-team-source-guard-')
    const noConfigHome = await mkSrc('prism-team-source-noconf-')
    const isolated: CommandContext = { ...ctx, home: noConfigHome }
    const rc = await runCommand(isolated, [
      'team',
      'new',
      'free',
      '--source',
      src,
      '--roles-dir',
      join(home, 'roles'),
      '--members',
      'dev-1:1',
    ])
    expect(rc).toBe(0)
    expect(existsSync(join(src, 'free.md'))).toBe(true)
    expect(lines.join('\n')).not.toContain('guard_required')
  })

  it('--roles-dir：成员校验用显式角色库（隔离库缺成员 → 报错，不落盘）', async () => {
    const src = await mkSrc('prism-team-source-roles-')
    const bareRoles = await mkSrc('prism-team-source-bareroles-') // 空角色库

    lines = []
    expect(
      await runCommand(ctx, [
        'team',
        'new',
        'ghost-team',
        '--source',
        src,
        '--roles-dir',
        bareRoles,
        '--members',
        'dev-1:1',
      ]),
    ).toBe(1)
    expect(lines.join('\n')).toContain('team_invalid')
    expect(existsSync(join(src, 'ghost-team.md'))).toBe(false)

    // 换成有 dev-1 的角色库 → 通过并落盘（证明 --roles-dir 真的被用作校验源）
    lines = []
    expect(
      await runCommand(ctx, [
        'team',
        'new',
        'ghost-team',
        '--source',
        src,
        '--roles-dir',
        join(home, 'roles'),
        '--members',
        'dev-1:1',
      ]),
    ).toBe(0)
    expect(existsSync(join(src, 'ghost-team.md'))).toBe(true)
  })
})
