/**
 * v10 F9：图谱分层聚合（`GET /api/graph/rollup`）的**纯函数**聚合层。
 *
 * 分工：读盘（`readCodeGraphCached`）+ 路由校验在路由里，本模块**零 IO、零时钟**——
 * 入参是已规范化的 `NormalizedGraph`，出参是可直接序列化的 `RollupResult`。
 *
 * 四层（每层一次请求，按需下钻）：
 * - `community`（无 parent）→ 按 graph.json 的 `community` 分组（缺失归 `community:_`「未分组」桶）
 * - `dir`（parent=`community:<n>`）→ **该社区成员**按 `source_file` 的 dirname **全路径**聚合
 *   （原稿「路径首段」在 monorepo 下退化成 `packages`/`apps` 两个组，下钻无意义，弃用）
 * - `file`（parent=`dir:<path>`）→ 该目录下的文件（**全图口径**，见下「非包含树」）
 * - `symbol`（parent=`file:<path>`，只读出口）→ 文件内符号，`nodes[].id` 是**真实图谱节点 id**
 *   （合成节点在四模式查询里必然寻址不到，故 file 层必须给这个口）
 *
 * **三层是对同一节点的独立投影，不是包含树**（交叉验证钉死，本仓 62/274 文件跨社区）：
 * 同一文件的符号可属多个社区，所以 `community:1 → dir:src/sub` 的计数（只数社区 1 的成员）
 * 与随后 `dir:src/sub → file:…` 的计数（全图口径）**不相等是正常的**——合成 id
 * `dir:<path>` / `file:<path>` 不含社区段，下钻后自然回到全图口径。
 *
 * 合成 id 编码：`community:<n>` / `dir:<path>`（正斜杠）/ `file:<path>`（正斜杠）。
 * 路径一律正斜杠（graph.json 的 `source_file` 实测即正斜杠；反斜杠在此归一）。
 */
import { PrismError } from '@prism/core'
import { normalizeGraph } from '@prism/agents'
import type { CodeGraph, CodeGraphEdge, CodeGraphNode, NormalizedGraph } from '@prism/agents'

export type RollupLevel = 'community' | 'dir' | 'file' | 'symbol'

export const ROLLUP_LEVELS: readonly RollupLevel[] = ['community', 'dir', 'file', 'symbol']

/**
 * 单层节点上限（超此数按 `symbol_count` 降序截断，label 字典序次级）。
 *
 * 存在理由：社区数可达数千（本仓 2340 节点），一次全量吐给 SVG 会让前端卡死；
 * 截断在**每层每 parent**生效（深层目录整棵收进「更多」展开）。
 */
export const ROLLUP_MAX_NODES = 500

export interface RollupNode {
  id: string
  label: string
  kind: RollupLevel
  symbol_count: number
  /** 仅 dir 层填父社区编号（`community:_` 桶无编号，省略） */
  community?: number | string
}

export interface RollupEdge {
  from: string
  to: string
  /** 跨组边**条数**（与边自带的 `weight` 字段无关） */
  weight: number
}

export interface RollupResult {
  level: RollupLevel
  /** 合成 parent id（community 层为 `null`） */
  parent: string | null
  /** 截断**前**的全量节点数 */
  total: number
  truncated: boolean
  nodes: RollupNode[]
  edges: RollupEdge[]
}

/**
 * 「calls 族」关系集合——镜像 `packages/agents/src/arch/graph-ir.ts` 的私有常量
 * `CALL_RELATIONS`（`['calls','invokes']`）。该常量在 agents 侧**未导出**，
 * 故此处镜像口径；若上游增删，需同步改这里（全仓搜 `CALL_FAMILY_RELATIONS`）。
 *
 * ⚠ 刻意**不用**设计稿点名的 `DEPENDENCY_RELATIONS`：那个集合含 `imports`，与 F9 契约
 * 「weight 只统计 calls 族，不计 `imports`(1388)/`re_exports`(876) 等结构边」直接冲突。
 * 语义上也该分开——「调用强度」看谁调谁，「结构依赖」看谁引谁，混起来会把 import 密度
 * 当成调用密度。回归用例里放了一条 `imports` 边锁定「不计入」。
 */
