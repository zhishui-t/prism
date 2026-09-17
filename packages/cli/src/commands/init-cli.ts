/**
 * `prism init` 的 **CLI 全局注册**步骤（design-v12 §F5 / SPEC-5.1–5.6）。
 *
 * 目标：让 `prism` 命令在**任何 cwd** 下可用；`init` 默认执行，`--skip-cli` 跳过。
 * 两种包形态，安装机制**不同**（审核修正后的口径，原文「repoRoot 命中=仓库态」不成立——
 * `repoRoot()` 找 `3rd/`/`packages/` 特征，而**发行根两样都有**，两种布局都会命中）：
 *
 * - **发行态** = 发行根含 `PRISM-MANIFEST.json`（`scripts/package.mjs` 只在发行根写它）
 *   → `npm install -g <发行根>`：发行根 package.json 自带 `bin: {prism: ./bin/prism.js}`
 *   且依赖自包含，npm 只做「装目录 + 链接 bin」，无需联网。
 * - **仓库态** = 无 `PRISM-MANIFEST.json` → **写全局 bin shim**。绝不能 `npm install -g <仓库根>`：
 *   根包 private 且无 bin，子包依赖是 pnpm `workspace:*` 协议，npm 解析不了。shim 零网络、
 *   内容确定性（幂等 = 重写同内容），指向 `<仓库根>/packages/cli/dist/index.js`。
 *
 * **失败一律不中断 init**（SPEC-5.4）：返回 `status: failed` + 平台/形态对应的手动指引，
 * init 其余步骤照常完成、进程仍 exit 0。
 *
 * ⚠ 幂等判据含**绝对路径**比对（SPEC-5.3）：只在「本次将写入的 bin 路径」这一绝对路径上
 * 验证 `--version`，绝不裸跑 PATH 上的 `prism`（prefix 注入的测试下它根本不在 PATH，
 * 且 PATH 上同版本的另一份会假绿）。
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { repoRoot } from '@prism/core'

import { cliVersion } from '../version.js'

/**
 * **全仓唯一的 npm / prism 平台判定点**（AGENTS.md §3.4：平台差异只在统一位置判定，
 * 其余代码不得就地再判一次）。判据与登记见 `doc/requirements/cross-platform.md` §3。
 */
const IS_WINDOWS = process.platform === 'win32'

/** npm 可执行体名（Windows 上 npm 是 `npm.cmd`，须经 shell 执行）。 */
const npmExe = (): string => (IS_WINDOWS ? 'npm.cmd' : 'npm')

/** npm 是否须经 shell 执行（Windows 的 `.cmd` 走 `shell: true`，见 AGENTS.md 陷阱表）。 */
const npmShell = (): boolean => IS_WINDOWS

/** 全局 bin 布局：npm 在 win32 / POSIX 下的落点与可执行体命名差异。 */
export interface GlobalBinLayout {
  /** 全局 bin 目录（npm 把可执行体写在这里） */
  binDir: string
  /** 本次安装/写入的可执行体绝对路径（Windows = `prism.cmd`，POSIX = `prism`） */
  prismExe: string
  /** npm 可执行体名（Windows = `npm.cmd`，POSIX = `npm`） */
  npmExe: string
  /** 是否须经 shell 执行（Windows 的 `.cmd` 为 true） */
  shell: boolean
}

/**
 * **唯一平台判定函数**：由 npm prefix 推出全局 bin 目录与可执行体命名。
 * - Windows：`<prefix>` 本身就是 bin 目录（npm win32 布局把 `prism.cmd` 直接写在 prefix 下）
 * - POSIX：`<prefix>/bin`
 */
export function resolveGlobalBin(prefix: string): GlobalBinLayout {
  if (IS_WINDOWS) {
    return { binDir: prefix, prismExe: join(prefix, 'prism.cmd'), npmExe: npmExe(), shell: true }
  }
  const binDir = join(prefix, 'bin')
  return { binDir, prismExe: join(binDir, 'prism'), npmExe: npmExe(), shell: npmShell() }
}

