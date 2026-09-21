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
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

/**
 * 启动句柄：launcher 返回的**共享可变对象**（测试可注入替身，不必真起进程）。
 *
 * 为什么不是「返回 pid」：spawn 的失败是**异步** emit 的——`spawn()` 同步返回时 `pid`
 * 还是 `undefined`，`error`（ENOENT）要到下一 tick 才到、`exit`（早夭）同理。所以
 * 「启动失败」只能由 launcher 的事件处理器**原地写**进这个共享句柄，`ensureServe`
 * 在轮询里读它；同步返回值拿不到失败。
 */
export interface ServeLaunchHandle {
  pid?: number
  /** 启动失败（spawn error / 早夭 exit≠0）；由 launcher 的事件处理器原地写入 */
  failure?: Error
  /** 结束启动观测窗口：收口 launcher 打开的日志 fd（由 `ensureServe` 结束时统一调用一次） */
  dispose?: () => void
}

/** 监听器：返回**共享句柄**（测试可注入替身，不必真起进程）。 */
export type ServeLauncher = (argv: string[]) => ServeLaunchHandle

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

/**
 * 启动期失败的**兜底记账**：追加一行 `[prism-launch-error] <message>` 到
 * `serve-<port>.log`（与子进程 stderr 同一个文件，用户看日志时线索在一处）。
 *
 * 为什么另开 fd、不复用 spawn 传给子进程的那个：那个 fd 要活到运行期（由 `ensureServe`
 * 统一关）；在事件处理器里顺手关掉它，会让**后续**事件写已关的 fd 抛 EBADF。
 * 记账是尽力而为——失败通道（`handle.failure`）才是结论，写不进去也不掩盖根因。
 */
function appendLaunchError(logPath: string, message: string): void {
  try {
    const fd = openSync(logPath, 'a')
    try {
      appendFileSync(fd, `[prism-launch-error] ${message}\n`)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* 记账失败不致命：错误本身已进 failure 通道 */
  }
}

/**
 * 生产用启动器：`detached` 真起后台进程，stdout/stderr 落到 `serve-<port>.log`。
 *
 * `command` 可注入**只为测试**（真 spawn 一个必败命令来验 error 路径）；生产调用一律
 * 用缺省的 `process.execPath`，行为与注入前逐字节一致。
 */
export function defaultLaunch(home: string, port: number, command: string = process.execPath): ServeLauncher {
  return (argv) => {
    const logPath = serveLogPath(home, port)
    const handle: ServeLaunchHandle = {}

    let logFd: number
    try {
      logFd = openSync(logPath, 'a')
    } catch (error) {
      // 日志都打不开 = 同步可判的启动失败，不必再 spawn
      handle.failure = error instanceof Error ? error : new Error(String(error))
      return handle
    }

    // 「启动观测窗口」：窗口内（= 还没拿到结论）的 error/exit 才算**启动**失败。
    // 窗口由 ensureServe 收口（成功 / 失败 / 超时都会调 dispose）——此后进程退出是
    // **运行期**的事（`prism serve --stop` 在 Windows 上就是非零退出码），不记启动账。
    let observing = true
    handle.dispose = () => {
      observing = false
      try {
        closeSync(logFd)
      } catch {
        /* 已关 / 无效 fd 不致命 */
      }
    }

    const recordFailure = (message: string): void => {
      if (!observing) return
      // 先到先记：ENOENT 只有 error、早夭只有 exit，但两者都可能到（Node 不保证互斥）——
      // 首条定 failure 通道，记账也只记首条：同一次失败恰一行，SPEC-1.2/1.3 的行数断言平台无关。
      if (handle.failure !== undefined) return
      handle.failure = new Error(message)
      appendLaunchError(logPath, message)
    }

    const child = spawn(command, argv, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...process.env, PRISM_HOME: home },
    })
    // 事件选择：`error` + `exit`，**不挂 `close`**——ENOENT 只发 error+close（没有 exit），
    // 挂 close 会把同一次失败记两遍。
    child.on('error', (error) => {
      recordFailure(`spawn 失败：${error.message}`)
    })
    child.on('exit', (code, signal) => {
      // code=0 = 正常退出；code=null = 被信号终止——都不是「启动失败」
      if (code === null || code === 0) return
      recordFailure(`进程提前退出：code=${String(code)} signal=${signal ?? '-'}`)
    })
    child.unref()
    if (child.pid !== undefined) handle.pid = child.pid
    return handle
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
  // ⚠ 保留**整句柄**、不要解构 `{ pid }`：解构会丢掉 failure 通道——失败是事件处理器
  // 异步写进句柄的，只有句柄本身在轮询里可见。
  const handle = launch(backgroundServeArgv(home, host, port, options.extraArgs ?? []))
  const pid = handle.pid

  const deadline = Date.now() + waitMs
  try {
    while (Date.now() < deadline) {
      await delay(200)
      // **快失败**：launcher 的 error/exit 处理器已把原因写进句柄 → 立刻抛，不干等 waitMs。
      // 判据钉死为「failure 已置」而非「pid 为空」——后者会被「日志还没落盘」这类时序骗到。
      if (handle.failure !== undefined) {
        throw new Error(
          `后台控制台启动失败（spawn_failed）：${handle.failure.message}\n` +
            `  看日志：${logPath}\n  前台排查：prism serve --port ${port}`,
        )
      }
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
  } finally {
    // fd 生命周期收口：launcher 打开的日志 fd 不在 spawn 后即关（子进程要一直写它），
    // 由这里统一关闭——成功 / 失败 / 超时三条路径都会走到。
    handle.dispose?.()
  }
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
