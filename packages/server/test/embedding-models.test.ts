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

import { EMBEDDING_MODELS, EMBEDDING_TIERS, resolveTier } from '../src/kb/embedding-models.js'

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
