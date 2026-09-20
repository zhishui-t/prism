/**
 * 模型档位注册表一致性测试。
 *
 * `packages/server/src/kb/embedding-models.ts` 与 `scripts/setup-embedding.mjs` 各自
 * 维护一份档位表（运行时不导入脚本，避免 ESM/子进程耦合）。两处漂移会导致
 * 「装了模型但运行时找不到」——这里读脚本文本做交叉校验，锁死一致性。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { EMBEDDING_MODELS, EMBEDDING_TIERS, RERANK_MODELS, RERANK_TIERS, resolveRerankTier, resolveTier } from '../src/kb/embedding-models.js'

const scriptText = readFileSync(
  fileURLToPath(new URL('../../../scripts/setup-embedding.mjs', import.meta.url)),
  'utf-8',
)

describe('embedding 档位注册表', () => {
  it('三档齐备且 id 唯一', () => {
    expect(EMBEDDING_TIERS).toEqual(['small', 'default', 'large'])
    const ids = EMBEDDING_TIERS.map((t) => EMBEDDING_MODELS[t].id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每档文件名/维度/上下文自洽', () => {
    for (const tier of EMBEDDING_TIERS) {
      const m = EMBEDDING_MODELS[tier]
      expect(m.tier).toBe(tier)
      expect(m.file.endsWith('.gguf')).toBe(true)
      expect(m.dim).toBeGreaterThan(0)
      expect(m.ctx).toBeGreaterThanOrEqual(m.maxChars) // ctx 必须装得下单条最长输入
      expect(m.maxChars).toBeLessThanOrEqual(m.ctx)
    }
  })

  it('small 档是 512 维（省算力），default/large 是 1024 维', () => {
    expect(EMBEDDING_MODELS.small.dim).toBe(512)
    expect(EMBEDDING_MODELS.default.dim).toBe(1024)
    expect(EMBEDDING_MODELS.large.dim).toBe(1024)
  })

  it('causal 模型（Qwen3）声明 pooling=last', () => {
    expect(EMBEDDING_MODELS.large.pooling).toBe('last')
  })

  it('resolveTier 接受档位名与模型 id，未知返回 null', () => {
    expect(resolveTier('small')).toBe('small')
    expect(resolveTier('bge-m3-q8')).toBe('default')
    expect(resolveTier('qwen3-embedding-0.6b-q8')).toBe('large')
    expect(resolveTier(undefined)).toBeNull()
    expect(resolveTier('nope')).toBeNull()
  })

  it('安装脚本的档位表与注册表一致（防两处漂移）', () => {
    for (const tier of EMBEDDING_TIERS) {
      const m = EMBEDDING_MODELS[tier]
      // 脚本文本里应出现该档的文件名与 HF 仓库
      expect(scriptText, `脚本缺 ${tier} 的 file`).toContain(m.file)
      expect(scriptText, `脚本缺 ${tier} 的 repo`).toContain(m.repo)
    }
    // 脚本 TIERS 键集合与注册表一致
    const tiersBlock = scriptText.match(/const TIERS = \{([\s\S]*?)\n\}/)
    expect(tiersBlock).not.toBeNull()
    for (const tier of EMBEDDING_TIERS) {
      expect(tiersBlock![1]).toContain(`${tier}: {`)
    }
  })
})

/**
 * rerank 档位注册表（v14 §1.1；SPEC-1.2/1.6/1.7、M2、S7）。
 *
 * 与 embedding 同一手法：`scripts/setup-embedding.mjs` 也维护一份 rerank 表（运行时不导入
 * 脚本），这里读脚本文本做交叉校验防漂移——两处不一致 = 「装了模型但运行时找不到」。
 */
describe('rerank 档位注册表', () => {
  it('两档齐备（gpu/cpu）且 id 唯一', () => {
    expect(RERANK_TIERS).toEqual(['gpu', 'cpu'])
    const ids = RERANK_TIERS.map((t) => RERANK_MODELS[t].id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每档文件名/档位自洽，且 ctx ≥1024（M1：query+doc+模板）', () => {
    for (const tier of RERANK_TIERS) {
      const m = RERANK_MODELS[tier]
      expect(m.tier).toBe(tier)
      expect(m.file.endsWith('.gguf')).toBe(true)
      expect(m.ctx).toBeGreaterThanOrEqual(1024)
      // doc 预算（token 保守折算成字符）必须装得进 ctx
      expect(m.maxDocChars).toBeLessThanOrEqual(m.ctx)
    }
  })

  it('SPEC-1.2/1.7：GPU 档 24×512tok 默认开；CPU 档 10×256tok 默认关', () => {
    expect(RERANK_MODELS.gpu.candidates).toBe(24)
    expect(RERANK_MODELS.gpu.maxDocChars).toBe(512)
    expect(RERANK_MODELS.gpu.enabledByDefault).toBe(true)
    expect(RERANK_MODELS.cpu.candidates).toBe(10)
    expect(RERANK_MODELS.cpu.maxDocChars).toBe(256)
    expect(RERANK_MODELS.cpu.enabledByDefault).toBe(false)
  })

  it('M2：超时随档走（GPU 3s / CPU 10s），CPU 档不是必然超时的死配置', () => {
    expect(RERANK_MODELS.gpu.timeoutMs).toBe(3000)
    expect(RERANK_MODELS.cpu.timeoutMs).toBe(10000)
    expect(RERANK_MODELS.cpu.timeoutMs).toBeGreaterThan(RERANK_MODELS.gpu.timeoutMs)
  })

  it('S7 裁决已落地（波次 3 真机）：CPU 档换成 bge-reranker-base，无待证候选', () => {
    // 真机判别分实测：0.6B（因果 LM，无分类头）方向相反 → 按 S7 回落分支换交叉编码器
    expect(RERANK_MODELS.cpu.id).toBe('bge-reranker-base-q4')
    expect(RERANK_MODELS.cpu.repo).toContain('bge-reranker-base')
    expect('provisional' in RERANK_MODELS.cpu).toBe(false)
    expect('provisional' in RERANK_MODELS.gpu).toBe(false)
  })

  it('resolveRerankTier 接受档位名与模型 id，未知返回 null', () => {
    expect(resolveRerankTier('gpu')).toBe('gpu')
    expect(resolveRerankTier('cpu')).toBe('cpu')
    expect(resolveRerankTier('bge-reranker-v2-m3-q4')).toBe('gpu')
    expect(resolveRerankTier('bge-reranker-base-q4')).toBe('cpu')
    expect(resolveRerankTier(undefined)).toBeNull()
    expect(resolveRerankTier('nope')).toBeNull()
  })

  it('安装脚本的 rerank 表与注册表一致（防两处漂移）', () => {
    for (const tier of RERANK_TIERS) {
      const m = RERANK_MODELS[tier]
      expect(scriptText, `脚本缺 rerank ${tier} 的 file`).toContain(m.file)
      expect(scriptText, `脚本缺 rerank ${tier} 的 repo`).toContain(m.repo)
    }
    const block = scriptText.match(/const RERANK = \{([\s\S]*?)\n\}/)
    expect(block).not.toBeNull()
    for (const tier of RERANK_TIERS) {
      expect(block![1]).toContain(`${tier}: {`)
    }
  })
})
