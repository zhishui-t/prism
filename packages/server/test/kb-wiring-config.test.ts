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

import { EMBEDDING_MODELS, EMBEDDING_TIERS } from '../src/kb/embedding-models.js'
import type { EmbeddingTier } from '../src/kb/embedding-models.js'
import {
  CHUNK_MIN_CHARS,
  DEFAULT_VECTOR_SCAN_CAP,
  loadKnowledgeService,
  prismConfigValue,
  resolveChunkMaxChars,
  resolveKbWiringConfig,
} from '../src/kb/wiring.js'
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
