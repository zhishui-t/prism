/**
 * 段 BM25 检索提速（v17 §B-6 / SPEC-B6.0–B6.3）。
 *
 * 核心改动：`#chunkBm25Hits` 的 SQL **只取窄列**（`chunk_id`/`entry_rowid`/`rank`），
 * 终排存活段再由 `#hydrateChunkHits` 按主键补回 `text`/`heading_path`/`seq`。故这里的
 * 验收断言是：
 * - **结果一致性（SPEC-B6.2）**：整条融合链（条目 BM25 + 段 BM25，无嵌入）与「旧全列表 SQL
 *   双实现」对照——条目序/集合、每条目 `hits` 的 `seq`/`heading_path`/`score` **逐位相等**；
 * - **明文补取（`text` 逐字）**：经 rerank 取材缝观测「每条目最高段全文」与旧取回路径一致；
 * - **补取规模**：只发生在终排存活段，按主键 `c.id IN (…)`，行数 ≤ `limit×CHUNK_HITS_PER_ENTRY`；
 * - **窄列红线**：段 BM25 SQL 不再携带 `c.text` / `c.heading_path` / `c.seq`。
 *
 * 全部临时目录（R5）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { searchFts } from '../src/index-db.js'
import { PrismKnowledgeService } from '../src/service.js'
import { toMatchExpression } from '../src/tokenize.js'
import { CHUNK_HITS_PER_ENTRY, HYBRID_CANDIDATES, RRF_K, rrfFuse } from '../src/vector.js'

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-bm25narrow-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 段切分收窄：让「一节 = 一段」在小夹具上稳定成立（minChars 小以免相邻节被合并）。 */
const SPLIT = { minChars: 8, maxChars: 400 } as const

const TERM = '独角鲸'

interface Section {
  title: string
  text: string
}

/** 拼一份「多节」文档：每节 `## 标题\n正文`，配合 SPLIT 后一节恰为一段。 */
function sectionDoc(sections: ReadonlyArray<Section>): string {
  return sections.map((s) => `## ${s.title}\n${s.text}\n`).join('')
}

/** 造一节：`withTerm` 决定正文是否含查询词（标题恒不含，heading_path 可预测）。 */
function sec(idx: number, withTerm: boolean): Section {
  return {
    title: `第${idx}节`,
    text: withTerm ? `本节正文第 ${idx} 处写入独角鲸一词。` : `本节正文第 ${idx} 处与查询无关。`,
  }
}

/** 夹具：条目 id → 各节是否含词（`true`/`false` 列表，下标即 seq）。 */
const FIXTURE: ReadonlyArray<readonly [string, readonly boolean[]]> = [
  ['E1', [true, true, true, true, true, true]], // 6 段命中 → 触发 K=4 截断
  ['E2', [false, true, true]],
  ['E3', [true, false]],
  ['E4', [true, true, true, true, true]], // 5 段命中 → 触发截断
  ['E5', [false, false, false]], // 零命中（不进条目路也不进段路）
]

/** 每节标题（seq → heading_path），供「逐字一致」断言用。 */
function titlesOf(flags: readonly boolean[]): string[] {
  return flags.map((_, i) => `第${i}节`)
}

// ── 旧实现的「双实现」参照：全列表 SQL + 同一套纯聚合 ────────────────────────

interface RefHit {
  chunkId: number
  entryRowid: number
  seq: number
  headingPath: string
  text: string
  score: number
}

