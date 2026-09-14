/**
 * 后台 serve 入口 —— 由 `ensureServe()`（`prism serve --ensure`，或宿主启动时 MCP
 * 顺带调用）以 **detached** 方式拉起。
 *
 * 只做三件事：解析参数、起 HTTP 服务、保持存活直到收到信号。
 * stdout/stderr 会被拉起方重定向到 `<PRISM_HOME>/state/serve-<port>.log`，
 * 所以这里可以放心打日志——它**不是** MCP 的 JSON-RPC 通道。
 */
import { startServer } from './app.js'

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const port = Number(argValue('port') ?? 7777)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`--port 必须为 1~65535 的整数: ${String(argValue('port'))}`)
  }
  const host = argValue('host') ?? '127.0.0.1'
  const home = argValue('home')
  const harnessRoot = argValue('harness-root')

  const app = await startServer({
    ...(home !== undefined ? { home } : {}),
    port,
    host,
    ...(harnessRoot !== undefined ? { harnessRoot } : {}),
  })
  process.stdout.write(`prism serve (background) 监听 http://${app.host}:${app.port}（home=${app.home}）\n`)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
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

void main().catch((error: unknown) => {
  process.stderr.write(`[background] 启动失败: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
