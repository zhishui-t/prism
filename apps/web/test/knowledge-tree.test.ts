// @vitest-environment happy-dom
/**
 * F2 书内目录树：**接线**回归（判据本身由 `knowledge-logic.test.ts` 的 node 单测覆盖）。
 *
 * 任务书 F2 的原话是「左侧目录不分层，压成 2 级，父子看不出层级」→ 目标形态
 * 「书 → 目录多级嵌套 → 条目」。机制（design-v8 §5 钉死）：书列表骨架仍走 `kbTree`，
 * **书内多级目录树由前端按每书 `kbCatalog` 条目的 `path` 字段建**（`moduleFromRel` 的压平
 * 只存续于存储层）。本文件锁的正是这条接线的可观察结果：
 *
 * 1. 建树拉取的 `limit` = catalog 服务端上限 5000（建树要一次拿够，否则树缺层）；
 * 2. `path` 建出来的层级与缩进（`--toc-depth`）、计数（子树条目数）；
 * 3. `path` 空 / 无分隔 → 顶层；自有序条目的 `<id>/vNN.md` 存储尾不进树；`_inbox` → 「未归类」；
 * 4. 点叶子 = 选中条目（与既有行为一致）；目录行可折叠（`.collapse` + `aria-expanded`）；
 * 5. 单框双语义的「输入即目录内收敛」在树上仍然成立：条目命中保留祖先目录、目录段名命中
 *    保留整棵子树。
 *
 * 渲染路径与 `collapse-dom.test.ts` / `knowledge-book-deeplink.test.ts` 一致：happy-dom +
 * 裸 `react-dom/client` + `react.act`（根 vitest.config.ts 的 include 只收 `.test.ts`，不用 JSX）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BookNode } from '../src/api.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：书骨架 + 该书的 catalog（懒加载）+ 记录调用参数（锁 limit）。 */
const data = vi.hoisted(() => ({
  tree: [] as unknown[],
  catalog: [] as unknown[],
  calls: [] as Array<Record<string, unknown>>,
}))

vi.mock('../src/api.ts', () => ({
  api: {
    kbTree: () => Promise.resolve(data.tree),
    kbStats: () => Promise.resolve({ layers: {}, books: 1, entries: 5 }),
    kbConflicts: () => Promise.resolve([]),
    kbCatalog: (params: Record<string, unknown>) => {
      data.calls.push(params)
      return Promise.resolve(data.catalog)
    },
    kbSearch: () => Promise.resolve([]),
    kbGet: () => Promise.resolve(null),
    kbVersions: () => Promise.resolve([]),
    kbBookStructure: () => Promise.resolve(null),
    // v9 F2：页面挂载即拉一次全量架构图；空清单 = 图集组不出现，本文件的树断言不受影响。
    archDiagrams: () => Promise.resolve([]),
  },
}))

import { setLang } from '../src/i18n.ts'
import { KnowledgePage } from '../src/pages/Knowledge.tsx'

function book(name: string): BookNode {
  return { layer: 'project', owner: 'prism', book: name, modules: [{ name: 'doc', count: 5 }], total: 5 }
}

function entry(id: string, title: string, path: string) {
  return {
    id,
    version: 1,
    title,
    type: 'doc',
    layer: 'project',
    owner: 'prism',
    book: 'prism',
    module: 'doc',
    status: 'active',
    risk: '',
    tags: [],
    path,
    in_degree: 0,
    out_degree: 0,
    updated_at: '2026-09-17T00:00:00.000Z',
  }
}

/**
 * 五条条目刚好覆盖 F2 的四类路径形态（书 = `prism`，锚 = 最后一个 `prism` 段）：
 * - 索引型两级：`…\prism\doc\a.md` / `…\prism\doc\req\b.md` → `doc › req`；
 * - 无分隔（`README.md`）与空串 → **顶层**；
 * - 自有序：`<knowledgeDir>\<layer>\<owner>\<book>\notes\<id>\v01.md` → 只留 `notes`
 *   （`<id>` 段与 `vNN.md` 是 Prism 自己的存储结构，`store.ts:48/56`）。
 */
const CATALOG = [
  entry('kb-a', 'Doc A', 'K:\\work\\project\\prism\\doc\\a.md'),
  entry('kb-b', 'Doc Req B', 'K:\\work\\project\\prism\\doc\\req\\b.md'),
  entry('kb-readme', 'Readme', 'README.md'),
  entry('kb-nopath', 'No Path', ''),
  entry('kb-owned', 'Owned', 'C:\\Users\\u\\.prism\\knowledge\\project\\prism\\prism\\notes\\KB-mt1\\v01.md'),
]