/** 改动前的 `#chunkBm25Hits`（全列取回），逐字复刻为参照实现。 */
function fullChunkBm25(
  raw: DatabaseSync,
  match: string,
  clauses: string[],
  params: string[],
): RefHit[] {
  const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : ''
  const rows = raw
    .prepare(
      `SELECT c.id AS chunk_id, e.rowid AS entry_rowid, c.seq AS seq,
              c.heading_path AS heading_path, c.text AS text, bm25(kb_chunk_fts) AS rank
       FROM kb_chunk_fts
       JOIN kb_chunks c ON c.id = kb_chunk_fts.rowid
       JOIN knowledge_entries e ON e.id = c.entry_id AND c.version = e.version
       WHERE kb_chunk_fts MATCH ? ${where}
       ORDER BY rank ASC`,
    )
    .all(match, ...params) as unknown as Array<{
    chunk_id: number
    entry_rowid: number
    seq: number
    heading_path: string
    text: string
    rank: number
  }>
  return rows.map((r) => ({
    chunkId: r.chunk_id,
    entryRowid: r.entry_rowid,
    seq: r.seq,
    headingPath: r.heading_path,
    text: r.text,
    score: -Number(r.rank),
  }))
}

/** 改动前纯函数（service.ts 内私有）的语义复刻，仅用于对照。 */
function bestByEntry(hits: readonly RefHit[]): Map<number, number> {
  const best = new Map<number, number>()
  for (const hit of hits) {
    const prev = best.get(hit.entryRowid)
    if (prev === undefined || hit.score > prev) best.set(hit.entryRowid, hit.score)
  }
  return best
}

function entryRank(hits: readonly RefHit[], limit: number): number[] {
  return [...bestByEntry(hits).entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([rowid]) => rowid)
}

/** `groupChunkHits` 的语义复刻（`truncated` 不参与本对照）。 */
function groupByEntry(
  scores: ReadonlyMap<number, number>,
  hits: readonly RefHit[],
  perEntry: number,
): Map<number, RefHit[]> {
  const detail = new Map<number, RefHit>()
  for (const hit of hits) detail.set(hit.chunkId, hit)
  const byEntry = new Map<number, RefHit[]>()
  for (const [chunkId, score] of scores) {
    const source = detail.get(chunkId)
    if (source === undefined) continue
    const item: RefHit = { ...source, score }
    const list = byEntry.get(source.entryRowid)
    if (list === undefined) byEntry.set(source.entryRowid, [item])
    else list.push(item)
  }
  for (const [entry, list] of byEntry) {
    list.sort((a, b) => b.score - a.score)
    if (list.length > perEntry) byEntry.set(entry, list.slice(0, perEntry))
  }
  return byEntry
}

interface RefSummary {
  id: string | undefined
  score: number
  hits: Array<{ seq: number; heading_path: string; score: number }>
  /** 每条目最高段全文（= `groupChunkHits` 第 0 条的 `text`，rerank 取材同源）。 */
  bestText: string | undefined
}

/**
 * 参照实现：整条可见链路（条目 BM25 + 段 BM25 两路 RRF，无嵌入、无引用扩展、无精排）。
 * 段 BM25 用**旧全列 SQL** 取回——这正是「全量取回参照实现」。
 */
function referenceSummary(raw: DatabaseSync, q: string, limit: number): RefSummary[] {
  const match = toMatchExpression(q, 'all')
  const clauses = ["e.is_latest = 1 AND e.status != 'deprecated'"]
  const params: string[] = []
  const pool = Math.max(limit, HYBRID_CANDIDATES)
  const entryBm25Rank = searchFts(raw, {
    match,
    where: clauses.join(' AND '),
    params,
    limit: HYBRID_CANDIDATES,
  }).map((h) => h.rowid)
  const full = fullChunkBm25(raw, match, clauses, params)
  const fused = rrfFuse([entryBm25Rank, [], entryRank(full, pool), []], RRF_K, [1, 1, 1, 1])
  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  const chunkScores = rrfFuse([full.map((h) => h.chunkId), []], RRF_K, [1, 1])
  const byEntry = groupByEntry(chunkScores, full, CHUNK_HITS_PER_ENTRY)
  const rankIds = ranked.map(([rowid]) => rowid)
  const idByRowid = new Map(
    (
      raw
        .prepare(
          `SELECT rowid, id FROM knowledge_entries WHERE rowid IN (${rankIds.map(() => '?').join(', ')})`,
        )
        .all(...rankIds) as unknown as Array<{ rowid: number; id: string }>
    ).map((r) => [r.rowid, r.id]),
  )
  return ranked.map(([rowid, score]) => {
    const list = byEntry.get(rowid) ?? []
    return {
      id: idByRowid.get(rowid),
      score,
      hits: list.map((h) => ({ seq: h.seq, heading_path: h.headingPath, score: h.score })),
      bestText: list[0]?.text,
    }
  })
}

