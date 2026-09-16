/**
 * `prism trash list | restore <id> | purge [--all]`（design-v9 §3 F3）——回收站命令面。
 *
 * 语义（D-2）：
 * - `list [--kind role|team|skill]`：只读列出回收站单元（最新在前）；
 * - `restore <id> [--overwrite]`：把单元搬回**原路径**；`id` 形状 `<kind>/<单元目录名>`，
 *   取自 `list` 的首列。目标已存在 → 报错（`--overwrite` 才覆盖）；越界/不存在 → 友好提示；
 * - `purge [--all]`：缺省**只清到期单元**（保留期 `PRISM_TRASH_RETENTION_DAYS`，默认 3 天）；
 *   `--all` = 清全部（含未到期）。
 *
 * 归属：trashDir 与审计都随 `ctx.home`（`--home` / 测试临时目录）——绝不落默认 `~/.prism`。
 * 自动清除只在 `prism serve` 进程（每小时，C-8）；纯 CLI 部署靠本命令的手动 purge 兜底（I-4）。
 */
import { prismHome, resolveTrashRetentionDays } from '@prism/core'

import { trashStoreFor } from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'

const TRASH_USAGE =
  '用法: prism trash list [--kind role|team|skill] | restore <id> [--overwrite] | purge [--all]'

export async function runTrash(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const trash = trashStoreFor(ctx.home ?? prismHome())

  switch (sub) {
    case 'list': {
      const kind = (values.kind ?? '').trim()
      const units = await trash.list(kind === '' ? undefined : kind)
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: units }))
        return 0
      }
      if (units.length === 0) {
        ctx.stdout(`回收站为空（${trash.trashDir}）`)
        return 0
      }
      for (const unit of units) {
        const broken = unit.broken === true ? '  [broken]' : ''
        ctx.stdout(`${unit.id}  ${unit.kind}  ${unit.name}  ${unit.deletedAt}${broken}`)
      }
      ctx.stdout(`共 ${units.length} 个单元（${trash.trashDir}）`)
      return 0
    }

    case 'restore': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr(TRASH_USAGE)
        return 1
      }
      let restored: string[]
      try {
        restored = await trash.restore(id, { overwrite: values.overwrite === true, trigger: 'CLI' })
      } catch (error) {
        return reportTrashError(ctx, error)
      }
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { id, restored } }))
        return 0
      }
      for (const path of restored) ctx.stdout(`  已还原 ${path}`)
      ctx.stdout(`单元 ${id} 已还原（${restored.length} 项）`)
      return 0
    }

    case 'purge': {
      // 缺省 = 只清到期（保留期读 PRISM_TRASH_RETENTION_DAYS，缺省 3 天）；
      // `--all` = retentionDays 0（cutoff = 现在），即清全部单元（TrashStore 侧同口径的既有约定）
      const retentionDays = values.all === true ? 0 : resolveTrashRetentionDays()
      const purged = await trash.purge(retentionDays, { trigger: 'CLI' })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: { all: values.all === true, purged } }))
        return 0
      }
      if (purged.length === 0) {
        ctx.stdout(values.all === true ? '回收站为空，无需清除' : '没有到期单元（清全部用 prism trash purge --all）')
        return 0
      }
      for (const id of purged) ctx.stdout(`  已彻底清除 ${id}`)
      ctx.stdout(`共清除 ${purged.length} 个单元（${trash.trashDir}）`)
      return 0
    }

    default:
      ctx.stderr(`未知子命令: trash ${sub ?? ''}\n${TRASH_USAGE}`)
      return 1
  }
}

/** 统一错误出口：把 TrashStore 的 `PrismError.code` 与可读文案一并给出（含手工恢复提示）。 */
function reportTrashError(ctx: CommandContext, error: unknown): number {
  const code = (error as { code?: string }).code ?? 'bad_request'
  const hint =
    code === 'target_exists'
      ? '（目标位置已有同名文件/目录：加 --overwrite 覆盖，或先移走它）'
      : code === 'trash_broken'
        ? '（该单元缺 trash-meta.json，无法自动还原：请手工处理或 prism trash purge）'
        : code === 'trash_restore_escape'
          ? '（原路径已越出受管根，拒绝回写：请手工处理）'
          : code === 'trash_busy'
            ? '（该单元正被删除/恢复占用：稍后重试；占用方若已崩溃，登记 30 分钟后自动失效）'
            : code === 'not_found'
              ? '（用 prism trash list 取有效 id）'
              : ''
  ctx.stderr(`错误 [${code}] ${error instanceof Error ? error.message : String(error)}${hint}`)
  return 1
}
