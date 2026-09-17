/**
 * **F5 测试红线**（design-v12 §F5 / SPEC-5.6，复核 N-3）：
 * `prism init` 默认会做「CLI 全局注册」——仓库态**往真实 npm 全局 bin 目录写 shim**，
 * 发行态**真跑 `npm install -g`**。任何测试/红绿演示若直接调 init 而不隔离，
 * 就是真实触碰本机的 npm prefix 与全局 bin 目录（R5 同族红线）。
 *
 * 本文件三层防线：
 *   a) **静态红线断言**：扫描全部既有 init 调用点源码，逐个断言 `--skip-cli`
 *      或 npm_config_prefix 隔离（违例输出 `文件:行` 清单）；
 *   b) **动态零副作用断言**：真实 `npm config get prefix` 与其全局 bin 目录条目
 *      在代表性 init 前后**零变化**（shim / npm 两条副作用路径的常备防线）；
 *   c) **功能测试**：仓库态 shim 三态、发行态 `npm install -g` 三态、`--skip-cli`、
 *      失败回落（npm 缺失 / 版本不符）——全部用**临时** `npm_config_prefix` 隔离。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { defaultContext, runCommand, cliVersion, type CommandContext } from '../src/argv.js'
import { resolveGlobalBin, shellHostileChars, type GlobalBinLayout } from '../src/commands/init-cli.js'

/** 仓库根（本文件在 `packages/cli/test/`）。 */
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/**
 * **扫描面 = glob**（b-4）：`packages/cli/test/*.test.ts` + 仓库根 `test/*.mjs`。
 * 不再维护固定清单——新增测试文件自动入扫，不会「新文件漏网」。
 */
function guardedFiles(): string[] {
  const out: string[] = []
  for (const dir of ['packages/cli/test', 'test']) {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      if (name.endsWith('.test.ts') || name.endsWith('.mjs')) out.push(`${dir}/${name}`)
    }
  }
  return out
}

/**
 * init 调用点的 argv 字面量：`['init'` 后须紧跟**旗标**（`'--…'`）、展开（`...`）或数组收尾。
 *
 * 只写 `['init'` 会把 `argv.test.ts` 的 USAGE 断言 `['init','serve','doctor',…]`
 * （一份**命令名清单**，不是调用）误判成调用点；故要求下一项确为旗标/展开/收尾。
 */
const INIT_ARGV = /\[\s*['"]init['"]\s*(?:,\s*(?:['"]--|\.\.\.)|,?\s*\])/

/** 豁免窗口（b-4）：调用点前后各 N 行内出现隔离证据才算已隔离。 */
const EXEMPT_WINDOW = 5

/**
 * 显式豁免标记（b-4）：写在 init 调用点邻域内即豁免，用于**无法靠 `npm_config_prefix`
 * 就近佐证**的调用（如本守护文件的 `initWith` 包装器）——必须同时在旁注明原因。
 */
const EXEMPT_MARKER = 'init-cli-guard:exempt'

/** 隔离证据（±{@link EXEMPT_WINDOW} 行窗口内任一命中即豁免）。 */
const ISOLATION_EVIDENCE = ['npm_config_prefix', '--skip-cli', EXEMPT_MARKER]

/**
 * 单个调用点的判定（纯函数，供 {@link staticIsolationViolations} 与自测共用）。
 * 返回 `null` = 非调用点或已隔离；否则返回该行的违例描述。
 */
export function initCallViolation(rel: string, lines: string[], index: number): string | null {
  const line = lines[index] ?? ''
  if (!INIT_ARGV.test(line)) return null
  const from = Math.max(0, index - EXEMPT_WINDOW)
  const to = Math.min(lines.length - 1, index + EXEMPT_WINDOW)
  const window = lines.slice(from, to + 1).join('\n')
  if (ISOLATION_EVIDENCE.some((evidence) => window.includes(evidence))) return null
  return `${rel}:${index + 1}  ${line.trim()}`
}

/**
 * 枚举未隔离的 init 调用点。
 *
 * 判据（±{@link EXEMPT_WINDOW} 行窗口内任一命中即算已隔离）：
 * - 调用点邻域内有 `--skip-cli`（显式跳过 CLI 注册）；或
 * - 邻域内有 `npm_config_prefix`（临时 prefix 注入，见本文件 `withEnv`）；或
 * - 邻域内有 {@link EXEMPT_MARKER} 显式标记（须写清原因）。
 */
