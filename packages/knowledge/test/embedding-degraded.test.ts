/**
 * v15 §2 / SPEC-2.1–2.3：`embedding_degraded` 能力降级标志（M-1 修订后的三判据）。
 *
 * 判据（**三者同真**才报）：① 装配侧 `vectorCapable` ∧ ② 查询 `hybrid !== false`
 * （显式关混合是用户选择）∧ ③ 查询向量 `qVec === null`（假活/超时/失败算不出）。
 *
 * 关键回归（M-1）：旧判据 `#embed !== undefined` 是**假阳性**——server 侧 `embed` 无条件
 * 注入（未装时只是恒返回 null），故本文件用 `embed: deadEmbed`（恒 null）+ `vectorCapable`
 * 的**有无**来区分「装了但算不出」（报）与「未装/off」（不报）。
 *
 * 假活真跑（kill -STOP ≥1 分钟）只人工黑盒（S-4），此处一律注入 mock embed。
 * 全部临时目录（R5），零真实宿主污染。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-degraded-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 假活/超时/失败的 embedding：恒「算不出」。 */
const deadEmbed = async (): Promise<Float32Array | null> => null

/** 按标记位返回正交向量的 embedding：含「甲」→ e0、含「乙」→ e1（跨桶余弦 0）。 */
async function bucketEmbed(text: string): Promise<Float32Array | null> {
  if (text.includes('甲')) return Float32Array.from([1, 0])
  if (text.includes('乙')) return Float32Array.from([0, 1])
  return null
}

/** 段切分收窄（与 chunk-search 同口径）：让 deposit 落到有 chunks 的 fused 分支。 */
const SPLIT = { minChars: 8, maxChars: 400 } as const

async function depositOne(kb: PrismKnowledgeService, content = '甲甲内容写在这里。'): Promise<void> {
  await kb.deposit({
    id: 'D-1',
    title: '降级夹具',
    type: 'doc',
    layer: 'global',
    book: 'b',
    module: 'm',
    content,
  })
}

describe('v15 SPEC-2.1：三判据同真 → embedding_degraded:true 且回落纯 BM25', () => {
  it('legacy 分支（全库无 chunks）：能力已装但向量算不出 → 带标志，BM25 照常命中', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), embed: deadEmbed, vectorCapable: true })
    try {
      await depositOne(kb)
      const resp = await kb.searchWithMeta({ q: '甲甲' })
      expect(resp.embedding_degraded).toBe(true)
      // 回落纯 BM25：结果与 `search()`（裸数组）逐字节一致，且确有命中
      expect(resp.results.map((r) => r.id)).toEqual(['D-1'])
      expect(resp.results).toEqual(await kb.search({ q: '甲甲' }))
    } finally {
      kb.close()
    }
  })

  it('fused 分支（有 chunks）：能力已装但向量算不出 → 同样带标志（接线另一条）', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      chunkOptions: SPLIT,
      embed: deadEmbed,
      vectorCapable: true,
    })
    try {
      await depositOne(kb, '## 甲章\n甲甲内容写在这里。\n')
      // 前置：确有 chunks（否则走的是 legacy 分支，断言不到 fused 接线）
      const chunks = kb.persistence.knowledge.raw
        .prepare('SELECT COUNT(*) AS n FROM kb_chunks')
        .get() as { n: number }
      expect(chunks.n).toBeGreaterThan(0)

      const resp = await kb.searchWithMeta({ q: '甲甲' })
      expect(resp.embedding_degraded).toBe(true)
      expect(resp.results.map((r) => r.id)).toEqual(['D-1'])
    } finally {
      kb.close()
    }
  })
})

