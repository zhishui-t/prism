/**
 * v17 §B-5：`embed_batch` 扁平键**真的贯通到注入闭包**（不只是解析函数对）。
 *
 * 手法：`vi.mock` **partial** 替换 `kb/embedding.ts` 的 `embedBatchText` 为 spy（保留其余
 * 导出——同图模块如 `activeModel` / `embeddingInstalled` 不受影响，范本 `warmup-models.test.ts`），
 * 于是 `loadKnowledgeService` 注入的 `embedBatch` 闭包一被 `deposit` 触发，就能看到它把
 * **解析出的批大小**当第二参传给 `embedBatchText`。
 *
 * R5：home 一律临时目录；vitest 全局 `PRISM_EMBEDDING=off`，不会起真实实例。
 */
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PrismKnowledgeService } from '@prism/knowledge'

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ texts: string[]; size: number }>,
}))

vi.mock('../src/kb/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kb/embedding.js')>()
  return {
    ...actual,
    embedBatchText: async (texts: readonly string[], size: number) => {
      calls.push({ texts: [...texts], size })
      return texts.map(() => new Float32Array([1, 0, 0, 0]))
    },
  }
})

import { loadKnowledgeService } from '../src/kb/wiring.js'
import { makeTempDir, putFile } from './helpers.js'

afterEach(() => {
  calls.length = 0
  vi.restoreAllMocks()
})

async function depositOne(home: string, id: string): Promise<void> {
  const kb = (await loadKnowledgeService(home)) as PrismKnowledgeService
  try {
    await kb.deposit({
      id,
      title: '标题',
      type: 'doc',
      layer: 'global',
      book: 'b',
      content: '## 甲章\n甲内容。\n',
    })
  } finally {
    kb.close()
  }
}

describe('v17 §B-5：embed_batch 贯通到注入的 embedBatch 闭包', () => {
  it('prism.yaml 写 embed_batch: 3 → 批大小 3 传到 embedBatchText 第二参', async () => {
    const home = await makeTempDir('prism-kb-embed-batch-')
    await putFile(join(home, 'prism.yaml'), 'embed_batch: 3\n')
    await depositOne(home, 'E-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.size).toBe(3)
    expect(calls[0]?.texts.length).toBe(1)
  })

  it('缺 prism.yaml → 缺省 8（B-R §4① 口径）', async () => {
    const home = await makeTempDir('prism-kb-embed-batch-')
    await depositOne(home, 'E-2')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.size).toBe(8)
  })

  it('非法 embed_batch → 装载告警并回落 8', async () => {
    const home = await makeTempDir('prism-kb-embed-batch-')
    await putFile(join(home, 'prism.yaml'), 'embed_batch: abc\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await depositOne(home, 'E-3')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('embed_batch')
    expect(calls[0]?.size).toBe(8)
  })
})