export function staticIsolationViolations(): string[] {
  const violations: string[] = []
  for (const rel of guardedFiles()) {
    const lines = readFileSync(join(ROOT, rel), 'utf-8').split('\n')
    lines.forEach((_line, index) => {
      const violation = initCallViolation(rel, lines, index)
      if (violation !== null) violations.push(violation)
    })
  }
  return violations
}

describe('SPEC-5.6 静态红线：全部 init 调用点必须隔离（真实 npm prefix 零触碰）', () => {
  it('扫描面非空且含已知文件（防 glob 失配导致「空扫」假绿）', () => {
    const files = guardedFiles()
    expect(files.length).toBeGreaterThan(10)
    expect(files).toContain('test/run-e2e.mjs')
    expect(files).toContain('packages/cli/test/commands.test.ts')
    expect(files).toContain('packages/cli/test/init-cli-guard.test.ts')
    for (const rel of files) expect(rel.endsWith('.test.ts') || rel.endsWith('.mjs')).toBe(true)
  })

  it('判定器自测：真正未隔离的调用点会被抓，隔离证据 / 非调用点不误报', () => {
    // 样本用 `call(...)` 拼装——本文件自身不能出现「init + 旗标」调用字面量，
    // 否则会被自己的 glob 扫成调用点（守护文件的文本式判定固有边界）。
    const call = (args: string): string => `runCommand(ctx, ['init'${args}])`
    const at = (lines: string[]): string[] =>
      lines
        .map((_line, index) => initCallViolation('probe.ts', lines, index))
        .filter((v): v is string => v !== null)

    // 未隔离 → 违例（带旗标形态）
    const withFlag = call(", '--home', h")
    expect(at([withFlag])).toEqual([`probe.ts:1  ${withFlag}`])
    // 数组收尾形态（无旗标）同样是调用点 → 未隔离即违例
    const bare = call('')
    expect(at([bare])).toEqual([`probe.ts:1  ${bare}`])
    // 同行 `--skip-cli` → 豁免
    expect(at([call(", '--skip-cli'")])).toEqual([])
    // 邻域内 `npm_config_prefix`（窗口内）→ 豁免
    expect(at([call(", '--json'"), 'await withEnv({ npm_config_prefix: p }, fn)'])).toEqual([])
    // 显式标记（窗口内）→ 豁免
    expect(at(['// init-cli-guard:exempt —— 由调用方注入 prefix', call(", '--json'")])).toEqual([])
    // 命令名清单（第二项不是旗标/展开/收尾）→ 非调用点
    expect(at(["for (const c of ['init', 'serve', 'doctor']) {"])).toEqual([])
  })

  it('每个 init 调用点都显式 --skip-cli（或所在文件已声明 npm_config_prefix 隔离）', () => {
    const violations = staticIsolationViolations()
    expect(
      violations,
      `以下 init 调用点未隔离——会真实触碰本机 npm 全局 bin 目录：\n${violations.join('\n')}`,
    ).toEqual([])
  })
})

// ——————————————————————————————————————————————————————————————
// 共用的隔离夹具：临时 PRISM_HOME / harness 根 / npm prefix
// ——————————————————————————————————————————————————————————————

interface InitReportView {
  mcp: { status: string }
  cli: {
    status: string
    mode: string | null
    prefix: string | null
    binDir: string | null
    installPath: string | null
    verify: string | null
    error?: string
    hint?: string
  }
}

interface Fixture {
  home: string
  harnessRoot: string
  prefix: string
  lines: string[]
  ctx: CommandContext
}

/** npm 可执行体（走 `resolveGlobalBin` 这个唯一平台点，测试里不另判平台）。 */
function npmSpawn(): { command: string; shell: boolean } {
  const layout = resolveGlobalBin(ROOT)
  return { command: layout.npmExe, shell: layout.shell }
}

interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

/** 起子进程收输出（测试自用的小工具，与产品实现无关）。 */
function capture(
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; shell: boolean },
): Promise<CaptureResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: CaptureResult): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const child = spawn(command, args, {
      env: opts.env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      shell: opts.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (error: Error) => finish({ code: null, stdout, stderr, error: error.message }))
    child.on('close', (code: number | null) => finish({ code, stdout, stderr }))
  })
}

