/**
 * 代码图谱（Graphify 产物）→ archify `architecture` / `sequence` / `dataflow` IR。
 *
 * **纯函数**：零 IO、零时钟、零随机（红线 R7：IR 是派生视图）。
 * 读盘（`graphify-out/graph.json`）在 `@prism/server` 的 `readCodeGraph` 里做，
 * 本模块只接受已解析的数据——同输入必须同字节，否则 sidecar 的 `ir_hash` 失去意义。
 *
 * ## 输入契约
 *
 * Graphify 产物是 `{ nodes, links }`（部分版本写 `edges`），节点/边字段为**可选**——
 * 实测跨 5 个真实样本（`3rd/graphify/worked/*`、`packages/core/.graphify`）字段并不齐：
 * 有的节点带 `community_name`，有的没有；`source_file` 一律为**仓库相对路径**。
 *
 * 边的 relation 全集（实测）：`contains` / `imports` / `imports_from` / `method` /
 * `re_exports` / `calls` / `uses` / `inherits` / `rationale_for`。
 * **没有 reads / writes / stores** —— 这一点直接决定了 `dataflow` 的口径（见下）。
 *
 * ## 各图口径（改口径 = 改所有产物，需评审）
 *
 * ### architecture —— 模块聚类视图
 * - **社区（`node.community`）→ 组件**；组件的显示名取社区内**出现最多的目录段**
 *   （`community_name` 实测多为无信息量的 `Community 3`，故仅在有实义时采用）。
 * - **目录段 → 边界（region）+ 列**：同目录段的组件排在同一列，外包一个 `region` 边界。
 *   目录段的取法见 `makeRegionOf`（相对全仓库公共目录前缀取 1–2 段，兼容 monorepo 的
 *   `packages/x/src/y` 与绝对路径的 `/home/u/proj/x`）。
 * - **依赖边 → 连接**：只取 `imports` / `imports_from` / `uses` / `calls` / `inherits`
 *   （`contains` / `method` / `re_exports` 是文件内结构边，画出来只会糊成一团）。
 * - 组件类型按目录关键词启发式映射（`inferComponentType`），未匹配 → `backend`。
 *
 * ### sequence —— 跨文件调用链视图
 * - **参与者 = 文件**（不是社区：时序图需要「谁调用谁」的精确角色）。
 * - 只取**跨文件**的 `calls` 边；同文件内的调用不产生消息（会退化成自环）。
 * - 根参与者 = 调用图上**度数最高**的文件（并列取字典序），从它做 BFS 收集参与者与消息，
 *   全部按 BFS 发现顺序输出——**不用「最重要」这类主观排序**，保证可复现。
 *
 * ### dataflow —— **依赖流向视图**（口径声明，非真实数据流）
 * - ⚠️ Graphify 图谱**没有数据读写边**，因此无法派生真正的数据流图。
 *   本图为**换口径**产物：按目录角色把模块分到「入口 / 接口 / 领域 / 基础设施 / 存储」
 *   五层，边取依赖关系的跨层流动。
 * - 这个口径**写进 `meta.subtitle`**，避免读图的人误以为它是真实数据流。
 */

import { anchorOf, freeTracks, pickLabelAt, planRoutes, type LabelRect, type RouterBox, type RouterSide } from './router.js'
import { allocateId, assertArchifyId, fitMiddle, fitUnits, stableTop, textUnits } from './text.js'
import type { ArchifyComponentType, ArchifyMeta } from './types.js'

/**
 * 连线标签的矩形尺寸（口径对齐 `render-architecture.mjs`：`max(30, textUnits*4.8+10) × 14`）。
 *
 * 我们的 `textUnits` 是保守近似（宁可算宽），再加 6px 余量，保证「我们以为放得下」时
 * 渲染器也一定放得下。
 */
function archLabelWidth(label: string): number {
  return Math.max(30, textUnits(label) * 4.8 + 10) + 6
}

/** 同上，dataflow 口径：`max(34, textUnits*4.9+12) × 16`。 */
function flowLabelWidth(label: string): number {
  return Math.max(34, textUnits(label) * 4.9 + 12) + 6
}

/** 把 `via` 补成渲染器实际会画的完整折线（首末点 = 两端锚点）。 */
function fullPath(
  from: RouterBox,
  to: RouterBox,
  fromSide: RouterSide,
  toSide: RouterSide,
  via: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  return [anchorOf(from, fromSide), ...via.map(([x, y]) => [x, y] as [number, number]), anchorOf(to, toSide)]
}

// ===== 输入类型（Graphify 产物；字段按实测设为可选，缺失即降级而非抛错）=====

export interface CodeGraphNode {
  id: string
  label?: string
  file_type?: string
  source_file?: string
  source_location?: string
  community?: number | string
  community_name?: string
}

export interface CodeGraphEdge {
  source?: string
  target?: string
  relation?: string
  confidence?: string
  weight?: number
  source_file?: string
}

/** Graphify `graph.json` 的结构（`links` 与 `edges` 两种写法都兼容）。 */
export interface CodeGraph {
  nodes?: readonly CodeGraphNode[]
  links?: readonly CodeGraphEdge[]
  edges?: readonly CodeGraphEdge[]
}

/** 规范化后的图谱（丢弃缺 `id` / 缺端点的行，保证后续步骤不必再判空）。 */
export interface NormalizedGraph {
  nodes: CodeGraphNode[]
  edges: CodeGraphEdge[]
}

export function normalizeGraph(graph: CodeGraph): NormalizedGraph {
  const nodes = (graph.nodes ?? []).filter((node) => typeof node?.id === 'string' && node.id !== '')
  const edges = (graph.links ?? graph.edges ?? []).filter(
    (edge) => typeof edge?.source === 'string' && typeof edge?.target === 'string',
  )
  return { nodes, edges }
}

// ===== 共用派生 =====

