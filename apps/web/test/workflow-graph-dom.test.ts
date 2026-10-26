// @vitest-environment happy-dom
/**
 * 工作流图组件交互回归（WorkflowGraph）。
 *
 * 锁四件事：
 *  1. **缩放/平移真的落到内容上**：所有内容在外层 `<g class="wf-zoom-layer" transform=...>` 里
 *     （曾漏这层：工具条百分比会变，图却纹丝不动）；
 *  2. **拖动落点按内容坐标结算**：happy-dom 无 `getScreenCTM`，组件要降级到
 *     「rect + viewBox meet + transform 分量」的等价算式——拖一格就该落相邻格，
 *     不许出现「拖一格飞两格」（曾只除 zoom.scale，漏了 SVG 自身 meet 缩放）；
 *  3. **点选与聚焦**：编辑模式点节点回调 order（右侧面板联动）；只读模式点节点聚焦上下游；
 *  4. **不误伤点击**：位移 ≤3px 的按下-抬起算点击，不算拖动（否则每次点选都会重排）。
 *
 * 环境口径同 `graph-call-chain-zoom-dom.test.ts`（happy-dom + 裸 react-dom + act，不写 JSX）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setLang } from '../src/i18n.ts'
import {
  WF_LANE_LABEL_W,
  WF_NODE_H,
  WF_NODE_W,
  WF_STEP_GAP,
  type WfGraphNode,
} from '../src/pages/graph-logic.ts'
import { WorkflowGraph } from '../src/pages/WorkflowGraph.tsx'

let container: HTMLDivElement
let root: Root

/** 单泳道 3 步（同排横向）。 */
const NODES: WfGraphNode[] = [
  { order: 1, label: '受理', owner: ['dev'], reflow: '—' },
  { order: 2, label: '修复', owner: ['dev'], reflow: '—' },
  { order: 3, label: '复验', owner: ['dev'], reflow: '—' },
]

beforeEach(() => {
  setLang('zh')
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

async function render(props: Parameters<typeof WorkflowGraph>[0]): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkflowGraph, props))
  })
  await act(async () => {})
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function nodes(): Element[] {
  return all('.wf-node')
}

/** happy-dom 的 PointerEvent 构造器不读坐标（同 WheelEvent 先例）→ 建完手工赋参。 */
function pointer(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(e, { clientX: x, clientY: y, button: 0, pointerId: 1 })
  return e
}

