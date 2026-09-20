/**
 * v13 §1.1 / SPEC-1.13：kb 装配配置的扁平键贯通与启动校验。
 *
 * 分两层：
 * 1. **纯函数层**（`resolveKbWiringConfig` / `resolveChunkMaxChars`）——三档自适应、
 *    合法透传、违规回落与告警，逐条确定性断言；
 * 2. **管道层**（`loadKnowledgeService` + 临时 `<home>/prism.yaml`）——证明配置真的
 *    落到了知识服务（同文档段数随 `chunk_max_chars` 变），且缺文件/空文件/非法值不炸。
 *
 * R5：home 一律 `mkdtemp` 临时目录；vitest 全局 `PRISM_EMBEDDING=off`，故「未装嵌入」
 * 分档（clientMaxChars undefined）在管道层恒成立，也不会去起 embedding 服务。
 */
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import type { PrismKnowledgeService } from '@prism/knowledge'

import { EMBEDDING_MODELS, EMBEDDING_TIERS, RERANK_MODELS } from '../src/kb/embedding-models.js'
import type { EmbeddingTier } from '../src/kb/embedding-models.js'
import {
  CHUNK_MIN_CHARS,
  DEFAULT_VECTOR_SCAN_CAP,
  loadKnowledgeService,
  parseGraphFusion,
  parseGraphFusionDecay,
  parseRerankEnabled,
  prismConfigValue,
  resolveChunkMaxChars,
  resolveGraphFusionConfigForHome,
  resolveKbWiringConfig,
  resolveRerankConfigForHome,
  resolveRerankWiringConfig,
} from '../src/kb/wiring.js'
import { GRAPH_FUSION_DECAY } from '@prism/knowledge'
import { rerankInstalled } from '../src/kb/embedding.js'
import { makeTempDir, putFile } from './helpers.js'

describe('chunk_max_chars：默认分档（R2 修订）', () => {
  it('三档客户端上限 → 240 / 1200 / 1200；未装 → 2000', () => {
    // 前提锁定：分档表的三档 maxChars 就是 400/1500/1500（表变了这条要显式失败）
    expect(EMBEDDING_MODELS.small.maxChars).toBe(400)
    expect(EMBEDDING_MODELS.default.maxChars).toBe(1500)
    expect(EMBEDDING_MODELS.large.maxChars).toBe(1500)

    const expected: Record<EmbeddingTier, number> = { small: 240, default: 1200, large: 1200 }
    for (const tier of EMBEDDING_TIERS) {
      const config = resolveKbWiringConfig({ clientMaxChars: EMBEDDING_MODELS[tier].maxChars })
      expect(config.chunkOptions.maxChars).toBe(expected[tier])
      expect(config.warnings).toEqual([])
    }

    expect(resolveKbWiringConfig({ clientMaxChars: undefined }).chunkOptions.maxChars).toBe(2000)
    expect(resolveKbWiringConfig({}).chunkOptions.maxChars).toBe(2000)
  })

  it('minChars 恒注入 120（与切分器默认同源）', () => {
    expect(CHUNK_MIN_CHARS).toBe(120)
    for (const clientMaxChars of [400, 1500, undefined]) {
      expect(resolveKbWiringConfig({ clientMaxChars }).chunkOptions.minChars).toBe(120)
    }
  })
})

