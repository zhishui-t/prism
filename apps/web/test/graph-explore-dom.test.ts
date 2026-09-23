// @vitest-environment happy-dom
/**
 * v10 F8（图谱页两态改版）+ F9ui（层级探索视图）：**DOM 行为**回归
 * （happy-dom + 裸 `react-dom/client` + `react.act`；根 vitest.config.ts 的 include 只收
 * `.test.ts`，故不用 JSX，走 `createElement`）。
 *
 * 覆盖：
 *  F8 ——
 *   1. 三态：默认落**查询**态（进页面即见初始引导）→ 发查询出结果面板 → 切探索 →
 *      切回查询结果仍在（视图切换是组件内 state，不重取数）；
 *   2. **`sel` 深链兼容**：深链进来仍落查询态，且切视图**不写 hash**（F9-5：`sel` 键语义不动、
 *      探索状态不进 hash）；
 *   3. studio **iframe 已移除**，降级为「打开全图」外链（新标签 + `noopener`）。
 *  F9ui ——
 *   4. 逐级下钻的**请求序**（community → dir → file → symbol），**按需**（探索态可见才发）
 *      且**每层每 parent 一次**（回退/切走再回来都走缓存，不再发）；
 *   5. 面包屑回退（点哪段回哪段）；
 *   6. file 卡片的「查此节点」→ 符号列表（只读）→ 点符号**切回查询态**对该**真实 id**
 *      发四模式查询（含「先前停在 path 档」这一路径——`pickSymbol` 不被 mode 守卫挡掉）；
 *       dir/community 卡片**没有**这个入口；
 *   7. 截断（`truncated`）如实告知 + **B-7 真分页**：本地翻完用 `next_cursor` 取次页并并进本层
 *      （跨页边在次页补齐）、409 `stale_cursor` → 丢弃本层回第一页重查；
 *   8. 空态 / 错误态（含重试）。
 *
 * mock 口径：与 `graph-query-dom.test.ts` 同款——stub 最外层 `globalThis.fetch`，
 * 让 `api.ts` 与页面一起跑真代码（要断言「打到了哪个 URL、带了什么参数」）。
 * rollup 的桩按 `level|parent` 取（翻页按 `cursor:<游标>`），未知键回 `not_stubbed` 信封
 * （用例写漏会红，不会静默过）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setLang, t } from '../src/i18n.ts'
import { CodeGraphPage } from '../src/pages/CodeGraph.tsx'

const PROJECT = { project: 'demo', root: '/tmp/demo' }
const STATUS = {
  project: 'demo',
  root: '/tmp/demo',
  graph_exists: true,
  built_at: '2026-09-16T00:00:00.000Z',
  changed_files: 0,
  total_files: 10,
  stale: false,
}

/** 路径 → 信封（非 rollup 的既有端点用）。 */
let payloads: Record<string, unknown> = {}
/**
 * rollup 桩：首页按 `level|parent` 取，翻页按 `cursor:<游标>` 取。
 * 未知键回 `not_stubbed` 信封（用例写漏会红，不会静默过）。
 */
let rollups: Record<string, unknown> = {}
let requests: URL[] = []
/** `hold()` 挂起中的响应：settle 之前该路径的 fetch 一直悬着。 */
let pending: Record<string, Promise<unknown>> = {}
let container: HTMLDivElement
let root: Root

function ok(value: unknown): unknown {
  return { ok: true, value }
}

/** 把某路径的响应**挂起**，返回 `settle(envelope)`（用于断言「在途」那一帧的渲染）。 */
function hold(pathname: string): (envelope: unknown) => void {
  let settle!: (value: unknown) => void
  const promise = new Promise<unknown>((resolve) => {
    settle = resolve
  })
  pending[pathname] = promise
  return (envelope: unknown) => {
    delete pending[pathname]
    settle({ json: async () => envelope })
  }
}

function rollupRequests(): URL[] {
  return requests.filter((u) => u.pathname === '/api/graph/rollup')
}

