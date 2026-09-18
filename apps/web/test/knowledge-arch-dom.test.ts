// @vitest-environment happy-dom
/**
 * v9 F2 架构图入目录树：**接线**回归（判据本身由 `knowledge-arch-logic.test.ts` 的 node 单测覆盖）。
 *
 * 本文件锁的是「纯函数判据」与「页面实际行为」之间那层接线，正是缺陷可能藏身的地方：
 *  1. **挂载**：`module` 命中目录段 / 未命中回落书根 / 无 book 归「全局图集」（根级虚拟组，默认收起）；
 *  2. **过滤**：搜索与层 chips 对 arch 节点同等生效；
 *  3. **深链**：`arch-<type>-<name>` **先分支**——`kbGet` 一次都不许发（旧写法会落 404 帧），
 *     命中项带 book 时自动展开该书；解析不到给 **arch 专用**未命中 pane；
 *  4. **降级**：全量拉取失败 → 图集组内错误行（原文 + 重试），条目浏览不受阻；
 *  5. **空库有图**（design-v9 E-4）：`books=[]` 但有图 → 仍渲染两栏，不落 `EmptyBlock`。
 *
 * 渲染路径与 `knowledge-tree.test.ts` 一致：happy-dom + 裸 `react-dom/client` + `react.act`
 * （根 vitest.config.ts 的 include 只收 `.test.ts`，故不用 JSX，走 `createElement`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BookNode } from '../src/api.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 受控假数据。
 * - `atlas` = 无书归属的图（进「全局图集」）；`byBook` = 各书作用域的图；
 * - **全量** fetch（无 `book` 参数）返回两者的并集——真服务端就是这样，深链解析也因此拿得到带书的图；
 * - `failFull` 造「全量拉取失败」；`holdFull` 造「在途」（未决 promise）。
 */
const data = vi.hoisted(() => ({
  tree: [] as unknown[],
  catalog: [] as unknown[],
  atlas: [] as unknown[],
  byBook: {} as Record<string, unknown[]>,
  failFull: false,
  holdFull: false,
  releaseFull: null as null | ((value: unknown[]) => void),
  kbGetCalls: [] as string[],
}))

vi.mock('../src/api.ts', () => ({
  api: {
    kbTree: () => Promise.resolve(data.tree),
    kbStats: () => Promise.resolve({ layers: {}, books: 1, entries: 1 }),
    kbConflicts: () => Promise.resolve([]),
    kbCatalog: () => Promise.resolve(data.catalog),
    kbSearch: () => Promise.resolve({ results: [] }),
    kbGet: (id: string) => {
      data.kbGetCalls.push(id)
      return Promise.resolve(null)
    },
    kbVersions: () => Promise.resolve([]),
    kbBookStructure: () => Promise.resolve(null),
    archDiagrams: (params?: { book?: string }) => {
      if (params?.book !== undefined) return Promise.resolve(data.byBook[params.book] ?? [])
      if (data.holdFull) {
        return new Promise<unknown[]>((resolve) => {
          data.releaseFull = resolve
        })
      }
      if (data.failFull) return Promise.reject(new Error('internal: 架构图接口挂了'))
      return Promise.resolve([...data.atlas, ...Object.values(data.byBook).flat()])
    },
  },
}))

import { setLang } from '../src/i18n.ts'
import { KnowledgePage } from '../src/pages/Knowledge.tsx'

function book(name: string): BookNode {
  return { layer: 'project', owner: 'prism', book: name, modules: [{ name: 'doc', count: 1 }], total: 1 }
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
    updated_at: '2026-09-16T08:00:00.000Z',
  }
}

/** 架构图响应项（冻结字段的子集；`preview` 由服务端给，前端不拼）。 */
function diagram(type: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    name,
    bytes: 1024,
    mtime: '2026-09-16T08:00:00.000Z',
    has_ir: true,
    source: 'global',
    preview: `/api/arch/preview/${type}/${name}`,
    ir: `/api/arch/ir/${type}/${name}`,
    ...extra,
  }
}

let container: HTMLDivElement
let root: Root

interface Props {
  sel?: string
  query?: Record<string, string>
  onSelect?: (id?: string) => void
  onQuery?: (patch: Record<string, string | undefined>) => void
}

async function render(props: Props = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(KnowledgePage, props))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

/** 点一下 + 冲刷微任务（书展开后的条目 / 架构图懒加载要等落地）。 */
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

/** 展开唯一那本书（触发条目 + 架构图两条懒加载）。 */
async function openBook(): Promise<void> {
  await click(one('.toc-book')!)
}

