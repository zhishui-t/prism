import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismError } from '@prism/core'

import { ok, type Envelope } from '../envelope.js'
import {
  buildGraphArgs,
  formatCommand,
  resolveGraphifyCommand,
  runGraphify,
  graphPath as queryGraphPath,
  graphExplain as queryGraphExplain,
  graphAffected as queryGraphAffected,
  graphGodNodes as queryGraphGodNodes,
  graphSummary as queryGraphSummary,
  graphExport as runGraphExport,
  GRAPHIFY_EXPORT_FORMATS,
} from '../../graph/graphify.js'
import { BuildJobManager, type BuildRunner } from '../../graph/jobs.js'
import { inspectGraphStatus, ProjectRegistry, type ProjectInfo } from '../../graph/registry.js'
import type { RouteContext } from '../router.js'

export interface GraphDeps {
  registry: ProjectRegistry
  jobs: BuildJobManager
  /** 真实建图执行体；测试注入假执行体 */
  runner: BuildRunner
  /** graphify 环境覆盖（测试注入） */
  graphifyEnv?: NodeJS.ProcessEnv
  graphifyTimeoutMs?: number
}

/** 默认建图执行体：graphify extract（钉死参数，禁 LLM 富化）+ flows build。 */
export function defaultGraphifyRunner(deps: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): BuildRunner {
  return async (_project, root, appendLog, opts) => {
    const resolved = await resolveGraphifyCommand(deps.env ?? process.env)
    for (const args of buildGraphArgs(root, opts?.incremental === true ? 'incremental' : 'full')) {
      appendLog(`> ${formatCommand(resolved, args)}`)
      const result = await runGraphify(args, { cwd: root, timeoutMs: deps.timeoutMs, env: deps.env })
      const tail = result.stdout.trim().split('\n').slice(-3).join(' | ')
      if (tail !== '') {
        appendLog(`stdout: ${tail.slice(0, 500)}`)
      }
    }
  }
}

