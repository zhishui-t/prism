/**
 * 段级检索融合（v13 §4 / SPEC-3.1～3.7）。
 *
 * 单层四路 RRF：条目 BM25 / 条目向量 / 段 BM25 / 段向量。四条路只有两条是新的，
 * 故这里既测新行为，也测「不回归」的两条底线：
 * - SPEC-3.4② 全库无 chunks → 与改动前的固定基线**逐字节一致**（`fixtures/search-baseline.json`，
 *   由改动前的代码录制，见下）；
 * - SPEC-3.6 `search()` 的 `SearchResult[]` 形状不变，`hits` 缺省不下发。
 *
 * 全部临时目录（R5）：home 一律 mkdtemp，不碰真实宿主目录。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { RRF_K } from '../src/vector.js'
import type { SearchQuery, SearchResult } from '../src/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-csearch-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 段切分收窄：让「一节 = 一段」在小夹具上稳定成立（minChars 小以免相邻节被合并）。 */
const SPLIT = { minChars: 8, maxChars: 400 } as const

/** 语义桶假 embedding：同桶余弦 1、跨桶正交（0 < VECTOR_FLOOR → 被过滤）。 */
const BUCKETS: string[][] = [['苹果', '手机', 'iphone', 'apple', 'phone']]

function bucketEmbed(text: string): Promise<Float32Array | null> {
  const lower = text.toLowerCase()
  const hit = BUCKETS.findIndex((kws) => kws.some((kw) => lower.includes(kw)))
  if (hit < 0) return Promise.resolve(null)
  const v = new Float32Array(BUCKETS.length)
  v[hit] = 1
  return Promise.resolve(v)
}

/** 拼一份「多节」文档：每节 `## 标题\n正文`，配合 SPLIT 后一节恰为一段。 */
function sectionDoc(sections: ReadonlyArray<{ title: string; text: string }>): string {
  return sections.map((s) => `## ${s.title}\n${s.text}\n`).join('')
}

interface ChunkRow {
  seq: number
  heading_path: string
  text: string
  char_start: number
  char_end: number
}

function chunksOf(kb: PrismKnowledgeService, entryId: string): ChunkRow[] {
  return kb.persistence.knowledge.raw
    .prepare('SELECT seq, heading_path, text, char_start, char_end FROM kb_chunks WHERE entry_id = ? ORDER BY seq')
    .all(entryId) as unknown as ChunkRow[]
}

/** 段路命中数（直接问 `hits` 字段；缺省不下发 → 0）。 */
function hitCount(result: SearchResult | undefined): number {
  return result?.hits?.length ?? 0
}

// ── SPEC-3.1 段级 BM25 ────────────────────────────────────────────────────────

describe('SPEC-3.1 段级 BM25：命中词只在第 3 段 → hits 给出段定位', () => {
  it('条目命中且 hits = [{seq:2, heading_path, excerpt}]（wire 一律 snake_case）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'S31',
        title: '分段检索夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([
          { title: '甲章', text: '甲甲内容写在这里，与查询无关。' },
          { title: '乙章', text: '乙乙内容写在这里，同样无关。' },
          { title: '丙章', text: '丙丙内容，独角鲸只出现在这一段。' },
        ]),
      })
      expect(chunksOf(kb, 'S31').map((c) => c.heading_path)).toEqual(['甲章', '乙章', '丙章'])

      const [top] = await kb.search({ q: '独角鲸' })
      expect(top?.id).toBe('S31')
      expect(top?.hits).toHaveLength(1)

      const hit = top!.hits![0]!
      expect(hit.seq).toBe(2)
      expect(hit.heading_path).toBe('丙章')
      expect(hit.excerpt).toContain('独角鲸')
      expect(hit.score).toBeGreaterThan(0)
      // wire 形状：snake_case；且**不带**内部 camelCase 名
      expect(Object.keys(hit)).toEqual(['seq', 'heading_path', 'excerpt', 'score'])
      expect('headingPath' in hit).toBe(false)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-3.2 段级向量 ─────────────────────────────────────────────────────────

