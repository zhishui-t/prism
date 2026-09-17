/**
 * `prism init` 的 MCP 注册**冲突判定**：归一化投影比较（v10 F7）。
 *
 * 旧实现用 `JSON.stringify(existing) === JSON.stringify(entry)` 判「未变化」，对**等价写法**
 * 一律误报 conflict：键序、`node` vs `node.exe`、`\` vs `/`、缺省 `timeoutMs` vs `60000`，
 * 以及宿主自己往条目里加的键（`disabled` 之类）。误报的后果是**重跑 init 时用户被要求 --force**，
 * 而 --force 又会（旧实现）整条替换、把宿主写的键静默抹掉。
 *
 * 现在的口径（本文件逐个锁定）：
 *   - 只比 Prism 管的字段：`type`（仅 ZCode 形态，缺省即 stdio）、`command`（可执行体形态归一）、
 *     `args`（逐项、分隔符归一）、`env`（键序无关 + 值分隔符归一）、`timeoutMs`（仅 ZCode 形态，
 *     缺省补齐 60_000，`"60000"` 与 `60000` 归一）；
 *   - 归一化后等价 → `unchanged`：不报 conflict、不覆盖、不备份；
 *   - 真差异 → `conflict` 且不覆盖，除非 `--force`；
 *   - `--force` 覆盖时**保留既有未知键**（含 env 里用户自己加的变量），不静默丢弃。
 *
 * 既有条目一律由首次 init 写出的真实条目**派生**——`args` 里的 MCP 入口路径由
 * `resolveMcpEntry()` 决定（跑测机器相关），手写字面量会随环境漂移。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

interface Harness {
  home: string
  root: string
  lines: string[]
  ctx: CommandContext
}

/**
 * 把路径换成「另一种分隔符写法」——两个方向都有实质文本差异（Windows 的 `\`→`/`，
 * POSIX 的 `/`→`\`），避免在某一平台上退化成空操作。
 */
