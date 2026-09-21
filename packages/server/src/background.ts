/**
 * 后台 serve 入口 —— 由 `ensureServe()`（`prism serve --ensure`，或宿主启动时 MCP
 * 顺带调用）以 **detached** 方式拉起。
 *
 * 只做三件事：解析参数、起 HTTP 服务、保持存活直到收到信号。
 * stdout/stderr 会被拉起方重定向到 `<PRISM_HOME>/state/serve-<port>.log`，
 * 所以这里可以放心打日志——它**不是** MCP 的 JSON-RPC 通道。
 *
 * 另：进程退出时还会往 `<home>/state/background-exit-<port>.log` 追加一条退出记录
 * （时间 / 退出码 / stderr 尾），补上 v14 实录缺的「退出码 + 时间戳」。
 * 见 `installBackgroundExitLog` 与文件末尾的**残余限制**。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { prismHome } from '@prism/core'

import { startServer } from './app.js'

// ————————————————————————————————————————————————————————————————
// 退出日志（SPEC-3.1–3.4 / design-v15 §3）
// ————————————————————————————————————————————————————————————————

/** stderr 环形缓冲容量：退出记录里最多保留这么多字节的 stderr 尾（SPEC-3.1 的「尾 ~4KB」）。 */
export const EXIT_LOG_STDERR_TAIL_BYTES = 4 * 1024

/** 退出日志文件上限：超出即截断保尾，防无限增长（SPEC-3.3）。 */
export const EXIT_LOG_MAX_BYTES = 64 * 1024

/** 截断后留在文件首行的标记（人类可读；写入前先剔除，保证多次截断不堆叠）。 */
export const EXIT_LOG_TRUNCATION_MARK = '… 【前部已截断，仅保留尾部】\n'

/**
 * 退出日志路径：**按端口分文件**，防多实例并发退出互踩（SPEC-3.3 / S-6）。
 * 落 `<home>/state/`，沿 `serve-<port>.log` 的既有先例（不另建 runtime/）。
 */
export function backgroundExitLogPath(home: string, port: number): string {
  return join(home, 'state', `background-exit-${port}.log`)
}

/** 按 UTF-8 字节取尾部（对齐到字符边界，避免留下半个多字节字符）。 */
export function keepTailBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const raw = Buffer.from(text, 'utf8')
  // 从字节尾部切可能落在多字节字符中间——去掉开头被判为「替换字符」的残片
  return raw.subarray(raw.length - maxBytes).toString('utf8').replace(/^\uFFFD+/, '')
}

/** 退出时读 stderr 尾的取数口（返回此刻缓冲里的内容）。 */
export interface StderrTail {
  tail(): string
}

/**
 * **启动即挂**的 stderr 环形缓冲（SPEC-3.4）：只缓冲、不写盘，退出时才落盘。
 *
 * 透明转发给原 `write`——stderr 的可见行为与吞吐**完全不变**（零侵入）。
 */
export function captureStderrTail(capacity: number = EXIT_LOG_STDERR_TAIL_BYTES): StderrTail {
  let buffered = ''
  const original = process.stderr.write
  const patched = ((chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      buffered +=
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (Buffer.byteLength(buffered, 'utf8') > capacity) buffered = keepTailBytes(buffered, capacity)
    } catch {
      // 缓冲失败绝不能影响进程本身：stderr 才是真相输出通道
    }
    return (original as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest)
  }) as typeof process.stderr.write
  process.stderr.write = patched
  return { tail: () => buffered }
}

export interface ExitLogInput {
  at: Date
  /** `process.on('exit')` 给的退出码；被信号终止时可能为 null。 */
  code: number | null
  /** 进程收到的停止信号（POSIX 下 SIGINT/SIGTERM；Windows 后台进程收不到，见文件末尾）。 */
  signal: NodeJS.Signals | null
  port: number
  stderrTail: string
}

/**
 * 一条退出记录。**正常退出只记一行**（SPEC-3.2：时间/信号）；异常退出记全量
 * （SPEC-3.1：时间/退出码/stderr 尾）。判据：`code === 0` 视为正常。
 */
export function formatExitEntry(input: ExitLogInput): string {
  const ts = input.at.toISOString()
  const signal = input.signal ?? '-'
  if (input.code === 0) return `${ts} [port ${input.port}] 正常退出 code=0 signal=${signal}\n`
  const code = input.code === null ? 'null' : String(input.code)
  const head = `${ts} [port ${input.port}] 异常退出 code=${code} signal=${signal}\n`
  const tail = input.stderrTail
  if (tail.trim() === '') return head
  return (
    `${head}--- stderr 尾（≤ ${EXIT_LOG_STDERR_TAIL_BYTES}B）---\n` +
    `${tail}${tail.endsWith('\n') ? '' : '\n'}--- stderr 尾结束 ---\n`
  )
}

/** 超限则只保留尾部（对齐行首），并在首行加一条**幂等**标记；结果**不超过** `maxBytes`。 */
export function truncateExitLog(text: string, maxBytes: number = EXIT_LOG_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  // 旧标记先剔除再重加：反复截断不会让标记在文件里越堆越多
  const body = text.split(EXIT_LOG_TRUNCATION_MARK).join('')
  const budget = Math.max(0, maxBytes - Buffer.byteLength(EXIT_LOG_TRUNCATION_MARK, 'utf8'))
  let tail = keepTailBytes(body, budget)
  const newline = tail.indexOf('\n') // 从行首起，避免留下半行
  if (newline !== -1) tail = tail.slice(newline + 1)
  return EXIT_LOG_TRUNCATION_MARK + tail
}