describe('SPEC-3.2 段级向量：语义近段（无共同词）召回并给段定位', () => {
  it('查询「苹果」→ 只有第 3 段含 iPhone（词面零重叠），hits 落在该段', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: SPLIT,
      embed: bucketEmbed,
      embeddingModel: 'test-1d',
    })
    try {
      await kb.deposit({
        id: 'S32',
        title: '选品说明',
        type: 'doc',
        layer: 'global',
        book: 'gadgets',
        module: 'm',
        content: sectionDoc([
          { title: '甲章', text: '本节描述包装与物流。' },
          { title: '乙章', text: '本节描述保修与退换。' },
          { title: '丙章', text: '本节描述 iPhone 配件清单。' },
        ]),
      })

      // 「苹果」与全文词面零重叠 → 关键词两路都不可能命中；只有段向量路能定位
      const [top] = await kb.search({ q: '苹果', hybrid: false })
      expect(top).toBeUndefined()

      const [hit] = await kb.search({ q: '苹果' })
      expect(hit?.id).toBe('S32')
      expect(hit?.hits).toHaveLength(1)
      expect(hit!.hits![0]!.seq).toBe(2)
      expect(hit!.hits![0]!.heading_path).toBe('丙章')

      // 段向量落库口径对照：只有第 3 段（含 iPhone）有向量
      const vecCount = kb.persistence.knowledge.raw
        .prepare(
          `SELECT COUNT(*) AS c FROM kb_chunk_vectors v
           JOIN kb_chunks c ON c.id = v.chunk_id WHERE c.entry_id = ?`,
        )
        .get('S32') as { c: number }
      expect(Number(vecCount.c)).toBe(1)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-3.3 聚合与 hits 预算 ─────────────────────────────────────────────────

describe('SPEC-3.3 聚合与预算：一条目一记录、hits 按段分降序、K=4 截断不静默', () => {
  it('同条目 6 段命中 → 1 条记录、hits 仅 4 条、hits_truncated=true', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'S33',
        title: '预算夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc(
          Array.from({ length: 6 }, (_, i) => ({
            title: `第 ${i + 1} 节`,
            text: `独角鲸在本节第 ${i + 1} 次出现，用于命中预算测试。`,
          })),
        ),
      })
      expect(chunksOf(kb, 'S33')).toHaveLength(6)

      const resp = await kb.searchWithMeta({ q: '独角鲸', limit: 10 })
      expect(resp.results).toHaveLength(1) // 一条目一记录
      const hits = resp.results[0]!.hits!
      expect(hits).toHaveLength(4) // K = 4
      expect(resp.hits_truncated).toBe(true) // 截断不静默

      // hits 按段分降序
      const scores = hits.map((h) => h.score)
      expect([...scores].sort((a, b) => b - a)).toEqual(scores)

      // 全局上限 = limit × K
      const total = resp.results.reduce((n, r) => n + hitCount(r), 0)
      expect(total).toBeLessThanOrEqual(resp.results.length * 4)

      // 未超 K 的条目不留标记
      const single = await kb.searchWithMeta({ q: '独角鲸' })
      expect(single.results).toHaveLength(1)
      expect(single.hits_truncated).toBe(true)
    } finally {
      kb.close()
    }
  })

  it('hits 未超 K 时不置 hits_truncated（缺省不下发）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'S33B',
        title: '小预算夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([
          { title: '甲章', text: '独角鲸只在这里出现一次。' },
          { title: '乙章', text: '本节与查询无关的正文。' },
        ]),
      })
      const resp = await kb.searchWithMeta({ q: '独角鲸' })
      expect(resp.results[0]!.hits).toHaveLength(1)
      expect('hits_truncated' in resp).toBe(false)
      expect('chunk_scan_degraded' in resp).toBe(false)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-3.4a 权重映射 ────────────────────────────────────────────────────────