/** 仓库相对路径（统一分隔符）；缺失返回 null。 */
function fileOf(node: CodeGraphNode | undefined): string | null {
  const raw = node?.source_file
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return raw.replace(/\\/g, '/')
}

/**
 * 目录段（决定边界与列）。
 *
 * 取最后一个 `src` 之后的**一段**；没有 `src` 时取第一段。实测口径：
 * - `src/audit/audit-log.ts` → `audit`
 * - `packages/server/src/kb/scan.ts` → `kb`（monorepo 不会被压成 `packages`）
 * - `src/game.js` → `src`（文件直接在 src 下，退化为目录名本身）
 * - `index.ts` → `root`
 */
/** 目录段（丢掉空段：绝对路径 `/a/b/c.ts` 分段后首段是空串，留着会污染公共前缀）。 */
function dirSegments(sourceFile: string): string[] {
  return sourceFile
    .split('/')
    .slice(0, -1)
    .filter((segment) => segment !== '')
}

/**
 * 全仓库**公共目录前缀**（按路径段对齐）。
 *
 * 为什么要先求它：`source_file` 的形态在不同图谱里差得很远——
 * 有的是仓库相对路径（`backend/app/api/x.py`），有的是**绝对路径**
 * （`/home/safi/.../repos/minGPT/mingpt/x.py`），有的是被拍平的快照
 * （`worked/httpx/raw/x.py`）。不先归一化，任何「取前 N 段」的规则都会
 * 把绝对路径全判成同一个 `/home`，或者把拍平快照里的所有文件判成一个目录。
 */
export function commonDirPrefix(files: readonly string[]): string[] {
  let prefix: string[] | null = null
  for (const file of files) {
    const dirs = dirSegments(file)
    if (prefix === null) {
      prefix = dirs
      continue
    }
    let i = 0
    while (i < prefix.length && i < dirs.length && prefix[i] === dirs[i]) i++
    prefix = prefix.slice(0, i)
  }
  return prefix ?? []
}

/**
 * 生成「文件路径 → 区域名」的映射函数。
 *
 * 规则（相对公共前缀后判定）：
 * 1. 出现 `src` → 取 `src` **之后**的最多两段（`frontend/src/api/x.ts` → `api`）；
 *    文件直接躺在 `src` 下时取 `src` 前一段当包名（`packages/core/src/x.ts` → `core`），
 *    再没有就用 `src`（`src/x.py` → `src`）；
 * 2. 没有 `src` → 取**头两段**（`backend/app/api/x.py` → `backend/app`）。
 *
 * ⚠️ 必须是**函数工厂而不是单文件函数**：区域名依赖全仓库的公共目录前缀，
 * 同一个路径在不同仓库里该算哪个区域是不同的。曾有过一个单文件版
 * `regionOf(file)`，它拿不到语料、只能把自己目录全当公共前缀，于是任何路径都返回
 * `(root)`——这种「看起来能用」的 API 比没有更糟，已删除。
 *
 * 旧实现的另外两个真缺陷（真实样本实测）：取「最后一个 `src` 之后的一段」时，
 * 文件直接躺在 `src` 下会返回**文件名**（`src/game.py` → `game.py`，每个文件自成区域）；
 * 没有 `src` 时一律取第一段，把 `backend/app/api` 与 `backend/app/services` 压成 `backend`。
 */
export function makeRegionOf(files: readonly string[]): (sourceFile: string) => string {
  const prefix = commonDirPrefix(files)
  return (sourceFile: string): string => {
    const dirs = dirSegments(sourceFile)
    const relative = dirs.slice(prefix.length)
    if (relative.length === 0) return '(root)'
    const srcAt = relative.lastIndexOf('src')
    if (srcAt >= 0) {
      const after = relative.slice(srcAt + 1)
      if (after.length > 0) return after.slice(0, 2).join('/')
      return srcAt > 0 ? relative[srcAt - 1]! : 'src'
    }
    return relative.slice(0, 2).join('/')
  }
}

/**
 * 目录/名称 → archify 组件类型（启发式，顺序即优先级）。
 *
 * 未匹配一律 `backend`（保守：宁可归类到主流程，也不臆造 `cloud` / `security`）。
 */
const TYPE_RULES: ReadonlyArray<readonly [RegExp, ArchifyComponentType]> = [
  [/^(auth|security|permission|policy|guard|secret|crypto)/i, 'security'],
  [/^(db|database|persist|store|storage|sqlite|sql|schema|migration|repo)/i, 'database'],
  [/^(queue|bus|event|stream|message|mq|kafka|worker|job|scheduler)/i, 'messagebus'],
  [/^(web|ui|view|component|page|render|front|client|browser|style)/i, 'frontend'],
  [/^(cloud|deploy|infra|k8s|docker|helm|ci|config|env)/i, 'cloud'],
  [/^(api|http|route|router|server|handler|endpoint|controller|rest|grpc|middleware)/i, 'backend'],
  [/^(test|spec|mock|fixture|e2e|bench)/i, 'external'],
]

export function inferComponentType(hint: string): ArchifyComponentType {
  const token = hint.toLowerCase().replace(/[^a-z0-9]+/g, '')
  for (const [re, type] of TYPE_RULES) {
    if (re.test(token)) return type
  }
  return 'backend'
}

/** 参与「依赖」语义的边类型（其余是文件内结构边，不画）。 */
const DEPENDENCY_RELATIONS: ReadonlySet<string> = new Set([
  'imports',
  'imports_from',
  'uses',
  'calls',
  'inherits',
  'invokes',
  'depends_on',
])

/** 调用语义的边类型（`sequence` 专用；比依赖更严格）。 */
const CALL_RELATIONS: ReadonlySet<string> = new Set(['calls', 'invokes'])

// ===== 节点文本硬上限 =====

