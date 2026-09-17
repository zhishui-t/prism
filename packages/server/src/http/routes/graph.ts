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
  graphRelations as queryGraphRelations,
  readCodeGraphCached,
  DEFAULT_GRAPH_RELATION_LIMIT,
  graphExport as runGraphExport,
  GRAPHIFY_EXPORT_FORMATS,
} from '../../graph/graphify.js'
import { BuildJobManager, type BuildRunner } from '../../graph/jobs.js'
import { mergeProjectGraphs, type MergeProjectInput } from '../../graph/merge.js'
import { inspectGraphStatus, ProjectRegistry, type ProjectInfo } from '../../graph/registry.js'
import {
  ROLLUP_LEVELS,
  buildRollup,
  decodeRollupParent,
  isRollupLevel,
  normalizeRollupGraph,
} from '../../graph/rollup.js'
import type { RouteContext } from '../router.js'

export interface GraphDeps {
  registry: ProjectRegistry
  jobs: BuildJobManager
  /** 真实建图执行体；测试注入假执行体 */
  runner: BuildRunner
  /**
   * PRISM_HOME：多项目合并产物落 `<home>/graphify-merged`（裁决 D2）。
   * 必须显式传入——缺省会回落 `prismPaths()` 默认宿主目录（R5/R6 事故点，已有回归测试锁定）。
   */
  home: string
  /** graphify 环境覆盖（测试注入） */
  graphifyEnv?: NodeJS.ProcessEnv
  graphifyTimeoutMs?: number
}

/** 默认建图执行体：graphify extract/cluster-only（钉死参数 `--code-only`/`--no-label`，禁 LLM 富化）。
 *  注意：Python 版 graphify **没有 `flows` 子命令**，也没有 `flows build` 这一步。 */
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

