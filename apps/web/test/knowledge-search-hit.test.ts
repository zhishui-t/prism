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

import type { SearchResult } from '../src/api.ts'
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

function render(entry: SearchResult, props: { active?: boolean; onOpen?: () => void } = {}): void {
  act(() => {
    root.render(
      createElement(SearchHitRow, {
        entry,
        href: '#/knowledge?id=project%2Fprism%2Fperf%2Fe2e-guard',
        active: props.active ?? false,
        onOpen: props.onOpen ?? (() => {}),
        layerText: '项目',
        moduleText: 'performance',
      }),
    )
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