describe('SPEC-3.4a 权重映射：keyword 管两条 BM25 路、vector 管两条向量路', () => {
  it('keyword=0 → 条目 BM25 与段 BM25 同时关闭（无嵌入时全路缺席）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'W-K0',
        title: '权重夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([{ title: '甲章', text: '独角鲸出现在这一段里。' }]),
      })

      const on = await kb.searchWithMeta({ q: '独角鲸' })
      expect(on.results).toHaveLength(1)
      expect(on.results[0]!.hits).toHaveLength(1)

      // keyword=0：两条 BM25 路同时关闭 → 未装配嵌入时四条路全缺席
      const off = await kb.searchWithMeta({ q: '独角鲸', route_weights: { keyword: 0, vector: 1 } })
      expect(off.results).toEqual([])
    } finally {
      kb.close()
    }
  })

  it('vector=0 → 条目向量与段向量同时关闭（词面零重叠的查询彻底零命中）', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: SPLIT,
      embed: bucketEmbed,
      embeddingModel: 'test-1d',
    })
    try {
      await kb.deposit({
        id: 'W-V0',
        title: '权重夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([{ title: '甲章', text: '本节描述 iPhone 配件。' }]),
      })

      const on = await kb.searchWithMeta({ q: '苹果' })
      expect(on.results).toHaveLength(1)
      expect(on.results[0]!.hits).toHaveLength(1)

      const off = await kb.searchWithMeta({ q: '苹果', route_weights: { keyword: 1, vector: 0 } })
      expect(off.results).toEqual([])
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-3.5 过滤与版本同源 ───────────────────────────────────────────────────

describe('SPEC-3.5 段路过滤同源', () => {
  it('软删条目段路不可见；restore 后段路与 hits 恢复', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'F-SOFT',
        title: '软删夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([{ title: '甲章', text: '独角鲸出现在这一段里。' }]),
      })
      expect((await kb.search({ q: '独角鲸' })).map((r) => r.id)).toEqual(['F-SOFT'])

      await kb.remove('F-SOFT')
      expect(await kb.search({ q: '独角鲸' })).toEqual([])

      await kb.restore('F-SOFT')
      const [again] = await kb.search({ q: '独角鲸' })
      expect(again?.id).toBe('F-SOFT')
      expect(again?.hits).toHaveLength(1)
    } finally {
      kb.close()
    }
  })

  it('book / module / owner 过滤对段路与条目路同源', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      const base = {
        title: '过滤夹具',
        type: 'doc' as const,
        content: sectionDoc([{ title: '甲章', text: '独角鲸出现在这一段里。' }]),
      }
      await kb.deposit({ ...base, id: 'F-G1', layer: 'global', book: 'book-a', module: 'mod-a' })
      await kb.deposit({ ...base, id: 'F-G2', layer: 'global', book: 'book-b', module: 'mod-b' })
      await kb.deposit({ ...base, id: 'F-P1', layer: 'project', owner: 'owner-a', book: 'book-c', module: 'mod-c' })
      await kb.deposit({ ...base, id: 'F-P2', layer: 'project', owner: 'owner-b', book: 'book-d', module: 'mod-d' })

      expect((await kb.search({ q: '独角鲸' })).map((r) => r.id).sort()).toEqual([
        'F-G1',
        'F-G2',
        'F-P1',
        'F-P2',
      ])

      const byBook = await kb.search({ q: '独角鲸', book: 'book-a' })
      expect(byBook.map((r) => r.id)).toEqual(['F-G1'])
      expect(byBook[0]!.hits).toHaveLength(1) // 段路同样被 book 过滤

      const byModule = await kb.search({ q: '独角鲸', module: 'mod-b' })
      expect(byModule.map((r) => r.id)).toEqual(['F-G2'])

      const byOwner = await kb.search({ q: '独角鲸', owner: 'owner-a' })
      expect(byOwner.map((r) => r.id)).toEqual(['F-P1'])

      // 反向：过滤到别的 book 时，段路不得漏出
      const none = await kb.search({ q: '独角鲸', book: 'book-zzz' })
      expect(none).toEqual([])
    } finally {
      kb.close()
    }
  })

  it('v.model 绑定：换模型后旧段向量不参与；reindex 重算后恢复', async () => {
    const home = makeHome()
    const first = new PrismKnowledgeService({
      home,
      chunkOptions: SPLIT,
      embed: bucketEmbed,
      embeddingModel: 'model-1',
    })
    try {
      await first.deposit({
        id: 'F-MODEL',
        title: '模型夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([{ title: '甲章', text: '本节描述 iPhone 配件清单。' }]),
      })
      expect((await first.search({ q: '苹果' })).map((r) => r.id)).toEqual(['F-MODEL'])
    } finally {
      first.close()
    }

    // 换成 model-2：kb_chunk_vectors / kb_vectors 里仍是 model-1 的行 → 两条向量路都必须缺席
    const second = new PrismKnowledgeService({
      home,
      chunkOptions: SPLIT,
      embed: bucketEmbed,
      embeddingModel: 'model-2',
    })
    try {
      expect(await second.search({ q: '苹果' })).toEqual([])

      await second.reindex()
      const [restored] = await second.search({ q: '苹果' })
      expect(restored?.id).toBe('F-MODEL')
      expect(restored?.hits).toHaveLength(1)
      const row = second.persistence.knowledge.raw
        .prepare('SELECT model FROM kb_chunk_vectors LIMIT 1')
        .get() as { model: string }
      expect(row.model).toBe('model-2')
    } finally {
      second.close()
    }
  })

  it('all_versions=true → 段级两路整体不参与（段只存最新版）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'F-VER',
        title: '版次夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([{ title: '甲章', text: '独角鲸出现在这一段里。' }]),
      })

      const latest = await kb.search({ q: '独角鲸' })
      expect(latest[0]!.hits).toHaveLength(1)

      const all = await kb.search({ q: '独角鲸', all_versions: true })
      expect(all.map((r) => r.id)).toEqual(['F-VER'])
      expect(hitCount(all[0])).toBe(0)
      expect('hits' in all[0]!).toBe(false)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-3.6 兼容与契约链 ─────────────────────────────────────────────────────

