import { basename, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

import { splitFrontmatter, type FrontmatterData } from '@prism/knowledge'
import { ENTRY_TYPES, loadKnowledgeService, type KnowledgeService } from '@prism/server'
import { PrismError } from '@prism/core'

import type { ArgValues, CommandContext } from '../argv.js'

/** 获取知识服务（注入优先；否则运行时经 @prism/knowledge 装载）。 */
async function getKb(ctx: CommandContext): Promise<KnowledgeService> {
  if (ctx.kbFactory !== undefined) {
    return await ctx.kbFactory()
  }
  return await loadKnowledgeService(ctx.home)
}

/** `prism kb ...`（design.md §5：import/search；get/tree/stats 为需求文档补充面）。 */
export async function runKb(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'import':
      return await kbImport(ctx, rest, values)
    case 'search':
      return await kbSearch(ctx, rest, values)
    case 'get':
      return await kbGet(ctx, rest, values)
    case 'tree':
      return await kbTree(ctx, values)
    case 'stats':
      return await kbStats(ctx)
    case 'graph':
      return await kbGraph(ctx, rest, values)
    case 'path':
      return await kbPath(ctx, rest, values)
    case 'reindex':
      return await kbReindex(ctx)
    default:
      ctx.stderr(`用法: prism kb <import|search|get|tree|stats|graph|path|reindex> ...`)
      return 1
  }
}

async function kbImport(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const file = args[0]
  if (file === undefined) {
    ctx.stderr('用法: prism kb import <file.md> [--layer --owner --book --module]')
    return 1
  }
  const abs = resolve(file)
  const raw = await readFile(abs, 'utf-8')

  // frontmatter 字段作默认值；命令行显式传入时覆盖（返工单 F04）
  const { data, body } = splitFrontmatter(raw)
  const fm: FrontmatterData = data ?? {}
  const fmStr = (key: string): string | undefined => (typeof fm[key] === 'string' ? (fm[key] as string) : undefined)

  const title = fmStr('title') ?? extractTitle(body) ?? basename(abs).replace(/\.[^.]+$/, '')
  const id = fmStr('id')
  const type = fmStr('type') ?? 'doc'
  if (!ENTRY_TYPES.includes(type as never)) {
    throw new PrismError('bad_request', `frontmatter type 非法: ${type}（可选: ${ENTRY_TYPES.join('/')}）`)
  }
  const layer = values.layer ?? fmStr('layer') ?? 'global'
  const owner = values.owner ?? fmStr('owner')
  if ((layer === 'project' || layer === 'role') && (owner === undefined || owner === '')) {
    ctx.stderr('错误 [bad_request] --layer project/role 必须同时给 --owner（或文件 frontmatter 提供 owner）')
    return 1
  }
  const book = values.book ?? fmStr('book') ?? 'inbox'
  const module = values.module ?? fmStr('module')
  const tags = Array.isArray(fm.tags) ? fm.tags.filter((t): t is string => typeof t === 'string') : undefined

  const kb = await getKb(ctx)
  const result = await kb.deposit({
    id,
    title,
    type: type as Parameters<KnowledgeService['deposit']>[0]['type'],
    layer: layer as 'global' | 'project' | 'role',
    owner,
    book,
    module,
    tags,
    content: body, // 正文 = 去掉 frontmatter 后的正文，frontmatter 本身不入库
    source: { kind: 'import', ref: abs },
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: result }))
  } else {
    ctx.stdout(`已落库 ${result.id}@v${result.version} → ${result.path}`)
  }
  return 0
}

async function kbSearch(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const q = args[0]
  if (q === undefined || q.trim() === '') {
    ctx.stderr('用法: prism kb search <query> [--layer --book --limit]')
    return 1
  }
  const kb = await getKb(ctx)
  const results = await kb.search({
    q: q.trim(),
    layers: values.layer !== undefined ? [values.layer as 'global' | 'project' | 'role'] : undefined,
    book: values.book,
    limit: values.limit !== undefined ? Number(values.limit) : undefined,
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: results }))
    return 0
  }
  if (results.length === 0) {
    ctx.stdout('（无结果）')
    return 0
  }
  for (const r of results) {
    ctx.stdout(`[${r.score}] ${r.source}  ${r.title}`)
    ctx.stdout(`    ${r.excerpt.replace(/\n/g, ' ').slice(0, 100)}`)
  }
  ctx.stdout(`共 ${results.length} 条`)
  return 0
}

