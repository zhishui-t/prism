// @vitest-environment happy-dom
/**
 * v10 F5 调用链图 + 时序图导出：**DOM / SVG 行为**回归（happy-dom + 裸 `react-dom/client`
 * + `react.act`；根 vitest.config.ts 的 include 只收 `.test.ts`，故不用 JSX）。
 *
 * 覆盖（brief「F5 主体」+「F5 导出时序图按钮」）：
 *  1. **三档形状**：relations → 中心-辐射（中心节点 + 环绕关系节点 + 方向边）；
 *     path → 纵向链（节点自上而下、段间箭头、链上节点不可点）；affected → 分组列表（不画 SVG）；
 *  2. **形状与数据的对账**：入图上限（只画前 N 个并说明）、链过长不画（不留半条链）、
 *     空/未找到沿用既有文案；
 *  3. **onNodePick 联动**：点图中关系节点（鼠标 / 键盘）→ 以 **id** 重查、label 回填查询框、
 *     模式与 dir 保持、关系白名单保持——即既有 `drill` 的全部联动；
 *  4. **导出时序图**：按需触发、点击后禁用至响应、POST 体带**节点 id**、成功新标签打开
 *     `preview`、两类 `bad_request` 边类抛错 + `project_root_missing` 映人话、其余错误原文透出、
 *     拿不到 id 时禁用并说明；
 *  5. 图与**既有精确行清单并存**（清单的类名与行数不变——`graph-query-dom.test.ts` 的
 *     既有断言面不动）。
 *
 * mock 口径与 `graph-query-dom.test.ts` 同源：stub 最外层 `globalThis.fetch`（让 `api.ts`
 * 与页面一起跑真代码，能验 URL / 方法 / 请求体），未铺桩的路径回可识别的错误信封。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setLang, t } from '../src/i18n.ts'
import { CodeGraphPage } from '../src/pages/CodeGraph.tsx'
import {
  CHAIN_NODE,
  EDGE_GAP,
  RADIAL_CENTER,
  RADIAL_MAX,
  RADIAL_PEER,
  chainY,
  radialPoint,
} from '../src/pages/graph-logic.ts'

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

interface Recorded {
  url: URL
  init: RequestInit | undefined
}

/** 每个用例铺的桩：路径 → 信封。projects/status 恒有（页面骨架要用）。 */
let payloads: Record<string, unknown> = {}
let requests: Recorded[] = []
/** `hold()` 挂起中的响应：settle 之前该路径的 fetch 一直悬着（验「禁用至响应」）。 */
let pending: Record<string, Promise<unknown>> = {}
/** `window.open` 收到的 URL（新标签打开的唯一出口）。 */
let opened: string[] = []
let container: HTMLDivElement
let root: Root

function ok(value: unknown): unknown {
  return { ok: true, value }
}

function fail(code: string, message: string): unknown {
  return { ok: false, error: { code, message } }
}

/** 把某路径的响应**挂起**，返回 `settle(envelope)`（一次性）。 */
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