describe('SPEC-3.6 旧消费方兼容', () => {
  it('search() 仍返回 SearchResult[]，且与 searchWithMeta().results 逐字段相等', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'C-1',
        title: '兼容夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([{ title: '甲章', text: '独角鲸出现在这一段里。' }]),
      })
      const plain: SearchResult[] = await kb.search({ q: '独角鲸' })
      const meta = await kb.searchWithMeta({ q: '独角鲸' })
      expect(Array.isArray(plain)).toBe(true)
      expect(plain).toEqual(meta.results)
      expect(JSON.stringify(plain)).toBe(JSON.stringify(meta.results))
    } finally {
      kb.close()
    }
  })

  it('无段路结果的响应不含 hits 键；空结果也不含任何标记键', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'C-2',
        title: '兼容夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([{ title: '甲章', text: '独角鲸出现在这一段里。' }]),
      })

      // all_versions=true → 段级两路不参与 → 响应与条目都不带 hits
      const all = await kb.searchWithMeta({ q: '独角鲸', all_versions: true })
      expect(JSON.stringify(all)).not.toContain('"hits"')
      expect(JSON.stringify(all)).not.toContain('"hits_truncated"')
      expect(JSON.stringify(all)).not.toContain('"chunk_scan_degraded"')

      // 零结果：只有 results 一个键
      const empty = await kb.searchWithMeta({ q: '量子纠缠' })
      expect(empty.results).toEqual([])
      expect(Object.keys(empty)).toEqual(['results'])
    } finally {
      kb.close()
    }
  })

  it('契约链单一真相：port.ts 只有 re-export，没有镜像定义', () => {
    const portPath = join(HERE, '..', '..', 'server', 'src', 'kb', 'port.ts')
    const port = readFileSync(portPath, 'utf-8')
    // v8 的「镜像契约漂移」教训：server 侧不得再定义一份 SearchResult / SearchHit
    expect(port).not.toMatch(/interface\s+SearchResult\b/)
    expect(port).not.toMatch(/interface\s+SearchHit\b/)
    expect(port).not.toMatch(/interface\s+SearchResponse\b/)
    expect(port).toContain("from '@prism/knowledge'")
  })
})

// ── SPEC-3.7 扫描护栏 + 段 BM25 无 LIMIT ──────────────────────────────────────