/**
 * 文本上限（单位 = `textUnits`：全角/CJK 计 2）。
 *
 * archify 各渲染器把 `label`/`sublabel` 画成**不换行的单行 `<text>`**，放不下即判节点非法。
 * 口径为 `textUnits * 6 * 0.6 <= 节点宽 - 8`（label 更严：`* 6.2 <= 宽 + 6`）。
 * 我们显式给组件 `size`，宽度可控，故按各自宽度留余量设定；
 * **收敛文本而不是加宽节点**——加宽会触发自动布线横向错位（见 workflow-ir 的同名教训）。
 */
const ARCH_TEXT = { label: 22, sublabel: 30, tag: 12 } as const

/**
 * sequence 参与者 / 消息的文本上限。
 *
 * **口径来自渲染器，不能拍脑袋**：`participantW` 默认固定 **86px**，而
 * `render-sequence.mjs` 的两条硬校验是——
 * - `label`：`textUnits(label) * 6.8 > participantW + 6` → 超标即拒 → 上限 **13 单位**
 * - `sublabel`：`textUnits * 6 * 0.6 > participantW - 8`（`nodeTextFit = {widthFactor: 0.6, horizontalPadding: 8}`）
 *   → 上限 **21 单位**
 *
 * 实测踩过：rsl-siege-manager（1886 节点）里长文件名按 20 单位截断后仍有 136px > 92px 被拒。
 */
const SEQ_TEXT = { label: 13, sublabel: 21, message: 30 } as const

/**
 * dataflow 节点 / 连线的文本上限（同样来自渲染器口径，`nodeW = 112`）：
 * - `label`：`textUnits * 6.2 <= 118` → **19 单位**（取 18 留余量）
 * - `sublabel` / `tag`：`textUnits * 6 * 0.6 <= 104` → **28 单位**（取 27）
 *
 * 实测踩过：rsl-siege-manager 上 `scripts/excel-import`（22 单位）被判 124px > 118px。
 */
const FLOW_TEXT = { label: 18, sublabel: 27, tag: 12, flow: 16 } as const

/** 组件的显式几何（archify 允许「显式 pos+size」或「layout.mode=grid」，这里取前者以完全控盘）。 */
const GEOM = {
  originX: 56,
  originY: 88,
  nodeW: 184,
  nodeH: 76,
  gapY: 44,
  colGap: 96,
  pad: 26,
} as const

// ===== 模块分组（community → 组件）=====

interface ModuleGroup {
  /** 排序与 id 用（community 原值字符串化） */
  key: string
  nodes: CodeGraphNode[]
  /** 去重的源文件数 */
  files: number
  /** 出现最多的目录段 */
  region: string
  label: string
}

/** `community_name` 是否含实义（实测多为 `Community 3` 这类占位）。 */
function isInformativeName(name: string | undefined): boolean {
  if (name === undefined) return false
  const trimmed = name.trim()
  if (trimmed === '') return false
  return !/^community[\s_-]*\d+$/i.test(trimmed)
}

/** 统计出现次数最多的键（并列取字典序最小者）。 */
function dominantOf(counts: Map<string, number>): string | null {
  let best: string | null = null
  let bestCount = -1
  for (const [key, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = key
      bestCount = count
    }
  }
  return best
}

function groupByCommunity(nodes: readonly CodeGraphNode[]): ModuleGroup[] {
  const buckets = new Map<string, CodeGraphNode[]>()
  for (const node of nodes) {
    const key = node.community === undefined || node.community === null ? 'none' : String(node.community)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [node])
    else bucket.push(node)
  }

  // 区域名依赖**全仓库公共目录前缀**，所以要拿全部文件一起算，不能逐节点孤立判定
  const regionOfFile = makeRegionOf(nodes.map((node) => fileOf(node)).filter((file): file is string => file !== null))

  const groups: ModuleGroup[] = []
  for (const [key, members] of buckets) {
    const files = new Set<string>()
    const regionCounts = new Map<string, number>()
    for (const node of members) {
      const file = fileOf(node)
      if (file === null) continue
      files.add(file)
      const region = regionOfFile(file)
      regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1)
    }
    const region = dominantOf(regionCounts) ?? 'root'
    const named = members.find((node) => isInformativeName(node.community_name))?.community_name
    groups.push({
      key,
      nodes: members,
      files: files.size,
      region,
      label: (named ?? region).trim(),
    })
  }

  // 全序：规模降序 → 键升序（并列项顺序不随 sort 实现漂移）
  return stableTop(
    groups,
    (group) => group.nodes.length,
    (group) => group.key,
  )
}

function groupId(group: ModuleGroup, used: Set<string>): string {
  // 社区名可能是纯中文（slug 后为空）→ 走 allocateId 的 `mod-N` 兜底
  return allocateId(`mod-${group.label}`, used, 'mod')
}

// ===== architecture =====

export interface ArchitectureIrComponent {
  id: string
  type: ArchifyComponentType
  label: string
  sublabel?: string
  tag?: string
  pos: [number, number]
  size: [number, number]
}

export interface ArchitectureIrBoundary {
  kind: 'region'
  label: string
  wraps: string[]
  pad?: number
}

export interface ArchitectureIrConnection {
  from: string
  to: string
  label?: string
  /** 标签锚点（`router.pickLabelAt` 算出；缺省则渲染器按路径中点放，可能压组件） */
  labelAt?: [number, number]
  fromSide?: RouterSide
  toSide?: RouterSide
  route?: 'straight'
  via?: Array<[number, number]>
}

export interface ArchitectureIr {
  schema_version: 1
  diagram_type: 'architecture'
  meta: ArchifyMeta
  components: ArchitectureIrComponent[]
  boundaries?: ArchitectureIrBoundary[]
  connections?: ArchitectureIrConnection[]
}

