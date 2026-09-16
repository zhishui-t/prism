import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TrashStore, TrashTrigger } from '@prism/core'

import { hasPrismMarker } from './marker.js'
import type { SkillUninstallOptions, SkillUninstallResult } from './types.js'

/**
 * 卸载的**回收站依赖**（v9 F3）。
 *
 * 单独成型而不并入冻结的 {@link SkillUninstallOptions}：`trashDir` 与 `AuditLog` 必须归属
 * 调用方的 `PRISM_HOME`（`--home` / 测试临时目录），本包不解析 home。
 */
export interface SkillUninstallDeps {
  /** 回收站（搬移 + 审计单点）；由入口层按 `PRISM_HOME` 构造后注入。 */
  trash: TrashStore
  /** 触发入口（进回收站 meta 与审计，仅作溯源）。 */
  trigger: TrashTrigger
}

/**
 * 卸载 Skill（design-v3 §5 冲突策略的另一半）：**只回收带 Prism marker 的产物**。
 *
 * - 落点 `<targetDir>/<name>/SKILL.md`；`names` 缺省 = 扫描 `targetDir` 下全部子目录。
 * - SKILL.md 含 Prism marker → **整目录搬进回收站**（v9 F3：原「`rm -rf` 直接删」改为
 *   `TrashStore.put`，可 `prism trash restore <id>` 还原）；人写的（无 marker）→ **一律不动**，
 *   记入 `kept` 并给原因。目录里没有 SKILL.md 同样保留。
 * - `targetDir` 不存在 → 空结果（幂等：没什么可卸的）。
 *
 * 实现单点：CLI `prism skill uninstall` 与 MCP `prism_skill_uninstall` /
 * HTTP `POST /api/skills/uninstall` 共用本函数——「卸载只动 Prism 产物」的口径不会各自漂移。
 *
 * ⚠ `removed` 自 v9 起是**实际落点（整目录的绝对路径）**，不再是被卸的 Skill 名
 * （旧语义会让调用方把「名字」当路径用，且目录式卸载只搬 SKILL.md 会留残目录）。
 */
export async function uninstallSkills(
  opts: SkillUninstallOptions,
  deps: SkillUninstallDeps,
): Promise<SkillUninstallResult> {
  const removed: string[] = []
  const trashIds: string[] = []
  const kept: SkillUninstallResult['kept'] = []

  let targets = opts.names ?? []
  if (targets.length === 0) {
    if (!existsSync(opts.targetDir)) return { removed, kept, trashIds }
    const entries = await readdir(opts.targetDir, { withFileTypes: true })
    targets = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  }

  for (const name of targets) {
    const dir = join(opts.targetDir, name)
    const skillFile = join(dir, 'SKILL.md')
    if (!existsSync(skillFile)) {
      kept.push({ name, path: dir, reason: '无 SKILL.md' })
      continue
    }
    const text = await readFile(skillFile, 'utf-8')
    if (!hasPrismMarker(text)) {
      kept.push({ name, path: skillFile, reason: '非 Prism 产物，保留' })
      continue
    }
    // 落点 = 整目录（目录内可能还有 references/ 等附带产物，只删 SKILL.md 会留残目录）
    const moved = await deps.trash.put('skill', name, [dir], {
      managedRoot: opts.targetDir,
      trigger: deps.trigger,
    })
    removed.push(...moved.originalPaths)
    trashIds.push(moved.id)
  }

  return { removed, kept, trashIds }
}
