/**
 * `prism harness`（deployment-model.md §1）：运行时宿主适配器。
 *
 * Prism 编译期支持多个 harness 适配器，**运行期只激活一个**。
 * 选择优先级：`PRISM_HARNESS` 环境变量 > `prism.yaml: harness` 键 > 默认 `zcode`。
 */
import { loadPrismConfig, resolveHarness, harnessSummary, HARNESS_ENV_VAR } from '@prism/agents'
import { isPrismError } from '@prism/core'

import { defaultZcodeDir } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { expandHome } from '../argv.js'

/** `prism harness <list|show> [--zcode-dir <dir>]`。 */
export async function runHarness(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub] = args
  const zcodeDir = expandHome(values['zcode-dir'] ?? defaultZcodeDir())
  try {
    switch (sub) {
      case 'list':
        return harnessList(ctx, zcodeDir)
      case 'show':
        return harnessShow(ctx, zcodeDir)
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

/** 解析配置来源（env / prism.yaml），供展示。 */
function resolveWithConfig(ctx: CommandContext, zcodeDir: string): ReturnType<typeof resolveHarness> {
  const config = loadPrismConfig(ctx.home)
  return resolveHarness({
    zcodeDir,
    ...(config?.harness !== undefined ? { configuredId: config.harness } : {}),
  })
}

function harnessList(ctx: CommandContext, zcodeDir: string): number {
  const resolved = resolveWithConfig(ctx, zcodeDir)
  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        value: { active: resolved.id, source: resolved.source, available: resolved.available },
      }),
    )
    return 0
  }
  for (const id of resolved.available) {
    const mark = id === resolved.id ? '●' : '○'
    const tag = id === resolved.id ? `  ← 当前激活（${sourceLabel(resolved.source)}）` : ''
    ctx.stdout(`${mark} ${id}${tag}`)
  }
  ctx.stdout(`已编译 ${resolved.available.length} 个适配器（运行期只激活一个）`)
  return 0
}

function harnessShow(ctx: CommandContext, zcodeDir: string): number {
  const resolved = resolveWithConfig(ctx, zcodeDir)
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
