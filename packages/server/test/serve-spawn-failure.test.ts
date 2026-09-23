/**
 * SPEC-1.1–1.4 ＋真 spawn 集成口补充：后台 serve 的**启动快失败**（v16 B-1 / R-1）。
 *
 * 现状缺口：`defaultLaunch` 起完就 `unref() + return pid`，spawn 的 `error` 事件**没人挂**
 * ——spawn 失败（ENOENT / 早夭）时父进程只会干等 30s 报「未就绪」，日志里也无线索。
 *
 * 修法（已审核钉死）：
 * - launcher 返回**共享可变句柄** `{ pid?, failure?, dispose? }`——失败是**异步** emit 的，
 *   同步返回值里拿不到，只能由 error/exit 处理器**原地写**进句柄；
 * - `defaultLaunch` 在处理器内 `openSync → appendFileSync → closeSync` 记一行
 *   `[prism-launch-error] <原因>`（另开 fd：spawn 那个 fd 归 `ensureServe` 收口）；
 * - `ensureServe` 保留**整句柄**（不解构），在既有 200ms 轮询里 poll failure，置位即抛
 *   `spawn_failed`，不干等 waitMs。
 *
 * 三层验证：**替身**（时序确定性最好）+ **真 spawn**（defaultLaunch 的 error / exit 两条
 * 事件路径）+ **正常路径回归**（行为与现状一致）。R5：home 一律临时目录，不碰真实宿主。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  backgroundServeArgv,
  defaultLaunch,
  ensureServe,
  serveLogPath,
  serveStatePath,
  type ServeLaunchHandle,
} from '../src/serve-control.js'

// 临时目录前缀说明（C-10⑤ 反注更正）：global-tmp-reaper（vitest globalSetup）在 setup 时给
// `tmpdir()/prism-*` 拍**基线快照**，teardown 只删**本轮新增**的条目（已存在的绝不碰），且发生在
// 全部测试跑完之后——**不会在跑测途中断掉本轮目录**。故 `prism-` 前缀其实可被自动回收，并无
// 「被一并清掉」之虞；本文件仍用独立前缀（便于人工分辨）+ afterAll 自行清理。
const cleanup: string[] = []

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'serve-spawn-'))
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

/**
 * 「像 Prism」的服务（`/api/health` 回真信封）。**不自动 listen**——由测试放进 launch 回调里
 * 拉起，复刻真实时序「先 spawn、后台进程随后才监听」；否则 `ensureServe` 第一步就会判
 * `alreadyRunning`，测不到「本次真的拉起来」这条路径。
 */
function fakePrism(): { listen: (port: number) => Promise<void>; close: () => Promise<void> } {
  const server = createServer((req, res) => {
    if (req.url !== '/api/health') {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, value: { version: '16.1.0', home: 'X:/h' } }))
  })
  return {
    listen: (port) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** 等条件成立（轮询，别用裸 sleep 测异步）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`条件在 ${timeoutMs}ms 内未成立`)
}

/** 取 `ensureServe` 抛出的错误（自己收，便于同时断言「耗时」）。 */
async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error('预期抛出，但没有抛出')
}

/** 日志里的失败记账行。 */
function launchErrorLines(home: string, port: number): string[] {
  return readFileSync(serveLogPath(home, port), 'utf8')
    .split('\n')
    .filter((line) => line.includes('[prism-launch-error]'))
}

describe('SPEC-1.1 failure 已置 → ensureServe 快失败（不干等 waitMs）', () => {
  it('替身在下一 tick 置 failure → 立刻抛 spawn_failed（带原因），耗时远小于 waitMs', async () => {
    const home = await tempHome()
    const port = await freePort()
    const startedAt = Date.now()

    const error = await failureOf(
      ensureServe({
        home,
        host: '127.0.0.1',
        port,
        waitMs: 30_000,
        launch: () => {
          const handle: ServeLaunchHandle = {}
          // 复刻真 spawn 的时序：同步返回时拿不到失败，error 下一 tick 才到
          queueMicrotask(() => {
            handle.failure = new Error('spawn /nope ENOENT')
          })
          return handle
        },
      }),
    )

    expect(error.message).toContain('spawn_failed')
    expect(error.message).toContain('spawn /nope ENOENT')
    expect(error.message).toContain(serveLogPath(home, port)) // 报错要能指到日志
    expect(Date.now() - startedAt).toBeLessThan(5_000) // 不是 30s
  }, 20_000)

  it('超时路径之外的判据是 failure 而非 pid：pid 有值但 failure 置位同样快抛', async () => {
    const home = await tempHome()
    const port = await freePort()

    const error = await failureOf(
      ensureServe({
        home,
        host: '127.0.0.1',
        port,
        waitMs: 30_000,
        launch: () => {
          const handle: ServeLaunchHandle = { pid: 4242 } // pid 拿到了，但进程随后早夭
          queueMicrotask(() => {
            handle.failure = new Error('进程提前退出：code=7 signal=-')
          })
          return handle
        },
      }),
    )

    expect(error.message).toContain('spawn_failed')
    expect(error.message).toContain('code=7')
  }, 20_000)
})