/**
 * **真实** npm prefix：临时摘掉注入项再问 npm（量到的才是本机默认值）。
 *
 * 大小写两种写法都要摘——Windows 的环境块里实际存在的是 `NPM_CONFIG_PREFIX`
 * （pnpm/npm 父进程留下的），只删小写键等于没删。
 */
async function realNpmPrefix(): Promise<string> {
  const { command, shell } = npmSpawn()
  const keys = ['npm_config_prefix', 'NPM_CONFIG_PREFIX']
  const saved = keys.map((key) => [key, process.env[key]] as const)
  for (const key of keys) delete process.env[key]
  try {
    const probe = await capture(command, ['config', 'get', 'prefix'], { env: process.env, shell })
    const lines = probe.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return lines.length === 0 ? '' : lines[lines.length - 1]
  } finally {
    for (const [key, value] of saved) {
      if (value !== undefined) process.env[key] = value
    }
  }
}

/** 目录条目清单（不存在 → null，用于「前后零变化」比对）。 */
async function listDir(dir: string): Promise<string[] | null> {
  return await readdir(dir).then(
    (entries) => entries.sort(),
    () => null,
  )
}

/**
 * 用 npm 把某个「发行根」装进**临时** prefix（测试自建前置状态；仍在隔离内）。
 *
 * ⚠ 必须经 {@link withEnv} 改写 `process.env` 本体，**不能**另传一份 `{...process.env, npm_config_prefix}`：
 * Windows 的环境块里本来就可能有 `NPM_CONFIG_PREFIX`（pnpm/npm 父进程留下的，实测本机有），
 * 大小写不敏感查找下新加的**小写**键会被它压住 → npm 装到真实全局前缀去（隔离失效）。
 * `process.env` 赋值走的是「就地替换同名项」，所以只剩一个键、生效确定。
 */
async function npmInstallInto(prefix: string, root: string): Promise<CaptureResult> {
  const { command, shell } = npmSpawn()
  const args = ['install', '-g', shell && root.includes(' ') ? `"${root}"` : root, '--no-audit', '--no-fund', '--ignore-scripts']
  return await withEnv({ npm_config_prefix: prefix }, () => capture(command, args, { env: process.env, shell }))
}

