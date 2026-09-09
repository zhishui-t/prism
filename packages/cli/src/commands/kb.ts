import { basename, resolve } from 'node:path'
import { readFile, access } from 'node:fs/promises'

import { splitFrontmatter, type FrontmatterData } from '@prism/knowledge'
import {
  ENTRY_TYPES,
  ProjectRegistry,
  idFromRel,
  loadKnowledgeService,
  exportKnowledgeGraph,
  scanProject,
  type KnowledgeService,
} from '@prism/server'
import { PrismError, WorkQueue, openPersistence, prismPaths } from '@prism/core'

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
    case 'sync':
      return await kbSync(ctx, rest, values)
    case 'remove':
      return await kbRemove(ctx, rest, values)
    case 'export':
      return await kbExport(ctx, rest, values)
    default:
      ctx.stderr(`用法: prism kb <import|sync|remove|search|get|tree|stats|graph|path|export|reindex> ...`)
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

/**
 * `prism kb export [--format html|obsidian|svg|graphml|wiki]`（D9）：
 * 知识图谱借 Graphify 渲染/导出——Prism 零 LLM 抽边 → Graphify 格式 → 社区发现 + 渲染。
 */
async function kbExport(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const format = (values.format ?? args[0] ?? 'html') as 'html' | 'obsidian' | 'svg' | 'graphml' | 'wiki'
  const allowed = ['html', 'obsidian', 'svg', 'graphml', 'wiki']
  if (!allowed.includes(format)) {
    ctx.stderr(`错误 [bad_request] 不支持的导出格式: ${format}（可用: ${allowed.join('/')}）`)
    return 1
  }
  const kb = await getKb(ctx)
  const result = await exportKnowledgeGraph(kb, {
    format,
    home: ctx.home,
    ...(ctx.graphifyEnv !== undefined ? { graphifyEnv: ctx.graphifyEnv } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: result }))
    return 0
  }
  ctx.stdout(`已导出知识图谱（${format}）：节点 ${result.summary.nodes} / 边 ${result.summary.edges}${result.summary.dropped_edges > 0 ? `（丢弃悬空边 ${result.summary.dropped_edges}）` : ''}`)
  ctx.stdout(`  Graphify 格式: ${result.graphJson}`)
  ctx.stdout(`  产物: ${result.output}`)
  if (result.files.length > 0) {
    ctx.stdout(`  文件: ${result.files.slice(0, 8).join(', ')}${result.files.length > 8 ? ` …共 ${result.files.length} 个` : ''}`)
  }
  if (format === 'obsidian') ctx.stdout('  用法: 把该目录作为 vault 在 Obsidian 中打开')
  if (format === 'html') ctx.stdout('  提示: 可直接在浏览器打开，或经控制台「知识图谱」页预览')
  return 0
}

/**
 * `prism kb sync <项目名|项目根> [--enqueue] [--book] [--module] [--dry-run]`
 *
 * 扫描项目文档建「引用型」索引（design-knowledge-model-v1 §4）：
 * - 参数是已登记的项目名 → 从台账取根目录并回写扫描时间；是路径 → 直接扫（需 --owner）；
 * - `--dry-run` 只报告发现与转换结果，不落库（验证用）；
 * - `--enqueue` 给每条新建/更新的条目投富化任务（宿主执行，Prism 零 LLM）。
 */