describe('chunk_max_chars：合法值透传', () => {
  it('区间内直接透传，不告警', () => {
    // 未装嵌入（上界 2000）
    expect(resolveKbWiringConfig({ chunkMaxChars: '900' }).chunkOptions.maxChars).toBe(900)
    expect(resolveKbWiringConfig({ chunkMaxChars: '2000' }).chunkOptions.maxChars).toBe(2000) // 上界含
    expect(resolveKbWiringConfig({ chunkMaxChars: '121' }).chunkOptions.maxChars).toBe(121) // 下界不含
    // 分档后上界随档位收紧
    expect(resolveKbWiringConfig({ clientMaxChars: 400, chunkMaxChars: '240' }).chunkOptions.maxChars).toBe(240)
    expect(resolveKbWiringConfig({ clientMaxChars: 1500, chunkMaxChars: '1200' }).chunkOptions.maxChars).toBe(1200)
    expect(resolveKbWiringConfig({ clientMaxChars: 400, chunkMaxChars: '121' }).chunkOptions.maxChars).toBe(121)
  })

  it('缺省 / 空串 / 纯空白 → 静默默认分档（不告警）', () => {
    for (const raw of [undefined, '', '   ']) {
      const config = resolveKbWiringConfig({ chunkMaxChars: raw, clientMaxChars: 400 })
      expect(config.chunkOptions.maxChars).toBe(240)
      expect(config.warnings).toEqual([])
    }
  })
})

describe('chunk_max_chars：启动校验（R3：上界=回落值，同一公式）', () => {
  it('未装嵌入：100 / 99999 / abc / 0 / -5 → 告警 + 回落 2000', () => {
    for (const raw of ['100', '99999', 'abc', '0', '-5', '50abc']) {
      const config = resolveKbWiringConfig({ chunkMaxChars: raw })
      expect(config.chunkOptions.maxChars).toBe(2000)
      expect(config.warnings).toHaveLength(1)
      expect(String(config.warnings[0])).toContain('chunk_max_chars')
    }
  })

  it('同一违规值在不同档位回落不同（small 档回落 240）', () => {
    expect(resolveKbWiringConfig({ clientMaxChars: 400, chunkMaxChars: '99999' }).chunkOptions.maxChars).toBe(240)
    expect(resolveKbWiringConfig({ clientMaxChars: 1500, chunkMaxChars: '99999' }).chunkOptions.maxChars).toBe(1200)
    expect(resolveKbWiringConfig({ clientMaxChars: undefined, chunkMaxChars: '99999' }).chunkOptions.maxChars).toBe(2000)
    // 100 对 small 档同样违规（≤ minChars），回落同一公式值
    const small = resolveKbWiringConfig({ clientMaxChars: 400, chunkMaxChars: '100' })
    expect(small.chunkOptions.maxChars).toBe(240)
    expect(small.warnings).toHaveLength(1)
  })

  it('告警文案带原始值与回落值', () => {
    const [warning = ''] = resolveKbWiringConfig({ clientMaxChars: 400, chunkMaxChars: '99999' }).warnings
    expect(warning).toContain('99999')
    expect(warning).toContain('240')
  })
})

describe('resolveChunkMaxChars 纯函数（bound / minChars 显式）', () => {
  it('缺省返回 bound；越界回落到 bound 并把告警写进收集器', () => {
    const quiet: string[] = []
    expect(resolveChunkMaxChars(undefined, 240, 120, quiet)).toBe(240)
    expect(quiet).toEqual([])

    const loud: string[] = []
    expect(resolveChunkMaxChars('300', 240, 120, loud)).toBe(240)
    expect(loud).toHaveLength(1)
    expect(resolveChunkMaxChars('120', 240, 120, loud)).toBe(240) // ≤ minChars
    expect(resolveChunkMaxChars('241', 240, 120, loud)).toBe(240) // > bound
    expect(loud).toHaveLength(3)
  })

  it('不传收集器也不炸（缺省参数）', () => {
    expect(resolveChunkMaxChars('99999', 240, 120)).toBe(240)
    expect(resolveChunkMaxChars('200', 240, 120)).toBe(200)
  })
})

