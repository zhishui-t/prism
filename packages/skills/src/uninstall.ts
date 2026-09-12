import { readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { hasPrismMarker } from './marker.js'
import type { SkillUninstallOptions, SkillUninstallResult } from './types.js'

/**
 * 卸载 Skill（design-v3 §5 冲突策略的另一半）：**只删 Prism 产物**。
 *
 * - 落点 `<targetDir>/<name>/SKILL.md`；`names` 缺省 = 扫描 `targetDir` 下全部子目录。
 * - SKILL.md 含 Prism marker → 整目录 `rm -rf`；人写的（无 marker）→ **一律不动**，
 *   记入 `kept` 并给原因。目录里没有 SKILL.md 同样保留。
 * - `targetDir` 不存在 → 空结果（幂等：没什么可卸的）。
 *
 * 实现单点：CLI `prism skill uninstall` 与 MCP `prism_skill_uninstall` /
 * HTTP `POST /api/skills/uninstall` 共用本函数——「卸载只动 Prism 产物」的口径不会各自漂移。
 */
export async function uninstallSkills(opts: SkillUninstallOptions): Promise<SkillUninstallResult> {
  const removed: string[] = []
  const kept: SkillUninstallResult['kept'] = []

  let targets = opts.names ?? []
  if (targets.length === 0) {
    if (!existsSync(opts.targetDir)) return { removed, kept }
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
    await rm(dir, { recursive: true, force: true })
    removed.push(name)
  }

  return { removed, kept }
}
