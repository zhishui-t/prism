/**
 * `prism project`（design-knowledge-model-v1 §3）——项目登记台账。
 *
 * 为什么独立于 `graph build`：知识扫描（`kb sync`）需要知道「有哪些项目根」，
 * 而项目可能尚未建图。登记与建图解耦后，`prism project add` 一次登记，
 * 后续 `graph build` / `kb sync` 都复用同一份台账（`<PRISM_HOME>/graph/projects.json`）。
 *
 * 红线：只记录路径与时间，**不读 git、不写项目文件、不判断是否提交**。
 */
import { access, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { prismPaths, isPrismError } from '@prism/core'
import { ProjectRegistry } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

/** `prism project <add|list|remove|show> ...`。 */
export async function runProject(
  ctx: CommandContext,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const [sub, ...rest] = args
  try {
    switch (sub) {
      case 'add':
        return await projectAdd(ctx, rest, values)
      case 'list':
        return await projectList(ctx)
      case 'show':
        return await projectShow(ctx, rest)
      case 'remove':
        return await projectRemove(ctx, rest, values)
      default:
        ctx.stderr(
          `用法: prism project <add|list|show|remove> ...\n` +
            `  add <项目根目录> [--name <项目名>]   登记项目（不建图、不扫描）\n` +
            `  list                                  列出已登记项目\n` +
            `  show <项目名>                         查看单个项目\n` +
            `  remove <项目名> [--yes]               从台账移除（不删磁盘文件）`,
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

function registry(ctx: CommandContext): ProjectRegistry {
  return new ProjectRegistry(ctx.home ?? prismPaths().home)
}

async function projectAdd(
  ctx: CommandContext,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const rootArg = args[0]
  if (rootArg === undefined) {
    ctx.stderr('用法: prism project add <项目根目录> [--name <项目名>]')
    return 1
  }
  const root = resolve(rootArg)
  try {
    await access(root)
  } catch {
    ctx.stderr(`错误 [bad_request] 项目根目录不存在: ${root}`)
    return 1
  }
  const info = await stat(root)
  if (!info.isDirectory()) {
    ctx.stderr(`错误 [bad_request] 不是目录: ${root}`)
    return 1
  }

  const name = values.name ?? basename(root)
  const reg = registry(ctx)
  // 保留已有 built_at（重新登记不该清掉建图记录）
  let builtAt: string | null = null
  try {
    builtAt = (await reg.get(name)).built_at
  } catch {
    // 未登记过 → 保持 null
  }
  const saved = await reg.register(name, root, builtAt)

  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: saved }))
  } else {
    ctx.stdout(`已登记项目 ${name} → ${root}`)
    if (saved.registered_at !== undefined) {
      ctx.stdout(`  登记时间: ${saved.registered_at}`)
    }
    ctx.stdout(`  下一步: prism graph build ${root} --name ${name}   # 建代码图谱`)
    ctx.stdout(`          prism kb sync ${name}                       # 扫描项目知识`)
  }
  return 0
}

async function projectList(ctx: CommandContext): Promise<number> {
  const projects = await registry(ctx).list()
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: projects }))
    return 0
  }
  if (projects.length === 0) {
    ctx.stdout('（还没有登记项目）用 prism project add <项目根目录> 登记')
    return 0
  }
  for (const p of projects) {
    const flags: string[] = []
    // 区分「从未建图」与「建过但产物已缺失」——后者才是陈旧
    if (p.built_at === null) flags.push('未建图')
    else if (p.stale) flags.push('图谱陈旧')
    else flags.push('已建图')
    if (p.last_scan_at !== undefined) flags.push(`已扫描(${p.scanned_sources ?? 0} 源)`)
    ctx.stdout(`${p.project.padEnd(24)} ${p.root}`)
    ctx.stdout(`  ${' '.repeat(22)}${flags.join(' · ')}`)
  }
  return 0
}

async function projectShow(ctx: CommandContext, args: string[]): Promise<number> {
  const name = args[0]
  if (name === undefined) {
    ctx.stderr('用法: prism project show <项目名>')
    return 1
  }
  const info = await registry(ctx).get(name)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: info }))
    return 0
  }
  ctx.stdout(`项目: ${info.project}`)
  ctx.stdout(`  根目录: ${info.root}`)
  ctx.stdout(`  登记时间: ${info.registered_at ?? '（早期登记，无记录）'}`)
  ctx.stdout(`  建图时间: ${info.built_at ?? '（未建图）'}${info.stale && info.built_at !== null ? ' [产物已缺失]' : ''}`)
  ctx.stdout(`  上次扫描: ${info.last_scan_at ?? '（未扫描）'}${info.scanned_sources !== undefined ? ` · ${info.scanned_sources} 个知识源` : ''}`)
  return 0
}

async function projectRemove(
  ctx: CommandContext,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const name = args[0]
  if (name === undefined) {
    ctx.stderr('用法: prism project remove <项目名> [--yes]')
    return 1
  }
  const reg = registry(ctx)
  const info = await reg.get(name) // 不存在 → not_found
  if (values.yes !== true) {
    ctx.stderr(
      `将要从台账移除项目 ${name}（${info.root}）。\n` +
        `  · 只删登记记录，**不会删除项目里的任何文件**\n` +
        `  · 知识条目与图谱产物保留在磁盘\n` +
        `确认请加 --yes`,
    )
    return 1
  }
  const removed = await reg.remove(name)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { project: name, removed } }))
  } else {
    ctx.stdout(`已从台账移除 ${name}（项目文件未动）`)
  }
  return 0
}