beforeEach(() => {
  setLang('zh')
  payloads = {}
  rollups = {}
  requests = []
  pending = {}
  vi.stubGlobal('fetch', (input: unknown) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(url)
    const held = pending[url.pathname]
    if (held !== undefined) return held
    if (url.pathname === '/api/graph/projects') return Promise.resolve({ json: async () => ok([PROJECT]) })
    if (url.pathname === '/api/graph/status') return Promise.resolve({ json: async () => ok(STATUS) })
    if (url.pathname === '/api/graph/rollup') {
      const cursor = url.searchParams.get('cursor')
      const key =
        cursor !== null
          ? `cursor:${cursor}`
          : `${url.searchParams.get('level')}|${url.searchParams.get('parent') ?? ''}`
      const hit = rollups[key]
      return Promise.resolve({
        json: async () =>
          hit ?? { ok: false, error: { code: 'not_stubbed', message: key } },
      })
    }
    const hit = payloads[url.pathname]
    if (hit === undefined) {
      return Promise.resolve({
        json: async () => ({ ok: false, error: { code: 'not_stubbed', message: url.pathname } }),
      })
    }
    return Promise.resolve({ json: async () => hit })
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(CodeGraphPage, { sel: 'demo' }))
  })
  // useAsync 的两笔（projects → status）落定
  await act(async () => {})
  await act(async () => {})
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function buttonByText(label: string, scope = container): HTMLButtonElement {
  const hit = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

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

function nodeInput(): HTMLInputElement {
  const hit = one<HTMLInputElement>('.graph-query-card > .row > input')
  if (hit === null) throw new Error('查询卡里没有输入框')
  return hit
}

function modeChip(label: string): HTMLButtonElement {
  return buttonByText(label, one<HTMLElement>('.graph-query-modes')!)
}

/** 主区两态的分段控件里那两颗按钮（作用域限定在 `.graph-view-bar`，不与查询卡的串）。 */
function viewTab(label: string): HTMLButtonElement {
  const bar = one<HTMLElement>('.graph-view-bar')
  if (bar === null) throw new Error('主区视图分段控件不在 DOM 里')
  return buttonByText(label, bar)
}

function queryTab(): HTMLButtonElement {
  return viewTab(t('graph.view.query'))
}

function exploreTab(): HTMLButtonElement {
  return viewTab(t('graph.view.explore'))
}

async function toExplore(): Promise<void> {
  await click(exploreTab())
}

function cards(): HTMLButtonElement[] {
  return all('.explore-card') as HTMLButtonElement[]
}

/** 卡片上的名字（`.explore-label` 是卡片里唯一的等宽名字段）。 */
function cardLabels(): string[] {
  return cards().map((c) => c.querySelector('.explore-label')?.textContent ?? '')
}

function cardByLabel(label: string): HTMLButtonElement {
  const hit = cards().find((c) => c.querySelector('.explore-label')?.textContent === label)
  if (hit === undefined) throw new Error(`没有名为 ${label} 的卡片（现有：${cardLabels().join(',')}）`)
  return hit
}

/** 面包屑上的文字（末段是 `span.crumb-here`，其余是可点的 `button.crumb-back`）。 */
function crumbs(): string[] {
  const nav = one<HTMLElement>('.crumb')
  if (nav === null) throw new Error('面包屑不在 DOM 里')
  return [...nav.children].map((cell) => {
    const here = cell.querySelector('.crumb-here')
    const back = cell.querySelector('.crumb-back')
    return (here ?? back)?.textContent ?? ''
  })
}

function lastRollup(level: string): URL | undefined {
  return [...rollupRequests()].reverse().find((u) => u.searchParams.get('level') === level)
}

/** 翻页请求（带 `cursor` 的那些）——B-7 真分页用。 */
function cursorRequests(): URL[] {
  return rollupRequests().filter((u) => u.searchParams.has('cursor'))
}

/** 某一层（`level` + 可选 `parent`）被请求了几次——409 回首页重查要看这个。 */
function layerRequests(level: string, parent: string | null = null): URL[] {
  return rollupRequests().filter(
    (u) => u.searchParams.get('level') === level && (u.searchParams.get('parent') ?? null) === parent,
  )
}

// ===== rollup 夹具（形状逐字对齐后端 `graph-rollup.test.ts`） =====

function communityValue(): unknown {
  return {
    level: 'community',
    parent: null,
    total: 2,
    truncated: false,
    nodes: [
      { id: 'community:1', label: '核心', kind: 'community', symbol_count: 4 },
      { id: 'community:2', label: '工具', kind: 'community', symbol_count: 1 },
    ],
    edges: [{ from: 'community:1', to: 'community:2', weight: 2 }],
  }
}

/** `dir` 层带 `community` 字段（真实响应就有）——UI **不得**把它渲染出来（见断言）。 */
function dirValue(): unknown {
  return {
    level: 'dir',
    parent: 'community:1',
    total: 1,
    truncated: false,
    nodes: [{ id: 'dir:src/sub', label: 'src/sub', kind: 'dir', symbol_count: 5, community: 1 }],
    edges: [],
  }
}

function fileValue(): unknown {
  return {
    level: 'file',
    parent: 'dir:src/sub',
    total: 1,
    truncated: false,
    nodes: [{ id: 'file:src/sub/a.ts', label: 'src/sub/a.ts', kind: 'file', symbol_count: 2 }],
    edges: [],
  }
}

function symbolValue(): unknown {
  return {
    level: 'symbol',
    parent: 'file:src/sub/a.ts',
    total: 2,
    truncated: false,
    nodes: [
      { id: 'pkg/a.ts#alpha', label: 'alpha', kind: 'symbol', symbol_count: 1 },
      { id: 'pkg/a.ts#beta', label: 'beta', kind: 'symbol', symbol_count: 1 },
    ],
    edges: [],
  }
}

/** 铺好「社区 → 目录 → 文件 → 符号」四层，并按需走完下钻。 */
async function drillToSymbols(): Promise<void> {
  await toExplore()
  await click(cardByLabel('核心'))
  await click(cardByLabel('src/sub'))
  await click(cardByLabel('src/sub/a.ts'))
}

function relations(items: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { project: 'demo', node: 'n1', dir: 'in', total: items.length, limit: 200, items, ...extra }
}

describe('F8 主区两态：默认查询 / 初始引导 / 探索', () => {
  it('进页面即所见：默认落**查询**态，主区是初始引导（不是空白）', async () => {
    await render()
    expect(queryTab().getAttribute('aria-pressed')).toBe('true')
    expect(exploreTab().getAttribute('aria-pressed')).toBe('false')
    // 引导：标题 + 四模式与探索各一条
    expect(one('.graph-guide')).not.toBeNull()
    expect(container.textContent).toContain(t('graph.guide.title'))
    expect(one('.graph-guide')!.querySelectorAll('.graph-guide-list > li')).toHaveLength(5)
    // 探索态的内容不在
    expect(one('.explore-wrap')).toBeNull()
  })

  it('「sel 深链」进来仍落查询态（`#/graph/<project>` 只带项目名，不表达视图）', async () => {
    await render()
    expect(queryTab().getAttribute('aria-pressed')).toBe('true')
    // 深链的项目名没有被改写成别的（页内回落 replace 只在未命中时发生）
    expect(one<HTMLSelectElement>('.pane select')!.value).toBe('demo')
  })

  it('切视图**不写 hash**（F9-5：`sel` 键语义不动、探索状态不进 hash）', async () => {
    await render()
    const before = window.location.hash
    await toExplore()
    expect(window.location.hash).toBe(before)
    await click(queryTab())
    expect(window.location.hash).toBe(before)
  })

  it('发出查询 → 引导让位给结果面板；切到探索再切回来，结果还在（不重取数）', async () => {
    payloads['/api/graph/relations'] = ok(relations([{ other: 'pkg/a.ts#caller', other_label: 'caller', kind: 'calls', file: 'src/a.ts', line: '52' }]))
    await render()
    await fill(nodeInput(), 'alpha')
    await click(buttonByText(t('graph.query'), one<HTMLElement>('.graph-query-card')!))

    expect(one('.graph-guide')).toBeNull()
    expect(one('.query-panel')).not.toBeNull()
    expect(all('.query-result .graph-rel-row')).toHaveLength(1)

    await toExplore()
    expect(one('.query-panel')).toBeNull()
    await click(queryTab())
    expect(one('.query-panel')).not.toBeNull()
    // 结果面板的取数是查询态自己的事，切视图不该重发
    expect(requests.filter((u) => u.pathname === '/api/graph/relations')).toHaveLength(1)
  })

  it('查询在途时主区是骨架而非引导（引导是「还没问」；重问时再摆一遍像什么都没发生）', async () => {
    await render()
    const settle = hold('/api/graph/relations')
    await fill(nodeInput(), 'alpha')
    await click(buttonByText(t('graph.query'), one<HTMLElement>('.graph-query-card')!))

    expect(one('.graph-guide')).toBeNull()
    expect(one('.graph-loading .skeleton')).not.toBeNull()

    await act(async () => {
      settle(ok(relations([])))
    })
    await act(async () => {})
    expect(one('.skeleton')).toBeNull()
    expect(one('.query-panel')).not.toBeNull()
  })

  it('studio iframe 已移除；「打开全图」是外链（新标签 + noopener）', async () => {
    await render()
    expect(one('iframe')).toBeNull()

    const link = one<HTMLAnchorElement>('a.btn-link')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe('/studio/demo/graph.html')
    expect(link!.getAttribute('target')).toBe('_blank')
    expect(link!.getAttribute('rel')).toContain('noopener')
  })
})

describe('F9ui 下钻请求序：按需 + 每层每 parent 一次 + 缓存复用', () => {
  beforeEach(() => {
    rollups['community|'] = ok(communityValue())
    rollups['dir|community:1'] = ok(dirValue())
    rollups['file|dir:src/sub'] = ok(fileValue())
    rollups['symbol|file:src/sub/a.ts'] = ok(symbolValue())
  })

  it('**按需**：没切到探索态就一笔 rollup 都不发', async () => {
    await render()
    expect(rollupRequests()).toHaveLength(0)
  })

  it('community → dir → file：每步恰好一笔，参数是合成 id', async () => {
    await render()
    await toExplore()

    expect(rollupRequests()).toHaveLength(1)
    const first = rollupRequests()[0]!
    expect(first.searchParams.get('level')).toBe('community')
    expect(first.searchParams.get('project')).toBe('demo')
    // community 层不接受 parent：参数里**没有**它
    expect(first.searchParams.has('parent')).toBe(false)
    expect(cardLabels()).toEqual(['核心', '工具'])

    await click(cardByLabel('核心'))
    expect(rollupRequests()).toHaveLength(2)
    expect(lastRollup('dir')!.searchParams.get('parent')).toBe('community:1')
    expect(cardLabels()).toEqual(['src/sub'])

    await click(cardByLabel('src/sub'))
    expect(rollupRequests()).toHaveLength(3)
    expect(lastRollup('file')!.searchParams.get('parent')).toBe('dir:src/sub')
    expect(cardLabels()).toEqual(['src/sub/a.ts'])
  })

  it('面包屑逐段长出来；回退点哪段回哪段，且**不发新请求**（缓存复用）', async () => {
    await render()
    await toExplore()
    expect(crumbs()).toEqual([t('graph.explore.root')])

    await click(cardByLabel('核心'))
    expect(crumbs()).toEqual([t('graph.explore.root'), '核心'])
    await click(cardByLabel('src/sub'))
    expect(crumbs()).toEqual([t('graph.explore.root'), '核心', 'src/sub'])

    // 末段是「当前」不是按钮
    expect(all('.crumb-back')).toHaveLength(2)
    expect(one('.crumb-here')!.getAttribute('aria-current')).toBe('page')

    await click(all('.crumb-back')[0]!) // 回根
    expect(crumbs()).toEqual([t('graph.explore.root')])
    expect(rollupRequests()).toHaveLength(3) // 回退不取数

    // 再进同一个社区：dir 层已在缓存里 → 仍然 3 笔
    await click(cardByLabel('核心'))
    expect(cardLabels()).toEqual(['src/sub'])
    expect(rollupRequests()).toHaveLength(3)
  })

  it('切到查询态再切回来：不重复请求（缓存活在页面层，不随视图销毁）', async () => {
    await render()
    await toExplore()
    await click(cardByLabel('核心'))
    expect(rollupRequests()).toHaveLength(2)

    await click(queryTab())
    expect(one('.explore-wrap')).toBeNull()
    await toExplore()
    expect(cardLabels()).toEqual(['src/sub'])
    expect(rollupRequests()).toHaveLength(2)
  })

  it('`dir` 层的 `community` 字段**不渲染**（它不是「目录属于社区」的归属声明）', async () => {
    await render()
    await toExplore()
    await click(cardByLabel('核心'))
    const card = cardByLabel('src/sub')
    expect(card.textContent).toContain('src/sub')
    expect(card.textContent).not.toContain('community')
    // 口径说明常驻（三层是独立投影，不是包含树）
    expect(container.textContent).toContain(t('graph.explore.note'))
  })

  it('跨组边强度挂在卡片上（出/入各写非零一侧，`←0` 这类噪音不写）', async () => {
    await render()
    await toExplore()
    // 夹具：community:1 → community:2 一条 calls 边
    expect(cardByLabel('核心').querySelector('.explore-weight')!.textContent).toBe('\u21921')
    expect(cardByLabel('工具').querySelector('.explore-weight')!.textContent).toBe('\u21901')
    // 没有边的层不出这一项（dir 夹具 edges 为空）
    await click(cardByLabel('核心'))
    expect(cardByLabel('src/sub').querySelector('.explore-weight')).toBeNull()
  })
})

describe('F9ui file 出口：查此节点 → 符号列表 → 发四模式查询', () => {
  beforeEach(() => {
    rollups['community|'] = ok(communityValue())
    rollups['dir|community:1'] = ok(dirValue())
    rollups['file|dir:src/sub'] = ok(fileValue())
    rollups['symbol|file:src/sub/a.ts'] = ok(symbolValue())
  })

  it('只有 file 卡片带「查此节点」；dir/community 卡片没有（合成 id 查询必 404）', async () => {
    await render()
    await toExplore()
    for (const card of cards()) expect(card.querySelector('.explore-open')).toBeNull()

    await click(cardByLabel('核心'))
    for (const card of cards()) expect(card.querySelector('.explore-open')).toBeNull()

    await click(cardByLabel('src/sub'))
    expect(cardByLabel('src/sub/a.ts').querySelector('.explore-open')!.textContent).toBe(
      t('graph.explore.open'),
    )
  })

  it('点 file 卡片 → 一笔 symbol 请求（parent=file:<路径>）→ 只读符号列表（label + 真实 id）', async () => {
    await render()
    await drillToSymbols()

    const hit = lastRollup('symbol')!
    expect(hit.searchParams.get('parent')).toBe('file:src/sub/a.ts')
    expect(rollupRequests()).toHaveLength(4)

    const panel = one('.explore-symbols')!
    expect(panel.querySelector('.pane-head h3')!.textContent).toBe(
      t('graph.explore.symbolsTitle', { file: 'src/sub/a.ts' }),
    )
    const rows = all('.explore-symbol')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('alpha')
    expect(rows[0]!.textContent).toContain('pkg/a.ts#alpha') // 可寻址的是 id，必须看得见
    // 网格让位给符号列表
    expect(one('.explore-grid')).toBeNull()
  })

  it('「返回」回到文件网格，不重取数', async () => {
    await render()
    await drillToSymbols()
    await click(buttonByText(t('graph.explore.back'), one<HTMLElement>('.explore-symbols')!))

    expect(one('.explore-symbols')).toBeNull()
    expect(cardLabels()).toEqual(['src/sub/a.ts'])
    expect(rollupRequests()).toHaveLength(4)
  })

  it('点符号 → 切回**查询态**、以该 id 发 relations（查询框回填 label）', async () => {
    payloads['/api/graph/relations'] = ok(relations([]))
    await render()
    await drillToSymbols()
    await click(all('.explore-symbol')[1]!)

    expect(queryTab().getAttribute('aria-pressed')).toBe('true')
    expect(one('.explore-wrap')).toBeNull()
    const hit = requests.filter((u) => u.pathname === '/api/graph/relations').at(-1)!
    expect(hit.searchParams.get('node')).toBe('pkg/a.ts#beta') // 寻址一律 id
    expect(hit.searchParams.get('dir')).toBe('in')
    expect(nodeInput().value).toBe('beta') // 查询框联动为 label
    expect(one('.query-panel')).not.toBeNull()
  })

  it('先前停在「A→B 调用链」档时点符号：仍切到「谁调用它」并发查询（不被 mode 守卫挡掉）', async () => {
    payloads['/api/graph/relations'] = ok(relations([]))
    await render()
    // 先在查询态切到 path 档——`drill` 在那一刻是非 relations 模式，走它会直接 return
    await click(modeChip(t('graph.mode.path')))
    await drillToSymbols()
    await click(all('.explore-symbol')[0]!)

    const hits = requests.filter((u) => u.pathname === '/api/graph/relations')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.searchParams.get('node')).toBe('pkg/a.ts#alpha')
    expect(hits[0]!.searchParams.get('dir')).toBe('in')
    // 模式 chip 也跟着拨回「谁调用它」（否则结果与 chip 不一致）
    expect(modeChip(t('graph.mode.in')).getAttribute('aria-pressed')).toBe('true')
    expect(modeChip(t('graph.mode.path')).getAttribute('aria-pressed')).toBe('false')
    // path 的两个输入框已收起
    expect(all('.graph-query-card > .row > input')).toHaveLength(1)
  })
})

