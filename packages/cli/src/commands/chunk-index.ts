/**
 * 段级索引补齐（v13 §7 / SPEC-5.1–5.3）——**单点实现**。
 *
 * `prism kb reindex --chunks [--book <b>]` 与 `prism embedding reindex` 共用本模块：
 * 两条命令的重切口径、跳过判据与向量补齐口径必须逐字一致，否则「先跑 A 再跑 B」
 * 会来回重切（镜像契约漂移——AGENTS.md §5 的已知陷阱）。
 *
 * 红线：R7（段是**派生**索引，可重建；正文文件一个字节都不动）、R5（临时目录由调用方
 * 保证，本模块只按传入的 home 打开库）。
 *
 * 与 `service.reindex()` 的分工：
 * - `service.reindex()`：**整体**以文件为真相重建 entries + FTS + 段（一个事务，owned 全量）；
 * - 本模块：存量**补齐**——不重建条目行、不改正文，只保证「每个最新版条目都有一份与
 *   当前索引正文一致的段级索引」，按条目逐个事务（中断可重跑，不锁检索——SPEC-5.2）。
 */
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import type { PrismDatabase } from '@prism/core'
import {
  assembleChunkEmbeddingInput,
  chunkMarkdown,
  deleteChunks,
  indexChunks,
} from '@prism/knowledge'
import type { Chunk, ChunkOptions } from '@prism/knowledge'

/** 一次补齐的计数报告（`kb reindex --chunks` 与 `embedding reindex` 共用形状）。 */
export interface ChunkBackfillReport {
  /** 扫过的最新版条目数 */
  scanned: number
  /** 完全就绪、跳过的条目数 */
  skipped: number
  /** 重切（段行被重写）的条目数 */
  reindexed: number
  /** 段行未动、只补段向量的条目数 */
  refilled: number
  /** 本次写入的段行总数（仅计重切的条目） */
  chunks: number
  /** 本次写入的段向量条数 */
  vectors: number
  /** 清理的条目数（自有型但版次文件已消失 → 段行删除） */
  cleaned: number
  /** 失败项清单（条目 / 段 seq / 原因）——支持重跑 */
  failed: Array<{ entry: string; seq?: number; reason: string }>
}

export interface ChunkBackfillInput {
  /** 知识库连接（调用方负责打开/关闭） */
  knowledge: PrismDatabase
  /**
   * 段切分选项——**必须**来自 `resolveKbConfigForHome`（与 service 注入的同一份），
   * 否则本模块重切出的段与 service 写入的段不一致，跳过判据永不收敛。
   */
  chunkOptions: ChunkOptions
  /** 只处理该书（未给 = 全库） */
  book?: string
  /** 段向量计算端口；未装配（嵌入不可用）时 undefined → 只补段行与段 FTS */
  embed?: (text: string) => Promise<Float32Array | null>
  /** 当前嵌入模型 id（判「段向量是否齐全」的同一把尺子；缺省 'unknown'，同 service 口径） */
  model?: string
}

/** 条目行（本模块只读必要列）。 */
interface EntryRow {
  rowid: number
  id: string
  version: number
  title: string
  origin: string
  path: string | null
}

/** 已落库的段行。 */
interface StoredChunk {
  id: number
  seq: number
  heading_path: string
  char_start: number
  char_end: number
  text: string
}

/**
 * 存量段级索引补齐（逐条目一个事务；中断后重跑幂等）。
 *
 * 跳过判据（SPEC-5.1 / M-9 / S-13 的落地形态，见模块头「口径说明」）：
 *   ① 段就绪：**存量段 == 按当前索引正文 + 当前 chunkOptions 重切的结果**（逐字段）
 *   ② 向量就绪：**嵌入不可用**（无法补，故不阻塞跳过）**或**每段都有**当前模型**的向量行
 *   ③ 自有型条目但版次文件已消失 → 清段行（与 `service.reindex()` 的 origin 口径同源）
 *
 * 正文取自 `kb_fts.body`（条目级索引副本）——与 `embedding reindex` 同源，且保证段文本
 * 与条目级检索路服务的是同一份内容（自有型/引用型都有）。
 */