/**
 * shim / spawn 内联的目标 shell 种类（b-1：判定收敛成这一个单点）。
 * `sh` = POSIX sh（Git Bash 亦走它）；`cmd` = Windows `cmd.exe`（`.cmd` shim 与
 * `shell:true` 的 spawn 拼接都经它）；`ps1` = PowerShell（`.ps1` shim）。
 */
export type ShellKind = 'sh' | 'cmd' | 'ps1'

/**
 * **b-1 冻结判据**：`value` 内联进 `shell` 的**双引号**之后，仍会被该 shell 解释的字符。
 * 返回命中的字符（去重、按出现序）；空数组 = 可安全内联。
 *
 * 只列**双引号内仍生效**的字符，避免把正常路径（如 Windows 的 `C:\work\...`）过度拒绝：
 * - `sh`：`$` / 反引号 / `"`；以及**后接 `$`/反引号/`"`/`\` 或位于末尾**的 `\`
 *   （POSIX 双引号内 `\` 只在这些位置特殊，普通 `C:\dir\file` 不受影响）；
 * - `cmd`：`%`（`%VAR%` 在双引号内照样展开）/ `!`（延迟展开）/ `"`（提前闭合）；
 * - `ps1`：`$`（`$var`/`$(...)` 展开）/ 反引号 / `"`。
 */
export function shellHostileChars(shell: ShellKind, value: string): string[] {
  const hostile = (char: string, next: string | undefined): boolean => {
    switch (shell) {
      case 'sh':
        if (char === '$' || char === '`' || char === '"') return true
        return char === '\\' && (next === undefined || next === '$' || next === '`' || next === '"' || next === '\\')
      case 'cmd':
        return char === '%' || char === '!' || char === '"'
      case 'ps1':
        return char === '$' || char === '`' || char === '"'
    }
  }
  const out: string[] = []
  for (let index = 0; index < value.length; index++) {
    const char = value[index] as string
    if (!hostile(char, value[index + 1])) continue
    if (!out.includes(char)) out.push(char)
  }
  return out
}

/** 本仓 shim 的识别特征（b-2 冻结）：内容含本仓 CLI 入口路径片段（`packages/cli/dist/index.js`）。 */
const REPO_ENTRY_MARKER = join('packages', 'cli', 'dist', 'index.js').replaceAll('\\', '/')

/** shim 文件名 → 目标 shell（写入清单与判定共用同一来源，不各自列）。 */
function shellOfShim(name: string): ShellKind {
  if (name.endsWith('.cmd')) return 'cmd'
  if (name.endsWith('.ps1')) return 'ps1'
  return 'sh'
}

/**
 * 仓库态本次会写入的 shim 清单（**名称 + 内容同源**：写入、外来判定、指引三处共用）。
 * Windows 三件套（`prism` / `prism.cmd` / `prism.ps1`，顺序 = 写入顺序）；POSIX 仅 `prism`。
 */
function shimSpecs(layout: GlobalBinLayout, entry: string): Array<{ name: string; content: string }> {
  const specs = [
    // Windows 的 Git Bash 也走这一个：msys 按 shebang 认可执行，无需扩展名
    { name: 'prism', content: `#!/bin/sh\nexec node "${entry}" "$@"\n` },
  ]
  if (layout.shell) {
    // .cmd 用 CRLF（cmd.exe 的常规形态；内容仍确定）
    specs.push(
      { name: 'prism.cmd', content: `@echo off\r\nnode "${entry}" %*\r\n` },
      {
        name: 'prism.ps1',
        content: `#!/usr/bin/env pwsh\n& node "${entry}" $args\nexit $LASTEXITCODE\n`,
      },
    )
  }
  return specs
}