describe('F9ui 截断与分页', () => {
  it('`truncated` 如实告知「共多少 / 已加载多少」', async () => {
    rollups['community|'] = ok({
      level: 'community',
      parent: null,
      total: 503,
      truncated: true,
      nodes: [{ id: 'community:1', label: '核心', kind: 'community', symbol_count: 4 }],
      edges: [],
    })
    await render()
    await toExplore()
    const note = one('.explore-truncated')!
    expect(note.textContent).toBe(t('graph.explore.truncated', { total: 503, loaded: 1 }))
  })

  it('本地未翻完时「更多」只切本地（不发请求）', async () => {
    const nodes = Array.from({ length: 130 }, (_, i) => ({
      id: `community:${i}`,
      label: `C${i}`,
      kind: 'community',
      symbol_count: 130 - i,
    }))
    rollups['community|'] = ok({ level: 'community', parent: null, total: 130, truncated: false, nodes, edges: [] })
    await render()
    await toExplore()

    expect(cards()).toHaveLength(60)
    const more = one<HTMLButtonElement>('.explore-more button')!
    expect(more.textContent).toBe(t('graph.explore.more', { shown: 60, total: 130 }))

    await click(more)
    expect(cards()).toHaveLength(120)
    // 再点一次到全长，「更多」自己消失
    await click(one<HTMLButtonElement>('.explore-more button')!)
    expect(cards()).toHaveLength(130)
    expect(one('.explore-more')).toBeNull()
    // 全程只有最初那一笔 rollup——本地还有余量，不请求
    expect(rollupRequests()).toHaveLength(1)
  })

  it('v17 B-7 真分页：本地翻完 + `next_cursor` → 点「更多」用游标取次页并并进本层', async () => {
    const page1 = Array.from({ length: 60 }, (_, i) => ({
      id: `community:${i}`,
      label: `C${i}`,
      kind: 'community',
      symbol_count: 60 - i,
    }))
    const page2 = Array.from({ length: 10 }, (_, i) => ({
      id: `community:${60 + i}`,
      label: `C${60 + i}`,
      kind: 'community',
      symbol_count: 10 - i,
    }))
    rollups['community|'] = ok({
      level: 'community',
      parent: null,
      total: 70,
      truncated: true,
      nodes: page1,
      edges: [],
      next_cursor: 'cur-1',
    })
    rollups['cursor:cur-1'] = ok({
      level: 'community',
      parent: null,
      total: 70,
      truncated: true,
      nodes: page2,
      edges: [],
      // 耗尽：次页无 next_cursor
    })
    await render()
    await toExplore()

    // 第一页 60 条已铺满一屏，「更多」此时指向**服务端次页**
    await click(one<HTMLButtonElement>('.explore-more button')!)

    expect(cursorRequests()).toHaveLength(1)
    const sent = cursorRequests()[0]!
    expect(sent.searchParams.get('cursor')).toBe('cur-1')
    // 游标自包含：翻页请求**不带** level/parent
    expect(sent.searchParams.has('level')).toBe(false)
    expect(sent.searchParams.has('parent')).toBe(false)

    expect(cards()).toHaveLength(70)
    // 两页都取完 + 本地全显示 → 「更多」消失
    expect(one('.explore-more')).toBeNull()
  })

  it('v17 B-7 跨页边在次页补齐：次页带回「新节点 ↔ 已翻页节点」的边（卡片强度更新）', async () => {
    const page1 = Array.from({ length: 60 }, (_, i) => ({
      id: `community:${i}`,
      label: `C${i}`,
      kind: 'community',
      symbol_count: 60 - i,
    }))
    rollups['community|'] = ok({
      level: 'community',
      parent: null,
      total: 61,
      truncated: true,
      nodes: page1,
      edges: [],
      next_cursor: 'cur-1',
    })
    // 次页：新节点 community:60，边只含它与已翻页的 community:0 之间那条（首页因对端缺席看不到）
    rollups['cursor:cur-1'] = ok({
      level: 'community',
      parent: null,
      total: 61,
      truncated: true,
      nodes: [{ id: 'community:60', label: 'C60', kind: 'community', symbol_count: 1 }],
      edges: [{ from: 'community:0', to: 'community:60', weight: 3 }],
    })
    await render()
    await toExplore()

    // 首页：community:0 没有跨组边（对端在第 2 页）→ 无强度标记
    expect(cardByLabel('C0').querySelector('.explore-weight')).toBeNull()

    await click(one<HTMLButtonElement>('.explore-more button')!)
    expect(cards()).toHaveLength(61)
    // 次页补齐后，页 1 的卡片也拿到了跨页边（卡片数字是**边条数**：C0 出 1、C60 入 1）
    expect(cardByLabel('C0').querySelector('.explore-weight')!.textContent).toBe('\u21921')
    expect(cardByLabel('C60').querySelector('.explore-weight')!.textContent).toBe('\u21901')
  })

  it('v17 B-7 收 409 `stale_cursor` → 丢弃本层已取回的页、回第一页重查（不报错给用户）', async () => {
    const page1 = Array.from({ length: 60 }, (_, i) => ({
      id: `community:${i}`,
      label: `C${i}`,
      kind: 'community',
      symbol_count: 60 - i,
    }))
    const firstPageValue = {
      level: 'community',
      parent: null,
      total: 70,
      truncated: true,
      nodes: page1,
      edges: [],
      next_cursor: 'cur-1',
    }
    rollups['community|'] = ok(firstPageValue)
    rollups['cursor:cur-1'] = { ok: false, error: { code: 'stale_cursor', message: '图谱已重建，翻页游标失效：请回首页重新查询' } }

    await render()
    await toExplore()
    expect(layerRequests('community')).toHaveLength(1)

    await click(one<HTMLButtonElement>('.explore-more button')!)
    await act(async () => {})

    // 翻页失败没有把错误摆到界面上（那是 stale_cursor 的特殊处理）
    expect(one('.act-bar.err')).toBeNull()
    // 而是回第一页重查：community 层被请求了第二次
    expect(layerRequests('community')).toHaveLength(2)
    expect(cards()).toHaveLength(60)
    // 重查回来后（图已刷新，新页仍带游标）「更多」可再点
    expect(one('.explore-more button')).not.toBeNull()
  })

  it('未截断时不出截断说明（不与「一屏分页」混为一谈）', async () => {
    rollups['community|'] = ok(communityValue())
    await render()
    await toExplore()
    expect(one('.explore-truncated')).toBeNull()
    expect(one('.explore-more')).toBeNull()
  })
})

