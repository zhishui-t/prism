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
