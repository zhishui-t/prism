// @vitest-environment happy-dom
/**
 * v12 F1 **缩放平移**的 DOM / SVG 交互回归（单开一个文件，与 `graph-call-chain-dom.test.ts`
 * 分工：那个锁「形状与数据对账」，本文件只锁缩放层——SPEC-1.2–1.8）。
 *
 * 覆盖：
 *  1. **滚轮缩放**（SPEC-1.2）：一格 1.1×、指针锚、clamp 0.3–3，且 `preventDefault()` 真的生效
 *     （组件用**原生** `addEventListener(..., { passive: false })`——React 合成 `onWheel` 是
 *     passive 的，在里面 preventDefault 无效，这条断言就是那道闸）；
 *  2. **拖拽平移**（SPEC-1.3）：按下-移动-抬起，图随指针走；从可点节点上起手不算拖拽；
 *  3. **工具条**（SPEC-1.4/1.5）：放大 / 缩小 / 适应窗口 / 百分比只读、± 可聚焦；
 *  4. **形态边界**（SPEC-1.7）：`affected` 分组列表**不出现**工具条、也不挂 wheel 监听；
 *  5. **第二行标注**（SPEC-1.8）：倍率 ≥ 1.5 追加 `id · file:line`、不截断；没有定位数据不编造；
 *  6. **reduced-motion**（SPEC-1.6）：系统要求减少动态时功能不受限（过渡那一侧由
 *     `styles-call-chain-graph.test.ts` 的 CSS 断言锁）。
 *
 * 环境与 mock 口径同 `graph-call-chain-dom.test.ts`（happy-dom + 裸 `react-dom/client` + `react.act`，
 * 根 vitest.config.ts 只收 `.test.ts`，故不写 JSX；`fetch` 走最外层 stub，页面与 `api.ts` 跑真代码）。
 *
 * ⚠ **happy-dom 的三处适配**（都是「构造器不读 init」那一类，与既有 DragEvent 先例同源）：
 *  - `WheelEvent` 构造器**不读** `clientX/clientY` → 建完事件手工赋参（否则指针锚算出来永远是 0）；
 *  - `getBoundingClientRect()` 恒为 0 → 容器盒未测量 = 纯函数层的**单位映射兜底**（那条路径本身
 *    在 `graph-logic.test.ts` 里以显式尺寸直测；本文件验的是「组件接线对不对」）；
 *  - `<button>` 的 Enter / Space **不会**被合成成 click → 键盘可达性只断言「可聚焦 + 非 -1 的
 *    tabIndex」，触发路径按浏览器实际走的那条（click）验（否则就是拿 happy-dom 的缺口当真）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setLang, t } from '../src/i18n.ts'
import { CodeGraphPage } from '../src/pages/CodeGraph.tsx'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, transformAttr, userTransform } from '../src/pages/graph-logic.ts'

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

let payloads: Record<string, unknown> = {}
let container: HTMLDivElement
let root: Root

function ok(value: unknown): unknown {
  return { ok: true, value }
}

beforeEach(() => {
  setLang('zh')
  payloads = {}
  vi.stubGlobal('fetch', (input: unknown) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/graph/projects') return Promise.resolve({ json: async () => ok([PROJECT]) })
    if (url.pathname === '/api/graph/status') return Promise.resolve({ json: async () => ok(STATUS) })
    const hit = payloads[url.pathname]
    if (hit === undefined) {
      return Promise.resolve({ json: async () => ({ ok: false, error: { code: 'not_stubbed', message: url.pathname } }) })
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

/* ===== 查询流程（与 graph-call-chain-dom.test.ts 同源，只留本文件要用的三档） ===== */

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

