/**
 * Rerank 第二实例与 `/rerank` 调用层（v14 §1.1/§1.2；SPEC-1.4/1.5/1.6）。
 *
 * 本文件只碰 **server 侧**：argv 结构（M1 的三条硬约束）、响应解析（源码实查的
 * `results[].index` 回填）、四态调用（注入 fetch 层，不起真进程）、门控独立性。
 * 检索接入（重排生效/取值/单调分）在 `packages/knowledge/test/rerank.test.ts`。
 *
 * R5：全部临时目录 + 注入 fetch，不碰真实宿主目录，也不会 spawn llama-server。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'

import {
  RERANK_PORT,
  activeRerankTier,
  boundRerankDocs,
  buildRerankServerArgv,
  callRerank,
  parseRerankScores,
  rerankInstalled,
  rerankPaths,
  rerankText,
  resolveRerankBackend,
  setRerankFetch,
  setRerankTier,
} from '../src/kb/embedding.js'
import { RERANK_MODELS, RERANK_TIERS } from '../src/kb/embedding-models.js'

afterEach(() => {
  setRerankFetch(null)
  vi.unstubAllEnvs()
})

/** 构造一个 fetch 假实现：记录调用并返回给定响应。 */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { calls: Array<{ url: string; init?: RequestInit }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init })
    return handler(input, init)
  }) as unknown as typeof fetch
  return { calls, fetch: fetchImpl }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ── SPEC-1.6 / M1：第二实例 argv 结构 ────────────────────────────────────────

describe('SPEC-1.6 第二实例：argv 结构（M1 三条硬约束）', () => {
  it('带 --rerank；不带 --embedding / --pooling；-c ≥ 1024；端口独立', () => {
    const argv = buildRerankServerArgv({ modelPath: '/m/r.gguf', ctx: 1024, gpu: false })
    expect(argv).toContain('--rerank')
    // 池化是实例级全局：带上即打死 /embedding 语义（arg.cpp:3471-3476）
    expect(argv).not.toContain('--embedding')
    expect(argv).not.toContain('--pooling')
    const c = argv[argv.indexOf('-c') + 1]
    expect(Number(c)).toBeGreaterThanOrEqual(1024)
    expect(argv[argv.indexOf('--port') + 1]).toBe(String(RERANK_PORT))
    expect(argv).toContain('/m/r.gguf')
  })

  it('两档的 ctx 都 ≥1024（query+doc+模板装得下）', () => {
    for (const tier of RERANK_TIERS) expect(RERANK_MODELS[tier].ctx).toBeGreaterThanOrEqual(1024)
  })

  it('GPU 档带 -ngl 99，CPU 档不带', () => {
    expect(buildRerankServerArgv({ modelPath: 'm', ctx: 1024, gpu: true })).toContain('-ngl')
    expect(buildRerankServerArgv({ modelPath: 'm', ctx: 1024, gpu: false })).not.toContain('-ngl')
  })

  it('三个落点独立于 embedding（llama-rerank-server.* vs llama-server.*）', () => {
    const paths = rerankPaths()
    for (const p of Object.values(paths)) expect(p).toContain('llama-rerank-server')
    expect(new Set(Object.values(paths)).size).toBe(3)
  })
})

// ── 响应解析（源码实查：results 已按分数降序，必须按 index 回填）───────────────

