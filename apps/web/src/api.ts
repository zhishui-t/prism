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

/**
 * 条目版本历史（F-B4，design-v4 §3.1 EntryVersion 契约）。
 * `status` 用 string 而非联合类型：未知值要**原文显示**（不隐藏），见 ui-spec §4.2。
 */
export interface EntryVersion {
  id: string
  version: number
  status: string
  title: string
  is_latest: boolean
  updated_at: string
  source_path: string | null
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

/**
 * 图谱状态（/api/graph/status）。
 *
 * `graph_exists` 是**判定「有没有图谱」的依据**——`stale` 只表示「建过图但现在可能过期」
 * （产物缺失时服务端也返回 stale:true）。历史 bug：前端只声明了 `{stale, detail}`，
 * 于是未建图的项目被显示成「图谱可能已陈旧」，且 Studio 面板直接把 404 信封渲染出来。
 */
export interface GraphStatus {
  project: string
  root: string
  graph_exists: boolean
  built_at: string | null
  changed_files: number
  total_files: number
  stale: boolean
}


/** 扫描历史记录（/api/kb/scan-history）。 */export interface ScanRecord {
  project: string
  root: string
  scanned_at: string
  discovered: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  missing: string[]
  unreadable: string[]
  truncated: boolean
  /** 被 `.gitignore` 忽略的目录（旧记录缺省） */
  ignored_dirs?: string[]
  /** 被 `.gitignore` 忽略的文件数（旧记录缺省） */
  ignored_files?: number
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

/**
 * 书的定稿目录 / 继承链（`GET /api/kb/book-structure`，§4.1 K4）。
 * 服务端形状见 knowledge 的 `BookStructure`（下划线字段，不再驼峰改写）。
 */
export interface BookStructure {
  layer: string
  book: string
  /** 每次 freeze 递增 */
  revision: number
  /** 冻结清单（有序；本地项覆盖继承项） */
  modules: string[]
  /** 推导建议 */
  suggested: Array<{ slug: string; entries: number }>
  /** 声明的继承（形如 `["global/java-standards"]`） */
  inherits: string[]
  /** 实际生效的继承链 */
  inherited_from: string[]
  frozen_at: string | null
  confirmed_by: string | null
  updated_at: string
}

export interface HealthInfo {
  version: string
  home: string
  uptime: number
}

/**
 * 统一请求：解析信封，失败抛错（页面据此显示错误态）。
 *
 * ⚠ **契约（debts D-1，不得更改）**：错误**必须**以 `` `${code}: ${message}` `` 抛成 `Error.message`
 * ——错误码靠这个前缀承载。消费方按前缀分派：
 * - `components/EffectiveSkills.tsx`：`err.startsWith('not_found')` → 换成「角色不存在」的人话；
 * - 各页 `State` / `.error` 直接展示原文（`code: message`）。
 * 因此**不要**把它改成结构化 error、也不要在前缀里加别的东西；要翻译码，请在消费方做映射。
 * （`api-team.ts` 的同名函数是同一契约的第二处实现，改一处必须同步另一处。）
 */
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

  /**
   * 条目版本历史（F-B4 → GET /api/kb/versions/:id）。
   * 服务端形状在 design-v4 §3.4 记为 `{versions}`、ui-spec §4.4 记为裸数组 → 两种都接受。
   */
  kbVersions: async (id: string): Promise<EntryVersion[]> => {
    const value = await request<EntryVersion[] | { versions: EntryVersion[] }>(
      `/api/kb/versions/${encodeURIComponent(id)}`,
    )
    if (Array.isArray(value)) return value
    return value?.versions ?? []
  },

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

  kbScanHistory: (project?: string, limit = 20) => {
    const qs = new URLSearchParams()
    if (project !== undefined) qs.set('project', project)
    qs.set('limit', String(limit))
    return request<ScanRecord[]>(`/api/kb/scan-history?${qs.toString()}`)
  },

  kbConflicts: (includeResolved = false) =>
    request<KbConflict[]>(`/api/kb/conflicts${includeResolved ? '?include_resolved=true' : ''}`),

  kbRemove: (id: string, hard = false) =>
    request<{ id: string; mode: string; references: number }>(
      `/api/kb/entry/${encodeURIComponent(id)}/remove${hard ? '?hard=true' : ''}`,
      { method: 'POST' },
    ),

  /**
   * 恢复软删条目（`POST /api/kb/entry/:id/restore`）。
   *
   * 「删除不可逆」是阅读室硬伤 → 必加（§6.3）。`restored=false` 表示本就 active（幂等）。
   * ⚠ 与 `kbRemove` 相反：服务端**不**做审核语义，只按宿主指令改状态（R3）。
   */
  kbRestore: (entryId: string) =>
    request<{ id: string; restored: boolean }>(
      `/api/kb/entry/${encodeURIComponent(entryId)}/restore`,
      { method: 'POST' },
    ),

  /**
   * 书的定稿目录 / 继承链（`GET /api/kb/book-structure`，只读）。
   *
   * 「跨层同名书」与「层间继承」的唯一数据源（§4.1 K4 → §6.5「同名书可辨」锚点）。
   * 结构未生成（或书不存在）→ 服务端抛 `not_found`（不是空结构，两者必须可区分）。
   * **不接** `POST` 形态的 generate/freeze（写操作，本轮无 UI 位置）。
   */
  kbBookStructure: (params: { layer: string; book: string }) => {
    const qs = new URLSearchParams({ layer: params.layer, book: params.book })
    return request<BookStructure>(`/api/kb/book-structure?${qs.toString()}`)
  },

  graphProjects: () => request<GraphProject[]>('/api/graph/projects'),

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
    request<GraphStatus>(`/api/graph/status?project=${encodeURIComponent(project)}`),
}
