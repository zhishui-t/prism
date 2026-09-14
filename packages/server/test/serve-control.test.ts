/**
 * 控制台按需拉起（`prism serve --ensure|--check|--stop` 的底层）：
 * 幂等判定、冲突识别、失败可解释。
 *
 * 这里**不真起 Prism 服务**（那属于 e2e）：只测「判断与边界」——
 * 端口空着 / 被别人占 / 自己没记录 三条分支必须给出**可据以行动**的结果。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  backgroundServeArgv,
  ensureServe,
  probeServe,
  serveLogPath,
  serveStatePath,
  stopServe,
} from '../src/serve-control.js'

let home = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'prism-serve-ctl-'))
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true }).catch(() => undefined)
})

/** 拿一个当前空闲的端口（listen(0) 再关掉）。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/** 起一个「不是 Prism」的 HTTP 服务占住端口，用于测冲突分支。 */
async function squat(port: number): Promise<{ close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"hello":"not-prism"}')
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

describe('serve 控制：路径与命令行口径', () => {
  it('状态文件与日志落在 <home>/state 下，且带端口', () => {
    expect(serveStatePath('X:/h', 7777)).toBe(join('X:/h', 'state', 'serve-7777.json'))
    expect(serveLogPath('X:/h', 7788)).toBe(join('X:/h', 'state', 'serve-7788.log'))
  })

  it('后台命令行含 port/host/home，extraArgs 追加在末尾', () => {
    const argv = backgroundServeArgv('X:/h', '127.0.0.1', 7777, ['--harness-root', 'X:/hb'])
    expect(argv.join(' ')).toContain('--port 7777')
    expect(argv.join(' ')).toContain('--host 127.0.0.1')
    expect(argv.join(' ')).toContain('--home X:/h')
    expect(argv.slice(-2)).toEqual(['--harness-root', 'X:/hb'])
    // 入口必须是包内自带的 background.js（开发/打包两种布局同解）
    expect(argv[0]?.endsWith('background.js')).toBe(true)
  })
})

describe('serve 控制：探测与冲突', () => {
  it('空端口 → alive=false（不报错）', async () => {
    const port = await freePort()
    const status = await probeServe('127.0.0.1', port, 500)
    expect(status.alive).toBe(false)
    expect(status.port).toBe(port)
  })

  it('端口被**非 Prism** 程序占用 → probeServe 判否，ensureServe 明确拒绝', async () => {
    const port = await freePort()
    const other = await squat(port)
    try {
      // 只看端口占用会误判成「自己的服务在跑」，这里必须识别出来
      const status = await probeServe('127.0.0.1', port, 800)
      expect(status.alive).toBe(false)

      await expect(ensureServe({ home, host: '127.0.0.1', port })).rejects.toThrow(/其他程序|占用/)
    } finally {
      await other.close()
    }
  })
})

describe('serve 控制：停止只认自己写的记录', () => {
  it('没有状态文件且端口空 → 说明「没有记录」，不误杀', async () => {
    const port = await freePort()
    const result = await stopServe(home, '127.0.0.1', port)
    expect(result.stopped).toBe(false)
    expect(result.reason).toContain('没有后台服务记录')
  })

  it('状态文件里的 pid 已不存在 → 清理记录并说明', async () => {
    const port = await freePort()
    // 写一条指向「肯定不存在」的 pid 的记录
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, 'state'), { recursive: true })
    await writeFile(
      serveStatePath(home, port),
      JSON.stringify({ pid: 999_999_999, host: '127.0.0.1', port, startedAt: 'x' }),
      'utf8',
    )
    const result = await stopServe(home, '127.0.0.1', port)
    expect(result.stopped).toBe(false)
    expect(result.reason).toContain('已不存在')
  })
})

describe('serve 控制：ensure 的可注入性（不真起进程）', () => {
  it('按 extraArgs 拉起；就绪超时给出可操作的报错（含日志路径）', async () => {
    const port = await freePort()
    let seen: string[] | undefined
    await expect(
      ensureServe({
        home,
        host: '127.0.0.1',
        port,
        waitMs: 300,
        extraArgs: ['--harness-root', 'X:/hb'],
        launch: (argv) => {
          seen = argv
          return { pid: 4242 }
        },
      }),
    ).rejects.toThrow(/未就绪/)
    expect(seen?.join(' ')).toContain('--harness-root X:/hb')
  })
})
