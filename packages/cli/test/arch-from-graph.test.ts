/**
 * v9 F1：`prism arch from-graph` 的**缺省落点**改为项目目录
 * `<projectRoot>/.prism/arch/<type>/`（与 MCP `prism_arch_generate`、HTTP `POST /api/arch/render`
 * 同口径）；`--out` 完全接管；未注册项目拒绝。
 *
 * 这里跑的是**真实 archify 渲染**（与 `packages/server/test/arch-from-graph.test.ts` 同门禁），
 * 全部写临时目录（`--home` + 临时项目根），绝不碰真实 ~/.prism（R5/R6）。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectRegistry } from '@prism/server'

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

/** 3 个目录角色 + 跨文件 calls 边（architecture 生成器的最小可用输入）。 */
const GRAPH = {
  nodes: [
    { id: 'cli', label: 'entry', source_file: 'proj/src/cli/entry.ts', community: 0 },
    { id: 'api', label: 'routes', source_file: 'proj/src/api/routes.ts', community: 1 },
    { id: 'store', label: 'db', source_file: 'proj/src/store/db.ts', community: 2 },
  ],
  links: [
    { source: 'cli', target: 'api', relation: 'calls' },
    { source: 'api', target: 'store', relation: 'calls' },
  ],
}

async function setup(): Promise<{
  home: string
  root: string
  ctx: CommandContext
  lines: string[]
  errors: string[]
}> {
  const home = await tempDir('prism-cli-arch-graph-home-')
  const root = await tempDir('prism-cli-arch-graph-proj-')
  await mkdir(join(root, 'graphify-out'), { recursive: true })
  await writeFile(join(root, 'graphify-out', 'graph.json'), JSON.stringify(GRAPH), 'utf-8')
  await new ProjectRegistry(home).register('demo', root)

  const lines: string[] = []
  const errors: string[] = []
  const ctx: CommandContext = {
    ...defaultContext({
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line),
    }),
    home,
  }
  return { home, root, ctx, lines, errors }
}

describe('prism arch from-graph（v9 F1 落点）', () => {
  it('缺省落 <projectRoot>/.prism/arch/<type>/，三件套齐备', async () => {
    const { root, ctx, lines } = await setup()
    const code = await runCommand(ctx, ['arch', 'from-graph', 'architecture', 'demo'])

    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('已由代码图谱生成架构图')
    const dir = join(root, '.prism', 'arch', 'architecture')
    expect(existsSync(join(dir, 'demo.html'))).toBe(true)
    expect(existsSync(join(dir, 'demo.ir.json'))).toBe(true)
    expect(existsSync(join(dir, 'demo.meta.json'))).toBe(true)
  }, 120_000)

  it('--json 回显 source=project 与产物路径', async () => {
    const { root, ctx, lines } = await setup()
    const code = await runCommand(ctx, ['arch', 'from-graph', 'architecture', 'demo', '--json'])

    expect(code).toBe(0)
    const payload = JSON.parse(lines.join('\n')) as {
      ok: boolean
      value: { type: string; project: string; html: string; source: string }
    }
    expect(payload.ok).toBe(true)
    expect(payload.value.source).toBe('project')
    expect(payload.value.project).toBe('demo')
    expect(payload.value.html.startsWith(join(root, '.prism', 'arch', 'architecture'))).toBe(true)
  }, 120_000)

  it('--out 完全接管：不落项目目录', async () => {
    const { root, ctx } = await setup()
    const out = join(root, 'explicit', 'out.html')
    const code = await runCommand(ctx, ['arch', 'from-graph', 'architecture', 'demo', '--out', out])

    expect(code).toBe(0)
    expect(existsSync(out)).toBe(true)
    expect(existsSync(join(root, '.prism', 'arch', 'architecture', 'demo.html'))).toBe(false)
  }, 120_000)

  it('未注册项目 → 退出码 1 + not_found（绝不接受任意路径）', async () => {
    const { ctx, errors } = await setup()
    const code = await runCommand(ctx, ['arch', 'from-graph', 'architecture', 'ghost'])
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('未注册的项目')
  })

  it('已注册但 root 被删 → project_root_missing，且不复活目录（v9.1 B-1）', async () => {
    const { home, root, ctx, errors } = await setup()
    await rm(root, { recursive: true, force: true })
    const code = await runCommand(ctx, ['arch', 'from-graph', 'architecture', 'demo'])

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('project_root_missing')
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(root, '.prism'))).toBe(false)
    // 注册表本身未被写坏（root 仍在册，只是目录没了）
    const listed = await new ProjectRegistry(home).list()
    expect(listed.map((p) => p.project)).toContain('demo')
  })

  it('sidecar 里的 ir_hash 与 IR 一致（产物可溯源）', async () => {
    const { root, ctx } = await setup()
    expect(await runCommand(ctx, ['arch', 'from-graph', 'dataflow', 'demo'])).toBe(0)
    const dir = join(root, '.prism', 'arch', 'dataflow')
    const meta = JSON.parse(await readFile(join(dir, 'demo.meta.json'), 'utf-8')) as {
      ir_hash: string
      ir_file: string
      archify_version: string
    }
    expect(meta.ir_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(meta.ir_file).toBe('demo.ir.json')
    expect(meta.archify_version).toBe('2.16.0')
  }, 120_000)
})