const CALL_FAMILY_RELATIONS: ReadonlySet<string> = new Set(['calls', 'invokes'])

/** 无 `community` 的节点归此桶（合并图未聚类）——id 段用 `_`。 */
const UNGROUPED_COMMUNITY = '_'

/** 无 `source_file`（或文件就在仓库根、取不出目录）的节点归此桶。 */
const UNKNOWN_DIR = '(unknown)'

/** 无 `source_file` 的节点在 file 层的合成文件名（与 dir 层同一口径，下钻不断链）。 */
const UNKNOWN_FILE = '(unknown)'

export function isRollupLevel(raw: string): raw is RollupLevel {
  return (ROLLUP_LEVELS as readonly string[]).includes(raw)
}

/**
 * 读侧归一（v10 派修 P2-4）：`normalizeGraph` 读边用的是 `links ?? edges`——两键**并存**时
 * `links: []`（空数组，非 nullish）会胜出，把非空的 `edges` **静默丢掉**；而本仓读同一份
 * 产物的另一条路 `readGraphEdges`（`graph/graphify.ts`，`/api/graph/relations` 走它）是
 * **非空侧优先**。于是合成/合并产物可触发「rollup 见 0 边，relations 却看得到边」这种
 * 最难查的静默降级（真实 graph.json 只写 `links`，故本仓未触发）。
 *
 * 归一规则与 `readGraphEdges` 逐字同口径：`edges` 非空取 `edges`，否则取 `links`。
 * 放在 rollup **入口**（路由读图之后、`buildRollup` 之前）做的理由：`buildRollup` 收的是
 * 已规范化的 `NormalizedGraph`，那时两键的信息已经丢了，改不动。
 */
export function normalizeRollupGraph(graph: CodeGraph): NormalizedGraph {
  const edges = graph.edges ?? []
  const links = graph.links ?? []
  // 选中的那一边经 `links` 位传给 `normalizeGraph`（它只认这一条读边口）
  const picked = edges.length > 0 ? edges : links
  return normalizeGraph({ nodes: graph.nodes, links: picked })
}

/**
 * 反解 `parent` 的**形态**（不校验实体是否存在——那需要图，归 `buildRollup`）。
 *
 * 形态错 → `bad_request`；`community` 层不接受 parent（传了多半是调用方串层）。
 * 返回值：`community` 层为 `null`；`dir` 层为社区键（`_` = 未分组）；`file` 层为目录全路径；
 * `symbol` 层为文件路径。
 */
export function decodeRollupParent(level: RollupLevel, parent: string | null): string | null {
  const raw = parent === null ? '' : parent.trim()
  switch (level) {
    case 'community': {
      if (raw !== '') {
        throw new PrismError('bad_request', `community 层不接受 parent: ${raw}`)
      }
      return null
    }
    case 'dir':
      return decodePrefixed(raw, 'dir', 'community:', 'community:<n>')
    case 'file':
      return decodePrefixed(raw, 'file', 'dir:', 'dir:<目录全路径>')
    case 'symbol':
      return decodePrefixed(raw, 'symbol', 'file:', 'file:<文件路径>')
  }
}

/**
 * 按层聚合并返回结果（parent 为 `decodeRollupParent` 的返回值）。
 *
 * @throws PrismError `bad_request` parent 形态与层不匹配；`not_found` parent 反解后图中无对应实体
 */
export function buildRollup(graph: NormalizedGraph, level: RollupLevel, parent: string | null): RollupResult {
  switch (level) {
    case 'community':
      return communityLayer(graph)
    case 'dir':
      return dirLayer(graph, requireValue(parent, level))
    case 'file':
      return fileLayer(graph, requireValue(parent, level))
    case 'symbol':
      return symbolLayer(graph, requireValue(parent, level))
  }
}

// ===== 各层 =====

