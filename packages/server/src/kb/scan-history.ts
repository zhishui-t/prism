/**
 * 知识扫描历史（append-only JSONL）。
 *
 * 为什么需要：`prism kb sync` 的报告（发现数、新建/更新、**孤儿索引**、不可读目录）
 * 原本只打印到 stdout，进程一退就没了。生产环境要回答「上周那次扫描哪些源失效了」
 * 无处可查。这里把每次扫描追加一行 JSON，形成可审计的历史。
 *
 * 存哪：`<PRISM_HOME>/graph/scan-history.jsonl`（与项目台账同目录）。
 * 为什么用 JSONL 而不是改 projects.json：历史是 append-only，追加写不会与
 * 台账的「整文件原子替换」互相干扰；坏了也只坏一行。
 * 红线：只记录 Prism 自己观察到的结果，不读 git、不改项目文件。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SingleWriterQueue } from '@prism/core'

/** 一次扫描的留痕。 */
export interface ScanRecord {
  /** 项目名 */
  project: string
  /** 项目根目录 */
  root: string
  /** 扫描完成时间（ISO） */
  scanned_at: string
  /** 发现的可处理文件数 */
  discovered: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  /** 源文件已消失、索引仍在的条目 id */
  missing: string[]
  /** 不可读目录 */
  unreadable: string[]
  /** 是否被文件数上限截断 */
  truncated: boolean
}

/** 扫描历史（按项目分文件？不——单文件 + 查询时过滤，量级可控）。 */
export class ScanHistory {
  readonly #file: string
  readonly #writeQueue = new SingleWriterQueue()

  constructor(home: string) {
    this.#file = join(home, 'graph', 'scan-history.jsonl')
  }

  /** 追加一条记录（串行写，跨进程追加为「各自 append」，POSIX 下小写入原子）。 */
  async append(record: ScanRecord): Promise<void> {
    await this.#writeQueue.run(async () => {
      await mkdir(dirname(this.#file), { recursive: true })
      await appendFile(this.#file, `${JSON.stringify(record)}\n`, 'utf-8')
    })
  }

  /**
   * 读历史（最新的在前）。
   * @param project 限定项目（省略 = 全部）
   * @param limit 最多返回条数（默认 20）
   */
  async list(project?: string, limit = 20): Promise<ScanRecord[]> {
    let text: string
    try {
      text = await readFile(this.#file, 'utf-8')
    } catch {
      return [] // 无历史
    }
    const out: ScanRecord[] = []
    const lines = text.split('\n')
    // 从后往前读，够 limit 就停（避免大文件全解析）
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]?.trim()
      if (line === undefined || line === '') continue
      try {
        const rec = JSON.parse(line) as ScanRecord
        if (project === undefined || rec.project === project) out.push(rec)
      } catch {
        // 坏行跳过（不因一行损坏丢全部历史）
      }
    }
    return out
  }

  /** 某项目最近一次扫描。 */
  async latest(project: string): Promise<ScanRecord | null> {
    const list = await this.list(project, 1)
    return list[0] ?? null
  }

  /** 历史文件路径（供诊断/展示）。 */
  get path(): string {
    return this.#file
  }
}
