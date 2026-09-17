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
  /**
   * 条目的真相文件路径（**索引型**= 项目原件绝对路径，**自有序**= 版次文件
   * `<knowledgeDir>/…/<book>/<module>/<id>/vNN.md`）。服务端一直返回它
   * （`packages/knowledge/src/service.ts` 的 `catalog()` → `path: row.path`），
   * 这里补上声明：**F2 的书内目录树按它建**（`knowledge-logic.ts#buildTree`）。
   */
  path: string
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

/**
 * 架构图产物（v9 F2，`GET /api/arch/diagrams` 的响应项，**逐字段冻结** design-v9 §2）。
 *
 * - `preview` / `ir` 是**服务端构造好的 URL**（带 project 限定）——前端**绝不拼路径**，
 *   iframe `src` 与「新标签打开」一律直接用 `preview`（design-v9 G-1）。
 * - `source` 区分「项目派生」（`<project>/.prism/arch/`）与「全局」（`<PRISM_HOME>/archify/`）；
 *   `project` 只在 `source === 'project'` 时存在。
 * - `book` / `module` 是 sidecar 里的**挂载作用域**（MCP 历史产物两者皆无 → 落「全局图集」）。
 * - `mtime` 是 ISO 字符串（`stat().mtime.toISOString()`），展示统一走 `fmtTime`。
 * - **可选字段缺失时后端不下发该键**（不是 `null`）：一律按
 *   `x === undefined` / `x ?? fallback` 读，**不得**写 `item.x === null` 这类判断。
 *
 * ✅ v9 批次 2 已与 `packages/server/src/http/routes/arch.ts` 的 `ArchArtifact` **逐字对账**
 * （字段名/类型/必选性/排序/过滤口径），并按冻结契约接真路由；对账留痕见
 * `.agent-team/v9-web-report.md` 的「契约接线状态」节。
 */
export interface ArchDiagram {
  type: string
  name: string
  bytes: number
  /** 产物文件的修改时间（ISO 字符串） */
  mtime: string
  /** 图标题（sidecar → IR `meta.title`；两者都缺**不下发**，渲染层回落 `name`） */
  title?: string
  layer?: string
  owner?: string
  book?: string
  module?: string
  archify_version?: string
  /** 同目录 `<name>.ir.json` 是否存在 */
  has_ir: boolean
  source: 'project' | 'global'
  /**
   * 项目名（仅 `source === 'project'`）。后端**恒成对下发**（实测：项目源项必有非空
   * `project`，全局源项必无该键）——故「是不是项目派生的」两套写法等价，树上的 project
   * 徽章按 `project` 判（`Knowledge.tsx` 的 `renderArch`）。
   */
  project?: string
  /** 服务端构造的预览 URL（iframe src / 新标签打开都用它） */
  preview: string
  /** 服务端构造的 IR 源 URL */
  ir: string
}

/** 调用链关系方向（v8 F4）：`out` = 查询节点为**发出方**（它调用谁）；`in` = **指向**查询节点（谁调用它）。 */
export type GraphRelationDir = 'in' | 'out'

/**
 * 一条调用关系（v8 F4，`GET /api/graph/relations` 的 `items[]`）。
 *
 * ⚠ `other` 是**节点 id**——寻址（追问）一律用它：`other_label` 不唯一
 * （本仓 2340 节点仅 2063 个唯一 label）。`file` / `line` 是**调用发出侧**的定位，
 * 都可能为空串（边与节点都没记 location 时）；空则对应那段不渲染。
 */
export interface GraphRelationItem {
  other: string
  other_label: string
  /** 边上的 relation 原值（calls / imports / …） */
  kind: string
  file: string
  /** 纯数字行号串（服务端已剥 `L` 前缀）；定位不到为空串 */
  line: string
}

/** 符号名多义命中时的候选（UI 让用户挑；「多义」是 200 非报错）。 */
export interface GraphRelationCandidate {
  id: string
  label: string
}