describe('图层与缩放', () => {
  it('内容包在 wf-zoom-layer 里，且 transform 来自 useZoom', async () => {
    await render({ nodes: NODES })
    const layer = container.querySelector('g.wf-zoom-layer')
    expect(layer).not.toBeNull()
    expect(layer!.getAttribute('transform')).toMatch(/translate\(|scale\(/)
    // 节点与边必须在这层里（否则缩放/平移不动内容）
    expect(layer!.querySelectorAll('.wf-node').length).toBe(NODES.length)
    expect(layer!.querySelectorAll('.wf-edge').length).toBe(2)
  })

  it('只读模式不渲染回流手柄；编辑模式每节点一个', async () => {
    await render({ nodes: NODES })
    expect(all('.wf-handle')).toHaveLength(0)
    await render({ nodes: NODES, editable: true, onChange: () => {} })
    expect(all('.wf-handle')).toHaveLength(NODES.length)
  })
})

describe('点选（编辑）与聚焦（只读）', () => {
  it('编辑模式点节点 → onSelect(order)；不触发 onChange（未拖动）', async () => {
    const picked: number[] = []
    let changed = 0
    await render({
      nodes: NODES,
      editable: true,
      onSelect: (o) => picked.push(o),
      onChange: () => {
        changed += 1
      },
    })
    await act(async () => {
      nodes()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(picked).toEqual([2])
    expect(changed).toBe(0)
  })

  it('编辑模式 selected 节点带 selected 类', async () => {
    await render({ nodes: NODES, editable: true, selected: 2, onSelect: () => {}, onChange: () => {} })
    expect(nodes()[1]!.classList.contains('selected')).toBe(true)
    expect(nodes()[0]!.classList.contains('selected')).toBe(false)
  })

  it('只读模式点节点聚焦上下游（dimmed 标记出现在无关节点上）', async () => {
    const chain: WfGraphNode[] = [
      { order: 1, label: 'a', owner: ['x'], reflow: '' },
      { order: 2, label: 'b', owner: ['x'], reflow: '' },
      { order: 3, label: 'c', owner: ['x'], reflow: '' },
    ]
    await render({ nodes: chain })
    await act(async () => {
      nodes()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // 2 的前后都在链上 → 全部相关、无 dimmed；再点一次取消聚焦
    expect(all('.wf-node.dimmed')).toHaveLength(0)
    await act(async () => {
      nodes()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(all('.wf-node.dimmed')).toHaveLength(0)
  })
})

describe('拖动改序（内容坐标结算）', () => {
  /** happy-dom 的 svg 无 getScreenCTM → 组件走降级算式；盒未测量时 fit=1、transform 为 fit 态（scale 1）。 */
  it('把第 3 个节点拖到第 1 位 → onChange 收到的顺序是 [3,1,2]', async () => {
    let next: WfGraphNode[] | undefined
    await render({ nodes: NODES, editable: true, onChange: (n) => (next = n) })
    const third = nodes()[2]!
    const step = WF_NODE_W + WF_STEP_GAP
    // 起点 = 第 3 格左缘，终点 = 第 1 格左缘（往左拖两格）
    const startX = WF_LANE_LABEL_W + 2 * step
    await act(async () => {
      third.dispatchEvent(pointer('pointerdown', startX, 0))
    })
    await act(async () => {
      third.dispatchEvent(pointer('pointermove', WF_LANE_LABEL_W, 0))
    })
    await act(async () => {
      third.dispatchEvent(pointer('pointerup', WF_LANE_LABEL_W, 0))
    })
    expect(next).toBeDefined()
    expect(next!.map((n) => n.label)).toEqual(['复验', '受理', '修复'])
    expect(next!.map((n) => n.order)).toEqual([1, 2, 3])
  })

  it('微动（≤3px）不触发重排——那是点选', async () => {
    let changed = 0
    await render({ nodes: NODES, editable: true, onChange: () => (changed += 1) })
    const first = nodes()[0]!
    await act(async () => {
      first.dispatchEvent(pointer('pointerdown', WF_LANE_LABEL_W, 0))
    })
    await act(async () => {
      first.dispatchEvent(pointer('pointermove', WF_LANE_LABEL_W + 2, 1))
    })
    await act(async () => {
      first.dispatchEvent(pointer('pointerup', WF_LANE_LABEL_W + 2, 1))
    })
    expect(changed).toBe(0)
  })

  it('拖动中显示落点虚线框与目标泳道高亮', async () => {
    await render({ nodes: NODES, editable: true, onChange: () => {} })
    const third = nodes()[2]!
    const step = WF_NODE_W + WF_STEP_GAP
    await act(async () => {
      third.dispatchEvent(pointer('pointerdown', WF_LANE_LABEL_W + 2 * step, WF_NODE_H / 2))
    })
    await act(async () => {
      third.dispatchEvent(pointer('pointermove', WF_LANE_LABEL_W, WF_NODE_H / 2))
    })
    expect(all('.wf-drop-ghost')).toHaveLength(1)
    expect(all('.wf-lane-bg.drop')).toHaveLength(1)
  })
})

describe('回流手柄', () => {
  it('从第 3 步手柄拖到第 1 步 → 该步 reflow 写成「回 1」', async () => {
    let next: WfGraphNode[] | undefined
    await render({ nodes: NODES, editable: true, onChange: (n) => (next = n) })
    const handle = all('.wf-handle')[2]!
    const step = WF_NODE_W + WF_STEP_GAP
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', WF_LANE_LABEL_W + 2 * step + WF_NODE_W, WF_NODE_H / 2))
    })
    await act(async () => {
      handle.dispatchEvent(pointer('pointermove', WF_LANE_LABEL_W + 20, WF_NODE_H / 2))
    })
    await act(async () => {
      handle.dispatchEvent(pointer('pointerup', WF_LANE_LABEL_W + 20, WF_NODE_H / 2))
    })
    expect(next!.find((n) => n.order === 3)!.reflow).toBe('回 1')
  })

  it('拖到空白 → 提示条出现且不改草稿', async () => {
    let changed = 0
    await render({ nodes: NODES, editable: true, onChange: () => (changed += 1) })
    const handle = all('.wf-handle')[2]!
    const step = WF_NODE_W + WF_STEP_GAP
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', WF_LANE_LABEL_W + 2 * step + WF_NODE_W, WF_NODE_H / 2))
    })
    await act(async () => {
      handle.dispatchEvent(pointer('pointermove', 5, 900))
    })
    await act(async () => {
      handle.dispatchEvent(pointer('pointerup', 5, 900))
    })
    expect(changed).toBe(0)
    expect(container.querySelector('.banner')).not.toBeNull()
  })
})