function buttonByText(label: string): HTMLButtonElement {
  const hit = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
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

function nodeInputs(): HTMLInputElement[] {
  return all('.graph-query-card > .row > input') as HTMLInputElement[]
}

function modeChip(label: string): HTMLButtonElement {
  return buttonByText(label)
}

async function submitQuery(): Promise<HTMLButtonElement> {
  const hit = one<HTMLButtonElement>('.graph-query-card > .row > button')
  if (hit === null) throw new Error('查询卡里没有提交钮')
  return hit
}

function item(other: string, label: string, kind = 'calls', file = 'src/a.ts', line = '52') {
  return { other, other_label: label, kind, file, line }
}

/** 走一遍「输入 → 查询」（默认 relations）。 */
async function query(node: string): Promise<void> {
  await fill(nodeInputs()[0]!, node)
  await click(await submitQuery())
}

/** 切到 path 模式并查一条链。 */
async function runPath(chain: string[]): Promise<void> {
  payloads['/api/graph/path'] = ok({ project: 'demo', raw: '', hops: chain.length - 1, chain, found: true })
  await render()
  await click(modeChip(t('graph.mode.path')))
  const inputs = nodeInputs()
  await fill(inputs[0]!, 'a')
  await fill(inputs[1]!, 'b')
  await click(await submitQuery())
}

/* ===== 缩放层的读写口 ===== */

function svg(): SVGSVGElement {
  const hit = one<SVGSVGElement>('.chain-graph-wrap .chain-graph')
  if (hit === null) throw new Error('没有图')
  return hit
}

/** 内层 `<g>` 的 transform（缩放平移的**唯一**出口；viewBox 不动，SPEC-1.1）。 */
function layer(): string {
  const g = one<SVGGElement>('.chain-graph-wrap .chain-zoom-layer')
  if (g === null) throw new Error('没有缩放层')
  return g.getAttribute('transform') ?? ''
}

function pct(): string {
  return one('.chain-zoom-pct')?.textContent ?? ''
}

/** 滚轮：happy-dom 的 `WheelEvent` 构造器不读 clientX/clientY → 建完手工赋参。 */
async function fireWheel(deltaY: number, at: { x: number; y: number } = { x: 0, y: 0 }, scope?: SVGSVGElement): Promise<WheelEvent> {
  const e = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true })
  Object.assign(e, { clientX: at.x, clientY: at.y })
  await act(async () => {
    ;(scope ?? svg()).dispatchEvent(e)
  })
  await act(async () => {})
  return e
}

/** 连滚 n 格（向上 = 放大）。 */
async function wheelUp(n: number, at = { x: 0, y: 0 }): Promise<void> {
  for (let i = 0; i < n; i++) await fireWheel(-100, at)
}

async function firePointer(type: string, at: { x: number; y: number }, target?: Element): Promise<void> {
  const e = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
    button: 0,
    pointerId: 1,
  })
  await act(async () => {
    ;(target ?? svg()).dispatchEvent(e)
  })
  await act(async () => {})
}

async function dragTo(from: { x: number; y: number }, to: { x: number; y: number }, handle?: Element): Promise<void> {
  await firePointer('pointerdown', from, handle)
  await firePointer('pointermove', to)
  await firePointer('pointerup', to)
}

/** relations 图（默认一个关系节点）铺桩 + 渲染 + 查询。 */
async function runRelations(items = [item('n#a', 'alpha')]): Promise<void> {
  payloads['/api/graph/relations'] = ok({ project: 'demo', node: 'pkg/a.ts#alpha', dir: 'in', total: items.length, limit: 200, items })
  await render()
  await query('alpha')
}

/* ===== 1. 滚轮缩放（SPEC-1.2） ===== */

