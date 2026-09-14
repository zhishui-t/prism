/**
 * `prism arch`（knowledge-base.md §4.4）：架构图谱——五类图的校验与渲染。
 *
 * 渲染器是 vendored 子工程 `3rd/archify`（MIT v2.16.0），Prism 只做：
 *   - 调 `archify validate`（IR schema + 布局校验）
 *   - 调 `archify render` 产出**自包含 HTML**（iframe 可预览，无外部依赖）
 *   - 产物落 `<PRISM_HOME>/archify/<type>/`（IR 与 HTML 可再作为 `type: diagram` 知识条目）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  buildArchitectureIr,
  buildDataflowIr,
  buildSequenceIr,
  buildTaskLifecycleIr,
  buildTeamWorkflowIr,
} from '@prism/agents'
import { prismPaths, isPrismError } from '@prism/core'
import {
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_SCHEMA_KEYS,
  ARCHIFY_TYPE_LABELS,
  ProjectRegistry,
  loadTeam,
  readArchifySchema,
  readCodeGraph,
  renderDiagram,
  validateDiagram,
  writeArtifactMeta,
  type ArchifyDiagramType,
} from '@prism/server'

import { resolveTargetDirs, type ArgValues, type CommandContext } from '../argv.js'

/** `prism arch <types|schema|validate|render|from-team|from-graph|from-state> ...`。 */
export async function runArch(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  try {
    switch (sub) {
      case 'types':
        return archTypes(ctx)
      case 'validate':
        return await archValidate(ctx, rest)
      case 'render':
        return await archRender(ctx, rest, values)
      case 'from-team':
        return await archFromTeam(ctx, rest, values)
      case 'from-graph':
        return await archFromGraph(ctx, rest, values)
      case 'from-state':
        return await archFromState(ctx, rest, values)
      case 'schema':
        return await archSchema(ctx, rest)
      default:
        ctx.stderr(
          `用法: prism arch <types|schema|validate|render|from-team|from-graph|from-state> ...\n` +
            `  types                                   列出五类图\n` +
            `  schema <type|common>                    打印 IR 的 JSON Schema（宿主据此生成 IR）\n` +
            `  validate <type> <ir.json>               校验 IR（schema + 布局）\n` +
            `  render <type> <ir.json> [--out <html>] [--book <书>] [--module <模块>]\n` +
            `                                          渲染为自包含 HTML；--book/--module 把产物归到书内\n` +
            `  from-team <team_id> [--out <html>] [--book <书>] [--module <模块>]\n` +
            `                                          由团队工作流生成工作流图（IR 是纯函数派生物）\n` +
            `  from-graph <type> <project> [--out <html>] [--top <组件数>] [--limit <连接数>]\n` +
            `                                          由代码图谱生成 architecture|sequence|dataflow\n` +
            `  from-state [--out <html>] [--title <标题>]\n` +
            `                                          由 Prism 任务状态机生成生命周期图`,
        )
        return 1
    }
  } catch (error) {
    if (isPrismError(error)) {
      ctx.stderr(`错误 [${error.code}] ${error.message}`)
      return 1
    }
    throw error
  }
}

function archTypes(ctx: CommandContext): number {
  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        value: ARCHIFY_DIAGRAM_TYPES.map((type) => ({ type, label: ARCHIFY_TYPE_LABELS[type] })),
      }),
    )
    return 0
  }
  for (const type of ARCHIFY_DIAGRAM_TYPES) {
    ctx.stdout(`${type.padEnd(14)} ${ARCHIFY_TYPE_LABELS[type]}`)
  }
  return 0
}

/**
 * `prism arch schema <type|common>`：打印 IR 的 JSON Schema。
 *
 * 供**宿主**（拿不到 vendored 目录内部路径）按契约生成 IR——五类图里只有 workflow
 * 有内置生成器，其余四类要靠这条路径自助产出，而不是让用户手写 JSON。
 */
async function archSchema(ctx: CommandContext, args: string[]): Promise<number> {
  const key = args[0]
  if (key === undefined) {
    ctx.stderr(`错误 [bad_request] 缺少类型（可选: ${ARCHIFY_SCHEMA_KEYS.join('/')}）`)
    return 1
  }
  const schema = await readArchifySchema(key)
  ctx.stdout(ctx.json ? JSON.stringify({ ok: true, value: schema }) : JSON.stringify(schema, null, 2))
  return 0
}