/** init 报告的 `cli` 节（`--json` 原样输出；文本模式渲染成一行）。 */
export interface InitCliReport {
  status: 'installed' | 'updated' | 'unchanged' | 'failed' | 'skipped'
  /** 包形态：发行态 `package` / 仓库态 `repo`；`skipped` 时为 null */
  mode: 'package' | 'repo' | null
  /** npm 全局根（`npm config get prefix`） */
  prefix: string | null
  /** 全局 bin 目录（{@link resolveGlobalBin}） */
  binDir: string | null
  /** 本次安装/写入的可执行体绝对路径（失败/跳过时仍为期望落点或 null） */
  installPath: string | null
  /** 验证输出摘要（spawn `<installPath> --version` 的 stdout；未验证时为 null） */
  verify: string | null
  /** 失败原因（一句话） */
  error?: string
  /** 失败时的**手动指引原文**（发行态 = `npm i -g` 命令；仓库态 = 三个 shim 文件路径与内容） */
  hint?: string
}

/**
 * 执行 CLI 全局注册（幂等）。永不抛：任何异常都落成 `status: failed` + 指引。
 *
 * @param opts.skip `--skip-cli` → 直接 `status: skipped`，**不触碰** npm 与全局 bin
 */
export async function registerCli(opts: { skip: boolean }): Promise<InitCliReport> {
  if (opts.skip) {
    return { status: 'skipped', mode: null, prefix: null, binDir: null, installPath: null, verify: null }
  }

  const version = await cliVersion()
  const root = cliRoot()
  if (root === null) {
    return {
      status: 'failed',
      mode: null,
      prefix: null,
      binDir: null,
      installPath: null,
      verify: null,
      error: '找不到发行根 / 仓库根（repoRoot 未命中）',
      hint: '请从仓库或发行包内运行 `prism init`（可用 PRISM_CLI_ROOT 显式指定根目录）。',
    }
  }
  const mode: 'package' | 'repo' = existsSync(join(root, 'PRISM-MANIFEST.json')) ? 'package' : 'repo'

  // prefix 来源 = `npm config get prefix`（该命令尊重 npm_config_prefix 环境变量——
  // 测试隔离即靠注入它）；npm 不可用时回落该环境变量本身。
  const prefixProbe = await runCapture(npmExe(), ['config', 'get', 'prefix'], {
    env: process.env,
    timeoutMs: 30_000,
    shell: npmShell(),
  })
  const fromNpm = lastNonEmptyLine(prefixProbe.stdout)
  const prefix = fromNpm !== '' ? fromNpm : (process.env['npm_config_prefix'] ?? '').trim()
  if (prefix === '') {
    return {
      status: 'failed',
      mode,
      prefix: null,
      binDir: null,
      installPath: null,
      verify: null,
      error: `无法解析 npm 全局根：${prefixProbe.error ?? `npm config get prefix 退出码 ${String(prefixProbe.code)}`}`,
      hint: `${manualHint(mode, null, root)}（npm 全局根未解析出来：可先运行 npm config get prefix 查看，或设 npm_config_prefix 后重试）`,
    }
  }

  const layout = resolveGlobalBin(prefix)
  const base = { mode, prefix, binDir: layout.binDir, installPath: layout.prismExe }

  // b-1（spawn 侧）：Windows 上可执行体 `.cmd` **只能经 shell 执行**（`shell:true` 把
  // command+args 拼成一串，见 AGENTS.md 陷阱表），`shellSafe` 只处理空格。落点路径含
  // cmd 元字符时拼串不安全 → 与 shim 写入共用同一判定，此处 failed + 原样路径指引。
  if (layout.shell) {
    const chars = shellHostileChars('cmd', layout.prismExe)
    if (chars.length > 0) {
      return {
        ...base,
        status: 'failed',
        verify: null,
        error: `全局 bin 落点路径含 cmd 元字符（${chars.join(' ')}），经 shell 拼串不安全`,
        hint: `落点原样路径：${layout.prismExe}——其中 ${chars.join(' ')} 会被 cmd 解释，请手工把该路径加入 PATH（或手工写 shim）后重跑`,
      }
    }
  }

  // 落点是否已有可执行体——决定最终报 installed（新建）还是 updated（重装/重写）。
  // 能走到这里说明它要么不存在，要么存在但版本不符（版本相符的在上面就返回 unchanged 了）。
  const existed = existsSync(layout.prismExe)

  // 幂等（SPEC-5.3）：绝对路径上已存在可执行体 **且** 版本匹配 → unchanged。
  // 版本不符 → 落到下面的重装/重写，报 updated。
  if (existed) {
    const probe = await verify(layout, version)
    if (probe.ok) {
      return { ...base, status: 'unchanged', verify: probe.output }
    }
  }

  // —— 安装 / 重写 ——
  if (mode === 'package') {
    // b-1（spawn 侧）：npm 在 Windows 同样经 shell（`npm.cmd`），发行根路径含 cmd
    // 元字符时参数无法安全内联（`shellSafe` 只处理空格）→ 直接 failed + 原样路径指引。
    const rootHostile = npmShell() ? shellHostileChars('cmd', root) : []
    if (rootHostile.length > 0) {
      return {
        ...base,
        status: 'failed',
        verify: null,
        error: `发行根路径含 cmd 元字符（${rootHostile.join(' ')}），npm 经 shell 调用不安全`,
        hint: `发行根原样路径：${root}——其中 ${rootHostile.join(' ')} 会被 cmd 解释，请手工执行 npm install -g（按 cmd 规则自行转义该路径）`,
      }
    }
    const install = await runCapture(
      npmExe(),
      ['install', '-g', shellSafe(root, npmShell()), '--no-audit', '--no-fund', '--ignore-scripts'],
      { env: process.env, timeoutMs: 180_000, shell: npmShell() },
    )
    if (install.error !== undefined || install.code !== 0) {
      // npm 的 bin 链接**不覆盖**已存在的、不属于它的同名可执行体（报 EEXIST）——
      // 这不是「重装失败」而是「落点被别的 prism 占着」，指引要能直接照做。
      const occupied = /EEXIST/i.test(install.stderr)
      return {
        ...base,
        status: 'failed',
        verify: null,
        error: `npm install -g 失败：${install.error ?? `退出码 ${String(install.code)}`}${install.stderr.trim() !== '' ? `（${firstLine(install.stderr)}）` : ''}`,
        hint: occupied
          ? `${manualHint(mode, layout, root)}；npm 报 EEXIST——${layout.prismExe} 已存在且不属于 npm，先移走它再重试`
          : manualHint(mode, layout, root),
      }
    }
  } else {
    const entry = repoEntry(root)
    // b-1（shim 侧）：入口路径含任一目标 shell 双引号内仍生效的元字符 → shim 内容无法
    // 安全内联（加引号不解决 `%VAR%`/`$()`/反引号）→ failed + 原样路径让人手写。
    for (const { name } of shimSpecs(layout, entry)) {
      const shell = shellOfShim(name)
      const chars = shellHostileChars(shell, entry)
      if (chars.length === 0) continue
      return {
        ...base,
        status: 'failed',
        verify: null,
        error: `CLI 入口路径含 ${shell} 元字符（${chars.join(' ')}），不写全局 shim`,
        hint: `入口路径原样：${entry}——其中 ${chars.join(' ')} 会被 ${shell} 解释，请按该 shell 规则手工转义后写入 ${join(layout.binDir, name)}`,
      }
    }
    // b-2：落点已有文件时，只有「本仓 shim」可覆写；外来文件保守不碰（与 package 态
    // 的 EEXIST 口径对齐——不删、不覆盖别人的文件，只报 failed + 「先移走」指引）。
    const foreign = foreignShim(layout, entry)
    if (foreign !== null) {
      return {
        ...base,
        status: 'failed',
        verify: null,
        error: `落点 ${foreign} 已存在且不是本仓 shim（外来文件），不覆写`,
        hint: `${manualHint(mode, layout, root)}；${foreign} 已存在且不属于本仓 shim，先移走它再重跑`,
      }
    }
    try {
      writeShims(layout, entry)
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        verify: null,
        error: `写全局 bin shim 失败：${message(error)}`,
        hint: manualHint(mode, layout, root),
      }
    }
  }

  // —— 验证（SPEC-5.2：解析全局 bin 绝对路径，在临时 cwd 下跑 --version）——
  const probe = await verify(layout, version)
  if (!probe.ok) {
    return { ...base, status: 'failed', verify: probe.output, error: probe.error, hint: manualHint(mode, layout, root) }
  }
  return { ...base, status: existed ? 'updated' : 'installed', verify: probe.output }
}