describe('v12 F1 滚轮缩放（SPEC-1.2）', () => {
  it('一格 1.1×：向上放大、向下缩小；`preventDefault()` 生效（原生 passive:false ⇒ 页面不滚）', async () => {
    await runRelations()
    // 初始 = 适应窗口态：未测量（happy-dom）⇒ 单位映射，写进 `<g>` 的就是单位变换
    expect(pct()).toBe('100%')
    expect(layer()).toBe(transformAttr(userTransform({ scale: 1, tx: 0, ty: 0 }, { scale: 1, tx: 0, ty: 0 })))

    const up = await fireWheel(-100, { x: 0, y: 0 })
    expect(up.defaultPrevented).toBe(true) // ← 这条就是「原生 + { passive: false }」的验收
    expect(pct()).toBe('110%')
    expect(layer()).toBe('translate(0 0) scale(1.1)')

    await fireWheel(100, { x: 0, y: 0 })
    expect(pct()).toBe('100%') // ÷1.1 回到适应窗口
    await fireWheel(100, { x: 0, y: 0 })
    expect(pct()).toBe('91%') // 0.909 → 四舍五入
  })

  it('锚点 = 指针位置：指针底下的内容点就地放大（指针在 100px 处 ⇒ 平移量 = −10px）', async () => {
    await runRelations()
    await fireWheel(-100, { x: 100, y: 0 })
    // 内容点 u = (100 − 0)/1 = 100；放大 1.1 后仍钉在 100px：tx = 100 − 100×1.1 = −10
    expect(layer()).toBe('translate(-10 0) scale(1.1)')
    expect(pct()).toBe('110%')
  })

  it(`clamp ${ZOOM_MIN}–${ZOOM_MAX}：连滚不越界，且不产生非有限值`, async () => {
    await runRelations()
    await wheelUp(30, { x: 450, y: 300 })
    expect(pct()).toBe(`${ZOOM_MAX * 100}%`)
    await fireWheel(-100, { x: 450, y: 300 })
    expect(pct()).toBe(`${ZOOM_MAX * 100}%`) // 已在上限：再往上滚不动
    for (let i = 0; i < 40; i++) await fireWheel(100, { x: 450, y: 300 })
    expect(pct()).toBe(`${ZOOM_MIN * 100}%`)
    expect(layer()).not.toContain('NaN')
  })
})

/* ===== 2. 拖拽平移（SPEC-1.3） ===== */

describe('v12 F1 拖拽平移（SPEC-1.3）', () => {
  it('按下 → 移动 → 抬起：图随指针平移，抬起后不再跟手', async () => {
    await runRelations()
    await firePointer('pointerdown', { x: 10, y: 10 })
    await firePointer('pointermove', { x: 40, y: 25 })
    expect(layer()).toBe('translate(30 15) scale(1)') // 位移直接相加（1px 拖拽 = 图上 1px）
    expect(pct()).toBe('100%') // 平移不改倍率

    await firePointer('pointermove', { x: 60, y: 25 })
    expect(layer()).toBe('translate(50 15) scale(1)') // 跟手（增量式，不是从起点重算）

    await firePointer('pointerup', { x: 60, y: 25 })
    await firePointer('pointermove', { x: 200, y: 200 })
    expect(layer()).toBe('translate(50 15) scale(1)') // 抬起后不再动
    expect(svg().getAttribute('class')).not.toContain('dragging')
  })

  it('从可点节点上起手**不**平移：那是「以该 id 追问」的点击目标', async () => {
    await runRelations()
    const node = one('.chain-node.pick')!
    await firePointer('pointerdown', { x: 10, y: 10 }, node)
    await firePointer('pointermove', { x: 90, y: 90 })
    await firePointer('pointerup', { x: 90, y: 90 })
    expect(layer()).toBe('translate(0 0) scale(1)')
  })

  it('非主键（右键）按下不进入拖拽', async () => {
    await runRelations()
    const e = new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, button: 2, pointerId: 1 })
    await act(async () => {
      svg().dispatchEvent(e)
    })
    await firePointer('pointermove', { x: 50, y: 50 })
    expect(layer()).toBe('translate(0 0) scale(1)')
  })
})

/* ===== 3. 工具条（SPEC-1.4/1.5） ===== */

