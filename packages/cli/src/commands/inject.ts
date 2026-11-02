/**
 * `prism inject <项目根>` / `prism uninject <项目根>`（knowledge-injection.md §5 模式 C）。
 *
 * 把「已接入 Prism + 先查再答」的指引写进项目 AGENTS.md 的标记块：
 * - 只动 `<!-- prism:begin -->…<!-- prism:end -->` 之间的内容；
 * - 块外用户手写内容一字不动；无块追加、有块更新、缺文件创建；
 * - `--team <id>` 同时注入/更新**团队约定块**（`<!-- prism:team:<id>:start/end -->`，
 *   适配器 renderTeamInstructions：编制表【同角色并发实例上限】+ 工作流 + 仲裁链）——
 *   团队定义改版后重跑本命令即完成更新（team-definition.md §7「注入」）；
 * - uninject 只删块（知识块 + 全部团队块；卸载路径）。
 */
import { resolve } from 'node:path'

import { injectAgentsBlock, injectTeamConvention, removeAgentsBlock, removeTeamBlocks } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { harnessRootOverride, resolveTargetDirs } from '../argv.js'

export async function runInject(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const rootArg = sub === undefined ? rest[0] : sub
  if (rootArg === undefined || rootArg === '') {
    ctx.stderr(
      '用法: prism inject <项目根> [--team <团队id>] [--remove]\n' +
        '  把 Prism 指引写进 <项目根>/AGENTS.md 的标记块（不动手写内容）\n' +
        '  --team 同时注入/更新团队约定块（编制/工作流/仲裁链；重跑 = 更新）',
    )
    return 1
  }
  const repoRoot = resolve(rootArg)
  const path = resolve(repoRoot, 'AGENTS.md')
  const teamId = values.team !== undefined ? String(values.team).trim() : ''
  try {
    if (values.remove === true) {
      const removed = await removeAgentsBlock(path)
      const teamsRemoved = await removeTeamBlocks(path)
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { path, removed, teamsRemoved } }))
      } else {
        ctx.stdout(
          removed || teamsRemoved > 0
            ? `已移除 ${path} 中的 Prism 块（知识块 ${removed ? '✓' : '无'}；团队块 ${teamsRemoved} 个；其余内容未动）`
            : `（${path} 没有 Prism 块）`,
        )
      }
      return 0
    }
    const result = await injectAgentsBlock(path, {
      ...(teamId !== '' ? { teamId } : {}),
    })
    // 团队约定块（--team 时）：编制表/工作流/仲裁链 → 独立标记块，重跑即更新
    let team: { action: 'created' | 'appended' | 'updated' } | null = null
    if (teamId !== '') {
      const { root } = harnessRootOverride(values)
      const dirs = resolveTargetDirs(ctx, values)
      team = await injectTeamConvention({
        repoRoot,
        teamId,
        teamsDir: dirs.teamsDir,
        rolesDir: dirs.rolesDir,
        ...(root !== undefined ? { harnessRoot: root } : {}),
        home: ctx.home,
      })
    }
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ok: true, value: { ...result, team } }))
    } else {
      const verb = result.action === 'created' ? '已创建' : result.action === 'appended' ? '已追加 Prism 块' : '已更新 Prism 块'
      ctx.stdout(`${verb} → ${result.path}`)
      if (team !== null) {
        const teamVerb = team.action === 'created' ? '已创建' : team.action === 'appended' ? '已追加' : '已更新'
        ctx.stdout(`${teamVerb}团队约定块（${teamId}：编制/工作流/仲裁链）→ ${path}`)
      }
      ctx.stdout('块外内容未动；宿主下次读 AGENTS.md 即可看到 Prism 指引')
    }
    return 0
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'internal'
    ctx.stderr(`错误 [${code}] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
