import { describe, expect, it } from 'vitest'

import { ScanHistory, type ScanRecord } from '../src/kb/scan-history.js'
import { makeTempDir } from './helpers.js'

function rec(project: string, overrides: Partial<ScanRecord> = {}): ScanRecord {
  return {
    project,
    root: `D:/x/${project}`,
    scanned_at: new Date().toISOString(),
    discovered: 3,
    created: 2,
    updated: 1,
    unchanged: 0,
    skipped: 0,
    missing: [],
    unreadable: [],
    truncated: false,
    ...overrides,
  }
}

/** 扫描历史（append-only JSONL）：报告不再输出即焚。 */
describe('ScanHistory', () => {
  it('append + list：最新在前，可按项目过滤', async () => {
    const h = new ScanHistory(await makeTempDir('prism-hist-'))
    await h.append(rec('a', { scanned_at: '2026-01-01T00:00:00.000Z' }))
    await h.append(rec('b'))
    await h.append(rec('a', { scanned_at: '2026-01-02T00:00:00.000Z' }))

    const all = await h.list()
    expect(all).toHaveLength(3)
    expect(all[0]?.project).toBe('a') // 最新在前

    const onlyA = await h.list('a')
    expect(onlyA).toHaveLength(2)
    expect(onlyA[0]?.scanned_at).toBe('2026-01-02T00:00:00.000Z')
  })

  it('latest 取最近一次；无历史 → null / 空数组', async () => {
    const h = new ScanHistory(await makeTempDir('prism-hist-'))
    expect(await h.list()).toEqual([])
    expect(await h.latest('nope')).toBeNull()

    await h.append(rec('a'))
    expect((await h.latest('a'))?.project).toBe('a')
  })

  it('limit 生效；坏行不导致整体失败', async () => {
    const home = await makeTempDir('prism-hist-')
    const h = new ScanHistory(home)
    await h.append(rec('a'))
    // 手工插入坏行
    const { appendFile } = await import('node:fs/promises')
    await appendFile(h.path, '{ 坏 JSON\n', 'utf-8')
    await h.append(rec('b'))

    const list = await h.list(undefined, 10)
    expect(list).toHaveLength(2) // 坏行被跳过，两条正常记录都在
    expect(await h.list(undefined, 1)).toHaveLength(1)
  })

  it('孤儿索引明细被完整记录（生产审计用）', async () => {
    const h = new ScanHistory(await makeTempDir('prism-hist-'))
    await h.append(rec('a', { missing: ['IDX-x', 'IDX-y'], unreadable: ['D:/locked'] }))
    const [latest] = await h.list('a')
    expect(latest?.missing).toEqual(['IDX-x', 'IDX-y'])
    expect(latest?.unreadable).toEqual(['D:/locked'])
  })
})