/** 读 IR 文件（JSON）；失败给可读错误。 */
async function readIr(ctx: CommandContext, file: string | undefined): Promise<unknown | null> {
  if (file === undefined) {
    ctx.stderr('错误 [bad_request] 缺少 IR 文件路径（JSON）')
    return null
  }
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown
  } catch (error) {
    ctx.stderr(
      `错误 [bad_request] 读取 IR 失败: ${file}（${error instanceof Error ? error.message : String(error)}）`,
    )
    return null
  }
}

function assertType(ctx: CommandContext, type: string | undefined): type is ArchifyDiagramType {
  if (type === undefined) {
    ctx.stderr(`错误 [bad_request] 缺少图类型（可选: ${ARCHIFY_DIAGRAM_TYPES.join('/')}）`)
    return false
  }
  if (!ARCHIFY_DIAGRAM_TYPES.includes(type as ArchifyDiagramType)) {
    ctx.stderr(`错误 [bad_request] 非法图类型: ${type}（可选: ${ARCHIFY_DIAGRAM_TYPES.join('/')}）`)
    return false
  }
  return true
}

async function archValidate(ctx: CommandContext, args: string[]): Promise<number> {
  const [type, file] = args
  if (!assertType(ctx, type)) return 1
  const ir = await readIr(ctx, file)
  if (ir === null) return 1

  const result = await validateDiagram(type, ir)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: result.ok, value: result }))
    return result.ok ? 0 : 1
  }
  if (result.ok) {
    ctx.stdout(`${type}: ok（${ARCHIFY_TYPE_LABELS[type]}）`)
    return 0
  }
  ctx.stderr(`${type}: 校验未通过（${result.problems.length} 个问题）`)
  for (const problem of result.problems) {
    ctx.stderr(`  [${problem.code}] ${problem.message}${problem.fix !== undefined ? `\n      Fix: ${problem.fix}` : ''}`)
  }
  return 1
}

async function archRender(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [type, file] = args
  if (!assertType(ctx, type)) return 1
  const ir = await readIr(ctx, file)
  if (ir === null) return 1

  const home = ctx.home ?? prismPaths().home
  const outPath =
    values.out !== undefined
      ? String(values.out)
      : join(prismPaths(home).home, 'archify', type, `${type}.html`)

  const result = await renderDiagram(type, ir, outPath, {
    timeoutMs: values.timeout !== undefined ? Number(values.timeout) * 1000 : undefined,
  })

  // 同时落一份 IR 源（IR 是源、HTML 是派生，两者都可作为 diagram 条目）
  const irCopy = outPath.replace(/\.html$/i, '.ir.json')
  await writeFile(irCopy, `${JSON.stringify(ir, null, 2)}\n`, 'utf-8')

  // sidecar 元数据：作用域（--book/--module）+ 版本 + IR 哈希，让界面能按书过滤产物
  const meta = await writeArtifactMeta(outPath, ir, artifactScope(values))

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { type, html: result.htmlPath, ir: irCopy, meta } }))
  } else {
    ctx.stdout(`已渲染 ${ARCHIFY_TYPE_LABELS[type]} → ${result.htmlPath}`)
    ctx.stdout(`  IR 源: ${irCopy}`)
    if (meta.book !== undefined) {
      ctx.stdout(`  归属: ${meta.book}${meta.module !== undefined ? ` / ${meta.module}` : ''}`)
    } else {
      ctx.stdout('  归属: 未指定（加 --book <书> [--module <模块>] 可归到书内）')
    }
    ctx.stdout('  预览: prism serve 后在「知识库 → 点开书 → 架构图」查看')
  }
  return 0
}

/** 从 `--layer/--owner/--book/--module` 收集产物作用域（`arch render` / `arch from-team` 共用）。 */
function artifactScope(values: ArgValues): { layer?: string; owner?: string; book?: string; module?: string } {
  return {
    ...(values.layer !== undefined ? { layer: String(values.layer) } : {}),
    ...(values.owner !== undefined ? { owner: String(values.owner) } : {}),
    ...(values.book !== undefined ? { book: String(values.book) } : {}),
    ...(values.module !== undefined ? { module: String(values.module) } : {}),
  }
}