async function kbSync(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const target = args[0]
  if (target === undefined) {
    ctx.stderr(
      '用法: prism kb sync <项目名|项目根> [--owner <名>] [--book <书>] [--module <模块>] [--enqueue] [--dry-run]',
    )
    return 1
  }

  const registry = new ProjectRegistry(ctx.home ?? prismPaths().home)
  let root: string
  let projectName: string
  let owner = values.owner !== undefined ? String(values.owner) : undefined

  // 先按项目名解析；失败则当路径处理
  try {
    const info = await registry.get(target)
    root = info.root
    projectName = info.project
    owner = owner ?? info.project
  } catch {
    root = resolve(target)
    projectName = basename(root)
    owner = owner ?? projectName
  }

  try {
    await access(root)
  } catch {
    ctx.stderr(`错误 [bad_request] 目录不存在: ${root}`)
    return 1
  }

  const dryRun = values['dry-run'] === true
  const realKb = await getKb(ctx)
  const report = await scanProject(
    dryRun ? makeDryRunKb(realKb) : realKb,
    {
      root,
      layer: 'project',
      owner,
      ...(values.book !== undefined ? { book: String(values.book) } : {}),
      ...(values.module !== undefined ? { module: String(values.module) } : {}),
    },
  )

  // 入队富化任务（宿主执行；Prism 只投递）
  if (values.enqueue === true && !dryRun) {
    const persistence = openPersistence({ home: ctx.home ?? prismPaths().home })
    try {
      const queue = new WorkQueue({ persistence })
      for (const file of report.files) {
        if (file.status !== 'indexed') continue
        const created = await queue.enqueue({
          kind: 'extract_entities',
          payload: {
            source: file.rel,
            path: file.abs,
            hash: file.source_hash,
            entry_id: idFromRel(file.rel),
            owner,
          },
          priority: 0,
        })
        report.enqueued.push(created.id)
      }
    } finally {
      persistence.close()
    }
    await registry.markScanned(projectName, report.discovered)
  } else if (!dryRun) {
    await registry.markScanned(projectName, report.discovered)
  }

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: report }))
    return 0
  }

  ctx.stdout(`扫描 ${report.root}`)
  ctx.stdout(
    `  发现 ${report.discovered} 个可处理文件 → 新建 ${report.created} · 更新 ${report.updated} · 未变 ${report.unchanged} · 跳过 ${report.skipped}`,
  )
  if (report.truncated) ctx.stdout('  ⚠ 已达文件数上限，结果被截断（可调 --max-files 或分批扫描）')
  if (report.unreadable.length > 0) {
    ctx.stdout(`  ⚠ ${report.unreadable.length} 个目录不可读（已跳过）：${report.unreadable.slice(0, 3).join('；')}`)
  }
  if (report.missing.length > 0) {
    ctx.stdout(
      `  ⚠ ${report.missing.length} 条索引的源文件已不存在（索引保留）：${report.missing.slice(0, 5).join(', ')}${report.missing.length > 5 ? ' …' : ''}`,
    )
  }
  if (report.enqueued.length > 0) {
    ctx.stdout(`  已入队 ${report.enqueued.length} 个富化任务（宿主经 prism_work_pending 领取）`)
  }
  if (dryRun) ctx.stdout('  [dry-run] 未落库')
  for (const file of report.files.filter((f) => f.status === 'skipped').slice(0, 10)) {
    ctx.stdout(`  SKIP ${file.rel}: ${file.reason ?? '未知'}`)
  }
  return 0
}

/**
 * dry-run 包装：`index()` 只查不写——已存在且源哈希相同 → unchanged；
 * 否则报告 created/updated 但不落库。转换仍真实执行（验证 anydoc 能否处理）。
 */
function makeDryRunKb(real: KnowledgeService): KnowledgeService {
  // 用 Object.create 保留原型方法（class 实例的方法不在自有属性上，展开会丢）
  const wrapper = Object.create(real) as KnowledgeService
  wrapper.index = async (input) => {
    const existing = await real.get(input.id)
    if (existing !== null) {
      const prev = existing.source_hash
      return {
        id: input.id,
        action: prev === input.source_hash ? ('unchanged' as const) : ('updated' as const),
      }
    }
    return { id: input.id, action: 'created' as const }
  }
  return wrapper
}

/**
 * `prism kb remove <id> [--hard] [--yes]`
 * 软删（默认）：置 deprecated，保留审计；硬删需 --hard 且无引用。
 */
async function kbRemove(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    ctx.stderr('用法: prism kb remove <id> [--hard] [--yes]')
    return 1
  }
  const kb = await getKb(ctx)
  if (kb.remove === undefined) {
    ctx.stderr('错误 [unsupported] 当前知识服务未实现 remove')
    return 1
  }
  const hard = values.hard === true
  if (hard && values.yes !== true) {
    ctx.stderr(`硬删会永久删除条目 ${id} 的所有版次与文件，确认请加 --yes`)
    return 1
  }
  try {
    const result = await kb.remove(id, { hard })
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ok: true, value: result }))
    } else if (result.mode === 'soft') {
      ctx.stdout(`已软删 ${id}（status=deprecated，保留审计；被 ${result.references} 条边引用）`)
    } else {
      ctx.stdout(`已硬删 ${id}（版次行、边、文件均已移除）`)
    }
    return 0
  } catch (error) {
    if (error instanceof PrismError) {
      ctx.stderr(`错误 [${error.code}] ${error.message}`)
      return 1
    }
    throw error
  }
}

/** `prism kb reindex`：以文件为真相重建索引（Z2；手工编辑/迁移知识文件后收敛漂移）。 */async function kbReindex(ctx: CommandContext): Promise<number> {  const kb = await getKb(ctx)
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