describe('SPEC-1.2/1.3 真 spawn 失败：快抛 + 记账到 serve-<port>.log', () => {
  it('SPEC-1.2 spawn error（不存在的可执行体）→ 快抛 + [prism-launch-error] 追加', async () => {
    const home = await tempHome()
    const port = await freePort()
    const startedAt = Date.now()

    const error = await failureOf(
      ensureServe({
        home,
        host: '127.0.0.1',
        port,
        waitMs: 30_000,
        launch: defaultLaunch(home, port, join(home, 'no-such-binary-xyz')),
      }),
    )

    expect(error.message).toContain('spawn_failed')
    expect(error.message).toContain('ENOENT')
    expect(Date.now() - startedAt).toBeLessThan(5_000)

    const lines = launchErrorLines(home, port)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[prism-launch-error] spawn 失败')
    expect(lines[0]).toContain('ENOENT')
    // 失败路径不该留下「已启动」的状态记录（没有可用 pid）
    expect(existsSync(serveStatePath(home, port))).toBe(false)
  }, 20_000)

  it('SPEC-1.3 早夭 exit≠0 → 快抛 + 记账一次（不挂 close，不双记）', async () => {
    const home = await tempHome()
    const port = await freePort()
    const startedAt = Date.now()

    const error = await failureOf(
      ensureServe({
        home,
        host: '127.0.0.1',
        port,
        waitMs: 30_000,
        // 真 spawn 一个必败命令：node <不存在的脚本> → 进程立刻以非 0 退出（走 exit，不是 error）
        launch: () => defaultLaunch(home, port)([join(home, 'no-such-script.js')]),
      }),
    )

    expect(error.message).toContain('spawn_failed')
    expect(error.message).toContain('进程提前退出')
    expect(error.message).toContain('code=1')
    expect(Date.now() - startedAt).toBeLessThan(5_000)

    // 只记一次：ENOENT 会同时发 error+close，挂 close 就会双记账
    const lines = launchErrorLines(home, port)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[prism-launch-error] 进程提前退出')
    expect(existsSync(serveStatePath(home, port))).toBe(false)
  }, 20_000)
})

describe('SPEC-1.4 正常路径回归（行为与现状一致）', () => {
  it('健康服务就绪 → started=true + 写状态文件 + dispose 收口一次 + 无失败记账', async () => {
    const home = await tempHome()
    const port = await freePort()
    const prism = fakePrism()
    let disposed = 0
    try {
      const result = await ensureServe({
        home,
        host: '127.0.0.1',
        port,
        waitMs: 5_000,
        launch: () => {
          void prism.listen(port).catch(() => undefined) // 后台进程「起来之后」才开始监听
          return {
            pid: 4321,
            dispose: () => {
              disposed += 1
            },
          }
        },
      })

      expect(result).toEqual({
        alreadyRunning: false,
        started: true,
        pid: 4321,
        url: `http://127.0.0.1:${port}`,
        logPath: serveLogPath(home, port),
      })
      const record = JSON.parse(readFileSync(serveStatePath(home, port), 'utf8')) as Record<string, unknown>
      expect(record).toMatchObject({ pid: 4321, host: '127.0.0.1', port })
      expect(typeof record.startedAt).toBe('string')
      // fd 生命周期：启动观测窗口由 ensureServe 收口（成功路径同样要关）
      expect(disposed).toBe(1)
      expect(existsSync(serveLogPath(home, port))).toBe(false) // 成功路径不写失败记账
    } finally {
      await prism.close()
    }
  }, 20_000)

  it('超时路径照旧：未就绪 → 报「未就绪」，且 dispose 仍被调用', async () => {
    const home = await tempHome()
    const port = await freePort()
    let disposed = 0

    const error = await failureOf(
      ensureServe({
        home,
        host: '127.0.0.1',
        port,
        waitMs: 300,
        launch: () => ({
          pid: 4242,
          dispose: () => {
            disposed += 1
          },
        }),
      }),
    )

    expect(error.message).toContain('未就绪')
    expect(error.message).toContain(serveLogPath(home, port))
    expect(disposed).toBe(1)
  }, 20_000)
})