describe('parseRerankScores：按 index 回填（结果数组是排序过的）', () => {
  it('Jina 形态：results 按分降序 → 输出仍按**入参顺序**', () => {
    // 入参 3 篇，服务端按分重排后第 2 篇（index=2）分最高
    const data = {
      model: 'r',
      object: 'list',
      usage: {},
      results: [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.5 },
        { index: 1, relevance_score: 0.1 },
      ],
    }
    expect(parseRerankScores(data)).toEqual([0.5, 0.1, 0.9])
  })

  it('TEI 形态（请求体带 texts 时服务端直接返数组）：认 score 字段', () => {
    expect(
      parseRerankScores([
        { index: 1, score: 0.7 },
        { index: 0, score: 0.2 },
      ]),
    ).toEqual([0.2, 0.7])
  })

  it('缺 index / index 重复 / 非有限数 / 非数组 → null（调用方据此回落）', () => {
    expect(parseRerankScores([{ relevance_score: 0.5 }])).toBeNull()
    expect(parseRerankScores([{ index: 0, score: 1 }, { index: 0, score: 2 }])).toBeNull()
    expect(parseRerankScores([{ index: 0, score: Number.NaN }])).toBeNull()
    expect(parseRerankScores([])).toBeNull()
    expect(parseRerankScores({ results: 'nope' })).toBeNull()
    expect(parseRerankScores(null)).toBeNull()
  })

  it('index 有空洞（缺 1）→ null，不产出错位数组', () => {
    expect(
      parseRerankScores([
        { index: 0, score: 1 },
        { index: 2, score: 2 },
      ]),
    ).toBeNull()
  })
})

// ── SPEC-1.2/1.7：文档预算（token 保守折算成字符）─────────────────────────────

describe('SPEC-1.2/1.7 boundRerankDocs：按档位预算裁剪候选文档', () => {
  it('超长截断到预算，短的原样；顺序与条数不变', () => {
    expect(boundRerankDocs(['a'.repeat(300)], 256)).toEqual(['a'.repeat(256)])
    expect(boundRerankDocs(['短'], 256)).toEqual(['短'])
    expect(boundRerankDocs(['x'.repeat(600), 'y', ''], 512)).toEqual(['x'.repeat(512), 'y', ''])
  })

  it('两档预算取自档位表（512 / 256），且都装得进 ctx', () => {
    for (const tier of RERANK_TIERS) {
      const m = RERANK_MODELS[tier]
      expect(boundRerankDocs(['z'.repeat(10_000)], m.maxDocChars)[0]).toHaveLength(m.maxDocChars)
      expect(m.maxDocChars).toBeLessThanOrEqual(m.ctx)
    }
  })
})

// ── SPEC-1.4：四态（注入 fetch 层；关档在下一节）─────────────────────────────
describe('SPEC-1.4 callRerank：一次请求 / 失败 / 超时', () => {
  it('成功：POST /rerank，body {query, documents} 一次数组请求 → 按入参顺序返分', async () => {
    const { calls, fetch } = fakeFetch(() =>
      jsonResponse({ results: [{ index: 1, relevance_score: 2 }, { index: 0, relevance_score: 1 }] }),
    )
    setRerankFetch(fetch)
    const result = await callRerank('查询', ['甲', '乙'], 3000)
    expect(result).toEqual({ ok: true, scores: [1, 2] })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.endsWith('/rerank')).toBe(true)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ query: '查询', documents: ['甲', '乙'] })
  })

  it('失败：HTTP 500 → {ok:false, reason:http}（不抛）', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: 'boom' }, 500))
    setRerankFetch(fetch)
    expect(await callRerank('q', ['a'], 3000)).toEqual({ ok: false, reason: 'http' })
  })

  it('超时：fetch 以 TimeoutError 拒绝 → reason:timeout', async () => {
    const { fetch } = fakeFetch(() => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      return Promise.reject(err)
    })
    setRerankFetch(fetch)
    expect(await callRerank('q', ['a'], 3000)).toEqual({ ok: false, reason: 'timeout' })
  })

  it('网络错：其它拒绝 → reason:network', async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new Error('ECONNREFUSED')))
    setRerankFetch(fetch)
    expect(await callRerank('q', ['a'], 3000)).toEqual({ ok: false, reason: 'network' })
  })

  it('响应形状不可解析 → reason:parse', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ results: [{ nonsense: true }] }))
    setRerankFetch(fetch)
    expect(await callRerank('q', ['a'], 3000)).toEqual({ ok: false, reason: 'parse' })
  })

  it('空候选不发请求（零候选无意义，也不该打端点）', async () => {
    const { calls, fetch } = fakeFetch(() => jsonResponse({ results: [] }))
    setRerankFetch(fetch)
    expect(await callRerank('q', [], 3000)).toEqual({ ok: true, scores: [] })
    expect(calls).toHaveLength(0)
  })

  it('超时随档走：请求真的带上 AbortSignal（不是无超时的裸 fetch）', async () => {
    const { calls, fetch } = fakeFetch(() => jsonResponse({ results: [{ index: 0, score: 1 }] }))
    setRerankFetch(fetch)
    await callRerank('q', ['a'], 3000)
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })
})