describe('vector_scan_cap（SPEC-3.7 管道，缺省 50000）', () => {
  it('合法值透传（小数向下取整）', () => {
    expect(DEFAULT_VECTOR_SCAN_CAP).toBe(50_000)
    expect(resolveKbWiringConfig({ vectorScanCap: '1234' }).vectorScanCap).toBe(1234)
    expect(resolveKbWiringConfig({ vectorScanCap: '2500.9' }).vectorScanCap).toBe(2500)
  })

  it('缺省 / 非法（abc / 0 / -1 / 空串）→ 50000', () => {
    for (const raw of [undefined, '', 'abc', '0', '-1', 'Infinity']) {
      expect(resolveKbWiringConfig({ vectorScanCap: raw }).vectorScanCap).toBe(50_000)
    }
  })

  it('与 chunk_max_chars 互不影响，且违规时不额外告警', () => {
    const config = resolveKbWiringConfig({ chunkMaxChars: 'abc', vectorScanCap: 'abc' })
    expect(config.vectorScanCap).toBe(50_000)
    expect(config.warnings).toHaveLength(1) // 只有 chunk_max_chars 那条
  })
})

describe('rerank 扁平键（v14 §1.1；SPEC-1.2/1.3/1.5/1.7）', () => {
  it('parseRerankEnabled：缺省/auto 走档位默认，显式 on/off 优先，非法告警回落', () => {
    expect(parseRerankEnabled(undefined, true)).toBe(true)
    expect(parseRerankEnabled(undefined, false)).toBe(false)
    for (const raw of ['', '  ', 'auto', 'AUTO']) {
      expect(parseRerankEnabled(raw, true)).toBe(true)
      expect(parseRerankEnabled(raw, false)).toBe(false)
    }
    for (const raw of ['on', 'ON', 'true', '1']) expect(parseRerankEnabled(raw, false)).toBe(true)
    for (const raw of ['off', 'OFF', 'false', '0']) expect(parseRerankEnabled(raw, true)).toBe(false)

    const warnings: string[] = []
    expect(parseRerankEnabled('maybe', true, warnings)).toBe(true)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('rerank_enabled')
    expect(warnings[0]).toContain('maybe')
  })

  it('档位默认：GPU 开（24 候选/3s）、CPU 关（10 候选/10s）——值取自档位表', () => {
    const gpu = resolveRerankWiringConfig({ autoTier: 'gpu', installed: true })
    expect(gpu).toMatchObject({
      enabled: true,
      tier: 'gpu',
      candidates: RERANK_MODELS.gpu.candidates,
      timeoutMs: 3000,
      maxDocChars: 512,
    })
    const cpu = resolveRerankWiringConfig({ autoTier: 'cpu', installed: true })
    expect(cpu).toMatchObject({ enabled: false, tier: 'cpu', candidates: 10, timeoutMs: 10_000, maxDocChars: 256 })
  })

  it('SPEC-1.3：显式 on/off 优先于档位默认（CPU 可开、GPU 可关）', () => {
    expect(resolveRerankWiringConfig({ enabled: 'on', autoTier: 'cpu', installed: true }).enabled).toBe(true)
    expect(resolveRerankWiringConfig({ enabled: 'off', autoTier: 'gpu', installed: true }).enabled).toBe(false)
    // 'auto' 等于不写（按档）
    expect(resolveRerankWiringConfig({ enabled: 'auto', autoTier: 'cpu', installed: true }).enabled).toBe(false)
  })

  it('SPEC-1.5：未装 → 一律不启用（显式 on 也不发请求）', () => {
    for (const enabled of [undefined, 'auto', 'on']) {
      for (const autoTier of ['gpu', 'cpu'] as const) {
        expect(resolveRerankWiringConfig({ enabled, autoTier, installed: false }).enabled).toBe(false)
      }
    }
  })

  it('rerank_model：档位名或模型 id 都认；未知告警并回落自动档位', () => {
    expect(resolveRerankWiringConfig({ model: 'gpu', autoTier: 'cpu', installed: true }).tier).toBe('gpu')
    expect(resolveRerankWiringConfig({ model: 'bge-reranker-v2-m3-q4', autoTier: 'cpu' }).tier).toBe('gpu')
    expect(resolveRerankWiringConfig({ model: 'bge-reranker-base-q4', autoTier: 'gpu' }).tier).toBe('cpu')

    const warnings: string[] = []
    const cfg = resolveRerankWiringConfig({ model: 'nope', autoTier: 'gpu', installed: true, warnings })
    expect(cfg.tier).toBe('gpu')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('rerank_model')
  })

  it('resolveRerankConfigForHome：prism.yaml 的 rerank_enabled / rerank_model 真被读到', async () => {
    const home = await makeTempDir('prism-kb-rerank-wiring-')
    // 缺文件 → 按档位默认 + 自动档位，无告警
    const none = resolveRerankConfigForHome(home)
    expect(none.warnings).toEqual([])
    expect(none.tier).toBe(resolveRerankConfigForHome(undefined).tier)

    await putFile(join(home, 'prism.yaml'), 'rerank_enabled: off\nrerank_model: gpu\n')
    const off = resolveRerankConfigForHome(home)
    expect(off.tier).toBe('gpu')
    expect(off.candidates).toBe(24)
    expect(off.enabled).toBe(false) // 显式 off 恒关

    await putFile(join(home, 'prism.yaml'), 'rerank_enabled: on\nrerank_model: cpu\n')
    const on = resolveRerankConfigForHome(home)
    expect(on.tier).toBe('cpu')
    // 未装 → false；装了才算真启用（本仓测试环境没下过 rerank 档模型）
    expect(on.enabled).toBe(rerankInstalled())
  })
})