let container: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(KnowledgePage, { query: { layer: 'project' } }))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

/** 点一下 + 冲刷微任务（书的条目懒加载：`kbCatalog().then(setState)` 要等落地）。 */
async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

/** 受控输入：走原生 value setter 改值再派发 `input`（React 的受控值跟踪才认账）。 */
async function fill(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 目录行（按显示名找，避免依赖兄弟顺序）。 */
function dirRow(name: string): HTMLElement {
  const found = all('.toc-mod').find((n) => n.querySelector('.toc-modname')?.textContent === name)
  if (found === undefined) throw new Error(`目录行不存在：${name}`)
  return found as HTMLElement
}

/** 目录行名（树形的可读证据，文档序）。 */
function dirNames(): string[] {
  return all('.toc-mod').map((n) => n.querySelector('.toc-modname')?.textContent ?? '')
}

/** 条目行标题（叶子的可读证据，文档序）。 */
function leafTitles(): string[] {
  return all('.toc-item .toc-title').map((n) => n.textContent ?? '')
}

/** 展开唯一那本书 → 触发懒加载 → 树出现。 */
async function openBook(): Promise<void> {
  await click(one('.toc-book')!)
}

beforeEach(() => {
  setLang('zh')
  data.tree = [book('prism')]
  data.catalog = CATALOG
  data.calls = []
  window.location.hash = ''
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

describe('F2 目录树 · 建树数据源与层级', () => {
  it('建树拉取上调到 catalog 的服务端上限 5000（否则树会缺层）', async () => {
    await render()
    await openBook()

    expect(data.calls).toEqual([{ layer: 'project', owner: 'prism', book: 'prism', limit: 5000 }])
  })

  it('树按 `path` 现建：多级可辨（缩进层级）、计数取子树条目数', async () => {
    await render()
    await openBook()

    // 文档序（父节点在其子层之前）：doc（根）› req（doc 的子层）› notes（根）
    expect(dirNames()).toEqual(['doc', 'req', 'notes'])
    expect(dirRow('doc').querySelector('.toc-count')?.textContent).toBe('2')
    expect(dirRow('doc').querySelector('.toc-modname')?.textContent).toBe('doc')
    expect(dirRow('notes').querySelector('.toc-count')?.textContent).toBe('1')

    // 层级缩进：行内 `--toc-depth`（0 起），左内边距由 styles.css 按层累加一档
    expect(dirRow('doc').getAttribute('style')).toContain('--toc-depth: 0')
    expect(dirRow('notes').getAttribute('style')).toContain('--toc-depth: 0')
    expect(dirRow('req').getAttribute('style')).toContain('--toc-depth: 1')
    // `req` 真嵌在 `doc` 的子层里（不是同层平铺——这正是 F2 要解决的「父子看不出层级」）
    expect(dirRow('doc').closest('.toc-node')?.contains(dirRow('req'))).toBe(true)
    expect(dirRow('req').closest('.toc-node')?.parentElement?.closest('.toc-node')).toBe(
      dirRow('doc').closest('.toc-node'),
    )
  })

  it('`path` 为空 / 无分隔 → 顶层；自有序条目的 `<id>/vNN.md` 段不进树', async () => {
    await render()
    await openBook()

    expect(leafTitles().sort()).toEqual(['Doc A', 'Doc Req B', 'No Path', 'Owned', 'Readme'])
    // `<id>` 段（KB-mt1）没有变成目录
    expect(dirNames()).not.toContain('KB-mt1')

    const byTitle = (title: string): HTMLElement =>
      all('.toc-item').find((a) => a.querySelector('.toc-title')?.textContent === title) as HTMLElement
    expect(byTitle('Readme').getAttribute('style')).toContain('--toc-depth: 0')
    expect(byTitle('No Path').getAttribute('style')).toContain('--toc-depth: 0')
    expect(byTitle('Doc A').getAttribute('style')).toContain('--toc-depth: 1')
    expect(byTitle('Owned').getAttribute('style')).toContain('--toc-depth: 1')
  })

  it('`_inbox`（无 module 的自有序条目）显示为「未归类」，沿用既有文案键', async () => {
    data.catalog = [
      entry('kb-inbox', 'Inbox One', 'C:\\Users\\u\\.prism\\knowledge\\project\\prism\\prism\\_inbox\\KB-mt2\\v01.md'),
    ]
    data.tree = [book('prism')]
    await render()
    await openBook()

    expect(dirNames()).toEqual(['未归类'])
    expect(leafTitles()).toEqual(['Inbox One'])
  })

  it('截断可见：`total` 超过缓存条数 → 书末尾明示「还有 N 条」（补测：此前零覆盖）', async () => {
    // 书声称 7 条、catalog 只回 5 条（= 5000 上限截断的形态）→ 剩 2 条要可见
    data.tree = [{ ...book('prism'), total: 7 }]
    await render()
    await openBook()

    expect(one('.toc-note')?.textContent).toBe('还有 2 条（已达上限，用检索收窄）')
    // 截断提示是**追加**行：已取到的 5 条照常渲染，不被提示顶掉
    expect(leafTitles()).toHaveLength(5)
  })

  it('未截断（total = 缓存条数）→ 无「还有 N 条」提示行', async () => {
    data.tree = [book('prism')] // total 5 = catalog 5 条
    await render()
    await openBook()

    expect(one('.toc-note')).toBeNull()
  })
})

describe('F2 目录树 · 交互', () => {
  it('点叶子选中条目：`<a>` 指向该条目的 hash 且拿到 `.active`（与既有条目选中一致）', async () => {
    await render()
    await openBook()

    const leaf = all('.toc-item').find((a) => a.textContent?.includes('Doc Req B')) as HTMLAnchorElement
    // 与既有条目行同源：`hrefOf({page:'knowledge', sel})` 的 path 形态（可中键 / 可复制）
    expect(leaf.getAttribute('href')).toBe('#/knowledge/kb-b?layer=project')
    expect(all('.toc-item.active').length).toBe(0)

    await click(leaf)
    expect(one('.toc-item.active')?.textContent).toContain('Doc Req B')
  })

  it('点目录行 → 只切 `.open` 与 `aria-expanded`，子层节点不卸载', async () => {
    await render()
    await openBook()

    const row = dirRow('req')
    const child = all('.toc-item').find((a) => a.textContent?.includes('Doc Req B'))
    expect(row.getAttribute('aria-expanded')).toBe('true')

    await click(row)
    expect(dirRow('req').getAttribute('aria-expanded')).toBe('false')
    expect(row.closest('.toc-node')?.querySelector('.collapse')?.classList.contains('open')).toBe(false)
    // 收起不卸载：既有「子行存在」类断言不会因动效失真（F2 后目录行同样常驻）
    expect(all('.toc-item').find((a) => a.textContent?.includes('Doc Req B'))).toBe(child)

    await click(dirRow('req'))
    expect(dirRow('req').getAttribute('aria-expanded')).toBe('true')
  })

  it('收起父目录会藏住整棵子树（`.collapse` 逐层嵌套）', async () => {
    await render()
    await openBook()

    await click(dirRow('doc'))
    expect(dirRow('doc').getAttribute('aria-expanded')).toBe('false')
    expect(dirRow('doc').closest('.toc-node')?.querySelector('.collapse')?.classList.contains('open')).toBe(false)
    // 子树 DOM 常驻（可见性交给 `.collapse` 的 `visibility: hidden`）
    expect(dirRow('req')).not.toBeNull()
  })
})

describe('F2 目录树 · 单框双语义的「目录内收敛」仍成立', () => {
  it('条目命中 → 保留其祖先目录，其余枝剪掉', async () => {
    await render()
    await openBook()

    await fill(one('.book-search input')!, 'doc req b')
    expect(dirNames()).toEqual(['doc', 'req'])
    expect(leafTitles()).toEqual(['Doc Req B'])
  })

  it('目录段名命中 → 该目录整棵子树保留（不吃条目命中的裁枝）', async () => {
    await render()
    await openBook()

    // `req` 只是目录段名，不是任何条目的标题 / id / tag 片段
    await fill(one('.book-search input')!, 'req')
    expect(dirNames()).toEqual(['doc', 'req'])
    expect(leafTitles()).toEqual(['Doc Req B'])
  })

  it('全不命中 → 行内空态（该书的可见性由裁枝结果决定）', async () => {
    await render()
    await openBook()

    await fill(one('.book-search input')!, 'zzz')
    expect(dirNames()).toEqual([])
    expect(leafTitles()).toEqual([])
    expect(one('.toc-note')?.textContent).toBe('没有匹配的条目')
  })
})
