/**
 * `prism arch`（knowledge-base.md §4.4）：架构图谱——五类图的校验与渲染。
 *
 * 渲染器是 vendored 子工程 `3rd/archify`（MIT v2.16.0），Prism 只做：
 *   - 调 `archify validate`（IR schema + 布局校验）
 *   - 调 `archify render` 产出**自包含 HTML**（iframe 可预览，无外部依赖）
 *   - 产物落 `<PRISM_HOME>/archify/<type>/`（IR 与 HTML 可再作为 `type: diagram` 知识条目）
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { prismPaths, isPrismError } from '@prism/core'
import {
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_TYPE_LABELS,
  renderDiagram,
  validateDiagram,
  writeArtifactMeta,
  type ArchifyDiagramType,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

/** `prism arch <types|validate|render> ...`。 */
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
      default:
        ctx.stderr(
          `用法: prism arch <types|validate|render> ...\n` +
            `  types                                   列出五类图\n` +
            `  validate <type> <ir.json>               校验 IR（schema + 布局）\n` +
            `  render <type> <ir.json> [--out <html>] [--book <书>] [--module <模块>]\n` +
            `                                          渲染为自包含 HTML；--book/--module 把产物归到书内`,
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
  const scope = {
    ...(values.layer !== undefined ? { layer: String(values.layer) } : {}),
    ...(values.owner !== undefined ? { owner: String(values.owner) } : {}),
    ...(values.book !== undefined ? { book: String(values.book) } : {}),
    ...(values.module !== undefined ? { module: String(values.module) } : {}),
  }
  const meta = await writeArtifactMeta(outPath, ir, scope)

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