describe('prismConfigValue：缺文件 / 空文件 / 非法值', () => {
  it('无 prism.yaml → undefined，不炸', async () => {
    const home = await makeTempDir('prism-kb-wiring-')
    expect(prismConfigValue(home, 'chunk_max_chars')).toBeUndefined()
    expect(prismConfigValue(undefined, 'chunk_max_chars')).toBeUndefined()
  })

  it('空文件 / 空值 / 注释 → undefined；有值 → 原样字符串', async () => {
    const home = await makeTempDir('prism-kb-wiring-')
    await putFile(join(home, 'prism.yaml'), '# 注释\nchunk_max_chars:\nvector_scan_cap: 1234\n')

    expect(prismConfigValue(home, 'chunk_max_chars')).toBeUndefined()
    expect(prismConfigValue(home, 'vector_scan_cap')).toBe('1234')

    await putFile(join(home, 'prism.yaml'), '')
    expect(prismConfigValue(home, 'vector_scan_cap')).toBeUndefined()
    // 空文件 + 缺值 → 全默认
    const config = resolveKbWiringConfig({ chunkMaxChars: prismConfigValue(home, 'chunk_max_chars') })
    expect(config.chunkOptions.maxChars).toBe(2000)
    expect(config.vectorScanCap).toBe(50_000)
    expect(config.warnings).toEqual([])
  })
})

describe('loadKnowledgeService：配置真的落到服务（E2E 管道）', () => {
  /** 602 字无句号的正文：> 240 且 > 2×240，硬截断兜底切点可预测。 */
  const body = `${'甲'.repeat(300)}\n\n${'乙'.repeat(300)}\n`

  async function depositAndCount(kb: PrismKnowledgeService, id: string): Promise<number[]> {
    await kb.deposit({ id, title: 'T', type: 'doc', layer: 'global', book: 'b', content: body })
    const rows = kb.persistence.knowledge.raw
      .prepare('SELECT text FROM kb_chunks WHERE entry_id = ? ORDER BY seq')
      .all(id) as unknown as Array<{ text: string }>
    return rows.map((r) => r.text.length)
  }

  it('prism.yaml 的 chunk_max_chars=240 生效（段数 >1，子段 ≤ 264）', async () => {
    const home = await makeTempDir('prism-kb-wiring-')
    await putFile(join(home, 'prism.yaml'), 'chunk_max_chars: 240\n')
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      const lengths = await depositAndCount(kb, 'W-1')
      expect(lengths.length).toBeGreaterThan(1) // 若仍是默认 2000，602 字只会 1 段
      for (const len of lengths) expect(len).toBeLessThanOrEqual(264) // maxChars×1.1
    } finally {
      kb.close()
    }
  })

  it('无 prism.yaml → 默认 2000（同一正文只 1 段）', async () => {
    const home = await makeTempDir('prism-kb-wiring-')
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      expect(await depositAndCount(kb, 'W-2')).toHaveLength(1)
    } finally {
      kb.close()
    }
  })

  it('非法 chunk_max_chars → 告警 + 回落（仍能装载与落库）', async () => {
    const home = await makeTempDir('prism-kb-wiring-')
    await putFile(join(home, 'prism.yaml'), 'chunk_max_chars: 100\nvector_scan_cap: abc\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('chunk_max_chars')
      // 测试环境未装嵌入 → 回落 2000 → 602 字 1 段
      expect(await depositAndCount(kb, 'W-3')).toHaveLength(1)
    } finally {
      warn.mockRestore()
      kb.close()
    }
  })

  it('空 prism.yaml → 全默认、无告警、不炸', async () => {
    const home = await makeTempDir('prism-kb-wiring-')
    await putFile(join(home, 'prism.yaml'), '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      expect(warn).not.toHaveBeenCalled()
      expect(await depositAndCount(kb, 'W-4')).toHaveLength(1)
    } finally {
      warn.mockRestore()
      kb.close()
    }
  })
})

