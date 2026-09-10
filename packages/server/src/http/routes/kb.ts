import { PrismError } from '@prism/core'

import { ok, type Envelope } from '../envelope.js'
import type { RouteContext } from '../router.js'
import { ENTRY_TYPES, LAYERS, type DepositInput, type EdgeRelation, type KnowledgeService, type Layer } from '../../kb/port.js'
import { exportKnowledgeGraph } from '../../kb/graph-export.js'
import { ScanHistory } from '../../kb/scan-history.js'
import { buildContextPack } from '../../kb/context-pack.js'
import { depositWithPolicy, type DepositRequest } from '../../kb/deposit-entry.js'
import { loadRole, loadTeam, teamNotFoundMessage } from '../../roles/index.js'

/**
 * kb 路由工厂：注入知识服务端口（真实服务运行时装载；测试注入内存桩）。
 *
 * @param rolesDir 角色目录（context-pack 取角色知识绑定）
 * @param teamsDir 团队目录（F-E2：`POST /api/kb/deposit` 的 `team_id` 策略来源）
 */
export function kbRoutes(
  getKb: () => Promise<KnowledgeService>,
  home: string,
  rolesDir: string,
  teamsDir: string,
): {
  search: (ctx: RouteContext) => Promise<Envelope>
  get: (ctx: RouteContext) => Promise<Envelope>
  tree: (ctx: RouteContext) => Promise<Envelope>
  stats: (ctx: RouteContext) => Promise<Envelope>
  deposit: (ctx: RouteContext) => Promise<Envelope>
  catalog: (ctx: RouteContext) => Promise<Envelope>
  graph: (ctx: RouteContext) => Promise<Envelope>
  path: (ctx: RouteContext) => Promise<Envelope>
  exportGraph: (ctx: RouteContext) => Promise<Envelope>
  remove: (ctx: RouteContext) => Promise<Envelope>
  restore: (ctx: RouteContext) => Promise<Envelope>
  conflicts: (ctx: RouteContext) => Promise<Envelope>
  resolveConflict: (ctx: RouteContext) => Promise<Envelope>
  scanHistory: (ctx: RouteContext) => Promise<Envelope>
  contextPack: (ctx: RouteContext) => Promise<Envelope>
  versions: (ctx: RouteContext) => Promise<Envelope>
  bookStructure: (ctx: RouteContext) => Promise<Envelope>
  bookStructureAction: (ctx: RouteContext) => Promise<Envelope>
} {
  const search = async (ctx: RouteContext): Promise<Envelope> => {
    const q = ctx.query.get('q')?.trim() ?? ''
    if (q === '') {
      throw new PrismError('bad_request', '缺少检索词 q')
    }
    const layers = parseLayers(ctx.query.get('layers'))
    // B3：visibility 过滤（opt-in，不传即不过滤）
    const visibilities = parseLayers(ctx.query.get('visibilities'))
    const limit = parseLimit(ctx.query.get('limit'))
    const results = await (
      await getKb()
    ).search({
      q,
      layers: layers ?? undefined,
      owner: ctx.query.get('owner') ?? undefined,
      book: ctx.query.get('book') ?? undefined,
      module: ctx.query.get('module') ?? undefined,
      limit: limit ?? undefined,
      all_versions: parseBool(ctx.query.get('all_versions')),
      ...(visibilities !== null ? { visibilities } : {}),
    })
    return ok(results)
  }

  const get = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id
    if (id === undefined || id === '') {
      throw new PrismError('bad_request', '缺少条目 id')
    }
    const versionRaw = ctx.query.get('version')
    let version: number | undefined
    if (versionRaw !== null && versionRaw !== '') {
      version = Number(versionRaw)
      if (!Number.isInteger(version) || version <= 0) {
        throw new PrismError('bad_request', `version 必须为正整数: ${versionRaw}`)
      }
    }
    const entry = await (await getKb()).get(id, version)
    if (entry === null) {
      throw new PrismError('not_found', `知识条目不存在: ${id}${version !== undefined ? `@${version}` : ''}`)
    }
    return ok(entry)
  }

  const tree = async (ctx: RouteContext): Promise<Envelope> => {
    const layer = parseLayer(ctx.query.get('layer'))
    const owner = ctx.query.get('owner') ?? undefined
    const nodes = await (await getKb()).tree(layer ?? undefined, owner)
    return ok(nodes)
  }

  /** 全量目录（星图/下钻用）：`?layer=&owner=&book=&limit=`。 */
  const catalog = async (ctx: RouteContext): Promise<Envelope> => {
    const layer = parseLayer(ctx.query.get('layer'))
    const owner = ctx.query.get('owner')?.trim() || undefined
    const book = ctx.query.get('book')?.trim() || undefined
    const limitRaw = ctx.query.get('limit')
    const limit = limitRaw !== null && limitRaw !== '' ? parseLimit(limitRaw) : null
    const visibilities = parseLayers(ctx.query.get('visibilities'))
    const entries = await (await getKb()).catalog({
      ...(layer !== null ? { layer } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(book !== undefined ? { book } : {}),
      ...(limit !== null ? { limit } : {}),
      ...(visibilities !== null ? { visibilities } : {}),
    })
    return ok(entries)
  }

  const stats = async (_ctx: RouteContext): Promise<Envelope> => {
    return ok(await (await getKb()).stats())
  }

  /**
   * 落库（F-E2）：接受 `team_id` 并走与 MCP **同一个** `depositWithPolicy`
   * （团队策略只在 `kb/deposit-entry.ts` 实现一次）；缺省不传 → 直传，行为不变。
   */
  const deposit = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Partial<DepositRequest>
    validateDepositInput(body)
    const result = await depositWithPolicy(
      {
        kb: getKb,
        loadTeam: async (teamId) => {
          const team = await loadTeam(teamsDir, teamId, { rolesDir })
          if (team === null) {
            throw new PrismError('not_found', teamNotFoundMessage(teamsDir, teamId))
          }
          return team
        },
      },
      body as DepositRequest,
    )
    return ok(result)
  }

  /**
   * 条目版本历史（F-B4）：`GET /api/kb/versions/:id` → `{ versions }`（降序 + `is_latest`）。
   * 不存在 id → **空数组**（不报错，对齐 §3.1 `listVersions` 口径）。
   * 逐字对齐 design-v4 §3.4 的冻结形状（控制台 `kbVersions` 已两种形状兼容）。
   */
  const versions = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id?.trim() ?? ''
    if (id === '') throw new PrismError('bad_request', '缺少条目 id')
    return ok({ versions: await (await getKb()).listVersions(id) })
  }

  /**
   * 书结构（F-A1/F-A2，design-v4 §3.4）：`GET /api/kb/book-structure?layer=&book=` → `BookStructure`。
   *
   * 与 CLI `prism kb structure show`（t14）**同口径**：结构未生成（或书不存在）→ `not_found`
   * （**不是** `ok(null)`／`ok(空结构)`——「没有结构」与「结构为空」必须可区分）；
   * 层非法/同名书多 owner → 由知识侧抛 `bad_request`（owner 消歧规则在 knowledge，
   * 多 owner 是**契约行为**，不是缺陷）。
   *
   * **R5/R6**：本路由不接任何宿主/知识目录参数——落点由 `getKb()`（组合根按 PRISM_HOME
   * 解析）决定，请求只能给 `layer`/`book`。
   */
  const bookStructure = async (ctx: RouteContext): Promise<Envelope> => {
    const layer = parseLayer(ctx.query.get('layer'))
    if (layer === null) {
      throw new PrismError('bad_request', '缺少 layer 参数')
    }
    const book = ctx.query.get('book')?.trim() ?? ''
    if (book === '') {
      throw new PrismError('bad_request', '缺少 book 参数')
    }
    const structure = await (await getKb()).bookStructure(layer, book)
    if (structure === null) {
      throw new PrismError('not_found', `书结构不存在: ${layer}/${book}（尚未 generate/freeze，或该书无条目）`)
    }
    return ok(structure)
  }

  /**
   * 书结构写面：`POST /api/kb/book-structure`，`action` 在 body（`generate` | `freeze`）。
   *
   * - `generate` → `{ structure, files }`（零 LLM 推导，幂等；与 CLI `--json` 的 value 同形）；
   * - `freeze`   → `BookStructure`（`revision+1`；`modules` 省略则沿用当前清单或接受建议）；
   * - 字段名沿用 `inherited_from`/`frozen_at`/`confirmed_by` 下划线风格，**不做驼峰改写**（t14 同口径）。
   *
   * **R5/R6**：同 GET——不接目录参数。
   */
  const bookStructureAction = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action.trim() : ''
    if (action !== 'generate' && action !== 'freeze') {
      throw new PrismError('bad_request', `action 必须为 generate 或 freeze: ${JSON.stringify(body.action ?? null)}`)
    }
    const rawLayer = typeof body.layer === 'string' ? body.layer.trim() : ''
    const book = typeof body.book === 'string' ? body.book.trim() : ''
    if (rawLayer === '' || book === '') {
      const missing = [...(rawLayer === '' ? ['layer'] : []), ...(book === '' ? ['book'] : [])]
      throw new PrismError('bad_request', `缺少必填参数: ${missing.join(', ')}`)
    }
    const layer = parseLayer(rawLayer)
    if (layer === null) {
      throw new PrismError('bad_request', '缺少 layer 参数')
    }
    const confirmedBy = trimOrUndefined(body.confirmed_by)
    const kb = await getKb()
    if (action === 'generate') {
      return ok(
        await kb.generateBookStructure({
          layer,
          book,
          ...(confirmedBy !== undefined ? { confirmed_by: confirmedBy } : {}),
        }),
      )
    }
    const modules = parseModules(body.modules)
    const note = trimOrUndefined(body.note)
    return ok(
      await kb.freezeBookStructure({
        layer,
        book,
        ...(modules !== undefined ? { modules } : {}),
        ...(confirmedBy !== undefined ? { confirmed_by: confirmedBy } : {}),
        ...(note !== undefined ? { note } : {}),
      }),
    )
  }

  /** 删除条目（B1）：`?hard=true` 走硬删（需无引用）。 */
  const remove = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id?.trim() ?? ''
    if (id === '') throw new PrismError('bad_request', '缺少条目 id')
    const kb = await getKb()
    if (kb.remove === undefined) throw new PrismError('unsupported', '当前知识服务未实现 remove')
    const hard = ctx.query.get('hard') === 'true'
    return ok(await kb.remove(id, { hard }))
  }

  /** 恢复软删条目：`POST /api/kb/entry/:id/restore`。 */
  const restore = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id?.trim() ?? ''
    if (id === '') throw new PrismError('bad_request', '缺少条目 id')
    const kb = await getKb()
    if (kb.restore === undefined) throw new PrismError('unsupported', '当前知识服务未实现 restore')
    return ok(await kb.restore(id))
  }

  /** 层间冲突列表（B2）：`?include_resolved=true` 含已处理。 */
  const conflicts = async (ctx: RouteContext): Promise<Envelope> => {
    const kb = await getKb()
    if (kb.conflicts === undefined) throw new PrismError('unsupported', '当前知识服务未实现 conflicts')
    return ok(await kb.conflicts({ includeResolved: ctx.query.get('include_resolved') === 'true' }))
  }

  /** 标记冲突已处理（B2）：`POST /api/kb/conflicts/:id/resolve`。 */
  const resolveConflict = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id?.trim() ?? ''
    if (id === '') throw new PrismError('bad_request', '缺少冲突 id')
    const kb = await getKb()
    if (kb.resolveConflict === undefined) throw new PrismError('unsupported', '当前知识服务未实现 resolveConflict')
    return ok({ id, resolved: await kb.resolveConflict(id) })
  }

  /** 扫描历史：`GET /api/kb/scan-history?project=<名>&limit=20`。 */
  const scanHistory = async (ctx: RouteContext): Promise<Envelope> => {
    const project = ctx.query.get('project')?.trim() || undefined
    const limitRaw = ctx.query.get('limit')
    const limit = limitRaw !== null && limitRaw !== '' ? Number(limitRaw) : 20
    const history = new ScanHistory(home)
    return ok(await history.list(project, Number.isFinite(limit) ? limit : 20))
  }

  /**
   * 上下文包：`GET /api/kb/context-pack?role=&task=&budget_tokens=`
   * + F-B1/F-B2 增 `layers`/`books`/`symbols`/`max_excerpt_chars`（全部可选，缺省行为不变）。
   */
  const contextPack = async (ctx: RouteContext): Promise<Envelope> => {
    const roleName = ctx.query.get('role')?.trim() ?? ''
    const task = ctx.query.get('task')?.trim() ?? ''
    if (roleName === '' || task === '') {
      throw new PrismError('bad_request', '缺少 role 或 task 参数')
    }
    const role = await loadRole(rolesDir, roleName)
    if (role === null) {
      throw new PrismError('not_found', `角色不存在: ${roleName}`)
    }
    const budget = parseQueryNumber(ctx.query.get('budget_tokens'))
    const layers = parseLayers(ctx.query.get('layers'))
    const books = parseCsv(ctx.query.get('books'))
    const symbols = parseCsv(ctx.query.get('symbols'))
    const maxExcerptChars = parsePositiveInt(ctx.query.get('max_excerpt_chars'), 'max_excerpt_chars', 100000)
    return ok(
      await buildContextPack(await getKb(), {
        role: roleName,
        binding: role.knowledge,
        task,
        ...(budget !== undefined ? { budgetTokens: budget } : {}),
        ...(layers !== null ? { layers } : {}),
        ...(books !== null ? { books } : {}),
        ...(symbols !== null ? { symbols } : {}),
        ...(maxExcerptChars !== null ? { maxExcerptChars } : {}),
      }),
    )
  }

  /** 图谱邻域/概览：`?id=<节点>&depth=1&relations=references&limit=50`。 */
  const graph = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.query.get('id')?.trim() || undefined
    const depth = parsePositiveInt(ctx.query.get('depth'), 'depth', 3)
    const limit = parsePositiveInt(ctx.query.get('limit'), 'limit', 500)
    const book = ctx.query.get('book')?.trim() || undefined
    const owner = ctx.query.get('owner')?.trim() || undefined
    const moduleName = ctx.query.get('module')?.trim() || undefined
    const layerRaw = ctx.query.get('layer')?.trim() || undefined
    const layer = layerRaw !== undefined ? parseLayer(layerRaw) : null
    const view = await (
      await getKb()
    ).graph({
      ...(id !== undefined ? { id } : {}),
      ...(depth !== null ? { depth } : {}),
      ...(limit !== null ? { limit } : {}),
      ...(book !== undefined ? { book } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(moduleName !== undefined ? { module: moduleName } : {}),
      ...(layer !== null ? { layer } : {}),
      ...(parseRelations(ctx.query.get('relations')) !== undefined
        ? { relations: parseRelations(ctx.query.get('relations')) }
        : {}),
    })
    return ok(view)
  }

  /**
   * 导出知识图谱（D9：借 Graphify 渲染/Obsidian，Prism 零 LLM 抽边）：
   * `POST /api/kb/export { format, limit? }`。
   */
  const exportGraph = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as { format?: unknown; limit?: unknown }
    const format = typeof body.format === 'string' ? body.format.trim() : 'html'
    const allowed = ['html', 'obsidian', 'svg', 'graphml', 'wiki']
    if (!allowed.includes(format)) {
      throw new PrismError('bad_request', `不支持的导出格式: ${format}`, { allowed })
    }
    const limit = typeof body.limit === 'number' ? body.limit : undefined
    const kb = await getKb()
    const view = await kb.graph({ limit: limit ?? 500 })
    const result = await exportKnowledgeGraph(kb, {
      format: format as 'html',
      view,
      // R5：产物落调用方的 home（测试传临时目录时不得写真实 PRISM_HOME）
      home,
      ...(limit !== undefined ? {} : {}),
    })
    return ok(result)
  }

  /** 两节点最短路径：`?from=<id>&to=<id>`；不可达 → 404 not_found。 */
  const path = async (ctx: RouteContext): Promise<Envelope> => {
    const from = ctx.query.get('from')?.trim() ?? ''
    const to = ctx.query.get('to')?.trim() ?? ''
    if (from === '' || to === '') {
      throw new PrismError('bad_request', '路径查询需要 from 与 to')
    }
    const found = await (await getKb()).path(from, to, parseRelations(ctx.query.get('relations')))
    if (found === null) {
      throw new PrismError('not_found', `两节点间无路径: ${from} → ${to}`)
    }
    return ok(found)
  }

  return { search, get, tree, stats, catalog, deposit, graph, path, exportGraph, remove, restore, conflicts, resolveConflict, scanHistory, contextPack, versions, bookStructure, bookStructureAction }
}

