import { describe, expect, it } from 'vitest'

import { ProjectRegistry } from '../src/graph/registry.js'
import { makeTempDir } from './helpers.js'

/** 项目台账（A1）：登记/列表/移除/扫描记录，含 v1 向后兼容。 */
describe('ProjectRegistry（项目登记台账）', () => {
  it('register 写 registered_at；重复登记保留首次时间与 built_at', async () => {
    const home = await makeTempDir('prism-reg-')
    const reg = new ProjectRegistry(home)

    const first = await reg.register('proj-a', 'D:/x/proj-a')
    expect(first.registered_at).toBeDefined()
    expect(first.built_at).toBeNull()

    // 建图后标记 built_at，再重新登记（模拟 graph build 后跑 project add）
    const builtAt = '2026-01-01T00:00:00.000Z'
    await reg.markBuilt('proj-a', builtAt)
    const again = await reg.register('proj-a', 'D:/x/proj-a')
    expect(again.registered_at).toBe(first.registered_at)
    expect(again.built_at).toBe(builtAt)
  })

  it('list 返回全部字段；get 未登记 → not_found', async () => {
    const home = await makeTempDir('prism-reg-')
    const reg = new ProjectRegistry(home)
    await reg.register('b-proj', 'D:/x/b')
    await reg.register('a-proj', 'D:/x/a')
    await reg.markScanned('a-proj', 7)

    const list = await reg.list()
    expect(list.map((p) => p.project)).toEqual(['a-proj', 'b-proj']) // 按名排序
    const a = list.find((p) => p.project === 'a-proj')!
    expect(a.scanned_sources).toBe(7)
    expect(a.last_scan_at).toBeDefined()

    await expect(reg.get('nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('remove 移除条目并返回布尔；重复移除为 false', async () => {
    const home = await makeTempDir('prism-reg-')
    const reg = new ProjectRegistry(home)
    await reg.register('proj-a', 'D:/x/a')

    expect(await reg.remove('proj-a')).toBe(true)
    expect(await reg.remove('proj-a')).toBe(false)
    expect(await reg.list()).toEqual([])
  })

  it('markScanned 对未登记项目静默无操作（不抛、不创建）', async () => {
    const home = await makeTempDir('prism-reg-')
    const reg = new ProjectRegistry(home)
    await reg.markScanned('ghost', 3)
    expect(await reg.list()).toEqual([])
  })

  it('向后兼容 v1 文件（无扩展字段）→ 读取不炸，字段为 undefined', async () => {
    const home = await makeTempDir('prism-reg-')
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(join(home, 'graph'), { recursive: true })
    await writeFile(
      join(home, 'graph', 'projects.json'),
      JSON.stringify({ version: 1, projects: { legacy: { root: 'D:/x/legacy', built_at: null } } }),
      'utf-8',
    )
    const reg = new ProjectRegistry(home)
    const list = await reg.list()
    expect(list[0]?.project).toBe('legacy')
    expect(list[0]?.registered_at).toBeUndefined()
    expect(list[0]?.last_scan_at).toBeUndefined()
  })
})