describe('SPEC-3.7 段向量全扫护栏', () => {
  it('超 vectorScanCap → 段向量路整体缺席 + chunk_scan_degraded（条目向量路仍在）', async () => {
    const build = (vectorScanCap: number): PrismKnowledgeService =>
      new PrismKnowledgeService({
        home: makeHome(),
        chunkOptions: SPLIT,
        embed: bucketEmbed,
        embeddingModel: 'test-1d',
        vectorScanCap,
      })

    // 同一份数据、同一查询，只差扫描上限。夹具里 **2 段有向量**（甲章无桶词 → 不写向量），
    // 故扫描量 = 2：cap=1 超限降级、cap=2 恰好不超限（判据是 `> cap`，不是 `>=`）。
    for (const [cap, degraded] of [
      [1, true],
      [2, false],
      [50_000, false],
    ] as const) {
      const kb = build(cap)
      try {
        await kb.deposit({
          id: 'G-1',
          title: '护栏夹具',
          type: 'doc',
          layer: 'global',
          book: 'b',
          module: 'm',
          content: sectionDoc([
            { title: '甲章', text: '本节描述包装与物流。' },
            { title: '乙章', text: '本节描述 iPhone 包装。' },
            { title: '丙章', text: '本节描述 iPhone 配件清单。' },
          ]),
        })
        expect(chunksOf(kb, 'G-1')).toHaveLength(3)
        const vectors = kb.persistence.knowledge.raw
          .prepare('SELECT COUNT(*) AS c FROM kb_chunk_vectors')
          .get() as { c: number }
        expect(Number(vectors.c)).toBe(2)

        const resp = await kb.searchWithMeta({ q: '苹果' })
        // 条目仍由**条目向量路**召回（那条路不受段扫描上限影响）
        expect(resp.results.map((r) => r.id)).toEqual(['G-1'])
        if (degraded) {
          expect(resp.chunk_scan_degraded).toBe(true)
          // 段向量路整体缺席 → 无段定位
          expect(hitCount(resp.results[0])).toBe(0)
        } else {
          expect('chunk_scan_degraded' in resp).toBe(false)
          expect(resp.results[0]!.hits).toHaveLength(2)
        }
      } finally {
        kb.close()
      }
    }
  })

  it('段 BM25 不带小 LIMIT：hybrid_candidates=2 时仍能通过段路找回 >2 个条目', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      for (let i = 0; i < 5; i++) {
        await kb.deposit({
          id: `L-${i}`,
          title: `段路夹具 ${i}`,
          type: 'doc',
          layer: 'global',
          book: 'b',
          module: 'm',
          content: sectionDoc([{ title: '甲章', text: `独角鲸在第 ${i} 篇出现。` }]),
        })
      }

      // 条目 BM25 路被 hybrid_candidates=2 截到 2 个条目；段 BM25 路**全匹配后聚合**，
      // 故池（= max(limit, candidates)）里能补齐其余 3 个——若段路 SQL 也带 LIMIT 2，
      // 并集最多 4 个条目，本断言即失败。
      const wide = await kb.search({ q: '独角鲸', hybrid_candidates: 2, limit: 5 })
      expect(wide).toHaveLength(5)

      // 对照：limit 也收窄到 2 时只剩 2 个
      const narrow = await kb.search({ q: '独角鲸', hybrid_candidates: 2, limit: 2 })
      expect(narrow).toHaveLength(2)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-3.4 回落链拆清 ───────────────────────────────────────────────────────

describe('SPEC-3.4① 嵌入未装 + 有 chunks → 条目 + 段两路 BM25 融合（刻意变更）', () => {
  it('两路 BM25 融合有结果，且段路确实参与（hits 非空）', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT })
    try {
      await kb.deposit({
        id: 'R-1',
        title: '回落夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([
          { title: '甲章', text: '甲章正文与查询无关。' },
          { title: '乙章', text: '乙章正文含独角鲸一词。' },
        ]),
      })

      const resp = await kb.searchWithMeta({ q: '独角鲸' })
      expect(resp.results.map((r) => r.id)).toEqual(['R-1'])
      // 段级 route 参与（这正是与「纯 BM25」的刻意差异——design §4 M-8）
      expect(resp.results[0]!.hits).toHaveLength(1)
      expect(resp.results[0]!.hits![0]!.seq).toBe(1)
      // 分数是 RRF 融合分（两条 BM25 路各贡献一份），不再是 -bm25
      expect(resp.results[0]!.score).toBeCloseTo(2 / (RRF_K + 1), 10)
    } finally {
      kb.close()
    }
  })
})