/** graph 路由工厂（design.md §4：projects/build/job/query/path/explain/affected/god-nodes/summary/status；v5 增 merge；v10 F9 增 rollup）。 */
export function graphRoutes(deps: GraphDeps): {
  projects: (ctx: RouteContext) => Promise<Envelope>
  build: (ctx: RouteContext) => Promise<Envelope>
  jobStatus: (ctx: RouteContext) => Promise<Envelope>
  merge: (ctx: RouteContext) => Promise<Envelope>
  query: (ctx: RouteContext) => Promise<Envelope>
  path: (ctx: RouteContext) => Promise<Envelope>
  explain: (ctx: RouteContext) => Promise<Envelope>
  affected: (ctx: RouteContext) => Promise<Envelope>
  relations: (ctx: RouteContext) => Promise<Envelope>
  godNodes: (ctx: RouteContext) => Promise<Envelope>
  summary: (ctx: RouteContext) => Promise<Envelope>
  exportGraph: (ctx: RouteContext) => Promise<Envelope>
  rollup: (ctx: RouteContext) => Promise<Envelope>
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

  /**
   * 多项目图谱合并（v5 F-C2 / 裁决 D2）：
   * `POST /api/graph/merge { projects: string[], out_dir? }`。
   * - 项目名必须在注册表（否则 not_found），且各自已有 `graphify-out/graph.json`；
   * - 产物缺省落 `<PRISM_HOME>/graphify-merged/`；显式 `out_dir` 落在任一项目根内 → bad_request（D2 护栏）；
   * - 合并后顺带 `cluster-only` 渲染自包含 `graph.html`（只读/生成型，不触发建图）。
   */
  const merge = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as { projects?: unknown; out_dir?: unknown }
    const names = Array.isArray(body.projects)
      ? body.projects
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item !== '')
      : []
    if (names.length < 2) {
      throw new PrismError('bad_request', `缺少 projects（至少 2 个项目名，用 prism graph build 建图后再合并）`)
    }
    const targets: MergeProjectInput[] = []
    for (const name of names) {
      const info = await deps.registry.get(name)
      targets.push({ project: info.project, root: info.root })
    }
    const outDirRaw = typeof body.out_dir === 'string' ? body.out_dir.trim() : ''
    const result = await mergeProjectGraphs(targets, {
      home: deps.home,
      ...(outDirRaw !== '' ? { outDir: outDirRaw } : {}),
      ...(deps.graphifyEnv !== undefined ? { env: deps.graphifyEnv } : {}),
      ...(deps.graphifyTimeoutMs !== undefined ? { timeoutMs: deps.graphifyTimeoutMs } : {}),
    })
    return ok(result)
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

  /**
   * 调用链关系查询（v8 F4）：`GET /api/graph/relations?project=&node=&dir=in|out[&relation=&limit=]`。
   *
   * 直读 `<root>/graphify-out/graph.json` 内存过滤（同 summary 先例），**不起 graphify 子进程**。
   * `node` 为节点 id 或符号名（服务端按 `norm_label` 精确 → 唯一前缀解析；多义回 candidates）。
   */
  const relations = async (ctx: RouteContext): Promise<Envelope> => {
    const node = ctx.query.get('node')?.trim() ?? ''
    if (node === '') {
      throw new PrismError('bad_request', '缺少 node 参数')
    }
    const dir = ctx.query.get('dir')?.trim() ?? ''
    if (dir !== 'in' && dir !== 'out') {
      throw new PrismError('bad_request', `dir 必须为 in 或 out: ${dir === '' ? '(缺省)' : dir}`)
    }
    const limitRaw = ctx.query.get('limit')?.trim() ?? ''
    const limit =
      limitRaw === '' ? DEFAULT_GRAPH_RELATION_LIMIT : parsePositiveInt(limitRaw, 'limit', MAX_RELATION_LIMIT)
    const relationFilter = parseRelationFilter(ctx.query.get('relation'))
    const project = await requireProject(ctx)
    await ensureGraph(project)
    const result = await queryGraphRelations(project.root, {
      node,
      dir,
      limit,
      ...(relationFilter !== undefined ? { relations: relationFilter } : {}),
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

  /**
   * 分层聚合·逐级探索（v10 F9）：
   * `GET /api/graph/rollup?project=&level=community|dir|file|symbol&parent=<合成 id?>`。
   *
   * 直读 `<root>/graphify-out/graph.json`（**带 mtime+size 失效键的进程内缓存**，只缓存
   * read+parse，不缓存聚合结果），内存分组，**不起 graphify 子进程**（同 relations/summary
   * 先例）。parent 编码与实体校验：形态错 → bad_request，实体不存在 → not_found。
   *
   * 响应**不加 `project` 字段**——形状按 F9 契约钉死为
   * `{ level, parent, total, truncated, nodes, edges }`（前端按此写死解析）。
   *
   * 性能（红线 <200ms）：本仓实测 read+parse+分组 ≈24ms（3.66MB / 2340 节点 / 7103 边）；
   * 加缓存后只有首次付 read+parse。**测试不做硬时限断言**（CI 负载下抖，见「bare sleep
   * 测异步」同类教训），以实测为准。
   */
  const rollup = async (ctx: RouteContext): Promise<Envelope> => {
    const levelRaw = ctx.query.get('level')?.trim() ?? ''
    if (!isRollupLevel(levelRaw)) {
      throw new PrismError(
        'bad_request',
        `level 必须为 ${ROLLUP_LEVELS.join('/')}: ${levelRaw === '' ? '(缺省)' : levelRaw}`,
      )
    }
    // 形态校验放读图之前（读一张几 MB 的图再报 400 是纯浪费）
    const parentRaw = ctx.query.get('parent')?.trim() ?? ''
    const parent = decodeRollupParent(levelRaw, parentRaw === '' ? null : parentRaw)
    const project = await requireProject(ctx)
    await ensureGraph(project)
    // 边读取取**非空侧**（派修 P2-4）：rollup 不自造 `links ?? edges` 口径，用与
    // `/api/graph/relations`（`readGraphEdges`）同口径的归一，避免「rollup 见 0 边」。
    const graph = normalizeRollupGraph(await readCodeGraphCached(project.root))
    return ok(buildRollup(graph, levelRaw, parent))
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

  return { projects, build, jobStatus, merge, query, path, explain, affected, relations, godNodes, summary, exportGraph, rollup, status }
}

/**
 * `limit` 上限（契约只规定「缺省 200」，未规定上限）：取 10000 —— 高于本仓全量边数
 * （7103），故「想要全量」的调用不会被这道闸拦下，同时挡住畸形大数。
 */
const MAX_RELATION_LIMIT = 10_000

/**
 * `relation=calls,invokes` → `['calls','invokes']`（trim + 去空）；缺省/全空 → undefined（不过滤）。
 *
 * **不对未知名报错**：关系取值随图谱而变，UI 四模式默认 `calls,invokes` 里的 `invokes`
 * 在部分图谱（如本仓）并不存在——报 400 会让默认查询直接失败。
 */
function parseRelationFilter(raw: string | null): string[] | undefined {
  if (raw === null) return undefined
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return list.length > 0 ? list : undefined
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
