// @vitest-environment happy-dom
/**
 * v7.1 展开收起：**过渡不得破坏 DOM 断言**（本轮红线）。
 *
 * 高度过渡用的是 `.collapse` 的 `grid-template-rows: 0fr → 1fr`，这条技巧要求内容在
 * 折叠态**仍挂在 DOM 上**（内容一卸载，高度早就是 0，动画无从观察）。于是「折叠时元素还在
 * 不在 DOM 里」这件事从「原来不在」变成了「现在在」——本文件把这个新契约钉死，正因为它是
 * 本轮唯一可能让既有断言（「元素存在/可点」）失真的地方。
 *
 * 两件事各锁一遍：
 * 1. **收起常驻**：折叠态下内容节点存在，且开合前后是**同一个节点**（不是重建出来的）；
 * 2. **状态位不靠动画**：开合由 `.open` 类与 `aria-expanded` 表达，与过渡进度无关
 *    （无头环境下没有渲染时钟，若哪天真把状态挂到动画上，这里立刻红）。
 *
 * 渲染路径与 `knowledge-book-deeplink.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`（根 vitest.config.ts 的 include 只收 `.test.ts`，故不用 JSX，走 `createElement`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowStage } from '../src/api-team.ts'
import type { BookNode } from '../src/api.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 知识库：书列表骨架只吃 `kbTree` + 统计 + 冲突 + 命中那本的 catalog（懒加载）。
 * ⚠ F2 起**目录行来自 catalog 的 `path`**（不再是 `kbTree.modules`），故这里必须给 catalog
 * 真条目，否则书内是空树、目录行一个都渲染不出来。
 */
const data = vi.hoisted(() => ({ tree: [] as unknown[], catalog: [] as unknown[] }))

vi.mock('../src/api.ts', () => ({
  api: {
    kbTree: () => Promise.resolve(data.tree),
    kbStats: () => Promise.resolve({ layers: {}, books: 1, entries: 1 }),
    kbConflicts: () => Promise.resolve([]),
    kbCatalog: () => Promise.resolve(data.catalog),
    kbSearch: () => Promise.resolve([]),
    kbGet: () => Promise.resolve(null),
    kbVersions: () => Promise.resolve([]),
    kbBookStructure: () => Promise.resolve(null),
    // v9 F2：页面挂载即拉一次全量架构图；空清单 = 图集组不出现，本文件的 DOM 断言不受影响。
    archDiagrams: () => Promise.resolve([]),
  },
}))

import { setLang } from '../src/i18n.ts'
import { KnowledgePage } from '../src/pages/Knowledge.tsx'
import { WorkflowFlow } from '../src/pages/teams/parts/WorkflowFlow.tsx'

function stage(order: number, name: string): WorkflowStage {
  return {
    order,
    stage: name,
    roles: [`role-${order}`],
    mode: 'scan',
    input: `in-${order}`,
    output: `out-${order}`,
    done: `done-${order}`,
    reflow: '',
  }
}

function book(name: string): BookNode {
  return { layer: 'project', owner: 'prism', book: name, modules: [{ name: 'm1', count: 2 }], total: 2 }
}

/**
 * F2 的目录行由条目 `path` 建：`<...>/prism/doc/a.md` 与 `<...>/prism/doc/req/b.md`
 * → 书内树 `doc › req`（doc 计 2、req 计 1）。书锚 = 最后一个与书名相等的段（`prism`）。
 */
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

const CATALOG = [
  entry('kb-1', 'A', 'K:\\work\\project\\prism\\doc\\a.md'),
  entry('kb-2', 'B', 'K:\\work\\project\\prism\\doc\\req\\b.md'),
]

let container: HTMLDivElement
let root: Root

