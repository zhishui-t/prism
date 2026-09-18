/**
 * FTS5 全文索引（design.md §3.4 硬约束）。
 *
 *   CREATE VIRTUAL TABLE kb_fts USING fts5(body, seg, tokenize='unicode61')
 *
 * - seg = bigram(标题 + 正文)；查询串同样 bigram 化（tokenize.ts）；
 * - 必须用 bigram，禁止 trigram（trigram 检索不了两字中文词）；
 * - body 存原文副本，供摘要/高亮（本版摘要在 service 层用 JS 计算）；
 * - 映射约定：kb_fts.rowid === knowledge_entries.rowid（同库、append-only、
 *   行不删除不改写，故稳定；VACUUM 重排 rowid 的极端场景留给下期 reindex）。
 *   每个版次一行，检索时按 is_latest 过滤，天然支持 all_versions。
 */
import type { DatabaseSync } from 'node:sqlite'

import type { PrismDatabase } from '@prism/core'

import { assembleChunkEmbeddingInput } from './chunker.js'
import type { Chunk } from './chunker.js'
import { bigram } from './tokenize.js'

/** design.md §3.4 原样 DDL（禁止改为 trigram）。 */
export const KB_FTS_DDL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(body, seg, tokenize='unicode61')"

/** 确保 FTS 表存在（构造时执行一次，幂等）。 */
export function ensureKbFts(db: PrismDatabase): void {
  db.raw.exec(KB_FTS_DDL)
}

/**
 * 在同一事务内写入一个版次的检索副本。
 * @param entriesRowid knowledge_entries 新行的 rowid
 * @param body         正文原文副本
 * @param seg          bigram(标题 + 正文)
 */
export function indexEntry(raw: DatabaseSync, entriesRowid: number, body: string, seg: string): void {
  raw
    .prepare('INSERT INTO kb_fts(rowid, body, seg) VALUES (?, ?, ?)')
    .run(entriesRowid, body, seg)
}

/** 读取某 entries rowid 对应的正文副本（版次文件缺失时的兜底）。 */
export function bodyForRowid(raw: DatabaseSync, entriesRowid: number): string | null {
  const row = raw.prepare('SELECT body FROM kb_fts WHERE rowid = ?').get(entriesRowid) as
    | { body: string }
    | undefined
  return row?.body ?? null
}

export interface FtsSearchOptions {
  /** MATCH 表达式（toMatchExpression 产物） */
  match: string
  /** 附加过滤 SQL（以 e. 别名引用列），如 'e.is_latest = 1 AND e.layer = ?' */
  where: string
  /** 过滤参数（与 where 中 ? 一一对应，均为字符串值） */
  params: string[]
  /** 返回上限 */
  limit: number
}

export interface FtsHit {
  /** knowledge_entries.rowid */
  rowid: number
  /** -bm25，越大越相关 */
  score: number
}

/**
 * FTS 命中：FTS 表与条目表按 rowid 联查，返回 (rowid, score)，
 * 排序为相关性降序（bm25 数值越小越好，取负后越大越好）。
 */
export function searchFts(raw: DatabaseSync, options: FtsSearchOptions): FtsHit[] {
  const where = options.where ? `AND ${options.where}` : ''
  const sql = `
    SELECT kb_fts.rowid AS rowid, bm25(kb_fts) AS rank
    FROM kb_fts
    JOIN knowledge_entries e ON e.rowid = kb_fts.rowid
    WHERE kb_fts MATCH ?
    ${where}
    ORDER BY rank ASC
    LIMIT ?
  `
  const rows = raw
    .prepare(sql)
    .all(options.match, ...options.params, options.limit) as Array<{
    rowid: number
    rank: number
  }>
  return rows.map((r) => ({ rowid: r.rowid, score: -Number(r.rank) }))
}

// ── 段级三表（v13 §2 / SPEC-2.1）───────────────────────────────────────────────

/**
 * 段表 DDL（v13 §2）。`id` **必须**是 `INTEGER PRIMARY KEY`——只有它是 rowid 的
 * 别名，`kb_chunk_fts.rowid ≡ kb_chunks.id` 的恒等式才成立（N-3）。
 * FTS 自身不能用 INTEGER：显式指定 rowid 需要载体表的 id 与之同源。
 */
export const KB_CHUNKS_DDL = `CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY,
    entry_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    heading_path TEXT NOT NULL,
    char_start INTEGER NOT NULL,
    char_end INTEGER NOT NULL,
    text TEXT NOT NULL
)`

/** 段表按 (entry_id, version) 查删的索引（段路 WHERE 逐字复用条目路过滤）。 */
export const KB_CHUNKS_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_kb_chunks_entry_version ON kb_chunks (entry_id, version)'

