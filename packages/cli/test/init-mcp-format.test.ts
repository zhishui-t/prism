/**
 * `prism init` 的 MCP 注册**形态分派**（F-接入：WorkBuddy）。
 *
 * 早期实现把 ZCode 的嵌套形态（`{ mcp: { servers: {} } }`）写死在 registerMcp 里；
 * 接入用平铺形态的宿主（WorkBuddy / VS Code：`{ mcpServers: {} }`）时会**静默写错层级**
 * ——宿主读不到，还往人家配置里塞了无意义的 `mcp` 键。
 *
 * 本文件锁两件事：
 *   1. 默认宿主（zcode）仍写嵌套形态，且**幂等**、**不碰同文件其它键**；
 *   2. 声明 `format: 'mcpServers-json'` 的插件宿主 → 写平铺形态到其 `configFile`。
 *
 * 第 2 条用的是仓库里真实交付的插件 `examples/harnesses/workbuddy/`（而非测试内联的假插件），
 * 这样插件本身也被门禁覆盖。
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetHarnessPlugins } from '@prism/agents'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

const WORKBUDDY_PLUGIN_SRC = fileURLToPath(new URL('../../../examples/harnesses/workbuddy', import.meta.url))

interface Harness {
  home: string
  root: string
  lines: string[]
  ctx: CommandContext
}

describe('prism init：MCP 注册形态分派', () => {
  const cleanup: string[] = []
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['PRISM_HARNESS', 'PRISM_HARNESS_ROOT', 'PRISM_HARNESS_DIR', 'PRISM_NO_HARNESS_PLUGINS']) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    resetHarnessPlugins()
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetHarnessPlugins()
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  async function makeHarness(): Promise<Harness> {
    const home = await mkdtemp(join(tmpdir(), 'prism-initmcp-home-'))
    const root = await mkdtemp(join(tmpdir(), 'prism-initmcp-root-'))
    cleanup.push(home, root)
    const lines: string[] = []
    const ctx: CommandContext = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home,
    }
    return { home, root, lines, ctx }
  }

  /** 把真实交付的 workbuddy 插件装进宿主的插件目录（模拟部署后的 PRISM_HOME）。 */
  async function installPlugin(home: string): Promise<void> {
    await mkdir(join(home, 'harnesses'), { recursive: true })
    await cp(WORKBUDDY_PLUGIN_SRC, join(home, 'harnesses', 'workbuddy'), { recursive: true })
  }

  async function readJson(path: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
  }

  it('默认宿主（zcode）：写嵌套 mcp.servers，且幂等', async () => {
    const { home, root, ctx } = await makeHarness()
    const first = await runCommand(ctx, ['init', '--home', home, '--harness-root', root, '--json'])
    expect(first).toBe(0)

    const configPath = join(root, 'cli', 'config.json')
    const cfg = await readJson(configPath)
    const mcp = cfg['mcp'] as Record<string, unknown>
    const servers = mcp['servers'] as Record<string, unknown>
    expect(servers['prism']).toEqual({
      type: 'stdio',
      command: 'node',
      args: [expect.stringContaining('mcp')],
      env: { PRISM_HOME: home },
      timeoutMs: 60_000,
    })
    // 平铺形态的键**不得**出现
    expect(cfg['mcpServers']).toBeUndefined()

    // 幂等：第二次运行报告 unchanged
    const lines: string[] = []
    const ctx2: CommandContext = { ...ctx, stdout: (l) => lines.push(l) }
    expect(await runCommand(ctx2, ['init', '--home', home, '--harness-root', root])).toBe(0)
    expect(lines.join('\n')).toContain('MCP 注册未变化')
  })

  it('插件宿主（workbuddy）：写平铺 mcpServers 到 <root>/mcp.json，且不产生 mcp 键', async () => {
    const { home, root, ctx } = await makeHarness()
    await installPlugin(home)
    process.env['PRISM_HARNESS'] = 'workbuddy'

    const code = await runCommand(ctx, ['init', '--home', home, '--harness-root', root, '--json'])
    expect(code).toBe(0)

    const configPath = join(root, 'mcp.json')
    const cfg = await readJson(configPath)
    const servers = cfg['mcpServers'] as Record<string, unknown>
    expect(servers).toBeDefined()
    expect(servers['prism']).toEqual({
      command: 'node',
      args: [expect.stringContaining('mcp')],
      env: { PRISM_HOME: home },
    })
    // ZCode 形态不应出现
    expect(cfg['mcp']).toBeUndefined()
    // 平铺形态条目不带 type/timeoutMs（写未知键部分宿主会判配置非法）
    expect(servers['prism']).not.toHaveProperty('type')
    expect(servers['prism']).not.toHaveProperty('timeoutMs')
    // Skill 装到了 workbuddy 的 skills 目录（~/.workbuddy/skills 的真实约定）
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, 'skills'))).toBe(true)
  })

  it('平铺形态：合并写入，保留同文件既有键与既有 server', async () => {
    const { home, root, ctx } = await makeHarness()
    await installPlugin(home)
    process.env['PRISM_HARNESS'] = 'workbuddy'

    const configPath = join(root, 'mcp.json')
    await writeFile(
      configPath,
      `${JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'npx', args: ['x'] } } }, null, 2)}\n`,
      'utf-8',
    )

    const code = await runCommand(ctx, ['init', '--home', home, '--harness-root', root, '--json'])
    expect(code).toBe(0)

    const cfg = await readJson(configPath)
    const servers = cfg['mcpServers'] as Record<string, unknown>
    expect(cfg['theme']).toBe('dark')
    expect(servers['other']).toEqual({ command: 'npx', args: ['x'] })
    expect(servers['prism']).toBeDefined()
    // 改过既有文件 → 必须留备份
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(root)
    expect(files.some((f) => f.startsWith('mcp.json.bak-prism-init-'))).toBe(true)
  })

  it('幂等：同一形态重复 init → unchanged（不重复写、不再备份）', async () => {
    const { home, root, ctx } = await makeHarness()
    await installPlugin(home)
    process.env['PRISM_HARNESS'] = 'workbuddy'

    const lines1: string[] = []
    const ctx1: CommandContext = { ...ctx, stdout: (l) => lines1.push(l) }
    expect(await runCommand(ctx1, ['init', '--home', home, '--harness-root', root])).toBe(0)

    const lines2: string[] = []
    const ctx2: CommandContext = { ...ctx, stdout: (l) => lines2.push(l) }
    expect(await runCommand(ctx2, ['init', '--home', home, '--harness-root', root])).toBe(0)
    expect(lines2.join('\n')).toContain('MCP 注册未变化')
    expect(lines2.join('\n')).not.toContain('备份')
  })

  it('prism.yaml 的 harness 键同样生效（回归：harnessPaths 曾只认 env，会静默回落到 zcode）', async () => {
    const { home, root, ctx } = await makeHarness()
    await installPlugin(home)
    // 关键：**不设** PRISM_HARNESS，只靠 <PRISM_HOME>/prism.yaml 声明
    await writeFile(join(home, 'prism.yaml'), 'harness: workbuddy\n', 'utf-8')

    expect(await runCommand(ctx, ['init', '--home', home, '--harness-root', root, '--json'])).toBe(0)

    const cfg = await readJson(join(root, 'mcp.json'))
    expect((cfg['mcpServers'] as Record<string, unknown>)['prism']).toBeDefined()
    // 若回落成 zcode，这里会写到 cli/config.json 且出现 mcp 键
    expect(cfg['mcp']).toBeUndefined()
  })

  it('prism harness list 能看到插件适配器（external）', async () => {
    const { home, ctx } = await makeHarness()
    await installPlugin(home)

    const lines: string[] = []
    const ctxJson: CommandContext = { ...ctx, json: true, stdout: (l) => lines.push(l) }
    const code = await runCommand(ctxJson, ['harness', 'list', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(lines.join('\n')) as { value?: { adapters?: Array<{ id: string; origin: string }> } }
    const list = parsed.value?.adapters ?? []
    expect(list.map((h) => h.id)).toContain('workbuddy')
    expect(list.find((h) => h.id === 'workbuddy')?.origin).toBe('external')
  })
})
