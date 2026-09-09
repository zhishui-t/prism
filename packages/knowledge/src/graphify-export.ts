/**
 * 知识图谱 → Graphify graph.json 导出（D9：书级/全库图谱借 Graphify 渲染与导出）。
 *
 * 为什么这样接：Graphify 处理**文档**需 LLM API key（实测报 no LLM API key found），
 * 而 Prism 的红线是「不调 LLM」。故走另一条路——
 * **Prism 自己零 LLM 抽取的边表 → 转成 Graphify 的 graph.json 格式 → 交给 Graphify
 * 做社区发现、HTML 渲染与 Obsidian 导出**（这些环节是纯计算，不需要 LLM）。
 *
 * 格式对齐实测（Graphify-Labs v0.9.56）：
 *   { directed, multigraph, graph, nodes:[{id,label,...,community?}], links:[{source,target,relation,confidence,...}] }
 * - `cluster-only --graph <file>` 会补 community 并产出 GRAPH_REPORT.md / graph.html；
 * - `export obsidian --graph <file>` 产出 Obsidian vault（每节点一篇 .md + graph.canvas）。
 */

import type { GraphView, KnowledgeEdge, KnowledgeEntry, Layer } from './types.js'

/** Graphify graph.json 的节点（保留 Prism 归属字段，便于溯源）。 */
export interface GraphifyNode {
  id: string
  label: string
  /** Graphify 用于图例/导出分类的字段 */
  file_type: 'doc'
  type: string
  norm_label: string
  source_file: string
  source_location: string
  /** Prism 归属（不进 Graphify 语义，仅供溯源） */
  layer: Layer
  owner?: string
  book: string
  module: string
}

/** Graphify graph.json 的边。 */
export interface GraphifyLink {
  source: string
  target: string
  relation: string
  _origin: string
  confidence: string
  confidence_score: number
  context: string
  source_file: string
  source_location: string
  weight: number
}

/** Graphify graph.json（networkx node_link 兼容形态）。 */
export interface GraphifyGraph {
  directed: boolean
  multigraph: boolean
  graph: Record<string, unknown>
  nodes: GraphifyNode[]
  links: GraphifyLink[]
}

/** 节点出处：`层[/owner]/书/模块/ID`（与检索 source 同构，便于回查）。 */
function nodeSource(node: GraphView['nodes'][number]): string {
  return [
    node.layer,
    ...(node.owner !== undefined ? [node.owner] : []),
    node.book,
    node.module === '' ? '_inbox' : node.module,
    node.id,
  ].join('/')
}

/** 边上下文：按关系类型给 Graphify 一个可读的 context 标签。 */
const EDGE_CONTEXT: Record<string, string> = {
  references: 'wiki_link',
  overrides: 'override',
  supersedes: 'supersede',
  related: 'related',
}

/**
 * GraphView → Graphify graph.json。
 * - 悬空引用（to_id 不在节点集）会被丢弃：Graphify 要求边两端存在，否则渲染报错；
 * - 保留 Prism 归属字段（layer/owner/book/module）供导出笔记溯源。
 */
export function toGraphifyGraph(view: GraphView): GraphifyGraph {
  const nodeIds = new Set(view.nodes.map((n) => n.id))
  const nodes: GraphifyNode[] = view.nodes.map((n) => ({
    id: n.id,
    label: n.title,
    file_type: 'doc',
    type: n.type,
    norm_label: n.title,
    source_file: nodeSource(n),
    source_location: 'L1',
    layer: n.layer,
    ...(n.owner !== undefined ? { owner: n.owner } : {}),
    book: n.book,
    module: n.module,
  }))

  const links: GraphifyLink[] = []
  for (const edge of view.edges) {
    if (!nodeIds.has(edge.from_id) || !nodeIds.has(edge.to_id)) continue
    links.push({
      source: edge.from_id,
      target: edge.to_id,
      relation: edge.relation,
      _origin: 'prism',
      confidence: edge.confidence,
      confidence_score: edge.confidence === 'EXTRACTED' ? 1.0 : 0.6,
      context: EDGE_CONTEXT[edge.relation] ?? edge.relation,
      source_file: edge.from_id,
      source_location: 'L1',
      weight: edge.weight,
    })
  }

  return { directed: false, multigraph: false, graph: {}, nodes, links }
}

/** 供上层展示的导出摘要。 */
export interface GraphifyExportSummary {
  nodes: number
  edges: number
  /** 被丢弃的悬空边数 */
  dropped_edges: number
}

/** 统计导出规模（含悬空边计数，供日志/响应）。 */
export function graphifyExportSummary(view: GraphView): GraphifyExportSummary {
  const nodeIds = new Set(view.nodes.map((n) => n.id))
  let dropped = 0
  for (const edge of view.edges) {
    if (!nodeIds.has(edge.from_id) || !nodeIds.has(edge.to_id)) dropped++
  }
  return { nodes: view.nodes.length, edges: view.edges.length - dropped, dropped_edges: dropped }
}

/** 便捷：从完整条目列表构造 GraphView（用于「导出全库」而不只是某次查询的子图）。 */
export function graphViewFromEntries(
  entries: KnowledgeEntry[],
  edges: KnowledgeEdge[],
): GraphView {
  const nodes = entries.map((e) => ({
    id: e.id,
    title: e.title,
    type: e.type,
    layer: e.layer,
    ...(e.owner !== undefined ? { owner: e.owner } : {}),
    book: e.book,
    module: e.module,
    in_degree: edges.filter((x) => x.to_id === e.id).length,
    out_degree: edges.filter((x) => x.from_id === e.id).length,
  }))
  return { nodes, edges, truncated: false }
}