export async function backfillChunks(input: ChunkBackfillInput): Promise<ChunkBackfillReport> {
  const raw = input.knowledge.raw
  const report: ChunkBackfillReport = {
    scanned: 0,
    skipped: 0,
    reindexed: 0,
    refilled: 0,
    chunks: 0,
    vectors: 0,
    cleaned: 0,
    failed: [],
  }

  const where = ["e.is_latest = 1", "e.status != 'deprecated'"]
  const params: string[] = []
  if (input.book !== undefined) {
    where.push('e.book = ?')
    params.push(input.book)
  }
  const entries = raw
    .prepare(
      `SELECT e.rowid AS rowid, e.id AS id, e.version AS version, e.title AS title,
              e.origin AS origin, e.path AS path
       FROM knowledge_entries e
       WHERE ${where.join(' AND ')}
       ORDER BY e.updated_at DESC`,
    )
    .all(...params) as unknown as EntryRow[]

  for (const entry of entries) {
    report.scanned++

    // ① 自有型 + 版次文件已消失 → 段行清理（条目本身留给 `kb reindex` 处理）
    if (entry.origin === 'owned' && (entry.path === null || entry.path === '' || !existsSync(entry.path))) {
      await input.knowledge.run((tx) => deleteChunks(tx, entry.id))
      report.cleaned++
      continue
    }

    // ② 正文 = 条目级索引副本（缺副本说明条目级索引也没建成，报失败让人先跑 kb reindex）
    const bodyRow = raw.prepare('SELECT body FROM kb_fts WHERE rowid = ?').get(entry.rowid) as
      | { body: string }
      | undefined
    if (bodyRow === undefined) {
      report.failed.push({ entry: entry.id, reason: '缺条目级索引副本（先跑 prism kb reindex）' })
      continue
    }
    const body = bodyRow.body
    const fresh = chunkMarkdown(body, input.chunkOptions)
    const stored = raw
      .prepare(
        `SELECT id, seq, heading_path, char_start, char_end, text
         FROM kb_chunks WHERE entry_id = ? ORDER BY seq`,
      )
      .all(entry.id) as unknown as StoredChunk[]

    // ③ 段就绪？（含「chunkOptions 变更 → 存量段作废」这一设计未言明的场景）
    let current: Array<{ id: number; seq: number; embedInput: string }>
    let rewrote = false
    if (sameChunks(stored, fresh)) {
      current = stored.map((row) => ({
        id: row.id,
        seq: row.seq,
        embedInput: assembleChunkEmbeddingInput(entry.title, toChunk(row)),
      }))
    } else {
      const written = await input.knowledge.run((tx) => {
        deleteChunks(tx, entry.id)
        return indexChunks(tx, entry.id, entry.version, entry.title, fresh)
      })
      rewrote = true
      report.reindexed++
      report.chunks += written.length
      current = written.map((row, index) => ({ id: row.id, seq: fresh[index]?.seq ?? index, embedInput: row.embedText }))
    }

    // ④ 向量就绪？嵌入不可用 → 判据为真（补不了，不阻塞跳过——M-9）
    if (current.length === 0 || input.embed === undefined) {
      if (!rewrote) report.skipped++
      continue
    }
    const model = input.model ?? 'unknown'
    const missing = current.filter((row) => !hasVector(raw, row.id, model))
    if (missing.length === 0) {
      if (!rewrote) report.skipped++
      continue
    }

    const computed: Array<{ id: number; vec: Float32Array }> = []
    for (const row of missing) {
      let vec: Float32Array | null
      try {
        vec = await input.embed(row.embedInput)
      } catch (error) {
        report.failed.push({
          entry: entry.id,
          seq: row.seq,
          reason: `嵌入失败: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      if (vec === null || vec.length === 0) {
        report.failed.push({ entry: entry.id, seq: row.seq, reason: '嵌入不可用（返回空向量）' })
        continue
      }
      computed.push({ id: row.id, vec })
    }
    if (computed.length === 0) continue

    const nowIso = new Date().toISOString()
    await input.knowledge.run((tx) => {
      const upsert = tx.prepare(
        `INSERT INTO kb_chunk_vectors (chunk_id, dim, vec, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec,
           model = excluded.model, updated_at = excluded.updated_at`,
      )
      for (const row of computed) {
        const blob = Buffer.from(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength)
        upsert.run(row.id, row.vec.length, blob, model, nowIso)
      }
    })
    report.vectors += computed.length
    if (!rewrote) report.refilled++
  }

  return report
}

/** 报告的通用输出行（`--json` 之外的两个人读入口共用，措辞单点）。 */
export function chunkReportLines(report: ChunkBackfillReport, label = '段级索引补齐'): string[] {
  const parts = [
    `扫描 ${report.scanned} 条`,
    `跳过 ${report.skipped} 条`,
    `重切 ${report.reindexed} 条（${report.chunks} 段）`,
  ]
  if (report.refilled > 0 || report.vectors > 0) {
    parts.push(`补向量 ${report.refilled} 条 / ${report.vectors} 段`)
  }
  if (report.cleaned > 0) parts.push(`清理 ${report.cleaned} 条`)
  const lines = [`${label}：${parts.join('，')}`]
  for (const item of report.failed) {
    lines.push(`  FAIL ${item.entry}${item.seq !== undefined ? `#${item.seq}` : ''}: ${item.reason}`)
  }
  return lines
}

/** 存量段是否与重切结果逐字段一致（seq / 路径 / 区间 / 正文全比）。 */
function sameChunks(stored: readonly StoredChunk[], fresh: readonly Chunk[]): boolean {
  if (stored.length !== fresh.length) return false
  for (let i = 0; i < fresh.length; i++) {
    const left = stored[i]
    const right = fresh[i]
    if (left === undefined || right === undefined) return false
    if (
      left.seq !== right.seq ||
      left.heading_path !== right.headingPath ||
      left.char_start !== right.charStart ||
      left.char_end !== right.charEnd ||
      left.text !== right.text
    ) {
      return false
    }
  }
  return true
}

/** 段行 → `Chunk`（仅为复用 `assembleChunkEmbeddingInput` 的单点拼装口径）。 */
function toChunk(row: StoredChunk): Chunk {
  return {
    seq: row.seq,
    headingPath: row.heading_path,
    text: row.text,
    charStart: row.char_start,
    charEnd: row.char_end,
  }
}

/** 该段是否已有**当前模型**的向量行（换档后旧模型向量视为缺失）。 */
function hasVector(raw: DatabaseSync, chunkId: number, model: string): boolean {
  const row = raw
    .prepare('SELECT 1 AS ok FROM kb_chunk_vectors WHERE chunk_id = ? AND model = ?')
    .get(chunkId, model) as { ok: number } | undefined
  return row !== undefined
}