function flipSeparators(path: string): string {
  return path.includes('\\') ? path.replace(/\\/g, '/') : path.replace(/\//g, '\\')
}

describe('prism init：MCP 冲突判定 = 归一化投影比较', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  async function makeHarness(): Promise<Harness> {
    const home = await mkdtemp(join(tmpdir(), 'prism-initcmp-home-'))
    const root = await mkdtemp(join(tmpdir(), 'prism-initcmp-root-'))
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

  const configPath = (h: Harness): string => join(h.root, 'cli', 'config.json')

  async function readPrismEntry(h: Harness): Promise<Record<string, unknown>> {
    const cfg = JSON.parse(await readFile(configPath(h), 'utf-8')) as Record<string, unknown>
    const mcp = cfg['mcp'] as Record<string, unknown>
    return (mcp['servers'] as Record<string, unknown>)['prism'] as Record<string, unknown>
  }

  /** 覆写既有配置（对象字面量的键序即落盘 JSON 的键序，用于测键序无关）。 */
  async function writePrismEntry(h: Harness, entry: unknown): Promise<void> {
    await writeFile(configPath(h), `${JSON.stringify({ mcp: { servers: { prism: entry } } }, null, 2)}\n`, 'utf-8')
  }

  /**
   * 跑一次 init（`--harness-root` 指临时目录：既隔离真实宿主，也免掉 --yes）。
   *
   * `--skip-cli`：跳过 F5 的 CLI 全局注册——本文件只关心 MCP 注册冲突判定，
   * CLI 全局注册会真实触碰本机 npm prefix / 全局 bin 目录（SPEC-5.6 红线）。
   * 全部 12 个调用点都经这个 wrapper，故隔离点只有这一处。
   */
  async function runInit(h: Harness, extra: string[] = []): Promise<number> {
    h.lines.length = 0
    return runCommand(h.ctx, ['init', '--home', h.home, '--harness-root', h.root, '--skip-cli', ...extra])
  }

  /** 首次 init 写出真实条目，作为「派生变体」的基线。 */
  async function baseline(h: Harness): Promise<Record<string, unknown>> {
    expect(await runInit(h)).toBe(0)
    return readPrismEntry(h)
  }

  async function backups(h: Harness): Promise<string[]> {
    return (await readdir(join(h.root, 'cli'))).filter((f) => f.includes('.bak-prism-init-'))
  }

  it('既有条目键序打乱 → unchanged（不报 conflict、不覆盖、不备份）', async () => {
    const h = await makeHarness()
    const base = await baseline(h)
    // 键序与 Prism 写出的完全相反
    await writePrismEntry(h, {
      timeoutMs: base['timeoutMs'],
      env: base['env'],
      args: base['args'],
      command: base['command'],
      type: base['type'],
    })
    const before = await readFile(configPath(h), 'utf-8')

    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册未变化')
    expect(await readFile(configPath(h), 'utf-8')).toBe(before)
    expect(await backups(h)).toEqual([])
  })

  it('args 路径分隔符形态不同 → unchanged', async () => {
    const h = await makeHarness()
    const base = await baseline(h)
    const args = (base['args'] as string[]).map(flipSeparators)
    expect(args).not.toEqual(base['args']) // 确认变体确有差异（否则用例是空断言）
    await writePrismEntry(h, { ...base, args })

    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册未变化')
  })

  it('env 键序打乱 + 值分隔符形态不同 → unchanged', async () => {
    const h = await makeHarness()
    const base = await baseline(h)
    const env = base['env'] as Record<string, unknown>
    const prismHome = String(env['PRISM_HOME'])
    // 键序：把 PRISM_HOME 放最后；值：换一种分隔符写法
    await writePrismEntry(h, { ...base, env: { HOST_ADDED: 'x', PRISM_HOME: flipSeparators(prismHome) } })

    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册未变化')
  })

  it('command `node` 与 `node.exe` 视为同一可执行体 → unchanged', async () => {
    const h = await makeHarness()
    const base = await baseline(h)
    expect(base['command']).toBe('node')
    await writePrismEntry(h, { ...base, command: 'node.exe' })

    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册未变化')
  })

  it('timeoutMs 缺省 vs 60_000 vs 字符串 "60000" → 均 unchanged', async () => {
    const h = await makeHarness()
    const base = await baseline(h)
    const withoutTimeout: Record<string, unknown> = { ...base }
    delete withoutTimeout['timeoutMs']

    // ① 缺省（宿主/手工配置常不写这个键）
    await writePrismEntry(h, withoutTimeout)
    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册未变化')

    // ② 字符串 "60000"
    await writePrismEntry(h, { ...base, timeoutMs: '60000' })
    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册未变化')
  })

  it('指向不同 args / command → conflict 且不覆盖', async () => {
    const h = await makeHarness()
    const base = await baseline(h)

    await writePrismEntry(h, { ...base, args: ['/elsewhere/server.js'] })
    const beforeArgs = await readFile(configPath(h), 'utf-8')
    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册冲突')
    expect(await readFile(configPath(h), 'utf-8')).toBe(beforeArgs)
    expect(await backups(h)).toEqual([])

    await writePrismEntry(h, { ...base, command: 'bun' })
    const beforeCmd = await readFile(configPath(h), 'utf-8')
    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册冲突')
    expect(await readFile(configPath(h), 'utf-8')).toBe(beforeCmd)
  })

  it('既有条目带未知键（disabled）+ 内容等价 → unchanged', async () => {
    const h = await makeHarness()
    const base = await baseline(h)
    await writePrismEntry(h, { ...base, disabled: true })

    expect(await runInit(h)).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册未变化')
    // 未知键没被顺手删掉（未变化路径压根不写盘）
    expect((await readPrismEntry(h))['disabled']).toBe(true)
  })

  it('--force 覆盖写回：未知键与用户加的 env 变量仍在', async () => {
    const h = await makeHarness()
    const base = await baseline(h)
    await writePrismEntry(h, {
      ...base,
      args: ['/stale/server.js'],
      disabled: true,
      env: { PRISM_HOME: base['env'] && (base['env'] as Record<string, unknown>)['PRISM_HOME'], NODE_OPTIONS: '--max-old-space-size=4096' },
    })

    expect(await runInit(h, ['--force'])).toBe(0)
    expect(h.lines.join('\n')).toContain('MCP 注册已按 --force 覆盖')

    const after = await readPrismEntry(h)
    expect(after['args']).toEqual(base['args']) // Prism 管的字段被覆盖成新值
    expect(after['disabled']).toBe(true) // 宿主写的键保留
    expect((after['env'] as Record<string, unknown>)['NODE_OPTIONS']).toBe('--max-old-space-size=4096')
    expect((after['env'] as Record<string, unknown>)['PRISM_HOME']).toBe((base['env'] as Record<string, unknown>)['PRISM_HOME'])
  })
})
