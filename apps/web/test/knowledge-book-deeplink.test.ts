// @vitest-environment happy-dom
/**
 * Knowledge 目录的 **book 深链收敛**回归（**D-3**）。
 *
 * 缺陷：`#/knowledge?layer=project&book=prism` 里 `?book=` 被忽略——目录只按 layer
 * 过滤，两本书照列（黑盒证据断言输出 `names=mini-snake,prism`）。T6 边表要求
 * `Ref kind=book` 的落点**收敛到该书**。
 *
 * 判据本身由 `knowledge-logic.ts#resolveBookDeepLink` 的 node 单测覆盖；**本文件锁的是
 * 接线**（收敛是否真接进 `scopedBooks`、命中那本是否被展开），这正是缺陷所在层——
 * 纯函数测试对该缺陷是全绿的。
 *
 * 渲染路径与 `knowledge-search-hit.test.ts` / `teams-page-drawer.test.ts` 一致：
 * happy-dom + 裸 `react-dom/client` + `react.act`（根 vitest.config.ts 的 include
 * 只收 `.test.ts`，故不用 JSX，走 `createElement`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BookNode } from '../src/api.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 受控假数据：两本同层书（`mini-snake` / `prism`）——`?book=prism` 的收敛态 = 只剩 `prism`。
 * 深链只吃 `kbTree`（骨架）+ `kbStats` + `kbConflicts` + 命中那本的 `kbCatalog`（懒加载）。
 */
const data = vi.hoisted(() => ({ tree: [] as unknown[] }))

vi.mock('../src/api.ts', () => ({
  api: {
    kbTree: () => Promise.resolve(data.tree),
    kbStats: () => Promise.resolve({ layers: {}, books: 2, entries: 2 }),
    kbConflicts: () => Promise.resolve([]),
    kbCatalog: () => Promise.resolve([]),
    kbSearch: () => Promise.resolve({ results: [] }),
    kbGet: () => Promise.resolve(null),
    kbVersions: () => Promise.resolve([]),
    kbBookStructure: () => Promise.resolve(null),
    // v9 F2：页面挂载即拉一次全量架构图；空清单 = 图集组不出现，既有断言不受影响。
    archDiagrams: () => Promise.resolve([]),
  },
}))

import { setLang } from '../src/i18n.ts'
import { KnowledgePage } from '../src/pages/Knowledge.tsx'

function book(owner: string, name: string): BookNode {
  return { layer: 'project', owner, book: name, modules: [{ name: 'm', count: 1 }], total: 1 }
}

let container: HTMLDivElement
let root: Root

async function render(query: Record<string, string>): Promise<void> {
  await act(async () => {
    root.render(createElement(KnowledgePage, { query }))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

/** 目录里列出的书名（收敛与否的唯一可读证据）。 */
function bookNames(): string[] {
  return all('.toc-bookname').map((n) => n.textContent ?? '')
}

function expandedOf(name: string): string | undefined {
  const section = all('.toc-section').find((s) => s.querySelector('.toc-bookname')?.textContent === name)
  return section?.querySelector('.toc-book')?.getAttribute('aria-expanded') ?? undefined
}

beforeEach(() => {
  setLang('zh')
  data.tree = [book('mini-snake', 'mini-snake'), book('prism', 'prism')]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('KnowledgePage 目录 · book 深链收敛（D-3）', () => {
  it('`?layer=project&book=prism` → 目录只剩 prism，且该书已展开（旧代码：两本照列）', async () => {
    await render({ layer: 'project', book: 'prism' })

    expect(bookNames()).toEqual(['prism'])
    expect(expandedOf('prism')).toBe('true')
  })

  it('book 指向不存在的书 → 静默忽略参数：目录回落该层全部（与非法 layer 同口径，不报错）', async () => {
    await render({ layer: 'project', book: 'nope' })

    expect(bookNames()).toEqual(['mini-snake', 'prism'])
    expect(container.querySelector('.error')).toBeNull()
  })

  it('无 book 参数 → 普通目录（收敛层不存在，行为不回归）', async () => {
    await render({ layer: 'project' })

    expect(bookNames()).toEqual(['mini-snake', 'prism'])
  })

  it('书链带 owner 时只收敛到那一本同名书（同层多 owner 同名书不误伤）', async () => {
    data.tree = [book('mini-snake', 'same'), book('prism', 'same')]
    await render({ layer: 'project', owner: 'prism', book: 'same' })

    expect(bookNames()).toEqual(['same'])
  })
})