/** graph 路由工厂（design.md §4：projects/build/job/query/path/explain/affected/god-nodes/summary/status）。 */
export function graphRoutes(deps: GraphDeps): {
  projects: (ctx: RouteContext) => Promise<Envelope>
  build: (ctx: RouteContext) => Promise<Envelope>
  jobStatus: (ctx: RouteContext) => Promise<Envelope>
  query: (ctx: RouteContext) => Promise<Envelope>
  path: (ctx: RouteContext) => Promise<Envelope>
  explain: (ctx: RouteContext) => Promise<Envelope>
  affected: (ctx: RouteContext) => Promise<Envelope>
  godNodes: (ctx: RouteContext) => Promise<Envelope>
  summary: (ctx: RouteContext) => Promise<Envelope>
  exportGraph: (ctx: RouteContext) => Promise<Envelope>
  status: (ctx: RouteContext) => Promise<Envelope>
} {
  const projects = async (_ctx: RouteContext): Promise<Envelope> => {
    return ok(await deps.registry.list())
  }

  const build = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as { project?: unknown; root?: unknown; incremental?: unknown }
    const project = typeof body.project === 'string' ? body.project.trim() : ''
    if (project === '') {
      throw new PrismError('bad_request', '缺少 project')
    }
    const root = typeof body.root === 'string' ? body.root.trim() : ''
    let known: ProjectInfo | null = null
    try {
      known = await deps.registry.get(project)
    } catch {
      known = null
    }
    if (known === null) {
      if (root === '') {
        throw new PrismError('not_found', `未注册的图谱项目: ${project}（首次建图请同时传 root 项目根绝对路径）`)
      }
      await deps.registry.register(project, root)
    } else if (root !== '' && root !== known.root) {
      throw new PrismError('bad_request', `项目 ${project} 已注册为 ${known.root}，与传入 root ${root} 不一致`)
    }
    const target = await deps.registry.get(project)
    const incremental = body.incremental === true
    const job = deps.jobs.submit(project, target.root, target.root, deps.runner, { incremental })
    return ok({ job_id: job.job_id })
  }

  const jobStatus = async (ctx: RouteContext): Promise<Envelope> => {
    const job = deps.jobs.get(ctx.params.job_id ?? '')
    // 建图成功 → 回写 built_at（此前只有 CLI 建图会写，控制台建图 built_at 恒空）
    if (job.status === 'done' && typeof job.ended_at === 'string') {
      await deps.registry.markBuilt(job.project, job.ended_at)
    }
    return ok({
      job_id: job.job_id,
      project: job.project,
      status: job.status,
      log: job.log,
      error: job.error,
      started_at: job.started_at,
      ended_at: job.ended_at,
    })
  }

  const query = async (ctx: RouteContext): Promise<Envelope> => {
    const q = ctx.query.get('q')?.trim() ?? ''
    if (q === '') {
      throw new PrismError('bad_request', '缺少查询词 q')
    }
    const project = await requireProject(ctx)
    const graph = join(project.root, 'graphify-out', 'graph.json')
    try {
      await access(graph)
    } catch {
      throw new PrismError('graph_not_found', `图谱不存在: ${graph}（请先建图）`)
    }
    const args = ['query', q, '--graph', graph]
    const result = await runGraphify(args, {
      cwd: project.root,
      timeoutMs: deps.graphifyTimeoutMs,
      env: deps.graphifyEnv,
    })
    return ok({ project: project.project, output: result.stdout.trim(), command: formatCommandDisplay(args) })
  }

  const path = async (ctx: RouteContext): Promise<Envelope> => {
    const from = ctx.query.get('from')?.trim() ?? ''
    const to = ctx.query.get('to')?.trim() ?? ''
    if (from === '' || to === '') {
      throw new PrismError('bad_request', '缺少 from / to 参数')
    }
    const project = await requireProject(ctx)
    await ensureGraph(project)
    const result = await queryGraphPath(project.root, from, to, queryOpts(project, deps))
    return ok({ project: project.project, ...result })
  }

  const explain = async (ctx: RouteContext): Promise<Envelope> => {
    const node = ctx.query.get('node')?.trim() ?? ''
    if (node === '') {
      throw new PrismError('bad_request', '缺少 node 参数')
    }
    const project = await requireProject(ctx)
    await ensureGraph(project)
    const result = await queryGraphExplain(project.root, node, queryOpts(project, deps))
    return ok({ project: project.project, ...result })
  }

  const affected = async (ctx: RouteContext): Promise<Envelope> => {
    const node = ctx.query.get('node')?.trim() ?? ''
    if (node === '') {
      throw new PrismError('bad_request', '缺少 node 参数')
    }
    const project = await requireProject(ctx)
    await ensureGraph(project)
    const depthRaw = ctx.query.get('depth')
    const result = await queryGraphAffected(project.root, node, {
      ...queryOpts(project, deps),
      ...(depthRaw !== null && depthRaw !== '' ? { depth: parsePositiveInt(depthRaw, 'depth', 10) } : {}),
    })
    return ok({ project: project.project, ...result })
  }

  const godNodes = async (ctx: RouteContext): Promise<Envelope> => {
    const project = await requireProject(ctx)
    await ensureGraph(project)
    const topRaw = ctx.query.get('top')
    const result = await queryGraphGodNodes(project.root, {
      ...queryOpts(project, deps),
      ...(topRaw !== null && topRaw !== '' ? { top: parsePositiveInt(topRaw, 'top', 100) } : {}),
    })
    return ok({ project: project.project, ...result })
  }

  const summary = async (ctx: RouteContext): Promise<Envelope> => {
    const project = await requireProject(ctx)
    const result = await queryGraphSummary(project.root)
    if (!result.exists) {
      throw new PrismError('graph_not_found', `图谱不存在: ${result.path}（请先建图）`)
    }
    return ok({ project: project.project, ...result })
  }

  /** 导出图谱为其他格式：`POST /api/graph/export { project, format }`。 */
  const exportGraph = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as { project?: unknown; format?: unknown }
    const format = typeof body.format === 'string' ? body.format.trim() : ''
    if (format === '') {
      throw new PrismError('bad_request', `缺少 format（可用: ${GRAPHIFY_EXPORT_FORMATS.join('/')}）`)
    }
    if (!GRAPHIFY_EXPORT_FORMATS.includes(format as never)) {
      throw new PrismError('bad_request', `不支持的导出格式: ${format}`, {
        allowed: GRAPHIFY_EXPORT_FORMATS,
      })
    }
    const name = typeof body.project === 'string' ? body.project.trim() : ''
    if (name === '') {
      throw new PrismError('bad_request', '缺少 project 参数')
    }
    const project = await deps.registry.get(name)
    await ensureGraph(project)
    const result = await runGraphExport(project.root, format as never, queryOpts(project, deps))
    return ok({ project: project.project, ...result })
  }

  const status = async (ctx: RouteContext): Promise<Envelope> => {
    const project = await requireProject(ctx)
    return ok(await inspectGraphStatus(project.project, project.root, project.built_at))
  }

  const requireProject = async (ctx: RouteContext): Promise<ProjectInfo> => {
    const name = ctx.query.get('project')?.trim() ?? ''
    if (name === '') {
      throw new PrismError('bad_request', '缺少 project 参数')
    }
    return await deps.registry.get(name)
  }

  return { projects, build, jobStatus, query, path, explain, affected, godNodes, summary, exportGraph, status }
}

/** 查询命令共用选项（cwd=项目根、超时与 env 透传）。 */
function queryOpts(
  project: ProjectInfo,
  deps: GraphDeps,
): { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } {
  return {
    cwd: project.root,
    ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
  }
}

/** 图谱产物存在性校验（缺失 → graph_not_found）。 */
async function ensureGraph(project: ProjectInfo): Promise<void> {
  const graph = join(project.root, 'graphify-out', 'graph.json')
  try {
    await access(graph)
  } catch {
    throw new PrismError('graph_not_found', `图谱不存在: ${graph}（请先建图）`)
  }
}

/** 正整数参数（上限 max）。 */
function parsePositiveInt(raw: string, name: string, max: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new PrismError('bad_request', `${name} 必须为 1~${max} 的整数: ${raw}`)
  }
  return value
}

/** 诊断展示用命令行（不含真实解析结果）。 */
function formatCommandDisplay(args: string[]): string {
  return `graphify ${args.join(' ')}`
}
