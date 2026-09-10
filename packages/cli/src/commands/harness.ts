/**
 * `prism harness`（deployment-model.md §1）：运行时宿主适配器。
 *
 * 适配器分**内置**（zcode）与**插件**（`<PRISM_HOME>/harnesses/`，启动时自动注册）。
 * **运行期只激活一个**：`PRISM_HARNESS` 环境变量 > `prism.yaml: harness` 键 > 默认项。
 */
import {
  loadPrismConfig,
  resolveHarness,
  harnessSummary,
  listHarnesses,
  harnessDir,
  HARNESS_ENV_VAR,
} from '@prism/agents'
import { isPrismError } from '@prism/core'

import { harnessPluginReport } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { harnessRootOverride } from '../argv.js'

/** `prism harness <list|show> [--harness-root <dir>]`。 */
export async function runHarness(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub] = args
  // 只在**显式指定**时给根覆盖；否则交给激活适配器的 defaultRoot（插件自述）
  const { root } = harnessRootOverride(values)
  try {
    switch (sub) {
      case 'list':
        return harnessList(ctx, root)
      case 'show':
        return harnessShow(ctx, root)
      default:
        ctx.stderr(
          `用法: prism harness <list|show>\n` +
            `  list   列出已编译的适配器 + 当前激活项\n` +
            `  show   当前适配器的约定字段（agent/skill/dispatch/model/instructions）`,
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

/** 解析配置来源（env / prism.yaml），供展示。root 仅在显式指定时传入。 */
function resolveWithConfig(ctx: CommandContext, root?: string): ReturnType<typeof resolveHarness> {
  const config = loadPrismConfig(ctx.home)
  return resolveHarness({
    ...(root !== undefined ? { root } : {}),
    ...(config?.harness !== undefined ? { configuredId: config.harness } : {}),
  })
}

function harnessList(ctx: CommandContext, root?: string): number {
  const resolved = resolveWithConfig(ctx, root)
  const listings = listHarnesses()
  const report = harnessPluginReport()
  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        value: {
          active: resolved.id,
          source: resolved.source,
          available: resolved.available,
          adapters: listings,
          plugins_dir: harnessDir(ctx.home),
          plugins: report !== null ? { loaded: report.loaded, errors: report.errors } : null,
        },
      }),
    )
    return 0
  }
  for (const { id, origin } of listings) {
    const mark = id === resolved.id ? '●' : '○'
    const tag = id === resolved.id ? `  ← 当前激活（${sourceLabel(resolved.source)}）` : ''
    ctx.stdout(`${mark} ${id}  [${origin === 'external' ? '插件' : '内置'}]${tag}`)
  }
  ctx.stdout(`共 ${listings.length} 个适配器（运行期只激活一个）`)
  ctx.stdout(`插件目录: ${harnessDir(ctx.home)}`)
  if (report !== null && report.errors.length > 0) {
    for (const e of report.errors) ctx.stdout(`  ⚠ 插件加载失败: ${e.dir} — ${e.reason}`)
  }
  if (listings.length === 1) {
    ctx.stdout('（提示：第三方适配器包放入插件目录即可自动注册，无需改 Prism 代码）')
  }
  return 0
}

function harnessShow(ctx: CommandContext, root?: string): number {
  const resolved = resolveWithConfig(ctx, root)
  const summary = harnessSummary(resolved.adapter)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: { source: resolved.source, ...summary } }))
    return 0
  }
  ctx.stdout(`适配器: ${summary.id}（${summary.displayName}）  来源: ${sourceLabel(resolved.source)}`)
  ctx.stdout(`  角色目录:   ${summary.agent.globalDir}`)
  ctx.stdout(`  团队目录:   ${summary.agent.teamDir ?? '—'}`)
  ctx.stdout(`  文件模式:   ${summary.agent.filePattern}`)
  ctx.stdout(`  正文约定:   ${summary.agent.bodyConvention}`)
  ctx.stdout(`  激活时机:   ${summary.agent.activation}`)
  ctx.stdout(`  名字对齐:   ${summary.agent.nameMustMatchFile ? '必须与文件名一致' : '不要求'}`)
  ctx.stdout(`  Skill 目录: ${summary.skill.nativeDir ?? '—'}（格式 ${summary.skill.format}）`)
  ctx.stdout(`  派发机制:   ${summary.dispatch?.mechanism ?? '—'}`)
  ctx.stdout(`  模型声明:   ${summary.model?.declarable === true ? `可声明（${summary.model.format}）` : '不可声明'}`)
  ctx.stdout(`  指令文件:   ${summary.instructions.file}`)
  return 0
}

function sourceLabel(source: 'env' | 'config' | 'default'): string {
  if (source === 'env') return `${HARNESS_ENV_VAR} 环境变量`
  if (source === 'config') return 'prism.yaml'
  return '默认'
}
