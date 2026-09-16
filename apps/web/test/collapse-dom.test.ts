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

/** 知识库树只吃 `kbTree`（骨架）+ 统计 + 冲突 + 命中那本的 catalog（懒加载）。 */
const data = vi.hoisted(() => ({ tree: [] as unknown[] }))

vi.mock('../src/api.ts', () => ({
  api: {
    kbTree: () => Promise.resolve(data.tree),
    kbStats: () => Promise.resolve({ layers: {}, books: 1, entries: 1 }),
    kbConflicts: () => Promise.resolve([]),
    kbCatalog: () => Promise.resolve([]),
    kbSearch: () => Promise.resolve([]),
    kbGet: () => Promise.resolve(null),
    kbVersions: () => Promise.resolve([]),
    kbBookStructure: () => Promise.resolve(null),
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

/** 点一下（阶段卡与目录行都不是 `<button>` 的场景各自在用例里走对应的事件）。 */
async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  setLang('zh')
  data.tree = [book('prism')]
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

describe('v7.1 知识库目录树：书/模块收起后内容常驻 DOM', () => {
  it('书未展开时模块行已在 DOM 里（DOM 常驻是高度可过渡的前提）', async () => {
    await render(createElement(KnowledgePage, { query: { layer: 'project' } }))

    expect(all('.toc-mod').length).toBeGreaterThan(0)
    const wrap = one('.toc-section .collapse')
    expect(wrap, '书行缺折叠容器').not.toBeNull()
    expect(wrap?.classList.contains('open')).toBe(false)
  })

  it('点书 → 折叠容器加 `.open` 且 `aria-expanded` 为真；再点 → 模块行**仍在** DOM', async () => {
    await render(createElement(KnowledgePage, { query: { layer: 'project' } }))
    const bookRow = one('.toc-book')
    expect(bookRow?.getAttribute('aria-expanded')).toBe('false')

    await click(bookRow!)
    expect(one('.toc-section .collapse')?.classList.contains('open')).toBe(true)
    expect(one('.toc-book')?.getAttribute('aria-expanded')).toBe('true')

    const mod = one('.toc-mod')
    expect(mod).not.toBeNull()
    await click(one('.toc-book')!)
    expect(one('.toc-section .collapse')?.classList.contains('open')).toBe(false)
    expect(one('.toc-mod')).toBe(mod) // 收起不卸载：既有「模块行存在」类断言不会因动效失真
  })

  it('模块行收起同样只切 `.open`（条目行常驻，`aria-expanded` 不依赖过渡）', async () => {
    await render(createElement(KnowledgePage, { query: { layer: 'project' } }))
    await click(one('.toc-book')!)

    const mod = one('.toc-mod')
    expect(mod?.getAttribute('aria-expanded')).toBe('true')
    await click(mod!)
    expect(one('.toc-mod')?.getAttribute('aria-expanded')).toBe('false')
    // 目录树里只有两层折叠容器：书级 + 模块级（条目行是模块级容器的**直接内容**，
    // 不再各自包一层——多一层就多一次溢出裁剪，条目行的悬停底与焦点环都会被切）
    const wraps = all('.toc-section .collapse')
    expect(wraps.length).toBe(2)
    expect(wraps[1]?.classList.contains('open')).toBe(false)
  })
})
