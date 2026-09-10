import { basename, resolve } from 'node:path'
import { readFile, access, writeFile } from 'node:fs/promises'

import { splitFrontmatter, type FrontmatterData } from '@prism/knowledge'
import {
  convertFileToMarkdown,
  writeEnrichment,
  ENTRY_TYPES,
  ProjectRegistry,
  ScanHistory,
  loadKnowledgeService,
  exportKnowledgeGraph,
  makeDryRunKb,
  scanProject,
  type KnowledgeService,
} from '@prism/server'
import { PrismError, prismPaths } from '@prism/core'

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
    case 'restore':
      return await kbRestore(ctx, rest)
    case 'conflicts':
      return await kbConflicts(ctx, values)
    case 'resolve':
      return await kbResolve(ctx, rest)
    case 'history':
      return await kbHistory(ctx, rest, values)
    case 'export':
      return await kbExport(ctx, rest, values)
    case 'convert':
      return await kbConvert(ctx, rest, values)
    case 'enrich':
      return await kbEnrich(ctx, rest, values)
    default:
      ctx.stderr(
        `用法: prism kb <import|sync|remove|search|get|tree|stats|graph|path|export|reindex|convert|enrich> ...`,
      )
      return 1
  }
}

/**
 * `prism kb convert <file> [--out <path>] [--max-chars N]`
 * 把任意文档转成 Markdown（本地 anydoc 转换，零 LLM）。默认打印到 stdout；--out 写文件。
 */
async function kbConvert(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const file = args[0]
  if (file === undefined) {
    ctx.stderr('用法: prism kb convert <file> [--out <path>] [--max-chars N]')
    return 1
  }
  const result = await convertFileToMarkdown(resolve(file), {
    ...(values['max-chars'] !== undefined ? { maxChars: Number(values['max-chars']) } : {}),
  })
  if (values.out !== undefined) {
    await writeFile(resolve(String(values.out)), result.markdown, 'utf-8')
    if (ctx.json) {
      ctx.stdout(
        JSON.stringify({
          ok: true,
          value: {
            status: result.status,
            path: result.path,
            out: resolve(String(values.out)),
            chars: result.markdown.length,
            truncated: result.truncated ?? false,
          },
        }),
      )
    } else {
      ctx.stdout(`已转换 ${result.path} → ${resolve(String(values.out))}（${result.status}，${result.markdown.length} 字）`)
    }
    return 0
  }
  // 无 --out：Markdown 打到 stdout（便于管道）；--json 时走信封
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { status: result.status, chars: result.markdown.length, markdown: result.markdown } }))
  } else {
    ctx.stdout(result.markdown)
  }
  return result.status === 'failed' || result.status === 'unsupported' ? 1 : 0
}

/**
 * `prism kb enrich <kind> --payload <json> --result <json> [--by <who>]`
 * 回写一次富化结果（工作队列已移除，改为直付）。
 */