/**
 * 派生图落的公共尾段：渲染 → 落 IR 源 + sidecar。
 *
 * 四条 `from-*` 路径（team / graph / state）都走这里，保证产物的三件套
 * （HTML + `*.ir.json` + `*.meta.json`）口径一致；渲染前 archify 会先校验，
 * 校验不过直接失败（不产出坏图）。
 */
async function emitDerivedIr(
  values: ArgValues,
  type: ArchifyDiagramType,
  ir: unknown,
  outPath: string,
): Promise<{ html: string; ir: string; meta: unknown }> {
  await mkdir(dirname(outPath), { recursive: true })
  const result = await renderDiagram(type, ir, outPath, {
    timeoutMs: values.timeout !== undefined ? Number(values.timeout) * 1000 : undefined,
  })
  const irCopy = outPath.replace(/\.html$/i, '.ir.json')
  await writeFile(irCopy, `${JSON.stringify(ir, null, 2)}\n`, 'utf-8')
  const meta = await writeArtifactMeta(outPath, ir, artifactScope(values))
  return { html: result.htmlPath, ir: irCopy, meta }
}

/** IR 生成器抛错 → 可读的 `bad_request`（生成器不含 PrismError，故在此统一包装）。 */
function generationFailure(ctx: CommandContext, error: unknown): number {
  ctx.stderr(`错误 [bad_request] ${error instanceof Error ? error.message : String(error)}`)
  return 1
}

/**
 * `prism arch from-team <team_id>`（F-C4）：由**团队工作流**生成工作流图。
 *
 * IR 是纯函数派生物（`buildTeamWorkflowIr`，agents 包），本命令只负责
 * 「读团队 → 生成 IR → 调 archify 渲染 → 落 IR 源 + sidecar」。
 */
async function archFromTeam(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const teamId = args[0]
  if (teamId === undefined) {
    ctx.stderr('错误 [bad_request] 缺少团队 ID（用法: prism arch from-team <team_id> [--out <html>]）')
    return 1
  }

  const home = ctx.home ?? prismPaths().home
  const dirs = resolveTargetDirs(ctx, values)
  const team = await loadTeam(dirs.teamsDir, teamId, { rolesDir: dirs.rolesDir })
  if (team === null) {
    ctx.stderr(`错误 [not_found] 团队不存在: ${teamId}（受管 ${dirs.teamsDir}）`)
    return 1
  }

  let ir: unknown
  try {
    ir = buildTeamWorkflowIr(team)
  } catch (error) {
    return generationFailure(ctx, error)
  }

  const outPath =
    values.out !== undefined
      ? String(values.out)
      : join(prismPaths(home).home, 'archify', 'workflow', `${teamId}.html`)

  const result = await emitDerivedIr(values, 'workflow', ir, outPath)

  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        value: { type: 'workflow', team_id: teamId, html: result.html, ir: result.ir, meta: result.meta },
      }),
    )
  } else {
    ctx.stdout(`已由团队 ${teamId} 生成工作流图 → ${result.html}`)
    ctx.stdout(`  IR 源: ${result.ir}`)
    ctx.stdout(`  预览: prism serve 后在「知识库 → 点开书 → 架构图」查看`)
  }
  return 0
}

/** `from-graph` 支持的图类型（`workflow` / `lifecycle` 各有专源，不走图谱）。 */
const FROM_GRAPH_TYPES = ['architecture', 'sequence', 'dataflow'] as const
type FromGraphType = (typeof FROM_GRAPH_TYPES)[number]

function isFromGraphType(value: string): value is FromGraphType {
  return (FROM_GRAPH_TYPES as readonly string[]).includes(value)
}

/**
 * `prism arch from-graph <type> <project>`：由**代码图谱**生成三类图。
 *
 * 分工：读图谱（server 的 `readCodeGraph`）→ 派生 IR（agents 的纯函数生成器）
 * → archify 渲染。**不需要宿主或用户写一行 IR**。
 *
 * `dataflow` 是**依赖流向口径**（Graphify 图谱没有数据读写边），口径写在
 * IR 的 `meta.subtitle` 与文档里，此处额外在终端提示一次。
 */
