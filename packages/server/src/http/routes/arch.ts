import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'

import { buildTeamWorkflowIr } from '@prism/agents'
import { PrismError } from '@prism/core'
import { prismPaths } from '@prism/core'

import { loadTeam, teamNotFoundMessage } from '../../roles/index.js'
import { ok, type Envelope } from '../envelope.js'
import {
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_TYPE_LABELS,
  artifactStat,
  isInside,
  readArtifactMeta,
  readIrCopy,
  renderDiagram,
  validateDiagram,
  writeArtifactMeta,
} from '../../graph/archify.js'
import type { RouteContext } from '../router.js'

export interface ArchDeps {
  /** PRISM_HOME（产物落 <home>/archify/<type>/） */
  home: string
  /** 团队受管目录（F-C4 `from-team` 读团队定义；与 CLI 同源） */
  teamsDir: string
  /** 角色受管目录（团队成员的引用校验用） */
  rolesDir: string
}

/** 产物列表项（带作用域，供界面按书/模块过滤）。 */
export interface ArchArtifact {
  type: string
  name: string
  bytes: number
  mtime: string
  /** 图标题（取自 IR meta.title 或 sidecar） */
  title?: string
  layer?: string
  owner?: string
  book?: string
  module?: string
  /** 渲染器版本（sidecar） */
  archify_version?: string
  /** IR 是否可读（同目录 <name>.ir.json 存在） */
  has_ir: boolean
}

/** 图类型守卫。 */
function assertType(raw: string): asserts raw is (typeof ARCHIFY_DIAGRAM_TYPES)[number] {
  if (!ARCHIFY_DIAGRAM_TYPES.includes(raw as never)) {
    throw new PrismError('bad_request', `非法图类型: ${raw}`, { allowed: ARCHIFY_DIAGRAM_TYPES })
  }
}

/**
 * 架构图谱路由（knowledge-base.md §4.4 / D10）：
 * - GET  /api/arch/types              五类图清单
 * - GET  /api/arch/diagrams           已渲染产物列表（<home>/archify/<type>/*.html）
 * - POST /api/arch/validate           校验 IR（body: { type, ir }）
 * - POST /api/arch/render             渲染并落盘（body: { type, ir, name? }）
 * - POST /api/arch/from-team          由**团队工作流**生成并渲染（body: { team_id, name? }，F-C4）
 * - GET  /api/arch/preview/:type/:file  取渲染产物 HTML（iframe 预览；防穿越）
 * 渲染器为 vendored 子工程 3rd/archify（MIT v2.16.0），Prism 只编排。
 */