describe('v12 F1 工具条（SPEC-1.4/1.5）', () => {
  it('放大 / 缩小按钮：一格一步，与滚轮同一套换算', async () => {
    await runRelations()
    await click(buttonByText(t('graph.zoom.in')))
    expect(pct()).toBe('110%')
    await click(buttonByText(t('graph.zoom.in')))
    expect(pct()).toBe('121%')
    await click(buttonByText(t('graph.zoom.out')))
    expect(pct()).toBe('110%')
    expect(Number(ZOOM_STEP)).toBeGreaterThan(1)
  })

  it('「适应窗口」：缩放 + 平移一起复位到初始 fit 态（SPEC-1.4）', async () => {
    await runRelations()
    await wheelUp(3, { x: 200, y: 100 })
    await dragTo({ x: 10, y: 10 }, { x: 120, y: 60 })
    expect(pct()).toBe('133%')
    expect(layer()).not.toBe('translate(0 0) scale(1)')

    await click(buttonByText(t('graph.zoom.fit')))
    expect(pct()).toBe('100%')
    // 未测量 ⇒ fit = 单位映射 ⇒ `<g>` 也是单位变换（真机上这里就是「内容按 meet 铺满容器」）
    expect(layer()).toBe(transformAttr(userTransform({ scale: 1, tx: 0, ty: 0 }, { scale: 1, tx: 0, ty: 0 })))
  })

  it('± 按钮是原生 `<button>`：可聚焦、tabIndex 不是 -1；聚焦后激活即生效；百分比只读', async () => {
    await runRelations()
    const plus = buttonByText(t('graph.zoom.in'))
    expect(plus.tagName).toBe('BUTTON')
    expect(plus.getAttribute('type')).toBe('button')
    expect(plus.tabIndex).toBe(0)
    plus.focus()
    expect(document.activeElement).toBe(plus)

    /* ⚠ happy-dom **不会**把聚焦按钮上的 Enter / Space 合成为 click（探测过：keydown 派发
       后 click 计数为 0）——那是环境的缺口，不是实现的可达性。故这里按浏览器实际走的那条
       路径验：焦点已在按钮上 → 激活它（浏览器里 Enter / Space 合成的就是这个 click）。 */
    await act(async () => {
      plus.click()
    })
    await act(async () => {})
    expect(pct()).toBe('110%')

    await click(buttonByText(t('graph.zoom.out')))
    expect(pct()).toBe('100%')

    const readout = one<HTMLElement>('.chain-zoom-pct')!
    expect(readout.tagName).toBe('SPAN')
    expect(readout.querySelector('button, input, select, textarea')).toBeNull()
    expect(readout.textContent).toBe('100%')
    expect(readout.getAttribute('title')).toBe(t('graph.zoom.current', { pct: 100 }))

    const bar = one<HTMLElement>('.chain-zoom')!
    expect(bar.getAttribute('role')).toBe('group')
    expect(bar.getAttribute('aria-label')).toBe(t('graph.zoom.label'))
  })
})

/* ===== 4. 形态边界（SPEC-1.7） ===== */

describe('v12 F1 形态边界：affected 不启用缩放（SPEC-1.7）', () => {
  it('分组列表形态：没有工具条、没有缩放层，也不挂 wheel 监听（事件不被拦）', async () => {
    payloads['/api/graph/affected'] = ok({
      project: 'demo',
      raw: '',
      depth: 2,
      nodes: [{ label: 'v1', relation: 'calls', location: 'src/a.ts:1' }],
    })
    await render()
    await click(modeChip(t('graph.mode.affected')))
    await query('alpha')

    expect(all('.chain-group')).toHaveLength(1)
    expect(one('.chain-zoom')).toBeNull()
    expect(one('.chain-graph')).toBeNull()
    expect(one('.chain-zoom-layer')).toBeNull()

    const wrap = one('.chain-graph-wrap')!
    const e = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true })
    await act(async () => {
      wrap.dispatchEvent(e)
    })
    expect(e.defaultPrevented).toBe(false) // 没监听 ⇒ 不 preventDefault（页面照常滚）
  })
})

/* ===== 5. 第二行标注（SPEC-1.8） ===== */