/**
 * 段向量（v13 §2）：chunk_id 主键，一段一行。`model` 语义同 kb_vectors——不同模型的
 * 向量不可比，检索只比同模型向量。
 */
export const KB_CHUNK_VECTORS_DDL = `CREATE TABLE IF NOT EXISTS kb_chunk_vectors (
    chunk_id INTEGER PRIMARY KEY,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT 'bge-m3-q8',
    updated_at TEXT NOT NULL
)`

/**
 * 段 FTS（v13 §2）：`rowid ≡ kb_chunks.id`（**非** entries rowid——append-only 假设
 * 在段级不成立）；`seg = bigram(条目标题 + '\\n' + heading_path + '\\n' + text)`，
 * 与条目级 `seg = bigram(标题 + '\\n' + 正文)` 同形态（S-20：标题词在段路可查）。
 */
export const KB_CHUNK_FTS_DDL =
  "CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunk_fts USING fts5(text, seg, tokenize='unicode61')"

/**
 * 确保段级三表存在（构造时执行一次，幂等）。
 * **刻意不走 KNOWLEDGE_SCHEMA_VERSION**：老库升版时会跳过「when 条件不成立」的语句，
 * 而 ensure 式建表对「表已存在」与「表刚建」都安全（同 kb_fts 先例——S-11）。
 */
export function ensureKbChunks(db: PrismDatabase): void {
  db.raw.exec(KB_CHUNKS_DDL)
  db.raw.exec(KB_CHUNKS_INDEX_DDL)
  db.raw.exec(KB_CHUNK_VECTORS_DDL)
  db.raw.exec(KB_CHUNK_FTS_DDL)
}

/** 写入段行后回传的定位信息：chunk_id（段向量外键）与嵌入输入。 */
export interface IndexedChunk {
  /** kb_chunks.id（= kb_chunk_fts.rowid）。 */
  id: number
  /** 段向量嵌入输入 = `标题\nheadingPath\n段文本`（SPEC-1.12）。 */
  embedText: string
}

/**
 * 删除某个条目的**全部版次**段行（段 FTS 行随 rowid 一并删，段向量随 chunk_id 删）。
 * 版次策略「只留最新版」的落地：写新版前先清旧版（先删 FTS/向量——它们的子查询
 * 依赖 kb_chunks 的 id 还在）。
 */
export function deleteChunks(raw: DatabaseSync, entryId: string): void {
  raw
    .prepare('DELETE FROM kb_chunk_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE entry_id = ?)')
    .run(entryId)
  raw
    .prepare('DELETE FROM kb_chunk_vectors WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE entry_id = ?)')
    .run(entryId)
  raw.prepare('DELETE FROM kb_chunks WHERE entry_id = ?').run(entryId)
}

/**
 * 删除全部**自有型**条目的段行（reindex 用：先整体清、再按文件真相重切）。
 * 引用型条目（origin='indexed'）的段行必须原样保留（其真相在项目文件，不在本次扫描
 * 范围内——与 KB-1 的 entries/kb_fts 过滤同源）。
 */
export function deleteOwnedChunks(raw: DatabaseSync): void {
  const owned = "entry_id IN (SELECT id FROM knowledge_entries WHERE origin = 'owned')"
  raw.prepare(`DELETE FROM kb_chunk_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE ${owned})`).run()
  raw.prepare(`DELETE FROM kb_chunk_vectors WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE ${owned})`).run()
  raw.prepare(`DELETE FROM kb_chunks WHERE ${owned}`).run()
}

/**
 * 写一个条目一个版次的段行 + 段 FTS（**恒写**，不依赖嵌入）。调用方负责先
 * `deleteChunks`（版次策略只留最新版）。
 *
 * 返回每段的 (chunk_id, 嵌入输入)，供事务外补段向量——嵌入是异步的，不能进同步事务。
 */
export function indexChunks(
  raw: DatabaseSync,
  entryId: string,
  version: number,
  title: string,
  chunks: ReadonlyArray<Chunk>,
): IndexedChunk[] {
  const insertChunk = raw.prepare(
    `INSERT INTO kb_chunks (entry_id, version, seq, heading_path, char_start, char_end, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertFts = raw.prepare('INSERT INTO kb_chunk_fts(rowid, text, seg) VALUES (?, ?, ?)')
  const out: IndexedChunk[] = []
  for (const chunk of chunks) {
    const info = insertChunk.run(
      entryId,
      version,
      chunk.seq,
      chunk.headingPath,
      chunk.charStart,
      chunk.charEnd,
      chunk.text,
    )
    const id = Number(info.lastInsertRowid)
    const embedText = assembleChunkEmbeddingInput(title, chunk)
    insertFts.run(id, chunk.text, bigram(embedText))
    out.push({ id, embedText })
  }
  return out
}
