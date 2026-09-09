import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'

import { PrismError } from '@prism/core'
import { prismPaths } from '@prism/core'

import { ok, type Envelope } from '../envelope.js'
import { ARCHIFY_DIAGRAM_TYPES, ARCHIFY_TYPE_LABELS, renderDiagram, validateDiagram } from '../../graph/archify.js'
import type { RouteContext } from '../router.js'

export interface ArchDeps {
  /** PRISM_HOME（产物落 <home>/archify/<type>/） */
  home: string
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
 * - GET  /api/arch/preview/:type/:file  取渲染产物 HTML（iframe 预览；防穿越）
 * 渲染器为 vendored 子工程 3rd/archify（MIT v2.16.0），Prism 只编排。
 */
export function archRoutes(deps: ArchDeps): {
  types: (ctx: RouteContext) => Promise<Envelope>
  diagrams: (ctx: RouteContext) => Promise<Envelope>
  validate: (ctx: RouteContext) => Promise<Envelope>
  render: (ctx: RouteContext) => Promise<Envelope>
  preview: (ctx: RouteContext) => Promise<void>
} {
  const baseDir = (): string => join(prismPaths(deps.home).home, 'archify')

  const types = async (): Promise<Envelope> =>
    ok(ARCHIFY_DIAGRAM_TYPES.map((type) => ({ type, label: ARCHIFY_TYPE_LABELS[type] })))

  const diagrams = async (): Promise<Envelope> => {
    const { readdir } = await import('node:fs/promises')
    const out: Array<{ type: string; name: string; bytes: number; mtime: string }> = []
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
        out.push({ type, name: entry, bytes: info.size, mtime: info.mtime.toISOString() })
      }
    }
    return ok(out.sort((a, b) => b.mtime.localeCompare(a.mtime)))
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
    const info = await stat(htmlPath)
    return ok({
      type,
      name: `${name}.html`,
      bytes: info.size,
      preview: `/api/arch/preview/${type}/${name}.html`,
      ir: irCopy,
    })
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
    if (!target.startsWith(root)) {
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

  return { types, diagrams, validate, render, preview }
}

/** 读取本地 IR 文件（供上层测试/脚本复用）。 */
export async function readIrFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown
}
