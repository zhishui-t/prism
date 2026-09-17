/**
 * 技能分类存储（v12 F4「存储扩展」/ SPEC-4.3；原 design-v8 §3 F7）：`<PRISM_HOME>/skill-categories.json`。
 *
 * v12 形态迁移：磁盘从**旧裸映射** `{ "<技能名>": "<分类>" }` 迁到**双节新形态**
 * `{ categories: string[], mapping: { "<技能名>": "<分类>" } }`：
 * - 判别式：解析结果是普通对象 **且** `categories` 是数组 **且** `mapping` 是普通对象 → 新形态；
 *   否则按旧裸映射读（半写新形态由此自然降级）；`categories: []` 仍算新形态，**绝不回落裸读**；
 * - 旧形态读时升级（categories = mapping 值去重、按首次出现序），**写时不回退**；
 * - mapping 值 ∉ categories（游离分类）→ 读时按未分类呈现，下次写时修复（不悄悄加回 categories）。
 *
 * 范式对照 `packages/server/src/graph/registry.ts`（ProjectRegistry）——
 * tmp + rename 原子替换、每次访问重读磁盘、跨进程后写胜出、坏文件按**空新形态**降级。
 * 本文件只测**存储自身**：三入口（HTTP/MCP/CLI）的一致性由各自 surface 测试对账。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PrismError } from '@prism/core'

import { parseCategorizeInput, SkillCategoryStore } from '../src/roles/skill-categories.js'

const EMPTY = { categories: [], mapping: {} }

function isPrismError(error: unknown): error is PrismError {
  return error instanceof PrismError
}

describe('SkillCategoryStore（v12 F4 双节存储）', () => {
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

  const file = (): string => join(home, 'skill-categories.json')
  const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file(), 'utf-8')) as unknown
  const writeRaw = async (raw: string): Promise<void> => await writeFile(file(), raw, 'utf-8')

  it('落点 = <home>/skill-categories.json；文件不存在 → 空新形态（不抛）', async () => {
    expect(store.file.replaceAll('\\', '/')).toBe(join(home, 'skill-categories.json').replaceAll('\\', '/'))
    expect(await store.all()).toEqual(EMPTY)
  })

  it('写 → 重读一致（新实例从磁盘读到，无进程内缓存）；磁盘落双节新形态', async () => {
    const result = await store.categorize(['code-review', 'prism'], '质量')
    expect(result.category).toBe('质量')
    expect(result.updated).toEqual(['code-review', 'prism'])
    expect(result.cleared).toEqual([])
    expect(result.categories).toEqual(['质量'])
    expect(result.mapping).toEqual({ 'code-review': '质量', prism: '质量' })

    // 另一个实例（模拟另一个进程）读同一文件 → 立即可见
    expect(await new SkillCategoryStore(home).all()).toEqual({
      categories: ['质量'],
      mapping: { 'code-review': '质量', prism: '质量' },
    })

    // 磁盘落的是 `{ categories: string[], mapping: { <技能名>: <分类> } }` 形
    expect(await onDisk()).toEqual({
      categories: ['质量'],
      mapping: { 'code-review': '质量', prism: '质量' },
    })
  })

  it('原子替换：写完不留 tmp 残留（目录里只有映射文件）', async () => {
    await store.categorize(['a'], 'X')
    await store.categorize(['a'], undefined)
    await store.categorize(['b', 'c'], 'Y')
    const entries = (await readdir(home)).sort()
    expect(entries).toEqual(['skill-categories.json'])
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
  })

  it('b-6：多实例并发写同 home —— tmp 名带随机后缀不互撞，落点无 .tmp 残渣且为合法 JSON', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'skillcat-conc-'))
    cleanup.push(shared)
    const stores = [0, 1, 2, 3].map(() => new SkillCategoryStore(shared))
    await Promise.all(stores.map((s, index) => s.categorize([`s${index}`], `C${index}`)))
    const entries = (await readdir(shared)).sort()
    expect(entries).toEqual(['skill-categories.json'])
    const data = await new SkillCategoryStore(shared).all()
    expect(data.categories.length).toBeGreaterThan(0)
    expect(Object.keys(data.mapping).length).toBeGreaterThan(0)
  })

  it('n-2：技能名字面 `__proto__` 可表达 —— categorize → 落盘 → 重读仍在（null 原型）', async () => {
    const result = await store.categorize(['__proto__'], 'X')
    // 赋值落到**自有属性**（不是被原型 setter 静默吞掉）
    expect(Object.prototype.hasOwnProperty.call(result.mapping, '__proto__')).toBe(true)
    expect(result.mapping['__proto__']).toBe('X')
    expect(result.updated).toEqual(['__proto__'])

    // 落盘后 JSON 里有该键；重读（新实例，走 #read 的新形态分支）仍在
    const disk = (await onDisk()) as { mapping: Record<string, string> }
    expect(Object.prototype.hasOwnProperty.call(disk.mapping, '__proto__')).toBe(true)
    const reread = await new SkillCategoryStore(home).all()
    expect(Object.prototype.hasOwnProperty.call(reread.mapping, '__proto__')).toBe(true)
    expect(reread.mapping['__proto__']).toBe('X')

    // 清除同样可表达（delete 命中的是自有属性）
    const cleared = await store.categorize(['__proto__'])
    expect(cleared.cleared).toEqual(['__proto__'])
    expect(Object.prototype.hasOwnProperty.call(cleared.mapping, '__proto__')).toBe(false)
  })

  it('只动点名的键：其它条目原样保留（部分更新不整表重写）；新分类自动登记追加末尾', async () => {
    await store.categorize(['a'], 'A')
    await store.categorize(['b'], 'B')
    await store.categorize(['a'], 'A2')
    expect(await store.all()).toEqual({
      categories: ['A', 'B', 'A2'],
      mapping: { a: 'A2', b: 'B' },
    })

    await store.categorize(['b'])
    expect(await store.all()).toEqual({ categories: ['A', 'B', 'A2'], mapping: { a: 'A2' } })
  })

  it('清除语义：省略 category / 空串 / 纯空白 均同义 = 清除（**不从 categories 删分类**）', async () => {
    for (const clear of [undefined, '', '   ']) {
      await store.categorize(['x'], 'X')
      expect(await store.all()).toEqual({ categories: ['X'], mapping: { x: 'X' } })
      const result = await store.categorize(['x'], clear)
      expect(result.category).toBeNull()
      expect(result.cleared).toEqual(['x'])
      expect(result.updated).toEqual([])
      // 组内技能回未分类，但「X」这个分类本身仍在（空分类要存得住——SPEC-4.4）
      expect(await store.all()).toEqual({ categories: ['X'], mapping: {} })
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
    expect(await store.all()).toEqual(EMPTY)
    // 从未写过 → 文件不存在（空表也不伪造文件）
    await expect(readFile(file(), 'utf-8')).rejects.toThrow()
  })

  it('重复名去重；名称/分类 trim 后落盘', async () => {
    const result = await store.categorize([' a ', 'a', 'b'], '  X  ')
    expect(result.updated).toEqual(['a', 'b'])
    expect(await store.all()).toEqual({ categories: ['X'], mapping: { a: 'X', b: 'X' } })
  })

  it('坏文件降级空新形态：非法 JSON / 数组 / null / 非字符串值都不抛', async () => {
    await writeRaw('{ not json')
    expect(await store.all()).toEqual(EMPTY)

    await writeRaw('[1,2,3]')
    expect(await store.all()).toEqual(EMPTY)

    await writeRaw('null')
    expect(await store.all()).toEqual(EMPTY)

    // 旧形态：结构合法但值非字符串/空串 → 视为无分类（只留真分类）
    await writeRaw('{"a":"A","b":123,"c":"","d":null,"e":{"nested":1}}')
    expect(await store.all()).toEqual({ categories: ['A'], mapping: { a: 'A' } })

    // 新形态：值非字符串/空串同样只留真分类
    await writeRaw('{"categories":["A"],"mapping":{"a":"A","b":123,"c":"","d":null}}')
    expect(await store.all()).toEqual({ categories: ['A'], mapping: { a: 'A' } })

    // 坏文件之后仍能正常写入（重建为合法新形态）
    await writeRaw('{ broken')
    await store.categorize(['fresh'], 'F')
    expect(await store.all()).toEqual({ categories: ['F'], mapping: { fresh: 'F' } })
  })

  it('跨进程后写胜出：外部直接改文件，读写两侧都看最新（无缓存闩）', async () => {
    await store.categorize(['a'], 'A')
    // 外部写成**旧裸映射**（旧版 Prism / 手改）→ 读时自动升级
    await writeRaw(JSON.stringify({ a: 'A-external', z: 'Z' }))
    expect(await store.all()).toEqual({ categories: ['A-external', 'Z'], mapping: { a: 'A-external', z: 'Z' } })
    // 写入基于**重读后的**最新内容合并（不会用陈旧快照盖掉外部条目）→ 且落回新形态
    // （`A-local` 未登记 → 自动登记，追加在末尾）
    await store.categorize(['a'], 'A-local')
    expect(await store.all()).toEqual({
      categories: ['A-external', 'Z', 'A-local'],
      mapping: { a: 'A-local', z: 'Z' },
    })
  })
})

describe('磁盘形态迁移（判别式 / 半写新形态 / 游离分类）', () => {
  let home: string
  let store: SkillCategoryStore
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-skillcat-mig-'))
    cleanup.push(home)
    store = new SkillCategoryStore(home)
  })

  afterEach(async () => {
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    cleanup.length = 0
  })

  const file = (): string => join(home, 'skill-categories.json')
  const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file(), 'utf-8')) as unknown
  const writeRaw = async (raw: string): Promise<void> => await writeFile(file(), raw, 'utf-8')

  it('旧裸映射读 → 自动升级：categories = mapping 值去重（按首次出现序），语义等价', async () => {
    await writeRaw('{"a":"B","b":"A","c":"B"}')
    expect(await store.all()).toEqual({ categories: ['B', 'A'], mapping: { a: 'B', b: 'A', c: 'B' } })
  })

  it('读出口径 = 写盘口径：分类名/值一律 trim（手改文件的空白不造成往返变样）', async () => {
    await writeRaw('{"a":"  X  "}')
    expect(await store.all()).toEqual({ categories: ['X'], mapping: { a: 'X' } })
    // 再写一次：磁盘上的值就是规范形（不会留 `  X  `）
    await store.categorize(['b'], 'X')
    expect(await onDisk()).toEqual({ categories: ['X'], mapping: { a: 'X', b: 'X' } })
  })

  it('写时不回退：旧形态读进来、写盘即新形态', async () => {
    await writeRaw('{"a":"A"}')
    await store.categorize(['b'], 'B')
    expect(await onDisk()).toEqual({ categories: ['A', 'B'], mapping: { a: 'A', b: 'B' } })
  })

  it('categories: [] 且 mapping 空 → 仍按新形态识别（不回落裸读）', async () => {
    await writeRaw('{"categories":[],"mapping":{}}')
    expect(await store.all()).toEqual(EMPTY)

    // 回落裸读的表现：会把 `categories`（数组）当技能名处理 → 这里必须是空新形态
    await store.categorize(['a'], 'A')
    expect(await onDisk()).toEqual({ categories: ['A'], mapping: { a: 'A' } })
  })

  it('categories: [] 且 mapping 含游离分类 → 仍新形态；游离按未分类呈现，不回加 categories', async () => {
    await writeRaw('{"categories":[],"mapping":{"a":"X"}}')
    expect(await store.all()).toEqual(EMPTY)

    // 下次写时修复文件：游离条目被剔除，`X` 不进 categories
    await store.categorize(['b'], 'Y')
    expect(await onDisk()).toEqual({ categories: ['Y'], mapping: { b: 'Y' } })
  })

  it('游离分类（值不在 categories）：读时该技能按未分类呈现；下次写时从文件剔除', async () => {
    await writeRaw('{"categories":["A"],"mapping":{"s1":"A","s2":"B"}}')
    expect(await store.all()).toEqual({ categories: ['A'], mapping: { s1: 'A' } })

    await store.categorize(['s3'], 'A')
    const disk = (await onDisk()) as { categories: string[]; mapping: Record<string, string> }
    expect(disk.categories).toEqual(['A'])
    expect(disk.mapping).toEqual({ s1: 'A', s3: 'A' })
    expect('s2' in disk.mapping).toBe(false)
  })

  it('半写新形态（只有 categories 无 mapping）→ 判别式不成立，落旧裸映射路径降级', async () => {
    await writeRaw('{"categories":["A"]}')
    expect(await store.all()).toEqual(EMPTY)
  })

  it('半写新形态（mapping 非普通对象）→ 同样落旧裸映射路径降级', async () => {
    // 数组 / null / 数字：旧路径逐项跳过（值非字符串）→ 空新形态
    for (const bad of ['[]', 'null', '123']) {
      await writeRaw(`{"categories":["A"],"mapping":${bad}}`)
      expect(await store.all(), `mapping=${bad}`).toEqual(EMPTY)
    }
    // 字符串：旧语义下 `mapping` 就是一个**技能名**（值是真分类），照旧读——这正是判别式要的降级
    await writeRaw('{"categories":["A"],"mapping":"A"}')
    expect(await store.all()).toEqual({ categories: ['A'], mapping: { mapping: 'A' } })
  })

  it('旧文件里技能恰好叫 categories/mapping（值是字符串）不会被误判为新形态', async () => {
    await writeRaw('{"categories":"X","mapping":"Y","z":"X"}')
    expect(await store.all()).toEqual({
      categories: ['X', 'Y'],
      mapping: { categories: 'X', mapping: 'Y', z: 'X' },
    })
  })

  it('新形态里技能名恰好叫 categories（值是真分类）也照常读回', async () => {
    await writeRaw('{"categories":["A"],"mapping":{"categories":"A"}}')
    expect(await store.all()).toEqual({ categories: ['A'], mapping: { categories: 'A' } })
  })
})

describe('categories CRUD（B-2 的 HTTP 路由按此接）', () => {
  let home: string
  let store: SkillCategoryStore
  const cleanup: string[] = []

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-skillcat-crud-'))
    cleanup.push(home)
    store = new SkillCategoryStore(home)
  })

  afterEach(async () => {
    for (const dir of cleanup) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    cleanup.length = 0
  })

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    const error = await p.catch((e: unknown) => e)
    expect(isPrismError(error)).toBe(true)
    return (error as PrismError).code
  }

  it('addCategory：trim 后追加到**末尾**（保序）；空分类能存住（不写 mapping）', async () => {
    await store.categorize(['a'], 'A')
    const after = await store.addCategory('  B  ')
    expect(after).toEqual({ categories: ['A', 'B'], mapping: { a: 'A' } })
    expect(await store.all()).toEqual({ categories: ['A', 'B'], mapping: { a: 'A' } })
  })

  it('addCategory：重名 → id_conflict（409）；空 / 纯空白 → bad_request 且不落盘', async () => {
    await store.addCategory('A')
    expect(await codeOf(store.addCategory('A'))).toBe('id_conflict')
    expect(await codeOf(store.addCategory(' A '))).toBe('id_conflict')
    for (const bad of ['', '   ']) {
      expect(await codeOf(store.addCategory(bad))).toBe('bad_request')
    }
    expect(await store.all()).toEqual({ categories: ['A'], mapping: {} })
  })

  it('renameCategory：级联改 mapping 且**保持分类原位置**', async () => {
    await store.addCategory('A')
    await store.addCategory('B')
    await store.categorize(['s1', 's2'], 'B')
    const after = await store.renameCategory('B', ' 质量 ')
    expect(after).toEqual({ categories: ['A', '质量'], mapping: { s1: '质量', s2: '质量' } })
    expect(await store.all()).toEqual({ categories: ['A', '质量'], mapping: { s1: '质量', s2: '质量' } })
  })

  it('renameCategory：目标重名 → id_conflict；源不存在 → not_found；空名 → bad_request', async () => {
    await store.addCategory('A')
    await store.addCategory('B')
    expect(await codeOf(store.renameCategory('A', 'B'))).toBe('id_conflict')
    expect(await codeOf(store.renameCategory('A', ' B '))).toBe('id_conflict')
    expect(await codeOf(store.renameCategory('ghost', 'C'))).toBe('not_found')
    expect(await codeOf(store.renameCategory('A', ''))).toBe('bad_request')
    expect(await store.all()).toEqual({ categories: ['A', 'B'], mapping: {} })
  })

  it('renameCategory：from === to（trim 后）为幂等 no-op，不算重名冲突；源不存在仍 not_found', async () => {
    await store.addCategory('A')
    await store.categorize(['s'], 'A')
    expect(await store.renameCategory('A', ' A ')).toEqual({ categories: ['A'], mapping: { s: 'A' } })
    expect(await codeOf(store.renameCategory('ghost', 'ghost'))).toBe('not_found')
  })

  it('removeCategory：从 categories 移除并清掉指向它的 mapping（组内技能回未分类）', async () => {
    await store.addCategory('A')
    await store.addCategory('B')
    await store.categorize(['s1'], 'A')
    await store.categorize(['s2'], 'B')
    const after = await store.removeCategory('A')
    expect(after).toEqual({ categories: ['B'], mapping: { s2: 'B' } })
    expect(await store.all()).toEqual({ categories: ['B'], mapping: { s2: 'B' } })

    // 只删空分类（无组内技能）同样成立
    expect(await store.removeCategory('B')).toEqual(EMPTY)
  })

  it('removeCategory：不存在 → not_found；空名 → bad_request', async () => {
    await store.addCategory('A')
    expect(await codeOf(store.removeCategory('ghost'))).toBe('not_found')
    expect(await codeOf(store.removeCategory('  '))).toBe('bad_request')
    expect(await store.all()).toEqual({ categories: ['A'], mapping: {} })
  })

  it('categorize 对未登记分类**自动登记**（追加末尾），保持不变式 mapping 值 ⊆ categories', async () => {
    await store.addCategory('A')
    const result = await store.categorize(['s1'], 'X')
    expect(result.categories).toEqual(['A', 'X'])
    // 用库外的另一实例核对磁盘（不变式对任何写路径成立）
    expect(await new SkillCategoryStore(home).all()).toEqual({
      categories: ['A', 'X'],
      mapping: { s1: 'X' },
    })
  })

  it('已登记分类不重复登记；list() 与 all() 同形同值', async () => {
    await store.categorize(['s1'], 'A')
    await store.categorize(['s2'], 'A')
    expect(await store.all()).toEqual({ categories: ['A'], mapping: { s1: 'A', s2: 'A' } })
    expect(await store.list()).toEqual(await store.all())
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

  it('n-1：names 数组含非字符串项 → bad_request（不静默过滤，与 category 侧取齐严格）', () => {
    for (const names of [['a', 42], [null], ['a', {}], ['a', ['b']], [true, 'a']]) {
      const error = (() => {
        try {
          parseCategorizeInput({ names })
          return null
        } catch (e) {
          return e
        }
      })()
      expect(isPrismError(error), `names=${JSON.stringify(names)}`).toBe(true)
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