describe('v15 SPEC-2.2：向量算得出但零命中 → 不报（合法零命中 ≠ 降级）', () => {
  it('查询向量非 null、召回空 → 无 embedding_degraded 键', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), embed: bucketEmbed, vectorCapable: true })
    try {
      // 存「甲」桶条目；查询「乙」桶（词面零重叠 + 向量正交 → BM25 与向量均零命中）
      await depositOne(kb, '甲甲内容写在这里。')
      const resp = await kb.searchWithMeta({ q: '乙乙' })
      expect(resp.results).toEqual([])
      expect('embedding_degraded' in resp).toBe(false)
    } finally {
      kb.close()
    }
  })
})

describe('v15 SPEC-2.3：未装 / off / 显式 hybrid=false → 不报', () => {
  it('装配侧未置 vectorCapable（未装/off）→ 向量算不出也不报，且响应仅含 results', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), embed: deadEmbed })
    try {
      await depositOne(kb)
      const resp = await kb.searchWithMeta({ q: '甲甲' })
      expect('embedding_degraded' in resp).toBe(false)
      expect(Object.keys(resp)).toEqual(['results'])
    } finally {
      kb.close()
    }
  })

  it('显式 hybrid=false（用户选择）→ 即便能力已装且向量算不出也不报', async () => {
    const kb = new PrismKnowledgeService({ home: makeHome(), embed: deadEmbed, vectorCapable: true })
    try {
      await depositOne(kb)
      const resp = await kb.searchWithMeta({ q: '甲甲', hybrid: false })
      expect('embedding_degraded' in resp).toBe(false)
      expect(resp.results.map((r) => r.id)).toEqual(['D-1'])
    } finally {
      kb.close()
    }
  })
})

// v15 tester 补测（假阳性面全扫）：三判据（vectorCapable × hybrid × 向量可否算出）的
// **组合矩阵**——逐格断言标志有无，堵「单点用例盖不全、改判据漏一角」的回归面。
// 全部 legacy 分支（无 chunks，最快路径）；每格同时断言 BM25 结果照常（降级不吞结果）。
describe('v15 tester 补测：三判据 8 格组合矩阵（legacy 分支，假阳性面全扫）', () => {
  // [vectorCapable, hybrid, embed 形态, 期望 embedding_degraded]
  it.each([
    [true, undefined, 'dead', true], // 装 + 未关 + 算不出 → 报（SPEC-2.1 本体）
    [true, true, 'dead', true], // 显式 hybrid:true 与缺省同口径（判据是 !== false）
    [true, false, 'dead', false], // 用户显式关混合 → 不报（SPEC-2.3）
    [undefined, undefined, 'dead', false], // 装配侧未置能力 → 不报（M-1 假阳性洞）
    [undefined, false, 'dead', false], // 双保险格：两判据各自独立堵
    [undefined, undefined, 'none', false], // 连 embed 都未装配（#queryVector 首短路）
    [true, undefined, 'live', false], // 向量算得出 → 不报（SPEC-2.2 的非零命中侧）
    [true, false, 'live', false], // 算得出 + 显式关 → 不报
  ] as const)(
    'vectorCapable=%s hybrid=%s embed=%s → embedding_degraded=%s',
    async (vc, hybrid, embedKind, expected) => {
      const embed = embedKind === 'dead' ? deadEmbed : embedKind === 'live' ? bucketEmbed : undefined
      const kb = new PrismKnowledgeService({
        home: makeHome(),
        ...(embed !== undefined ? { embed } : {}),
        ...(vc !== undefined ? { vectorCapable: vc } : {}),
      })
      try {
        await depositOne(kb)
        const resp = await kb.searchWithMeta({ q: '甲甲', ...(hybrid !== undefined ? { hybrid } : {}) })
        // 契约是**键的存在性**：真 = 键在且为 true；假 = 键整个不在（未降级响应与旧形状逐字节一致）
        if (expected) expect(resp.embedding_degraded).toBe(true)
        else expect('embedding_degraded' in resp).toBe(false)
        // 任何一格都不许吞 BM25 结果（降级回落 ≠ 结果消失）
        expect(resp.results.map((r) => r.id)).toEqual(['D-1'])
      } finally {
        kb.close()
      }
    },
  )
})