/** 按组名（书名 / 「全局图集」）取 `.toc-section`。 */
function sectionOf(name: string): HTMLElement {
  const found = all('.toc-section').find((s) => s.querySelector('.toc-bookname')?.textContent === name)
  if (found === undefined) throw new Error(`分组不存在：${name}`)
  return found as HTMLElement
}

/** 架构图行的标题（文档序）。 */
function archTitles(): string[] {
  return all('.toc-item .toc-arch-dot').map((dot) => dot.parentElement?.querySelector('.toc-title')?.textContent ?? '')
}

/** 条目叶子行的标题（文档序）。 */
function leafTitles(): string[] {
  return all('.toc-item')
    .filter((row) => row.querySelector('.toc-arch-dot') === null)
    .map((row) => row.querySelector('.toc-title')?.textContent ?? '')
}

/** 点层 chip（按显示文案找）。 */
async function pickChip(label: string): Promise<void> {
  const chip = all('.toc-chips .toc-chip').find((c) => c.textContent === label)
  if (chip === undefined) throw new Error(`chip 不存在：${label}`)
  await click(chip)
}

beforeEach(() => {
  setLang('zh')
  data.tree = [book('prism')]
  data.catalog = [entry('kb-a', 'Doc A', 'K:\\work\\project\\prism\\doc\\a.md')]
  data.atlas = []
  data.byBook = {}
  data.failFull = false
  data.holdFull = false
  data.releaseFull = null
  data.kbGetCalls = []
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

describe('F2 架构图 · 挂载（module 命中目录段 / 回落书根 / 全局图集）', () => {
  it('`module` 命中目录段 → 挂在那个目录下，且排在**条目之后**', async () => {
    data.byBook = {
      prism: [diagram('architecture', 'a.html', { book: 'prism', module: 'doc', title: 'Arch A' })],
    }
    await render({ query: { layer: 'project' } })
    await openBook()

    const doc = all('.toc-mod').find((m) => m.querySelector('.toc-modname')?.textContent === 'doc')!
    // 目录行计数含图（1 条目 + 1 图）
    expect(doc.querySelector('.toc-count')?.textContent).toBe('2')
    // 同节点内：条目在前、图在后
    const rows = [...doc.closest('.toc-node')!.querySelectorAll('.toc-item')].map(
      (r) => r.querySelector('.toc-title')?.textContent,
    )
    expect(rows).toEqual(['Doc A', 'Arch A'])
  })

  it('`module` 未命中 → 回落**书根**（不在任何 `.toc-node` 里，深度 0）', async () => {
    data.byBook = {
      prism: [diagram('dataflow', 'd.html', { book: 'prism', module: 'nope', title: 'Root D' })],
    }
    await render({ query: { layer: 'project' } })
    await openBook()

    const row = all('.toc-item').find((r) => r.querySelector('.toc-arch-dot') !== null)!
    expect(row.querySelector('.toc-title')?.textContent).toBe('Root D')
    expect(row.getAttribute('style')).toContain('--toc-depth: 0')
    expect(row.closest('.toc-node')).toBeNull()
  })

  it('无 book → 根级虚拟组「全局图集」，默认收起；开合**不写 `?book=`**；带 project 时多一枚徽章', async () => {
    data.atlas = [
      diagram('workflow', 'w.html', { title: 'Flow W', project: 'prism', source: 'project' }),
    ]
    const onQuery = vi.fn()
    const onSelect = vi.fn()
    await render({ query: { layer: 'project' }, onQuery, onSelect })

    const group = sectionOf('全局图集')
    const head = group.querySelector('.toc-book')!
    expect(head.getAttribute('aria-expanded')).toBe('false')
    // 收起是 `.collapse` 的形态，行本身常驻 DOM（高度可过渡的前提）
    expect(group.querySelector('.collapse')?.classList.contains('open')).toBe(false)
    expect(archTitles()).toEqual(['Flow W'])
    // 徽章：类型 + project（两张）
    const badges = [...group.querySelectorAll('.toc-arch-badge')].map((b) => b.textContent)
    expect(badges).toEqual(['工作流图', 'prism'])

    await click(head)
    expect(group.querySelector('.toc-book')?.getAttribute('aria-expanded')).toBe('true')
    expect(group.querySelector('.collapse')?.classList.contains('open')).toBe(true)
    // 图集不是书：开合不得回写 `?book=`（也不该改选中）
    expect(onQuery).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })
})

/**
 * 裁决 2（key 唯一性）· **先红后绿**：
 *
 * 冲突②暴露的后果之一——同书同 `(type, name)`、仅 `source`/`project`/`mtime` 不同的产物
 * 会挂在同一棵树上，而旧 key 取 `archSel(item)`（只含 `type|name`）⇒ React 报重复 key。
 *
 * **红（改 key 之前）**：本用例在该 describe 下跑，`expect(dup).toEqual([])` 失败——
 *   spy 捕获到 `Warning: Encountered two children with the same key, `arch-architecture-a.html``。
 * **绿（改 key 之后）**：`renderArch` 的 key 改 `type|name|mtime|序号`，
 *   同 sel 的两行 key 不再相等，告警消失、两行都在。
 * 深链 sel 粒度**不变**（裁决 1 接受现状，见报告 D-v9-1 技术债）。
 */
describe('F2 架构图 · 同书同名双节点的 key 唯一性（裁决 2）', () => {
  it('同 type/name、不同 mtime 的两项挂同一本书 → 两行都渲染，且无 React 重复 key 告警', async () => {
    data.byBook = {
      // 按真服务端口径（mtime 降序）：较新的 demo-b 在前
      prism: [
        diagram('architecture', 'a.html', {
          book: 'prism',
          module: 'doc',
          title: 'Arch A（demo-b）',
          project: 'demo-b',
          source: 'project',
          mtime: '2026-09-17T08:00:00.000Z',
        }),
        diagram('architecture', 'a.html', {
          book: 'prism',
          module: 'doc',
          title: 'Arch A（demo-a）',
          project: 'demo-a',
          source: 'project',
          mtime: '2026-09-16T08:00:00.000Z',
        }),
      ],
    }
    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args)
    })
    try {
      await render({ query: { layer: 'project' } })
      await openBook()
    } finally {
      spy.mockRestore()
    }

    // 两行都在（同一目录段 `doc` 下，文档序 = 入参顺序；服务端降序 ⇒ 较新的在前）
    expect(archTitles()).toEqual(['Arch A（demo-b）', 'Arch A（demo-a）'])
    // React 不得报重复 key
    const dup = errors.filter((args) => args.some((a) => String(a).includes('same key')))
    expect(dup).toEqual([])
  })
})

