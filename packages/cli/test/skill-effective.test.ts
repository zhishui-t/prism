import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

const ROLE_DEV1 = `---
name: dev-1
description: "开发角色：带两个 skill 声明。"
skills:
  - code_review
  - ghost_skill
knowledge:
  layers: [global, project]
---

# 开发 1

## 核心契约
**交付可运行的增量。**
`

const TEAM_SK = `---
team_id: sk
name: 技能团队
description: 团队级 skill 声明测试用。
default: false
members:
  - role: dev-1
    count: 1
skills:
  - team_only
knowledge:
  layers: [global]
deposit:
  enabled: false
  default_layer: project
  default_type: pitfall
  priority: medium
  require_note: false
arbitration: [quality]
rework_limit: 2
---

# 技能团队
`

/** F-D2（CLI 面）：`prism skill effective --role <r> [--team <t>]`。 */
describe('prism skill effective（F-D2 CLI）', () => {
  let home: string
  let harnessRoot: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-skeff-home-'))
    harnessRoot = await mkdtemp(join(tmpdir(), 'prism-skeff-root-'))
    cleanup.push(home, harnessRoot)
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${home.replaceAll('\\', '/')}/roles\nteams_dir: ${home.replaceAll('\\', '/')}/teams\n`,
      'utf-8',
    )
    await mkdir(join(home, 'roles'), { recursive: true })
    await mkdir(join(home, 'teams'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1.md'), ROLE_DEV1, 'utf-8')
    await writeFile(join(home, 'teams', 'sk.md'), TEAM_SK, 'utf-8')
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

  it('全局已装 ∪ 角色声明：来源标注 + 缺失告警（--json）', async () => {
    await mkdir(join(harnessRoot, 'skills', 'code_review'), { recursive: true })
    lines = []
    expect(
      await runCommand(ctx, ['skill', 'effective', '--role', 'dev-1', '--harness-root', harnessRoot, '--json']),
    ).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as {
      value: {
        role: string
        team?: string
        skills: Array<{ name: string; sources: string[]; available: boolean }>
        warnings: Array<{ code: string }>
      }
    }
    expect(out.value.role).toBe('dev-1')
    expect(out.value.team).toBeUndefined()
    const byName = new Map(out.value.skills.map((s) => [s.name, s]))
    expect(byName.get('code_review')).toEqual({ name: 'code_review', sources: ['global', 'role'], available: true })
    expect(byName.get('ghost_skill')?.available).toBe(false)
    expect(byName.get('ghost_skill')?.sources).toEqual(['role'])
    // ghost_skill 既不在内置也不在已装 → skill_unknown
    expect(out.value.warnings.map((w) => w.code)).toEqual(['skill_unknown'])
  })

  it('--team：团队声明并入（source=team）', async () => {
    await mkdir(join(harnessRoot, 'skills', 'code_review'), { recursive: true })
    lines = []
    expect(
      await runCommand(ctx, [
        'skill', 'effective', '--role', 'dev-1', '--team', 'sk', '--harness-root', harnessRoot, '--json',
      ]),
    ).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as {
      value: { team?: string; skills: Array<{ name: string; sources: string[] }>; warnings: Array<{ code: string }> }
    }
    expect(out.value.team).toBe('sk')
    const teamOnly = out.value.skills.find((s) => s.name === 'team_only')
    expect(teamOnly?.sources).toEqual(['team'])
    expect(out.value.warnings.map((w) => w.code).sort()).toEqual(['skill_unknown', 'skill_unknown'])
  })

  it('宿主 skills 目录不存在（installed 缺省）→ available 全 true；未知名字仍给 skill_unknown', async () => {
    const bareRoot = await mkdtemp(join(tmpdir(), 'prism-skeff-bare-'))
    cleanup.push(bareRoot)
    lines = []
    expect(
      await runCommand(ctx, ['skill', 'effective', '--role', 'dev-1', '--harness-root', bareRoot, '--json']),
    ).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as {
      value: { skills: Array<{ available: boolean; sources: string[] }>; warnings: Array<{ code: string }> }
    }
    // installed 缺省 = 宿主 skills 目录不存在 → 不判 skill_not_installed，available 全 true
    expect(out.value.skills.every((s) => s.available)).toBe(true)
    expect(out.value.skills.every((s) => s.sources.join() === 'role')).toBe(true)
    // 但「内置清单 ∪ 已装」都没有的名字仍是 skill_unknown（两个声明都不存在）
    expect(out.value.warnings.map((w) => w.code)).toEqual(['skill_unknown', 'skill_unknown'])
  })

  it('文本输出：来源标签 + 已装/未装 + 告警', async () => {
    await mkdir(join(harnessRoot, 'skills', 'code_review'), { recursive: true })
    lines = []
    expect(
      await runCommand(ctx, ['skill', 'effective', '--role', 'dev-1', '--team', 'sk', '--harness-root', harnessRoot]),
    ).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('role=dev-1')
    expect(text).toContain('team=sk')
    expect(text).toContain('[global+role]')
    expect(text).toContain('已装  code_review')
    expect(text).toContain('未装  ghost_skill')
    expect(text).toContain('WARN [skill_unknown]')
    expect(text).toContain('共 3 个生效 Skill')
  })

  it('角色/团队不存在 → not_found（rc 1）；缺 --role → 用法（rc 1）', async () => {
    lines = []
    expect(
      await runCommand(ctx, ['skill', 'effective', '--role', 'nope', '--harness-root', harnessRoot]),
    ).toBe(1)
    expect(lines.join('\n')).toContain('not_found')

    lines = []
    expect(
      await runCommand(ctx, ['skill', 'effective', '--role', 'dev-1', '--team', 'nope', '--harness-root', harnessRoot]),
    ).toBe(1)
    expect(lines.join('\n')).toContain('团队不存在')

    lines = []
    expect(await runCommand(ctx, ['skill', 'effective'])).toBe(1)
    expect(lines.join('\n')).toContain('用法: prism skill effective')
  })
})
