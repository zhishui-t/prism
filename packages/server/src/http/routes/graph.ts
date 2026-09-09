import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismError } from '@prism/core'

import { ok, type Envelope } from '../envelope.js'
import { buildGraphArgs, formatCommand, resolveGraphifyCommand, runGraphify } from '../../graph/graphify.js'
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
  return async (_project, root, appendLog) => {
    const resolved = await resolveGraphifyCommand(deps.env ?? process.env)
    for (const args of buildGraphArgs(root)) {
      appendLog(`> ${formatCommand(resolved, args)}`)
      const result = await runGraphify(args, { cwd: root, timeoutMs: deps.timeoutMs, env: deps.env })
      const tail = result.stdout.trim().split('\n').slice(-3).join(' | ')
      if (tail !== '') {
        appendLog(`stdout: ${tail.slice(0, 500)}`)
      }
    }
  }
}

/** graph 路由工厂（design.md §4：projects/build/job/query/status）。 */
export function graphRoutes(deps: GraphDeps): {
  projects: (ctx: RouteContext) => Promise<Envelope>
  build: (ctx: RouteContext) => Promise<Envelope>
  jobStatus: (ctx: RouteContext) => Promise<Envelope>
  query: (ctx: RouteContext) => Promise<Envelope>
  status: (ctx: RouteContext) => Promise<Envelope>
} {
  const projects = async (_ctx: RouteContext): Promise<Envelope> => {
    return ok(await deps.registry.list())
  }

  const build = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as { project?: unknown; root?: unknown }
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
    const job = deps.jobs.submit(project, target.root, target.root, deps.runner)
    return ok({ job_id: job.job_id })
  }

  const jobStatus = async (ctx: RouteContext): Promise<Envelope> => {
    const job = deps.jobs.get(ctx.params.job_id ?? '')
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

  return { projects, build, jobStatus, query, status }
}

/** 诊断展示用命令行（不含真实解析结果）。 */
function formatCommandDisplay(args: string[]): string {
  return `graphify ${args.join(' ')}`
}