describe('SPEC-3.4② 全库无 chunks → 与改动前基线逐字节一致', () => {
  it('固定语料（无 chunks 库）的全部查询与 fixtures/search-baseline.json 深度相等', async () => {
    const fixture = JSON.parse(
      readFileSync(join(HERE, 'fixtures', 'search-baseline.json'), 'utf-8'),
    ) as {
      corpus: Array<Record<string, unknown>>
      queries: SearchQuery[]
      noEmbed: Array<{ query: SearchQuery; results: unknown[] }>
      withEmbed: Array<{ query: SearchQuery; results: unknown[] }>
    }

    // 录制脚本用的同一套语义桶（改动前录制，脚本已删除；两侧漂移则本用例失败）
    const recordBuckets: string[][] = [
      ['性能', '缓存', 'cache', 'performance'],
      ['日志', 'log', 'trace'],
    ]
    const recordingEmbed = (text: string): Promise<Float32Array | null> => {
      const lower = text.toLowerCase()
      for (let i = 0; i < recordBuckets.length; i++) {
        if (recordBuckets[i]!.some((kw) => lower.includes(kw))) {
          const v = new Float32Array(recordBuckets.length)
          v[i] = 1
          return Promise.resolve(v)
        }
      }
      return Promise.resolve(null)
    }

    const replay = async (
      embed: ((text: string) => Promise<Float32Array | null>) | undefined,
    ): Promise<string[]> => {
      const home = makeHome()
      const kb = new PrismKnowledgeService(embed === undefined ? { home } : { home, embed })
      try {
        for (const entry of fixture.corpus) {
          await kb.deposit(entry as never)
        }
        // 模拟存量库（未跑 `kb reindex --chunks`）：全库零 chunks → 必须走现状路径
        kb.persistence.knowledge.raw.exec('DELETE FROM kb_chunk_fts')
        kb.persistence.knowledge.raw.exec('DELETE FROM kb_chunk_vectors')
        kb.persistence.knowledge.raw.exec('DELETE FROM kb_chunks')
        expect(
          (kb.persistence.knowledge.raw.prepare('SELECT COUNT(*) AS c FROM kb_chunks').get() as {
            c: number
          }).c,
        ).toBe(0)

        const out: string[] = []
        for (const query of fixture.queries) {
          out.push(JSON.stringify(await kb.search(query)))
        }
        return out
      } finally {
        kb.close()
      }
    }

    const frozen = (rows: Array<{ results: unknown[] }>): string[] =>
      rows.map((row) => JSON.stringify(row.results))

    expect(await replay(undefined)).toEqual(frozen(fixture.noEmbed))
    expect(await replay(recordingEmbed)).toEqual(frozen(fixture.withEmbed))
  }, 60_000)
})

// ── 幂等 / 确定性 ─────────────────────────────────────────────────────────────

describe('幂等与确定性', () => {
  it('同查询两次调用逐字段相等（含 hits 与标记位）', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: SPLIT,
      embed: bucketEmbed,
      embeddingModel: 'test-1d',
    })
    try {
      await kb.deposit({
        id: 'D-1',
        title: '确定性夹具',
        type: 'doc',
        layer: 'global',
        book: 'b',
        module: 'm',
        content: sectionDoc([
          { title: '甲章', text: '本节描述 iPhone 配件与独角鲸。' },
          { title: '乙章', text: '本节描述包装与物流。' },
        ]),
      })
      const queries: SearchQuery[] = [
        { q: '独角鲸' },
        { q: '苹果' },
        { q: '配件 物流', match_mode: 'any', limit: 5 },
        { q: '独角鲸', limit: 1 },
      ]
      for (const query of queries) {
        expect(JSON.stringify(await kb.searchWithMeta(query))).toBe(
          JSON.stringify(await kb.searchWithMeta(query)),
        )
      }
    } finally {
      kb.close()
    }
  })
})
