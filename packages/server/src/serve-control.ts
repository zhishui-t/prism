/**
 * 控制台（HTTP serve）的**按需拉起**与生命周期管理。
 *
 * 为什么需要它：`prism serve` 原本只有「前台阻塞」一种形态，宿主（WorkBuddy / ZCode）
 * 启动时没有可靠办法把控制台带起来——用户感知就是「重启后 Prism 没启动」。
 * 本模块提供**幂等**的后台启停，供 CLI（`serve --ensure|--check|--stop`）与
 * MCP server（启动时顺带 ensure）共用同一套实现，避免两处口径漂移。
 *
 * 两条硬约束：
 * 1. **必须确认是 Prism**（探 `/api/health`）才算「已在运行」——只看端口占用会把
 *    别的程序误判成自己的服务。
 * 2. 后台进程一律 `detached + stdio 重定向到日志文件`——MCP 的 stdout 是 JSON-RPC
 *    通道，任何输出污染都会破坏协议。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 后台 serve 的入口文件（随 `@prism/server` 一起分发）。
 * 用 `import.meta.url` 定位——开发布局（`src/`）与打包布局（`dist/`）同解，
 * 因此不受「算相对仓库根的路径」那种层级漂移的影响。
 */
export const backgroundServeEntry = fileURLToPath(new URL('./background.js', import.meta.url))

/** 控制台缺省端口（与 `app.ts` 的 `DEFAULT_PORT` 同值；CLI / MCP 共用一处定义，别各写各的）。 */
export const DEFAULT_SERVE_PORT = 7777

/** 控制台状态快照。 */
export interface ServeStatus {
  /** 只有**确认 Prism 在跑**才为 true */
  alive: boolean
  host: string
  port: number
  version?: string
  home?: string
}

/** 后台服务记录（pid/日志位置），供 `--stop` 定位进程。 */
export interface ServeRecord {
  pid?: number
  host: string
  port: number
  startedAt: string
}

export function serveStatePath(home: string, port: number): string {
  return join(home, 'state', `serve-${port}.json`)
}

export function serveLogPath(home: string, port: number): string {
  return join(home, 'state', `serve-${port}.log`)
}

/** 监听器：返回 pid 即可（测试可注入替身，不必真起进程）。 */
export type ServeLauncher = (argv: string[]) => { pid?: number }

export interface EnsureServeOptions {
  home: string
  host: string
  port: number
  /** 等待就绪的上限（ms），默认 30s */
  waitMs?: number
  /** 透传给后台进程的额外参数（如 `--harness-root <dir>`，保证后台进程与前台同配置） */
  extraArgs?: string[]
  /** 注入点：单测用替身启动器 */
  launch?: ServeLauncher
}

export interface EnsureServeResult {
  /** 探测时已经在跑 */
  alreadyRunning: boolean
  /** 本次真的拉起来了 */
  started: boolean
  pid?: number
  url: string
  logPath: string
}

export interface StopServeResult {
  stopped: boolean
  pid?: number
  reason?: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** TCP 探测端口是否有监听——**不区分是谁**，仅用于区分「端口被占」与「空着」。 */
async function portInUse(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host, port })
    const finish = (value: boolean): void => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 健康探测：请求 `/api/health` 并校验信封，**只有确认是 Prism 才判 alive**。
 * 端口被占但响应不是 Prism 信封时返回 `alive: false`，由调用方给出「被别的程序占用」的报错。
 */
export async function probeServe(host: string, port: number, timeoutMs = 1500): Promise<ServeStatus> {
  const base: ServeStatus = { alive: false, host, port }
  try {
    const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return base
    const body = (await res.json()) as { ok?: unknown; value?: { version?: unknown; home?: unknown } }
    if (body.ok !== true || typeof body.value?.version !== 'string') return base
    return {
      alive: true,
      host,
      port,
      version: body.value.version,
      ...(typeof body.value.home === 'string' ? { home: body.value.home } : {}),
    }
  } catch {
    return base
  }
}

function defaultLaunch(home: string, port: number): ServeLauncher {
  return (argv) => {
    const logFd = openSync(serveLogPath(home, port), 'a')
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...process.env, PRISM_HOME: home },
    })
    child.unref()
    return child.pid === undefined ? {} : { pid: child.pid }
  }
}

/** 后台进程的命令行（可注入测试；也便于文档/日志展示真实命令）。 */
export function backgroundServeArgv(
  home: string,
  host: string,
  port: number,
  extraArgs: string[] = [],
): string[] {
  return [backgroundServeEntry, '--port', String(port), '--host', host, '--home', home, ...extraArgs]
}

/**
 * 幂等确保控制台在跑：已在跑→复用；端口被别人占→报错；否则**后台**拉起并等待就绪。
 * 抛出的是「用户可据此行动」的错误（换端口 / 手工前台排查）。
 */
export async function ensureServe(options: EnsureServeOptions): Promise<EnsureServeResult> {
  const { home, host, port } = options
  const waitMs = options.waitMs ?? 30_000
  const url = `http://${host}:${port}`
  const logPath = serveLogPath(home, port)

  if ((await probeServe(host, port)).alive) {
    return { alreadyRunning: true, started: false, url, logPath }
  }

  if (await portInUse(host, port)) {
    throw new Error(
      `端口 ${port} 已被**其他程序**占用（不是 Prism 服务）；换端口：prism serve --ensure --port <其他>`,
    )
  }

  mkdirSync(dirname(serveStatePath(home, port)), { recursive: true })
  const launch = options.launch ?? defaultLaunch(home, port)
  const { pid } = launch(backgroundServeArgv(home, host, port, options.extraArgs ?? []))

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(200)
    if ((await probeServe(host, port, 800)).alive) {
      const record: ServeRecord = {
        ...(pid !== undefined ? { pid } : {}),
        host,
        port,
        startedAt: new Date().toISOString(),
      }
      writeFileSync(serveStatePath(home, port), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      return { alreadyRunning: false, started: true, ...(pid !== undefined ? { pid } : {}), url, logPath }
    }
  }

  throw new Error(
    `后台控制台在 ${waitMs}ms 内未就绪（启动可能失败）。\n  看日志：${logPath}\n  前台排查：prism serve --port ${port}`,
  )
}

/**
 * 停止由 `--ensure` 拉起的后台控制台。
 * 只认自己写的 pid 文件——**不去扫端口杀进程**，避免误杀别的程序。
 */
export async function stopServe(home: string, host: string, port: number): Promise<StopServeResult> {
  const file = serveStatePath(home, port)
  if (!existsSync(file)) {
    const alive = await probeServe(host, port)
    return {
      stopped: false,
      reason: alive.alive
        ? `端口 ${port} 上有 Prism 在跑，但没有 ${file} 记录（不是由 --ensure 拉起的），无法定位进程`
        : `没有后台服务记录（${file} 不存在），端口 ${port} 上也没有 Prism 在跑`,
    }
  }

  let pid: number | undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
    if (typeof raw.pid === 'number') pid = raw.pid
  } catch {
    /* 文件损坏按无 pid 处理，走下面的清理分支 */
  }

  if (pid === undefined) {
    rmSync(file, { force: true })
    return { stopped: false, reason: '状态文件里没有可用 pid（已清理该文件）' }
  }

  try {
    process.kill(pid)
  } catch {
    rmSync(file, { force: true })
    return { stopped: false, pid, reason: `进程 ${pid} 已不存在（状态文件已清理）` }
  }

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await delay(150)
    if (!(await probeServe(host, port, 600)).alive) break
  }
  rmSync(file, { force: true })
  return { stopped: true, pid }
}