export interface ArchitectureIrOptions {
  title: string
  /** 组件数上限，超出者合并为一个「其他」组件；默认 12 */
  maxComponents?: number
  /** 连接数上限；默认 40 */
  maxConnections?: number
  /** 边界最少成员数（低于此不成边界，避免单组件包一圈噪声）；默认 2 */
  minBoundarySize?: number
}

/** 分组 → 组件 + 边界（共用：`architecture` 与 `dataflow` 都用这套列布局）。 */
interface PlacedGroup {
  group: ModuleGroup
  id: string
  x: number
  y: number
}

/**
 * 把分组按「目录段 = 列」排布。
 *
 * 列序：该目录段的节点数降序 → 名称升序。列内按分组规模降序（沿用 `groups` 的顺序）。
 * 这样同一目录的组件在空间上连续，`region` 边界才不会圈到别的列。
 */
function placeGroups(groups: readonly ModuleGroup[], used: Set<string>): {
  placed: PlacedGroup[]
  columns: Array<{ region: string; members: PlacedGroup[] }>
} {
  const byRegion = new Map<string, ModuleGroup[]>()
  for (const group of groups) {
    const list = byRegion.get(group.region)
    if (list === undefined) byRegion.set(group.region, [group])
    else list.push(group)
  }

  const columns = stableTop(
    [...byRegion.entries()].map(([region, members]) => ({
      region,
      members,
      weight: members.reduce((sum, group) => sum + group.nodes.length, 0),
    })),
    (column) => column.weight,
    (column) => column.region,
  )

  const placed: PlacedGroup[] = []
  const out: Array<{ region: string; members: PlacedGroup[] }> = []
  columns.forEach((column, colIndex) => {
    const x = GEOM.originX + colIndex * (GEOM.nodeW + GEOM.colGap)
    const members: PlacedGroup[] = []
    column.members.forEach((group, rowIndex) => {
      const y = GEOM.originY + rowIndex * (GEOM.nodeH + GEOM.gapY)
      const item: PlacedGroup = { group, id: groupId(group, used), x, y }
      placed.push(item)
      members.push(item)
    })
    out.push({ region: column.region, members })
  })
  return { placed, columns: out }
}

/** 跨组依赖边聚合（同组自环丢弃）。 */
function aggregateConnections(
  edges: readonly CodeGraphEdge[],
  componentOfNode: Map<string, string>,
  relations: ReadonlySet<string>,
  max: number,
): Array<{ from: string; to: string; count: number; relation: string }> {
  const byPair = new Map<string, { from: string; to: string; count: number; relations: Map<string, number> }>()
  for (const edge of edges) {
    const relation = edge.relation ?? ''
    if (!relations.has(relation)) continue
    const from = componentOfNode.get(edge.source!)
    const to = componentOfNode.get(edge.target!)
    if (from === undefined || to === undefined || from === to) continue
    const pairKey = `${from}\u0000${to}`
    const entry = byPair.get(pairKey)
    if (entry === undefined) {
      byPair.set(pairKey, { from, to, count: 1, relations: new Map([[relation, 1]]) })
    } else {
      entry.count += 1
      entry.relations.set(relation, (entry.relations.get(relation) ?? 0) + 1)
    }
  }
  const list = [...byPair.values()].map((entry) => ({
    from: entry.from,
    to: entry.to,
    count: entry.count,
    relation: dominantOf(entry.relations) ?? 'depends',
  }))
  return stableTop(
    list,
    (entry) => entry.count,
    (entry) => `${entry.from}\u0000${entry.to}`,
  ).slice(0, max)
}

/**
 * 代码图谱 → `architecture` IR。
 *
 * @throws Error 图谱无节点时抛出（schema 要求 `components` 至少 1 项；
 *   空图说明没建图或产物损坏，交给调用方报错，不伪造组件）。
 */
