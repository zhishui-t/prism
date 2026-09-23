/**
 * v17 §B-5：段级写入链的**批量口**（`KnowledgeServiceOptions.embedBatch`，additive）。
 *
 * 只验 knowledge 侧的消费契约（server 的 HTTP 批量 + 整批失败逐条回落见
 * `packages/server/test/kb-embed-batch.test.ts`）：
 * - 注入 `embedBatch` → 一篇 entry 的**全部段一次算整批**（单口不被调用；结果等长同序）；
 * - `null` 逐位传播（失败段不写行，其余照写）；
 * - 契约破坏（结果不等长）/ 整批抛错 → **不写任何段向量**（绝不按下标错位写库）；
 * - **未注入 `embedBatch` → 逐段走单口**（v13 零回归，与改动前同）。
 *
 * R5：home 一律 `mkdtemp` 临时目录。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assembleChunkEmbeddingInput } from '../src/chunker.js'
import { PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-chunkbatch-'))
  dirs.push(home)
  return home
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 三个 H2 小节 → 3 段（minChars 10 保证不被并入）。 */
const CONTENT = `## 甲章\n${'甲内容。'.repeat(8)}\n## 乙章\n${'乙内容。'.repeat(8)}\n## 丙章\n${'丙内容。'.repeat(8)}\n`

const VEC = (): Float32Array => new Float32Array([1, 0, 0, 0])

function vectorSeq(kb: PrismKnowledgeService): number[] {
  return (
    kb.persistence.knowledge.raw
      .prepare(
        `SELECT c.seq AS seq FROM kb_chunk_vectors v JOIN kb_chunks c ON c.id = v.chunk_id ORDER BY c.seq`,
      )
      .all() as unknown as Array<{ seq: number }>
  ).map((r) => r.seq)
}

function deposit(kb: PrismKnowledgeService, id: string): Promise<unknown> {
  return kb.deposit({ id, title: '标题', type: 'doc', layer: 'global', book: 'b', content: CONTENT })
}

describe('v17 §B-5：embedBatch 在段级写入链的消费契约', () => {
  it('注入批口 → 一篇 entry 的全部段**一次**算整批；单口零调用；结果等长同序', async () => {
    const singleCalls: string[] = []
    const batchCalls: string[][] = []
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: async (text) => {
        singleCalls.push(text)
        return VEC()
      },
      embedBatch: async (texts) => {
        batchCalls.push([...texts])
        return texts.map(() => VEC())
      },
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      await deposit(kb, 'B-1')

      expect(batchCalls).toHaveLength(1) // 整篇一次
      expect(batchCalls[0]).toHaveLength(3) // 批 = 全部 3 段
      // 单口只被**条目级整篇向量**调用一次（段级全部走批口）
      expect(singleCalls).toHaveLength(1)

      // 批入参 = 每段的 embedding 输入（标题 + heading 路径 + 段文本，单点拼装口径）
      const rows = kb.persistence.knowledge.raw
        .prepare('SELECT seq, heading_path, text, char_start, char_end FROM kb_chunks ORDER BY seq')
        .all() as unknown as Array<{ seq: number; heading_path: string; text: string; char_start: number; char_end: number }>
      expect(batchCalls[0]).toEqual(
        rows.map((r) =>
          assembleChunkEmbeddingInput('标题', {
            seq: r.seq,
            headingPath: r.heading_path,
            text: r.text,
            charStart: r.char_start,
            charEnd: r.char_end,
          }),
        ),
      )
      expect(vectorSeq(kb)).toEqual([0, 1, 2])
    } finally {
      kb.close()
    }
  })

  it('null 逐位传播：失败段不写行，其余段照写（下标不错位）', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: async () => VEC(),
      embedBatch: async (texts) => texts.map((_, i) => (i === 1 ? null : VEC())),
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      await deposit(kb, 'B-2')
      expect(vectorSeq(kb)).toEqual([0, 2]) // 第 2 段（seq=1）失败 → 无行
    } finally {
      kb.close()
    }
  })

  it('批口结果不等长（违约）→ 整批放弃，不按下标错位写库', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: async () => VEC(),
      embedBatch: async () => [VEC()], // 长度 1 ≠ 3
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      await deposit(kb, 'B-3')
      expect(vectorSeq(kb)).toEqual([])
    } finally {
      kb.close()
    }
  })

  it('批口整批抛错 → 不写任何段向量，且 deposit 仍成立（增强不阻断主流程）', async () => {
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: async () => VEC(),
      embedBatch: async () => {
        throw new Error('boom')
      },
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      const result = await deposit(kb, 'B-4')
      expect(result).toMatchObject({ action: 'created' })
      expect(vectorSeq(kb)).toEqual([])
      // 段行与段 FTS 照写（只有向量缺口）
      expect(
        (kb.persistence.knowledge.raw.prepare('SELECT COUNT(*) AS c FROM kb_chunks').get() as { c: number }).c,
      ).toBe(3)
    } finally {
      kb.close()
    }
  })

  it('**未注入批口** → 逐段走单口（v13 零回归）：每段一次、结果与批口一致', async () => {
    const singleCalls: string[] = []
    const kb = new PrismKnowledgeService({
      home: makeHome(),
      embed: async (text) => {
        singleCalls.push(text)
        return VEC()
      },
      embeddingModel: 'test-4d',
      chunkOptions: { minChars: 10, maxChars: 500 },
    })
    try {
      await deposit(kb, 'B-5')
      // 1 次条目级整篇向量 + 3 次段级（逐段）——无批口即回到 v13 的单口路径
      expect(singleCalls).toHaveLength(4)
      expect(vectorSeq(kb)).toEqual([0, 1, 2])
    } finally {
      kb.close()
    }
  })
})
