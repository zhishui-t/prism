/**
 * 图谱融合 · 引用扩展（v14 §2 / SPEC-2.1–2.6；全序 S4、单向正跳 S5）。
 *
 * 覆盖：1 跳 ×0.5 / 2 跳 ×0.25 / 多路到达取最高（SPEC-2.1/2.2）、开关 off 与稀疏图零影响
 * （SPEC-2.3/2.4）、扩展候选过主查询同 clauses（软删 / 层——SPEC-2.5）、单向正跳（S5）、
 * overrides 降权落在 rerank **之后**（S4），以及系数键`.
 *
 * 边由 `deposit` 的正文双链 `[[id]]` 写入（`references`，from=引用方 → to=被引方）。
 * 全部临时目录（R5）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import type {
  KnowledgeServiceOptions,
  Layer,
  SearchResponse,
} from '../src/types.js'

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-fusion-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 段切分收窄：小夹具上「一节 = 一段」稳定成立。 */
const SPLIT = { minChars: 8, maxChars: 400 } as const

/** 检索词（三字 → bigram `独角`+`角鲸`）——只出现在被引用方的条目标题/正文里。 */
const QUERY = '独角鲸'

interface Fixture {
  id: string
  title: string
  content: string
  layer?: Layer
  owner?: string
  overrides?: string[]
  visibility?: 'global' | 'project' | 'role'
}

/** 同一 `entries` 顺序建库 → 两次建库的 rowid / BM25 完全一致（可跨库逐字节比对）。 */
async function build(
  entries: readonly Fixture[],
  options: Partial<KnowledgeServiceOptions> = {},
): Promise<PrismKnowledgeService> {
  const kb = new PrismKnowledgeService({ home: makeHome(), chunkOptions: SPLIT, ...options })
  for (const entry of entries) {
    await kb.deposit({
      id: entry.id,
      title: entry.title,
      type: 'doc',
      layer: entry.layer ?? 'global',
      ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
      ...(entry.visibility !== undefined ? { visibility: entry.visibility } : {}),
      book: 'b',
      module: 'm',
      content: entry.content,
      ...(entry.overrides !== undefined ? { overrides: entry.overrides } : {}),
    })
  }
  return kb
}

const ids = (response: SearchResponse): string[] => response.results.map((r) => r.id)

/** 边表里是否存在某条边（证「非空转」：被过滤掉的候选，其边确实存在）。 */
function edgeCount(kb: PrismKnowledgeService, from: string, to: string, relation: string): number {
  const row = kb.persistence.knowledge.raw
    .prepare(
      'SELECT COUNT(*) AS c FROM knowledge_edges WHERE from_id = ? AND to_id = ? AND relation = ?',
    )
    .get(from, to, relation) as { c: number }
  return Number(row.c)
}

function scoresDescending(response: SearchResponse): boolean {
  for (let i = 1; i < response.results.length; i++) {
    if (response.results[i]!.score > response.results[i - 1]!.score) return false
  }
  return true
}

/**
 * A → {B, D}；B → {C, D}。只有 A 含检索词 → 融合结果初始只有 A，其余全由扩展并入。
 * 一跳到 B/D（×0.5）、二跳到 C（×0.25）；D 同时是一跳与二跳目标 → 取最高（×0.5）。
 */
const CHAIN: readonly Fixture[] = [
  { id: 'GF-A', title: '甲', content: '## 甲一\n独角鲸甲正文。\n\n[[GF-B]] [[GF-D]]\n' },
  { id: 'GF-B', title: '乙', content: '## 乙一\n乙的普通正文。\n\n[[GF-C]] [[GF-D]]\n' },
  { id: 'GF-C', title: '丙', content: '## 丙一\n丙的普通正文。\n' },
  { id: 'GF-D', title: '丁', content: '## 丁一\n丁的普通正文。\n' },
]

// ── SPEC-2.1 / 2.2：一跳、二跳、多路取最高 ──────────────────────────────────

