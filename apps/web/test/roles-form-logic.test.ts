/**
 * 角色表单的**纯逻辑**回归锁。
 *
 * 两条主线：
 *
 * 1. **B1（PATCH 缺省 = 不改）**：服务端 `strictKnowledge` 在 edit 下「显式给出 knowledge
 *    对象即全量写入、缺省字段补 `[]`」——故「载入已有角色 → 表单 → payload」这条链上
 *    任何一环丢掉 books，都会让用户改一次描述就静默清空知识绑定（R7 红线）。
 *    F1 起 books **在表单里也有编辑位**，往返链多了一环（`seedRoleFormValues`），
 *    故本文件同时钉住**播种**与**构造**两端：`build(seed(role))` 深等价。
 *
 * 2. **F1 列表操作**：chips 的单个移除 / 弹层的勾选与手动添加共用同一组纯函数
 *    （去重、去空白、幂等），不重渲染的「同一个引用」也是契约的一部分。
 */

import { describe, expect, it } from 'vitest'

import type { RoleDefinition } from '../src/api-team.ts'
import {
  appendToList,
  buildRoleInput,
  removeFromList,
  seedRoleFormValues,
  splitList,
  toggleInList,
  type RoleFormValues,
} from '../src/pages/roles-form-logic.ts'

/** 既有角色（编辑基线）：`knowledge` 是服务端读回值，`books` 有可能非空。 */
function role(books?: string[]): RoleDefinition {
  return {
    name: 'dev-1',
    description: '一句话职责',
    color: 'blue',
    model: 'sonnet',
    thoughtLevel: 'high',
    skills: ['a', 'b'],
    knowledge: books === undefined ? { layers: ['global'] } : { layers: ['global'], books },
    principle: '',
    body: '# 正文',
  }
}

/** 表单值（new / edit 共用超集）——F1 起 skills / books 是**数组**。 */
function values(over: Partial<RoleFormValues> = {}): RoleFormValues {
  return {
    name: 'dev-1',
    description: '一句话职责',
    color: '',
    model: '',
    thought: '',
    skills: ['a', 'b'],
    layers: 'global, role',
    books: [],
    body: '# 正文',
    dir: '/tmp/prism-roles',
    ...over,
  }
}

const hasBooks = (input: { knowledge?: { books?: string[] } }): boolean =>
  Object.prototype.hasOwnProperty.call(input.knowledge, 'books')

describe('seedRoleFormValues（F1：播种是往返链的一环）', () => {
  it('编辑：skills / books / layers 从读回值播种（数组按值拷贝，不与定义共享引用）', () => {
    const def = role(['a.md', 'b.md'])
    const v = seedRoleFormValues('/tmp/prism-roles', def)
    expect(v.skills).toEqual(['a', 'b'])
    expect(v.books).toEqual(['a.md', 'b.md'])
    expect(v.layers).toBe('global')
    expect(v.dir).toBe('/tmp/prism-roles')
    // 拷贝：改表单不该改到那一份读回的定义（下一轮渲染的 initial 仍是它）
    v.books.push('c.md')
    v.skills.push('c')
    expect(def.knowledge.books).toEqual(['a.md', 'b.md'])
    expect(def.skills).toEqual(['a', 'b'])
  })

  it('无 books / 无 skills 时播种为空数组（表单里表现为「还没有选」而不是 undefined）', () => {
    const v = seedRoleFormValues('/tmp/prism-roles', role())
    expect(v.skills).toEqual(['a', 'b'])
    expect(v.books).toEqual([])
  })

  it('新建（initial = null）：空白名单 + layers 走缺省 `global`', () => {
    const v = seedRoleFormValues('/tmp/prism-roles', null)
    expect(v).toMatchObject({ name: '', skills: [], books: [], layers: 'global', dir: '/tmp/prism-roles' })
  })
})

describe('buildRoleInput（B1：PATCH 缺省 = 不改；F1：表单值即白名单真相）', () => {
  it('**往返链**：载入已有角色 → 播种 → 构造，books / skills 一个不丢（B1 红线）', () => {
    const input = buildRoleInput('edit', seedRoleFormValues('/tmp/prism-roles', role(['a.md', 'b.md'])))
    expect(input.knowledge?.books).toEqual(['a.md', 'b.md'])
    expect(input.skills).toEqual(['a', 'b'])
    expect(input.knowledge?.layers).toEqual(['global'])
  })

  it('books 为空 ⇒ payload 不含该键（服务端缺省补 `[]` = 用户在选取器里移光了 = 清空绑定）', () => {
    expect(hasBooks(buildRoleInput('edit', values({ books: [] })))).toBe(false)
  })

  it('books 非空 ⇒ 原样发出（保持选取顺序，不重排）', () => {
    const input = buildRoleInput('edit', values({ books: ['zeta', 'alpha'] }))
    expect(input.knowledge?.books).toEqual(['zeta', 'alpha'])
  })

  it('skills 直接取表单数组（含顺序）；空数组合法（= 清空白名单）', () => {
    expect(buildRoleInput('edit', values({ skills: ['z', 'a'] })).skills).toEqual(['z', 'a'])
    expect(buildRoleInput('edit', values({ skills: [] })).skills).toEqual([])
  })

  it('layers 为空串 / 空白 → layers 为 []（清空语义不被顺手回归掉）', () => {
    expect(buildRoleInput('edit', values({ layers: '' })).knowledge?.layers).toEqual([])
    expect(buildRoleInput('edit', values({ layers: '  , , ' })).knowledge?.layers).toEqual([])
  })

  it('置空语义不变：new 省略，edit 显式 null（color / model / thought）', () => {
    const created = buildRoleInput('new', values())
    expect(created).not.toHaveProperty('color')
    expect(created).not.toHaveProperty('model')
    expect(created).not.toHaveProperty('thought_level')
    expect(created.name).toBe('dev-1')

    const patched = buildRoleInput('edit', values())
    expect(patched.color).toBeNull()
    expect(patched.model).toBeNull()
    expect(patched.thought_level).toBeNull()
    // edit 不改 name（身份不可改）
    expect(patched).not.toHaveProperty('name')
  })
})

describe('F1 列表操作（chips 移除 / 勾选 / 手动添加共用）', () => {
  it('appendToList：去空白、忽略空串、已有同名幂等', () => {
    expect(appendToList(['a'], ' b ')).toEqual(['a', 'b'])
    expect(appendToList(['a'], '   ')).toEqual(['a'])
    const list = ['a']
    // 幂等 = 返回**同一个引用**（setState 收到同一引用不会重渲染 = 什么也没发生）
    expect(appendToList(list, 'a')).toBe(list)
  })

  it('removeFromList：移除一项，不在列内时返回同一引用', () => {
    expect(removeFromList(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    const list = ['a']
    expect(removeFromList(list, 'zzz')).toBe(list)
  })

  it('toggleInList：两个方向都走它（勾选进、再勾选出）', () => {
    expect(toggleInList(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleInList(['a', 'b'], 'a')).toEqual(['b'])
    // 手动添加未装技能后再取消勾选 → 干净移除（不留下空位）
    expect(toggleInList(['ghost'], 'ghost')).toEqual([])
  })

  it('三个操作都不就地改入参（调用方的数组仍归调用方）', () => {
    const list = ['a']
    appendToList(list, 'b')
    removeFromList(list, 'a')
    toggleInList(list, 'c')
    expect(list).toEqual(['a'])
  })
})

describe('splitList', () => {
  it('逗号分隔 + 去空白 + 滤空串（layers 仍在用）', () => {
    expect(splitList(' a , b ,, c ')).toEqual(['a', 'b', 'c'])
  })
})
