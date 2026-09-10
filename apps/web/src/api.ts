/** Prism server 响应信封（design.md §4）。 */
export type Envelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

export interface SearchResult {
  id: string
  version: number
  title: string
  type: string
  layer: string
  owner?: string
  book: string
  module: string
  excerpt: string
  score: number
  source: string
}

export interface KnowledgeEntry {
  id: string
  version: number
  title: string
  type: string
  layer: string
  owner?: string
  book: string
  module: string
  status: string
  risk: string
  confidence: number
  tags: string[]
  content: string
  path: string
  superseded_by?: string
  created_at: string
  updated_at: string
}

/** 目录条目（星图/下钻用）。 */
export interface CatalogEntry {
  id: string
  version: number
  title: string
  type: string
  layer: string
  owner?: string
  book: string
  module: string
  status: string
  risk: string
  tags: string[]
  in_degree: number
  out_degree: number
  updated_at: string
}

export interface BookNode {
  layer: string
  owner?: string
  book: string
  modules: Array<{ name: string; count: number }>
  total: number
}

export interface KbStats {
  layers: Record<string, number>
  books: number
  entries: number
  by_type: Record<string, number>
}

export interface GraphProject {
  project: string
  root: string
  built_at?: string
  stale?: boolean
  registered_at?: string
  last_scan_at?: string
  scanned_sources?: number
}

/** 层间冲突（/api/kb/conflicts）。 */
export interface KbConflict {
  id: string
  high_id: string
  low_id: string
  kind: string
  resolved: boolean
  detected_at: string
}

/** 知识图谱节点（/api/kb/graph）。 */
export interface KbGraphNode {
  id: string
  title: string
  type: string
  layer: string
  owner?: string
  book: string
  module: string
  in_degree: number
  out_degree: number
}

/** 知识图谱边。 */
export interface KbGraphEdge {
  from_id: string
  to_id: string
  relation: string
  confidence: string
  weight: number
  source: string
  created_at: string
}

/** 知识图谱视图（单一边表的过滤视图）。 */
export interface KbGraphView {
  nodes: KbGraphNode[]
  edges: KbGraphEdge[]
  root?: string
  truncated: boolean
}

/** 两节点最短路径。 */
export interface KbGraphPath {
  nodes: string[]
  edges: KbGraphEdge[]
}

/** 架构图类型（五类）。 */
export interface ArchType {
  type: string
  label: string
}

/** 已渲染的架构图产物（带作用域，供按书/模块过滤）。 */
export interface ArchDiagram {
  type: string
  name: string
  bytes: number
  mtime: string
  /** 图标题（IR meta.title） */
  title?: string
  layer?: string
  owner?: string
  book?: string
  module?: string
  archify_version?: string
  /** 同目录是否有 IR 源 */
  has_ir: boolean
}

/** 产物元数据（sidecar <name>.meta.json）。 */
export interface ArchArtifactMeta {
  type: string
  name: string
  archify_version: string
  ir_hash: string
  ir_file: string
  title?: string
  layer?: string
  owner?: string
  book?: string
  module?: string
  created_at: string
}

/** 产物 IR + 元数据。 */
export interface ArchIrResult {
  type: string
  name: string
  ir: unknown
  meta: ArchArtifactMeta | null
}

/** 渲染结果。 */
export interface ArchRenderResult {
  type: string
  name: string
  bytes: number
  preview: string
  ir: string
}

/** 校验结果。 */
export interface ArchValidation {
  ok: boolean
  type: string
  problems: Array<{ code: string; severity: string; message: string; fix?: string }>
}

/** 工作请求（拉取式队列）。 */
export interface WorkRequest {
  id: string
  kind: string
  payload: unknown
  status: string
  priority: number
  attempt_token: string | null
  claimed_by: string | null
  claimed_at: string | null
  claimed_deadline: string | null
  fail_count: number
  result: unknown
  error: string | null
  created_at: string
  updated_at: string
}

/** 队列水位。 */
export interface WorkStats {
  pending: number
  claimed: number
  completed: number
  failed: number
  oldest_pending_age_ms: number | null
}

export interface TaskRow {
  id: string
  dag_id: string
  description: string
  status: string
  dependencies: string[]
  write_scopes: string[]
  revision: number
  assigned_agent?: string | null
  executor?: string | null
  stage?: string
  result?: unknown
  error_type?: string | null
  created_at: string
  updated_at: string
}

/** 任务台账统计。 */
export interface TaskStats {
  total: number
  by_status: Record<string, number>
  dags: number
}

/** DAG 依赖图（任务 + 边）。 */
export interface TaskDag {
  dag_id: string
  status: string
  tasks: TaskRow[]
  edges: Array<{ from: string; to: string }>
}

export interface HealthInfo {
  version: string
  home: string
  uptime: number
}