describe('SPEC-2.1/2.2 引用扩展：跳数衰减与多路取最高', () => {
  it('A→B 一跳 ×0.5、A→B→C 二跳 ×0.25、D 多路到达取最高（×0.5 非 ×0.25）', async () => {
    const off = await build(CHAIN, { graphFusion: false })
    const on = await build(CHAIN) // 缺省（未传）= on
    try {
      // 前提：只有 A 被检索到（B/C/D 不含检索词、无边可走的库给不出它们）
      expect(ids(await off.searchWithMeta({ q: QUERY, limit: 10 }))).toEqual(['GF-A'])

      const got = await on.searchWithMeta({ q: QUERY, limit: 10 })
      const byId = new Map(got.results.map((r) => [r.id, r]))
      expect([...byId.keys()].sort()).toEqual(['GF-A', 'GF-B', 'GF-C', 'GF-D'])

      const base = byId.get('GF-A')!.score
      expect(byId.get('GF-B')!.score).toBeCloseTo(base * 0.5, 10)
      expect(byId.get('GF-C')!.score).toBeCloseTo(base * 0.25, 10)
      // 多路：D 被 A 一跳（0.5s）与 B 二跳（0.25s）同时到达 → 取最高 = 0.5s
      expect(byId.get('GF-D')!.score).toBeCloseTo(base * 0.5, 10)

      // 衰减保证扩展候选不顶掉原 top
      expect(base).toBeGreaterThan(byId.get('GF-B')!.score)
      expect(scoresDescending(got)).toBe(true)
    } finally {
      off.close()
      on.close()
    }
  })

  it('graph_fusion_decay 被真正消费（0.2 → 1 跳 ×0.2、2 跳 ×0.04）', async () => {
    const kb = await build(CHAIN, { graphFusionDecay: 0.2 })
    try {
      const got = await kb.searchWithMeta({ q: QUERY, limit: 10 })
      const byId = new Map(got.results.map((r) => [r.id, r]))
      const base = byId.get('GF-A')!.score
      expect(byId.get('GF-B')!.score).toBeCloseTo(base * 0.2, 10)
      expect(byId.get('GF-C')!.score).toBeCloseTo(base * 0.04, 10)
    } finally {
      kb.close()
    }
  })

  it('扩展候选并入后仍截断到 limit（不因扩展而超出响应长度）', async () => {
    const kb = await build(CHAIN)
    try {
      const got = await kb.searchWithMeta({ q: QUERY, limit: 2 })
      expect(got.results).toHaveLength(2)
      expect(got.results[0]!.id).toBe('GF-A') // 原 top 仍居首
    } finally {
      kb.close()
    }
  })
})

// ── SPEC-2.3 / 2.4：开关与稀疏图 ────────────────────────────────────────────

describe('SPEC-2.3/2.4 开关 off / 稀疏图：与无此功能逐字节一致', () => {
  it('无 edges（稀疏图）：缺省 on 与显式 off 逐字节一致、零扩展', async () => {
    const solo: readonly Fixture[] = [
      { id: 'GF-S', title: '甲', content: '## 甲一\n独角鲸甲正文。\n' },
      { id: 'GF-T', title: '乙', content: '## 乙一\n乙的普通正文。\n' },
    ]
    const on = await build(solo)
    const off = await build(solo, { graphFusion: false })
    try {
      const a = await on.search({ q: QUERY, limit: 10 })
      const b = await off.search({ q: QUERY, limit: 10 })
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(b.map((r) => r.id)).toEqual(['GF-S'])
      expect(edgeCount(on, 'GF-S', 'GF-T', 'references')).toBe(0) // 前提：确实无边
    } finally {
      on.close()
      off.close()
    }
  })

  it("graph_fusion='off' 即使有边也零扩展（结果 = 只被检索到的条目）", async () => {
    const off = await build(CHAIN, { graphFusion: false })
    try {
      expect(edgeCount(off, 'GF-A', 'GF-B', 'references')).toBe(1) // 边在，仍不扩展
      expect(ids(await off.searchWithMeta({ q: QUERY, limit: 10 }))).toEqual(['GF-A'])
    } finally {
      off.close()
    }
  })
})

// ── SPEC-2.5：过滤同源 ─────────────────────────────────────────────────────

