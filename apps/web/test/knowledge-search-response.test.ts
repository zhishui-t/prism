/**
 * v13 W-3 真机炸点 1 回归（SPEC-3.6）：`GET /api/kb/search` 的**双形状归一**。
 *
 * 背景：服务端 B-4 起 `value` 是对象 `{ results, chunk_scan_degraded?, hits_truncated? }`，
 * 而 W-2 的客户端按**裸数组**消费（`searchRaw.length` / `.slice`）——真机上对象没有
 * `.length`，检索结果整块炸。修复是 `kbSearch` 里 `Array.isArray(data) ? { results: data } : data`。
 *
 * 这里用 `vi.stubGlobal('fetch')` 挡最外层（让 `api.ts` 跑真代码，而非 `vi.mock` 替掉它），
 * 覆盖三态：新对象形状、旧裸数组形状、响应级标记位透传。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type SearchResult } from '../src/api.ts'

function stubValue(value: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ json: async () => ({ ok: true, value }) })),
  )
}

function row(id: string): SearchResult {
  return {
    id,
    version: 1,
    title: id,
    type: 'rule',
    layer: 'project',
    book: 'b',
    module: 'm',
    excerpt: '',
    score: 1,
    source: 'fts',
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('kbSearch 双形状归一（真机炸点 1）', () => {
  it('新服务端对象形状：原样返回对象（含响应级标记位）', async () => {
    stubValue({ results: [row('a')], chunk_scan_degraded: true, hits_truncated: true })
    const res = await api.kbSearch({ q: 'x' })
    expect(res.results.map((r) => r.id)).toEqual(['a'])
    expect(res.chunk_scan_degraded).toBe(true)
    expect(res.hits_truncated).toBe(true)
  })

  it('旧服务端裸数组形状：归一为 `{ results }`，标记位缺省不下发', async () => {
    stubValue([row('a'), row('b')])
    const res = await api.kbSearch({ q: 'x' })
    expect(Array.isArray(res)).toBe(false)
    expect(res.results.map((r) => r.id)).toEqual(['a', 'b'])
    expect(res.chunk_scan_degraded).toBeUndefined()
    expect(res.hits_truncated).toBeUndefined()
  })

  it('空数组 / 空对象都不炸：`results` 恒为数组（消费方 `data.results ?? []` 安全）', async () => {
    stubValue([])
    expect((await api.kbSearch({ q: 'x' })).results).toEqual([])

    stubValue({ results: [] })
    expect((await api.kbSearch({ q: 'x' })).results).toEqual([])
  })

  it('条目级 `hits` 随结果原样透传（段列表数据面）', async () => {
    const hits = [{ seq: 2, heading_path: 'A › B', excerpt: 'e', score: 0.5 }]
    stubValue({ results: [{ ...row('a'), hits }] })
    const res = await api.kbSearch({ q: 'x' })
    expect(res.results[0].hits).toEqual(hits)
  })
})
