/**
 * SPEC-3.1–3.4：background 进程退出日志（design-v15 §3 / R-3）。
 *
 * 前提勘误（S-5）：v14 实录**不是**「零日志」——默认链路的 stderr 已被 parent 重定向到
 * `<home>/state/serve-<port>.log`（serve-control.ts）。真缺口 = **退出码 + 时间戳**，
 * 以及覆盖非默认 spawn 链路。本文件锁的就是这条新记录。
 *
 * 两层验证：
 * - **单元层**：import 本模块取纯函数（入口守卫保证 import 不会真起服务）；
 * - **子进程层**：真跑 `dist/background.js`（与 `ensureServe` 的生产链路同解），
 *   外加一个「临时脚本」在真进程里验证 `exit` 钩子确实**同步**落盘、stderr 尾被 4KB 截断。
 *
 * ⚠ 平台边界：Windows 无法向子进程投递**可捕获**信号（`process.kill` = TerminateProcess），
 * 故 SPEC-3.2 的「正常退出」用临时脚本 `process.emit('SIGINT')` 走等价路径；
 * 真信号的投递属 POSIX 能力，是本特性的**残余限制**（见实现文件末尾声明）。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  EXIT_LOG_MAX_BYTES,
  EXIT_LOG_TRUNCATION_MARK,
  appendExitLog,
  backgroundExitLogPath,
  formatExitEntry,
  keepTailBytes,
  truncateExitLog,
} from '../src/background.js'

/** `packages/server/`（本文件在 `packages/server/test/`）。 */
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 真跑的后台入口（门禁第 2 步 `pnpm --filter @prism/server build` 会产出它）。 */
const ENTRY = join(PKG_ROOT, 'dist', 'background.js')

// ⚠ 临时目录**不要**用 `prism-` 前缀：vitest 的 tmp 回收器会把 tmpdir 下的 `prism-*` 一并清掉。
const cleanup: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

/** 当前空闲端口（listen(0) 再关掉）。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

/** 占住端口，制造 EADDRINUSE（异常退出的可控触发器）。 */
async function occupyPort(port: number): Promise<{ close: () => Promise<void> }> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

interface RunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