/** `GET /api/graph/relations` 的 value（多义时 `node`=查询原串、`total`=0、多出 `candidates`）。 */
export interface GraphRelations {
  project: string
  node: string
  dir: GraphRelationDir
  /** 过滤后**全量**边数（不受 `limit` 截断） */
  total: number
  limit: number
  items: GraphRelationItem[]
  candidates?: GraphRelationCandidate[]
}

/** `GET /api/graph/path` 的 value（graphify 子进程；`chain` 已由服务端切好）。 */
export interface GraphPath {
  project: string
  raw: string
  hops: number | null
  chain: string[]
  found: boolean
}

/** `GET /api/graph/affected` 的 value。⚠ `nodes[].label` 是 label 不是 id——**不可**当寻址主键。 */
export interface GraphAffected {
  project: string
  raw: string
  depth: number | null
  nodes: Array<{ label: string; relation: string; location: string | null }>
}

/**
 * 分层聚合端点（v10 F9）。
 *
 * ✅ **已与后端批逐字对账**（`packages/server/src/http/routes/graph.ts` 的 `rollup`
 * + `packages/server/src/graph/rollup.ts` 的 `buildRollup`；后端回归
 * `packages/server/test/graph-rollup.test.ts`）。路径只此一处，后端定稿/改名时单点改。
 */
export const GRAPH_ROLLUP_ENDPOINT = '/api/graph/rollup'

/** 四层（`symbol` 是 file 的只读出口，不是网格层——见 `pages/explore-logic.ts` 的 `GRID_LEVELS`）。 */
export type RollupLevel = 'community' | 'dir' | 'file' | 'symbol'

/**
 * 一层里的一个聚合节点。
 *
 * 合成 id 编码（后端 `rollup.ts` 头注钉死）：`community:<n>` / `dir:<路径>` / `file:<路径>`。
 * ⚠ 只有 `symbol` 层的 `id` 是**真实图谱节点 id**（可拿去四模式查询）；前三个是合成 id，
 * 拿去做查询必然 404——这正是「dir/community 不给『查此节点』」的原因。
 */
export interface RollupNode {
  id: string
  label: string
  kind: RollupLevel
  symbol_count: number
  /** 仅 `dir` 层填父社区编号（`community:_` 未分组桶无此键） */
  community?: number | string
}

/** 跨组边**条数**（与边自带的 `weight` 字段无关；后端只统计 calls 族）。 */
export interface RollupEdge {
  from: string
  to: string
  weight: number
}

/**
 * `GET /api/graph/rollup` 的 value。
 *
 * ⚠ **响应不含 `project`**（后端形状按 F9 契约钉死为恰好这六个键，逐字见
 * `graph-rollup.test.ts` 的「响应形状钉死」用例）——不要在本类型上加 `project`。
 */
export interface RollupResult {
  level: RollupLevel
  /** 合成 parent id（`community` 层为 `null`） */
  parent: string | null
  /** 截断**前**的全量节点数 */
  total: number
  /** 是否被服务端按 `symbol_count` 降序截断（上限 500，**无分页参数**） */
  truncated: boolean
  nodes: RollupNode[]
  edges: RollupEdge[]
}

/**
 * 架构图渲染端点（`POST /api/arch/render`）。
 *
 * v10 F5 起该面有**两个互斥分支**（`packages/server/src/http/routes/arch.ts` 的 `render`）：
 * - 缺省：调用方自备 `body.ir`（既有面，Web 未消费）；
 * - `mode: 'from-graph'`：调用方只给「项目 + 起点节点 id」，服务端读图谱自组 IR（F5 的导出）。
 *   路径与 mode 常量都收在这里，后端定稿/改名时**单点改**。
 */
export const ARCH_RENDER_ENDPOINT = '/api/arch/render'

/** `mode=from-graph` 分支的选择器值（与后端 `arch.ts` 里的字面量同源）。 */
export const ARCH_RENDER_MODE_FROM_GRAPH = 'from-graph'

