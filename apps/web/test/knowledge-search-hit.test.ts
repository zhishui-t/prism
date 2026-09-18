// @vitest-environment happy-dom
/**
 * 检索结果行（design-brief-v7-a K7）结构回归 —— **D-1（major）**。
 *
 * 缺陷：`#/knowledge` 检索结果行的 `.toc-hit-main` 是 `flex-direction: row`，标题
 * `.toc-title` 与来源 `.toc-source` 是**同一 flex row 的平级项**，标题被收缩压成
 * `width: 0`（文本正确但视觉不可见，行内留 ~97px 空腔）。
 *
 * 这里锁的是**结构**，不是像素：happy-dom 没有布局引擎，计算宽度一律是 0/空，断言
 * 「宽度 > 0」毫无意义。真正可锁且够用的是两条结构事实：
 *   1. 标题所在容器（行根的第一个块级子容器 `.toc-hit-main`）里**只有标题**——
 *      没有任何能与它争宽度的兄弟节点（旧结构里 `.toc-source` 正是那个兄弟）；
 *   2. 该容器在 `styles.css` 里**不是 flex row**（`display: block`）。
 * 把修复回退成旧结构（title 与 source 在 `.toc-hit-main` 内平级、该容器 `display: flex`），
 * 上面的断言立即变红。
 *
 * 渲染路径与 `teams-page-drawer.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`，不引 @testing-library。根 vitest.config.ts 的 include 只收 `.test.ts`，
 * 故本文件不用 JSX，走 `createElement`。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchHitSegment, SearchResult } from '../src/api.ts'
import { setLang } from '../src/i18n.ts'
import { SearchHitRow } from '../src/pages/SearchHitRow.tsx'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: 'project/prism/perf/e2e-guard',
    version: 1,
    title: 'E2E 性能守则',
    type: 'rule',
    layer: 'project',
    owner: 'prism',
    book: 'project/prism/raw/e2e.md',
    module: 'performance',
    excerpt: '异步等待用 waitFor 轮询，不要裸 sleep。',
    score: 0.87,
    source: 'fts',
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  setLang('zh')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(
  entry: SearchResult,
  props: {
    active?: boolean
    onOpen?: () => void
    query?: string
    onLocateSegment?: (seg: SearchHitSegment) => void
  } = {},
): void {
  act(() => {
    root.render(
      createElement(SearchHitRow, {
        entry,
        href: '#/knowledge?id=project%2Fprism%2Fperf%2Fe2e-guard',
        active: props.active ?? false,
        onOpen: props.onOpen ?? (() => {}),
        layerText: '项目',
        moduleText: 'performance',
        query: props.query ?? '',
        onLocateSegment: props.onLocateSegment,
      }),
    )
  })
}

function click(node: Element): void {
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function el<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector)
  if (found === null) throw new Error(`未找到 ${selector}`)
  return found
}

/**
 * 取 styles.css 里某个选择器的声明块（这些选择器各只出现一次）。
 * 路径经 `fileURLToPath(字符串)` 解析：happy-dom 会替换全局 `URL`，把它造出来的 URL
 * 对象交给 `readFileSync` 会报「The URL must be of scheme file」。
 */
function cssRule(selector: string): string {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const found = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (found === null) throw new Error(`styles.css 里没有 ${selector} 规则`)
  return found[1]
}