describe('F9ui 空态与错误态', () => {
  it('空层 → 明确的空态文案（不是空白，也不是错误）', async () => {
    rollups['community|'] = ok({ level: 'community', parent: null, total: 0, truncated: false, nodes: [], edges: [] })
    await render()
    await toExplore()
    expect(container.textContent).toContain(t('graph.explore.empty'))
    expect(one('.act-bar.err')).toBeNull()
    expect(cards()).toHaveLength(0)
  })

  it('404 not_found → `.act-bar.err` 显示 `code: message` 原文 + 重试；重试成功后出网格', async () => {
    rollups['community|'] = { ok: false, error: { code: 'not_found', message: 'no such project' } }
    await render()
    await toExplore()

    const bar = one('.act-bar.err')!
    expect(bar.textContent).toContain('not_found: no such project')
    expect(bar.textContent).toContain(t('common.retry'))
    expect(cards()).toHaveLength(0)

    // 重试：只重发**当前层**那一笔，成功后渲染
    rollups['community|'] = ok(communityValue())
    await click(buttonByText(t('common.retry'), bar))
    expect(rollupRequests()).toHaveLength(2)
    expect(cardLabels()).toEqual(['核心', '工具'])
    expect(one('.act-bar.err')).toBeNull()
  })

  it('切层后错误不跟着走（每层各自的错误位，按请求键比对）', async () => {
    rollups['community|'] = ok(communityValue())
    rollups['dir|community:1'] = { ok: false, error: { code: 'bad_request', message: 'bad parent' } }
    await render()
    await toExplore()
    await click(cardByLabel('核心'))

    expect(one('.act-bar.err')!.textContent).toContain('bad_request: bad parent')
    // 回退到根：那一层的错误不在这里显示
    await click(all('.crumb-back')[0]!)
    expect(container.textContent).not.toContain('bad_request: bad parent')
    expect(cardLabels()).toEqual(['核心', '工具'])
  })

  it('失败后再进同一层：重取成功时旧错误**让位**给结果（不出现「数据已到、界面还在报错」）', async () => {
    rollups['community|'] = ok(communityValue())
    rollups['dir|community:1'] = { ok: false, error: { code: 'not_found', message: 'flaky' } }
    await render()
    await toExplore()
    await click(cardByLabel('核心'))
    expect(one('.act-bar.err')).not.toBeNull()

    // 退出去再进来 = 自动重取（该层没进缓存）；这次服务端好了
    await click(all('.crumb-back')[0]!)
    rollups['dir|community:1'] = ok(dirValue())
    await click(cardByLabel('核心'))

    expect(one('.act-bar.err')).toBeNull()
    expect(cardLabels()).toEqual(['src/sub'])
  })
})
