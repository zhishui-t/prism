import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CORE_DEV_TEAM_MD, fillTeamTemplate } from '@prism/agents'

import { defaultContext, expandHome, runCommand, type CommandContext } from '../src/argv.js'
import { parseArgv } from '../src/argv.js'

const ZCODE_ROLE_A = `---
name: dev-1
description: "开发角色：交付可运行增量，绝不扩大战场。适用于: 功能开发。"
color: blue
model: "custom:builtin%3Abigmodel:GLM"
thoughtLevel: max
---

# 开发 1

## 核心契约
**交付可运行的增量，绝不扩大战场。**

## 职责
- 写代码
`

const ZCODE_ROLE_B = `---
name: tester
description: "测试角色：全项有运行证据才算完成。"
color: green
---

# 测试

## 核心契约
**没证据不放行。**
`

describe('CLI 参数解析与 ~ 展开（design-v3 §5 P14）', () => {
  it('parseArgv 接受 --harness-root/--source/--force/--thought-level', () => {
    const { positionals, values } = parseArgv([
      'role',
      'init',
      'dev-1',
      '--harness-root',
      '~/x',
      '--source',
      'D:/roles',
      '--force',
      '--thought-level',
      'max',
    ])
    expect(positionals).toEqual(['role', 'init', 'dev-1'])
    expect(values['harness-root']).toBe('~/x')
    expect(values['source']).toBe('D:/roles')
    expect(values['thought-level']).toBe('max')
    expect(values.force).toBe(true)
  })

  it('expandHome 展开 ~ 与 ~/ 前缀；其余原样', () => {
    expect(expandHome('~')).not.toBe('~')
    expect(expandHome('~/zcode')).toContain('zcode')
    expect(expandHome('D:/tmp/x')).toBe('D:/tmp/x')
    expect(expandHome('~/')).not.toMatch(/^~/)
  })
})

