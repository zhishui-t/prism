import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPersistence, prismPaths } from '@prism/core'
import { resolveGraphifyCommand, runGraphify, vendoredGraphifyVersion } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

export interface DoctorCheck {
  name: string
  ok: boolean
  detail: string
}

const MIN_NODE = [22, 5] as const

/** `prism doctor`：Node 版本 / PRISM_HOME 可写 / knowledge.db 可开 / graphify 存在 / 端口占用。 */
export async function runDoctor(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const home = ctx.home ?? prismPaths().home
  const checks: DoctorCheck[] = []

  // 1) Node 版本（engines: >=22.5，node:sqlite 需要）
  const [maj, min] = process.versions.node.split('.').map((n) => Number(n))
  const nodeOk = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])
  checks.push({
    name: 'node_version',
    ok: nodeOk,
    detail: `当前 ${process.versions.node}，要求 >= ${MIN_NODE.join('.')}`,
  })

  // 2) PRISM_HOME 可写
  const paths = prismPaths(home)
  try {
    mkdirSync(paths.home, { recursive: true })
    const probe = mkdtempSync(join(tmpdir(), 'prism-doctor-'))
    const file = join(probe, 'w')
    writeFileSync(file, 'ok')
    const content = readFileSync(file, 'utf-8')
    rmSync(probe, { recursive: true, force: true })
    checks.push({ name: 'prism_home_writable', ok: content === 'ok', detail: home })
  } catch (error) {
    checks.push({ name: 'prism_home_writable', ok: false, detail: `${home}（${msg(error)}）` })
  }

  // 3) knowledge.db 可开
  try {
    const persistence = openPersistence({ home })
    const version = persistence.knowledge.userVersion()
    persistence.close()
    checks.push({ name: 'knowledge_db', ok: true, detail: `${paths.stateDir}/knowledge.db（user_version=${version}）` })
  } catch (error) {
    checks.push({ name: 'knowledge_db', ok: false, detail: msg(error) })
  }

  // 4) graphify 存在（vendored 子工程 / PATH / GRAPHIFY_BIN）
  try {
    const resolved = await resolveGraphifyCommand(ctx.graphifyEnv ?? process.env)
    let detail = `${resolved.command}${resolved.prefixArgs.length > 0 ? ` ${resolved.prefixArgs.join(' ')}` : ''}${resolved.shell ? '（shell 模式）' : ''}`
    try {
      // vendored Python 子工程的 --version 输出 unknown，优先读 pyproject.toml
      const fromPyproject = await vendoredGraphifyVersion()
      if (fromPyproject !== null) {
        detail += ` 版本: ${fromPyproject}（vendored）`
      } else {
        const version = await runGraphify(['--version'], {
          env: ctx.graphifyEnv ?? process.env,
          timeoutMs: 10_000,
        })
        detail += ` 版本: ${version.stdout.trim().split('\n')[0] || '未知'}`
      }
    } catch {
      detail += '（--version 不可用，忽略）'
    }
    checks.push({ name: 'graphify', ok: true, detail })
  } catch (error) {
    checks.push({ name: 'graphify', ok: false, detail: `${msg(error)}（可设 GRAPHIFY_BIN）` })
  }

  // 5) 端口占用
  const port = values.port !== undefined ? Number(values.port) : 7777
  const portFree = await probePort(port, values.host)
  checks.push({
    name: `port_${port}`,
    ok: portFree,
    detail: portFree ? `端口 ${port} 空闲` : `端口 ${port} 被占用（换端口：--port）`,
  })

  const allOk = checks.every((c) => c.ok)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: allOk, value: checks }))
  } else {
    for (const check of checks) {
      ctx.stdout(`${check.ok ? '  ok ' : 'FAIL '} ${check.name} — ${check.detail}`)
    }
    ctx.stdout(allOk ? 'doctor: 全部通过' : 'doctor: 存在失败项')
  }
  return allOk ? 0 : 1
}

function probePort(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host ?? '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