/**
 * 临时设置环境变量并在结束时还原（npm_config_prefix 注入即测试隔离手段）。
 *
 * ⚠ **必须先全部存档、再统一写入**：Windows 的 `PATH`/`Path` 是同一个环境项（大小写不敏感），
 * 若「写一个存一个」，后存的键读到的已是**被改过的**值，还原时就会把污染留下来。
 */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const entries = Object.entries(env)
  const saved = entries.map(([key]) => [key, process.env[key]] as const)
  for (const [key, value] of entries) process.env[key] = value
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('F5 CLI 全局注册（全部用临时 npm_config_prefix 隔离）', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  async function makeFixture(): Promise<Fixture> {
    const home = await mkdtemp(join(tmpdir(), 'clireg-home-'))
    const harnessRoot = await mkdtemp(join(tmpdir(), 'clireg-root-'))
    const prefix = await mkdtemp(join(tmpdir(), 'clireg-prefix-'))
    cleanup.push(home, harnessRoot, prefix)
    const lines: string[] = []
    const ctx: CommandContext = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home,
    }
    return { home, harnessRoot, prefix, lines, ctx }
  }

  /**
   * 跑一次 init（--json）并取回报告。
   *
   * 本包装器的调用点**不经 `withEnv`**，故静态红线断言看不见就近的 `npm_config_prefix`；
   * 显式标记豁免——所有 `initWith` 的调用点都由调用方 `withEnv({ npm_config_prefix })`
   * 注入临时 prefix（见各用例），即本文件 b) 层的隔离手段。
   */
  // init-cli-guard:exempt —— initWith 的隔离由各调用点的 withEnv({npm_config_prefix}) 承担
  async function initWith(f: Fixture, extra: string[] = []): Promise<{ code: number; report: InitReportView }> {
    f.lines.length = 0
    const code = await runCommand(f.ctx, ['init', '--home', f.home, '--harness-root', f.harnessRoot, '--json', ...extra])
    const jsonLine = [...f.lines].reverse().find((line) => line.startsWith('{'))
    if (jsonLine === undefined) throw new Error(`init 未输出 JSON 报告：${f.lines.join(' | ')}`)
    return { code, report: (JSON.parse(jsonLine) as { value: InitReportView }).value }
  }

  /** 伪造「发行根」：PRISM-MANIFEST.json（发行态判据）+ 带 bin 的最小 package.json + 假 CLI。 */
  async function makeFakeRelease(reportedVersion: string): Promise<string> {
    const releaseRoot = await mkdtemp(join(tmpdir(), 'clireg-release-'))
    cleanup.push(releaseRoot)
    await writeFile(join(releaseRoot, 'PRISM-MANIFEST.json'), '{}\n', 'utf-8')
    await writeFile(
      join(releaseRoot, 'package.json'),
      `${JSON.stringify(
        { name: 'prism-fake-release', version: reportedVersion, bin: { prism: './bin/prism.js' } },
        null,
        2,
      )}\n`,
      'utf-8',
    )
    await mkdir(join(releaseRoot, 'bin'), { recursive: true })
    await writeFile(
      join(releaseRoot, 'bin', 'prism.js'),
      `#!/usr/bin/env node\nprocess.stdout.write('prism ${reportedVersion}\\n')\n`,
      'utf-8',
    )
    return releaseRoot
  }

  /** 在全局 bin 落点预置一个**外来**（非本仓）可执行体：package 态触发 npm EEXIST。 */
  async function writeStaleExe(layout: GlobalBinLayout): Promise<void> {
    await mkdir(layout.binDir, { recursive: true })
    if (layout.shell) {
      // Windows：待验证的是 prism.cmd
      await writeFile(layout.prismExe, '@echo off\r\necho 0.0.0\r\n', 'utf-8')
      return
    }
    await writeFile(layout.prismExe, '#!/bin/sh\necho 0.0.0\n', 'utf-8')
    await chmod(layout.prismExe, 0o755)
  }

  /**
   * 预置「**本仓 shim** 但版本不符」（b-2 反面）：内容含本仓入口特征（判定为可覆写），
   * 但 `--version` 报 0.0.0 → 落重写分支 → updated。
   */
  async function writeStaleRepoShim(layout: GlobalBinLayout, entry: string): Promise<void> {
    await mkdir(layout.binDir, { recursive: true })
    const content = layout.shell
      ? `@echo off\r\necho 0.0.0\r\nrem exec node "${entry}" %*\r\n`
      : `#!/bin/sh\necho 0.0.0\nexec node "${entry}" "$@"\n`
    await writeFile(layout.prismExe, content, 'utf-8')
    if (!layout.shell) await chmod(layout.prismExe, 0o755)
  }

  it('仓库态：写全局 bin shim（win 三件套 / posix 单件 + 可执行位），指向仓库 CLI 入口', async () => {
    const f = await makeFixture()
    const layout = resolveGlobalBin(f.prefix)
    const entry = join(ROOT, 'packages', 'cli', 'dist', 'index.js')
    // 验证是**真跑** dist 入口，故先确认产物在（门禁第 2 步会 build）
    expect(existsSync(entry), `缺少 ${entry}——先跑 pnpm --filter @prism/cli build`).toBe(true)

    const first = await withEnv({ npm_config_prefix: f.prefix }, () => initWith(f))
    expect(first.code).toBe(0)
    expect(first.report.cli.status).toBe('installed')
    expect(first.report.cli.mode).toBe('repo')
    expect(first.report.cli.prefix).toBe(f.prefix)
    expect(first.report.cli.installPath).toBe(layout.prismExe)
    expect(first.report.cli.verify).toContain(await cliVersion())

    // 平台分支断言：Windows 三件套直落 <prefix>；POSIX 单件落 <prefix>/bin
    const norm = (p: string): string => p.replaceAll('\\', '/')
    if (process.platform === 'win32') {
      expect(layout.binDir).toBe(f.prefix)
      for (const name of ['prism', 'prism.cmd', 'prism.ps1']) {
        expect(existsSync(join(layout.binDir, name)), `${name} 应落 ${layout.binDir}`).toBe(true)
      }
      expect(norm(await readFile(join(layout.binDir, 'prism.cmd'), 'utf-8'))).toContain(norm(entry))
      expect(norm(await readFile(join(layout.binDir, 'prism.ps1'), 'utf-8'))).toContain(norm(entry))
    } else {
      expect(layout.binDir).toBe(join(f.prefix, 'bin'))
      expect(existsSync(join(layout.binDir, 'prism'))).toBe(true)
      expect(existsSync(join(layout.binDir, 'prism.cmd'))).toBe(false)
    }
    const shim = await readFile(join(layout.binDir, 'prism'), 'utf-8')
    expect(shim.startsWith('#!/bin/sh')).toBe(true)
    expect(norm(shim)).toContain(`exec node "${norm(entry)}" "$@"`)

    // 幂等（SPEC-5.3）：绝对路径 + 版本都命中 → unchanged，不重写
    const second = await withEnv({ npm_config_prefix: f.prefix }, () => initWith(f))
    expect(second.report.cli.status).toBe('unchanged')

    // 本仓 shim 但版本不符 → 允许覆写 → 重写 → updated（且内容回到确定性 shim）
    await writeStaleRepoShim(layout, entry)
    const third = await withEnv({ npm_config_prefix: f.prefix }, () => initWith(f))
    expect(third.report.cli.status, JSON.stringify(third.report.cli)).toBe('updated')
    expect(third.report.cli.verify).toContain(await cliVersion())
    expect(norm(await readFile(join(layout.binDir, 'prism'), 'utf-8'))).toContain(`exec node "${norm(entry)}"`)
  })

  it('b-2：落点已有**外来** prism 文件 → failed + 「先移走 <路径>」指引，恰不覆写', async () => {
    const f = await makeFixture()
    const layout = resolveGlobalBin(f.prefix)
    const foreign = layout.prismExe
    await writeStaleExe(layout) // 手写文件，不含本仓入口特征 → 外来

    const { code, report } = await withEnv({ npm_config_prefix: f.prefix }, () => initWith(f))
    expect(code).toBe(0)
    expect(report.cli.status).toBe('failed')
    expect(report.cli.error ?? '').toContain(foreign)
    expect(report.cli.hint ?? '').toContain(foreign)
    expect(report.cli.hint ?? '').toContain('先移走')
    // 外来文件原样保留（零覆写）
    expect(await readFile(foreign, 'utf-8')).toContain('0.0.0')
  })

  it('b-1：CLI 入口路径含 sh 元字符（`$`）→ failed + 原样路径指引，不写 shim', async () => {
    const f = await makeFixture()
    // 只改 root（含 `$`）→ 入口路径含 sh 危险字符；sh shim 在两种平台都会写 → 两平台同断言
    const hostileRoot = await mkdtemp(join(tmpdir(), 'clireg-$-'))
    cleanup.push(hostileRoot)
    const layout = resolveGlobalBin(f.prefix)
    const entry = join(hostileRoot, 'packages', 'cli', 'dist', 'index.js')

    const { code, report } = await withEnv(
      { npm_config_prefix: f.prefix, PRISM_CLI_ROOT: hostileRoot },
      () => initWith(f),
    )
    expect(code).toBe(0)
    expect(report.cli.status).toBe('failed')
    expect(report.cli.mode).toBe('repo')
    expect(report.cli.error ?? '').toContain('sh')
    expect(report.cli.hint ?? '').toContain(entry) // 指引给**原样**路径
    // 含元字符即不写：一个 shim 文件都没落
    expect(existsSync(join(layout.binDir, 'prism'))).toBe(false)
    expect(existsSync(layout.prismExe)).toBe(false)
  })

  it('b-1 单点判定：shellHostileChars 三分支表驱动（只列双引号内仍生效的字符）', () => {
    const cases: Array<{ shell: 'sh' | 'cmd' | 'ps1'; value: string; expected: string[] }> = [
      // sh：`$` / 反引号 / `"` 命中；普通 Windows 路径（反斜杠不特殊）全绿
      { shell: 'sh', value: 'C:\\work\\project\\prism\\packages\\cli\\dist\\index.js', expected: [] },
      { shell: 'sh', value: '/Users/a$b/prism', expected: ['$'] },
      { shell: 'sh', value: '/tmp/`whoami`/x', expected: ['`'] },
      { shell: 'sh', value: '/tmp/a"b', expected: ['"'] },
      { shell: 'sh', value: 'C:\\a\\', expected: ['\\'] }, // 末尾反斜杠会吃掉收尾引号
      { shell: 'sh', value: 'C:\\a\\$b', expected: ['\\', '$'] },
      // cmd：`%VAR%` 与 `!` 双引号内仍展开
      { shell: 'cmd', value: 'C:\\work\\prism', expected: [] },
      { shell: 'cmd', value: 'C:\\a%b\\c', expected: ['%'] },
      { shell: 'cmd', value: 'C:\\a!b', expected: ['!'] },
      // ps1：`$` / 反引号
      { shell: 'ps1', value: 'C:\\work\\prism', expected: [] },
      { shell: 'ps1', value: 'C:\\a$b', expected: ['$'] },
      { shell: 'ps1', value: 'C:\\a`b', expected: ['`'] },
    ]
    for (const { shell, value, expected } of cases) {
      expect(shellHostileChars(shell, value), `${shell} ${value}`).toEqual(expected)
    }
  })

  it('发行态：真跑 npm install -g 假发行根 → installed，重跑 → unchanged', async () => {
    const f = await makeFixture()
    const version = await cliVersion()
    const releaseRoot = await makeFakeRelease(version)
    const layout = resolveGlobalBin(f.prefix)

    const first = await withEnv(
      { npm_config_prefix: f.prefix, PRISM_CLI_ROOT: releaseRoot },
      () => initWith(f),
    )
    expect(first.code).toBe(0)
    expect(first.report.cli.status).toBe('installed')
    expect(first.report.cli.mode).toBe('package')
    expect(first.report.cli.installPath).toBe(layout.prismExe)
    expect(existsSync(layout.prismExe)).toBe(true)
    expect(first.report.cli.verify).toContain(version)

    // 幂等：绝对路径 + 版本命中 → unchanged（不再跑 npm）
    const second = await withEnv(
      { npm_config_prefix: f.prefix, PRISM_CLI_ROOT: releaseRoot },
      () => initWith(f),
    )
    expect(second.report.cli.status).toBe('unchanged')
  }, 120_000)

  it('发行态：落点已有旧版本 → 重装并报 updated（版本不符的常规路径）', async () => {
    const f = await makeFixture()
    const version = await cliVersion()
    const layout = resolveGlobalBin(f.prefix)
    // 先用 npm 装一个**同名旧包**（模拟「本机已有旧版 prism」），它是 npm 自己的 shim →
    // 再由 init 用新发行根覆盖：npm 按包名替换 → shim 目标路径不变、版本翻新 → updated。
    const pre = await npmInstallInto(f.prefix, await makeFakeRelease('0.0.1'))
    expect(pre.code, `预装旧版失败：${pre.stderr}`).toBe(0)
    expect(
      existsSync(layout.prismExe),
      `${layout.prismExe} 不在；prefix 内容=${JSON.stringify(await listDir(f.prefix))}`,
    ).toBe(true)

    const { code, report } = await withEnv(
      { npm_config_prefix: f.prefix, PRISM_CLI_ROOT: await makeFakeRelease(version) },
      () => initWith(f),
    )
    expect(code).toBe(0)
    expect(report.cli.status, JSON.stringify(report.cli)).toBe('updated')
    expect(report.cli.verify).toContain(version)
  }, 120_000)

  it('失败回落：落点被**非 npm** 的 prism 占着 → npm 报 EEXIST → failed + 针对该情形的指引', async () => {
    const f = await makeFixture()
    const releaseRoot = await makeFakeRelease(await cliVersion())
    const layout = resolveGlobalBin(f.prefix)
    await writeStaleExe(layout) // 手写文件：npm 的 bin 链接不覆盖它

    const { code, report } = await withEnv(
      { npm_config_prefix: f.prefix, PRISM_CLI_ROOT: releaseRoot },
      () => initWith(f),
    )
    expect(code).toBe(0)
    expect(report.cli.status).toBe('failed')
    expect(report.cli.error ?? '').toContain('EEXIST')
    expect(report.cli.hint ?? '').toContain('EEXIST')
    expect(report.cli.hint ?? '').toContain(layout.prismExe)
    expect(existsSync(join(f.home, 'config.json'))).toBe(true)
  }, 120_000)

  it('--skip-cli：cli 节 status=skipped，且全局 bin 目录零触碰', async () => {
    const f = await makeFixture()
    const layout = resolveGlobalBin(f.prefix)

    const { code, report } = await withEnv({ npm_config_prefix: f.prefix }, () => initWith(f, ['--skip-cli']))
    expect(code).toBe(0)
    expect(report.cli).toEqual({
      status: 'skipped',
      mode: null,
      prefix: null,
      binDir: null,
      installPath: null,
      verify: null,
    })
    // 全局 bin 目录连建都没建（prefix 是临时空目录）
    expect(await listDir(layout.binDir)).toEqual([])
  })

  it('失败回落：发行态 npm 不在 PATH → failed + 手动指引，其余步骤照常完成（exit 0）', async () => {
    const f = await makeFixture()
    const releaseRoot = await makeFakeRelease(await cliVersion())
    const emptyBin = await mkdtemp(join(tmpdir(), 'clireg-nopath-'))
    cleanup.push(emptyBin)

    const { code, report } = await withEnv(
      { npm_config_prefix: f.prefix, PRISM_CLI_ROOT: releaseRoot, PATH: emptyBin, Path: emptyBin },
      () => initWith(f),
    )
    expect(code).toBe(0) // init 不因 CLI 注册失败而中断
    expect(report.cli.status).toBe('failed')
    expect(report.cli.hint).toContain('npm install -g')
    expect(report.cli.hint).toContain(releaseRoot)
    // 其余步骤照常完成
    expect(existsSync(join(f.home, 'config.json'))).toBe(true)
    expect(existsSync(join(f.harnessRoot, 'skills', 'prism', 'SKILL.md'))).toBe(true)
    expect(report.mcp.status).toBe('written')
  }, 120_000)

  it('失败回落：安装后 --version 版本不符 → failed + 指引，其余步骤照常完成（exit 0）', async () => {
    const f = await makeFixture()
    const releaseRoot = await makeFakeRelease('9.9.9')
    const layout = resolveGlobalBin(f.prefix)

    const { code, report } = await withEnv(
      { npm_config_prefix: f.prefix, PRISM_CLI_ROOT: releaseRoot },
      () => initWith(f),
    )
    expect(code).toBe(0)
    expect(report.cli.status).toBe('failed')
    expect(report.cli.error ?? '').toContain('版本不符')
    expect(report.cli.hint).toBeTruthy()
    expect(report.cli.installPath).toBe(layout.prismExe)
    expect(existsSync(join(f.home, 'config.json'))).toBe(true)
    expect(report.mcp.status).toBe('written')
  }, 120_000)
})