async function depositFixture(kb: PrismKnowledgeService): Promise<void> {
  for (const [id, flags] of FIXTURE) {
    await kb.deposit({
      id,
      title: `段 BM25 提速夹具 ${id}`,
      type: 'doc',
      layer: 'global',
      book: 'b',
      module: 'm',
      content: sectionDoc(flags.map((f, i) => sec(i, f))),
    })
  }
}

// ── SPEC-B6.2 结果一致性：与「全量取回参照实现」逐位对照 ─────────────────────

describe('SPEC-B6.2 段 BM25 提速：结果与全量取回参照实现逐位一致', () => {
  it('条目序/集合 + 每条目 hits(seq/heading_path/score) 与旧全列 SQL 双实现相等', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT, graphFusion: false })
    try {
      await depositFixture(kb)
      const raw = kb.persistence.knowledge.raw

      for (const limit of [10, 2, 3]) {
        const actual = (await kb.searchWithMeta({ q: TERM, limit })).results.map((r) => ({
          id: r.id,
          score: r.score,
          hits: (r.hits ?? []).map((h) => ({ seq: h.seq, heading_path: h.heading_path, score: h.score })),
        }))
        const ref = referenceSummary(raw, TERM, limit)

        // 条目集合与序（SPEC-B6.2 的核心红线）
        expect(actual.map((a) => a.id)).toEqual(ref.map((r) => r.id))
        expect(actual).toHaveLength(ref.length)

        for (let i = 0; i < actual.length; i++) {
          // 段级明细逐条对齐
          expect(actual[i]!.hits.map((h) => [h.seq, h.heading_path])).toEqual(
            ref[i]!.hits.map((h) => [h.seq, h.heading_path]),
          )
          expect(actual[i]!.hits).toHaveLength(ref[i]!.hits.length)
          for (let k = 0; k < actual[i]!.hits.length; k++) {
            expect(actual[i]!.hits[k]!.score).toBeCloseTo(ref[i]!.hits[k]!.score, 12)
          }
          expect(actual[i]!.score).toBeCloseTo(ref[i]!.score, 12)
        }
      }
    } finally {
      kb.close()
    }
  })

  it('补取的段 text 逐字等于库中该段（经 rerank 取材缝观测最高段全文）', async () => {
    const captured: string[][] = []
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: SPLIT,
      graphFusion: false,
      // 取材缝：docs = 每条目最高段全文（`#rerankHead` 读 `chunkHits[0].text`）。
      // 返回全 0 → 头部重赋分为等值，序不变，故可与参照实现在同一序上对照。
      rerank: (_q, docs) => {
        captured.push([...docs])
        return Promise.resolve(docs.map(() => 0))
      },
    })
    try {
      await depositFixture(kb)
      const raw = kb.persistence.knowledge.raw

      const resp = await kb.searchWithMeta({ q: TERM, limit: 10 })
      const ref = referenceSummary(raw, TERM, 10)

      expect(captured).toHaveLength(1)
      const docs = captured[0]!
      const resultIds = resp.results.map((r) => r.id)
      // 序不变（全 0 分稳定重赋）
      expect(resultIds).toEqual(ref.map((r) => r.id))
      // 逐字一致：补回的 text == 旧全列取回的最高段全文
      expect(docs).toEqual(ref.map((r) => r.bestText))
      // 且非空、确含查询词（占位 '' 若漏补会在此暴露）
      for (const doc of docs) {
        expect(doc.length).toBeGreaterThan(0)
        expect(doc).toContain(TERM)
      }
    } finally {
      kb.close()
    }
  })

  it('hits 明文非空且 heading_path 与 seq 对应（占位漏补即失败）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT, graphFusion: false })
    try {
      await depositFixture(kb)
      const resp = await kb.searchWithMeta({ q: TERM })

      expect(resp.results.length).toBeGreaterThan(0)
      expect(resp.hits_truncated).toBe(true) // E1/E4 命中 6/5 段 > K=4

      for (const result of resp.results) {
        const flags = FIXTURE.find(([id]) => id === result.id)![1]
        const titles = titlesOf(flags)
        const hits = result.hits ?? []
        expect(hits.length).toBeGreaterThan(0)
        expect(hits.length).toBeLessThanOrEqual(CHUNK_HITS_PER_ENTRY)
        for (const hit of hits) {
          expect(hit.heading_path).toBe(titles[hit.seq]) // 逐字一致
          expect(hit.heading_path.length).toBeGreaterThan(0)
          expect(hit.excerpt.length).toBeGreaterThan(0)
          expect(hit.excerpt).toContain(TERM)
          expect(hit.score).toBeGreaterThan(0)
        }
      }
    } finally {
      kb.close()
    }
  })
})