/** 文本模式的一行渲染（`--json` 走原对象）。 */
export function formatCliLine(cli: InitCliReport): string {
  const where = cli.installPath ?? '(未知)'
  switch (cli.status) {
    case 'skipped':
      return '⑤ CLI 全局注册: 已跳过（--skip-cli）'
    case 'unchanged':
      return `⑤ CLI 全局注册: 未变化（幂等）: ${where}（验证 ${cli.verify ?? ''}）`
    case 'installed':
      return `⑤ CLI 全局注册: 已安装${cli.mode === 'package' ? '（npm install -g）' : '（全局 bin shim）'} → ${where}（验证 ${cli.verify ?? ''}）`
    case 'updated':
      return `⑤ CLI 全局注册: 已更新 → ${where}（验证 ${cli.verify ?? ''}）`
    case 'failed':
      return `⑤ CLI 全局注册: 失败——${cli.error ?? ''}\n    手动指引：${cli.hint ?? ''}`
  }
}

/** 判定用的根目录：`PRISM_CLI_ROOT` 覆盖优先（**测试/CI 专用**），否则 `repoRoot` 向上查找。 */
function cliRoot(): string | null {
  const override = process.env['PRISM_CLI_ROOT']?.trim()
  if (override !== undefined && override !== '') return override
  return repoRoot(import.meta.url, 8)
}