async function archFromGraph(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const type = args[0]
  const project = args[1]
  if (type === undefined || !isFromGraphType(type)) {
    ctx.stderr(
      `错误 [bad_request] 图类型必须是 ${FROM_GRAPH_TYPES.join(' / ')}` +
        `（用法: prism arch from-graph <type> <project>）`,
    )
    return 1
  }
  if (project === undefined) {
    ctx.stderr('错误 [bad_request] 缺少项目名（用法: prism arch from-graph <type> <project>）')
    return 1
  }

  const home = ctx.home ?? prismPaths().home
  const registry = new ProjectRegistry(home)
  const info = await registry.get(project) // 未注册 → not_found（由外层统一渲染）
  const graph = await readCodeGraph(info.root)

  const top = values.top !== undefined ? Number(values.top) : undefined
  const limit = values.limit !== undefined ? Number(values.limit) : undefined
  const title = values.title !== undefined ? String(values.title) : `${project} · ${ARCHIFY_TYPE_LABELS[type]}`

  let ir: unknown
  try {
    if (type === 'architecture') {
      ir = buildArchitectureIr(graph, {
        title,
        ...(top !== undefined ? { maxComponents: top } : {}),
        ...(limit !== undefined ? { maxConnections: limit } : {}),
      })
    } else if (type === 'sequence') {
      ir = buildSequenceIr(graph, {
        title,
        ...(top !== undefined ? { maxParticipants: top } : {}),
        ...(limit !== undefined ? { maxMessages: limit } : {}),
      })
    } else {
      ir = buildDataflowIr(graph, {
        title,
        ...(top !== undefined ? { maxComponents: top } : {}),
        ...(limit !== undefined ? { maxFlows: limit } : {}),
      })
    }
  } catch (error) {
    return generationFailure(ctx, error)
  }

  const outPath =
    values.out !== undefined
      ? String(values.out)
      : join(prismPaths(home).home, 'archify', type, `${project}.html`)

  const result = await emitDerivedIr(values, type, ir, outPath)

  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        value: { type, project, root: info.root, html: result.html, ir: result.ir, meta: result.meta },
      }),
    )
  } else {
    ctx.stdout(`已由代码图谱生成${ARCHIFY_TYPE_LABELS[type]} → ${result.html}`)
    ctx.stdout(`  项目: ${project}（${info.root}）`)
    ctx.stdout(`  IR 源: ${result.ir}`)
    if (type === 'dataflow') {
      ctx.stdout(`  ⚠ 口径: 依赖流向视图——图谱无数据读写边，本图按目录角色分层 + 依赖边派生`)
    }
    ctx.stdout(`  预览: prism serve 后在「知识库 → 点开书 → 架构图」查看`)
  }
  return 0
}

/**
 * `prism arch from-state`：由 **Prism 任务状态机**生成生命周期图。
 *
 * 数据源是 `@prism/core` 的 `TASK_TRANSITIONS` / `DERIVED_TRANSITIONS` 常量
 * ——改了状态机重新生成即可，**图不可能与代码脱节**。
 */
async function archFromState(ctx: CommandContext, _args: string[], values: ArgValues): Promise<number> {
  const home = ctx.home ?? prismPaths().home
  const title = values.title !== undefined ? String(values.title) : undefined

  let ir: unknown
  try {
    ir = buildTaskLifecycleIr({ ...(title !== undefined ? { title } : {}) })
  } catch (error) {
    return generationFailure(ctx, error)
  }

  const outPath =
    values.out !== undefined
      ? String(values.out)
      : join(prismPaths(home).home, 'archify', 'lifecycle', 'task-state-machine.html')

  const result = await emitDerivedIr(values, 'lifecycle', ir, outPath)

  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({ ok: true, value: { type: 'lifecycle', html: result.html, ir: result.ir, meta: result.meta } }),
    )
  } else {
    ctx.stdout(`已由任务状态机生成生命周期图 → ${result.html}`)
    ctx.stdout(`  IR 源: ${result.ir}`)
    ctx.stdout(`  预览: prism serve 后在「知识库 → 点开书 → 架构图」查看`)
  }
  return 0
}
