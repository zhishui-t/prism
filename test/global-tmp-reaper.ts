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
 * v18 起**按运行标记收窄回收面**（此前「删一切新增」曾把并行 archify render
 * CLI 在途的目录当新增删掉，造成 ENOENT 事故）：
 *  - setup 时注入 `PRISM_TMP_TAG = r<主pid>-<ts>` 并对 `tmpdir()/prism-*` 拍基线；
 *    vitest 3 默认 `pool: 'forks'`，worker / spawn 孙进程默认继承 env → 全 run 同标记
 *    （不能按 pid 匹配：worker / 主进程 / CLI 孙进程三方 pid 各不相同）；
 *  - teardown 只删**新增且嵌本 run 标记**（`-<tag>-` 连字符锚定）的条目；
 *    无标记的新增条目属于并行外部进程的在途产物——跳过（DEBUG 可见），绝不碰；
 *  - **防退化哨兵**：本轮有新增却一个都没回收 → WARN（标记机制被破坏导致 reaper
 *    空转 = R5 静默回归，必须可见）。
 *  - Windows 下 SQLite WAL 句柄若未释放会删不掉：带重试，仍失败则**不静默**，
 *    打 WARN 并列出残留清单。
 *
 * 创建点约定：产品 + 测试一律经 `core.prismTmpPrefix(use)` / `core.tmpTag()` 嵌标记
 * （env 缺省回落 `p<pid>`，非测试场景进程隔离自然成立）；带 finally 自清的测试
 * 不受影响——reaper 只是兜底。
 */

const REAP_PREFIX = 'prism-'

/** 正则元字符转义（本仓无共享实现，reaper 自带）。 */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function listPrismEntries(): string[] {
  try {
    return readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(REAP_PREFIX))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export interface TmpReaper {
  setup(): Promise<void>
  teardown(): Promise<void>
}

/**
 * 可实例化的回收器。env 可注入——测试用独立实例（自有基线 + 沙箱 env），
 * 不动全局 `process.env`、也不会误删其他并行 worker 的在途目录。
 */
export function createTmpReaper(env: NodeJS.ProcessEnv = process.env): TmpReaper {
  let baseline = new Set<string>()

  return {
    async setup(): Promise<void> {
      env.PRISM_TMP_TAG = `r${process.pid}-${Date.now()}`
      baseline = new Set(listPrismEntries())
    },

    async teardown(): Promise<void> {
      const tag = env.PRISM_TMP_TAG ?? ''
      const tagRe = tag === '' ? null : new RegExp(`-${escapeRegex(tag)}-`)
      const failed: string[] = []
      const skipped: string[] = []
      let created = 0
      let deleted = 0
      for (const name of listPrismEntries()) {
        if (baseline.has(name)) continue
        created++
        // 收窄：只回收嵌了本 run 标记的条目。无标记的是并行外部进程（archify
        // render CLI 等）的在途产物，动它 = v17 的 ENOENT 事故重演。
        if (tagRe === null || !tagRe.test(name)) {
          skipped.push(name)
          continue
        }
        try {
          rmSync(join(tmpdir(), name), {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          })
          deleted++
        } catch {
          failed.push(join(tmpdir(), name))
        }
      }
      // 防退化哨兵：有新增却零回收 → 标记匹配失效、reaper 空转（R5 静默回归）。
      if (created > 0 && deleted === 0) {
        process.stderr.write(
          `\n⚠️  tmp-reaper 哨兵：本轮新增 ${created} 个 prism-* 条目但回收 0 个（其中无标记跳过 ${skipped.length} 个）——运行标记匹配是否失效？\n`,
        )
      }
      if (skipped.length > 0) {
        const shown = skipped.slice(0, 5).map((name) => `   - ${name}`)
        if (skipped.length > 5) shown.push(`   … 另有 ${skipped.length - 5} 个`)
        process.stderr.write(
          `\n[DEBUG] tmp-reaper 跳过 ${skipped.length} 个非本 run 标记的 prism-* 条目（并行进程在途保护，不删）：\n${shown.join('\n')}\n`,
        )
      }
      if (failed.length > 0) {
        const shown = failed.slice(0, 10).map((dir) => `   - ${dir}`)
        if (failed.length > 10) shown.push(`   … 另有 ${failed.length - 10} 个`)
        process.stderr.write(
          `\n⚠️  测试临时目录回收失败 ${failed.length} 个（Windows 句柄未释放？可手动删除）：\n${shown.join('\n')}\n`,
        )
      }
    },
  }
}

const globalReaper = createTmpReaper()

export const setup = globalReaper.setup
export const teardown = globalReaper.teardown