beforeEach(() => {
  setLang('zh')
  payloads = {}
  requests = []
  pending = {}
  opened = []
  vi.stubGlobal('open', (...args: unknown[]) => {
    opened.push(String(args[0]))
    return null
  })
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push({ url, init })
    const held = pending[url.pathname]
    if (held !== undefined) return held
    if (url.pathname === '/api/graph/projects') return Promise.resolve({ json: async () => ok([PROJECT]) })
    if (url.pathname === '/api/graph/status') return Promise.resolve({ json: async () => ok(STATUS) })
    const hit = payloads[url.pathname]
    if (hit === undefined) {
      // 未铺桩 = 用例写漏：回一个可识别的错误信封（断言会因缺行/出错而红，不会静默通过）
      return Promise.resolve({ json: async () => fail('not_stubbed', url.pathname) })
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
  await act(async () => {})
  await act(async () => {})
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function buttonByText(label: string, scope: Element = container): HTMLButtonElement {
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

async function press(target: Element, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
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

function nodeInputs(): HTMLInputElement[] {
  return all('.graph-query-card > .row > input') as HTMLInputElement[]
}

function modeChip(label: string): HTMLButtonElement {
  return buttonByText(label, one<HTMLElement>('.graph-query-modes')!)
}

function submitQuery(): HTMLButtonElement {
  const hit = one<HTMLButtonElement>('.graph-query-card > .row > button')
  if (hit === null) throw new Error('查询卡里没有提交钮')
  return hit
}

/** 关系项（服务端 `GraphRelationItem`）。 */
function item(other: string, label: string, kind = 'calls', file = 'src/a.ts', line = '52') {
  return { other, other_label: label, kind, file, line }
}

function relations(items: ReturnType<typeof item>[], total = items.length, extra: Record<string, unknown> = {}) {
  return { project: 'demo', node: 'pkg/a.ts#alpha', dir: 'in', total, limit: 200, items, ...extra }
}

/** 走一遍「输入 → 查询」（默认 dir=in）。 */
async function query(node: string, pathname = '/api/graph/relations'): Promise<void> {
  await fill(nodeInputs()[0]!, node)
  await click(submitQuery())
  if (requests.filter((r) => r.url.pathname === pathname).length === 0) {
    throw new Error(`没有打到 ${pathname}`)
  }
}

function lastRequest(pathname: string): Recorded | undefined {
  return [...requests].reverse().find((r) => r.url.pathname === pathname)
}

/** 图容器（组件根，`data-shape` 是形状判据的唯一出口）。 */
function graph(): HTMLElement | null {
  return one<HTMLElement>('.chain-graph-wrap')
}

function shape(): string | null {
  return graph()?.getAttribute('data-shape') ?? null
}

function svg(): SVGSVGElement | null {
  return one<SVGSVGElement>('.chain-graph-wrap .chain-graph')
}

function nodeTexts(selector: string): string[] {
  return all(selector).map((n) => n.textContent ?? '')
}

describe('F5 三档形状：relations → 中心-辐射', () => {
  it('出 SVG、`data-shape=radial`；中心是命中节点 id、关系节点环绕可点', async () => {
    payloads['/api/graph/relations'] = ok(
      relations([item('n#a', 'alpha'), item('n#b', 'beta'), item('n#c', 'gamma')]),
    )
    await render()
    await query('alpha')

    expect(shape()).toBe('radial')
    const box = svg()
    expect(box).not.toBeNull()
    expect(box!.getAttribute('viewBox')).toBe('0 0 560 340')
    expect(box!.getAttribute('role')).toBe('img')
    // 中心：命中节点 id（服务端 `node` 字段），全文在 `<title>` 里
    expect(one('.chain-node.center text')?.textContent).toBe('pkg/a.ts#alpha')
    expect(one('.chain-node.center title')?.textContent).toBe(
      t('graph.viz.centerAria', { id: 'pkg/a.ts#alpha' }),
    )
    // 关系节点：三个都在，且**带 id 才可点** → role=button + tabindex=0 + aria-label
    const picks = all('.chain-node.pick')
    expect(picks).toHaveLength(3)
    expect(nodeTexts('.chain-node.pick text')).toEqual(['alpha', 'beta', 'gamma'])
    const peers = [
      { label: 'alpha', id: 'n#a' },
      { label: 'beta', id: 'n#b' },
      { label: 'gamma', id: 'n#c' },
    ]
    picks.forEach((node, index) => {
      const { label, id } = peers[index]!
      expect(node.getAttribute('role')).toBe('button')
      expect(node.getAttribute('tabindex')).toBe('0')
      // aria-label = 「选择「X」作为新起点」+ 该行的 kind · file:line（读屏也拿得到定位）
      expect(node.getAttribute('aria-label')).toBe(
        `${t('graph.viz.pickAria', { name: label })} · calls · src/a.ts:52`,
      )
      // 框里标签会被截断，故全文（标签 · id · kind · file:line）留在 `<title>`
      expect(node.querySelector('title')?.textContent).toBe(`${label} · ${id} · calls · src/a.ts:52`)
    })
    // 边随方向：默认「谁调用它」= in（对端 → 本节点）
    const edges = all('.chain-edge')
    expect(edges).toHaveLength(3)
    for (const edge of edges) {
      expect(edge.getAttribute('class')).toContain('in')
      expect(edge.getAttribute('marker-end')).toBe('url(#chain-arrow-in)')
    }
    // 端点退到节点框外：第一个关系节点在正上方，故该边是竖线，两端各让出「半框 + 缝」
    // （不让的话 `marker-end` 的箭头会被后画的节点框整根盖住——本批实现时实际踩到）
    const first = edges[0]!
    expect([first.getAttribute('x1'), first.getAttribute('x2')]).toEqual([
      String(RADIAL_CENTER.x),
      String(RADIAL_CENTER.x),
    ])
    expect(Number(first.getAttribute('y1'))).toBe(
      radialPoint(0, 3).y + RADIAL_PEER.h / 2 + EDGE_GAP,
    )
    expect(Number(first.getAttribute('y2'))).toBe(
      RADIAL_CENTER.y - RADIAL_CENTER.h / 2 - EDGE_GAP,
    )
    // 图例：中心 + 当前方向各一条
    const legend = one('.chain-legend')
    expect(legend?.textContent).toContain(t('graph.viz.center'))
    expect(legend?.textContent).toContain(t('graph.mode.in'))
  })

  it('切「它调用谁」→ 图不变形、边的方向类换一档（out）', async () => {
    payloads['/api/graph/relations'] = ok({
      project: 'demo',
      node: 'pkg/a.ts#alpha',
      dir: 'out',
      total: 1,
      limit: 200,
      items: [item('n#d', 'delta')],
    })
    await render()
    await click(modeChip(t('graph.mode.out')))
    await query('alpha')

    expect(shape()).toBe('radial')
    const edge = all('.chain-edge')[0]!
    expect(edge.getAttribute('class')).toContain('out')
    expect(edge.getAttribute('marker-end')).toBe('url(#chain-arrow-out)')
    // 「框也跟着换方向」：out 时**从中心画到对端**——起点退中心框、终点退对端框
    // （只换点不换框会把退让量算错：本批实现时踩到过一次）
    expect(Number(edge.getAttribute('y1'))).toBe(RADIAL_CENTER.y - RADIAL_CENTER.h / 2 - EDGE_GAP)
    expect(Number(edge.getAttribute('y2'))).toBe(radialPoint(0, 1).y + RADIAL_PEER.h / 2 + EDGE_GAP)
    expect(one('.chain-legend')?.textContent).toContain(t('graph.mode.out'))
  })

  it(`关系数超过上限（${RADIAL_MAX}）→ 图上只画前 ${RADIAL_MAX} 个，并把「只画前 N 个」写在图下`, async () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`n#${i}`, `peer${i}`))
    payloads['/api/graph/relations'] = ok(relations(items, 12))
    await render()
    await query('alpha')

    expect(all('.chain-node.pick')).toHaveLength(RADIAL_MAX)
    expect(container.textContent).toContain(t('graph.viz.more', { shown: RADIAL_MAX, total: 12 }))
    // 精确行清单**不截断**（图答形状、清单答到底有哪些）——12 行都在
    expect(all('.query-result .graph-rel-row')).toHaveLength(12)
  })

  it('多义（candidates）→ 不出图（那时还没有「命中的节点」），候选清单照旧', async () => {
    payloads['/api/graph/relations'] = ok({
      project: 'demo',
      node: 'dup',
      dir: 'in',
      total: 0,
      limit: 200,
      items: [],
      candidates: [{ id: 'a#dup', label: 'dup' }],
    })
    await render()
    await query('dup')

    expect(shape()).toBe('radial')
    // 容器在（`data-shape` 有语义），但里面没有 SVG（没中心可画）
    expect(svg()).toBeNull()
    expect(one('.graph-cand-list')).not.toBeNull()
  })

  it('没有关系节点 → 不出 SVG（空态文案由既有清单承担，不重复）', async () => {
    payloads['/api/graph/relations'] = ok(relations([]))
    await render()
    await query('alpha')

    expect(svg()).toBeNull()
    expect(container.textContent).toContain(t('graph.rel.empty'))
  })
})

describe('F5 三档形状：path → 纵向链', () => {
  async function runPath(chain: string[], found = true, hops: number | null = 2): Promise<void> {
    payloads['/api/graph/path'] = ok({ project: 'demo', raw: '', hops, chain, found })
    await render()
    await click(modeChip(t('graph.mode.path')))
    const inputs = nodeInputs()
    await fill(inputs[0]!, 'a')
    await fill(inputs[1]!, 'b')
    await click(submitQuery())
  }

  it('节点自上而下、段间画箭头；`data-shape=chain`，且链上节点**不可点**', async () => {
    await runPath(['a', 'mid', 'b'])

    expect(shape()).toBe('chain')
    const box = svg()!
    expect(box.getAttribute('role')).toBe('img')
    expect(box.getAttribute('aria-label')).toBe(t('graph.viz.chainAria', { n: 3 }))
    expect(nodeTexts('.chain-node text')).toEqual(['a', 'mid', 'b'])
    // 段数 = 节点数 − 1，且都朝下；端点退到节点框外（箭头不被框盖）
    const edges = all('.chain-edge')
    expect(edges).toHaveLength(2)
    for (const edge of edges) {
      expect(edge.getAttribute('class')).toContain('down')
      expect(edge.getAttribute('marker-end')).toBe('url(#chain-arrow-down)')
    }
    expect(edges[0]!.getAttribute('x1')).toBe(edges[0]!.getAttribute('x2'))
    expect(Number(edges[0]!.getAttribute('y1'))).toBe(chainY(0) + CHAIN_NODE.h / 2 + EDGE_GAP)
    expect(Number(edges[0]!.getAttribute('y2'))).toBe(chainY(1) - CHAIN_NODE.h / 2 - EDGE_GAP)
    expect(Number(edges[0]!.getAttribute('y2'))).toBeGreaterThan(Number(edges[0]!.getAttribute('y1')))
    // y 递增 = 自上而下
    const ys = all('.chain-node rect').map((r) => Number(r.getAttribute('y')))
    expect(ys).toEqual([...ys].sort((x, y) => x - y))
    expect(new Set(ys).size).toBe(3)
    // 链上节点没有 id → 不可点（不假装能跳）
    expect(all('[data-shape="chain"] [role="button"]')).toHaveLength(0)
    // 既有链文本仍在（精确呈现）
    expect(one('.graph-chain')?.textContent).toContain('mid')
  })

  it('链超过上限 → 整图不画（截断的链看起来就是终点，是假信息），完整链文本仍在', async () => {
    const chain = Array.from({ length: 13 }, (_, i) => `hop${i}`)
    await runPath(chain)

    expect(shape()).toBe('chain')
    expect(svg()).toBeNull()
    expect(one('.graph-chain')?.textContent).toContain('hop12')
    expect(container.textContent).not.toContain(t('graph.viz.more', { shown: 12, total: 13 }))
  })

  it('没找到路径 / 找到了但切不出节点 → 都不画图，沿用既有两种文案', async () => {
    await runPath([], false, null)
    expect(svg()).toBeNull()
    expect(container.textContent).toContain(t('graph.path.none'))

    await runPath([], true, 1)
    expect(svg()).toBeNull()
    expect(container.textContent).toContain(t('graph.path.unparsed'))
  })
})

describe('F5 三档形状：affected → 分组列表（不硬画成图）', () => {
  function affected(nodes: Array<{ label: string; relation: string; location: string | null }>) {
    return { project: 'demo', raw: '', depth: 2, nodes }
  }

  async function runAffected(payload: unknown): Promise<void> {
    payloads['/api/graph/affected'] = ok(payload)
    await render()
    await click(modeChip(t('graph.mode.affected')))
    await query('alpha', '/api/graph/affected')
  }

  it('按 relation 分组：组头带计数、组内行沿用既有类名与列（label / tag / location）', async () => {
    await runAffected(
      affected([
        { label: 'v1', relation: 'calls', location: 'src/a.ts:1' },
        { label: 'v2', relation: 'imports', location: null },
        { label: 'v3', relation: 'calls', location: 'src/c.ts:3' },
      ]),
    )

    expect(shape()).toBe('groups')
    expect(svg()).toBeNull() // 这一档的「图」就是列表本身
    const groups = all('.chain-group')
    expect(groups).toHaveLength(2)
    expect(groups[0]!.querySelector('.count-label')?.textContent).toBe('calls')
    expect(groups[0]!.querySelector('.count-num')?.textContent).toBe('2')
    expect(groups[1]!.querySelector('.count-label')?.textContent).toBe('imports')
    expect(groups[1]!.querySelector('.count-num')?.textContent).toBe('1')

    const rows = all('.chain-group .graph-rel-row')
    expect(rows).toHaveLength(3)
    // 组内保序：calls 组 = [v1, v3]，imports 组 = [v2]（组序 = 首次出现顺序）
    expect(rows.map((r) => r.querySelector('.graph-rel-peer')?.textContent)).toEqual(['v1', 'v3', 'v2'])
    expect(rows[0]!.querySelector('.tag')?.textContent).toBe('calls')
    expect(rows[0]!.querySelector('.graph-rel-loc')?.textContent).toBe('src/a.ts:1')
    // location 缺的那行不显示定位段（不编 `null`）
    expect(rows[2]!.querySelector('.graph-rel-loc')).toBeNull()
  })

  it('关系为空串 → 归「其他关系」组（不静默丢行）', async () => {
    await runAffected(affected([{ label: 'v1', relation: '', location: null }]))
    expect(one('.chain-group .count-label')?.textContent).toBe(t('graph.affected.other'))
    expect(all('.chain-group .graph-rel-row')).toHaveLength(1)
  })

  it('空结果 → 既有空态文案，不渲染分组', async () => {
    await runAffected(affected([]))
    expect(all('.chain-group')).toHaveLength(0)
    expect(container.textContent).toContain(t('graph.affected.none'))
  })
})

describe('F5 onNodePick 联动（点图 = 以 id 追问）', () => {
  it('点图中关系节点 → 以该 id 重查、label 回填查询框、模式与关系白名单保持', async () => {
    payloads['/api/graph/relations'] = ok(relations([item('pkg/a.ts#beta', 'beta')]))
    await render()
    await query('alpha')
    expect(requests.filter((r) => r.url.pathname === '/api/graph/relations')).toHaveLength(1)

    await click(all('.chain-node.pick')[0]!)

    const hits = requests.filter((r) => r.url.pathname === '/api/graph/relations')
    expect(hits).toHaveLength(2)
    const qs = hits[1]!.url.searchParams
    expect(qs.get('node')).toBe('pkg/a.ts#beta') // 寻址一律 id
    expect(qs.get('dir')).toBe('in') // dir 保持
    expect(qs.get('relation')).toBe('calls,invokes') // 关系白名单保持
    expect(nodeInputs()[0]!.value).toBe('beta') // 查询框联动为 label
  })

  it('键盘 Enter / 空格同样触发（节点可聚焦）', async () => {
    payloads['/api/graph/relations'] = ok(relations([item('n#a', 'alpha'), item('n#b', 'beta')]))
    await render()
    await query('alpha')

    await press(all('.chain-node.pick')[1]!, 'Enter')
    expect(lastRequest('/api/graph/relations')!.url.searchParams.get('node')).toBe('n#b')

    await press(all('.chain-node.pick')[1]!, ' ')
    expect(requests.filter((r) => r.url.pathname === '/api/graph/relations')).toHaveLength(3)
    expect(nodeInputs()[0]!.value).toBe('beta')
  })

  it('中心节点不可点（它就是当前节点，点它等于原地重查）', async () => {
    payloads['/api/graph/relations'] = ok(relations([item('n#a', 'alpha')]))
    await render()
    await query('alpha')

    const center = one('.chain-node.center')!
    expect(center.getAttribute('role')).toBeNull()
    expect(center.getAttribute('tabindex')).toBeNull()
    await click(center)
    expect(requests.filter((r) => r.url.pathname === '/api/graph/relations')).toHaveLength(1)
  })

  it('affected 的行不可点（响应只有 label，没有 id，不假装能跳）', async () => {
    payloads['/api/graph/affected'] = ok({
      project: 'demo',
      raw: '',
      depth: 1,
      nodes: [{ label: 'victim', relation: 'calls', location: null }],
    })
    await render()
    await click(modeChip(t('graph.mode.affected')))
    await query('alpha', '/api/graph/affected')

    const row = one('.chain-group .graph-rel-row')!
    expect(row.querySelector('button')).toBeNull()
    expect(row.querySelector('[role="button"]')).toBeNull()
  })
})

describe('F5 导出时序图：按需触发 + 禁用至响应 + 新标签打开', () => {
  async function runRelations(): Promise<void> {
    payloads['/api/graph/relations'] = ok(relations([item('n#a', 'alpha')]))
    await render()
    await query('alpha')
  }

  function exportButton(): HTMLButtonElement {
    return buttonByText(t('graph.seq.action'))
  }

  it('点击 → POST 端点（体里是**节点 id**）→ 在途禁用并换文案 → 落地后新标签打开 preview', async () => {
    await runRelations()
    const settle = hold('/api/arch/render')

    expect(exportButton().disabled).toBe(false)
    await click(exportButton())

    const call = lastRequest('/api/arch/render')
    expect(call, '导出没有打到 /api/arch/render').toBeDefined()
    expect(call!.init?.method).toBe('POST')
    expect(JSON.parse(String(call!.init?.body))).toEqual({
      mode: 'from-graph',
      type: 'sequence',
      project: 'demo',
      node: 'pkg/a.ts#alpha',
    })

    // 禁用至响应：按钮换文案且不可再点
    expect(buttonByText(t('graph.seq.busy')).disabled).toBe(true)

    await act(async () => {
      settle(ok({ type: 'sequence', name: 'sequence-x.html', preview: '/api/arch/preview/sequence/sequence-x.html' }))
    })
    await act(async () => {})

    expect(opened).toEqual(['/api/arch/preview/sequence/sequence-x.html'])
    expect(exportButton().disabled).toBe(false)
    expect(one('.graph-seq-bar .act-bar.err')).toBeNull()
  })

  it('在途时再点不发第二笔（禁用只是视觉面，门在提交口）', async () => {
    await runRelations()
    const settle = hold('/api/arch/render')
    // 抓住同一个 DOM 节点：在途时它的文案会换成「导出中…」，按文案找第二次会找不到
    const button = exportButton()
    await click(button)
    await click(button)
    await click(button)

    expect(requests.filter((r) => r.url.pathname === '/api/arch/render')).toHaveLength(1)
    await act(async () => {
      settle(ok({ preview: '/api/arch/preview/sequence/only-once.html' }))
    })
    await act(async () => {})
    expect(opened).toEqual(['/api/arch/preview/sequence/only-once.html'])
  })

  it('按钮旁注明**口径与耗时**（产物语义 + archify 子进程秒级）', async () => {
    await runRelations()
    const note = one('.graph-seq-bar .small')?.textContent ?? ''
    expect(note).toContain(t('graph.seq.note'))
    expect(note).toContain('archify')
  })

  it('path / affected 结果：没有可寻址 id → 按钮禁用，并在 `title` 里说明原因', async () => {
    payloads['/api/graph/path'] = ok({ project: 'demo', raw: '', hops: 1, chain: ['a', 'b'], found: true })
    await render()
    await click(modeChip(t('graph.mode.path')))
    const inputs = nodeInputs()
    await fill(inputs[0]!, 'a')
    await fill(inputs[1]!, 'b')
    await click(submitQuery())

    const button = exportButton()
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe(t('graph.seq.noId'))

    payloads['/api/graph/affected'] = ok({
      project: 'demo',
      raw: '',
      depth: 1,
      nodes: [{ label: 'victim', relation: 'calls', location: null }],
    })
    await click(modeChip(t('graph.mode.affected')))
    await query('alpha', '/api/graph/affected')
    expect(exportButton().disabled).toBe(true)
    expect(lastRequest('/api/arch/render')).toBeUndefined()
  })

  it('多义结果同样禁用（`node` 是查询原串，不是命中节点的 id）', async () => {
    payloads['/api/graph/relations'] = ok({
      project: 'demo',
      node: 'dup',
      dir: 'in',
      total: 0,
      limit: 200,
      items: [],
      candidates: [{ id: 'a#dup', label: 'dup' }],
    })
    await render()
    await query('dup')

    expect(exportButton().disabled).toBe(true)
    expect(exportButton().getAttribute('title')).toBe(t('graph.seq.noId'))
  })

  it('失败「指定根文件无跨文件调用边」（P2-2 后真实双判别词全文）→ 人话文案、不打开新标签、按钮可再试', async () => {
    await runRelations()
    payloads['/api/arch/render'] = fail(
      'bad_request',
      // 后端实况（arch.ts from-graph catch）：graph-ir 原文 + 追加提示，两个判别词
      // （「根文件」「calls 边」）都在——分派靠「根文件」先判取胜（MINOR-1 同步）。
      '指定的根文件没有跨文件调用边: packages/agents/src/arch/graph-ir.ts；该文件在调用图里没有跨文件 calls 边，请换一个起点符号',
    )

    await click(exportButton())

    const bar = one('.graph-seq-bar .act-bar.err')
    expect(bar?.getAttribute('role')).toBe('alert')
    expect(bar?.textContent).toBe(t('graph.seq.noRootEdge'))
    expect(opened).toEqual([])
    expect(exportButton().disabled).toBe(false)
  })

  it('失败「图谱无跨文件 calls 边」→ 另一条人话文案（两条映射各自可达）', async () => {
    await runRelations()
    payloads['/api/arch/render'] = fail(
      'bad_request',
      // 后端 P2-2 改写后的实况文案（判别词「calls 边」不变，映射仍命中）
      '图谱没有跨文件 calls 边，无法派生时序图：本入口只从图谱的跨文件 calls 边派生调用链，请先 prism graph build 重建图，或换一个在调用图里有跨文件 calls 边的起点符号',
    )

    await click(exportButton())
    expect(one('.graph-seq-bar .act-bar.err')?.textContent).toBe(t('graph.seq.noCalls'))
  })

  it('失败 `project_root_missing`（项目根被删/被移）→ 独立文案，不落进 bad_request 那一族', async () => {
    await runRelations()
    payloads['/api/arch/render'] = fail(
      'project_root_missing',
      '项目根不存在: D:\\gone\\demo（项目 demo 已注册但目录已被删除或移动；Prism 不重建该目录）',
    )

    await click(exportButton())

    expect(one('.graph-seq-bar .act-bar.err')?.textContent).toBe(t('graph.seq.noProjectRoot'))
    expect(opened).toEqual([])
    expect(exportButton().disabled).toBe(false)
  })

  it('其余错误（陌生 bad_request / not_found / 网络）→ 原文透出，不吞错也不硬套文案', async () => {
    await runRelations()
    payloads['/api/arch/render'] = fail('bad_request', '缺少 node 参数')
    await click(exportButton())
    expect(one('.graph-seq-bar .act-bar.err')?.textContent).toBe(
      t('graph.seq.failed', { msg: 'bad_request: 缺少 node 参数' }),
    )

    payloads['/api/arch/render'] = fail('not_found', '未注册的图谱项目: nope（首次建图请同时传 root 项目根绝对路径）')
    await click(exportButton())
    expect(one('.graph-seq-bar .act-bar.err')?.textContent).toBe(
      t('graph.seq.failed', { msg: 'not_found: 未注册的图谱项目: nope（首次建图请同时传 root 项目根绝对路径）' }),
    )
  })

  it('重查后错误清掉（上一条的报错不留在新结果下面）', async () => {
    await runRelations()
    payloads['/api/arch/render'] = fail(
      'bad_request',
      '指定的根文件没有跨文件调用边: a.ts；该文件在调用图里没有跨文件 calls 边，请换一个起点符号',
    )
    await click(exportButton())
    expect(one('.graph-seq-bar .act-bar.err')).not.toBeNull()

    await query('alpha')
    expect(one('.graph-seq-bar .act-bar.err')).toBeNull()
  })
})