async function kbGet(ctx: CommandContext, args: string[], _values: ArgValues): Promise<number> {
  const ref = args[0]
  if (ref === undefined) {
    ctx.stderr('用法: prism kb get <id[@version]>')
    return 1
  }
  const atIndex = ref.lastIndexOf('@')
  const id = atIndex > 0 ? ref.slice(0, atIndex) : ref
  const version = atIndex > 0 ? Number(ref.slice(atIndex + 1)) : undefined
  const kb = await getKb(ctx)
  const entry = await kb.get(id, Number.isInteger(version) ? version : undefined)
  if (entry === null) {
    ctx.stderr(`错误 [not_found] 条目不存在: ${ref}`)
    return 1
  }
  ctx.stdout(JSON.stringify(ctx.json ? { ok: true, value: entry } : entry, null, 2))
  return 0
}

async function kbTree(ctx: CommandContext, values: ArgValues): Promise<number> {
  const kb = await getKb(ctx)
  const nodes = await kb.tree(values.layer as 'global' | 'project' | 'role' | undefined, values.owner)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: nodes }))
    return 0
  }
  for (const node of nodes) {
    ctx.stdout(`${node.layer}${node.owner !== undefined ? `/${node.owner}` : ''}/${node.book}（${node.total} 条）`)
    for (const mod of node.modules) {
      ctx.stdout(`  - ${mod.name}（${mod.count}）`)
    }
  }
  return 0
}

async function kbStats(ctx: CommandContext): Promise<number> {
  const kb = await getKb(ctx)
  const stats = await kb.stats()
  ctx.stdout(JSON.stringify(ctx.json ? { ok: true, value: stats } : stats, null, 2))
  return 0
}

/** `prism kb graph [id] [--depth --limit --relations]`：图谱邻域/概览。 */
async function kbGraph(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const id = args[0]
  const kb = await getKb(ctx)
  const view = await kb.graph({
    ...(id !== undefined ? { id } : {}),
    ...(values.depth !== undefined ? { depth: Number(values.depth) } : {}),
    ...(values.limit !== undefined ? { limit: Number(values.limit) } : {}),
    ...(values.relations !== undefined
      ? { relations: String(values.relations).split(',').map((s) => s.trim()) as never[] }
      : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: view }))
    return 0
  }
  ctx.stdout(`节点 ${view.nodes.length} 个，边 ${view.edges.length} 条${view.truncated ? '（已截断）' : ''}`)
  for (const node of view.nodes) {
    ctx.stdout(`  ${node.id}  [${node.layer}/${node.book}]  入${node.in_degree}/出${node.out_degree}  ${node.title}`)
  }
  for (const edge of view.edges) {
    ctx.stdout(`  ${edge.from_id} --${edge.relation}--> ${edge.to_id}`)
  }
  return 0
}

/** `prism kb path <from> <to> [--relations]`：两节点最短路径。 */
async function kbPath(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [from, to] = args
  if (from === undefined || to === undefined) {
    ctx.stderr('用法: prism kb path <from-id> <to-id> [--relations references,overrides]')
    return 1
  }
  const kb = await getKb(ctx)
  const relations =
    values.relations !== undefined
      ? (String(values.relations).split(',').map((s) => s.trim()) as never[])
      : undefined
  const path = await kb.path(from, to, relations)
  if (path === null) {
    ctx.stderr(`错误 [not_found] 两节点间无路径: ${from} → ${to}`)
    return 1
  }
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: path }))
    return 0
  }
  ctx.stdout(path.nodes.join(' → '))
  for (const edge of path.edges) {
    ctx.stdout(`  ${edge.from_id} --${edge.relation}--> ${edge.to_id}`)
  }
  return 0
}

/** `prism kb reindex`：以文件为真相重建索引（Z2；手工编辑/迁移知识文件后收敛漂移）。 */async function kbReindex(ctx: CommandContext): Promise<number> {
  const kb = await getKb(ctx)
  if (kb.reindex === undefined) {
    ctx.stderr('错误 [unsupported] 当前知识服务未实现 reindex')
    return 1
  }
  const report = await kb.reindex()
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: report }))
    return 0
  }
  ctx.stdout(`已重建索引：扫描 ${report.scanned} 个版次文件，索引 ${report.indexed} 条，跳过 ${report.skipped} 条`)
  for (const err of report.errors) {
    ctx.stderr(`  SKIP ${err.path}: ${err.reason}`)
  }
  return report.skipped > 0 ? 1 : 0
}

/** 取首个一级标题作为落库标题。 */
function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m)
  return match !== null ? match[1].trim() : null
}
