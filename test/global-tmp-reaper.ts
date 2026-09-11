import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 单测临时产物回收器（vitest globalSetup）。
 *
 * 背景：各测试统一用 `mkdtemp(join(tmpdir(), 'prism-<用途>-'))` 造隔离 home，
 * 有的还直接往 tmpdir 写 `prism-*.md` 文件，但**没有任何一处回收**——每次
 * `pnpm test` 都往 `os.tmpdir()` 净增一批 `prism-*` 条目（曾累积到 3 万+）。
 *
 * 口径（与 e2e 的 F-T1 收口同源，但单一入口覆盖所有测试文件，无需逐个改）：
 *  - setup 时对 `tmpdir()/prism-*`（目录 + 文件一并算）拍**基线快照**；
 *  - teardown 只删**本轮新增**的——已存在的（用户自己的东西）绝不碰；
 *  - Windows 下 SQLite WAL 句柄若未释放会删不掉：带重试，仍失败则
 *    **不静默**，打 WARN 并列出残留清单。
 *
 * vitest 3 默认 `pool: 'forks'`，worker 是子进程，退出即释放句柄，
 * 故 teardown（主进程内、所有 worker 结束后）能删成功。
 */

const REAP_PREFIX = 'prism-'

function listPrismEntries(): string[] {
  try {
    return readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(REAP_PREFIX))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

let baseline = new Set<string>()

export async function setup(): Promise<void> {
  baseline = new Set(listPrismEntries())
}

export async function teardown(): Promise<void> {
  const failed: string[] = []
  for (const name of listPrismEntries()) {
    if (baseline.has(name)) continue
    try {
      rmSync(join(tmpdir(), name), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      })
    } catch {
      failed.push(join(tmpdir(), name))
    }
  }
  if (failed.length > 0) {
    const shown = failed.slice(0, 10).map((dir) => `   - ${dir}`)
    if (failed.length > 10) shown.push(`   … 另有 ${failed.length - 10} 个`)
    process.stderr.write(
      `\n⚠️  测试临时目录回收失败 ${failed.length} 个（Windows 句柄未释放？可手动删除）：\n${shown.join('\n')}\n`,
    )
  }
}