describe('图谱融合扁平键（v14 §2；SPEC-2.1/2.3）', () => {
  it('parseGraphFusion：缺省 / 空串 / on 系 → 开；off 系 → 关；非法告警回落 on', () => {
    for (const raw of [undefined, '', '  ', 'on', 'ON', 'true', '1']) {
      expect(parseGraphFusion(raw), String(raw)).toBe(true)
    }
    for (const raw of ['off', 'OFF', 'false', '0']) expect(parseGraphFusion(raw)).toBe(false)

    const warnings: string[] = []
    expect(parseGraphFusion('maybe', warnings)).toBe(true) // 默认开 → 回落 on
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('graph_fusion')
    expect(warnings[0]).toContain('maybe')
  })

  it('parseGraphFusionDecay：缺省 0.5；(0,1] 透传；≤0 / >1 / 非数字 → 告警回落', () => {
    expect(GRAPH_FUSION_DECAY).toBe(0.5)
    for (const raw of [undefined, '', '  ']) expect(parseGraphFusionDecay(raw)).toBe(0.5)
    expect(parseGraphFusionDecay('1')).toBe(1) // 上界含
    expect(parseGraphFusionDecay('0.25')).toBe(0.25)

    const warnings: string[] = []
    for (const raw of ['0', '-1', '1.5', 'abc', 'Infinity']) {
      expect(parseGraphFusionDecay(raw, warnings)).toBe(0.5)
    }
    expect(warnings).toHaveLength(5)
    for (const w of warnings) expect(w).toContain('graph_fusion_decay')
  })

  it('resolveGraphFusionConfigForHome：缺文件 → on / 0.5 无告警；写键 → 真读到', async () => {
    const home = await makeTempDir('prism-kb-fusion-wiring-')
    const none = resolveGraphFusionConfigForHome(home)
    expect(none).toMatchObject({ enabled: true, decay: 0.5 })
    expect(none.warnings).toEqual([])

    await putFile(join(home, 'prism.yaml'), 'graph_fusion: off\ngraph_fusion_decay: 0.2\n')
    expect(resolveGraphFusionConfigForHome(home)).toMatchObject({ enabled: false, decay: 0.2 })
  })
})