describe('v12 F1 第二行标注（SPEC-1.8 / R-1 闭合点）', () => {
  const LONG = 'packages/agents/src/arch/graph-ir.ts'

  it('低倍率（< 1.5）：节点只有一行，全文仍在 `<title>` 里（现状不变）', async () => {
    await runRelations([item('n#a', 'alpha', 'calls', LONG, '715')])
    expect(all('.chain-node.pick text')).toHaveLength(1)
    expect(all('.chain-node.pick text tspan')).toHaveLength(0)
    expect(one('.chain-node.pick title')?.textContent).toBe(`alpha · n#a · calls · ${LONG}:715`)
  })

  it('倍率 ≥ 1.5：`<text>` 追加第二行 `id · file:line`，**不截断**（长路径原样）', async () => {
    await runRelations([item('n#a', 'alpha', 'calls', LONG, '715')])
    await wheelUp(4, { x: 0, y: 0 }) // 1.1⁴ ≈ 1.464（还不到）
    expect(pct()).toBe('146%')
    expect(all('.chain-node.pick text tspan')).toHaveLength(0)

    await wheelUp(1, { x: 0, y: 0 }) // 1.1⁵ ≈ 1.61 ≥ 1.5
    expect(pct()).toBe('161%')
    const tspans = all('.chain-node.pick text tspan')
    expect(tspans).toHaveLength(1)
    expect(tspans[0]!.textContent).toBe(`n#a · ${LONG}:715`)
    expect(tspans[0]!.textContent).not.toContain('…')
    // 第一行仍是**截断**的标签（框里放不下长标签），全文在 `<title>` —— 两行分工不变
    expect(one('.chain-node.pick title')?.textContent).toBe(`alpha · n#a · calls · ${LONG}:715`)
  })

  it('缩回低倍率：第二行随缩放**隐去**（不是一次性画上就留着）', async () => {
    await runRelations([item('n#a', 'alpha')])
    await wheelUp(5, { x: 0, y: 0 })
    expect(all('.chain-node.pick text tspan')).toHaveLength(1)
    for (let i = 0; i < 3; i++) await fireWheel(100, { x: 0, y: 0 })
    expect(pct()).toBe('121%')
    expect(all('.chain-node.pick text tspan')).toHaveLength(0)
  })

  it('中心节点不画第二行：响应里只有它的 id，没有 file/line（不编造）', async () => {
    await runRelations()
    await wheelUp(5, { x: 0, y: 0 })
    expect(all('.chain-node.center text tspan')).toHaveLength(0)
    expect(one('.chain-node.center text')?.textContent).toBe('pkg/a.ts#alpha')
  })

  it('path 链放大后仍无第二行：`chain` 只有符号名（无 id / 无定位）', async () => {
    await runPath(['a', 'mid', 'b'])
    await wheelUp(5, { x: 0, y: 0 })
    expect(svg()).not.toBeNull()
    expect(all('.chain-node text')).toHaveLength(3)
    expect(all('.chain-node text tspan')).toHaveLength(0)
  })
})

/* ===== 6. reduced-motion（SPEC-1.6） ===== */

describe('v12 F1 reduced-motion（SPEC-1.6）', () => {
  it('系统要求减少动态时：缩放 / 平移功能不受限，且组件不写 inline 过渡', async () => {
    // 模拟 `prefers-reduced-motion: reduce`：组件**不读**它（动画一律走 CSS，由全局归零块收口），
    // 故这里能验的是「功能不因它改变」——「平移瞬移（无过渡）」由样式表断言锁（styles-*.test.ts）
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }))

    await runRelations([item('n#a', 'alpha')])
    await fireWheel(-100, { x: 0, y: 0 })
    expect(pct()).toBe('110%')
    await dragTo({ x: 0, y: 0 }, { x: 20, y: 10 })
    expect(layer()).toBe('translate(20 10) scale(1.1)')

    // 过渡/动画一律在 styles.css（`.chain-zoom-layer` 与 `.chain-graph` 都不声明），组件不写 inline
    expect(one('.chain-zoom-layer')?.getAttribute('style')).toBeNull()
    expect(svg().getAttribute('style')).toBeNull()
  })
})