describe('F2 架构图 · 过滤（搜索 / 层 chips）', () => {
  it('搜索命中 `title`：保留祖先目录，未命中的条目被裁掉', async () => {
    data.byBook = {
      prism: [diagram('architecture', 'a.html', { book: 'prism', module: 'doc', title: 'Arch A' })],
    }
    await render({ query: { layer: 'project' } })
    await openBook()

    await fill(one('.book-search input')!, 'arch')

    expect(all('.toc-mod').map((m) => m.querySelector('.toc-modname')?.textContent)).toEqual(['doc'])
    expect(archTitles()).toEqual(['Arch A'])
    expect(leafTitles()).toEqual([])
  })

  it('层 chips：无 `layer` 的图恒可见；有 `layer` 的仅相等可见', async () => {
    data.atlas = [
      diagram('lifecycle', 'free.html', { title: 'Free' }),
      diagram('workflow', 'scoped.html', { title: 'Scoped', layer: 'role' }),
    ]
    await render({ query: {} })

    expect(archTitles().sort()).toEqual(['Free', 'Scoped'])

    await pickChip('全局')
    // 带 `layer: 'role'` 的被层过滤掉；无 `layer` 的照旧在
    expect(archTitles()).toEqual(['Free'])

    await pickChip('专家')
    // 切到 role：`Scoped` 回来了，而**无 `layer` 的 `Free` 始终没被任何 chip 挡掉**
    expect(archTitles()).toEqual(['Free', 'Scoped'])
  })

  it('书被层过滤掉时，其下的图一并不可见（书的可见性优先）', async () => {
    data.byBook = {
      prism: [diagram('architecture', 'a.html', { book: 'prism', module: 'doc', title: 'Arch A' })],
    }
    await render({ query: { layer: 'project' } })
    await openBook()
    expect(archTitles()).toEqual(['Arch A'])

    await pickChip('专家')
    // 书（project 层）整本消失 → 挂在它下面的图随之消失，也不该被「无处安放」地塞进图集
    expect(all('.toc-bookname')).toEqual([])
    expect(archTitles()).toEqual([])
  })
})

