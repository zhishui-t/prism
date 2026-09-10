/**
 * @prism/knowledge — 接口契约（design.md §3.2，先冻结后实现）。
 *
 * 本文件是对外 API 的唯一真相：server 包（dev-2）只依赖这里声明的类型与
 * KnowledgeService 接口，不感知文件布局与 SQL 细节。
 * 任何修改必须经队长仲裁（跨流契约）。
 */
import type { AuditLog, PrismPersistence } from '@prism/core'

/** 知识分层：global（全局）/ project（项目）/ role（角色）。 */
export type Layer = 'global' | 'project' | 'role'

/** 条目类型。 */
export type EntryType =
  | 'rule'
  | 'doc'
  | 'guide'
  | 'pitfall'
  | 'pattern'
  | 'diagram'
  | 'summary'
  | 'other'

/** 知识来源类型（design-knowledge-model-v1 §2）。 */
export type EntryOrigin = 'owned' | 'indexed'

/** 落库输入（design.md §3.2 DepositInput）。 */
export interface DepositInput {
  /** 不传则自动生成 */
  id?: string
  title: string
  type: EntryType
  layer: Layer
  /** project/role 层必填（project-id / role-id） */
  owner?: string
  book: string
  /** 省略 → 落 _inbox/（DB module=''） */
  module?: string
  content: string
  tags?: string[]
  /** 默认 low */
  risk?: 'low' | 'medium' | 'high'
  /** 默认 0.5 */
  confidence?: number
  /** 默认 [] */
  overrides?: string[]
  visibility?: 'global' | 'project' | 'role'
  source?: { kind: 'import' | 'agent' | 'manual'; ref?: string }
  deposited_by?: { subject: string; team?: string }
}

/**
 * 引用型条目的索引输入（design-knowledge-model-v1 §2/§4）。
 *
 * 与 `deposit` 的区别：**不写副本、不递增版次**——项目文件才是真相，
 * Prism 只记 `path` 指向原件 + `source_hash` 用于漂移检测。
 */
export interface IndexInput {
  id: string
  title: string
  type?: EntryType
  layer: Layer
  owner?: string
  book: string
  module?: string
  /** 项目原件的绝对路径 */
  path: string
  /** 原件内容哈希（sha256），用于判断源是否变化 */
  source_hash: string
  /** 从文档抽取的正文（用于 FTS 检索；原件为二进制时是转换结果） */
  content: string
  tags?: string[]
}

/**
 * 落库结果。
 *
 * `action` 语义（2026-09-10 加）：
 * - `created`：新条目 v1；
 * - `updated`：正文变化 → 版次 +1；
 * - `unchanged`：**正文哈希与最新版相同 → 不产生新版次**（版本只为「内容变化」服务，
 *   重复导入同一文件不再堆叠历史）。
 */
export interface DepositResult {
  id: string
  version: number
  path: string
  action: 'created' | 'updated' | 'unchanged'
}

/** 引用型索引结果。 */
export interface IndexResult {
  id: string
  /** 本次是新建、更新（源变了）、还是跳过（源未变） */
  action: 'created' | 'updated' | 'unchanged'
}

/** 删除结果（B1）。 */
export interface RemoveResult {
  id: string
  /** soft = 置 deprecated 保留审计；hard = 真删行（仅无引用时允许） */
  mode: 'soft' | 'hard'
  /** 被多少条边引用（软删时给出，便于提示影响面） */
  references: number
}

/** 恢复软删条目（deprecated → active）。 */
export interface RestoreResult {
  id: string
  /** 恢复前的状态；本就 active 时 restored=false（幂等） */
  restored: boolean
}

/**
 * 层间冲突（B2，§12.3）。
 *
 * Prism **不做审核**：冲突只记录、只提示，不阻断落库、不静默取胜。
 * 判据（零 LLM、保守）：同一 book/module 下存在**同名条目**跨层共存，
 * 且高层未显式声明 `overrides: [低层ID]` → 记录一条 conflict。
 */
export interface KnowledgeConflict {
  id: string
  /** 高优先级层条目（project/role） */
  high_id: string
  /** 低优先级层条目（global） */
  low_id: string
  /** 冲突类型：same_title（同名跨层） */
  kind: string
  resolved: boolean
  detected_at: string
}

/** 知识条目（design.md §3.2 KnowledgeEntry）。 */
export interface KnowledgeEntry {
  id: string
  version: number
  title: string
  type: EntryType
  layer: Layer
  owner?: string
  book: string
  /** 未归模块为 ''（文件层面在 _inbox/） */
  module: string
  status: 'active' | 'deprecated' | 'superseded'
  risk: string
  confidence: number
  tags: string[]
  content: string
  /** 指向该版次的版次文件 v<NN>.md（绝对路径） */
  path: string
  content_hash: string
  /** `owned`（Prism 落盘为真相）或 `indexed`（项目文件为真相） */
  origin?: EntryOrigin
  /** 引用型：源文件内容哈希（漂移检测）；自有型为空 */
  source_hash?: string
  /** 若本版已被取代，指向取代者（如 `ID@v3`） */
  superseded_by?: string
  created_at: string
  updated_at: string
}