export function buildArchitectureIr(graph: CodeGraph, options: ArchitectureIrOptions): ArchitectureIr {
  const { nodes, edges } = normalizeGraph(graph)
  if (nodes.length === 0) {
    throw new Error('图谱没有节点：请先建图（prism graph build），或检查 graphify-out/graph.json')
  }

  const maxComponents = options.maxComponents ?? 12
  const maxConnections = options.maxConnections ?? 40
  const minBoundarySize = options.minBoundarySize ?? 2

  const grouped = groupByCommunity(nodes)
  const head = grouped.slice(0, maxComponents)
  const tail = grouped.slice(maxComponents)
  if (tail.length > 0) {
    // 尾部合并成一个组件——否则大项目会有几十个社区，图直接糊掉
    head.push({
      key: 'others',
      nodes: tail.flatMap((group) => group.nodes),
      files: tail.reduce((sum, group) => sum + group.files, 0),
      region: 'other',
      label: `其他 ${tail.length} 个模块`,
    })
  }

  const used = new Set<string>()
  const { placed, columns } = placeGroups(head, used)

  const components: ArchitectureIrComponent[] = placed.map(({ group, id, x, y }) => ({
    id,
    type: inferComponentType(group.label),
    label: fitUnits(group.label, ARCH_TEXT.label),
    sublabel: fitUnits(`${group.files} 文件 · ${group.nodes.length} 节点`, ARCH_TEXT.sublabel),
    pos: [x, y],
    size: [GEOM.nodeW, GEOM.nodeH],
  }))

  const boundaries: ArchitectureIrBoundary[] = columns
    .filter((column) => column.members.length >= minBoundarySize)
    .map((column) => ({
      kind: 'region' as const,
      label: fitUnits(column.region, ARCH_TEXT.label),
      wraps: column.members.map((member) => member.id),
      // 边界矩形由被包组件的外接盒推出；pad 只需小于列间距的一半，免得两列边界相撞
      pad: GEOM.pad,
    }))

  // 节点 → 组件 id 的映射（合并组把尾部分组的所有节点都指向自己）
  const componentOfNode = new Map<string, string>()
  placed.forEach(({ group, id }) => {
    for (const node of group.nodes) componentOfNode.set(node.id, id)
  })

  const connections = aggregateConnections(edges, componentOfNode, DEPENDENCY_RELATIONS, maxConnections)

  // 走线：archify 会用 `clean-flow/edge-through-node` **拒绝穿节点的连线**，
  // 自动布线在「同列节点之间」必然穿兄弟节点，故一律自算 `via`（见 router.ts）。
  const boxes = new Map<string, RouterBox>()
  for (const component of components) {
    const [x, y] = component.pos
    const [w, h] = component.size
    boxes.set(component.id, { x0: x, x1: x + w, y0: y, y1: y + h })
  }
  const obstacles = [...boxes.values()]
  const routed = planRoutes(
    connections,
    (entry) => {
      const from = boxes.get(entry.from)
      const to = boxes.get(entry.to)
      return from !== undefined && to !== undefined ? { from, to } : null
    },
    obstacles,
    freeTracks(obstacles, 40),
  )

  // 标签落位：archify 默认把标签放在第 2 段中点，自动挑的那段常从别的组件上方掠过，
  // 报 `Label overlaps component` 整张图被拒。自己挑位置（schema 有 labelAt 就是为此）。
  const placedLabels: LabelRect[] = []
  let droppedLabels = 0
  const irConnections: ArchitectureIrConnection[] = routed.map(({ edge, plan }) => {
    const from = boxes.get(edge.from)!
    const to = boxes.get(edge.to)!
    const base: ArchitectureIrConnection = {
      from: edge.from,
      to: edge.to,
      fromSide: plan.fromSide,
      toSide: plan.toSide,
      route: plan.route,
      via: plan.via,
    }
    if (edge.count <= 1) return base
    const label = fitUnits(`${edge.relation} ×${edge.count}`, ARCH_TEXT.sublabel)
    const pick = pickLabelAt(
      fullPath(from, to, plan.fromSide, plan.toSide, plan.via),
      obstacles,
      { width: archLabelWidth(label), height: 14 },
      placedLabels,
      { lift: 10 },
    )
    if (pick === null) {
      droppedLabels += 1
      return base
    }
    placedLabels.push(pick.box)
    return { ...base, label, labelAt: [Math.round(pick.at[0]), Math.round(pick.at[1])] }
  })

  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: options.title,
      subtitle:
        `代码图谱派生（Graphify ${nodes.length} 节点 / ${edges.length} 边）｜ ` +
        `组件 = 社区聚类，按社区内主目录命名；列与 region 边界 = 目录段；` +
        `连线 = imports/calls/uses/inherits（文件内结构边不画；${connections.length - routed.length} 条因无法避让节点被略去` +
        (droppedLabels > 0 ? `，${droppedLabels} 条多重边因放不下标签只画线不标注` : '') +
        `）`,
    },
    components,
    ...(boundaries.length > 0 ? { boundaries } : {}),
    ...(irConnections.length > 0 ? { connections: irConnections } : {}),
  }
}

// ===== sequence =====

export interface SequenceIrParticipant {
  id: string
  type: ArchifyComponentType
  label: string
  sublabel?: string
}

export interface SequenceIrMessage {
  id: string
  from: string
  to: string
  y: number
  label: string
  variant?: 'default' | 'emphasis' | 'security' | 'dashed' | 'return'
}

export interface SequenceIr {
  schema_version: 1
  diagram_type: 'sequence'
  meta: ArchifyMeta & { viewBox?: [number, number] }
  participants: SequenceIrParticipant[]
  messages: SequenceIrMessage[]
}

export interface SequenceIrOptions {
  title: string
  /** 参与者上限（含根）；默认 7 */
  maxParticipants?: number
  /** 消息上限；默认 14 */
  maxMessages?: number
  /** 显式指定根文件（仓库相对路径）；省略则取调用图度数最高者 */
  rootFile?: string
}

/** 文件路径 → 显示名（basename，去掉扩展名）。 */
function baseName(file: string): string {
  const last = file.split('/').pop() ?? file
  return last.replace(/\.[A-Za-z0-9]+$/, '')
}

/**
 * 代码图谱 → `sequence` IR（跨文件调用链）。
 *
 * @throws Error 图谱里**没有任何跨文件调用边**时抛出——此时无法派生调用链，
 *   伪造一条「看起来像」的时序图会误导读者。调用方应提示先建图或换图类型。
 */
