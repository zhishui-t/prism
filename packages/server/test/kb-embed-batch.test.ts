/**
 * v17 §B-5：embed 批量口（`/embedding {input: string[]}`）的**调用层契约**。
 *
 * 只碰 server 侧、用注入 fetch（不起真进程、不碰 8191/8192、不碰真实宿主目录——R5）。
 * 覆盖：
 * - `batchTimeoutMs` 派生公式 `clamp(3000 + 800×n, 5000, 120000)`（B-R §4③ 回填）；
 * - 批大小切批（`embed_batch`）+ 响应**按 `index` 回填**（结果序与入参一致）；
 * - 整批失败 → **全部逐条重试一轮**（1+n 次请求；B-R §4④ 坐实的唯一可实现语义）；
 * - 批内 `null` 传播；维度不符该位 `null`；
 * - **超 ctx 减半重试**的判据回归（`embedding.ts` 旧判据 `/too large|batch/i` 不命中真实
 *   文案 `exceeds the available context size` → 曾是死代码；本文件把修复钉住）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_EMBED_BATCH,
  batchTimeoutMs,
  callEmbedBatch,
  embedBatchText,
  setEmbeddingFetch,
} from '../src/kb/embedding.js'
import type { EmbeddingModelDef } from '../src/kb/embedding-models.js'

afterEach(() => {
  setEmbeddingFetch(null)
  vi.unstubAllEnvs()
})

/** 4 维假档位：maxChars 1500（截断/减半可见）、dim 4（构造假向量方便）。 */
const DEF: EmbeddingModelDef = {
  id: 'test-4d',
  tier: 'large',
  label: 'test',
  file: 'test.gguf',
  dim: 4,
  ctx: 2048,
  maxChars: 1500,
  repo: '',
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function parseInput(init?: RequestInit): string | string[] {
  const raw = typeof init?.body === 'string' ? init.body : '{}'
  return (JSON.parse(raw) as { input: string | string[] }).input
}

/** 记录每次请求是「批（数组）」还是「单条（字符串）」及其承载的文本。 */
interface Req {
  isBatch: boolean
  texts: string[]
}

function recordingFetch(
  handler: (req: Req, index: number) => Response | Promise<Response>,
): { reqs: Req[]; fetch: (input: string, init?: RequestInit) => Promise<Response> } {
  const reqs: Req[] = []
  const impl = async (_input: string, init?: RequestInit): Promise<Response> => {
    const raw = parseInput(init)
    const isBatch = Array.isArray(raw)
    const texts = isBatch ? (raw as string[]) : [raw as string]
    reqs.push({ isBatch, texts })
    return handler({ isBatch, texts }, reqs.length - 1)
  }
  return { reqs, fetch: impl }
}

/** 服务端批量响应形态（B-R §1.6 实测）：顶层数组、元素带 index、embedding 多一层。 */
const batchBody = (texts: readonly string[]): Array<{ index: number; embedding: number[][] }> =>
  texts.map((_, i) => ({ index: i, embedding: [[i + 1, 0, 0, 1]] }))

// ── 超时派生公式（B-R §4③）──────────────────────────────────────────────────

describe('batchTimeoutMs：clamp(3000 + 800×n, 5000, 120000)', () => {
  it('逐锚点：n=1 触底 5s；4/8/16/32 按公式；n 大触顶 120s', () => {
    expect(batchTimeoutMs(1)).toBe(5_000) // 3800 → 触底
    expect(batchTimeoutMs(4)).toBe(6_200)
    expect(batchTimeoutMs(8)).toBe(9_400)
    expect(batchTimeoutMs(16)).toBe(15_800) // B-R 表：n=16 → 15.8s
    expect(batchTimeoutMs(32)).toBe(28_600)
    expect(batchTimeoutMs(200)).toBe(120_000) // 163000 → 触顶
    expect(batchTimeoutMs(1000)).toBe(120_000)
  })

  it('非有限/非正数按 n=1 兜底（不产生 0/NaN 超时）', () => {
    for (const n of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(batchTimeoutMs(n)).toBe(5_000)
    }
  })
})

// ── 批大小切批 + 结果序（SPEC-B5.1）─────────────────────────────────────────

describe('callEmbedBatch：一次请求收整批、结果序与入参一致', () => {
  it('10 段 / 批 8 → 两次请求（8+2），批内文本与顺序逐字对应', async () => {
    const { reqs, fetch } = recordingFetch((req) =>
      // 向量首分量编码该文本的**全局**序号（`t3` → 4），跨请求也可验证总序
      jsonResponse(req.texts.map((t, i) => ({ index: i, embedding: [[Number(t.slice(1)) + 1, 0, 0, 1]] }))),
    )
    setEmbeddingFetch(fetch)

    const texts = Array.from({ length: 10 }, (_, i) => `t${i}`)
    const out = await callEmbedBatch(texts, 8, DEF)

    expect(reqs).toHaveLength(2) // ⌈10 / 8⌉
    expect(reqs.every((r) => r.isBatch)).toBe(true)
    expect(reqs[0]?.texts).toEqual(texts.slice(0, 8))
    expect(reqs[1]?.texts).toEqual(texts.slice(8))

    expect(out).toHaveLength(10)
    expect(out.every((v) => v !== null && v.length === 4)).toBe(true)
    // 结果序 = 入参序（批响应按 index 回填）
    expect(out.map((v) => v?.[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('批响应元素逆序返回 → 仍按 index 回填为入参序', async () => {
    const { fetch } = recordingFetch((req) =>
      jsonResponse(batchBody(req.texts).reverse()),
    )
    setEmbeddingFetch(fetch)

    const out = await callEmbedBatch(['a', 'b', 'c'], 8, DEF)
    expect(out.map((v) => v?.[0])).toEqual([1, 2, 3])
  })

  it('批内某位缺席（200 但缺该 index）→ 该位 null，其余照回；不触发逐条重试', async () => {
    const { reqs, fetch } = recordingFetch(() =>
      jsonResponse([
        { index: 0, embedding: [[1, 0, 0, 1]] },
        { index: 2, embedding: [[3, 0, 0, 1]] },
      ]),
    )
    setEmbeddingFetch(fetch)

    const out = await callEmbedBatch(['a', 'b', 'c'], 8, DEF)
    expect(reqs).toHaveLength(1) // 200 即视为整批成功，不逐条
    expect(out[0]).not.toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).not.toBeNull()
  })

  it('维度不符（≠ 档位 dim）→ 该位 null', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse([
        { index: 0, embedding: [[1, 0]] }, // 2 维 ≠ 4
        { index: 1, embedding: [[1, 0, 0, 1]] },
      ]),
    )
    setEmbeddingFetch(fetch)

    const out = await callEmbedBatch(['a', 'b'], 8, DEF)
    expect(out[0]).toBeNull()
    expect(out[1]).not.toBeNull()
  })
})

// ── 整批失败 → 全部逐条重试（SPEC-B5.2 / M1 修订）───────────────────────────

describe('callEmbedBatch：整批失败 → 全部逐条重试一轮（1+n）', () => {
  it('3 段批失败（400）→ 1 批 + 3 单 = 4 次请求；逐条带回各段文本；全部成功', async () => {
    const { reqs, fetch } = recordingFetch((req) => {
      if (req.isBatch) {
        // B-R §2.3 实测的整请求错误形态：错误体**不含段序号**
        return jsonResponse(
          {
            error: {
              code: 400,
              message:
                'request (5768 tokens) exceeds the available context size (2048 tokens), try increasing it',
              type: 'exceed_context_size_error',
            },
          },
          400,
        )
      }
      return jsonResponse([{ index: 0, embedding: [[1, 0, 0, 1]] }])
    })
    setEmbeddingFetch(fetch)

    const out = await callEmbedBatch(['a', 'b', 'c'], 8, DEF)

    expect(reqs).toHaveLength(4) // 1 + n
    expect(reqs[0]?.isBatch).toBe(true)
    expect(reqs.slice(1).every((r) => !r.isBatch)).toBe(true)
    expect(reqs.slice(1).map((r) => r.texts[0])).toEqual(['a', 'b', 'c'])
    expect(out.map((v) => (v === null ? null : v[0]))).toEqual([1, 1, 1])
  })

  it('逐条仍失败 → 该位 null（只重试一轮，不递归）', async () => {
    const { reqs, fetch } = recordingFetch((req) =>
      req.isBatch ? jsonResponse({ error: { code: 400 } }, 400) : jsonResponse({ error: { code: 500 } }, 500),
    )
    setEmbeddingFetch(fetch)

    const out = await callEmbedBatch(['a', 'b'], 4, DEF)
    expect(reqs).toHaveLength(3) // 1 批 + 2 单（不再对这些失败的单条再重试）
    expect(out).toEqual([null, null])

    // 单条失败后**不再**产生新请求（无递归/无第二轮批）
    const before = reqs.length
    await new Promise((r) => setTimeout(r, 0))
    expect(reqs.length).toBe(before)
  })
})

// ── 超 ctx 减半重试的判据回归（侦察附带发现：旧正则失配 → 死代码）─────────────

describe('超 ctx 错误判据：命中 `exceeds the available context size` → 减半重试真生效', () => {
  it('批失败 + 单条首试失败（真实文案）→ 减半后成功；请求体长度 1500 → 1500 → 750', async () => {
    const { reqs, fetch } = recordingFetch((_req, index) => {
      if (index <= 1) {
        return jsonResponse(
          {
            error: {
              code: 400,
              message:
                'request (3000 tokens) exceeds the available context size (2048 tokens), try increasing it',
              type: 'exceed_context_size_error',
            },
          },
          400,
        )
      }
      return jsonResponse([{ index: 0, embedding: [[1, 0, 0, 1]] }])
    })
    setEmbeddingFetch(fetch)

    const long = 'x'.repeat(3000)
    const out = await callEmbedBatch([long], 1, DEF)

    // ① 批（截断到 maxChars=1500）→ 400；② 单条首试 1500 → 400；③ 减半 750 → 200
    expect(reqs.map((r) => r.texts[0]?.length)).toEqual([1500, 1500, 750])
    expect(out[0]).not.toBeNull()
    expect(out[0]?.length).toBe(4)
  })

  it('对照：非超 ctx 类错误（如 500）→ **不**减半，直接 null（避免无意义重试）', async () => {
    const { reqs, fetch } = recordingFetch(() => jsonResponse({ error: { code: 500 } }, 500))
    setEmbeddingFetch(fetch)

    const out = await callEmbedBatch(['x'.repeat(2000)], 1, DEF)
    // 批 1 次 + 单条 1 次（500 不匹配超 ctx 判据 → 不再减半）
    expect(reqs).toHaveLength(2)
    expect(out).toEqual([null])
  })
})

// ── 门控（未装/未就绪 → 不抛、全 null）──────────────────────────────────────

describe('embedBatchText：未装 → 全 null 且零请求（与单口同口径的降级）', () => {
  it('PRISM_EMBEDDING=off → 不入 HTTP 路径', async () => {
    vi.stubEnv('PRISM_EMBEDDING', 'off')
    let called = 0
    setEmbeddingFetch(async () => {
      called++
      return jsonResponse([])
    })

    const out = await embedBatchText(['a', 'b', 'c'])
    expect(out).toEqual([null, null, null])
    expect(called).toBe(0)
  })

  it('空入参 → 空数组（不触发门控探测）', async () => {
    expect(await embedBatchText([])).toEqual([])
  })

  it('缺省批大小 = DEFAULT_EMBED_BATCH（= 8，B-R §4① 口径）', () => {
    expect(DEFAULT_EMBED_BATCH).toBe(8)
  })
})