/** 仓库态 shim 指向的 CLI 入口（`<仓库根>/packages/cli/dist/index.js`）。 */
function repoEntry(root: string): string {
  return join(root, 'packages', 'cli', 'dist', 'index.js')
}

/**
 * 写全局 bin shim（仓库态）。内容**确定性**——同一 root/entry 每次写法完全一致
 * （幂等 = 重写同内容）。Windows 写三件套（`prism` / `prism.cmd` / `prism.ps1`），
 * POSIX 写 `prism` 并补可执行位。清单与内容由 {@link shimSpecs} 单点给出。
 */
function writeShims(layout: GlobalBinLayout, entry: string): void {
  mkdirSync(layout.binDir, { recursive: true })
  for (const { name, content } of shimSpecs(layout, entry)) {
    writeFileSync(join(layout.binDir, name), content, 'utf-8')
  }
  if (!layout.shell) chmodSync(join(layout.binDir, 'prism'), 0o755)
}

/**
 * **b-2 冻结判据**：返回本次会写入的 shim 里**第一个**「已存在但不是本仓 shim」的落点
 * （无则 `null`）。判据 = 读到的内容（`\` 归一到 `/`）含 {@link REPO_ENTRY_MARKER}
 * （本仓入口路径片段）；**读不到（权限/IO）按外来保守处理**——宁可 failed 也不覆写。
 */
function foreignShim(layout: GlobalBinLayout, entry: string): string | null {
  for (const { name } of shimSpecs(layout, entry)) {
    const file = join(layout.binDir, name)
    if (!existsSync(file)) continue
    let content: string
    try {
      content = readFileSync(file, 'utf-8')
    } catch {
      return file // 不可读 → 保守按外来
    }
    if (!content.replaceAll('\\', '/').includes(REPO_ENTRY_MARKER)) return file
  }
  return null
}

