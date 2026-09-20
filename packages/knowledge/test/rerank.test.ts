/**
 * 检索接入精排（v14 §1.2 / SPEC-1.1–1.7；M4 单调重赋分、S6 段全文取材）。
 *
 * 接入点：四路 RRF 融合出序、`hits` 已挂、**overrides 之前**（全序见 B-2）。
 * 注入模式与 `embed` 完全一致——knowledge 包不依赖 server，`/rerank` 调用在 server 侧
 * （`packages/server/test/kb-rerank.test.ts` 覆盖 fetch 层四态）。
 *
 * 全部临时目录（R5）：home 一律 mkdtemp，不碰真实宿主目录。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import type { KnowledgeServiceOptions, SearchResponse } from '../src/types.js'

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-rerank-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 段切分收窄：让「一节 = 一段」在小夹具上稳定成立。 */
const SPLIT = { minChars: 8, maxChars: 400 } as const

/** 180 字符正文（> 摘要窗口 120）——保证「段全文 ≠ excerpt」这一断言可证。 */
const LONG = '独角鲸'.repeat(60)

const QUERY = '独角鲸'

/** 拼一份「多节」文档：每节 `## 标题\n正文`。 */
function sectionDoc(sections: ReadonlyArray<{ title: string; text: string }>): string {
  return sections.map((s) => `## ${s.title}\n${s.text}\n`).join('')
}

/**
 * 夹具五条 + 一条「多段命中」：
 * - A/B/C：正文含查询词 → 段级命中（S6 取段全文的那条路）
 * - D：**只有标题**含查询词（正文没有）——注意段 FTS 的 `seg` 列是
 *   `bigram(assembleChunkEmbeddingInput(title, chunk))`，**标题也算段级命中**，
 *   所以 D 同样有 hits（要测「无 hits 回落摘要」得让段路整体缺席，见
 *   `all_versions=true` 那条用例）
 * - E：6 段全含查询词 → hits 被 `CHUNK_HITS_PER_ENTRY=4` 截断（`hits_truncated`）
 */
const ENTRIES: ReadonlyArray<{ id: string; title: string; content: string }> = [
  {
    id: 'RR-A',
    title: '甲文档',
    content: sectionDoc([
      { title: '甲一', text: `独角鲸甲 ${LONG}` },
      { title: '甲二', text: '与检索无关的甲二内容。' },
    ]),
  },
  { id: 'RR-B', title: '乙文档', content: sectionDoc([{ title: '乙一', text: `独角鲸乙 ${LONG}` }]) },
  { id: 'RR-C', title: '丙文档', content: sectionDoc([{ title: '丙一', text: `独角鲸丙 ${LONG}` }]) },
  {
    // 只有标题含查询词：段文本里没有 → 该条目没有 hits
    id: 'RR-D',
    title: '独角鲸丁文档',
    content: sectionDoc([{ title: '丁一', text: '正文完全不含那个检索词。' }]),
  },
  {
    id: 'RR-E',
    title: '戊文档',
    content: sectionDoc(
      Array.from({ length: 6 }, (_, i) => ({ title: `戊${i + 1}`, text: `独角鲸戊${i + 1} ${LONG}` })),
    ),
  },
]

/** 建一个 kb 并灌入夹具（同一顺序 → 两次建库的 rowid/BM25 完全一致，可跨库逐字节比对）。 */
async function makeKb(
  options: Partial<KnowledgeServiceOptions> = {},
): Promise<PrismKnowledgeService> {
  const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT, ...options })
  for (const entry of ENTRIES) {
    await kb.deposit({
      id: entry.id,
      title: entry.title,
      type: 'doc',
      layer: 'global',
      book: 'b',
      module: 'm',
      content: entry.content,
    })
  }
  return kb
}

async function searchOf(kb: PrismKnowledgeService): Promise<SearchResponse> {
  // `searchWithMeta` 与 `search` 同源同结果（多带回响应级标记与 hits）；`search()` 的
  // 数组契约同样走本路径，下面有一条专门断言两者一致。
  return kb.searchWithMeta({ q: QUERY, limit: 10 })
}

interface ChunkRow {
  seq: number
  heading_path: string
  text: string
}

/** 库里的段行（按 seq）——用来证「送进 rerank 的是段**全文**」。 */
function chunksOf(kb: PrismKnowledgeService, entryId: string): ChunkRow[] {
  return kb.persistence.knowledge.raw
    .prepare('SELECT seq, heading_path, text FROM kb_chunks WHERE entry_id = ? ORDER BY seq')
    .all(entryId) as unknown as ChunkRow[]
}

/** 故意「把头部反过来」的假精排：分数随入参递增 → 重排后头部顺序反转（易断言）。 */
function reversingRerank(): {
  fn: (query: string, docs: string[]) => Promise<number[] | null>
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    fn: async (_query, docs) => {
      calls.push([...docs])
      return docs.map((_, i) => i)
    },
  }
}

function scoresDescending(results: SearchResponse): boolean {
  for (let i = 1; i < results.results.length; i++) {
    if (results.results[i]!.score > results.results[i - 1]!.score) return false
  }
  return true
}