export function buildSequenceIr(graph: CodeGraph, options: SequenceIrOptions): SequenceIr {
  const { nodes, edges } = normalizeGraph(graph)
  const fileById = new Map<string, string>()
  const labelById = new Map<string, string>()
  for (const node of nodes) {
    if (typeof node.label === 'string' && node.label !== '') labelById.set(node.id, node.label)
    const file = fileOf(node)
    if (file !== null) fileById.set(node.id, file)
  }

  // 跨文件调用边：文件 → 文件
  const calls: Array<{ from: string; to: string; label: string }> = []
  const degree = new Map<string, number>()
  for (const edge of edges) {
    if (!CALL_RELATIONS.has(edge.relation ?? '')) continue
    const from = fileById.get(edge.source!)
    const to = fileById.get(edge.target!)
    if (from === undefined || to === undefined || from === to) continue
    // 消息文案取被调用方的符号名（图谱节点的 label），缺失时退化为关系名
    const callee = labelById.get(edge.target!) ?? edge.relation!
    calls.push({ from, to, label: callee })
    degree.set(from, (degree.get(from) ?? 0) + 1)
    degree.set(to, (degree.get(to) ?? 0) + 1)
  }

  if (calls.length === 0) {
    throw new Error(
      '图谱没有跨文件 calls 边，无法派生时序图：请先建图（prism graph build），或改用 architecture/dataflow',
    )
  }

  const maxParticipants = options.maxParticipants ?? 7
  const maxMessages = options.maxMessages ?? 14

  // 根：度数最高（并列取字典序），或调用方显式指定
  const root =
    options.rootFile ??
    stableTop([...degree.keys()], (file) => degree.get(file) ?? 0, (file) => file)[0]!
  if (!degree.has(root)) {
    throw new Error(`指定的根文件没有跨文件调用边: ${root}`)
  }

  // BFS 收集参与者（出边优先，再补入边，保证「被调用的下游」也进图）
  const outNeighbors = new Map<string, string[]>()
  const inNeighbors = new Map<string, string[]>()
  for (const call of calls) {
    outNeighbors.set(call.from, [...(outNeighbors.get(call.from) ?? []), call.to])
    inNeighbors.set(call.to, [...(inNeighbors.get(call.to) ?? []), call.from])
  }
  const participants: string[] = []
  const seen = new Set<string>()
  const queue: string[] = [root]
  while (queue.length > 0 && participants.length < maxParticipants) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    participants.push(file)
    for (const next of [...(outNeighbors.get(file) ?? [])].sort()) {
      if (!seen.has(next)) queue.push(next)
    }
    for (const prev of [...(inNeighbors.get(file) ?? [])].sort()) {
      if (!seen.has(prev)) queue.push(prev)
    }
  }
  if (participants.length < 2) {
    // schema 要求 participants >= 2
    throw new Error('调用链只涉及一个文件，无法生成时序图（schema 要求至少 2 个参与者）')
  }

  const participantSet = new Set(participants)
  const used = new Set<string>()
  const idOf = new Map<string, string>()
  const regionOfFile = makeRegionOf([...fileById.values()])
  const participantIr: SequenceIrParticipant[] = participants.map((file) => {
    const id = allocateId(baseName(file), used, 'p')
    idOf.set(file, id)
    const region = regionOfFile(file)
    return {
      id,
      type: inferComponentType(region),
      label: fitMiddle(baseName(file), SEQ_TEXT.label),
      sublabel: fitUnits(region, SEQ_TEXT.sublabel),
    }
  })

  const inSet = calls.filter((call) => participantSet.has(call.from) && participantSet.has(call.to))
  const messages: SequenceIrMessage[] = inSet.slice(0, maxMessages).map((call, index) => ({
    id: `m${index + 1}`,
    from: idOf.get(call.from)!,
    to: idOf.get(call.to)!,
    // 与 archify 示例同口径：首条 185，步长 43
    y: 185 + index * 43,
    label: fitUnits(call.label, SEQ_TEXT.message),
    variant: index === 0 ? 'emphasis' : 'default',
  }))
  for (const message of messages) assertArchifyId(message.id)

  // viewBox 自算：渲染器的两条硬边界——
  // - 宽度：`leftX + colGap*(n-1) + participantW/2 <= viewBox[0] - 40`（默认 920 只够 7 个参与者）
  // - 高度：消息 y 必须落在 `[160, viewBox[1] - 83]`（`lifelineBottom = viewBox[1] - 65`）
  // 参与者多 / 消息多时不抬高就会被判 `sits outside the readable timeline`。
  const seqViewBox: [number, number] = [
    Math.max(920, Math.ceil(62 + 108 * (participantIr.length - 1) + 43 + 40)),
    Math.max(760, messages.length === 0 ? 0 : Math.ceil(185 + (messages.length - 1) * 43 + 90)),
  ]

  return {
    schema_version: 1,
    diagram_type: 'sequence',
    meta: {
      title: options.title,
      subtitle:
        `代码图谱派生（Graphify ${nodes.length} 节点）｜ 根 = 调用图度数最高的文件；` +
        `参与者 = 文件，消息 = 跨文件 calls 边（BFS 顺序，最多 ${maxMessages} 条）`,
      viewBox: seqViewBox,
    },
    participants: participantIr,
    messages,
  }
}

// ===== dataflow（依赖流向口径）=====

/** 五层（顺序即 stage 序号）。 */
export const DATAFLOW_STAGES = ['入口', '接口', '领域', '基础设施', '存储'] as const

/**
 * dataflow 的布局几何 —— **必须与 `renderers/dataflow/render-dataflow.mjs` 的 `layout` 同口径**。
 *
 * 原因：dataflow 的节点坐标由**渲染器**按 `stage`/`row` 算（IR 里不给坐标），
 * 所以想做避让布线，就得先在生成器里复刻这套公式。改了上游常量这里要一起改
 * （`archify` 版本写进产物 sidecar，可溯源）。
 */
const DF_GEOM = {
  leftX: 100,
  colGap: 215,
  stageW: 168,
  /** stage 相框上边距（节点不得高于 `stageY + stageH + 22`） */
  nodeW: 112,
  nodeH: 58,
  rowYs: [128, 242, 356, 470, 584],
  stageBottomPad: 74,
} as const

/**
 * 同层节点超过 `rowYs` 槽位时，第二排整体下移的距离。
 *
 * **必须 ≥ 一整页的高度**：`rowYs` 跨度 `128..642`（`rowYs[4] + nodeH`），
 * 第二排起点要与第一排拉开至少一页再加 ≥10px 间距 → `642 - 128 + 10 = 524`。
 * 取 560 留出余量。**别想「挪一点点」**——实测用 160 时第二排直接压在第一排上，
 * 渲染器报 `Nodes "x" and "y" are less than 10px apart`。
 */
const DF_ROW_OVERFLOW = 560

/**
 * 目录 token → 层次（顺序即优先级）。
 *
 * ⚠️ 这是**结构性近似**，不是真实数据流（图谱没有读写边，见文件头口径说明）。
 *
 * 正则**锚定 token 前缀**（不带 `$`，容忍复数 / 派生形态如 `routes` / `services`）。
 * 旧实现把整条 region 压成一个 token 再锚定开头，于是 `backend/app` 这种多段
 * region 永远匹配不上任何规则、全部落进默认的「领域」层——实测 5 个真实仓库
 * 无一例外，dataflow 成了空图。
 */