describe('prism init（F09 五步；全部写临时目录）', () => {
  let home: string
  let harnessRoot: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-init-home-'))
    harnessRoot = await mkdtemp(join(tmpdir(), 'prism-init-zcode-'))
    cleanup.push(home, harnessRoot)
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

  it('首次 init：① 探测 ② 骨架 ③ 装 skill ④ 写 MCP ⑤ 报告 + 重启提示', async () => {
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('① 宿主目录')
    expect(output).toContain('catalog')
    expect(output).toContain('roles')
    expect(output).toContain('③ Skill 安装: 写 9 个') // SKILL.md + 8 个 references/（渐进披露）
    expect(existsSync(join(harnessRoot, 'skills', 'prism', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(harnessRoot, 'skills', 'prism', 'references', 'graph.md'))).toBe(true)
    // ④ config.json 合并写入
    const config = JSON.parse(await readFile(join(harnessRoot, 'cli', 'config.json'), 'utf-8')) as {
      mcp: { servers: { prism: { type: string; env: { PRISM_HOME: string } } } }
    }
    expect(config.mcp.servers.prism.type).toBe('stdio')
    expect(config.mcp.servers.prism.env.PRISM_HOME).toBe(home)
    // **不播种任何团队，也不预建 teams/**：受管位置由适配器/prism.yaml 决定；
    // <home>/teams 是旧版 Prism 的团队源目录，新装用户无需它
    expect(existsSync(join(harnessRoot, 'teams'))).toBe(false)
    expect(existsSync(join(home, 'teams'))).toBe(false)
    expect(output).toContain('团队: 未创建')
    expect(output).toContain('⑤ 完成。请重启宿主会话使 MCP 与 Skill 生效')
  })

  it('幂等：重跑不产生新备份、MCP 状态 unchanged', async () => {
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--json'])).toBe(0)
    const first = JSON.parse(lines[lines.length - 1]) as { value: { mcp: { status: string; backup?: string } } }
    expect(first.value.mcp.status).toBe('written')

    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--json'])).toBe(0)
    const second = JSON.parse(lines[lines.length - 1]) as { value: { mcp: { status: string }; skills: { written: unknown[]; skipped: unknown[] } } }
    expect(second.value.mcp.status).toBe('unchanged')
    expect(second.value.mcp.backup).toBeUndefined()
    // skill 幂等重装（marker → 覆盖，无 skip；9 个文件：SKILL.md + 8 references）
    expect(second.value.skills.written).toHaveLength(9)
    expect(second.value.skills.skipped).toHaveLength(0)
  })

  it('保留既有配置键 + 写前备份（.bak-prism-init-<ts>）', async () => {
    const configFile = join(harnessRoot, 'cli', 'config.json')
    await mkdir(join(harnessRoot, 'cli'), { recursive: true })
    await writeFile(
      configFile,
      JSON.stringify({ mcp: { servers: { photoshop: { command: 'photoshop-mcp' } } }, plugins: { enabledPlugins: { a: true } } }),
      'utf-8',
    )
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot])).toBe(0)
    const config = JSON.parse(await readFile(configFile, 'utf-8')) as {
      mcp: { servers: Record<string, unknown> }
      plugins: { enabledPlugins: { a: boolean } }
    }
    expect(config.mcp.servers['photoshop']).toEqual({ command: 'photoshop-mcp' })
    expect(config.plugins.enabledPlugins['a']).toBe(true)
    expect(config.mcp.servers['prism']).toBeDefined()
    const cliDir = await readdir(join(harnessRoot, 'cli'))
    expect(cliDir.some((f) => f.startsWith('config.json.bak-prism-init-'))).toBe(true)
  })

  it('已有 mcp.servers.prism 指向不同路径 → 不覆盖并提示 --force；--force 才覆盖', async () => {
    const configFile = join(harnessRoot, 'cli', 'config.json')
    await mkdir(join(harnessRoot, 'cli'), { recursive: true })
    await writeFile(
      configFile,
      JSON.stringify({ mcp: { servers: { prism: { command: 'elsewhere' } } } }),
      'utf-8',
    )
    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--json'])).toBe(0)
    const report = JSON.parse(lines[lines.length - 1]) as { value: { mcp: { status: string } } }
    expect(report.value.mcp.status).toBe('conflict')
    expect(JSON.parse(await readFile(configFile, 'utf-8')) as { mcp: { servers: { prism: { command: string } } } }).toMatchObject({
      mcp: { servers: { prism: { command: 'elsewhere' } } },
    })
    // 文本模式给出 --force 提示
    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot])).toBe(0)
    expect(lines.join('\n')).toContain('--force')

    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--force', '--json'])).toBe(0)
    const forced = JSON.parse(lines[lines.length - 1]) as { value: { mcp: { status: string; backup?: string } } }
    expect(forced.value.mcp.status).toBe('forced')
    expect(forced.value.mcp.backup).toBeDefined()
  })

  it('人写的同名 Skill → 不覆盖，写 .prism-new；--force 覆盖', async () => {
    const skillFile = join(harnessRoot, 'skills', 'prism', 'SKILL.md')
    await mkdir(join(harnessRoot, 'skills', 'prism'), { recursive: true })
    await writeFile(skillFile, '---\nname: prism\ndescription: "人写的"\n---\n\n手写\n', 'utf-8')
    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--json'])).toBe(0)
    const report = JSON.parse(lines[lines.length - 1]) as { value: { skills: { skipped: Array<{ path: string }> } } }
    expect(report.value.skills.skipped).toHaveLength(1)
    expect(await readFile(skillFile, 'utf-8')).toContain('人写的')
    expect(existsSync(`${skillFile}.prism-new`)).toBe(true)

    lines = []
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--force', '--json'])).toBe(0)
    expect(await readFile(skillFile, 'utf-8')).toContain('generated by prism')
  })
})