function communityLayer(graph: NormalizedGraph): RollupResult {
  const groups = new Map<string, { label: string; count: number }>()
  const groupOf = new Map<string, string>()
  for (const node of graph.nodes) {
    const key = communityOf(node)
    const id = `community:${key}`
    groupOf.set(node.id, id)
    const hit = groups.get(id)
    if (hit === undefined) {
      groups.set(id, { label: communityLabel(node, key), count: 1 })
    } else {
      hit.count += 1
      // `community_name` 取**首个非空**（同社区各节点应一致；个别节点缺字段不覆盖已有名字）
      if (hit.label === fallbackCommunityLabel(key)) {
        hit.label = communityLabel(node, key)
      }
    }
  }
  const nodes: RollupNode[] = [...groups].map(([id, group]) => ({
    id,
    label: group.label,
    kind: 'community',
    symbol_count: group.count,
  }))
  return finalize('community', null, nodes, crossGroupEdges(graph.edges, groupOf))
}

function dirLayer(graph: NormalizedGraph, communityKey: string): RollupResult {
  const members = graph.nodes.filter((node) => communityOf(node) === communityKey)
  if (members.length === 0) {
    throw new PrismError('not_found', `图谱中没有 community:${communityKey} 对应的社区成员`)
  }
  const parentId = `community:${communityKey}`
  // 编号原样回填（保留 number 形态；`_` 桶无编号）
  const communityRaw = members[0]?.community
  const groups = new Map<string, { label: string; count: number }>()
  const groupOf = new Map<string, string>()
  for (const node of members) {
    const dir = dirOf(node)
    const id = `dir:${dir}`
    groupOf.set(node.id, id)
    const hit = groups.get(id)
    if (hit === undefined) groups.set(id, { label: dir, count: 1 })
    else hit.count += 1
  }
  const nodes: RollupNode[] = [...groups].map(([id, group]) => ({
    id,
    label: group.label,
    kind: 'dir',
    symbol_count: group.count,
    ...(communityKey === UNGROUPED_COMMUNITY || communityRaw === undefined || communityRaw === null
      ? {}
      : { community: communityRaw }),
  }))
  return finalize('dir', parentId, nodes, crossGroupEdges(graph.edges, groupOf))
}

function fileLayer(graph: NormalizedGraph, dir: string): RollupResult {
  const members = graph.nodes.filter((node) => dirOf(node) === dir)
  if (members.length === 0) {
    throw new PrismError('not_found', `图谱中没有 dir:${dir} 对应的目录`)
  }
  const groups = new Map<string, { label: string; count: number }>()
  const groupOf = new Map<string, string>()
  for (const node of members) {
    const file = fileKeyOf(node)
    const id = `file:${file}`
    groupOf.set(node.id, id)
    const hit = groups.get(id)
    if (hit === undefined) groups.set(id, { label: file, count: 1 })
    else hit.count += 1
  }
  const nodes: RollupNode[] = [...groups].map(([id, group]) => ({
    id,
    label: group.label,
    kind: 'file',
    symbol_count: group.count,
  }))
  return finalize('file', `dir:${dir}`, nodes, crossGroupEdges(graph.edges, groupOf))
}

/**
 * symbol 层（只读出口）：`edges` 恒 `[]`——本层不再分组，调用关系由「对符号发四模式查询」回答。
 * `symbol_count` 恒 1（每行就是一个符号）。
 */
function symbolLayer(graph: NormalizedGraph, file: string): RollupResult {
  const members = graph.nodes.filter((node) => fileKeyOf(node) === file)
  if (members.length === 0) {
    throw new PrismError('not_found', `图谱中没有 file:${file} 对应的文件`)
  }
  const nodes: RollupNode[] = members.map((node) => ({
    id: node.id,
    label: labelOf(node),
    kind: 'symbol',
    symbol_count: 1,
  }))
  return finalize('symbol', `file:${file}`, nodes, [])
}

// ===== 分组 / 截断 / 边 =====

/** 跨组边计数：只认 calls 族；两端都必须在本层节点集内；同组边不计（「跨组」）。 */
function crossGroupEdges(edges: readonly CodeGraphEdge[], groupOf: Map<string, string>): RollupEdge[] {
  const weights = new Map<string, RollupEdge>()
  for (const edge of edges) {
    const relation = typeof edge.relation === 'string' ? edge.relation : ''
    if (!CALL_FAMILY_RELATIONS.has(relation)) continue
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') continue
    const from = groupOf.get(edge.source)
    const to = groupOf.get(edge.target)
    if (from === undefined || to === undefined || from === to) continue
    const key = `${from}\u0000${to}`
    const hit = weights.get(key)
    if (hit === undefined) weights.set(key, { from, to, weight: 1 })
    else hit.weight += 1
  }
  return [...weights.values()]
}

