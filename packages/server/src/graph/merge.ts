/**
 * 多项目图谱合并编排（v5 F-C2 / 裁决 D2）。
 *
 * 职责分工：
 * - 低层命令封装在 `graphify.ts`（`mergeGraphArgs` / `mergeGraphs`）；
 * - 本文件负责**编排**：输入校验 → 各项目图谱存在性 → 合并 → 渲染（cluster-only）。
 *
 * 落点铁律（D2）：产物一律落 `<PRISM_HOME>/graphify-merged/`（可用 `outDir` 覆盖以适配测试），
 * **绝不落任何项目根**——项目根下的 `graphify-out/` 归 graphify 管，且 studio 路由只服务注册项目根。
 *
 * 实测（2026-09-11，vendored graphify 0.9.x）：
 * - `merge-graphs <g1> <g2> --out <M>/merged-graph.json` → 打印 `Merged 2 graphs -> N nodes, M edges`；
 * - 随后的 `cluster-only <M> --graph <M>/merged-graph.json --no-label` 把产物写到
 *   **`<M>/graphify-out/`**（graph.html / GRAPH_REPORT.md / 带 community 的 graph.json），
 *   与进程 cwd 无关，且两个源项目根的 `graphify-out/` 全程未被改动。
 */

import { access, mkdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { prismPaths, PrismError } from '@prism/core'

import {
  defaultGraphPath,
  mergeGraphs,
  renderExternalGraph,
  type GraphQueryOptions,
} from './graphify.js'

/**
 * 合并产物目录：`<PRISM_HOME>/graphify-merged`（裁决 D2；绝不在项目根）。
 *
 * `home` **必填**：它一旦可选，缺省就会经 `prismPaths()` 回落真实宿主目录 `~/.prism`——
 * 这正是本轮两次 R5 事故的形态（HTTP 合并、CLI 条件展开），故从签名上堵死：
 * 调用方必须显式给出**已解析**的 PRISM_HOME。
 */
export function mergedGraphDir(home: string): string {
  return join(prismPaths(home).home, 'graphify-merged')
}

/** 参与合并的项目（名 + 根）。根必须来自 `ProjectRegistry`，不接受任意用户路径。 */
export interface MergeProjectInput {
  project: string
  root: string
}

export interface MergeProjectGraphsOptions {
  /**
   * PRISM_HOME，**必填、无默认值**（Q-4）：省略即回落真实宿主目录（R5 事故形态）。
   * 各入口的注入方式：HTTP → `GraphDeps.home`（`app.ts` 单点解析）、MCP → `createMcpTools({ home })`、
   * CLI → `ctx.home ?? prismHome()`。
   */
  home: string
  /** 覆盖产物目录（缺省 `mergedGraphDir(home)`；测试用临时目录） */
  outDir?: string
  /** graphify 环境覆盖（测试注入假实现） */
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** 只合并、不渲染（测试或仅需 graph.json 时） */
  skipRender?: boolean
}

export interface MergeProjectGraphsResult {
  /** 参与合并的项目名（保持入参顺序） */
  projects: string[]
  /** 产物目录（不在任何项目根内） */
  outDir: string
  /** 合并后的 graph.json 绝对路径（渲染后即带 community 的那份） */
  graphPath: string
  /** 渲染出的自包含 HTML 绝对路径（`skipRender` → null） */
  htmlPath: string | null
  /** HTML 是否真的落盘（`skipRender` → false） */
  htmlExists: boolean
  nodes: number | null
  edges: number | null
  /** graphify 原始输出（诊断用） */
  raw: string
}

/**
 * 合并多个已注册项目的代码图谱，并在 `<outDir>/graphify-out/` 渲染出可预览的 `graph.html`。
 *
 * 错误口径：
 * - 项目数 <2 → `bad_request`（不启动子进程）；
 * - 任一项目缺 `graphify-out/graph.json` → `graph_not_found` + 可执行的建图提示；
 * - graphify 自身失败/缺失 → 由 `runGraphify` 映射为 `graphify_failed` / `graphify_missing`。
 */
export async function mergeProjectGraphs(
  projects: MergeProjectInput[],
  options: MergeProjectGraphsOptions,
): Promise<MergeProjectGraphsResult> {
  if (projects.length < 2) {
    throw new PrismError('bad_request', `合并至少需要 2 个项目，收到 ${projects.length} 个`, {
      projects: projects.map((item) => item.project),
    })
  }

  // 生效前提：每个项目都已建图。缺图谱时给可执行提示，而不是让 graphify 报文件不存在。
  for (const item of projects) {
    const graphPath = defaultGraphPath(item.root)
    try {
      await access(graphPath)
    } catch {
      throw new PrismError(
        'graph_not_found',
        `项目 ${item.project} 还没有图谱：${graphPath}（先执行 prism graph build ${item.root} --name ${item.project}）`,
        { project: item.project },
      )
    }
  }

  const outDir = options.outDir ?? mergedGraphDir(options.home)
  // 注：`options.home` 必填（Q-4），故此处**不存在**「缺参 → 回落真实 ~/.prism」的路径。

  // D2 护栏：显式 outDir 也不得落在任一项目根内（否则等于往项目里写 Prism 产物）。
  const offender = firstProjectRootContaining(outDir, projects.map((item) => item.root))
  if (offender !== null) {
    throw new PrismError(
      'bad_request',
      `合并产物目录不得落在项目根内（裁决 D2）：${resolve(outDir)} 在 ${offender} 内`,
      { outDir, project: offender },
    )
  }

  await mkdir(outDir, { recursive: true })

  // cwd 固定为产物目录：即便某步落到 graphify 的默认输出路径，也只会在本目录内，
  // 不会反向污染任何项目根（D2 的防御性写法）。
  const runOptions: GraphQueryOptions = {
    cwd: outDir,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }

  const graphPath = join(outDir, 'merged-graph.json')
  const merged = await mergeGraphs(
    projects.map((item) => defaultGraphPath(item.root)),
    graphPath,
    runOptions,
  )

  let htmlPath: string | null = null
  let htmlExists = false
  if (options.skipRender !== true) {
    const rendered = await renderExternalGraph(outDir, graphPath, runOptions)
    htmlPath = rendered.htmlPath
    htmlExists = await access(htmlPath).then(
      () => true,
      () => false,
    )
  }

  return {
    projects: projects.map((item) => item.project),
    outDir,
    graphPath,
    htmlPath,
    htmlExists,
    nodes: merged.nodes,
    edges: merged.edges,
    raw: merged.raw,
  }
}

/**
 * 返回第一个「包含 target 的项目根」；都不包含 → null。
 * 用于 D2 护栏：合并产物目录不得落在任何项目根内。
 */
function firstProjectRootContaining(target: string, roots: string[]): string | null {
  const abs = resolve(target)
  for (const root of roots) {
    const base = resolve(root)
    const prefix = base.endsWith(sep) ? base : `${base}${sep}`
    if (abs === base || abs.startsWith(prefix)) return root
  }
  return null
}