/** `POST /api/arch/render` 的 `mode=from-graph` 分支（F5）。
 *
 * ✅ **已与后端批逐字对账**（`packages/server/src/http/routes/arch.ts` 的 `renderFromGraph`；
 * 后端回归 `packages/server/test/arch-render-from-graph.test.ts`）。⚠ 与 design-v10 的
 * **设想路径不同**：设计稿写「新分支（参照 from-team 模式）」，后端落成的是既有
 * `/api/arch/render` 路由的 `mode: 'from-graph'` 子分支——请求体因此多带 `mode` 与 `type`。
 *
 * 口径（对账后的实况）：
 * - 请求体 `{ mode: 'from-graph', type: 'sequence', project, node }`：**`node` 是节点 id**
 *   （`图谱中没有节点 id: X` 的 bad_request 会提示「用 other，不要用符号名」）；
 * - `rootFile` = 命中节点的 `source_file`（反斜杠已归一），由服务端取，前端不传；
 * - 产物落**项目源** `<projectRoot>/.prism/arch/sequence/`，名 `sequence-<消毒 id>-<时间戳>-<短哈希>`；
 * - 失败码（后端冻结，逐条见 `v10-backend-report.md` 的 F5 节）：
 *   `bad_request`（节点 id 不存在 / 该节点无 `source_file` / 缺参 / `type` 不是 sequence /
 *   图谱无跨文件 calls 边 / **指定根文件**无跨文件调用边）、`not_found`（项目未注册）、
 *   `project_root_missing`（项目已注册但根目录被删或被移，由 `resolveArchPlacement` 抛
 *   ——**它是独立码、不是 `bad_request`**，映射见 `pages/graph-logic.ts` 的
 *   `sequenceExportErrorKey`）。
 */
export interface ArchFromGraphResult {
  /** 恒为 `'sequence'`（该分支只支持时序图） */
  type: string
  /** 项目名 */
  project: string
  /** 起点节点 id（回显） */
  node: string
  /** 项目根（绝对路径） */
  root: string
  /** 实际用作根文件的仓库相对路径（正斜杠） */
  root_file: string
  /** 产物文件名，如 `sequence-<消毒 id>-<yyyyMMdd-HHmmss>-<短哈希>.html` */
  name: string
  /** 产物相对**项目根**的路径（正斜杠），便于界面直接展示 */
  relative_path: string
  bytes: number
  /** 服务端构造的预览 URL（iframe src / 新标签打开都用它） */
  preview: string
  /** 产物 IR 源（绝对路径） */
  ir: string
  /** 作用域 sidecar（与 `ArchDiagram` 同族，字段随调用方传入的 layer/owner/book/module 变） */
  meta: unknown
  /** 恒为 `'project'`（落项目源，不落全局 archify 目录） */
  source: 'project'
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

  /**
   * 架构图产物列表（v9 F2 → `GET /api/arch/diagrams`）。
   *
   * - **无参 = 全量**（页面挂载时拉一次：无书归属的进「全局图集」，也用于按 `(type, name)`
   *   解析深链）；
   * - `{ book }` = 该书的图（展开某本书时懒加载，design-v9 §4「按书懒加载」）。传的是
   *   `kbTree` 的**书名**（`BookNode.book`），服务端按 sidecar 的 `book` **精确**匹配，两端口径一致。
   *   ⚠ 服务端过滤**只认 book 名**、不含 layer/owner：跨层或多 owner 的同名书会各拿到**同一批**图，
   *   前端无从区分（见交付报告「对账冲突」）。
   * - 返回**服务端已排序**（`mtime` 降序）。前端原样消费、不重排——深链的「首个命中」依赖这条。
   **/
  archDiagrams: (params?: { book?: string }) => {
    const qs = new URLSearchParams()
    if (params?.book) qs.set('book', params.book)
    const suffix = qs.toString()
    return request<ArchDiagram[]>(`/api/arch/diagrams${suffix ? `?${suffix}` : ''}`)
  },

