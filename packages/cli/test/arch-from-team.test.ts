/**
 * F-C4：`prism arch from-team <team_id>`（团队工作流 → 工作流图）。
 *
 * 只测 CLI 的编排职责：读团队 → 生成 IR → 调 archify 渲染 → 落 IR 源 + sidecar。
 * IR 本身的性质（确定/slug 化/col 范围）在 `packages/agents/test/workflow-ir.test.ts`；
 * 真实渲染器门禁在 `packages/server/test/arch-from-team.test.ts`。
 */
import { existsSync } from 'node:fs'
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

/** 造一个 hosts 根（含 teams/core-dev.md）+ 收集 stdout/stderr 的 ctx。 */
async function setup(): Promise<{
  harnessRoot: string
  outDir: string
  ctx: CommandContext
  lines: string[]
  errors: string[]
}> {
  const harnessRoot = await tempDir('prism-cli-arch-team-')
  const teamsDir = join(harnessRoot, 'teams')
  await mkdir(teamsDir, { recursive: true })
  await writeFile(
    join(teamsDir, 'core-dev.md'),
    fillTeamTemplate(CORE_DEV_TEAM_MD, { teamId: 'core-dev', name: '核心研发团队', description: '测试用' }),
    'utf-8',
  )
  const outDir = join(harnessRoot, 'out')
  await mkdir(outDir, { recursive: true })

  const lines: string[] = []
  const errors: string[] = []
  const ctx = {
    ...defaultContext(),
    stdout: (line: string) => lines.push(line),
    stderr: (line: string) => errors.push(line),
  }
  return { harnessRoot, outDir, ctx, lines, errors }
}

describe('prism arch from-team（F-C4）', () => {
  it('由团队生成工作流图：HTML + IR 源 + meta 齐备，退出码 0', async () => {
    const { harnessRoot, outDir, ctx, lines } = await setup()
    const out = join(outDir, 'core-dev.html')

    const code = await runCommand(ctx, [
      'arch',
      'from-team',
      'core-dev',
      '--harness-root',
      harnessRoot,
      '--out',
      out,
    ])

    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('已由团队 core-dev 生成工作流图')
    expect(existsSync(out)).toBe(true)
    expect(existsSync(join(outDir, 'core-dev.ir.json'))).toBe(true)
    expect(existsSync(join(outDir, 'core-dev.meta.json'))).toBe(true)
  }, 120_000)

  it('重复执行产物逐字节一致（IR 无时钟字段）', async () => {
    const { harnessRoot, outDir, ctx } = await setup()
    const out = join(outDir, 'core-dev.html')
    const args = ['arch', 'from-team', 'core-dev', '--harness-root', harnessRoot, '--out', out]

    expect(await runCommand(ctx, args)).toBe(0)
    const firstIr = await readFile(join(outDir, 'core-dev.ir.json'), 'utf-8')
    expect(await runCommand(ctx, args)).toBe(0)
    const secondIr = await readFile(join(outDir, 'core-dev.ir.json'), 'utf-8')

    expect(secondIr).toBe(firstIr)
    expect(firstIr).not.toMatch(/created_at|updated_at|"\d{4}-\d{2}-\d{2}T/)
  }, 120_000)

  it('--json 输出机器可读结果（type=workflow + 团队 ID）', async () => {
    const { harnessRoot, outDir, ctx, lines } = await setup()
    const out = join(outDir, 'json.html')

    const code = await runCommand(ctx, [
      'arch',
      'from-team',
      'core-dev',
      '--harness-root',
      harnessRoot,
      '--out',
      out,
      '--json',
    ])

    expect(code).toBe(0)
    const payload = JSON.parse(lines.join('\n')) as {
      ok: boolean
      value: { type: string; team_id: string; html: string }
    }
    expect(payload.ok).toBe(true)
    expect(payload.value.type).toBe('workflow')
    expect(payload.value.team_id).toBe('core-dev')
  }, 120_000)

  it('团队不存在 → 退出码 1 + 可读错误', async () => {
    const { harnessRoot, outDir, ctx, errors } = await setup()
    const code = await runCommand(ctx, [
      'arch',
      'from-team',
      'no-such-team',
      '--harness-root',
      harnessRoot,
      '--out',
      join(outDir, 'x.html'),
    ])
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('团队不存在')
  })

  it('缺团队 ID → 退出码 1（用法提示）', async () => {
    const { harnessRoot, ctx, errors } = await setup()
    const code = await runCommand(ctx, ['arch', 'from-team', '--harness-root', harnessRoot])
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('缺少团队 ID')
  })
})