describe('SPEC-2.5 过滤同源：扩展候选必须过主查询同一份 clauses', () => {
  it('软删的被引条目不进（边仍在 DB，只是 status 不可见）', async () => {
    const fx: readonly Fixture[] = [
      { id: 'GF-A', title: '甲', content: '## 甲一\n独角鲸甲正文。\n\n[[GF-B]]\n' },
      { id: 'GF-B', title: '乙', content: '## 乙一\n乙的普通正文。\n' },
    ]
    const kb = await build(fx)
    try {
      expect(ids(await kb.searchWithMeta({ q: QUERY, limit: 10 }))).toEqual(['GF-A', 'GF-B'])
      await kb.remove('GF-B')
      expect(edgeCount(kb, 'GF-A', 'GF-B', 'references')).toBe(1) // 软删不删边
      expect(ids(await kb.searchWithMeta({ q: QUERY, limit: 10 }))).toEqual(['GF-A'])
    } finally {
      kb.close()
    }
  })

  it('层不可见的被引条目不进（限定 layers 时；不限定则正常并入——证明非空转）', async () => {
    const fx: readonly Fixture[] = [
      { id: 'GF-A', title: '甲', content: '## 甲一\n独角鲸甲正文。\n\n[[GF-P]]\n' },
      { id: 'GF-P', title: '丙', content: '## 丙一\n丙的普通正文。\n', layer: 'project', owner: 'p1' },
    ]
    const kb = await build(fx)
    try {
      expect(ids(await kb.searchWithMeta({ q: QUERY, limit: 10 }))).toEqual(['GF-A', 'GF-P'])
      expect(ids(await kb.searchWithMeta({ q: QUERY, limit: 10, layers: ['global'] }))).toEqual(['GF-A'])
    } finally {
      kb.close()
    }
  })

  it('visibility 不可见的被引条目不进（B3 visibilities 收窄——SPEC-2.5 的第三类子句）', async () => {
    const fx: readonly Fixture[] = [
      { id: 'GF-V', title: '甲', content: '## 甲一\n独角鲸甲正文。\n\n[[GV-B]]\n' },
      // 被引方落 project 可见性（layer 仍 global——visibility 与 layer 独立判定）
      { id: 'GV-B', title: '乙', content: '## 乙一\n乙的普通正文。\n', visibility: 'project' },
    ]
    const kb = await build(fx)
    try {
      expect(edgeCount(kb, 'GF-V', 'GV-B', 'references')).toBe(1) // 边确实存在——不是「没边」的假绿
      // 不收窄 → 扩展正常并入（B 在 A 后、×0.5）
      expect(ids(await kb.searchWithMeta({ q: QUERY, limit: 10 }))).toEqual(['GF-V', 'GV-B'])
      // visibilities 收窄到 global → 同一份 clauses 挡掉 project 可见性的 GV-B
      expect(ids(await kb.searchWithMeta({ q: QUERY, limit: 10, visibilities: ['global'] }))).toEqual(['GF-V'])
    } finally {
      kb.close()
    }
  })
})

// ── S5：单向正跳 ───────────────────────────────────────────────────────────

describe('S5 单向正跳：只沿 from_id 走，反向不扩展', () => {
  it('「谁引用了我」不把引用方拉进结果（反向边存在也不走）', async () => {
    const fx: readonly Fixture[] = [
      { id: 'GF-A', title: '甲', content: '## 甲一\n独角鲸甲正文。\n' },
      // F → A（F 引用了 A）：A 是**被引方**，不该因此把 F 拉进来
      { id: 'GF-F', title: '己', content: '## 己一\n己的普通正文。\n\n[[GF-A]]\n' },
    ]
    const kb = await build(fx)
    try {
      expect(edgeCount(kb, 'GF-F', 'GF-A', 'references')).toBe(1) // 反向边确实存在
      expect(ids(await kb.searchWithMeta({ q: QUERY, limit: 10 }))).toEqual(['GF-A'])
    } finally {
      kb.close()
    }
  })
})

// ── S4：全序（overrides 最后） ─────────────────────────────────────────────

describe('S4 全序：RRF → 扩展 → rerank → overrides 最后', () => {
  it('overrides 降权落在 rerank 的重赋分之后（恰为精排后分数的一半，不被盖掉）', async () => {
    const fx: readonly Fixture[] = [
      { id: 'GF-X', title: '甲', content: '## 甲一\n独角鲸甲正文。\n' },
      // Y 覆盖 X（overrides 声明 → 边 Y→X，relation='overrides'）
      { id: 'GF-Y', title: '乙', content: '## 乙一\n独角鲸乙正文。\n', overrides: ['GF-X'] },
    ]
    // 短路重排（全 0 分 → 顺序不变，但确实走了「重赋分」这一步）
    const rerank: NonNullable<KnowledgeServiceOptions['rerank']> = async (_q, docs) =>
      docs.map(() => 0)

    const plain = await build(fx)
    const noBoost = await build(fx, { rerankCandidates: 24, rerank })
    const boosted = await build(fx, { rerankCandidates: 24, rerank })
    try {
      expect(ids(await plain.searchWithMeta({ q: QUERY, limit: 10 })).sort()).toEqual(['GF-X', 'GF-Y'])

      const nb = await noBoost.searchWithMeta({ q: QUERY, limit: 10 })
      const xNo = nb.results.find((r) => r.id === 'GF-X')!
      expect(xNo.overridden_by).toBeUndefined() // graph_boost 未开 → 不降权

      const bo = await boosted.searchWithMeta({ q: QUERY, limit: 10, graph_boost: true })
      const xBo = bo.results.find((r) => r.id === 'GF-X')!
      expect(xBo.overridden_by).toBe('GF-Y@v1')
      // 精排先跑（重赋分）→ overrides 再 ×0.5：故恰为「精排后分数」的一半
      expect(xBo.score).toBeCloseTo(xNo.score * 0.5, 10)
      expect(scoresDescending(bo)).toBe(true)
    } finally {
      plain.close()
      noBoost.close()
      boosted.close()
    }
  })
})
