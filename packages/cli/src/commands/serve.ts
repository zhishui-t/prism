import { startServer } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { harnessRootOverride } from '../argv.js'

/**
 * `prism serve [--port 7777] [--host <h>] [--harness-root <dir>]`：启动 HTTP 服务，Ctrl+C 退出。
 * 根目录仅在**显式指定**时透传，否则由 server 用激活适配器的默认根（支持插件 harness）。
 */
export async function runServe(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const port = values.port !== undefined ? Number(values.port) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    ctx.stderr(`错误 [bad_request] --port 必须为 1~65535 的整数: ${values.port}`)
    return 1
  }
  const host = values.host
  const { root } = harnessRootOverride(values)
  try {
    const app = await startServer({ home: ctx.home, port, host, ...(root !== undefined ? { zcodeDir: root } : {}) })
    ctx.stdout(`Prism serve 监听 http://${app.host}:${app.port}（home=${app.home}）`)
    ctx.stdout('按 Ctrl+C 停止')
    const untilSignal = new Promise<void>((resolve) => {
      const stop = (): void => {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          process.off(signal, stop)
        }
        void app.close().then(() => resolve())
      }
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, stop)
      }
    })
    await untilSignal
    return 0
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EADDRINUSE') {
      ctx.stderr(`错误 [bad_request] 端口 ${port ?? 7777} 已被占用；换一个：prism serve --port <其他端口>`)
      return 1
    }
    throw error
  }
}