const STAGE_RULES: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(persist|db|database|store|storage|sqlite|sql|schema|migration|repo|table|dao|orm)/i, 4],
  [/^(route|router|api|http|controller|handler|endpoint|rest|grpc|server|serializer|resource|viewset)/i, 1],
  [/^(util|lib|common|shared|infra|config|setting|logging|log|error|type|helper|client|adapter|guard|crypto|auth|security|audit|middleware)/i, 3],
  [/^(cli|bin|cmd|main|index|entry|bootstrap|hook|command|app|page|component|template|ui)/i, 0],
]

export function dataflowStageOf(region: string): number {
  const tokens = region
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token !== '')
  for (const [re, stage] of STAGE_RULES) {
    if (tokens.some((token) => re.test(token))) return stage
  }
  return 2 // 领域
}

/**
 * 测试文件判定（按路径段）。
 *
 * 依赖流向图 / 架构图这类**结构视图**必须排除测试：真实仓库里测试代码动辄占
 * 三分之一（rsl-siege-manager 实测 1886 节点里 877 个在 `backend/tests`），
 * 混进来会把结构图变成测试清单。**排除行为写进 `meta.subtitle` 声明**，
 * 不做静默丢弃。
 */
const TEST_SEGMENTS = new Set(['test', 'tests', 'testing', '__tests__', 'spec', 'specs', 'e2e'])

export function isTestFile(sourceFile: string): boolean {
  const segments = sourceFile.split('/')
  return segments.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment.toLowerCase()))
}

export interface DataflowIrNode {
  id: string
  type: ArchifyComponentType
  label: string
  sublabel?: string
  tag?: string
  stage: number
  row: number
  /** 同一 `row` 上再竖向偏移（多个节点挤在同一 stage/row 时用），与渲染器同口径 */
  yOffset?: number
}

export interface DataflowIrFlow {
  from: string
  to: string
  label: string
  /** 标签锚点（`router.pickLabelAt` 算出；dataflow 还会两两查标签重叠，必须自己放） */
  labelAt?: [number, number]
  fromSide?: RouterSide
  toSide?: RouterSide
  route?: 'straight'
  via?: Array<[number, number]>
}

export interface DataflowIr {
  schema_version: 1
  diagram_type: 'dataflow'
  meta: ArchifyMeta & { viewBox?: [number, number] }
  stages: Array<{ label: string }>
  nodes: DataflowIrNode[]
  flows: DataflowIrFlow[]
}

export interface DataflowIrOptions {
  title: string
  maxComponents?: number
  maxFlows?: number
}

/**
 * 代码图谱 → `dataflow` IR（**依赖流向口径**）。
 *
 * ⚠️ Graphify 图谱不含数据读写边，故这里画的是「模块依赖如何跨层流动」，
 * 口径写进 `meta.subtitle` 与文档，避免被当成真实数据流。
 *
 * @throws Error 图谱无节点时抛出。
 */