/** 失败时的手动指引原文（SPEC-5.4：区分发行态与仓库态）。 */
export function manualHint(mode: 'package' | 'repo', layout: GlobalBinLayout | null, root: string): string {
  if (mode === 'package') {
    return `npm 不在 PATH 或安装未成功，可手动安装：npm install -g "${root}"（发行根就是运行目录，搬走后全局命令会断）`
  }
  const binDir = layout?.binDir ?? '<全局 bin 目录>'
  const entry = repoEntry(root)
  return (
    `可手动写全局 shim（三件套）：` +
    `${join(binDir, 'prism')} ← #!/bin/sh + exec node "${entry}" "$@"；` +
    `${join(binDir, 'prism.cmd')} ← @echo off + node "${entry}" %*；` +
    `${join(binDir, 'prism.ps1')} ← node "${entry}" $args`
  )
}

interface VerifyResult {
  ok: boolean
  output: string | null
  error?: string
}

/**
 * 验证（SPEC-5.2）：在 `os.tmpdir()` 临时 cwd 下执行**绝对路径**可执行体的 `--version`
 * （cwd 用临时目录只为证明「不依赖项目内 node_modules/.bin」），超时 30s，
 * 输出须含当前版本号。**绝不裸跑 PATH 上的 `prism`**。
 */
async function verify(layout: GlobalBinLayout, version: string): Promise<VerifyResult> {
  // Windows 的 .cmd 必须经 shell 执行（`shell: true` 不代为转义，含空格的路径自行加引号）
  const command = shellSafe(layout.prismExe, layout.shell)
  const probe = await runCapture(command, ['--version'], {
    env: process.env,
    cwd: tmpdir(),
    timeoutMs: 30_000,
    shell: layout.shell,
  })
  const output = probe.stdout.trim()
  if (probe.error !== undefined) {
    return { ok: false, output: output === '' ? null : output, error: `验证失败：${probe.error}` }
  }
  if (probe.code !== 0) {
    return { ok: false, output: output === '' ? null : output, error: `验证失败：退出码 ${String(probe.code)}` }
  }
  if (!output.includes(version)) {
    return { ok: false, output, error: `验证版本不符：期望 ${version}，实际 ${firstLine(output)}` }
  }
  return { ok: true, output }
}

interface CaptureResult {
  code: number | null
  stdout: string
  stderr: string
  error?: string
}

/** 起子进程收输出（不抛：ENOENT 走 `error` 字段、超时先 kill 再返回）。 */
function runCapture(
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; shell: boolean },
): Promise<CaptureResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    // timer 在 try 内赋值（spawn 成功才存在）；catch 路径不建 timer，finish 须判空
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: CaptureResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolvePromise(result)
    }
    try {
      const child = spawn(command, args, {
        env: opts.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        shell: opts.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      timer = setTimeout(() => {
        child.kill()
        finish({ code: null, stdout, stderr, error: `超时（${opts.timeoutMs}ms）` })
      }, opts.timeoutMs)
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', (error: Error) => finish({ code: null, stdout, stderr, error: error.message }))
      child.on('close', (code: number | null) => finish({ code, stdout, stderr }))
    } catch (error) {
      // 检视 b-3：spawn 同步抛（参数形态非法等罕见路径）也须落成 failed 报告——
      // SPEC-5.4「registerCli 永不抛」的兜底（此时尚未建 timer，直接 resolve）。
      resolvePromise({ code: null, stdout, stderr, error: message(error) })
    }
  })
}

/**
 * 含空格的路径在 `shell: true` 下须自行加引号（Node 只做拼接不转义，DEP0190），
 * 否则 `C:\Program Files\...` 会被 shell 拆成两段。
 */
function shellSafe(value: string, shell: boolean): string {
  return shell && value.includes(' ') ? `"${value}"` : value
}

/** 最后一行非空输出（npm 的正常输出在 stdout；有的版本会先吐注意事项）。 */
function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.length === 0 ? '' : lines[lines.length - 1]
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