/** 截断 + 无悬挂边 + 稳定排序（`symbol_count` 降序，label 字典序次级）。 */
function finalize(level: RollupLevel, parent: string | null, nodes: RollupNode[], edges: RollupEdge[]): RollupResult {
  const total = nodes.length
  const truncated = total > ROLLUP_MAX_NODES
  const kept = [...nodes].sort(compareRollupNodes).slice(0, ROLLUP_MAX_NODES)
  const visible = new Set(kept.map((node) => node.id))
  return {
    level,
    parent,
    total,
    truncated,
    nodes: kept,
    edges: edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)).sort(compareRollupEdges),
  }
}

/** `symbol_count` 降序 → label 字典序（码元序，确定性；locale 相关排序不做）。 */
function compareRollupNodes(a: RollupNode, b: RollupNode): number {
  if (a.symbol_count !== b.symbol_count) return b.symbol_count - a.symbol_count
  if (a.label === b.label) return 0
  return a.label < b.label ? -1 : 1
}

function compareRollupEdges(a: RollupEdge, b: RollupEdge): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1
  if (a.to !== b.to) return a.to < b.to ? -1 : 1
  return 0
}

// ===== 字段读取（容忍字段缺失/异形，缺失即降级） =====

function requireValue(parent: string | null, level: RollupLevel): string {
  if (parent === null || parent === '') {
    throw new PrismError('bad_request', `${level} 层缺少 parent`)
  }
  return parent
}

function decodePrefixed(raw: string, level: RollupLevel, prefix: string, form: string): string {
  if (raw === '') {
    throw new PrismError('bad_request', `${level} 层缺少 parent（应为 ${form}）`)
  }
  if (!raw.startsWith(prefix)) {
    throw new PrismError('bad_request', `${level} 层的 parent 形态非法: ${raw}（应为 ${form}）`)
  }
  const value = raw.slice(prefix.length).trim()
  if (value === '') {
    throw new PrismError('bad_request', `${level} 层的 parent 缺少取值: ${raw}（应为 ${form}）`)
  }
  return value
}

/** 文件路径（正斜杠归一）；缺 `source_file` 返回空串。 */
function fileOf(node: CodeGraphNode): string {
  const raw = typeof node.source_file === 'string' ? node.source_file.trim() : ''
  return raw === '' ? '' : raw.replace(/\\/g, '/')
}

/** file 层分组键：缺 `source_file` 归 `(unknown)`，保证 dir→file 下钻不断链。 */
function fileKeyOf(node: CodeGraphNode): string {
  const file = fileOf(node)
  return file === '' ? UNKNOWN_FILE : file
}

/**
 * 目录**全路径**（正斜杠）；缺 `source_file`、或文件就在仓库根（取不出目录段）→ `(unknown)`。
 * 与 agents 侧 `dirSegments` 的「取 src 后一段」不同——F9 契约明确要全路径。
 */
function dirOf(node: CodeGraphNode): string {
  const file = fileOf(node)
  if (file === '') return UNKNOWN_DIR
  const cut = file.lastIndexOf('/')
  return cut <= 0 ? UNKNOWN_DIR : file.slice(0, cut)
}

function communityOf(node: CodeGraphNode): string {
  const raw = node.community
  if (raw === undefined || raw === null) return UNGROUPED_COMMUNITY
  const text = String(raw).trim()
  return text === '' ? UNGROUPED_COMMUNITY : text
}

function communityLabel(node: CodeGraphNode, key: string): string {
  if (key === UNGROUPED_COMMUNITY) return '未分组'
  const name = typeof node.community_name === 'string' ? node.community_name.trim() : ''
  return name === '' ? fallbackCommunityLabel(key) : name
}

/** `--no-label` 之外图里可能没有 `community_name` → 回落 `Community <id>`。 */
function fallbackCommunityLabel(key: string): string {
  return `Community ${key}`
}

function labelOf(node: CodeGraphNode): string {
  const label = typeof node.label === 'string' ? node.label.trim() : ''
  return label === '' ? node.id : label
}