export function archRoutes(deps: ArchDeps): {
  types: (ctx: RouteContext) => Promise<Envelope>
  diagrams: (ctx: RouteContext) => Promise<Envelope>
  validate: (ctx: RouteContext) => Promise<Envelope>
  render: (ctx: RouteContext) => Promise<Envelope>
  fromTeam: (ctx: RouteContext) => Promise<Envelope>
  ir: (ctx: RouteContext) => Promise<Envelope>
  preview: (ctx: RouteContext) => Promise<void>
} {
  const baseDir = (): string => join(prismPaths(deps.home).home, 'archify')

  const types = async (): Promise<Envelope> =>
    ok(ARCHIFY_DIAGRAM_TYPES.map((type) => ({ type, label: ARCHIFY_TYPE_LABELS[type] })))

  const diagrams = async (ctx: RouteContext): Promise<Envelope> => {
    const { readdir } = await import('node:fs/promises')
    // 过滤条件：?book=&module=（module 为空串表示只看「待归类」）
    const bookFilter = ctx.query.get('book')
    const moduleFilter = ctx.query.get('module')
    const out: ArchArtifact[] = []
    for (const type of ARCHIFY_DIAGRAM_TYPES) {
      const dir = join(baseDir(), type)
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.endsWith('.html')) continue
        const full = join(dir, entry)
        const info = await stat(full)
        const meta = await readArtifactMeta(full)
        out.push({
          type,
          name: entry,
          bytes: info.size,
          mtime: info.mtime.toISOString(),
          ...(meta?.title !== undefined ? { title: meta.title } : {}),
          ...(meta?.layer !== undefined ? { layer: meta.layer } : {}),
          ...(meta?.owner !== undefined ? { owner: meta.owner } : {}),
          ...(meta?.book !== undefined ? { book: meta.book } : {}),
          ...(meta?.module !== undefined ? { module: meta.module } : {}),
          ...(meta?.archify_version !== undefined ? { archify_version: meta.archify_version } : {}),
          has_ir: (await artifactStat(full.replace(/\.html$/i, '.ir.json'))) !== null,
        })
      }
    }
    // 作用域过滤：指定 book 时只留该书的产物；再指定 module 时按模块收窄。
    const filtered = out.filter((a) => {
      if (bookFilter !== null && a.book !== bookFilter) return false
      if (moduleFilter !== null && (a.module ?? '') !== moduleFilter) return false
      return true
    })
    return ok(filtered.sort((a, b) => b.mtime.localeCompare(a.mtime)))
  }

  const validate = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const type = String(body['type'] ?? '')
    assertType(type)
    if (body['ir'] === undefined) {
      throw new PrismError('bad_request', '缺少 ir（JSON-IR 对象）')
    }
    const result = await validateDiagram(type, body['ir'])
    return result.ok ? ok(result) : ok(result) // 校验失败也是「正常响应」，由 value.ok 表达
  }

  const render = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const type = String(body['type'] ?? '')
    assertType(type)
    if (body['ir'] === undefined) {
      throw new PrismError('bad_request', '缺少 ir（JSON-IR 对象）')
    }
    const rawName = typeof body['name'] === 'string' ? body['name'].trim() : ''
    const name = rawName === '' ? type : rawName.replace(/[^A-Za-z0-9_.-]/g, '_')
    const dir = join(baseDir(), type)
    await mkdir(dir, { recursive: true })
    const htmlPath = join(dir, `${name}.html`)
    await renderDiagram(type, body['ir'], htmlPath)
    const irCopy = join(dir, `${name}.ir.json`)
    await writeFile(irCopy, `${JSON.stringify(body['ir'], null, 2)}\n`, 'utf-8')
    // sidecar：作用域（可选）+ 版本 + IR 哈希，让界面能按书/模块过滤产物
    const scope = {
      ...(typeof body['layer'] === 'string' ? { layer: body['layer'] } : {}),
      ...(typeof body['owner'] === 'string' ? { owner: body['owner'] } : {}),
      ...(typeof body['book'] === 'string' ? { book: body['book'] } : {}),
      ...(typeof body['module'] === 'string' ? { module: body['module'] } : {}),
    }
    const meta = await writeArtifactMeta(htmlPath, body['ir'], scope)
    const info = await stat(htmlPath)
    return ok({
      type,
      name: `${name}.html`,
      bytes: info.size,
      preview: `/api/arch/preview/${type}/${name}.html`,
      ir: irCopy,
      meta,
    })
  }

  /**
   * 由团队工作流生成工作流图（F-C4）：`buildTeamWorkflowIr`（agents 包纯函数）→ archify 渲染。
   *
   * 只落 `<home>/archify/workflow/`（同 `render`），**不接任意输出路径**；
   * `team_id` 未注册 → `not_found`（不静默产出空图）。
   * 注：按 D8 修正，本轮**不提供** MCP 入口。
   */
  const fromTeam = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const teamId = typeof body['team_id'] === 'string' ? body['team_id'].trim() : ''
    if (teamId === '') {
      throw new PrismError('bad_request', '缺少 team_id（团队 ID）')
    }
    const team = await loadTeam(deps.teamsDir, teamId, { rolesDir: deps.rolesDir })
    if (team === null) {
      throw new PrismError('not_found', teamNotFoundMessage(deps.teamsDir, teamId))
    }

    let ir: unknown
    try {
      ir = buildTeamWorkflowIr(team)
    } catch (error) {
      throw new PrismError('bad_request', error instanceof Error ? error.message : String(error))
    }

    const type = 'workflow' as const
    const rawName = typeof body['name'] === 'string' ? body['name'].trim() : ''
    const name = rawName === '' ? teamId : rawName.replace(/[^A-Za-z0-9_.-]/g, '_')
    const dir = join(baseDir(), type)
    await mkdir(dir, { recursive: true })
    const htmlPath = join(dir, `${name}.html`)
    await renderDiagram(type, ir, htmlPath)
    const irCopy = join(dir, `${name}.ir.json`)
    await writeFile(irCopy, `${JSON.stringify(ir, null, 2)}\n`, 'utf-8')
    const scope = {
      ...(typeof body['layer'] === 'string' ? { layer: body['layer'] } : {}),
      ...(typeof body['owner'] === 'string' ? { owner: body['owner'] } : {}),
      ...(typeof body['book'] === 'string' ? { book: body['book'] } : {}),
      ...(typeof body['module'] === 'string' ? { module: body['module'] } : {}),
    }
    const meta = await writeArtifactMeta(htmlPath, ir, scope)
    const info = await stat(htmlPath)
    return ok({
      type,
      team_id: teamId,
      name: `${name}.html`,
      bytes: info.size,
      preview: `/api/arch/preview/${type}/${name}.html`,
      ir: irCopy,
      meta,
    })
  }

  /** 取产物 IR 源（`<name>.ir.json`）与 sidecar 元数据，供界面「IR / 元数据」子标签展示。 */
  const ir = async (ctx: RouteContext): Promise<Envelope> => {
    const type = ctx.params.type ?? ''
    const file = ctx.params.file ?? ''
    assertType(type)
    if (!/^[A-Za-z0-9_.-]+\.html$/.test(file)) {
      throw new PrismError('bad_request', `非法文件名: ${file}`)
    }
    const root = resolve(join(baseDir(), type))
    const htmlPath = resolve(join(root, file))
    if (!isInside(root, htmlPath)) {
      throw new PrismError('bad_request', '路径越界')
    }
    const [irValue, meta] = await Promise.all([readIrCopy(htmlPath), readArtifactMeta(htmlPath)])
    if (irValue === null && meta === null) {
      throw new PrismError('not_found', `该产物没有 IR 源或元数据: ${type}/${file}`)
    }
    return ok({ type, name: file, ir: irValue, meta })
  }

  /** 预览：只允许 <home>/archify/<type>/<file>，且解析后仍在根内（防穿越）。 */
  const preview = async (ctx: RouteContext): Promise<void> => {
    const type = ctx.params.type ?? ''
    const file = ctx.params.file ?? ''
    assertType(type)
    if (!/^[A-Za-z0-9_.-]+\.html$/.test(file)) {
      throw new PrismError('bad_request', `非法文件名: ${file}`)
    }
    const root = resolve(join(baseDir(), type))
    const target = resolve(join(root, file))
    if (!isInside(root, target)) {
      throw new PrismError('bad_request', '路径越界')
    }
    let info
    try {
      info = await stat(target)
    } catch {
      throw new PrismError('not_found', `渲染产物不存在: ${type}/${file}`)
    }
    const res = ctx.res
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(info.size),
      'X-Content-Type-Options': 'nosniff',
    })
    createReadStream(target).pipe(res)
  }

  return { types, diagrams, validate, render, fromTeam, ir, preview }
}

/** 读取本地 IR 文件（供上层测试/脚本复用）。 */
export async function readIrFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown
}
