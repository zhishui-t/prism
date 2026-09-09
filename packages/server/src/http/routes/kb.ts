import { PrismError } from '@prism/core'

import { ok, type Envelope } from '../envelope.js'
import type { RouteContext } from '../router.js'
import { ENTRY_TYPES, LAYERS, type DepositInput, type EdgeRelation, type KnowledgeService, type Layer } from '../../kb/port.js'

/** kb 路由工厂：注入知识服务端口（真实服务运行时装载；测试注入内存桩）。 */
export function kbRoutes(getKb: () => Promise<KnowledgeService>): {
  search: (ctx: RouteContext) => Promise<Envelope>
  get: (ctx: RouteContext) => Promise<Envelope>
  tree: (ctx: RouteContext) => Promise<Envelope>
  stats: (ctx: RouteContext) => Promise<Envelope>
  deposit: (ctx: RouteContext) => Promise<Envelope>
  graph: (ctx: RouteContext) => Promise<Envelope>
  path: (ctx: RouteContext) => Promise<Envelope>
} {
  const search = async (ctx: RouteContext): Promise<Envelope> => {
    const q = ctx.query.get('q')?.trim() ?? ''
    if (q === '') {
      throw new PrismError('bad_request', '缺少检索词 q')
    }
    const layers = parseLayers(ctx.query.get('layers'))
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

  const stats = async (_ctx: RouteContext): Promise<Envelope> => {
    return ok(await (await getKb()).stats())
  }

  const deposit = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Partial<DepositInput>
    validateDepositInput(body)
    const result = await (await getKb()).deposit(body as DepositInput)
    return ok(result)
  }

  /** 图谱邻域/概览：`?id=<节点>&depth=1&relations=references&limit=50`。 */
  const graph = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.query.get('id')?.trim() || undefined
    const depth = parsePositiveInt(ctx.query.get('depth'), 'depth', 3)
    const limit = parsePositiveInt(ctx.query.get('limit'), 'limit', 500)
    const view = await (
      await getKb()
    ).graph({
      ...(id !== undefined ? { id } : {}),
      ...(depth !== null ? { depth } : {}),
      ...(limit !== null ? { limit } : {}),
      ...(parseRelations(ctx.query.get('relations')) !== undefined
        ? { relations: parseRelations(ctx.query.get('relations')) }
        : {}),
    })
    return ok(view)
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

  return { search, get, tree, stats, deposit, graph, path }
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

/** deposit 前置校验（design.md §3.5：必填字段缺失 → bad_request）。 */
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