describe('SPEC-1.2/1.3 补充：真 spawn 集成口（defaultLaunch 的句柄层行为；无独立 SPEC 号）', () => {
  it('spawn error：同步返回拿不到失败，error 下一 tick 才写进句柄', async () => {
    const home = await tempHome()
    const port = await freePort()
    mkdirSync(join(home, 'state'), { recursive: true })

    const handle = defaultLaunch(home, port, join(home, 'no-such-binary-xyz'))(
      backgroundServeArgv(home, '127.0.0.1', port),
    )

    // 关键时序：这就是「必须返回共享句柄、不能返回 pid」的原因
    expect(handle.pid).toBeUndefined()
    expect(handle.failure).toBeUndefined()

    await waitFor(() => handle.failure !== undefined)
    expect(handle.failure?.message).toContain('ENOENT')
    expect(launchErrorLines(home, port)).toHaveLength(1)

    handle.dispose?.()
  }, 20_000)

  it('早夭 exit≠0：走 exit 路径（error 不触发），写进句柄且只记一次', async () => {
    const home = await tempHome()
    const port = await freePort()
    mkdirSync(join(home, 'state'), { recursive: true })

    const handle = defaultLaunch(home, port)([join(home, 'no-such-script.js')])
    await waitFor(() => handle.failure !== undefined)

    expect(handle.failure?.message).toContain('进程提前退出')
    expect(handle.failure?.message).toContain('code=1')
    expect(launchErrorLines(home, port)).toHaveLength(1)

    handle.dispose?.()
  }, 20_000)

  it('观测窗口收口后（dispose）进程再以非 0 退出 → 不记启动账（运行期退出不属于启动失败）', async () => {
    const home = await tempHome()
    const port = await freePort()
    mkdirSync(join(home, 'state'), { recursive: true })

    // 真起一个「稍后以 code=3 退出」的进程，模拟 `--stop` 那类**运行期**退出
    const handle = defaultLaunch(home, port)(['-e', 'setTimeout(() => process.exit(3), 300)'])
    handle.dispose?.() // = ensureServe 已拿到结论（成功 / 失败 / 超时）后收口

    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(handle.failure).toBeUndefined()
    expect(launchErrorLines(home, port)).toHaveLength(0)
  }, 20_000)
})

describe('C-10④⑨ defaultLaunch 句柄层边界：日志 fd 打不开 / spawn 同步抛', () => {
  it('C-10④ 日志 fd 打不开（<home>/state 不存在）→ 同步判失败、不 spawn、无 fd 可收口', async () => {
    const home = await tempHome() // 故意不建 state/ 子目录 → openSync ENOENT
    const port = await freePort()

    const handle = defaultLaunch(home, port)(backgroundServeArgv(home, '127.0.0.1', port))

    expect(handle.failure).toBeInstanceOf(Error)
    expect(handle.failure?.message).toContain('ENOENT')
    expect(handle.pid).toBeUndefined() // 未走到 spawn
    expect(handle.dispose).toBeUndefined() // 未打开 fd → 无收口函数
  }, 20_000)

  it('C-10⑨ spawn 同步抛（空 command）→ 收口日志 fd 并走 failure 通道（不外抛）', async () => {
    const home = await tempHome()
    const port = await freePort()
    mkdirSync(join(home, 'state'), { recursive: true })

    // 空 command → node spawn 同步抛（ERR_INVALID_ARG_VALUE，不产生子进程）；修前该异常会逃出
    // launcher（跳过 ensureServe 的 dispose）→ 已 openSync 的日志 fd 泄漏。
    const handle = defaultLaunch(home, port, '')(backgroundServeArgv(home, '127.0.0.1', port))

    expect(handle.pid).toBeUndefined()
    expect(handle.failure).toBeInstanceOf(Error)
    expect(handle.failure?.message).toContain('spawn 同步失败')
    expect(handle.failure?.message).toContain('cannot be empty')

    // 记账走同一条 appendLaunchError：日志里恰一行，含原因
    const lines = launchErrorLines(home, port)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[prism-launch-error] spawn 同步失败')
    expect(lines[0]).toContain('cannot be empty')

    // fd 已收口：dispose 再调不抛（幂等，不会因二次 close 炸 EBADF）
    expect(() => handle.dispose?.()).not.toThrow()
  }, 20_000)

  it('C-10⑨ 集成：ensureServe 经 defaultLaunch 命中同步抛 → 快抛 spawn_failed（带日志路径）', async () => {
    const home = await tempHome()
    const port = await freePort()
    const startedAt = Date.now()

    const error = await failureOf(
      ensureServe({ home, host: '127.0.0.1', port, waitMs: 30_000, launch: defaultLaunch(home, port, '') }),
    )

    expect(error.message).toContain('spawn_failed')
    expect(error.message).toContain('spawn 同步失败')
    expect(error.message).toContain(serveLogPath(home, port)) // 报错要能指到日志
    expect(existsSync(serveStatePath(home, port))).toBe(false) // 失败路径不留「已启动」记录
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  }, 20_000)
})
