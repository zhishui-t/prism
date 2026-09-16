import { describe, expect, it } from 'vitest'

import { hrefOf, parseHash, queryOf, withQuery, type Route } from '../src/route.ts'

describe('parseHash · query 段（v7 契约：先 ? 后 /）', () => {
  it('无 query 时不带 query 字段（既有构造点零改动）', () => {
    expect(parseHash('#/roles/dev-1')).toEqual({ page: 'roles', sel: 'dev-1' })
    expect(parseHash('')).toEqual({ page: 'knowledge' })
    expect(parseHash('#/tasks')).toEqual({ page: 'knowledge' }) // 已删页面走兜底
  })

  it('先切 ? 再切 /：`?q=a/b` 的斜杠不撕碎实体名', () => {
    const route = parseHash('#/knowledge/prism?q=a/b&layer=global')
    expect(route.page).toBe('knowledge')
    expect(route.sel).toBe('prism')
    expect(route.query).toEqual({ q: 'a/b', layer: 'global' })
  })

  it('无实体只到页也能带 query；解码实体与 query 值', () => {
    expect(parseHash('#/teams?sel=core-dev')).toEqual({ page: 'teams', query: { sel: 'core-dev' } })
    expect(parseHash('#/knowledge/%E7%9F%A5%E8%AF%86?q=%E6%A3%80%E7%B4%A2')).toEqual({
      page: 'knowledge',
      sel: '知识',
      query: { q: '检索' },
    })
  })

  it('空串 / 全空键的 query 段 → undefined；值缺省为空串', () => {
    expect(parseHash('#/roles?')).toEqual({ page: 'roles' })
    expect(parseHash('#/roles?=&')).toEqual({ page: 'roles' })
    expect(parseHash('#/roles?q')).toEqual({ page: 'roles', query: { q: '' } })
  })
})

describe('parseHash · 畸形 % 序列不抛（M2：hash 是用户可编辑输入）', () => {
  it('实体段裸 % 原样透传，不抛 URIError（`#/roles/%` 曾整站白屏）', () => {
    expect(() => parseHash('#/roles/%')).not.toThrow()
    expect(parseHash('#/roles/%')).toEqual({ page: 'roles', sel: '%' })
  })

  it('query 值裸 % 原样透传（可分享链接 `?q=100%`），其余键照常解码', () => {
    expect(() => parseHash('#/knowledge?q=100%')).not.toThrow()
    expect(parseHash('#/knowledge?q=100%')).toEqual({ page: 'knowledge', query: { q: '100%' } })
    // 同一串里的合法键不受影响：`q` 保留畸形值，`layer` 正常解码
    expect(parseHash('#/knowledge?q=100%&layer=global')).toEqual({
      page: 'knowledge',
      query: { q: '100%', layer: 'global' },
    })
    // query **键**同样走宽松解码
    expect(parseHash('#/roles?%zz=1')).toEqual({ page: 'roles', query: { '%zz': '1' } })
  })

  it('截断的多字节序列（`%E4`）与非法转义（`%zz`）都不抛', () => {
    expect(parseHash('#/roles/%E4')).toEqual({ page: 'roles', sel: '%E4' })
    expect(parseHash('#/knowledge?q=%zz')).toEqual({ page: 'knowledge', query: { q: '%zz' } })
  })

  it('合法编码仍正常解码（宽松解码只兜底 URIError，不改变正常路径）', () => {
    expect(parseHash('#/knowledge/%E7%9F%A5')).toEqual({ page: 'knowledge', sel: '知' })
    expect(parseHash('#/knowledge?q=%E7%9F%A5')).toEqual({ page: 'knowledge', query: { q: '知' } })
  })
})

describe('queryOf / withQuery', () => {
  it('queryOf 永不 undefined，且返回副本', () => {
    expect(queryOf({ page: 'roles' })).toEqual({})
    const route: Route = { page: 'roles', query: { q: 'a' } }
    const copy = queryOf(route)
    copy.q = 'b'
    expect(route.query).toEqual({ q: 'a' })
  })

  it('withQuery 返回新对象，不改入参', () => {
    const route: Route = { page: 'knowledge', sel: 'prism', query: { q: 'a' } }
    const next = withQuery(route, { layer: 'global' })
    expect(next).toEqual({ page: 'knowledge', sel: 'prism', query: { q: 'a', layer: 'global' } })
    expect(route.query).toEqual({ q: 'a' })
  })

  it('undefined / 空串 = 删键；键删空则回到 `{ page }` 形态', () => {
    const route: Route = { page: 'knowledge', query: { q: 'a', layer: 'global' } }
    expect(withQuery(route, { layer: '' })).toEqual({ page: 'knowledge', query: { q: 'a' } })
    expect(withQuery(route, { q: undefined, layer: undefined })).toEqual({ page: 'knowledge' })
  })

  it('保留 sel', () => {
    expect(withQuery({ page: 'skills', sel: 'prism' }, { q: 'x' })).toEqual({
      page: 'skills',
      sel: 'prism',
      query: { q: 'x' },
    })
  })
})

describe('编码往返（hrefOf ↔ parseHash）', () => {
  it('CJK / 空格 / 斜杠经 hash 往返后原样还原', () => {
    const route: Route = { page: 'knowledge', sel: '知识库', query: { q: '检索 词/a', book: '手册' } }
    const hash = hrefOf(route)
    expect(hash).toBe(
      '#/knowledge/%E7%9F%A5%E8%AF%86%E5%BA%93?q=%E6%A3%80%E7%B4%A2%20%E8%AF%8D%2Fa&book=%E6%89%8B%E5%86%8C',
    )
    expect(parseHash(hash)).toEqual(route)
  })

  it('无 query 时 href 不带 ?；sel 省略时只到页', () => {
    expect(hrefOf({ page: 'teams' })).toBe('#/teams')
    expect(hrefOf({ page: 'teams', sel: 'core-dev' })).toBe('#/teams/core-dev')
  })

  it('空值键不进 hash', () => {
    expect(hrefOf({ page: 'roles', query: { q: '', layer: 'global' } })).toBe('#/roles?layer=global')
  })
})
