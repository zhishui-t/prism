/**
 * F-C3（CLI 侧）：`prism team activate <id> [--project <名>|--build-project <名>]`。
 *
 * 守 R1「不抢调度」：**缺省既不看图谱状态、也绝不建图**；只有显式参数才动。
 * 服务端同款行为在 `packages/server/test/team-activate-graph-status.test.ts`。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CORE_DEV_TEAM_MD, fillTeamTemplate } from '@prism/agents'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

const dirs: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

interface Fixture {
  home: string
  harnessRoot: string
  projectRoot: string
  ctx: CommandContext
  lines: string[]
  errors: string[]
}

/** 造 home（含注册表）+ harnessRoot（含团队）+ 一个已建图的项目根。 */
async function setup(): Promise<Fixture> {
  const home = await tempDir('prism-cli-activate-home-')
  const harnessRoot = await tempDir('prism-cli-activate-harness-')
  const projectRoot = await tempDir('prism-cli-activate-proj-')

  const teamsDir = join(harnessRoot, 'teams')
  await mkdir(teamsDir, { recursive: true })
  await writeFile(
    join(teamsDir, 'core-dev.md'),
    fillTeamTemplate(CORE_DEV_TEAM_MD, { teamId: 'core-dev', name: '核心研发团队', description: '测试用' }),
    'utf-8',
  )

  await mkdir(join(projectRoot, 'graphify-out'), { recursive: true })
  await writeFile(join(projectRoot, 'graphify-out', 'graph.json'), '{"nodes":[]}\n', 'utf-8')
  await mkdir(join(home, 'graph'), { recursive: true })
  await writeFile(
    join(home, 'graph', 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: { demo: { root: projectRoot, built_at: '2026-09-11T00:00:00.000Z' } },
    }),
    'utf-8',
  )

  const lines: string[] = []
  const errors: string[] = []
  const ctx: CommandContext = {
    ...defaultContext({ home }),
    stdout: (line) => lines.push(line),
    stderr: (line) => errors.push(line),
    // 假建图执行体：不碰真实 graphify（CLI 侧只验证「触发了建图」这条编排职责）
    buildRunner: async () => undefined,
  }
  return { home, harnessRoot, projectRoot, ctx, lines, errors }
}

describe('prism team activate 的图谱状态（F-C3）', () => {
  it('缺省：不指定项目 → 打印「未指定项目」，且不建图', async () => {
    const { harnessRoot, ctx, lines } = await setup()
    const code = await runCommand(ctx, ['team', 'activate', 'core-dev', '--harness-root', harnessRoot])
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('图谱: 未指定项目')
    expect(out).toContain('缺省不动手')
  })

  it('--project <名>：打印只读状态（可用/已陈旧 + 变更计数）', async () => {
    const { harnessRoot, ctx, lines } = await setup()
    const code = await runCommand(ctx, [
      'team',
      'activate',
      'core-dev',
      '--harness-root',
      harnessRoot,
      '--project',
      'demo',
    ])
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).toContain('图谱（demo）: 可用')
    expect(out).toContain('build 于 2026-09-11T00:00:00.000Z')
  })

  it('--project 指向未注册项目 → 退出码 1', async () => {
    const { harnessRoot, ctx, errors } = await setup()
    const code = await runCommand(ctx, [
      'team',
      'activate',
      'core-dev',
      '--harness-root',
      harnessRoot,
      '--project',
      'nope',
    ])
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('未注册的图谱项目')
  })

  it('--build-project <名>：显式建图后打印状态（runner 被调用）', async () => {
    const { harnessRoot, projectRoot, ctx, lines, errors } = await setup()
    const code = await runCommand(ctx, [
      'team',
      'activate',
      'core-dev',
      '--harness-root',
      harnessRoot,
      '--build-project',
      'demo',
    ])
    expect(code, `stderr: ${errors.join(' | ')}`).toBe(0)
    expect(lines.join('\n')).toContain('建图完成: demo')
    expect(lines.join('\n')).toContain('图谱（demo）')
    // 建图后注册表 built_at 被刷新（不再是种子值）
    const registry = JSON.parse(await readFile(join(ctx.home, 'graph', 'projects.json'), 'utf-8')) as {
      projects: Record<string, { built_at: string }>
    }
    expect(registry.projects.demo.built_at).not.toBe('2026-09-11T00:00:00.000Z')
    expect(projectRoot).toContain('prism-cli-activate-proj-')
  })

  it('--project 与 --build-project 互斥 → 退出码 1', async () => {
    const { harnessRoot, ctx, errors } = await setup()
    const code = await runCommand(ctx, [
      'team',
      'activate',
      'core-dev',
      '--harness-root',
      harnessRoot,
      '--project',
      'demo',
      '--build-project',
      'demo',
    ])
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('互斥')
  })

  it('--json：响应体带 graph_status（字段恒存在，未指定项目时为 null）', async () => {
    const { harnessRoot, ctx, lines } = await setup()
    expect(
      await runCommand(ctx, ['team', 'activate', 'core-dev', '--harness-root', harnessRoot, '--json']),
    ).toBe(0)
    const payload = JSON.parse(lines.join('\n')) as { ok: boolean; value: { graph_status: unknown } }
    expect(payload.ok).toBe(true)
    expect(payload.value.graph_status).toBeNull()

    lines.length = 0
    expect(
      await runCommand(ctx, [
        'team',
        'activate',
        'core-dev',
        '--harness-root',
        harnessRoot,
        '--project',
        'demo',
        '--json',
      ]),
    ).toBe(0)
    const withProject = JSON.parse(lines.join('\n')) as {
      value: { graph_status: { project: string; graph_exists: boolean } }
    }
    expect(withProject.value.graph_status.project).toBe('demo')
    expect(withProject.value.graph_status.graph_exists).toBe(true)
  })
})