async function kbEnrich(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const kind = args[0]
  if (kind === undefined || !['summarize', 'classify', 'extract_entities', 'diagram_ir'].includes(kind)) {
    ctx.stderr('用法: prism kb enrich <summarize|classify|extract_entities|diagram_ir> --payload <json> --result <json> [--by <who>]')
    return 1
  }
  const parse = (raw: string | undefined, name: string): Record<string, unknown> | undefined => {
    if (raw === undefined) return undefined
    try {
      const v: unknown = JSON.parse(raw)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('必须是对象')
      return v as Record<string, unknown>
    } catch (error) {
      ctx.stderr(`--${name} 不是合法 JSON 对象: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  const payload = parse(values.payload, 'payload')
  const result = parse(values.result, 'result')
  if (payload === undefined || result === undefined) return 1
  if (kind === 'diagram_ir') {
    ctx.stdout('diagram_ir 不回写知识库；用 prism arch render 消费该 IR')
    return 0
  }
  const report = await writeEnrichment(
    await getKb(ctx),
    { kind, payload, result },
    values.by !== undefined ? { deposited_by: { subject: String(values.by) } } : {},
  )
  if (ctx.json) ctx.stdout(JSON.stringify({ ok: true, value: report }))
  else ctx.stdout(report === null ? '（无回写动作）' : `回写 ${report.kind}: ${report.action} — ${report.detail}`)
  return 0
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
  } else if (result.action === 'unchanged') {
    ctx.stdout(`${result.id}@v${result.version} 内容未变，跳过（不产生新版次）`)
  } else {
    const verb = result.action === 'created' ? '已落库' : '已更新'
    ctx.stdout(`${verb} ${result.id}@v${result.version} → ${result.path}`)
  }
  return 0
}

async function kbSearch(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const q = args[0]
  if (q === undefined || q.trim() === '') {
    ctx.stderr('用法: prism kb search <query> [--layer --owner --book --module --visibility --limit]')
    return 1
  }
  const kb = await getKb(ctx)
  const visibilities =
    values.visibility !== undefined
      ? (String(values.visibility)
          .split(',')
          .map((v) => v.trim())
          .filter((v): v is 'global' | 'project' | 'role' => ['global', 'project', 'role'].includes(v)))
      : undefined
  const results = await kb.search({
    q: q.trim(),
    layers: values.layer !== undefined ? [values.layer as 'global' | 'project' | 'role'] : undefined,
    owner: values.owner,
    book: values.book,
    module: values.module,
    limit: values.limit !== undefined ? Number(values.limit) : undefined,
    // 变更 2：`--no-embedding` 强制纯 BM25（调试/对照用）
    ...(values['no-embedding'] === true ? { hybrid: false } : {}),
    ...(visibilities !== undefined && visibilities.length > 0 ? { visibilities } : {}),
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
 * `prism kb sync <项目名|项目根> [--book] [--module] [--dry-run]`
 *
 * 扫描项目文档建「引用型」索引（design-knowledge-model-v1 §4）：
 * - 参数是已登记的项目名 → 从台账取根目录并回写扫描时间；是路径 → 直接扫（需 --owner）；
 * - `--dry-run` 只报告发现与转换结果，不落库（验证用）。
 *   富化（实体抽取等）由宿主另经 MCP `prism_kb_enrich` 直接回写（工作队列已移除）。
 */
async function kbSync(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const target = args[0]
  if (target === undefined) {
    ctx.stderr(
      '用法: prism kb sync <项目名|项目根> [--owner <名>] [--book <书>] [--module <模块>] [--dry-run]',
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

  if (!dryRun) {
    await registry.markScanned(projectName, report.discovered)
  }

  // 扫描历史落盘（append-only JSONL；报告不再「输出即焚」）
  if (!dryRun) {
    await new ScanHistory(ctx.home ?? prismPaths().home).append({
      project: projectName,
      root: report.root,
      scanned_at: new Date().toISOString(),
      discovered: report.discovered,
      created: report.created,
      updated: report.updated,
      unchanged: report.unchanged,
      skipped: report.skipped,
      missing: report.missing,
      unreadable: report.unreadable,
      truncated: report.truncated,
    })
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
  if (dryRun) ctx.stdout('  [dry-run] 未落库')
  for (const file of report.files.filter((f) => f.status === 'skipped').slice(0, 10)) {
    ctx.stdout(`  SKIP ${file.rel}: ${file.reason ?? '未知'}`)
  }
  return 0
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

/**
 * `prism kb restore <id>`
 * 恢复软删条目（deprecated → active）；幂等。
 */
async function kbRestore(ctx: CommandContext, args: string[]): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    ctx.stderr('用法: prism kb restore <id>')
    return 1
  }
  const kb = await getKb(ctx)
  if (kb.restore === undefined) {
    ctx.stderr('错误 [unsupported] 当前知识服务未实现 restore')
    return 1
  }
  try {
    const result = await kb.restore(id)
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ok: true, value: result }))
    } else {
      ctx.stdout(result.restored ? `已恢复 ${id}（status=active）` : `${id} 本就未软删（status=active，未改动）`)
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

/**
 * `prism kb conflicts [--all]`
 * 列出层间冲突（默认只列未处理的；--all 含已处理）。
 */
async function kbConflicts(ctx: CommandContext, values: ArgValues): Promise<number> {
  const kb = await getKb(ctx)
  if (kb.conflicts === undefined) {
    ctx.stderr('错误 [unsupported] 当前知识服务未实现 conflicts')
    return 1
  }
  const list = await kb.conflicts({ includeResolved: values.all === true })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: list }))
    return 0
  }
  if (list.length === 0) {
    ctx.stdout('（没有层间冲突）')
    return 0
  }
  for (const c of list) {
    const mark = c.resolved ? '已处理' : '未处理'
    ctx.stdout(`[${mark}] ${c.kind}  ${c.high_id}  ⟷  ${c.low_id}   (${c.detected_at})`)
    ctx.stdout(`        ${c.id}`)
  }
  ctx.stdout(`共 ${list.length} 条`)
  return 0
}

/** `prism kb resolve <conflict-id>`：标记冲突已处理。 */
async function kbResolve(ctx: CommandContext, args: string[]): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    ctx.stderr('用法: prism kb resolve <conflict-id>')
    return 1
  }
  const kb = await getKb(ctx)
  if (kb.resolveConflict === undefined) {
    ctx.stderr('错误 [unsupported] 当前知识服务未实现 resolveConflict')
    return 1
  }
  const resolved = await kb.resolveConflict(id)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { id, resolved } }))
  } else if (resolved) {
    ctx.stdout(`已标记冲突 ${id} 为已处理`)
  } else {
    ctx.stderr(`错误 [not_found] 冲突不存在: ${id}`)
    return 1
  }
  return resolved ? 0 : 1
}

/**
 * `prism kb history [项目名] [--limit N]`
 * 查看扫描历史（含孤儿索引明细）——报告不再输出即焚。
 */
async function kbHistory(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const project = args[0]
  const limit = values.limit !== undefined ? Number(values.limit) : 20
  const history = new ScanHistory(ctx.home ?? prismPaths().home)
  const list = await history.list(project, Number.isFinite(limit) ? limit : 20)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: list }))
    return 0
  }
  if (list.length === 0) {
    ctx.stdout(project !== undefined ? `（${project} 没有扫描历史）` : '（还没有扫描历史）')
    return 0
  }
  for (const r of list) {
    ctx.stdout(
      `${r.scanned_at.replace('T', ' ').slice(0, 19)}  ${r.project}  ` +
        `发现 ${r.discovered} → 新建 ${r.created} · 更新 ${r.updated} · 未变 ${r.unchanged} · 跳过 ${r.skipped}`,
    )
    if (r.missing.length > 0) {
      ctx.stdout(`  ⚠ 孤儿索引 ${r.missing.length} 条: ${r.missing.slice(0, 5).join(', ')}${r.missing.length > 5 ? ' …' : ''}`)
    }
    if (r.unreadable.length > 0) {
      ctx.stdout(`  ⚠ 不可读目录 ${r.unreadable.length} 个`)
    }
  }
  ctx.stdout(`共 ${list.length} 条记录 · ${history.path}`)
  return 0
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
