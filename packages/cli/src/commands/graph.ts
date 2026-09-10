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
  graphPath as queryPath,
  graphExplain as queryExplain,
  graphAffected as queryAffected,
  graphGodNodes as queryGodNodes,
  graphSummary as querySummary,
  graphExport,
  GRAPHIFY_EXPORT_FORMATS,
  EXPORT_FORMAT_LABELS,
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
    case 'path':
      return await graphPathCmd(ctx, rest, values)
    case 'explain':
      return await graphExplainCmd(ctx, rest, values)
    case 'affected':
      return await graphAffectedCmd(ctx, rest, values)
    case 'god-nodes':
      return await graphGodNodesCmd(ctx, rest, values)
    case 'summary':
      return await graphSummaryCmd(ctx, rest, values)
    case 'export':
      return await graphExportCmd(ctx, rest, values)
    case 'status':
      return await graphStatus(ctx, rest)
    default:
      ctx.stderr(
        '用法: prism graph <build|query|path|explain|affected|god-nodes|summary|export|status> ...',
      )
      return 1
  }
}

/**
 * `prism graph build <项目根目录> [--name <项目名>] [--timeout <秒>]`
 * 同步执行（CLI 场景），参数与 server 一致：extract --no-description --no-label + flows build（禁 LLM 富化）。
 */
async function graphBuild(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const existsGraph = async (root: string): Promise<boolean> => {
    const { access } = await import('node:fs/promises')
    const { join } = await import('node:path')
    try {
      await access(join(root, 'graphify-out', 'graph.json'))
      return true
    } catch {
      return false
    }
  }
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
      const mode = values.incremental === true && (await existsGraph(projectRoot)) ? 'incremental' : 'full'
      for (const stepArgs of buildGraphArgs(projectRoot, mode)) {
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

/** 解析已注册项目（图谱查询命令共用）：未注册 → null（已打印错误）。 */
async function resolveProject(
  ctx: CommandContext,
  values: ArgValues,
  positional: string | undefined,
  usage: string,
): Promise<{ project: string; root: string } | null> {
  const projectName = values.project ?? positional
  if (projectName === undefined) {
    ctx.stderr(usage)
    return null
  }
  const registry = new ProjectRegistry(ctx.home ?? prismHome())
  try {
    const info = await registry.get(projectName)
    return { project: info.project, root: info.root }
  } catch {
    ctx.stderr(`错误 [not_found] 项目未注册: ${projectName}（先 prism graph build <目录>）`)
    return null
  }
}

/** 查询前校验图谱存在。 */
async function ensureGraph(ctx: CommandContext, root: string): Promise<boolean> {
  const graphPath = join(root, 'graphify-out', 'graph.json')
  try {
    await access(graphPath)
    return true
  } catch {
    ctx.stderr(`错误 [graph_not_found] 图谱不存在: ${graphPath}（请先 prism graph build）`)
    return false
  }
}

/** `prism graph path <from> <to> --project <名>`。 */
async function graphPathCmd(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [from, to] = args
  if (from === undefined || to === undefined) {
    ctx.stderr('用法: prism graph path <from> <to> --project <项目名>')
    return 1
  }
  const target = await resolveProject(ctx, values, undefined, '用法: prism graph path <from> <to> --project <项目名>')
  if (target === null || !(await ensureGraph(ctx, target.root))) return 1
  const result = await queryPath(target.root, from, to, { cwd: target.root })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: target.project, ...result } }))
    return result.found ? 0 : 1
  }
  ctx.stdout(result.raw.trim())
  return result.found ? 0 : 1
}

/** `prism graph explain <node> --project <名>`。 */
async function graphExplainCmd(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const node = args[0]
  if (node === undefined) {
    ctx.stderr('用法: prism graph explain <node> --project <项目名>')
    return 1
  }
  const target = await resolveProject(ctx, values, undefined, '用法: prism graph explain <node> --project <项目名>')
  if (target === null || !(await ensureGraph(ctx, target.root))) return 1
  const result = await queryExplain(target.root, node, { cwd: target.root })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: target.project, ...result } }))
  } else {
    ctx.stdout(result.raw.trim())
  }
  return 0
}

/** `prism graph affected <node> [--depth N] --project <名>`。 */
async function graphAffectedCmd(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const node = args[0]
  if (node === undefined) {
    ctx.stderr('用法: prism graph affected <node> [--depth N] --project <项目名>')
    return 1
  }
  const target = await resolveProject(ctx, values, undefined, '用法: prism graph affected <node> --project <项目名>')
  if (target === null || !(await ensureGraph(ctx, target.root))) return 1
  const result = await queryAffected(target.root, node, {
    cwd: target.root,
    ...(values.depth !== undefined ? { depth: Number(values.depth) } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: target.project, ...result } }))
  } else {
    ctx.stdout(result.raw.trim())
  }
  return 0
}

/** `prism graph god-nodes [--top N] --project <名>`。 */
async function graphGodNodesCmd(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const target = await resolveProject(ctx, values, undefined, '用法: prism graph god-nodes [--top N] --project <项目名>')
  if (target === null || !(await ensureGraph(ctx, target.root))) return 1
  const result = await queryGodNodes(target.root, {
    cwd: target.root,
    ...(values.top !== undefined ? { top: Number(values.top) } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: target.project, ...result } }))
  } else {
    ctx.stdout(result.raw.trim())
  }
  return 0
}

/** `prism graph summary --project <名>`：图谱规模统计（不调 CLI）。 */
async function graphSummaryCmd(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const target = await resolveProject(ctx, values, undefined, '用法: prism graph summary --project <项目名>')
  if (target === null) return 1
  const summary = await querySummary(target.root)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: target.project, ...summary } }))
    return summary.exists ? 0 : 1
  }
  if (!summary.exists) {
    ctx.stderr(`错误 [graph_not_found] 图谱不存在: ${summary.path}`)
    return 1
  }
  ctx.stdout(`项目: ${target.project}（${target.root}）`)
  ctx.stdout(`节点 ${summary.nodes}  边 ${summary.edges}  社区 ${summary.communities}`)
  return 0
}

/** `prism graph export <格式> --project <名>`（obsidian/wiki/svg/graphml/…）。 */
async function graphExportCmd(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const format = args[0]
  if (format === undefined) {
    ctx.stderr(
      `用法: prism graph export <格式> --project <项目名>
  可用格式: ${GRAPHIFY_EXPORT_FORMATS.join(' / ')}`,
    )
    return 1
  }
  if (!GRAPHIFY_EXPORT_FORMATS.includes(format as never)) {
    ctx.stderr(`错误 [bad_request] 不支持的导出格式: ${format}（可用: ${GRAPHIFY_EXPORT_FORMATS.join('/')}）`)
    return 1
  }
  const target = await resolveProject(ctx, values, undefined, '用法: prism graph export <格式> --project <项目名>')
  if (target === null || !(await ensureGraph(ctx, target.root))) return 1

  const result = await graphExport(target.root, format as never, { cwd: target.root })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: target.project, ...result } }))
    return 0
  }
  ctx.stdout(`已导出 ${EXPORT_FORMAT_LABELS[format as never]}`)
  ctx.stdout(`  产物: ${result.output}`)
  if (result.files.length > 0) {
    ctx.stdout(`  文件: ${result.files.slice(0, 8).join(', ')}${result.files.length > 8 ? ` …共 ${result.files.length} 个` : ''}`)
  }
  if (format === 'obsidian') {
    ctx.stdout('  用法: 把该目录作为 vault 在 Obsidian 中打开')
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
