import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'

import { buildSequenceIr, buildTeamWorkflowIr, normalizeGraph } from '@prism/agents'
import { PrismError } from '@prism/core'

import { loadTeam, teamNotFoundMessage } from '../../roles/index.js'
import { ok, type Envelope } from '../envelope.js'
import {
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_TYPE_LABELS,
  artifactStat,
  irTitle,
  isInside,
  readArtifactMeta,
  readIrCopy,
  renderDiagram,
  validateDiagram,
  writeArtifactMeta,
  type ArchifyDiagramType,
} from '../../graph/archify.js'
import {
  globalArchDir,
  projectArchDir,
  resolveArchPlacement,
  sanitizeArtifactName,
} from '../../graph/arch-placement.js'
import { ProjectRegistry } from '../../graph/registry.js'
import { readCodeGraph } from '../../graph/graphify.js'
import type { RouteContext } from '../router.js'

export interface ArchDeps {
  /** PRISM_HOME：**全局源**产物落 `<home>/archify/<type>/`；注册表读 `<home>/graph/projects.json` */
  home: string
  /** 团队受管目录（F-C4 `from-team` 读团队定义；与 CLI 同源） */
  teamsDir: string
  /** 角色受管目录（团队成员的引用校验用） */
  rolesDir: string
}

/** 产物来源：`project` = 注册项目根下 `.prism/arch/`；`global` = `<home>/archify/`。 */
export type ArchArtifactSource = 'project' | 'global'

/**
 * 产物列表项（带来源与作用域，供界面按书/模块过滤、按来源分组）。
 *
 * **逐字段冻结（v9 F1 §2，前端契约）**：`type, name, bytes, mtime, title?, layer?, owner?,
 * book?, module?, archify_version?, has_ir, source, project?, preview, ir`。
 * `preview`/`ir` 由**服务端构造**（项目源带 `?project=` 限定）——前端不拼路径。
 * **身份键 = `(type, name, source, project)`**：同一张图可同时存在于项目源与全局源。
 */
export interface ArchArtifact {
  type: string
  name: string
  bytes: number
  mtime: string
  /** 图标题（sidecar → IR meta.title → 不下发；缺 sidecar 的历史产物靠 IR 兜底） */
  title?: string
  layer?: string
  owner?: string
  book?: string
  module?: string
  /** 渲染器版本（sidecar） */
  archify_version?: string
  /** IR 是否可读（同目录 <name>.ir.json 存在） */
  has_ir: boolean
  /** 产物来源（双源扫描） */
  source: ArchArtifactSource
  /** 项目名（仅 `source==='project'`；项目源的身份键成分） */
  project?: string
  /** iframe 预览 URL（服务端构造，项目源带 `?project=`） */
  preview: string
  /** IR/元数据 URL（同上） */
  ir: string
}

/** 一个候选产物源。 */
interface ArtifactSource {
  /** 该源下 <type> 产物目录 */
  root: string
  source: ArchArtifactSource
  project?: string
}

/** 命中唯一产物后的解析结果。 */
interface ResolvedArtifact {
  htmlPath: string
  source: ArchArtifactSource
  project?: string
}

/** 图类型守卫。 */
function assertType(raw: string): asserts raw is ArchifyDiagramType {
  if (!ARCHIFY_DIAGRAM_TYPES.includes(raw as never)) {
    throw new PrismError('bad_request', `非法图类型: ${raw}`, { allowed: ARCHIFY_DIAGRAM_TYPES })
  }
}

/** 产物文件名守卫（防穿越：只允许单段 `<name>.html`）。 */
function assertArtifactFile(file: string): void {
  if (!/^[A-Za-z0-9_.-]+\.html$/.test(file)) {
    throw new PrismError('bad_request', `非法文件名: ${file}`)
  }
}