/** 关系类型查询参数（`relations=references,overrides`；非法 → bad_request）。 */
function parseRelations(raw: string | null): EdgeRelation[] | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const allowed: readonly EdgeRelation[] = ['references', 'overrides', 'supersedes', 'related']
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      if (!allowed.includes(s as EdgeRelation)) {
        throw new PrismError('bad_request', `非法关系类型: ${s}（可选: ${allowed.join('/')}）`)
      }
      return s as EdgeRelation
    })
}

/**
 * deposit 前置校验（design.md §3.5：必填字段缺失 → bad_request）。
 *
 * **`content` 必填**（与知识侧 `#validateAndNormalize` 的 `content 必填` 同口径）：
 * 团队 `deposit.require_note` 的机械判据是「`source.ref` 非空 **或** `content` 非空」，
 * 但 `content` 在**所有入口**（CLI 正文 / MCP schema `required` / 本处）都是硬要求，
 * 且服务在写库前必再校验一次 → 空正文永远到不了写库。故 HTTP 面 `require_note`
 * 只可能因「空正文」触发，而空正文先被本层以更直白的 `content 必填` 拦下。
 * QA v4（`.qa_ok_v4` D-1）核实此为**跨层口径张力，非功能缺陷**：三入口都必须给正文，
 * 该策略分支属「纵深冗余」，不是「HTTP 面被绕过」。详见 `doc/requirements/team-definition.md` §5。
 */