describe('SearchHitRow（D-1：标题不可被压成 0）', () => {
  it('标题独占行根的第一个块级子容器，且容器内没有能挤压它的兄弟节点', () => {
    render(hit())

    const row = el<HTMLAnchorElement>('a.toc-hit')
    const titleBox = row.firstElementChild
    expect(titleBox?.className).toBe('toc-hit-main')
    // 标题容器是块级元素（div），不是被塞进 flex row 的 span
    expect(titleBox?.tagName).toBe('DIV')

    const title = el<HTMLElement>('.toc-title')
    expect(title.textContent).toBe('E2E 性能守则')
    // 旧结构红点：标题容器里曾同时挂 `.toc-title` 与 `.toc-source`
    expect(title.parentElement).toBe(titleBox)
    expect(titleBox?.children.length).toBe(1)
    expect([...(titleBox?.children ?? [])]).toEqual([title])
  })

  it('命中来源落在副行右端，与标题不在同一个 flex row 里', () => {
    render(hit())

    const source = el<HTMLElement>('.toc-source')
    expect(source.textContent).toBe('fts')
    expect(source.parentElement?.className).toBe('toc-hit-sub')
    expect(source.closest('.toc-hit-main')).toBeNull()

    const sub = el<HTMLElement>('.toc-hit-sub')
    expect(sub.textContent).toBe('项目›prism›project/prism/raw/e2e.md›performancefts')
  })

  it('副行保留「层 › 归属 › 书 › 模块」四段，无归属时省略该段', () => {
    render(hit({ owner: undefined }))
    expect(el<HTMLElement>('.toc-hit-sub').textContent).toBe(
      '项目›project/prism/raw/e2e.md›performancefts',
    )
  })

  it('excerpt 非空才渲染摘要行', () => {
    render(hit())
    expect(el<HTMLElement>('.toc-hit-excerpt').textContent).toBe('异步等待用 waitFor 轮询，不要裸 sleep。')

    render(hit({ excerpt: '' }))
    expect(container.querySelector('.toc-hit-excerpt')).toBeNull()
  })

  it('A2 契约：行是 `<a href>`（可中键 / 可复制），点击回调整体可用', () => {
    const onOpen = vi.fn()
    render(hit(), { onOpen })

    const row = el<HTMLAnchorElement>('a.toc-hit')
    expect(row.getAttribute('href')).toBe('#/knowledge?id=project%2Fprism%2Fperf%2Fe2e-guard')
    expect(row.className).toBe('toc-item toc-hit')

    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledTimes(1)

    render(hit({ id: 'x' }), { active: true })
    expect(el<HTMLAnchorElement>('a.toc-hit').className).toBe('toc-item toc-hit active')
  })

  it('样式侧锁：标题容器不是 flex row，来源靠 margin-left:auto 收尾', () => {
    expect(cssRule('.book-toc .toc-hit-main')).toMatch(/display:\s*block/)
    expect(cssRule('.book-toc .toc-hit-main')).not.toMatch(/display:\s*flex/)
    expect(cssRule('.book-toc .toc-hit .toc-title')).toMatch(/display:\s*block/)
    expect(cssRule('.book-toc .toc-source')).toMatch(/margin-left:\s*auto/)
  })
})

/**
 * v13 W-2（SPEC-4.2）：命中段列表。`hits` 是 wire snake_case 的可选字段（服务端 B-4 已落地，
 * 单测仍用夹具 mock 覆盖缺省/有值两态）；缺省时**渲染必须与旧行为逐字一致**（行根仍是 `<a>`，
 * 无任何新 DOM）。W-3 追加：段行可点定位、条目级 `hits_truncated` 不再被消费。
 */
