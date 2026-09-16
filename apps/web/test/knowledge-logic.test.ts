import { describe, expect, it } from 'vitest'

import { isSelMiss, selMissDetail, resolveBookDeepLink } from '../src/pages/knowledge-logic.ts'

describe('isSelMiss · 深链未命中判据（M4）', () => {
  it('未选中（sel 空）→ false：走「从左侧选择条目」空态', () => {
    expect(isSelMiss('', false, undefined)).toBe(false)
    expect(isSelMiss('', false, null)).toBe(false)
  })

  it('选中但请求在途 → false：此时 data 还是上一轮的值，不能判未命中', () => {
    expect(isSelMiss('kb-1', true, undefined)).toBe(false)
    expect(isSelMiss('kb-1', true, null)).toBe(false)
    expect(isSelMiss('kb-1', true, { id: 'kb-1' })).toBe(false)
  })

  it('选中 + 已完结 + data null（kbGet 返回 null）→ true', () => {
    expect(isSelMiss('kb-1', false, null)).toBe(true)
  })

  it('选中 + 已完结 + data undefined（useAsync 出错不 setData）→ true', () => {
    // 旧判据 `data === null` 在此恒为 false —— 这就是冷启动未命中深链停在空态、
    // 到不了 notFound pane 的根因；本用例即该回归的红线。
    expect(isSelMiss('kb-1', false, undefined)).toBe(true)
  })

  it('选中 + 已完结 + 有内容 → false', () => {
    expect(isSelMiss('kb-1', false, { id: 'kb-1' })).toBe(false)
    // 边界：空字符串正文也是「取到了」，不算未命中
    expect(isSelMiss('kb-1', false, '')).toBe(false)
  })
})

describe('selMissDetail · notFound pane 的错误原文捎带（复检 MINOR-②）', () => {
  it('无错误（真 not_found 信封路径，error 未置）→ undefined：pane 标题即答案，不加噪音', () => {
    expect(selMissDetail(undefined)).toBeUndefined()
  })

  it('not_found 前缀（api.request 的信封错误原文）→ undefined：属于 pane 语义内的「不存在」', () => {
    expect(selMissDetail('not_found: 知识条目不存在: kb-1')).toBeUndefined()
    // 前缀必须带冒号才认——防「not_found_xxx」这类恰好同头的码误吞
    expect(selMissDetail('not_foundx: 其他')).not.toBeUndefined()
  })

  it('基建错误（500 / 网络断）→ 原文返回：不许被「不存在」标题吞掉', () => {
    expect(selMissDetail('internal: 数据库忙')).toBe('internal: 数据库忙')
    expect(selMissDetail('Failed to fetch')).toBe('Failed to fetch')
  })

  it('空串错误文本 → 原样返回空串（不隐藏，交给渲染层自行取舍）', () => {
    // `''` 不以 `not_found:` 开头，走「展示原文」分支——契约上与实现一致即可
    expect(selMissDetail('')).toBe('')
  })
})

describe('resolveBookDeepLink · ?book= 深链收敛（D-3 / T6）', () => {
  /** 与 `Knowledge.tsx` 的 `books` memo 同序：按 `book › owner` 排。 */
  const books = [
    { layer: 'global', book: 'handbook' },
    { layer: 'project', owner: 'mini-snake', book: 'prism' },
    { layer: 'project', owner: 'prism', book: 'prism' },
    { layer: 'role', owner: 'dev-1', book: 'prism' },
  ]

  it('命中：layer + owner + book 全给（T6 边表的标准形态）→ 该书本身', () => {
    const hit = resolveBookDeepLink(books, { layer: 'role', owner: 'dev-1', book: 'prism' })
    expect(hit).toBe(books[3])
  })

  it('命中：只给 book（TC-KB-12 的 `#/knowledge?book=<书>`）→ 首个匹配', () => {
    expect(resolveBookDeepLink(books, { book: 'handbook' })).toBe(books[0])
  })

  it('多 owner 同名书 + 未带 owner → 取目录首个（不是「全都算命中」）', () => {
    expect(resolveBookDeepLink(books, { book: 'prism' })).toBe(books[1])
  })

  it('给了 owner → 精确定位到那本同名书', () => {
    expect(resolveBookDeepLink(books, { owner: 'prism', book: 'prism' })).toBe(books[2])
  })

  it('不存在 / 层不符 / owner 不符 → undefined（静默忽略参数，与非法 layer 同口径）', () => {
    expect(resolveBookDeepLink(books, { book: 'nope' })).toBeUndefined()
    expect(resolveBookDeepLink(books, { layer: 'global', book: 'prism' })).toBeUndefined()
    expect(resolveBookDeepLink(books, { owner: 'tester', book: 'prism' })).toBeUndefined()
  })

  it('无 book 参数 / 空串 → undefined（普通目录不受影响）', () => {
    expect(resolveBookDeepLink(books, {})).toBeUndefined()
    expect(resolveBookDeepLink(books, { book: '' })).toBeUndefined()
    expect(resolveBookDeepLink(books, { layer: 'project', owner: 'prism', book: '' })).toBeUndefined()
  })

  it('非法 layer 值不参与匹配（与 Knowledge 的 layer 状态回落 `all` 同口径）', () => {
    expect(resolveBookDeepLink(books, { layer: 'bogus', book: 'handbook' })).toBe(books[0])
  })
})