async function render(node: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(node)
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

/**
 * 点一下（阶段卡与目录行都不是 `<button>` 的场景各自在用例里走对应的事件）。
 * 第二次 `act` 冲刷微任务：书的条目是**懒加载**的（`kbCatalog().then(setState)`），
 * 点开后要等这一轮落地才能看到目录行。
 */
async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

beforeEach(() => {
  setLang('zh')
  data.tree = [book('prism')]
  data.catalog = CATALOG
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

describe('v7.1 工作流阶段：折叠态内容常驻，开合只由 `.open` 表达', () => {
  it('未点任何阶段时明细已在 DOM 里（旧实现：`active === undefined` 整块不渲染）', async () => {
    await render(createElement(WorkflowFlow, { workflow: [stage(1, '扫描'), stage(2, '分析')] }))

    const wrap = one('.collapse')
    expect(wrap, '阶段明细缺折叠容器').not.toBeNull()
    expect(wrap?.classList.contains('open')).toBe(false)
    // 未展开时没有任何明细行
    expect(all('.flow-detail-row').length).toBe(0)
    // 阶段卡本身照旧可点（不能因为加了动效就变成不可交互）
    expect(all('.flow-stage').length).toBe(2)
  })

  it('点阶段 → 加 `.open` + `aria-expanded`，明细就地出现；再点 → 去 `.open` 但**节点仍在**', async () => {
    await render(createElement(WorkflowFlow, { workflow: [stage(1, '扫描'), stage(2, '分析')] }))

    await click(all('.flow-stage')[0]!)
    const wrap = one('.collapse')
    expect(wrap?.classList.contains('open')).toBe(true)
    expect(all('.flow-stage')[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(all('.flow-detail-row').length).toBeGreaterThan(0)

    // 收起：状态位（类名 + aria）先于任何动画落地，明细**不卸载**
    const detail = one('.flow-detail')
    expect(detail).not.toBeNull()
    await click(all('.flow-stage')[0]!)
    expect(one('.collapse')?.classList.contains('open')).toBe(false)
    expect(all('.flow-stage')[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(one('.flow-detail')).toBe(detail) // 同一个节点，不是重建
  })

  it('换到另一个阶段：`.open` 保持，明细内容换成新阶段（不高亮两个）', async () => {
    await render(createElement(WorkflowFlow, { workflow: [stage(1, '扫描'), stage(2, '分析')] }))

    await click(all('.flow-stage')[0]!)
    await click(all('.flow-stage')[1]!)
    expect(one('.collapse')?.classList.contains('open')).toBe(true)
    expect(all('.flow-stage')[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(all('.flow-stage')[1]?.getAttribute('aria-expanded')).toBe('true')
    expect(one('.flow-detail')?.textContent).toContain('role-2')
  })
})

/**
 * ⚠ **F2 契约变更（本段随实现重写，非「改测试迁就实现」）**：任务书把左栏从
 * 「书 → 压平模块 → 条目」改成「书 → 目录多级嵌套 → 条目」，目录行不再来自
 * `kbTree.modules`，而是该书 `kbCatalog` 条目的 `path` 现建的树
 * （`knowledge-logic.ts#buildTree`，判据另有 node 单测）。
 *
 * 于是**旧断言的取数前提消失**：书未展开时该书条目还没懒加载 ⇒ 一条目录行都没有。
 * `collapse` 的「收起后内容常驻 DOM」这条**红线本身没变**，只是被断言的对象从
 * 「模块行」换成「目录行」，并且要先把书展开（触发懒加载）才存在。
 */
describe('v7.1 知识库目录树：书/目录收起后内容常驻 DOM', () => {
  /** 目录行名（`.toc-modname`）：树形的可读证据。 */
  function dirNames(): string[] {
    return all('.toc-mod').map((n) => n.querySelector('.toc-modname')?.textContent ?? '')
  }

  it('展开书 → 按 `path` 现建目录树（doc › req），计数取子树条目数', async () => {
    await render(createElement(KnowledgePage, { query: { layer: 'project' } }))
    // 收起态：该书条目尚未懒加载 ⇒ 书内还建不出树
    expect(dirNames()).toEqual([])

    await click(one('.toc-book')!)
    expect(dirNames()).toEqual(['doc', 'req'])
    expect(all('.toc-mod')[0]?.querySelector('.toc-count')?.textContent).toBe('2')
    expect(all('.toc-mod')[1]?.querySelector('.toc-count')?.textContent).toBe('1')
    // 树要求「多级可辨」：层级由行内 `--toc-depth` 表达（根 0、子 1）
    expect(all('.toc-mod')[0]?.getAttribute('style')).toContain('--toc-depth: 0')
    expect(all('.toc-mod')[1]?.getAttribute('style')).toContain('--toc-depth: 1')
  })

  it('点书 → 折叠容器加 `.open` 且 `aria-expanded` 为真；再点 → 目录行**仍在** DOM（同一节点）', async () => {
    await render(createElement(KnowledgePage, { query: { layer: 'project' } }))
    const bookRow = one('.toc-book')
    expect(bookRow?.getAttribute('aria-expanded')).toBe('false')

    await click(bookRow!)
    expect(one('.toc-section .collapse')?.classList.contains('open')).toBe(true)
    expect(one('.toc-book')?.getAttribute('aria-expanded')).toBe('true')

    const dir = one('.toc-mod')
    expect(dir).not.toBeNull()
    await click(one('.toc-book')!)
    expect(one('.toc-section .collapse')?.classList.contains('open')).toBe(false)
    expect(one('.toc-mod')).toBe(dir) // 收起不卸载：既有「目录行存在」类断言不会因动效失真
  })

  it('目录行收起同样只切 `.open`（子层常驻，`aria-expanded` 不依赖过渡）', async () => {
    await render(createElement(KnowledgePage, { query: { layer: 'project' } }))
    await click(one('.toc-book')!)

    const dir = one('.toc-mod')
    expect(dir?.getAttribute('aria-expanded')).toBe('true')
    const child = one('.toc-item')
    await click(dir!)
    expect(one('.toc-mod')?.getAttribute('aria-expanded')).toBe('false')
    // 折叠容器数 = 书级 1 + 目录节点数（每个目录节点自带一层；条目行是叶层的**直接内容**，
    // 不再各自包一层——多一层就多一次溢出裁剪，悬停底与焦点环都会被切）
    expect(all('.toc-section .collapse').length).toBe(1 + all('.toc-mod').length)
    expect(one('.toc-node .collapse')?.classList.contains('open')).toBe(false)
    expect(one('.toc-item')).toBe(child) // 子层不卸载
  })
})