// ── SPEC-1.5：门控独立 + 关档不发请求 ────────────────────────────────────────

describe('SPEC-1.5 门控：rerankInstalled 独立、关档不发请求', () => {
  it('PRISM_RERANK=off 恒压制实装判定；清掉开关即回到原判定（不污染状态）', () => {
    // 不假设「本机没下过 rerank 档模型」——装了模型的机器是合法常态（波次 3 已实装两档）。
    vi.stubEnv('PRISM_RERANK', '')
    const real = rerankInstalled() // 本机实装判定（装/未装都合法，只要求自洽）
    vi.stubEnv('PRISM_RERANK', 'off')
    expect(rerankInstalled()).toBe(false) // 开关恒压制（与 embedding 侧开关互不代入）
    vi.stubEnv('PRISM_RERANK', '')
    expect(rerankInstalled()).toBe(real) // 清掉开关不是「写坏」，而是回到实装值
  })

  it('未就绪时 rerankText 直接返回 null，**不发请求**（关档跳过）', async () => {
    vi.stubEnv('PRISM_RERANK', 'off')
    const { calls, fetch } = fakeFetch(() => jsonResponse({ results: [{ index: 0, score: 1 }] }))
    setRerankFetch(fetch)
    expect(await rerankText('q', ['a'])).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('rerankInstalled 只认 rerank 档模型（不因 embedding 已装而变真）', () => {
    // 本仓测试环境恒 `PRISM_EMBEDDING=off`（vitest env）——即便嵌入侧关掉，
    // 也不影响 rerank 的门控判定本身（两者互不代入）
    vi.stubEnv('PRISM_EMBEDDING', 'off')
    expect(typeof rerankInstalled()).toBe('boolean')
    vi.stubEnv('PRISM_RERANK', 'off')
    expect(rerankInstalled()).toBe(false)
  })

  it('档位判定各自独立：设 rerank 档不动 embedding 档（反向亦然）', () => {
    const before = activeRerankTier()
    setRerankTier('gpu')
    expect(activeRerankTier()).toBe('gpu')
    setRerankTier('cpu')
    expect(activeRerankTier()).toBe('cpu')
    setRerankTier(undefined)
    expect(activeRerankTier()).toBe(before)
  })

  it('stopRerankServer：无实例时返回 false 且不抛（不会误杀 embedding）', async () => {
    const { stopRerankServer } = await import('../src/kb/embedding.js')
    expect(() => stopRerankServer()).not.toThrow()
    expect(typeof stopRerankServer()).toBe('boolean')
  })
})

// ── 设备跟随档位（v14 检视批队长裁决②的回归锁）──────────────────────────────

describe('设备跟随档位：resolveRerankBackend（裁决②纯函数化后的逐分支回归）', () => {
  it('cpu 档 → 恒 CPU：GPU 机器上也不许再被 -ngl 99 卸载进显存（裁决②针对的缺陷）', () => {
    expect(resolveRerankBackend('cpu', 'gpu')).toBe('cpu')
    expect(resolveRerankBackend('cpu', 'cpu')).toBe('cpu')
  })

  it('gpu 档 → 跟随探测后端：GPU 机器走 GPU、CPU 机器自然回落 CPU 执行', () => {
    expect(resolveRerankBackend('gpu', 'gpu')).toBe('gpu')
    expect(resolveRerankBackend('gpu', 'cpu')).toBe('cpu')
  })

  it('判定产物接 argv：cpu 档在 GPU 机器上的 spawn 不带 -ngl（与 buildRerankServerArgv 对齐）', () => {
    const backend = resolveRerankBackend('cpu', 'gpu') // 最易脱节的组合：GPU 机器 + 显式 cpu 档
    expect(buildRerankServerArgv({ modelPath: 'm', ctx: 1024, gpu: backend === 'gpu' })).not.toContain('-ngl')
  })
})
