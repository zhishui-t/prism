/**
 * 知识图谱导出编排（D9）：Prism 零 LLM 抽边 → Graphify 格式 → 渲染 / Obsidian 导出。
 *
 * 为什么不让 Graphify 直接吃 Markdown：实测 Graphify 处理**文档**需要 LLM API key
 * （`no LLM API key found (N doc file(s) need semantic extraction)`），与 Prism
 * 「不调 LLM」红线冲突。而 Prism 自己已经从正文双链/overrides 抽出了确定性边表——
 * 把它转成 Graphify 的 graph.json，再借 Graphify 做**纯计算**的社区发现、HTML 渲染、
 * Obsidian 导出，既拿到能力又不破红线。
 *
 * 产物落 `<PRISM_HOME>/graphify-kb/`：
 *   graph.json           Prism 导出的 Graphify 格式（含 community，聚类后回写）
 *   graphify-out/        graph.html / GRAPH_REPORT.md
 *   graphify-out/obsidian/  Obsidian vault（每节点一篇 .md + graph.canvas）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismError, prismPaths } from '@prism/core'
import {
  graphifyExportSummary,
  toGraphifyGraph,
  type GraphView,
  type KnowledgeService,
} from '@prism/knowledge'

import {
  exportExternalGraph,
  renderExternalGraph,
  type GraphifyExportFormat,
  type GraphQueryOptions,
} from '../graph/graphify.js'

export interface KbGraphExportOptions {
  /** 导出目标：'html'（聚类+渲染）或 export 格式（obsidian/svg/…） */
  format: 'html' | GraphifyExportFormat
  /** 图视图（缺省取全库概览） */
  view?: GraphView
  graphifyEnv?: NodeJS.ProcessEnv
  graphifyTimeoutMs?: number
}

export interface KbGraphExportResult {
  format: string
  /** 工作目录（Prism 导出的 graph.json 所在处） */
  workDir: string
  /** Prism 导出的 Graphify 格式 graph.json */
  graphJson: string
  /** HTML 产物（format='html' 时） */
  html?: string
  /** 导出产物路径 */
  output: string
  files: string[]
  summary: { nodes: number; edges: number; dropped_edges: number }
  raw: string
}

/** 知识图谱导出工作目录（<PRISM_HOME>/graphify-kb）。 */
export function kbGraphWorkDir(home?: string): string {
  return join(prismPaths(home).home, 'graphify-kb')
}

/**
 * 导出知识图谱：取图 → 转 Graphify 格式 → 落盘 → 调 Graphify 渲染/导出。
 * 零 LLM：Prism 负责抽边，Graphify 只做社区发现与渲染。
 */
export async function exportKnowledgeGraph(
  kb: KnowledgeService,
  options: KbGraphExportOptions & { home?: string },
): Promise<KbGraphExportResult> {
  const view = options.view ?? (await kb.graph({ limit: 500 }))
  if (view.nodes.length === 0) {
    throw new PrismError('not_found', '知识图谱为空（还没有任何双链或 overrides 关系）')
  }
  const summary = graphifyExportSummary(view)
  const graph = toGraphifyGraph(view)

  const workDir = kbGraphWorkDir(options.home)
  await mkdir(workDir, { recursive: true })
  const graphJson = join(workDir, 'graph.json')
  await writeFile(graphJson, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8')

  const runOptions: GraphQueryOptions = {
    ...(options.graphifyEnv !== undefined ? { env: options.graphifyEnv } : {}),
    ...(options.graphifyTimeoutMs !== undefined ? { timeoutMs: options.graphifyTimeoutMs } : {}),
  }

  if (options.format === 'html') {
    const rendered = await renderExternalGraph(workDir, graphJson, runOptions)
    return {
      format: 'html',
      workDir,
      graphJson,
      html: rendered.htmlPath,
      output: rendered.htmlPath,
      files: ['graph.html', 'GRAPH_REPORT.md', 'graph.json'],
      summary,
      raw: rendered.raw,
    }
  }

  const outDir = join(workDir, 'graphify-out')
  await mkdir(outDir, { recursive: true })
  const result = await exportExternalGraph(graphJson, options.format, outDir, runOptions)
  return {
    format: result.format,
    workDir,
    graphJson,
    output: result.output,
    files: result.files,
    summary,
    raw: result.raw,
  }
}