describe('prism role/team/skill（F10 端到端；临时目录）', () => {
  let home: string
  let harnessRoot: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-ppl-home-'))
    harnessRoot = await mkdtemp(join(tmpdir(), 'prism-ppl-zcode-'))
    // harnessRoot 只作 skill install 默认目标与默认目录推导基准
    // （role/team 受管目录由 prism.yaml 覆盖为 <home> 布局，见下）
    // 队长指示的测试方式：--home 指临时目录 + prism.yaml 覆盖（绝不写真实 ~/.zcode）
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${home.replaceAll('\\', '/')}/roles\nteams_dir: ${home.replaceAll('\\', '/')}/teams\n`,
      'utf-8',
    )
    cleanup.push(home, harnessRoot)
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

  it('list → validate → render → skill install 全链路（角色直接手写在 roles_dir）', async () => {
    // 角色直接写进受管 roles_dir（<home>/roles，由 prism.yaml 指定）——没有"导入/装配"这一步
    await mkdir(join(home, 'roles'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1.md'), ZCODE_ROLE_A, 'utf-8')
    await writeFile(join(home, 'roles', 'tester.md'), ZCODE_ROLE_B, 'utf-8')

    // list：skills 空 → issues 带 warning 但无 error（agents 校验码：skills_empty）
    lines = []
    expect(await runCommand(ctx, ['role', 'list', '--json'])).toBe(0)
    const list = JSON.parse(lines[lines.length - 1]) as { value: Array<{ name: string; issues: Array<{ code: string }> }> }
    expect(list.value.map((r) => r.name).sort()).toEqual(['dev-1', 'tester'])
    expect(list.value.every((r) => r.issues.some((i) => i.code === 'skills_empty'))).toBe(true)

    // validate：无 error → rc 0
    lines = []
    expect(await runCommand(ctx, ['role', 'validate'])).toBe(0)
    expect(lines.join('\n')).toContain('全部通过')

    // render：ZCode 格式 + marker；--model 覆盖
    lines = []
    expect(await runCommand(ctx, ['role', 'render', 'dev-1', '--model', 'custom:x'])).toBe(0)
    const rendered = lines.join('\n')
    expect(rendered).toContain('name: dev-1')
    expect(rendered).toContain('model: "custom:x"')
    expect(rendered).toContain('thoughtLevel: max')
    expect(rendered).toContain('generated by prism (role: dev-1)')

    // skill install（默认全量 → prism）
    lines = []
    expect(await runCommand(ctx, ['skill', 'install', '--harness-root', harnessRoot])).toBe(0)
    expect(existsSync(join(harnessRoot, 'skills', 'prism', 'SKILL.md'))).toBe(true)

    // skill list
    lines = []
    expect(await runCommand(ctx, ['skill', 'list', '--json'])).toBe(0)
    const skills = JSON.parse(lines[lines.length - 1]) as { value: Array<{ name: string }> }
    expect(skills.value.map((s) => s.name)).toContain('prism')
  })

  it('team list/validate/activate（使用者自建团队 + 手写角色）', async () => {
    // init 只建骨架、**不代建团队**；受管位置由 <home>/prism.yaml 指定（roles_dir/teams_dir → <home>）
    expect(await runCommand(ctx, ['init', '--harness-root', harnessRoot, '--json'])).toBe(0)
    lines = []
    expect(await runCommand(ctx, ['team', 'list', '--json'])).toBe(0)
    expect((JSON.parse(lines[lines.length - 1]) as { value: unknown[] }).value).toEqual([])

    // 使用者自建团队：写进受管 teams_dir
    const teamsDir = join(home, 'teams')
    await mkdir(join(teamsDir, 'core-dev'), { recursive: true })
    await writeFile(
      join(teamsDir, 'core-dev', 'AGENTS.md'),
      fillTeamTemplate(CORE_DEV_TEAM_MD, {
        teamId: 'core-dev',
        name: '核心研发团队',
        description: '使用者自建（测试用）。',
      }),
      'utf-8',
    )

    // 成员角色直接手写进 roles_dir（无导入步骤）
    await mkdir(join(home, 'roles'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1.md'), ZCODE_ROLE_A, 'utf-8')
    await writeFile(join(home, 'roles', 'tester.md'), ZCODE_ROLE_B, 'utf-8')

    // list：core-dev 在库；成员角色 dev-2/super-dev 等缺失 → issues 带 error（agents 校验码 member_role_unknown）
    lines = []
    expect(await runCommand(ctx, ['team', 'list', '--json'])).toBe(0)
    const teams = JSON.parse(lines[lines.length - 1]) as { value: Array<{ team_id: string; issues: Array<{ code: string }> }> }
    expect(teams.value.map((t) => t.team_id)).toContain('core-dev')
    expect(teams.value[0].issues.some((i) => i.code === 'member_role_unknown')).toBe(true)

    // validate：模板引用 5 个成员角色，本 fixture 只导入 2 个 → rc 1
    lines = []
    expect(await runCommand(ctx, ['team', 'validate', 'core-dev'])).toBe(1)
    expect(lines.join('\n')).toContain('member_role_unknown')

    // 单成员团队（手工写一份）→ validate 通过
    const single = join(teamsDir, 'mini', 'AGENTS.md')
    await mkdir(join(teamsDir, 'mini'), { recursive: true })
    await writeFile(
      single,
      `---
team_id: mini
name: 迷你团队
description: 单成员冒烟团队。
default: false
members:
  - role: dev-1
    count: 1
skills: []
knowledge:
  layers: [global]
deposit:
  enabled: false
  default_layer: project
  default_type: pitfall
  priority: low
  require_note: false
arbitration: [quality]
rework_limit: 1
---

# 迷你团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 开发 | dev-1 | 串行 | 任务书 | patch | 自验通过 | 卡死 → 队长 |
`,
      'utf-8',
    )
    lines = []
    expect(await runCommand(ctx, ['team', 'validate', 'mini'])).toBe(0)

    // activate：角色已住在 roles_dir → native
    lines = []
    expect(await runCommand(ctx, ['team', 'activate', 'mini', '--harness-root', harnessRoot, '--json'])).toBe(0)
    const activation = JSON.parse(lines[lines.length - 1]) as {
      value: { team_id: string; members: Array<{ dispatch: string }> }
    }
    expect(activation.value.team_id).toBe('mini')
    expect(activation.value.members[0].dispatch).toBe('native')

    // activate：清掉 roles_dir 中的角色 → fallback + definition + hint
    await rm(join(home, 'roles', 'dev-1.md'), { force: true })
    lines = []
    expect(await runCommand(ctx, ['team', 'activate', 'mini', '--harness-root', harnessRoot, '--json'])).toBe(0)
    const fallback = JSON.parse(lines[lines.length - 1]) as {
      value: { members: Array<{ dispatch: string; definition?: { name: string }; hint?: string }> }
    }
    expect(fallback.value.members[0].dispatch).toBe('fallback')
    expect(fallback.value.members[0].definition).toBeUndefined()
    expect(fallback.value.members[0].hint).toContain('不存在')
  })

  it('未知子命令/缺参数 → rc 1 + 用法', async () => {
    lines = []
    expect(await runCommand(ctx, ['role', 'nope'])).toBe(1)
    expect(lines.join('\n')).toContain('未知子命令: role nope')

    lines = []
    expect(await runCommand(ctx, ['role', 'show'])).toBe(1)
    expect(lines.join('\n')).toContain('用法: prism role show')

    lines = []
    expect(await runCommand(ctx, ['skill', 'install', 'ghost', '--harness-root', harnessRoot])).toBe(1)
    expect(lines.join('\n')).toContain('未知内置 Skill: ghost')
  })
})
