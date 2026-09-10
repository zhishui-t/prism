import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { PrismError } from '@prism/core'

import { hasPrismMarker } from './marker.js'
import type { SkillInstallOptions, SkillInstallResult } from './types.js'

/**
 * 安装 Skill 到目标目录（design-v3 §3.2 installSkills + §5 冲突策略）：
 * - 落点 `<targetDir>/<name>/SKILL.md`；targetDir 由调用方传入
 *   （来自 `--harness-root` / `adapter.skill.nativeDir` 推导），本包不硬编码任何宿主路径。
 * - 目标不存在 → 写入；含 Prism marker → 覆盖；人写的（无 marker）→ 不覆盖，
 *   写 `SKILL.md.prism-new` 供对比并记入 skipped；`--force` 一律覆盖。
 * - 目录不存在自动创建；不可写 → PrismError('bad_request') 可读错误（design-v3 §5 P16）。
 */
export async function installSkills(opts: SkillInstallOptions): Promise<SkillInstallResult> {
  const written: string[] = []
  const skipped: SkillInstallResult['skipped'] = []

  try {
    await mkdir(opts.targetDir, { recursive: true })
  } catch (error) {
    throw new PrismError(
      'bad_request',
      `目标目录不可写: ${opts.targetDir}（${error instanceof Error ? error.message : String(error)}）`,
    )
  }

  for (const skill of opts.skills) {
    const dir = join(opts.targetDir, skill.name)
    const file = join(dir, 'SKILL.md')
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      throw new PrismError(
        'bad_request',
        `目标目录不可写: ${dir}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }

    if (existsSync(file)) {
      const existing = await readFile(file, 'utf-8')
      const prismOwned = hasPrismMarker(existing)
      if (!prismOwned && opts.force !== true) {
        // 人写的 skill：不覆盖，写 .prism-new 供对比（design-v3 §5）
        const candidate = `${file}.prism-new`
        await writeFile(candidate, skill.content, 'utf-8')
        written.push(candidate)
        skipped.push({
          path: file,
          reason: `人写的 Skill（无 Prism marker），不覆盖；已写 ${candidate} 供对比（--force 可强制覆盖）`,
        })
        continue
      }
    }

    // 主文件就位后，本 Skill 目录即归 Prism 管理
    await writeFile(file, skill.content, 'utf-8')
    written.push(file)

    // 附带文件（references/ 等）：随主文件一起装。
    // 走到这里说明 SKILL.md 要么是新建、要么是 Prism 产物（人写的已在上面 continue），
    // 故整个 skill 目录归 Prism 管理，附带文件直接覆盖——否则幂等重装会把自己的
    // references 误判成「人写文件」而全部跳过（marker 只写在 SKILL.md）。
    for (const asset of skill.assets ?? []) {
      const assetPath = join(dir, ...asset.path.split('/'))
      // 越界防护：解析后必须仍在 skill 目录内
      if (!assetPath.startsWith(dir)) {
        throw new PrismError('bad_request', `Skill 附带文件路径越界: ${asset.path}`)
      }
      await mkdir(dirname(assetPath), { recursive: true })
      await writeFile(assetPath, asset.content, 'utf-8')
      written.push(assetPath)
    }
  }

  return { written, skipped }
}