describe('loadKnowledgeService：图谱融合键贯通（v14 §2；SPEC-2.3）', () => {
  /** A 引用 B（正文双链）——B 不含检索词，只能由引用扩展并入。 */
  async function seed(kb: PrismKnowledgeService): Promise<void> {
    await kb.deposit({
      id: 'G-1',
      title: '甲',
      type: 'doc',
      layer: 'global',
      book: 'b',
      content: '## 甲一\n独角鲸甲正文。\n\n[[G-2]]\n',
    })
    await kb.deposit({
      id: 'G-2',
      title: '乙',
      type: 'doc',
      layer: 'global',
      book: 'b',
      content: '## 乙一\n乙的普通正文。\n',
    })
  }

  const searchIds = async (kb: PrismKnowledgeService): Promise<string[]> =>
    (await kb.searchWithMeta({ q: '独角鲸', limit: 10 })).results.map((r) => r.id)

  it('缺 prism.yaml → 默认 on，被引条目并入', async () => {
    const home = await makeTempDir('prism-kb-fusion-')
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      await seed(kb)
      expect(await searchIds(kb)).toEqual(['G-1', 'G-2'])
    } finally {
      kb.close()
    }
  })

  it('graph_fusion: off → 零扩展（只留被检索到的条目）', async () => {
    const home = await makeTempDir('prism-kb-fusion-')
    await putFile(join(home, 'prism.yaml'), 'graph_fusion: off\n')
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      await seed(kb)
      expect(await searchIds(kb)).toEqual(['G-1'])
    } finally {
      kb.close()
    }
  })

  it('非法键值 → 装载时逐条告警（不静默吞掉拼错的键）', async () => {
    const home = await makeTempDir('prism-kb-fusion-')
    await putFile(join(home, 'prism.yaml'), 'graph_fusion: maybe\ngraph_fusion_decay: 9\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0]?.[0])).toContain('graph_fusion')
      await seed(kb)
      expect(await searchIds(kb)).toEqual(['G-1', 'G-2']) // 回落 on
    } finally {
      warn.mockRestore()
      kb.close()
    }
  })
})

describe('loadKnowledgeService：rerank 键贯通（v14 §1.2；SPEC-1.3/1.5）', () => {
  /** 精排只作用于 `#fusedResults`（有段行的库）；这里先落一条再检索。 */
  async function depositOne(kb: PrismKnowledgeService, id: string): Promise<void> {
    await kb.deposit({
      id,
      title: 'T',
      type: 'doc',
      layer: 'global',
      book: 'b',
      content: `## 节\n${'词语'.repeat(30)}\n`,
    })
  }

  it('rerank_enabled: on 但实装未就绪/已关断 → 不注入、不发请求、不告警，检索照常', async () => {
    const home = await makeTempDir('prism-kb-rerank-')
    await putFile(join(home, 'prism.yaml'), 'rerank_enabled: on\nrerank_model: gpu\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 「未就绪」用 `PRISM_RERANK=off` 取得**确定性形态**——不假设本机没下过 rerank 档模型
    // （波次 3 起本机两档俱在，写死 false 会随环境漂移）。
    vi.stubEnv('PRISM_RERANK', 'off')
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      await depositOne(kb, 'R-1')
      const hit = await kb.search({ q: '词语' })
      expect(hit.map((r) => r.id)).toEqual(['R-1'])
      expect(warn).not.toHaveBeenCalled()
      // 装配结论自证：未就绪 → enabled=false（SPEC-1.5 的短路而非「发了再降级」）
      expect(resolveRerankConfigForHome(home).enabled).toBe(false)
      // 清掉开关后回到**关系式**：enabled 恒 = 「请求开」 && 实装就绪（装与未装机器上同样成立）
      vi.stubEnv('PRISM_RERANK', '')
      expect(resolveRerankConfigForHome(home).enabled).toBe(rerankInstalled())
    } finally {
      warn.mockRestore()
      kb.close()
      vi.unstubAllEnvs()
    }
  })

  it('rerank_enabled 写成非法值 → 装载时告警（不静默吞掉拼错的键）', async () => {
    const home = await makeTempDir('prism-kb-rerank-')
    await putFile(join(home, 'prism.yaml'), 'rerank_enabled: yes-please\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
    try {
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('rerank_enabled')
      await depositOne(kb, 'R-2')
      expect((await kb.search({ q: '词语' })).map((r) => r.id)).toEqual(['R-2'])
    } finally {
      warn.mockRestore()
      kb.close()
    }
  })
})