describe('SPEC-5.6 动态零副作用：真实 npm prefix 与全局 bin 目录前后零变化', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('shim 与 npm 两条副作用路径跑完，本机真实 prefix / 全局 bin 目录零变化', async () => {
    const prefix = await realNpmPrefix()
    expect(prefix, 'npm config get prefix 应有输出').not.toBe('')
    const layout = resolveGlobalBin(prefix)
    const binBefore = await listDir(layout.binDir)

    const home = await mkdtemp(join(tmpdir(), 'zeroside-home-'))
    const harnessRoot = await mkdtemp(join(tmpdir(), 'zeroside-root-'))
    const tempPrefix = await mkdtemp(join(tmpdir(), 'zeroside-prefix-'))
    const releaseRoot = await mkdtemp(join(tmpdir(), 'zeroside-release-'))
    cleanup.push(home, harnessRoot, tempPrefix, releaseRoot)
    const lines: string[] = []
    const ctx: CommandContext = {
      ...defaultContext({ stdout: (line) => lines.push(line), stderr: (line) => lines.push(`[stderr] ${line}`) }),
      home,
    }
    const version = await cliVersion()
    await writeFile(join(releaseRoot, 'PRISM-MANIFEST.json'), '{}\n', 'utf-8')
    await writeFile(
      join(releaseRoot, 'package.json'),
      `${JSON.stringify({ name: 'prism-zeroside-release', version, bin: { prism: './bin/prism.js' } }, null, 2)}\n`,
      'utf-8',
    )
    await mkdir(join(releaseRoot, 'bin'), { recursive: true })
    await writeFile(
      join(releaseRoot, 'bin', 'prism.js'),
      `#!/usr/bin/env node\nprocess.stdout.write('prism ${version}\\n')\n`,
      'utf-8',
    )

    // init-cli-guard:exempt —— 两条副作用路径的 prefix 由下方 run({npm_config_prefix}) 注入
    const run = (env: Record<string, string>): Promise<number> =>
      withEnv(env, () =>
        runCommand(ctx, ['init', '--home', home, '--harness-root', harnessRoot, '--json']),
      )
    // 副作用路径一：仓库态写 shim；副作用路径二：发行态 npm install -g
    await run({ npm_config_prefix: tempPrefix })
    await run({ npm_config_prefix: tempPrefix, PRISM_CLI_ROOT: releaseRoot })

    expect(await listDir(layout.binDir), `${layout.binDir} 不应被本次测试改变`).toEqual(binBefore)
    expect(await realNpmPrefix()).toBe(prefix)
  }, 120_000)
})
