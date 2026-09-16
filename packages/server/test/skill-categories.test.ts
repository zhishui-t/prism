/**
 * 技能分类存储（design-v8 §3 F7 / R-v8-5）：`<PRISM_HOME>/skill-categories.json`。
 *
 * 范式对照 `packages/server/src/graph/registry.ts`（ProjectRegistry）——
 * tmp + rename 原子替换、每次访问重读磁盘、跨进程后写胜出、坏文件按空表降级。
 * 本文件只测**存储自身**：三入口（HTTP/MCP/CLI）的一致性由各自 surface 测试对账。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PrismError } from '@prism/core'

import { parseCategorizeInput, SkillCategoryStore } from '../src/roles/skill-categories.js'

function isPrismError(error: unknown): error is PrismError {
  return error instanceof PrismError
}

describe('SkillCategoryStore（design-v8 §3 F7 存储）', () => {
  let home: string
  let store: SkillCategoryStore
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-skillcat-'))
    cleanup.push(home)
    store = new SkillCategoryStore(home)
  })

  afterEach(async () => {
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    cleanup.length = 0
  })

  it('落点 = <home>/skill-categories.json；文件不存在 → 空表（不抛）', async () => {
    expect(store.file.replaceAll('\\', '/')).toBe(join(home, 'skill-categories.json').replaceAll('\\', '/'))
    expect(await store.all()).toEqual({})
  })

  it('写 → 重读一致（新实例从磁盘读到，无进程内缓存）', async () => {
    const result = await store.categorize(['code-review', 'prism'], '质量')
    expect(result.category).toBe('质量')
    expect(result.updated).toEqual(['code-review', 'prism'])
    expect(result.cleared).toEqual([])
    expect(result.categories).toEqual({ 'code-review': '质量', prism: '质量' })

    // 另一个实例（模拟另一个进程）读同一文件 → 立即可见
    expect(await new SkillCategoryStore(home).all()).toEqual({ 'code-review': '质量', prism: '质量' })

    // 磁盘落的是 `{ "<技能名>": "<分类>" }` 形
    const onDisk = JSON.parse(await readFile(join(home, 'skill-categories.json'), 'utf-8')) as unknown
    expect(onDisk).toEqual({ 'code-review': '质量', prism: '质量' })
  })

  it('原子替换：写完不留 tmp 残留（目录里只有映射文件）', async () => {
    await store.categorize(['a'], 'X')
    await store.categorize(['a'], undefined)
    await store.categorize(['b', 'c'], 'Y')
    const entries = (await readdir(home)).sort()
    expect(entries).toEqual(['skill-categories.json'])
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })

  it('只动点名的键：其它条目原样保留（部分更新不整表重写）', async () => {
    await store.categorize(['a'], 'A')
    await store.categorize(['b'], 'B')
    await store.categorize(['a'], 'A2')
    expect(await store.all()).toEqual({ a: 'A2', b: 'B' })

    await store.categorize(['b'])
    expect(await store.all()).toEqual({ a: 'A2' })
  })

  it('清除语义：省略 category / 空串 / 纯空白 均同义 = 清除', async () => {
    for (const clear of [undefined, '', '   ']) {
      await store.categorize(['x'], 'X')
      expect(await store.all()).toEqual({ x: 'X' })
      const result = await store.categorize(['x'], clear)
      expect(result.category).toBeNull()
      expect(result.cleared).toEqual(['x'])
      expect(result.updated).toEqual([])
      expect(await store.all()).toEqual({})
      // 清除不存在的映射也是幂等成功（不回滚、不报错）
      expect(await store.categorize(['x'], clear)).toMatchObject({ category: null, cleared: ['x'] })
    }
  })

  it('names 为空（空数组 / 空串 / 纯空白）→ bad_request，且不落盘', async () => {
    for (const names of [[], [''], ['  ']]) {
      const error = await store.categorize(names, 'X').catch((e: unknown) => e)
      expect(isPrismError(error)).toBe(true)
      expect((error as PrismError).code).toBe('bad_request')
    }
    expect(await store.all()).toEqual({})
    // 从未写过 → 文件不存在（空表也不伪造文件）
    await expect(readFile(join(home, 'skill-categories.json'), 'utf-8')).rejects.toThrow()
  })

  it('重复名去重；名称/分类 trim 后落盘', async () => {
    const result = await store.categorize([' a ', 'a', 'b'], '  X  ')
    expect(result.updated).toEqual(['a', 'b'])
    expect(await store.all()).toEqual({ a: 'X', b: 'X' })
  })

  it('坏文件降级空表：非法 JSON / 数组 / null / 非字符串值都不抛', async () => {
    const write = async (raw: string) => await writeFile(join(home, 'skill-categories.json'), raw, 'utf-8')

    await write('{ not json')
    expect(await store.all()).toEqual({})

    await write('[1,2,3]')
    expect(await store.all()).toEqual({})

    await write('null')
    expect(await store.all()).toEqual({})

    // 结构合法但值非字符串/空串 → 视为无分类（只留真分类）
    await write('{"a":"A","b":123,"c":"","d":null,"e":{"nested":1}}')
    expect(await store.all()).toEqual({ a: 'A' })

    // 坏文件之后仍能正常写入（重建为合法表）
    await write('{ broken')
    await store.categorize(['fresh'], 'F')
    expect(await store.all()).toEqual({ fresh: 'F' })
  })

  it('跨进程后写胜出：外部直接改文件，读写两侧都看最新（无缓存闩）', async () => {
    await store.categorize(['a'], 'A')
    await writeFile(join(home, 'skill-categories.json'), JSON.stringify({ a: 'A-external', z: 'Z' }), 'utf-8')
    expect(await store.all()).toEqual({ a: 'A-external', z: 'Z' })
    // 写入基于**重读后的**最新内容合并（不会用陈旧快照盖掉外部条目）
    await store.categorize(['a'], 'A-local')
    expect(await store.all()).toEqual({ a: 'A-local', z: 'Z' })
  })
})

describe('parseCategorizeInput（三入口共用入参归一化）', () => {
  it('正常：names trim/去空、category 省略 = 清除', () => {
    expect(parseCategorizeInput({ names: [' a ', '', 'b'], category: ' X ' })).toEqual({
      names: ['a', 'b'],
      category: ' X ',
    })
    expect(parseCategorizeInput({ names: ['a'] })).toEqual({ names: ['a'] })
    expect(parseCategorizeInput({ names: ['a'], category: null })).toEqual({ names: ['a'] })
  })

  it('names 非数组 / 空数组 → bad_request', () => {
    for (const names of [undefined, null, 'a', 42, {}, [], ['', '  ']]) {
      const error = (() => {
        try {
          parseCategorizeInput({ names })
          return null
        } catch (e) {
          return e
        }
      })()
      expect(isPrismError(error)).toBe(true)
      expect((error as PrismError).code).toBe('bad_request')
    }
  })

  it('category 非字符串（且非 null/undefined）→ bad_request（不静默当清除）', () => {
    for (const category of [42, true, {}, ['X']]) {
      const error = (() => {
        try {
          parseCategorizeInput({ names: ['a'], category })
          return null
        } catch (e) {
          return e
        }
      })()
      expect(isPrismError(error)).toBe(true)
      expect((error as PrismError).code).toBe('bad_request')
    }
  })
})