/** 检索查询（design.md §3.2 SearchQuery）。 */
export interface SearchQuery {
  q: string
  layers?: Layer[]
  owner?: string
  book?: string
  module?: string
  /** 默认 10 */
  limit?: number
  /** 默认 false（只返回每个 id 的最新版） */
  all_versions?: boolean
  /**
   * 按 visibility 过滤（B3，§12.7）。**opt-in**：不传 = 不过滤（保持既有行为）；
   * 传入可见性集合时只返回 `visibility IN (...)` 的条目。用于按角色/项目收窄读取面。
   */
  visibilities?: Array<'global' | 'project' | 'role'>
  /**
   * 词元匹配模式（默认 `all` = AND，保持既有精确检索行为）。
   * `any` = OR，命中任一词元即可——**长任务描述**（如上下文包）必须用，
   * 否则要求全部词元会零命中。
   */
  match_mode?: 'all' | 'any'
  /**
   * 是否启用混合检索（BM25 + 向量 RRF）。**默认 true**——但仅在装配了
   * `options.embed` 且 query 向量可算时生效；未装配/算不出时静默回落纯 BM25，
   * 与既有行为逐字节一致。显式传 `false` 可强制纯关键词检索。
   */
  hybrid?: boolean
}

/** 检索结果（design.md §3.2 SearchResult）。score 越大越相关（-bm25）。 */
export interface SearchResult {
  id: string
  version: number
  title: string
  type: EntryType
  layer: Layer
  owner?: string
  book: string
  module: string
  excerpt: string
  score: number
  /** 来源地址：`层[/owner]/书/模块/ID@v版次` */
  source: string
}

/** 书节点（design.md §3.2 BookNode）。 */
export interface BookNode {
  layer: Layer
  owner?: string
  book: string
  modules: Array<{ name: string; count: number }>
  total: number
}

/** 知识库统计（design.md §3.2 KbStats）。 */
export interface KbStats {
  layers: Record<Layer, number>
  books: number
  entries: number
  by_type: Record<string, number>
}

/**
 * 关系边类型（单一边表 + 多视图，design §4 / D8）。
 * - `references`：正文双链 `[[id]]`（EXTRACTED，确定性抽取）
 * - `overrides`：显式层间覆盖声明（EXTRACTED）
 * - `supersedes`：版次取代（EXTRACTED）
 * - `related`：人工/宿主声明的一般关联（可 INFERRED）
 */
export type EdgeRelation = 'references' | 'overrides' | 'supersedes' | 'related'

/** 边的置信来源（沿用 Graphify 口径：EXTRACTED=确定性抽取 / INFERRED=推断）。 */
export type EdgeConfidence = 'EXTRACTED' | 'INFERRED'

/** 一条关系边（knowledge_edges 表行）。 */
export interface KnowledgeEdge {
  from_id: string
  to_id: string
  relation: EdgeRelation
  confidence: EdgeConfidence
  weight: number
  /** 来源说明（如 `[[双链]]` / `overrides` / `deposit`） */
  source: string
  created_at: string
}

/** 图谱节点（带上度/出度，供可视化与中心度判断）。 */
export interface GraphNode {
  id: string
  title: string
  type: EntryType
  layer: Layer
  owner?: string
  book: string
  module: string
  /** 入度（被引用次数） */
  in_degree: number
  /** 出度（引用他人次数） */
  out_degree: number
}

/** 图谱子图（节点 + 边；单一边表的过滤视图）。 */
export interface GraphView {
  nodes: GraphNode[]
  edges: KnowledgeEdge[]
  /** 视图中心（neighbors 查询时为源节点 id） */
  root?: string
  /** 是否因 limit 截断 */
  truncated: boolean
}

/** 邻域/路径查询参数。 */
export interface GraphQuery {
  /** 起始节点 id（省略则返回全图概览，受 limit 限制） */
  id?: string
  /** 邻域跳数，默认 1，上限 3 */
  depth?: number
  /** 只保留这些关系类型 */
  relations?: EdgeRelation[]
  /** 节点数上限，默认 50，上限 500 */
  limit?: number
  /** 限定书（书内图谱：书详情页用） */
  book?: string
  /** 限定层（配合 owner 使用） */
  layer?: Layer
  /** 限定 owner（project/role 层） */
  owner?: string
  /** 限定模块（模块内图谱：模块详情页用） */
  module?: string
}

/** 路径查询结果。 */
export interface GraphPath {
  /** 节点序列（含起终点） */
  nodes: string[]
  /** 边序列（nodes.length - 1 条） */
  edges: KnowledgeEdge[]
}
/**
 * 目录条目（星图/下钻用）：全量最新版条目的轻量元数据。
 * 与 SearchResult 的区别：**不需要检索词**，一次拿全量（分页），供可视化渲染。
 */