function validateDepositInput(body: Partial<DepositInput>): void {
  for (const field of ['title', 'type', 'layer', 'book', 'content'] as const) {
    const value = body[field]
    if (typeof value !== 'string' || value.trim() === '') {
      throw new PrismError('bad_request', `deposit 缺少必填字段: ${field}`)
    }
  }
  if (!ENTRY_TYPES.includes(body.type as never)) {
    throw new PrismError('bad_request', `非法条目类型: ${String(body.type)}（可选: ${ENTRY_TYPES.join('/')}）`)
  }
  if (!LAYERS.includes(body.layer as never)) {
    throw new PrismError('bad_request', `非法层: ${String(body.layer)}（可选: ${LAYERS.join('/')}）`)
  }
  if ((body.layer === 'project' || body.layer === 'role') && (body.owner === undefined || body.owner.trim() === '')) {
    throw new PrismError('bad_request', `layer=${body.layer} 必须提供 owner`)
  }
}

/** 非空字符串 → 去空白；其余（缺省/空串/非字符串）→ undefined（不静默改成别的值）。 */
function trimOrUndefined(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

/**
 * `freeze` 的模块清单（F-A1）：接受字符串数组 **或** 逗号分隔字符串（与 CLI `--modules a,b` 同形）。
 * 缺省 → undefined（沿用当前清单/接受建议）；显式给了但筛完为空 → `bad_request`
 * （对齐 CLI：`--modules` 给了空值不静默当成「没给」）。
 */
function parseModules(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) && typeof raw !== 'string') {
    throw new PrismError('bad_request', 'modules 必须是字符串数组或逗号分隔字符串')
  }
  const list: unknown[] = Array.isArray(raw) ? raw : (raw as string).split(',')
  if (list.some((m) => typeof m !== 'string')) {
    throw new PrismError('bad_request', 'modules 必须是字符串数组或逗号分隔字符串')
  }
  const modules = (list as string[]).map((m) => m.trim()).filter((m) => m !== '')
  if (modules.length === 0) {
    throw new PrismError('bad_request', 'modules 需要至少一个模块 slug（如 ["core","api"]）')
  }
  return modules
}

