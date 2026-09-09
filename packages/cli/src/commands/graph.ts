import { access } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { prismHome, PrismError } from '@prism/core'
import {
  buildGraphArgs,
  formatCommand,
  ProjectRegistry,
  inspectGraphStatus,
  resolveGraphifyCommand,
  runGraphify,
  type BuildRunner,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

const GRAPHIFY_TIMEOUT_MS = 300_000

/** `prism graph ...`（design.md §5：build / query / status）。 */
export async function runGraph(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'build':
      return await graphBuild(ctx, rest, values)
    case 'query':
      return await graphQuery(ctx, rest, values)
    case 'status':
      return await graphStatus(ctx, rest)
    default:
      ctx.stderr('用法: prism graph <build|query|status> ...')
      return 1
  }
}

/**
 * `prism graph build <项目根目录> [--name <项目名>] [--timeout <秒>]`
 * 同步执行（CLI 场景），参数与 server 一致：extract --no-description --no-label + flows build（禁 LLM 富化）。
 */
async function graphBuild(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const rootArg = args[0]
  if (rootArg === undefined) {
    ctx.stderr('用法: prism graph build <项目根目录> [--name <项目名>]')
    return 1
  }
  const root = resolve(rootArg)
  try {
    await access(root)
  } catch {
    ctx.stderr(`错误 [bad_request] 项目根目录不存在: ${root}`)
    return 1
  }
  const name = values.name ?? basename(root)
  const env = ctx.graphifyEnv ?? process.env
  const timeoutMs = values.timeout !== undefined ? Number(values.timeout) * 1000 : GRAPHIFY_TIMEOUT_MS

  const registry = new ProjectRegistry(ctx.home ?? prismHome())
  const runner: BuildRunner =
    ctx.buildRunner ??
    (async (_project, projectRoot, appendLog) => {
      const resolvedCommand = await resolveGraphifyCommand(env)
      for (const stepArgs of buildGraphArgs(projectRoot)) {
        appendLog(`> ${formatCommand(resolvedCommand, stepArgs)}`)
        const result = await runGraphify(stepArgs, { cwd: projectRoot, timeoutMs, env })
        const tail = result.stdout.trim().split('\n').slice(-3).join(' | ')
        if (tail !== '') {
          ctx.stderr(`  ${tail.slice(0, 300)}`)
        }
      }
    })

  try {
    await registry.register(name, root)
    await runner(name, root, (line) => ctx.stderr(line))
    const builtAt = new Date().toISOString()
    await registry.markBuilt(name, builtAt)
    const summary = await inspectGraphStatus(name, root, builtAt)
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ok: true, value: { project: name, root, graph_exists: summary.graph_exists } }))
    } else {
      ctx.stdout(`建图完成: ${name} → ${join(root, 'graphify-out')}（graph_exists=${summary.graph_exists}）`)
    }
    return 0
  } catch (error) {
    if (error instanceof PrismError) {
      ctx.stderr(`错误 [${error.code}] ${error.message}`)
      return 1
    }
    throw error
  }
}

/** `prism graph query <q> --project <项目名>`。 */
async function graphQuery(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const q = args[0]
  const projectName = values.project
  if (q === undefined || projectName === undefined) {
    ctx.stderr('用法: prism graph query <q> --project <项目名>')
    return 1
  }
  const registry = new ProjectRegistry(ctx.home ?? prismHome())
  const info = await registry.get(projectName)
  const graphPath = join(info.root, 'graphify-out', 'graph.json')
  try {
    await access(graphPath)
  } catch {
    ctx.stderr(`错误 [graph_not_found] 图谱不存在: ${graphPath}（请先 prism graph build）`)
    return 1
  }
  const result = await runGraphify(['query', q, '--graph', graphPath], { cwd: info.root })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: info.project, output: result.stdout.trim() } }))
  } else {
    ctx.stdout(result.stdout.trim())
  }
  return 0
}

/** `prism graph status <项目名>`。 */
async function graphStatus(ctx: CommandContext, args: string[]): Promise<number> {
  const projectName = args[0]
  if (projectName === undefined) {
    ctx.stderr('用法: prism graph status <项目名>')
    return 1
  }
  const registry = new ProjectRegistry(ctx.home ?? prismHome())
  const info = await registry.get(projectName)
  const detail = await inspectGraphStatus(info.project, info.root, info.built_at)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: detail }))
    return 0
  }
  ctx.stdout(`项目: ${detail.project}（${detail.root}）`)
  ctx.stdout(`图谱: ${detail.graph_exists ? '存在' : '不存在'}  建图时间: ${detail.built_at ?? '未知'}`)
  ctx.stdout(`陈旧: ${detail.stale ? '是' : '否'}（变更 ${detail.changed_files}/${detail.total_files} 个文件）`)
  if (detail.note !== undefined) {
    ctx.stdout(`备注: ${detail.note}`)
  }
  return 0
}