describe('F2 架构图 · 深链（arch- 前缀先分支）', () => {
  it('arch sel 命中：**不发 kbGet**，右栏出全宽 iframe（src 直接用服务端 preview）+ 工具条', async () => {
    data.byBook = {
      prism: [diagram('architecture', 'a.html', { book: 'prism', module: 'doc', title: 'Arch A' })],
    }
    await render({ sel: 'arch-architecture-a.html', query: { layer: 'project' } })

    expect(data.kbGetCalls).toEqual([])

    const frame = one<HTMLIFrameElement>('.arch-view iframe')!
    expect(frame.getAttribute('src')).toBe('/api/arch/preview/architecture/a.html')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-popups')
    // 工具条：类型徽章 / 生成时间（fmtTime）/ 新标签打开（a[target=_blank]，href 同 preview）
    expect(one('.arch-view-bar')?.textContent).toContain('架构图')
    expect(one('.arch-view-bar')?.textContent).toContain('2026-09-16 08:00')
    const open = one<HTMLAnchorElement>('.arch-view-open')!
    expect(open.getAttribute('target')).toBe('_blank')
    expect(open.getAttribute('href')).toBe('/api/arch/preview/architecture/a.html')
    // 绝不落条目的未命中帧
    expect(container.textContent).not.toContain('条目不存在或已移出索引')
  })

  it('命中项带 `book` → 自动展开该书，且该行拿 `.active`', async () => {
    data.byBook = {
      prism: [diagram('sequence', 's.html', { book: 'prism', module: 'doc', title: 'Seq S' })],
    }
    await render({ sel: 'arch-sequence-s.html', query: { layer: 'project' } })

    expect(sectionOf('prism').querySelector('.toc-book')?.getAttribute('aria-expanded')).toBe('true')
    const active = one('.toc-item.active')!
    expect(active.querySelector('.toc-title')?.textContent).toBe('Seq S')
    expect(active.querySelector('.toc-arch-dot')).not.toBeNull()
  })

  it('命中项无书归属 → 自动展开「全局图集」（默认收起的组里，命中行否则看不见）', async () => {
    data.atlas = [diagram('workflow', 'w.html', { title: 'Flow W' })]
    await render({ sel: 'arch-workflow-w.html', query: {} })

    const group = sectionOf('全局图集')
    expect(group.querySelector('.toc-book')?.getAttribute('aria-expanded')).toBe('true')
    expect(one('.toc-item.active .toc-title')?.textContent).toBe('Flow W')
  })

  it('解析不到 → **arch 专用**未命中 pane（不复用「条目不存在」文案），仍不发 kbGet', async () => {
    await render({ sel: 'arch-architecture-missing.html', query: { layer: 'project' } })

    expect(one('.book-content h3')?.textContent).toBe('架构图不存在')
    expect(one('.book-content')?.textContent).toContain('arch-architecture-missing.html')
    expect(data.kbGetCalls).toEqual([])
    expect(container.textContent).not.toContain('条目不存在或已移出索引')
  })

  it('清单仍在途 → 骨架（不把慢网络说成「这张图不存在」）', async () => {
    data.holdFull = true
    await render({ sel: 'arch-architecture-a.html', query: { layer: 'project' } })

    expect(one('.book-content .skeleton')).not.toBeNull()
    expect(one('.book-content h3')).toBeNull()
    expect(data.kbGetCalls).toEqual([])
  })

  it('非法类型（不在五类闭集）→ 回落条目分支：会发 kbGet，落条目的未命中帧', async () => {
    await render({ sel: 'arch-gantt-x.html', query: { layer: 'project' } })

    expect(data.kbGetCalls).toEqual(['arch-gantt-x.html'])
    expect(one('.book-content h3')?.textContent).toBe('条目不存在或已移出索引')
  })
})

describe('F2 架构图 · 降级与空库有图', () => {
  it('全量拉取失败 → 图集组内出错误行（原文 + 重试），条目树照常渲染', async () => {
    data.failFull = true
    await render({ query: { layer: 'project' } })
    await openBook()

    const group = sectionOf('全局图集')
    expect(group.querySelector('.error')?.textContent).toContain('internal: 架构图接口挂了')
    expect(group.querySelector('button.tool-btn')?.textContent).toBe('重试')
    // 条目侧一切照旧
    expect(leafTitles()).toEqual(['Doc A'])
    expect(container.querySelector('.empty')).toBeNull()
  })

  it('空库有图（E-4）：`books=[]` 但有图 → 图集组渲染，`EmptyBlock` 不出现', async () => {
    data.tree = []
    data.atlas = [diagram('workflow', 'w.html', { title: 'Flow W' })]
    await render({ query: {} })

    expect(all('.toc-bookname').map((n) => n.textContent)).toEqual(['全局图集'])
    expect(archTitles()).toEqual(['Flow W'])
    expect(container.querySelector('.empty')).toBeNull()
  })

  it('库与图确实全空 → 仍落 `EmptyBlock`（空态没被 E-4 修丢）', async () => {
    data.tree = []
    data.atlas = []
    await render({ query: {} })

    expect(container.querySelector('.empty')).not.toBeNull()
    expect(one('.empty')?.textContent).toContain('知识库还没有内容')
  })
})