function parseLayers(raw: string | null): Layer[] | null {
  if (raw === null || raw.trim() === '') {
    return null
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      if (!LAYERS.includes(s as never)) {
        throw new PrismError('bad_request', `非法层: ${s}（可选: ${LAYERS.join('/')}）`)
      }
      return s as Layer
    })
}

function parseLayer(raw: string | null): Layer | null {
  if (raw === null || raw.trim() === '') {
    return null
  }
  if (!LAYERS.includes(raw as never)) {
    throw new PrismError('bad_request', `非法层: ${raw}（可选: ${LAYERS.join('/')}）`)
  }
  return raw as Layer
}

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') {
    return null
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > 1000) {
    throw new PrismError('bad_request', `limit 必须为 1~1000 的整数: ${raw}`)
  }
  return value
}

/** 正整数参数（省略 → null；上限 max）。 */
function parsePositiveInt(raw: string | null, name: string, max: number): number | null {
  if (raw === null || raw.trim() === '') return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new PrismError('bad_request', `${name} 必须为 1~${max} 的整数: ${raw}`)
  }
  return value
}

function parseBool(raw: string | null): boolean | undefined {
  if (raw === null) {
    return undefined
  }
  return raw === 'true' || raw === '1'
}

/** 查询参数 → 数字；缺省/非有限值 → undefined（保持「非法即忽略」的既有行为）。 */
function parseQueryNumber(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** 逗号分隔查询参数 → 去空串数组；参数缺省 → null（三态：缺省 / 空 / 有值）。 */
function parseCsv(raw: string | null): string[] | null {
  if (raw === null) return null
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}