export function buildDataflowIr(graph: CodeGraph, options: DataflowIrOptions): DataflowIr {
  const { nodes, edges } = normalizeGraph(graph)
  if (nodes.length === 0) {
    throw new Error('图谱没有节点：请先建图（prism graph build），或检查 graphify-out/graph.json')
  }

  const maxComponents = options.maxComponents ?? 12
  const maxFlows = options.maxFlows ?? 44

  // 结构视图排除测试代码（口径见 `isTestFile`）。排除量写进 subtitle 声明。
  const sourceNodes = nodes.filter((node) => {
    const file = fileOf(node)
    return file === null || !isTestFile(file)
  })
  const excluded = nodes.length - sourceNodes.length
  if (sourceNodes.length === 0) {
    throw new Error('图谱里除测试文件外没有节点，无法派生依赖流向图')
  }

  const grouped = groupByCommunity(sourceNodes)
  const head = grouped.slice(0, maxComponents)
  const tail = grouped.slice(maxComponents)
  if (tail.length > 0) {
    head.push({
      key: 'others',
      nodes: tail.flatMap((group) => group.nodes),
      files: tail.reduce((sum, group) => sum + group.files, 0),
      region: 'other',
      label: `其他 ${tail.length} 个模块`,
    })
  }

  const used = new Set<string>()
  const withIds = head.map((group) => ({ group, id: groupId(group, used) }))
  const componentOfNode = new Map<string, string>()
  for (const { group, id } of withIds) {
    for (const node of group.nodes) componentOfNode.set(node.id, id)
  }

  // stage = 主目录段映射的层次；row = 层内序号（按规模降序，沿用 head 的顺序）
  //
  // 层次**压缩**：目录角色只用到其中几层时（真实仓库常见只命中 2–3 层），
  // 保留 5 列会让图大半是空列。这里只留有节点的层，但**保持原层次顺序**，
  // 所以「入口在左、存储在右」的相对关系不变，只是去掉了空层。
  const rawStageOf = new Map<string, number>()
  for (const { group, id } of withIds) rawStageOf.set(id, dataflowStageOf(group.region))
  const keptStages = [...new Set(DATAFLOW_STAGES.map((_, index) => index))].filter((index) =>
    [...rawStageOf.values()].includes(index),
  )

  if (keptStages.length < 2) {
    throw new Error(
      `图谱按目录角色只分出 ${keptStages.length} 层（${keptStages.map((i) => DATAFLOW_STAGES[i]).join('、') || '无'}），` +
        '没有跨层依赖可画——这通常是「所有源文件同在一个目录」的扁平仓库（或图谱被拍平）。' +
        '请改用 architecture（社区聚类）或 sequence（调用链）。',
    )
  }

  const rowByStage = new Map<number, number>()
  const withRows = withIds.map(({ group, id }) => {
    const stage = keptStages.indexOf(rawStageOf.get(id)!)
    const index = rowByStage.get(stage) ?? 0
    rowByStage.set(stage, index + 1)
    // rowYs 只有 5 个槽位；同层超出 5 个时靠 yOffset 叠第二排（并把 viewBox 一起抬高）
    const row = index % DF_GEOM.rowYs.length
    const yOffset = Math.floor(index / DF_GEOM.rowYs.length) * DF_ROW_OVERFLOW
    return { group, id, stage, row, yOffset }
  })

  const flowNodes: DataflowIrNode[] = withRows.map(({ group, id, stage, row, yOffset }) => ({
    id,
    type: inferComponentType(group.label),
    label: fitUnits(group.label, FLOW_TEXT.label),
    sublabel: fitUnits(`${group.files} 文件 · ${group.nodes.length} 节点`, FLOW_TEXT.sublabel),
    ...(tail.length > 0 && group.key === 'others' ? { tag: fitUnits('合并', FLOW_TEXT.tag) } : {}),
    stage,
    row,
    ...(yOffset !== 0 ? { yOffset } : {}),
  }))

  // 几何：与 `renderers/dataflow/render-dataflow.mjs` 的 layout 常量同口径
  // （dataflow 的节点坐标由渲染器按 stage/row 算，所以这里必须复刻它的公式才能布线）
  const boxes = new Map<string, RouterBox>()
  for (const node of flowNodes) {
    const cx = DF_GEOM.leftX + node.stage * DF_GEOM.colGap
    const y = DF_GEOM.rowYs[node.row]! + (node.yOffset ?? 0)
    boxes.set(node.id, {
      x0: cx - DF_GEOM.nodeW / 2,
      x1: cx + DF_GEOM.nodeW / 2,
      y0: y,
      y1: y + DF_GEOM.nodeH,
    })
  }
  const obstacles = [...boxes.values()]
  const maxBottom = obstacles.reduce((max, box) => Math.max(max, box.y1), 0)
  const lastStageX = DF_GEOM.leftX + (keptStages.length - 1) * DF_GEOM.colGap
  const viewBox: [number, number] = [
    Math.max(940, Math.ceil(lastStageX + DF_GEOM.stageW / 2 + 24)),
    // 底部硬边界是 `node.y + height <= viewBox[1] - stageBottomPad`，多留 8px 余量
    Math.max(720, Math.ceil(maxBottom + DF_GEOM.stageBottomPad + 8)),
  ]

  // 只保留**跨层**流动：同层内部的依赖画出来是噪声，也不是这张图要回答的问题
  const stageOf = new Map<string, number>()
  for (const node of flowNodes) stageOf.set(node.id, node.stage)
  const aggregated = aggregateConnections(edges, componentOfNode, DEPENDENCY_RELATIONS, Number.MAX_SAFE_INTEGER)
  const crossStage = aggregated
    .filter((entry) => stageOf.get(entry.from) !== stageOf.get(entry.to))
    .slice(0, maxFlows)

  if (crossStage.length === 0) {
    throw new Error(
      `分层成立（${keptStages.length} 层）但模块之间没有任何**跨层**依赖，画出来会是一张没有连线的空图——` +
        '这通常是「若干互不依赖的独立项目被打进同一份图谱」（如 karpathy-repos 里的 minGPT / micrograd / nanoGPT）。' +
        '请改用 architecture（社区聚类）或对单个项目单独建图。',
    )
  }

  const routed = planRoutes(
    crossStage,
    (entry) => {
      const from = boxes.get(entry.from)
      const to = boxes.get(entry.to)
      return from !== undefined && to !== undefined ? { from, to } : null
    },
    obstacles,
    freeTracks(obstacles, 40),
  )

  // 标签落位：dataflow 的标签是必填，且渲染器会**两两查标签重叠**，所以必须逐条贪心占位
  const placedLabels: LabelRect[] = []
  const flows: DataflowIrFlow[] = routed.map(({ edge, plan }) => {
    const from = boxes.get(edge.from)!
    const to = boxes.get(edge.to)!
    const label = fitUnits(edge.count > 1 ? `${edge.relation} ×${edge.count}` : edge.relation, FLOW_TEXT.flow)
    const pick = pickLabelAt(
      fullPath(from, to, plan.fromSide, plan.toSide, plan.via),
      obstacles,
      { width: flowLabelWidth(label), height: 16 },
      placedLabels,
      // dataflow 的 label 是 schema 必填，放不下也只能放到最优位置
      { lift: 11, allowImperfect: true },
    )
    const base: DataflowIrFlow = {
      from: edge.from,
      to: edge.to,
      label,
      fromSide: plan.fromSide,
      toSide: plan.toSide,
      route: plan.route,
      via: plan.via,
    }
    if (pick === null) return base
    placedLabels.push(pick.box)
    return { ...base, labelAt: [Math.round(pick.at[0]), Math.round(pick.at[1])] }
  })

  return {
    schema_version: 1,
    diagram_type: 'dataflow',
    meta: {
      title: options.title,
      subtitle:
        `⚠️ 依赖流向视图（非真实数据流）：Graphify 图谱无数据读写边（relation 全集实测为 ` +
        `contains/imports/method/calls/uses/inherits/re_exports/rationale_for），` +
        `本图按目录角色分层（${keptStages.map((i) => DATAFLOW_STAGES[i]).join(' → ')}` +
        `${keptStages.length < DATAFLOW_STAGES.length ? `，共 ${DATAFLOW_STAGES.length} 层中命中 ${keptStages.length} 层，空层已去掉` : ''}）` +
        ` + 依赖边跨层流动派生（${crossStage.length - routed.length} 条因无法避让节点被略去）` +
        `｜ 已排除 ${excluded} 个测试文件节点`,
      viewBox,
    },
    stages: keptStages.map((index) => ({ label: DATAFLOW_STAGES[index]! })),
    nodes: flowNodes,
    flows,
  }
}