/**
 * 同步追加一条退出记录，并把文件裁到 {@link EXIT_LOG_MAX_BYTES} 以内（保尾）。
 *
 * **必须同步**：只在 `process.on('exit')` 里调用——exit 钩子不允许异步 IO（写了也不会被等待）。
 */
export function appendExitLog(home: string, port: number, entry: string): void {
  const file = backgroundExitLogPath(home, port)
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, entry, 'utf8')
  const text = readFileSync(file, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > EXIT_LOG_MAX_BYTES) {
    writeFileSync(file, truncateExitLog(text), 'utf8')
  }
}

export interface ExitLogWiring {
  home: string
  port: number
  stderrTail: () => string
  signal: () => NodeJS.Signals | null
}

/** 挂 `exit` 钩子：退出瞬间同步落一条记录（写失败也绝不改变退出码）。 */
export function installBackgroundExitLog(wiring: ExitLogWiring): void {
  process.on('exit', (code) => {
    try {
      appendExitLog(
        wiring.home,
        wiring.port,
        formatExitEntry({
          at: new Date(),
          code,
          signal: wiring.signal(),
          port: wiring.port,
          stderrTail: wiring.stderrTail(),
        }),
      )
    } catch {
      // exit 阶段无处上报：写日志失败也只能吞掉，不能掩盖真实退出原因
    }
  })
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** 收到的停止信号（下方 SIGINT/SIGTERM 处理器写入）；供退出日志记「以何信号退出」（SPEC-3.2）。 */
let exitSignal: NodeJS.Signals | null = null

async function main(): Promise<void> {
  const port = Number(argValue('port') ?? 7777)
  const host = argValue('host') ?? '127.0.0.1'
  // home **与 startServer 同源解析**——`--home` 参数优先、其次 `PRISM_HOME`（即 app.ts 的
  // `options.home ?? prismHome()`，这里解析一次后显式下传，不再有第二套规则）。
  // 重定向场景下退出日志绝不能写到别处（S-6）。
  const home = argValue('home') ?? prismHome()
  const harnessRoot = argValue('harness-root')

  // SPEC-3.4：**启动即挂** stderr 环形缓冲 + 退出钩子（此刻只缓冲，退出时才落盘）。
  // 刻意排在端口校验**之前**——「参数非法 / 启动失败」这类异常退出，正是 v14 缺的那条线索
  // （实录：有启动横幅、无错误行、无退出码）。
  const stderr = captureStderrTail()
  installBackgroundExitLog({
    home,
    // 端口非法时本就没有「实例」可分：退化为 0（文件名仅供归档，不假装它服务过）
    port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0,
    stderrTail: stderr.tail,
    signal: () => exitSignal,
  })

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port 必须为 1~65535 的整数: ${String(argValue('port'))}`)
  }

  const app = await startServer({
    home,
    port,
    host,
    ...(harnessRoot !== undefined ? { harnessRoot } : {}),
    // v14 检视批队长裁决①：后台常驻同样启动即预热两模型实例（与前台 serve 同口径）
    warmupModels: true,
  })
  process.stdout.write(`prism serve (background) 监听 http://${app.host}:${app.port}（home=${app.home}）\n`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      exitSignal = signal
      void app.close().then(() => {
        process.exit(0)
      })
    })
  }
  // 前台挂住：后台进程的生命周期交给信号控制，不主动退出。
  await new Promise<void>(() => {
    /* 永不 resolve——进程由信号终止 */
  })
}

// ————————————————————————————————————————————————————————————————
// 残余限制（SPEC-3.3 / S-5：**不把承诺说满**）
//
// 1. 外部**硬杀**（Windows `TerminateProcess` / POSIX `SIGKILL`）直接终止进程，Node 不会
//    触发 `exit` 事件，本日志也就不会产生——in-process 钩子的固有边界，不是缺陷。
//    ⚠ Windows 上 `process.kill(pid)`（`prism serve --stop` 走的正是它）实测属此类：
//    子进程报告 signal=SIGTERM，但**信号处理器不执行、`exit` 不触发**。故 Windows 后台
//    常驻被 `--stop` 停掉时不会有退出记录；「正常退出」一行只在硬杀之外出现
//    （POSIX 信号 / 前台 Ctrl+C）。
// 2. ~~parent 侧 spawn 失败静默~~（**已修复，v16 B-1 / R-1**）：serve-control 的
//    `defaultLaunch` 现挂 `error`+`exit`（不挂 `close`，避免 ENOENT 双记账），把失败原地写进
//    共享句柄，并追加一行 `[prism-launch-error] <原因>` 到 `serve-<port>.log`（本模块
//    stderr 的去处，线索集中一处）；`ensureServe` 在轮询里 poll 该句柄，置位即抛
//    `spawn_failed`，不再干等 30s。
// ————————————————————————————————————————————————————————————————

// 直接以本文件为入口运行时才启动服务（`node dist/background.js …`）。
// 守卫与 `mcp/server.ts` 同款——这样本模块可被测试 import 取纯函数而不真起服务。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`[background] 启动失败: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