describe('SearchHitRow · W-2 命中段列表', () => {
  const HITS = [
    { seq: 1, heading_path: '性能 › 守则', excerpt: '异步等待用 waitFor 轮询，不要裸 sleep。', score: 0.9 },
    { seq: 2, heading_path: '性能 › 边界', excerpt: '裸 sleep 在负载下会抖动。', score: 0.5 },
  ]

  it('hits 缺省 / 空：结构与旧行为逐字一致（根仍是 `<a>`，无展开件）', () => {
    render(hit())
    const a = el<HTMLAnchorElement>('a.toc-hit')
    expect(container.children).toHaveLength(1)
    expect(container.firstElementChild).toBe(a)
    expect(container.querySelector('.toc-hit-seg-toggle')).toBeNull()
    expect(container.querySelector('.toc-hit-segs')).toBeNull()

    render(hit({ hits: [] }))
    expect(container.querySelector('.toc-hit-seg-toggle')).toBeNull()
    expect(container.querySelector('.toc-hit-segs')).toBeNull()
  })

  it('默认收起；展开按钮在 `<a>` 之外、原生 button（键盘可达）+ aria-expanded', () => {
    render(hit({ hits: HITS }))
    const toggle = el<HTMLButtonElement>('.toc-hit-seg-toggle')
    expect(toggle.tagName).toBe('BUTTON')
    // 视觉复用既有 `.toc-chip`（与「限当前层/限当前书」同一零件语言），不另造一套按钮样式
    expect(toggle.className).toBe('toc-chip toc-hit-seg-toggle')
    expect(toggle.closest('a')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('展开命中段 (2)')
    expect(container.querySelector('.toc-hit-segs')).toBeNull()
  })

  it('展开：逐段渲染 heading_path + excerpt，查询词切 run 包 `<mark>`（大小写不敏感）', () => {
    render(hit({ hits: HITS }), { query: 'WAITFOR' })
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))

    const segs = [...container.querySelectorAll('.toc-hit-seg')]
    expect(segs).toHaveLength(2)
    expect(segs[0].querySelector('.toc-hit-seg-path')?.textContent).toBe('性能 › 守则')
    expect(segs[0].querySelector('.toc-hit-seg-excerpt')?.textContent).toBe('异步等待用 waitFor 轮询，不要裸 sleep。')
    expect(segs[1].querySelector('.toc-hit-seg-excerpt')?.textContent).toBe('裸 sleep 在负载下会抖动。')

    // 高亮是 run 数组 + `<mark>` 节点，不是 innerHTML 拼串
    const marks = [...container.querySelectorAll('.toc-hit-seg-excerpt .toc-hit-mark')]
    expect(marks.map((m) => m.textContent)).toEqual(['waitFor'])
    expect(segs[0].querySelector('.toc-hit-seg-excerpt')?.innerHTML).toContain('<mark')

    const toggle = el<HTMLButtonElement>('.toc-hit-seg-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('收起命中段 (2)')
  })

  it('空 query 不高亮；查询词无命中时 excerpt 保持纯文本', () => {
    render(hit({ hits: HITS }), { query: '' })
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))
    expect(container.querySelector('.toc-hit-mark')).toBeNull()
  })

  it('查询词不在段文本里时不高亮', () => {
    render(hit({ hits: HITS }), { query: 'zzz-not-here' })
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))
    expect(container.querySelector('.toc-hit-mark')).toBeNull()
  })

  /**
   * W-3 炸点 2 回归：`hits_truncated` 是**响应级**（`SearchResponse.hits_truncated`），
   * 条目级同名字段已从契约删除。旧实现读 `entry.hits_truncated` → 该提示**永不出现**；
   * 修复后即便夹具硬塞这个已删字段，组件也必须不渲染列表尾提示（提示改由结果区顶部承担）。
   */
  it('条目级 hits_truncated 不再被消费（列表尾恒无提示行）', () => {
    render(hit({ hits: HITS, ...({ hits_truncated: true } as Record<string, unknown>) } as Partial<SearchResult>))
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))
    expect(container.querySelector('.toc-hit-seg-more')).toBeNull()
    expect(container.querySelectorAll('.toc-hit-seg')).toHaveLength(2)
  })

  it('不给 onLocateSegment：段行是纯 `<li>` 内容，无按钮（不假装可点）', () => {
    render(hit({ hits: HITS }))
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))
    expect(container.querySelector('.toc-hit-seg-go')).toBeNull()
  })

  /**
   * W-3（SPEC-4.3）：命中段点击定位。每段包一层原生 `<button>`（键盘可达），点击回调
   * 收到该段（`seq` 供页面反查 chunk 区间）。
   */
  it('给 onLocateSegment：每段是原生 button，点击回调收到对应段', () => {
    const onLocate = vi.fn()
    render(hit({ hits: HITS }), { onLocateSegment: onLocate })
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))

    const gos = [...container.querySelectorAll<HTMLButtonElement>('.toc-hit-seg-go')]
    expect(gos).toHaveLength(2)
    expect(gos[0].tagName).toBe('BUTTON')
    expect(gos[0].closest('a')).toBeNull()
    // `<button>` 内容模型只允许 phrasing content：段内两个子块必须是 `<span>`（不能是 `<div>`）。
    expect(gos[0].querySelectorAll('div')).toHaveLength(0)
    expect(gos[0].querySelectorAll('span')).toHaveLength(2)

    click(gos[1])
    expect(onLocate).toHaveBeenCalledTimes(1)
    expect(onLocate).toHaveBeenCalledWith(HITS[1])

    click(gos[0])
    expect(onLocate).toHaveBeenCalledTimes(2)
    expect(onLocate).toHaveBeenCalledWith(HITS[0])
  })

  it('再点一次收起段列表（展开/收起往返）', () => {
    render(hit({ hits: HITS }))
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))
    expect(container.querySelector('.toc-hit-segs')).not.toBeNull()
    click(el<HTMLButtonElement>('.toc-hit-seg-toggle'))
    expect(container.querySelector('.toc-hit-segs')).toBeNull()
  })
})