export interface CatalogEntry {
  id: string
  version: number
  title: string
  type: EntryType
  layer: Layer
  owner?: string
  book: string
  module: string
  status: KnowledgeEntry['status']
  risk: string
  tags: string[]
  /** `owned` 或 `indexed`（缺失视为 owned，兼容老数据） */
  origin?: EntryOrigin
  /** 引用型：项目原件路径 */
  path?: string
  /** 入度（被引用数） */
  in_degree: number
  /** 出度（引用他人数） */
  out_degree: number
  updated_at: string
}

/**
 * 知识库服务（design.md §3.2 KnowledgeService）。
 * 实现类为 PrismKnowledgeService（含 close() 生命周期方法，接口外的扩展）。
 */
export interface KnowledgeService {
  /** 落库：新条目 v1，同 id 沉淀为 version+1，旧版置 superseded。 */
  deposit(input: DepositInput): Promise<DepositResult>
  /**
   * 索引一条「引用型」知识（项目文件为真相）：不写副本、不递增版次。
   * 源哈希未变 → `unchanged`（跳过）；变了 → `updated`；不存在 → `created`。
   * 实现层可选（内存桩可不实现）。
   */
  index?(input: IndexInput): Promise<IndexResult>
  /** 全文检索（bigram + FTS5 unicode61），默认只返回最新版。 */
  search(query: SearchQuery): Promise<SearchResult[]>
  /** 取单条；version 省略取最新版；历史版可读。查无 → null。 */
  get(id: string, version?: number): Promise<KnowledgeEntry | null>
  /** 层→书→模块结构树（只统计最新版）。 */
  tree(layer?: Layer, owner?: string): Promise<BookNode[]>
  /**
   * 全量目录（最新版），带出入度；供星图/下钻渲染。
   * `limit` 省略取 2000 上限（防止超大库拖垮前端）。
   */
  catalog(options?: { layer?: Layer; owner?: string; book?: string; limit?: number }): Promise<CatalogEntry[]>
  /** 全库统计（只统计最新版）。 */
  stats(): Promise<KbStats>
  /** 图谱邻域/概览查询（边表过滤视图，D8）。 */
  graph(query?: GraphQuery): Promise<GraphView>
  /** 两节点间最短路径（BFS，无向；relations 可过滤边类型）；不可达 → null。 */
  path(fromId: string, toId: string, relations?: EdgeRelation[]): Promise<GraphPath | null>
  /** 以文件为真相重建索引（Z2；内存桩可不实现）。 */
  reindex?(): Promise<ReindexReport>
  /**
   * 软删：把条目最新版置 `deprecated`（B1）。被引用过的条目**禁止硬删**，
   * 只允许软删；`hard=true` 且无引用时才真删行与文件。
   */
  remove?(id: string, options?: { hard?: boolean }): Promise<RemoveResult>
  /**
   * 恢复软删条目：最新版 `deprecated → active`（幂等；本就 active 时 restored=false）。
   * 与 `remove` 对称——`remove` 的「可恢复」由本方法兑现（此前无入口，是个空承诺）。
   */
  restore?(id: string): Promise<RestoreResult>
  /** 层间冲突列表（B2）；未解决在前。 */
  conflicts?(options?: { includeResolved?: boolean }): Promise<KnowledgeConflict[]>
  /** 标记冲突已处理（B2）。 */
  resolveConflict?(conflictId: string): Promise<boolean>
}

/**
 * 重建索引报告（Z2）：手工编辑/迁移知识文件后，以**文件为真相**重建
 * knowledge_entries 与 kb_fts（不动任何正文文件）。
 */
export interface ReindexReport {
  /** 扫描到的版次文件数（v<NN>.md） */
  scanned: number
  /** 成功重建的版次行数 */
  indexed: number
  /** 跳过的文件数（解析失败/缺必填） */
  skipped: number
  /** 跳过明细 */
  errors: Array<{ path: string; reason: string }>
}

/** createKnowledgeService 选项（实现层扩展，非 §3.2 契约的一部分）。 */
export interface KnowledgeServiceOptions {
  /** Prism 主目录；不传取 PRISM_HOME 或 ~/.prism */
  home?: string
  /** 知识文件根目录；不传取 <home>/knowledge */
  knowledgeDir?: string
  /** 注入已打开的持久化（server 共享连接池时用）；不传则内部 openPersistence */
  persistence?: PrismPersistence
  /** 注入审计日志；不传则按 home 新建（与持久化共享同一写队列） */
  audit?: AuditLog
  /** 可注入时钟（测试用） */
  now?: () => Date
  /** 可注入 id 生成器（测试用） */
  idFactory?: () => string
  /**
   * 本地向量化（变更 2）：`(text) => Float32Array | null`——由 server 装配注入
   * （未安装时返回 null 降级）。knowledge 包只存向量、算余弦，不依赖 embedding 实现。
   * 注入后：deposit 自动写向量；search 走 BM25+向量混合。
   */
  embed?: (text: string) => Promise<Float32Array | null>
  /**
   * 当前 embedding 模型 id（分档用；与 `embed` 配套注入）。
   * 写入 kb_vectors.model；检索**只比同模型向量**——不同模型（即便同维）向量空间
   * 不共通，换档后旧向量自动失效，由 reindex 重算。
   */
  embeddingModel?: string
}