/** 本地时间戳 `yyyyMMdd-HHmmss`（与 `init` / 回收站目录名同口径）。 */
function localStamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/**
 * `from-graph` 分支的产物名：`sequence-<消毒 id>-<yyyyMMdd-HHmmss>-<短哈希>`。
 *
 * **短哈希不是装饰**：节点 id 可以全是 CJK（`sanitizeArtifactName` 会把它们逐字换成 `_`），
 * 两个不同节点在同一秒内导出就会撞成同一个文件名而**静默互相覆盖**；哈希取的是**原始 id**，
 * 故消毒后同名的不同 id 仍然可区分。
 */
function sequenceArtifactName(nodeId: string): string {
  const safeId = sanitizeArtifactName(nodeId, 'node')
  const hash = createHash('sha256').update(nodeId).digest('hex').slice(0, 8)
  return `sequence-${safeId}-${localStamp()}-${hash}`
}

/**
 * 架构图谱路由（knowledge-base.md §4.4 / D10）：
 * - GET  /api/arch/types              五类图清单
 * - GET  /api/arch/diagrams           已渲染产物列表（**双源**：项目 `.prism/arch/` + `<home>/archify/`）
 * - POST /api/arch/validate           校验 IR（body: { type, ir }）
 * - POST /api/arch/render             渲染并落盘（body: { type, ir, name?, project?, book?, module? }）；
 *                                     `mode: 'from-graph'` 时**不收 ir**，由服务端读图谱自组 IR
 *                                     （F5：body: { mode, type:'sequence', project, node }）
 * - POST /api/arch/from-team          由**团队工作流**生成并渲染（body: { team_id, name? }，F-C4）
 * - GET  /api/arch/preview/:type/:file  取渲染产物 HTML（iframe 预览；防穿越；可选 `?project=`）
 * - GET  /api/arch/ir/:type/:file       取产物 IR 源与 sidecar（同上）
 * 渲染器为 vendored 子工程 3rd/archify（MIT v2.16.0），Prism 只编排。
 *
 * 落盘口径（v9 F1）：project 派生三类图给 `project` → 落注册项目根下 `.prism/arch/<type>/`；
 * workflow/lifecycle（及未给 project 的裸 render）落全局 `<home>/archify/<type>/`。详见
 * `graph/arch-placement.ts`。
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
  const types = async (): Promise<Envelope> =>
    ok(ARCHIFY_DIAGRAM_TYPES.map((type) => ({ type, label: ARCHIFY_TYPE_LABELS[type] })))

  /**
   * 候选产物源：
   * - 给了 `?project=` → **仅**该项目源（不存在/未注册 → 抛错，**不回落全局**）；
   * - 未给 → 全局源 + 各注册项目源（同名命中多个 → 由 `resolveArtifact` 判歧义）。
   */
  const artifactSources = async (type: ArchifyDiagramType, project: string | null): Promise<ArtifactSource[]> => {
    const registry = new ProjectRegistry(deps.home)
    if (project !== null && project !== '') {
      const info = await registry.get(project) // 未注册 → not_found
      return [{ root: projectArchDir(info.root, type), source: 'project', project: info.project }]
    }
    const projects = await registry.list()
    return [
      ...projects.map(
        (item): ArtifactSource => ({
          root: projectArchDir(item.root, type),
          source: 'project',
          project: item.project,
        }),
      ),
      { root: globalArchDir(deps.home, type), source: 'global' },
    ]
  }

  /**
   * 解析**唯一**产物路径。
   *
   * 为什么歧义要拒绝而不是「先项目后全局」：默认产物名 = 图类型（`render` 的 name 回落），
   * 于是「多项目 + 全局各有 `<type>.html`」是**默认路径而非边缘**；命中顺序随注册序偶然，
   * 静默择一会让预览指向随机的另一张图（v9.1 A-1）。
   */
  const resolveArtifact = async (
    type: ArchifyDiagramType,
    file: string,
    project: string | null,
  ): Promise<ResolvedArtifact> => {
    const matches: ResolvedArtifact[] = []
    for (const source of await artifactSources(type, project)) {
      const root = resolve(source.root)
      const target = resolve(join(root, file))
      if (!isInside(root, target)) {
        throw new PrismError('bad_request', '路径越界')
      }
      try {
        const info = await stat(target)
        if (!info.isFile()) continue
      } catch {
        continue
      }
      matches.push({
        htmlPath: target,
        source: source.source,
        ...(source.project !== undefined ? { project: source.project } : {}),
      })
    }
    if (matches.length === 0) {
      throw new PrismError(
        'not_found',
        project !== null && project !== ''
          ? `该产物在项目源内不存在: ${project}/${type}/${file}`
          : `渲染产物不存在: ${type}/${file}`,
      )
    }
    if (matches.length > 1) {
      const where = matches.map((m) => m.project ?? 'global').join('、')
      throw new PrismError('bad_request', `同名产物命中多个来源（${where}）；请加 ?project= 指定`, {
        type,
        file,
        sources: matches.map((m) => m.project ?? 'global'),
      })
    }
    return matches[0]!
  }

  /**
   * 双源扫描。**扫 `*.html` + 读 sidecar**（不是扫 `*.meta.json`）：
   * 历史产物（MCP 链路 2026-09 前不写 sidecar）没有 meta，按 meta 扫会让它们**静默消失**
   * ——违反 R-v9-2「存量不迁移、旧产物照常可见」。缺 meta 时 title 回落 IR meta.title，
   * 时间/字节取文件 stat。
   */
  const diagrams = async (ctx: RouteContext): Promise<Envelope> => {
    const { readdir } = await import('node:fs/promises')
    // 过滤条件：?book=&module=（module 为空串表示只看「待归类」）——两源同口径
    const bookFilter = ctx.query.get('book')
    const moduleFilter = ctx.query.get('module')
    const registry = new ProjectRegistry(deps.home)
    const projects = await registry.list()
    const out: ArchArtifact[] = []
    for (const type of ARCHIFY_DIAGRAM_TYPES) {
      const sources: ArtifactSource[] = [
        ...projects.map(
          (item): ArtifactSource => ({
            root: projectArchDir(item.root, type),
            source: 'project',
            project: item.project,
          }),
        ),
        { root: globalArchDir(deps.home, type), source: 'global' },
      ]
      for (const source of sources) {
        let entries: string[]
        try {
          entries = await readdir(source.root)
        } catch {
          continue // 目录不存在（root 未建图/已被清理）→ 该源为空，不是错误
        }
        for (const entry of entries) {
          if (!entry.endsWith('.html')) continue
          const full = join(source.root, entry)
          let info
          try {
            info = await stat(full)
          } catch {
            continue
          }
          if (!info.isFile()) continue
          const meta = await readArtifactMeta(full)
          // sidecar 缺 title（或整份缺失）才去读 IR——省掉绝大多数条目的额外读盘
          const irValue = meta?.title !== undefined ? null : await readIrCopy(full)
          const title = meta?.title ?? (irValue !== null ? irTitle(irValue) : undefined)
          const suffix =
            source.project !== undefined ? `?project=${encodeURIComponent(source.project)}` : ''
          out.push({
            type,
            name: entry,
            bytes: info.size,
            mtime: info.mtime.toISOString(),
            ...(title !== undefined ? { title } : {}),
            ...(meta?.layer !== undefined ? { layer: meta.layer } : {}),
            ...(meta?.owner !== undefined ? { owner: meta.owner } : {}),
            ...(meta?.book !== undefined ? { book: meta.book } : {}),
            ...(meta?.module !== undefined ? { module: meta.module } : {}),
            ...(meta?.archify_version !== undefined ? { archify_version: meta.archify_version } : {}),
            has_ir: (await artifactStat(full.replace(/\.html$/i, '.ir.json'))) !== null,
            source: source.source,
            ...(source.project !== undefined ? { project: source.project } : {}),
            preview: `/api/arch/preview/${type}/${entry}${suffix}`,
            ir: `/api/arch/ir/${type}/${entry}${suffix}`,
          })
        }
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

  /**
   * F5（v10）**由图谱查询结果导出时序图**——服务端自组 IR 的分支，与「调用方自备 `ir`」互斥。
   *
   * 为什么必须服务端组 IR：`buildSequenceIr` 的输入是**全图 CodeGraph + rootFile**
   * （`graph-ir.ts:677`），而前端持有的 relations 是**单跳 items**，组不出链。故调用方只给
   * 「项目 + 起点节点 id」，其余由服务端做。
   *
   * 契约（钉死）：
   * - **按节点 id 精确寻址**（复用 `resolveGraphNode` 的①档语义，**不落** label 前缀档）——
   *   本仓 159/2063 个 label 跨多文件，按符号名取 `source_file` 会**静默选错根文件**；
   * - `rootFile` = 命中节点的 `source_file`（反斜杠按生成器 `fileOf` 同口径归一，否则匹配不上
   *   calls 边的文件键）；
   * - 三类失败都映射 `bad_request`：节点 id 解析不到 /「图谱没有跨文件 calls 边」/
   *   「指定的根文件没有跨文件调用边」（后者是**高频路径**——本仓 27.6% 节点所在文件在调用图里
   *   没有跨文件 calls 边，文案必须让用户看懂**换起点**）。⚠ 生成器原文里「改用
   *   architecture/dataflow」是图集/CLI 侧的出路，本入口（`mode=from-graph` 只支持
   *   `type=sequence`）照做只会再吃 400，故在下面 catch 里改写为可行动指引
   *   （重建图 / 换起点符号；判别词「图谱没有跨文件 calls 边」保留，web 按它分派文案）；
   * - 产物落**项目源** `<projectRoot>/.prism/arch/sequence/`，**不落全局** `<home>/archify/`
   *   （否则 arch 页双源列表长期堆积无归属产物）。
   *
   * 口径声明：产物语义是「**该符号所在文件**的跨文件调用邻域」（参与者 = 文件、消息 =
   * 跨文件 calls 边），**可能不含该符号本身**；IR `meta.subtitle` 由生成器恒写「根 = 调用图
   * 度数最高的文件」，本分支显式指定了 rootFile，故渲染前**覆写**为实际根文件。
   */
  const renderFromGraph = async (
    body: Record<string, unknown>,
    type: ArchifyDiagramType,
  ): Promise<Envelope> => {
    if (type !== 'sequence') {
      throw new PrismError('bad_request', `mode=from-graph 只支持 type=sequence（收到 ${type}）`)
    }
    const project = typeof body['project'] === 'string' ? body['project'].trim() : ''
    if (project === '') {
      throw new PrismError('bad_request', '缺少 project（已注册的项目名）')
    }
    const nodeId = typeof body['node'] === 'string' ? body['node'].trim() : ''
    if (nodeId === '') {
      throw new PrismError('bad_request', '缺少 node（图谱节点 id；四模式查询结果的 other）')
    }

    const name = sequenceArtifactName(nodeId)
    // 落点解析**先于**读图谱：未注册 → not_found；已注册但 root 被删/被挪 → project_root_missing
    // （绝不 mkdir 复活，v9.1 B-1）。
    const placement = await resolveArchPlacement({ type, home: deps.home, name, project })
    const projectName = placement.project ?? project
    if (placement.root === undefined) {
      throw new PrismError('bad_request', `项目 ${projectName} 没有可用的项目根，无法由图谱导出`)
    }
    // 每请求读一次 graph.json（与 MCP/CLI `from-graph` 同一读取器，无缓存层）
    const graph = await readCodeGraph(placement.root)
    const { nodes } = normalizeGraph(graph)
    const hit = nodes.find((node) => node.id === nodeId)
    if (hit === undefined) {
      throw new PrismError(
        'bad_request',
        `图谱中没有节点 id: ${nodeId}（请用图谱查询结果里的 other 字段，不要用符号名）`,
        { project: projectName, node: nodeId },
      )
    }
    const rawFile = typeof hit.source_file === 'string' ? hit.source_file.trim() : ''
    if (rawFile === '') {
      throw new PrismError('bad_request', `节点 ${nodeId} 没有 source_file，无法定位根文件`, {
        project: projectName,
        node: nodeId,
      })
    }
    const rootFile = rawFile.replace(/\\/g, '/')
    const label = typeof hit.label === 'string' && hit.label.trim() !== '' ? hit.label.trim() : nodeId

    let ir: ReturnType<typeof buildSequenceIr>
    try {
      ir = buildSequenceIr(graph, { title: `${projectName} · ${label} 调用链`, rootFile })
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      // 两条生成器抛错都要落到**本入口真能执行**的出路（code-review-v10 §1 P2-2）：
      // `graph-ir.ts:702` 的原文建议「改用 architecture/dataflow」——那是图集/CLI 侧的出路；
      // 本入口是 `mode=from-graph`（只支持 `type=sequence`），用户照做只会再吃一个 400。
      // 故第一条改为重写（保留判别词「图谱没有跨文件 calls 边」，web 的
      // `sequenceExportErrorKey` 按它分派），第二条沿用既有的追加式提示。
      const message = raw.includes('指定的根文件没有跨文件调用边')
        ? `${raw}；该文件在调用图里没有跨文件 calls 边，请换一个起点符号`
        : raw.includes('图谱没有跨文件 calls 边')
          ? '图谱没有跨文件 calls 边，无法派生时序图：本入口只从图谱的跨文件 calls 边派生调用链，' +
            '请先 prism graph build 重建图，或换一个在调用图里有跨文件 calls 边的起点符号'
          : raw
      throw new PrismError('bad_request', message, {
        project: projectName,
        node: nodeId,
        root_file: rootFile,
      })
    }
    // 覆写 subtitle：生成器恒写「根 = 调用图度数最高的文件」，本分支的根是显式指定的
    const rendered = {
      ...ir,
      meta: {
        ...ir.meta,
        subtitle:
          `代码图谱派生（Graphify ${nodes.length} 节点）｜ 根 = ${rootFile}` +
          `（由指定符号所在文件指定，非默认口径）；参与者 = 文件，消息 = 跨文件 calls 边（BFS 顺序）`,
      },
    }

    await mkdir(placement.dir, { recursive: true })
    const htmlPath = placement.htmlPath
    // 渲染前 archify 会先校验，不过直接抛（不产出坏图）
    await renderDiagram(type, rendered, htmlPath)
    const irCopy = htmlPath.replace(/\.html$/i, '.ir.json')
    await writeFile(irCopy, `${JSON.stringify(rendered, null, 2)}\n`, 'utf-8')
    const scope = {
      ...(typeof body['layer'] === 'string' ? { layer: body['layer'] } : {}),
      ...(typeof body['owner'] === 'string' ? { owner: body['owner'] } : {}),
      ...(typeof body['book'] === 'string' ? { book: body['book'] } : {}),
      ...(typeof body['module'] === 'string' ? { module: body['module'] } : {}),
    }
    const meta = await writeArtifactMeta(htmlPath, rendered, scope)
    const info = await stat(htmlPath)
    return ok({
      type,
      project: projectName,
      node: nodeId,
      root: placement.root,
      root_file: rootFile,
      name: `${name}.html`,
      /** 产物相对**项目根**的路径（正斜杠，便于界面直接拼 / 展示） */
      relative_path: relative(placement.root, htmlPath).split(sep).join('/'),
      bytes: info.size,
      preview: `/api/arch/preview/${type}/${name}.html?project=${encodeURIComponent(projectName)}`,
      ir: irCopy,
      meta,
      source: 'project',
    })
  }

  const render = async (ctx: RouteContext): Promise<Envelope> => {
    const body = (await ctx.body()) as Record<string, unknown>
    const type = String(body['type'] ?? '')
    assertType(type)
    // F5：服务端自组 IR 的分支（调用方只给 项目 + 节点 id），与「自备 ir」互斥
    const mode = typeof body['mode'] === 'string' ? body['mode'].trim() : ''
    if (mode === 'from-graph') {
      return await renderFromGraph(body, type)
    }
    if (mode !== '') {
      throw new PrismError('bad_request', `未知 mode: ${mode}（可用: from-graph）`)
    }
    if (body['ir'] === undefined) {
      throw new PrismError('bad_request', '缺少 ir（JSON-IR 对象）')
    }
    const name = sanitizeArtifactName(
      typeof body['name'] === 'string' ? body['name'] : undefined,
      type,
    )
    const project = typeof body['project'] === 'string' ? body['project'].trim() : ''
    // 落点：project 派生三类图给了 project → 项目内 `.prism/arch/`；否则全局。
    // （本面**不接任意 `out` 路径**——那会新增一个经 HTTP 的任意写入口；`out` 的
    //  「完全接管」语义只在 MCP/CLI 两面存在，语义见 arch-placement.ts。）
    const placement = await resolveArchPlacement({
      type,
      home: deps.home,
      name,
      ...(project !== '' ? { project } : {}),
    })
    await mkdir(placement.dir, { recursive: true })
    const htmlPath = placement.htmlPath
    await renderDiagram(type, body['ir'], htmlPath)
    const irCopy = htmlPath.replace(/\.html$/i, '.ir.json')
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
    const suffix =
      placement.project !== undefined ? `?project=${encodeURIComponent(placement.project)}` : ''
    return ok({
      type,
      name: `${name}.html`,
      bytes: info.size,
      preview: `/api/arch/preview/${type}/${name}.html${suffix}`,
      ir: irCopy,
      meta,
      source: placement.project !== undefined ? 'project' : 'global',
      ...(placement.project !== undefined ? { project: placement.project } : {}),
    })
  }

  /**
   * 由团队工作流生成工作流图（F-C4）：`buildTeamWorkflowIr`（agents 包纯函数）→ archify 渲染。
   *
   * 只落 `<home>/archify/workflow/`（同 `render` 的全局分支），**不接任意输出路径**；
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
    const dir = globalArchDir(deps.home, type)
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
      source: 'global',
    })
  }

  /**
   * 取产物 IR 源（`<name>.ir.json`）与 sidecar 元数据，供界面「IR / 元数据」子标签展示。
   * 可选 `?project=` 限定项目源（同 `preview`）。
   */
  const ir = async (ctx: RouteContext): Promise<Envelope> => {
    const type = ctx.params.type ?? ''
    const file = ctx.params.file ?? ''
    assertType(type)
    assertArtifactFile(file)
    const resolved = await resolveArtifact(type, file, ctx.query.get('project'))
    const [irValue, meta] = await Promise.all([
      readIrCopy(resolved.htmlPath),
      readArtifactMeta(resolved.htmlPath),
    ])
    if (irValue === null && meta === null) {
      throw new PrismError('not_found', `该产物没有 IR 源或元数据: ${type}/${file}`)
    }
    return ok({
      type,
      name: file,
      ir: irValue,
      meta,
      source: resolved.source,
      ...(resolved.project !== undefined ? { project: resolved.project } : {}),
    })
  }

  /**
   * 预览：双源解析（`?project=` 限定时**只**在该项目源内找，不回落全局；未给且命中多源
   * → `bad_request` 歧义拒绝），解析后仍在根内（防穿越）。
   */
  const preview = async (ctx: RouteContext): Promise<void> => {
    const type = ctx.params.type ?? ''
    const file = ctx.params.file ?? ''
    assertType(type)
    assertArtifactFile(file)
    const resolved = await resolveArtifact(type, file, ctx.query.get('project'))
    const info = await stat(resolved.htmlPath)
    const res = ctx.res
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(info.size),
      'X-Content-Type-Options': 'nosniff',
    })
    createReadStream(resolved.htmlPath).pipe(res)
  }

  return { types, diagrams, validate, render, fromTeam, ir, preview }
}

/** 读取本地 IR 文件（供上层测试/脚本复用）。 */
export async function readIrFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8')) as unknown
}