// ── 补取规模与形态（可观测） ──────────────────────────────────────────────────

describe('SPEC-B6.2 补取只发生在终排存活段', () => {
  it('补取按主键 c.id IN，一次调用、行数 ≤ limit×CHUNK_HITS_PER_ENTRY；段 BM25 SQL 不取大列', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT, graphFusion: false })
    try {
      await depositFixture(kb)
      const raw = kb.persistence.knowledge.raw
      const origPrepare = raw.prepare
      const sqls: string[] = []
      ;(raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        sqls.push(sql)
        return origPrepare.call(raw, sql)
      }
      try {
        const limit = 2
        const resp = await kb.searchWithMeta({ q: TERM, limit })
        expect(resp.results).toHaveLength(2)

        // ① 段 BM25 窄列红线：MATCH 查询里不再出现 c.text / c.heading_path / c.seq
        const chunkSql = sqls.filter((s) => s.includes('FROM kb_chunk_fts'))
        expect(chunkSql).toHaveLength(1)
        expect(chunkSql[0]).not.toContain('c.text')
        expect(chunkSql[0]).not.toContain('c.heading_path')
        expect(chunkSql[0]).not.toContain('c.seq')

        // ② 补取恰一次、走主键、且行数受限
        const hydrateSql = sqls.filter((s) => s.includes('FROM kb_chunks c WHERE c.id IN'))
        expect(hydrateSql).toHaveLength(1)
        const placeholders = (hydrateSql[0]!.match(/\?/g) ?? []).length
        expect(placeholders).toBeGreaterThan(0)
        expect(placeholders).toBeLessThanOrEqual(limit * CHUNK_HITS_PER_ENTRY)
        // 不得复用 FTS 全扫补取（侦察反面教材）
        expect(hydrateSql[0]).not.toContain('MATCH')
      } finally {
        delete (raw as unknown as Record<string, unknown>).prepare
      }
    } finally {
      kb.close()
    }
  })

  it('零段命中（all_versions=true → 段路不参与）时零补取', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT, graphFusion: false })
    try {
      await depositFixture(kb)
      const raw = kb.persistence.knowledge.raw
      const origPrepare = raw.prepare
      const sqls: string[] = []
      ;(raw as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
        sqls.push(sql)
        return origPrepare.call(raw, sql)
      }
      try {
        const resp = await kb.searchWithMeta({ q: TERM, all_versions: true })
        expect(resp.results.length).toBeGreaterThan(0)
        expect(sqls.some((s) => s.includes('FROM kb_chunks c WHERE c.id IN'))).toBe(false)
      } finally {
        delete (raw as unknown as Record<string, unknown>).prepare
      }
    } finally {
      kb.close()
    }
  })
})