/** 跑一个 node 子进程到结束（输出走管道收齐）。 */
function runNode(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(process.execPath, args, {
      env: { ...process.env, PRISM_EMBEDDING: 'off', PRISM_RERANK: 'off', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', () => resolve({ code: null, signal: null, stdout, stderr }))
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

/** 真跑后台入口：`--home` / `--harness-root` 全部指向临时目录（R5 零宿主污染）。 */
async function runBackground(
  home: string,
  harnessRoot: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return await runNode([ENTRY, '--harness-root', harnessRoot, ...args], { PRISM_HOME: home, ...extraEnv })
}

// ————————————————————————————————————————————————————————————————
// 单元层
// ————————————————————————————————————————————————————————————————

describe('SPEC-3.1/3.3 路径与记录格式（单元）', () => {
  it('路径落在 <home>/state 下且**按端口分文件**', () => {
    expect(backgroundExitLogPath('X:/h', 7777)).toBe(join('X:/h', 'state', 'background-exit-7777.log'))
    expect(backgroundExitLogPath('X:/h', 7778)).toBe(join('X:/h', 'state', 'background-exit-7778.log'))
    expect(backgroundExitLogPath('X:/h', 7777)).not.toBe(backgroundExitLogPath('X:/h', 7778))
  })

  it('正常退出（code=0）只记**一行**：时间 + 信号，不带 stderr', () => {
    const entry = formatExitEntry({
      at: new Date('2026-09-20T01:02:03.000Z'),
      code: 0,
      signal: 'SIGTERM',
      port: 7777,
      stderrTail: '不该被写进去的噪声\n',
    })
    expect(entry).toBe('2026-09-20T01:02:03.000Z [port 7777] 正常退出 code=0 signal=SIGTERM\n')
    expect(entry.trim().split('\n')).toHaveLength(1)
  })

  it('异常退出（code≠0）记全量：时间 / 退出码 / stderr 尾', () => {
    const entry = formatExitEntry({
      at: new Date('2026-09-20T01:02:03.000Z'),
      code: 1,
      signal: null,
      port: 7777,
      stderrTail: 'listen EADDRINUSE: address already in use 127.0.0.1:7777\n',
    })
    expect(entry).toContain('2026-09-20T01:02:03.000Z [port 7777] 异常退出 code=1 signal=-')
    expect(entry).toContain('listen EADDRINUSE')
    // 无 stderr 时不写空块
    const bare = formatExitEntry({ at: new Date(), code: 3, signal: null, port: 1, stderrTail: '  \n' })
    expect(bare).not.toContain('stderr 尾')
    // code=null（被信号终止）也要如实记录
    expect(formatExitEntry({ at: new Date(), code: null, signal: 'SIGKILL', port: 1, stderrTail: '' })).toContain(
      'code=null signal=SIGKILL',
    )
  })

  it('字节级取尾不会留下半个多字节字符', () => {
    const text = '结尾标记测'
    const tail = keepTailBytes(text, 4) // 只够「记测」两个汉字 + 半个别
    expect(tail).not.toContain('\uFFFD')
    expect(text.endsWith(tail)).toBe(true)
    expect(keepTailBytes('短', 100)).toBe('短')
  })

  it('超 64KB → 截断保尾，且标记幂等（不堆叠）', () => {
    const line = (i: number): string => `2026-09-20T00:00:00.000Z [port 7777] 异常退出 code=1 signal=- CHUNK-${i}\n`
    const big = Array.from({ length: 900 }, (_v, i) => line(i)).join('')
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(EXIT_LOG_MAX_BYTES)

    const truncated = truncateExitLog(big)
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(EXIT_LOG_MAX_BYTES)
    expect(truncated.startsWith(EXIT_LOG_TRUNCATION_MARK)).toBe(true)
    expect(truncated).toContain('CHUNK-899') // 尾部保留
    expect(truncated).not.toContain('CHUNK-0') // 头部丢弃
    // 幂等：再截一次不新增标记、内容不变
    expect(truncateExitLog(truncated)).toBe(truncated)
    expect(truncateExitLog(truncated).split(EXIT_LOG_TRUNCATION_MARK)).toHaveLength(2)
  })

  it('appendExitLog：写进指定 home，且写前超限也会被裁到 64KB 内', async () => {
    const home = await tempDir('bg-exit-unit-')
    const file = backgroundExitLogPath(home, 6001)
    await mkdir(join(home, 'state'), { recursive: true })
    // 预置一个已经超限的文件（模拟历史累积），再追加一条
    writeFileSync(file, `${'F'.repeat(EXIT_LOG_MAX_BYTES + 5000)}\n`, 'utf8')

    appendExitLog(home, 6001, formatExitEntry({ at: new Date(), code: 1, signal: null, port: 6001, stderrTail: 'TAIL-MARK\n' }))

    const text = readFileSync(file, 'utf8')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(EXIT_LOG_MAX_BYTES)
    expect(text.startsWith(EXIT_LOG_TRUNCATION_MARK)).toBe(true)
    expect(text).toContain('TAIL-MARK') // 新增的那条在尾部，必须保住
    expect(text).toContain('异常退出 code=1')
  })
})

// ————————————————————————————————————————————————————————————————
// 子进程层：真跑 dist/background.js
// ————————————————————————————————————————————————————————————————

describe('SPEC-3.1 异常退出（真跑 dist/background.js）', () => {
  beforeAll(() => {
    expect(existsSync(ENTRY), `缺少 ${ENTRY}——先跑 pnpm --filter @prism/server build`).toBe(true)
  })

  it('启动失败（端口被占）→ 退出码非 0，日志落在 --home 下且带时间/退出码/stderr 尾', async () => {
    const home = await tempDir('bg-exit-')
    const harnessRoot = await tempDir('bg-exit-h-')
    const port = await freePort()
    const squatter = await occupyPort(port)
    try {
      const run = await runBackground(home, harnessRoot, ['--port', String(port), '--home', home])
      expect(run.code).not.toBe(0)
      expect(run.code).not.toBeNull()

      const file = backgroundExitLogPath(home, port)
      expect(existsSync(file), `应写出 ${file}；stderr=${run.stderr}`).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
      expect(text).toContain(`[port ${port}] 异常退出 code=${String(run.code)}`)
      expect(text).toContain('stderr 尾')
      expect(text).toContain('EADDRINUSE') // stderr 尾真的来自该进程
    } finally {
      await squatter.close()
    }
  })

  it('未给 --home 时与 PRISM_HOME **同源**（重定向场景不写错位置）', async () => {
    const home = await tempDir('bg-exit-env-')
    const harnessRoot = await tempDir('bg-exit-h-')
    const port = await freePort()
    const squatter = await occupyPort(port)
    try {
      const run = await runBackground(home, harnessRoot, ['--port', String(port)])
      expect(run.code).not.toBe(0)
      const file = backgroundExitLogPath(home, port)
      expect(existsSync(file), `应写出 ${file}（PRISM_HOME=${home}）；stderr=${run.stderr}`).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('异常退出')
    } finally {
      await squatter.close()
    }
  })
})

describe('SPEC-3.3 按端口分文件：同一 home 下两次退出互不混写', () => {
  beforeAll(() => {
    expect(existsSync(ENTRY), `缺少 ${ENTRY}——先跑 pnpm --filter @prism/server build`).toBe(true)
  })

  it('两个端口 → 两个文件，各自只含自己那条记录', async () => {
    const home = await tempDir('bg-exit-ports-')
    const harnessRoot = await tempDir('bg-exit-h-')
    const portA = await freePort()
    const portB = await freePort()
    const squatA = await occupyPort(portA)
    const squatB = await occupyPort(portB)
    try {
      await runBackground(home, harnessRoot, ['--port', String(portA), '--home', home])
      await runBackground(home, harnessRoot, ['--port', String(portB), '--home', home])

      const fileA = backgroundExitLogPath(home, portA)
      const fileB = backgroundExitLogPath(home, portB)
      expect(existsSync(fileA)).toBe(true)
      expect(existsSync(fileB)).toBe(true)

      const textA = readFileSync(fileA, 'utf8')
      const textB = readFileSync(fileB, 'utf8')
      expect(textA).toContain(`[port ${portA}]`)
      expect(textB).toContain(`[port ${portB}]`)
      // 环形头不会被另一个实例踩掉：A 的文件里不得出现 B 的记录
      expect(textA).not.toContain(`[port ${portB}]`)
      expect(textB).not.toContain(`[port ${portA}]`)
    } finally {
      await squatA.close()
      await squatB.close()
    }
  })
})

describe('SPEC-3.2/3.1 正常退出与 stderr 环形（临时脚本，真进程 exit 钩子）', () => {
  beforeAll(() => {
    expect(existsSync(ENTRY), `缺少 ${ENTRY}——先跑 pnpm --filter @prism/server build`).toBe(true)
  })

  /**
   * 临时脚本：import **构建产物**里的钩子，再以可控方式退出。
   *
   * 为什么不用 `prism_kb` 那种真信号：Windows 上 `process.kill` 是 TerminateProcess，
   * 子进程收不到可捕获信号（实测 `exit` 都不触发）。故「正常退出」走 `process.emit('SIGINT')`
   * ——它走的是与真信号**同一个处理器**，且跨平台可达。
   */
  async function makeScript(): Promise<string> {
    const dir = await tempDir('bg-exit-script-')
    const file = join(dir, 'probe.mjs')
    await writeFile(
      file,
      [
        "import { pathToFileURL } from 'node:url'",
        'const mod = await import(pathToFileURL(process.env.BG_ENTRY).href)',
        'const ring = mod.captureStderrTail()',
        'let signal = null',
        'mod.installBackgroundExitLog({',
        '  home: process.env.BG_HOME,',
        '  port: Number(process.env.BG_PORT),',
        '  stderrTail: ring.tail,',
        '  signal: () => signal,',
        '})',
        "process.stdout.write('ready\\n')",
        "if (process.env.BG_MODE === 'normal') {",
        "  process.on('SIGINT', () => { signal = 'SIGINT'; process.exit(0) })",
        "  setTimeout(() => process.emit('SIGINT'), 100)",
        '} else {',
        "  process.stderr.write(`${'X'.repeat(10000)}\\nBG-STDERR-TAIL-END\\n`)",
        '  setTimeout(() => process.exit(1), 100)',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    return file
  }

  it('code=0 + SIGINT → 只有一行简短记录（时间/信号）', async () => {
    const home = await tempDir('bg-exit-ok-')
    const script = await makeScript()
    const port = 4399
    const run = await runNode([script], { BG_ENTRY: ENTRY, BG_HOME: home, BG_PORT: String(port), BG_MODE: 'normal' })
    expect(run.code).toBe(0)

    const file = backgroundExitLogPath(home, port)
    expect(existsSync(file), `应写出 ${file}；stderr=${run.stderr}`).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
    expect(text).toContain('正常退出 code=0 signal=SIGINT')
    expect(text).not.toContain('stderr 尾')
  })

  it('stderr 超 4KB → 只落到环形的 ~4KB 尾巴（且保留最后一行）', async () => {
    const home = await tempDir('bg-exit-big-')
    const script = await makeScript()
    const port = 4400
    const run = await runNode([script], { BG_ENTRY: ENTRY, BG_HOME: home, BG_PORT: String(port), BG_MODE: 'bigstderr' })
    expect(run.code).toBe(1)

    const text = readFileSync(backgroundExitLogPath(home, port), 'utf8')
    expect(text).toContain('异常退出 code=1')
    expect(text).toContain('BG-STDERR-TAIL-END') // 最后写的必须留下
    const xCount = (text.match(/X/g) ?? []).length
    expect(xCount).toBeGreaterThan(0)
    expect(xCount).toBeLessThanOrEqual(4 * 1024) // 10000 个 X 被环形缓冲截到 ~4KB
    expect(text).not.toContain('X'.repeat(4 * 1024 + 1))
  })
})

// ————————————————————————————————————————————————————————————————
// 子进程层：零侵入 / 残余限制
// ————————————————————————————————————————————————————————————————

describe('SPEC-3.4 零侵入：正常启动与 stdout 协议不受影响', () => {
  beforeAll(() => {
    expect(existsSync(ENTRY), `缺少 ${ENTRY}——先跑 pnpm --filter @prism/server build`).toBe(true)
  })

  it('启动横幅照常出现在 stdout；退出日志**只在退出时**才写', async () => {
    const home = await tempDir('bg-exit-live-')
    const harnessRoot = await tempDir('bg-exit-h-')
    const port = await freePort()

    const child = spawn(process.execPath, [ENTRY, '--port', String(port), '--home', home, '--harness-root', harnessRoot], {
      env: { ...process.env, PRISM_EMBEDDING: 'off', PRISM_RERANK: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    // 等启动横幅（= stdout 协议照常）
    const stdout = await new Promise<string>((resolve, reject) => {
      let acc = ''
      const timer = setTimeout(() => reject(new Error(`未在 20s 内看到启动横幅；累计输出=${acc}`)), 20_000)
      child.stdout.on('data', (chunk: Buffer) => {
        acc += chunk.toString()
        if (acc.includes('prism serve (background) 监听')) {
          clearTimeout(timer)
          resolve(acc)
        }
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    expect(stdout).toContain(`http://127.0.0.1:${port}`)

    // 「启动即挂缓冲、退出时才写」：进程还活着时不该有日志文件
    expect(existsSync(backgroundExitLogPath(home, port))).toBe(false)

    const exited = new Promise<void>((resolve) => child.on('close', () => resolve()))
    child.kill('SIGTERM')
    await exited

    const file = backgroundExitLogPath(home, port)
    if (process.platform === 'win32') {
      // 残余限制（S-5）：Windows 的 process.kill 是 TerminateProcess——无事件可挂，不落记录
      expect(existsSync(file)).toBe(false)
    } else {
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('正常退出')
    }
  }, 40_000)
})