// ── SPEC-1.1 / M4 / S6 ──────────────────────────────────────────────────────

describe('SPEC-1.1 头部重排：段全文组对、按序重赋单调分、尾部不动（M4/S6）', () => {
  it('一次请求精排头部、头部序按新分、尾部序与分不动、response 内 score 单调不增', async () => {
    const baseKb = await makeKb()
    const rerank = reversingRerank()
    const kb = await makeKb({ rerankCandidates: 24, rerank: rerank.fn })
    try {
      const base = await searchOf(baseKb)
      const got = await searchOf(kb)

      expect(base.results).toHaveLength(ENTRIES.length) // 五条都在（D 靠标题命中）
      // 一次请求（数组输入），候选数 = min(档定值, 已召回条数)
      expect(rerank.calls).toHaveLength(1)
      const docs = rerank.calls[0]!
      expect(docs).toHaveLength(Math.min(24, base.results.length))
      // `search()` 的数组契约与 `searchWithMeta().results` 同源同结果（精排对两者都生效）
      expect(await kb.search({ q: QUERY, limit: 10 })).toEqual(got.results)
      expect(rerank.calls).toHaveLength(2) // 第二次检索又发了一次（每次请求一次）

      const headCount = Math.min(24, base.results.length)
      const baseIds = base.results.map((r) => r.id)
      expect(got.results.map((r) => r.id)).toEqual([
        ...baseIds.slice(0, headCount).reverse(),
        ...baseIds.slice(headCount),
      ])

      // M4：头部**分值域保持**（多集相等、降序指派），尾部分数一字不改
      const baseHeadScores = base.results.slice(0, headCount).map((r) => r.score).sort((a, b) => b - a)
      expect(got.results.slice(0, headCount).map((r) => r.score)).toEqual(baseHeadScores)
      expect(got.results.slice(headCount).map((r) => r.score)).toEqual(
        base.results.slice(headCount).map((r) => r.score),
      )
      // 响应内 score 随 rank 单调不增（宿主按分排序不会撤销精排）
      expect(scoresDescending(got)).toBe(true)

      // S6：组对取材——有段级命中的用**最高分段的 chunk 全文**（`hit.text`，
      // 不是给人看的 `excerpt`），hits 被截断的条目同样按已有最高段取材
      let differsFromEntryExcerpt = 0
      let differsFromHitExcerpt = 0
      for (let i = 0; i < headCount; i++) {
        const b = base.results[i]!
        const doc = docs[i]!
        const top = b.hits?.[0]
        expect(top, `${b.id} 应有段级命中（夹具里每条都被段路命中）`).toBeDefined()
        const full = chunksOf(baseKb, b.id).find((c) => c.seq === top!.seq)
        expect(full).toBeDefined()
        expect(doc).toBe(full!.text)
        if (full!.text !== b.excerpt) differsFromEntryExcerpt++
        if (full!.text !== top!.excerpt) differsFromHitExcerpt++
      }
      // 取材确为「段全文」而非摘要：至少有一条目上全文 ≠ 条目摘要、≠ 段摘要
      expect(differsFromEntryExcerpt).toBeGreaterThan(0)
      expect(differsFromHitExcerpt).toBeGreaterThan(0)
      // 长段（RR-A 的正文段 185 字符）不受摘要窗口（120）截断
      const longIndex = base.results.findIndex((r) => r.id === 'RR-A')
      expect(longIndex).toBeGreaterThanOrEqual(0)
      expect(docs[longIndex]!.length).toBeGreaterThan(120)
    } finally {
      baseKb.close()
      kb.close()
    }
  })

  it('S6 回落：段路整体缺席（all_versions=true）→ 组对用条目摘要', async () => {
    const baseKb = await makeKb()
    const rerank = reversingRerank()
    const kb = await makeKb({ rerankCandidates: 24, rerank: rerank.fn })
    try {
      const base = await baseKb.searchWithMeta({ q: QUERY, limit: 10, all_versions: true })
      const got = await kb.searchWithMeta({ q: QUERY, limit: 10, all_versions: true })
      // 前提：全版本检索时段级两路整体不参与（段只存最新版）→ 一条 hits 都没有
      expect(base.results.length).toBeGreaterThan(1)
      expect(base.results.every((r) => r.hits === undefined)).toBe(true)

      expect(rerank.calls).toHaveLength(1)
      const docs = rerank.calls[0]!
      expect(docs).toHaveLength(base.results.length)
      for (let i = 0; i < base.results.length; i++) expect(docs[i]).toBe(base.results[i]!.excerpt)
      // 重排本身照常生效（回落只影响「喂什么」，不影响「排不排」）
      expect(got.results.map((r) => r.id)).toEqual(base.results.map((r) => r.id).reverse())
      expect(scoresDescending(got)).toBe(true)
    } finally {
      baseKb.close()
      kb.close()
    }
  })

  it('S6 截断：hits 被 CHUNK_HITS_PER_ENTRY 截断的条目仍按「已有的最高段」取全文', async () => {
    const baseKb = await makeKb()
    const rerank = reversingRerank()
    const kb = await makeKb({ rerankCandidates: 24, rerank: rerank.fn })
    try {
      const base = await searchOf(baseKb)
      expect(base.hits_truncated).toBe(true) // 前提：确有条目被截断（RR-E 六段）
      const many = base.results.find((r) => r.id === 'RR-E')
      expect(many?.hits).toHaveLength(4)

      await searchOf(kb)
      const index = base.results.findIndex((r) => r.id === 'RR-E')
      const doc = rerank.calls[0]![index]!
      const seq = many!.hits![0]!.seq
      expect(doc).toBe(chunksOf(baseKb, 'RR-E').find((c) => c.seq === seq)!.text)
    } finally {
      baseKb.close()
      kb.close()
    }
  })
})

