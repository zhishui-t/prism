/**
 * `prism inject <项目根>` / `prism uninject <项目根>`（knowledge-injection.md §5 模式 C）。
 *
 * 把「已接入 Prism + 先查再答」的指引写进项目 AGENTS.md 的标记块：
 * - 只动 `<!-- prism:begin -->…<!-- prism:end -->` 之间的内容；
 * - 块外用户手写内容一字不动；无块追加、有块更新、缺文件创建；
 * - uninject 只删块（卸载路径）。
 */
import { resolve } from 'node:path'

import { injectAgentsBlock, removeAgentsBlock } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

export async function runInject(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const rootArg = sub === undefined ? rest[0] : sub
  if (rootArg === undefined || rootArg === '') {
    ctx.stderr('用法: prism inject <项目根> [--team <团队id>] [--remove]\n  把 Prism 指引写进 <项目根>/AGENTS.md 的标记块（不动手写内容）')
    return 1
  }
  const path = resolve(rootArg, 'AGENTS.md')
  try {
    if (values.remove === true) {
      const removed = await removeAgentsBlock(path)
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { path, removed } }))
      } else {
        ctx.stdout(removed ? `已移除 ${path} 中的 Prism 块（其余内容未动）` : `（${path} 没有 Prism 块）`)
      }
      return 0
    }
    const result = await injectAgentsBlock(path, {
      ...(values.team !== undefined ? { teamId: String(values.team) } : {}),
    })
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ok: true, value: result }))
    } else {
      const verb = result.action === 'created' ? '已创建' : result.action === 'appended' ? '已追加 Prism 块' : '已更新 Prism 块'
      ctx.stdout(`${verb} → ${result.path}`)
      ctx.stdout('块外内容未动；宿主下次读 AGENTS.md 即可看到 Prism 指引')
    }
    return 0
  } catch (error) {
    ctx.stderr(`错误 [internal] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
