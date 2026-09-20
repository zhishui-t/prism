import { prismHome } from '@prism/core'
import {
  DEFAULT_SERVE_PORT,
  ensureServe,
  probeServe,
  serveLogPath,
  startServer,
  stopServe,
} from '@prism/server'
import type { AppHandle } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { harnessRootOverride } from '../argv.js'

/**
 * `prism serve` —— 四种形态：
 *
 * | 形态 | 行为 |
 * | :--- | :--- |
 * | 裸调用 | **前台阻塞**，Ctrl+C 退出（原行为） |
 * | `--ensure` | **幂等**确保后台运行：已在跑则复用；端口被别人占则报错；否则 detached 拉起 |
 * | `--check` | 只报告状态，**退出码即结论**（0=在跑 / 1=没跑），给脚本与宿主探测用 |
 * | `--stop` | 停止由 `--ensure` 拉起的后台控制台（只认自己写的 pid，不扫端口杀进程） |
 *
 * 「宿主用的时候自动拉起来」由 **MCP server 启动时调 `ensureServe`** 实现，
 * 本命令是同一套逻辑的人工入口——两条路共用一个实现，避免口径漂移。
 */
export async function runServe(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const rawPort = values.port
  const port = rawPort !== undefined ? Number(rawPort) : DEFAULT_SERVE_PORT
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    ctx.stderr(`错误 [bad_request] --port 必须为 1~65535 的整数: ${String(rawPort)}`)
    return 1
  }
  const host = values.host ?? '127.0.0.1'
  const home = ctx.home ?? prismHome()
  const { root } = harnessRootOverride(values)
  // 后台进程要和前台拿到同一份配置，否则「自定义 harness 根」在后台形态下会失效。
  const extraArgs = root !== undefined ? ['--harness-root', root] : []

  if (values.check === true) return await reportStatus(ctx, host, port)
  if (values.stop === true) return await stopBackground(ctx, home, host, port)
  if (values.ensure === true) return await ensureBackground(ctx, home, host, port, extraArgs)

  try {
    const app = await startServer({
      home,
      port,
      host,
      ...(root !== undefined ? { harnessRoot: root } : {}),
      // v9 F3 / C-8：回收站到期自动清除只在 serve 进程存在——启动 sweep 一次 + 每小时 purge
      // （定时器由 createApp 挂在 server 生命周期上：unref + close 清除）。
      // 纯 CLI 部署没有常驻进程，靠 `prism trash purge` 手动兜底（I-4）。
      trashSweep: true,
      // v14 检视批队长裁决①：常驻 serve 启动即异步预热两实例（首查不付 llama-server 冷启动）
      warmupModels: true,
    })
    ctx.stdout(`Prism serve 监听 http://${app.host}:${app.port}（home=${app.home}）`)
    ctx.stdout('按 Ctrl+C 停止；要后台常驻（重启后靠宿主/计划任务拉起）改用：prism serve --ensure')
    await waitForShutdown(app)
    return 0
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EADDRINUSE') {
      ctx.stderr(`错误 [bad_request] 端口 ${port} 已被占用；换一个：prism serve --port <其他端口>`)
      return 1
    }
    throw error
  }
}

/** `--check`：退出码就是结论，方便脚本 / 宿主 / 计划任务判断。 */
async function reportStatus(ctx: CommandContext, host: string, port: number): Promise<number> {
  const status = await probeServe(host, port)
  if (ctx.json === true) {
    ctx.stdout(JSON.stringify({ ok: true, value: status }))
    return status.alive ? 0 : 1
  }
  if (!status.alive) {
    ctx.stdout(`控制台未运行（http://${host}:${port}）`)
    return 1
  }
  ctx.stdout(`控制台运行中：http://${host}:${port}（version=${status.version ?? '未知'}）`)
  return 0
}

/** `--ensure`：已在跑直接复用，不重复起（多宿主 / 计划任务并发调用是安全的）。 */
async function ensureBackground(
  ctx: CommandContext,
  home: string,
  host: string,
  port: number,
  extraArgs: string[],
): Promise<number> {
  try {
    const result = await ensureServe({ home, host, port, extraArgs })
    if (result.alreadyRunning) {
      ctx.stdout(`控制台已在运行：${result.url}`)
      return 0
    }
    const pid = result.pid !== undefined ? `（pid=${result.pid}）` : ''
    ctx.stdout(`已在后台启动控制台：${result.url}${pid}`)
    ctx.stdout(`日志：${serveLogPath(home, port)}`)
    return 0
  } catch (error) {
    ctx.stderr(`错误 [serve_ensure_failed] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function stopBackground(ctx: CommandContext, home: string, host: string, port: number): Promise<number> {
  const result = await stopServe(home, host, port)
  if (result.stopped) {
    ctx.stdout(`已停止后台控制台（pid=${result.pid ?? '未知'}）`)
    return 0
  }
  ctx.stdout(`未停止：${result.reason ?? '未知原因'}`)
  return 1
}

/** 等 SIGINT/SIGTERM 后优雅关闭。 */
async function waitForShutdown(app: AppHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.off(signal, stop)
      }
      void app.close().then(() => {
        resolve()
      })
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, stop)
    }
  })
}