// ── SPEC-1.7 预算 ───────────────────────────────────────────────────────────

describe('SPEC-1.7 预算：精排候选数 ≤ 档定值（只精排头部，尾部不参与）', () => {
  it('rerankCandidates=2 → 只组 2 对、只有头部 2 条被重排，尾部序与分不动', async () => {
    const baseKb = await makeKb()
    const rerank = reversingRerank()
    const kb = await makeKb({ rerankCandidates: 2, rerank: rerank.fn })
    try {
      const base = await searchOf(baseKb)
      const got = await searchOf(kb)
      expect(rerank.calls[0]).toHaveLength(2)
      const baseIds = base.results.map((r) => r.id)
      expect(got.results.map((r) => r.id)).toEqual([
        ...baseIds.slice(0, 2).reverse(),
        ...baseIds.slice(2),
      ])
      expect(got.results.slice(2).map((r) => r.score)).toEqual(base.results.slice(2).map((r) => r.score))
      expect(scoresDescending(got)).toBe(true)
    } finally {
      baseKb.close()
      kb.close()
    }
  })

  it('注入但候选不足 2 条 → 不发请求（无重排意义）', async () => {
    const rerank = reversingRerank()
    const kb = await makeKb({ rerankCandidates: 1, rerank: rerank.fn })
    try {
      await searchOf(kb)
      expect(rerank.calls).toHaveLength(0)
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-1.4 降级链（静默零痕迹）─────────────────────────────────────────────

describe('SPEC-1.4 降级：未注入 / 失败 / 超时 / 长度不符 → 与无 rerank 逐字节一致', () => {
  it('三种失败形态（null / 抛错 / 长度不符）结果逐字节等于未注入', async () => {
    const baseKb = await makeKb()
    const baseline = JSON.stringify(await searchOf(baseKb))
    baseKb.close()

    const variants: Array<[string, KnowledgeServiceOptions['rerank']]> = [
      ['注入返 null（未装/失败）', async () => null],
      ['注入抛错（超时未被归零的形态）', async () => {
        throw new Error('TimeoutError: rerank 超时')
      }],
      ['返回分数个数不符', async () => [1, 2]],
      ['返回 NaN', async () => [Number.NaN, ...Array.from({ length: ENTRIES.length }, () => 1)]],
    ]
    for (const [label, rerank] of variants) {
      const kb = await makeKb({ rerankCandidates: 24, rerank })
      try {
        expect(JSON.stringify(await searchOf(kb)), label).toBe(baseline)
      } finally {
        kb.close()
      }
    }
  })

  it('SPEC-1.5 关档跳过：不注入 → 一次请求都不发（与未注入逐字节一致）', async () => {
    const withOpt = await makeKb()
    const baseline = JSON.stringify(await searchOf(withOpt))
    withOpt.close()

    const kb = await makeKb() // 完全不注入 rerank
    try {
      expect(JSON.stringify(await searchOf(kb))).toBe(baseline)
    } finally {
      kb.close()
    }
  })

  it('两实例互不影响：rerank 挂不伤向量检索（含条目路 + 段路两条向量路）', async () => {
    // 确定性假 embedding：每段按其文本长度落桶（两库同文本必得同向量）
    const embed = async (text: string): Promise<Float32Array | null> => {
      const v = new Float32Array(4)
      v[text.length % 4] = 1
      return v
    }
    const ok = await makeKb({ embed, embeddingModel: 'test-4d' })
    const baseline = JSON.stringify(await searchOf(ok))
    ok.close()

    const broken = await makeKb({
      embed,
      embeddingModel: 'test-4d',
      rerankCandidates: 24,
      rerank: async () => {
        throw new Error('rerank server down')
      },
    })
    try {
      const got = await searchOf(broken)
      expect(JSON.stringify(got)).toBe(baseline)
      // 前提核对：向量路确实在工作（有向量才谈得上「不伤向量检索」）
      const vecRows = broken.persistence.knowledge.raw
        .prepare('SELECT COUNT(*) AS c FROM kb_vectors')
        .get() as { c: number }
      expect(Number(vecRows.c)).toBeGreaterThan(0)
    } finally {
      broken.close()
    }
  })
})