/** 统一请求：解析信封，失败抛错（页面据此显示错误态）。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = (await res.json()) as Envelope<T>
  if (!body.ok) {
    throw new Error(`${body.error.code}: ${body.error.message}`)
  }
  return body.value
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  kbSearch: (params: {
    q: string
    layers?: string
    book?: string
    module?: string
    limit?: number
    all_versions?: boolean
  }) => {
    const qs = new URLSearchParams()
    qs.set('q', params.q)
    if (params.layers) qs.set('layers', params.layers)
    if (params.book) qs.set('book', params.book)
    if (params.module) qs.set('module', params.module)
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.all_versions) qs.set('all_versions', 'true')
    return request<SearchResult[]>(`/api/kb/search?${qs.toString()}`)
  },

  kbGet: (id: string, version?: number) =>
    request<KnowledgeEntry>(
      `/api/kb/get/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`,
    ),

  kbTree: (layer?: string) =>
    request<BookNode[]>(`/api/kb/tree${layer ? `?layer=${encodeURIComponent(layer)}` : ''}`),

  kbStats: () => request<KbStats>('/api/kb/stats'),

  /** 全量目录（星图/下钻）。 */
  kbCatalog: (params?: { layer?: string; owner?: string; book?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.layer) qs.set('layer', params.layer)
    if (params?.owner) qs.set('owner', params.owner)
    if (params?.book) qs.set('book', params.book)
    if (params?.limit) qs.set('limit', String(params.limit))
    const suffix = qs.toString()
    return request<CatalogEntry[]>(`/api/kb/catalog${suffix ? `?${suffix}` : ''}`)
  },

  kbGraph: (params?: {
    id?: string
    depth?: number
    relations?: string
    limit?: number
    book?: string
    owner?: string
    module?: string
    layer?: string
  }) => {
    const qs = new URLSearchParams()
    if (params?.id) qs.set('id', params.id)
    if (params?.depth) qs.set('depth', String(params.depth))
    if (params?.relations) qs.set('relations', params.relations)
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.book) qs.set('book', params.book)
    if (params?.owner) qs.set('owner', params.owner)
    if (params?.module) qs.set('module', params.module)
    if (params?.layer) qs.set('layer', params.layer)
    const suffix = qs.toString()
    return request<KbGraphView>(`/api/kb/graph${suffix ? `?${suffix}` : ''}`)
  },

  /** 知识图谱导出（借 Graphify 渲染/Obsidian） */
  kbConflicts: (includeResolved = false) =>
    request<KbConflict[]>(`/api/kb/conflicts${includeResolved ? '?include_resolved=true' : ''}`),

  kbResolveConflict: (id: string) =>
    request<{ id: string; resolved: boolean }>(
      `/api/kb/conflicts/${encodeURIComponent(id)}/resolve`,
      { method: 'POST' },
    ),

  kbRemove: (id: string, hard = false) =>
    request<{ id: string; mode: string; references: number }>(
      `/api/kb/entry/${encodeURIComponent(id)}/remove${hard ? '?hard=true' : ''}`,
      { method: 'POST' },
    ),

  kbExport: (format: string) =>
    request<{ format: string; output: string; files: string[]; summary: { nodes: number; edges: number } }>(
      '/api/kb/export',
      { method: 'POST', body: JSON.stringify({ format }) },
    ),

  kbPath: (from: string, to: string, relations?: string) => {
    const qs = new URLSearchParams({ from, to })
    if (relations) qs.set('relations', relations)
    return request<KbGraphPath>(`/api/kb/path?${qs.toString()}`)
  },

  graphProjects: () => request<GraphProject[]>('/api/graph/projects'),

  graphBuild: (project: string) =>
    request<{ job_id: string }>('/api/graph/build', {
      method: 'POST',
      body: JSON.stringify({ project }),
    }),

  graphBuildStatus: (jobId: string) =>
    request<{ status: string; log?: string; error?: string }>(`/api/graph/build/${jobId}`),

  graphQuery: (project: string, q: string) =>
    request<{ nodes?: unknown[]; edges?: unknown[]; text?: string }>(
      `/api/graph/query?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`,
    ),

  /** 图谱导出（obsidian/wiki/svg/graphml…） */
  graphExport: (project: string, format: string) =>
    request<{ format: string; output: string; files: string[] }>('/api/graph/export', {
      method: 'POST',
      body: JSON.stringify({ project, format }),
    }),

  graphStatus: (project: string) =>
    request<{ stale: boolean; detail?: string }>(
      `/api/graph/status?project=${encodeURIComponent(project)}`,
    ),

  tasks: (params?: { dag_id?: string; status?: string; session_id?: string }) => {
    const qs = new URLSearchParams()
    if (params?.dag_id) qs.set('dag_id', params.dag_id)
    if (params?.status) qs.set('status', params.status)
    if (params?.session_id) qs.set('session_id', params.session_id)
    const suffix = qs.toString()
    return request<TaskRow[]>(`/api/tasks${suffix ? `?${suffix}` : ''}`)
  },

  taskStats: () => request<TaskStats>('/api/tasks/stats'),

  taskDag: (dagId: string) => request<TaskDag>(`/api/dags/${encodeURIComponent(dagId)}`),

  workPending: (params?: { kind?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.kind) qs.set('kind', params.kind)
    if (params?.limit) qs.set('limit', String(params.limit))
    const suffix = qs.toString()
    return request<WorkRequest[]>(`/api/work/pending${suffix ? `?${suffix}` : ''}`)
  },

  workStats: () => request<WorkStats>('/api/work/stats'),

  archTypes: () => request<ArchType[]>('/api/arch/types'),

  archDiagrams: (params?: { book?: string; module?: string }) => {
    const qs = new URLSearchParams()
    if (params?.book !== undefined) qs.set('book', params.book)
    if (params?.module !== undefined) qs.set('module', params.module)
    const suffix = qs.toString()
    return request<ArchDiagram[]>(`/api/arch/diagrams${suffix ? `?${suffix}` : ''}`)
  },

  archIr: (type: string, name: string) =>
    request<ArchIrResult>(`/api/arch/ir/${encodeURIComponent(type)}/${encodeURIComponent(name)}`),

  archValidate: (type: string, ir: unknown) =>
    request<ArchValidation>('/api/arch/validate', {
      method: 'POST',
      body: JSON.stringify({ type, ir }),
    }),

  archRender: (type: string, ir: unknown, name?: string) =>
    request<ArchRenderResult>('/api/arch/render', {
      method: 'POST',
      body: JSON.stringify({ type, ir, ...(name ? { name } : {}) }),
    }),
}