  graphProjects: () => request<GraphProject[]>('/api/graph/projects'),

  /**
   * 调用链关系查询（v8 F4）：`GET /api/graph/relations`。
   *
   * `node` 收**节点 id 或符号名**（服务端按 `norm_label` 精确 → 唯一前缀解析）；
   * `relation` 是逗号分隔的 relation 白名单（如 `'calls,invokes'`），
   * `undefined` / 空串 = 不传（= 全部关系）。
   */
  graphRelations: (params: {
    project: string
    node: string
    dir: GraphRelationDir
    relation?: string
    limit?: number
  }) => {
    const qs = new URLSearchParams({ project: params.project, node: params.node, dir: params.dir })
    if (params.relation !== undefined && params.relation !== '') qs.set('relation', params.relation)
    if (params.limit !== undefined) qs.set('limit', String(params.limit))
    return request<GraphRelations>(`/api/graph/relations?${qs.toString()}`)
  },

  /** A→B 调用链（`GET /api/graph/path`，graphify 子进程：首次调用可能数秒）。 */
  graphPath: (params: { project: string; from: string; to: string }) => {
    const qs = new URLSearchParams({ project: params.project, from: params.from, to: params.to })
    return request<GraphPath>(`/api/graph/path?${qs.toString()}`)
  },

  /** 改动影响谁（`GET /api/graph/affected`，graphify 子进程）。 */
  graphAffected: (params: { project: string; node: string; depth?: number }) => {
    const qs = new URLSearchParams({ project: params.project, node: params.node })
    if (params.depth !== undefined) qs.set('depth', String(params.depth))
    return request<GraphAffected>(`/api/graph/affected?${qs.toString()}`)
  },

  /**
   * 分层聚合·逐级探索（v10 F9 → `GET /api/graph/rollup`）。
   *
   * - `level='community'` **不接受** `parent`（传了服务端 400）；其余三层必带。
   * - `parent` 形态：`dir` 层 = `community:<n>`；`file` 层 = `dir:<路径>`；`symbol` 层 = `file:<路径>`。
   * - 形态错 → 400 `bad_request`；形态对但图中无此实体 → 404 `not_found`；
   *   项目未登记 → 404 `not_found`；已登记但产物缺失 → 404 `graph_not_found`。
   */
  graphRollup: (params: { project: string; level: RollupLevel; parent?: string }) => {
    const qs = new URLSearchParams({ project: params.project, level: params.level })
    if (params.parent !== undefined && params.parent !== '') qs.set('parent', params.parent)
    return request<RollupResult>(`${GRAPH_ROLLUP_ENDPOINT}?${qs.toString()}`)
  },

  /**
   * F5：由**图谱节点 id** 导出时序图（`POST /api/arch/render` 的 `mode: 'from-graph'` 分支）。
   *
   * `node` 必须是**节点 id**：四模式结果里带 id 的只有 `relations`（`value.node` 是命中
   * 节点 id、`items[].other` 是对端 id）。UI 侧的取用与「拿不到就禁用」的判据见
   * `pages/graph-logic.ts` 的 `sequenceAddress`；错误码→文案的映射见同文件的
   * `sequenceExportErrorKey`。
   */
  archRenderFromGraph: (params: { project: string; node: string }) =>
    request<ArchFromGraphResult>(ARCH_RENDER_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({
        mode: ARCH_RENDER_MODE_FROM_GRAPH,
        type: 'sequence',
        project: params.project,
        node: params.node,
      }),
    }),

  /** 图谱导出（obsidian/wiki/svg/graphml…） */
  graphExport: (project: string, format: string) =>
    request<{ format: string; output: string; files: string[] }>('/api/graph/export', {
      method: 'POST',
      body: JSON.stringify({ project, format }),
    }),

  graphStatus: (project: string) =>
    request<GraphStatus>(`/api/graph/status?project=${encodeURIComponent(project)}`),
}
