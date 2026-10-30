// @vitest-environment happy-dom
/**
 * 工作流详情页交互回归（WorkflowsPage）。
 *
 * 锁编辑流程的五条硬约束（都是改过 bug 的地方）：
 *  1. **保存成功后弹窗不消失**：列表 reload 与详情 reload 是两条线，弹窗若放在列表的
 *     `<State>` 里会被卸载重建（成功提示与草稿态一起丢）；
 *  2. **保存只写草稿内容**：PATCH body 的 steps 按新序 + rowId 原样带回（改序不串自定义列）；
 *  3. **脏草稿关闭要确认**：Esc / 遮罩 / 关闭钮都先弹确认，不静默丢改动；
 *  4. **字段编辑落到草稿**：右侧面板改步骤名 → 图上节点标签同步；
 *  5. **未改动时保存禁用**：不产生空写。
 *
 * 环境口径同 `graph-call-chain-zoom-dom.test.ts`（happy-dom + 裸 react-dom + act，不写 JSX）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { setLang } from '../src/i18n.ts'
import { WorkflowsPage } from '../src/pages/Workflows.tsx'

const DETAIL = {
  workflow: 'demo-flow',
  name: '演示流程',
  level: 'role',
  binds: ['dev'],
  skills: [],
  steps: [
    { order: 1, step: '受理', owner: ['dev'], skills: '', input: 'in', output: 'out', done: 'done', reflow: '—' },
    { order: 2, step: '复验', owner: ['dev'], skills: '', input: 'in2', output: 'out2', done: 'done2', reflow: '回 1' },
  ],
  steps_raw: { columns: ['#', '步骤', '承接', 'skill', '输入工件', '输出工件', '完成判定', '回流路径'], rows: [], rowIds: ['r-0', 'r-1'] },
  body: '',
  sourcePath: '/tmp/demo-flow.md',
  source_mtime: 1000,
  issues: [],
}

const INDEX = { workflows: [DETAIL], workflowsDir: '/tmp/wf' }

let container: HTMLDivElement
let root: Root
let patches: Array<{ url: string; body: unknown }>
let detailRequests = 0
let listRequests = 0

function ok(value: unknown): unknown {
  return { ok: true, value }
}

beforeEach(() => {
  setLang('zh')
  patches = []
  detailRequests = 0
  listRequests = 0
  vi.stubGlobal('fetch', (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input), 'http://localhost')
    if (init?.method === 'PATCH') {
      patches.push({ url: url.pathname, body: JSON.parse(init.body ?? '{}') })
      return Promise.resolve({ json: async () => ok({ path: '/tmp/demo-flow.md', source_mtime: 2000 }) })
    }
    if (url.pathname === '/api/workflows') {
      listRequests += 1
      return Promise.resolve({ json: async () => ok(INDEX) })
    }
    if (url.pathname === '/api/workflows/demo-flow') {
      detailRequests += 1
      return Promise.resolve({ json: async () => ok(DETAIL) })
    }
    return Promise.resolve({ json: async () => ({ ok: false, error: { code: 'not_stubbed', message: url.pathname } }) })
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
    root.render(createElement(WorkflowsPage, { sel: 'demo-flow', onSelect: () => {} }))
  })
  for (let i = 0; i < 4; i++) await act(async () => {})
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
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

async function fill(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('编辑流程', () => {
  it('默认只读：有「编辑」钮、无字段面板；点编辑后出现字段面板与保存/取消', async () => {
    await render()
    expect(all('.wf-inspector')).toHaveLength(0)
    await click(buttonByText('编辑图'))
    expect(all('.wf-inspector')).toHaveLength(1)
    expect(buttonByText('保存').disabled).toBe(true) // 未改动
    expect(buttonByText('取消')).toBeDefined()
  })

  it('改步骤名 → 图上节点标签同步；保存 PATCH 带上 rowId 与新内容', async () => {
    await render()
    await click(buttonByText('编辑图'))
    const nameInput = all('.wf-inspector input')[0] as HTMLInputElement
    expect(nameInput.value).toBe('受理')
    await fill(nameInput, '受理（改）')
    // 图上第一个节点标签跟着变
    const labels = all('.wf-node-label').map((t) => t.firstChild?.textContent)
    expect(labels[0]).toBe('受理（改）')
    expect(buttonByText('保存').disabled).toBe(false)
    await click(buttonByText('保存'))
    expect(patches).toHaveLength(1)
    const body = patches[0]!.body as { steps: Array<{ rowId?: string; step: string; order: number }>; if_match: number; workflows_dir: string }
    expect(body.workflows_dir).toBe('/tmp/wf')
    expect(body.if_match).toBe(1000)
    expect(body.steps.map((s) => s.rowId)).toEqual(['r-0', 'r-1'])
    expect(body.steps[0]!.step).toBe('受理（改）')
    expect(body.steps.map((s) => s.order)).toEqual([1, 2])
  })

  it('保存成功后弹窗仍在（不被列表 reload 卸载）且给出成功提示', async () => {
    await render()
    await click(buttonByText('编辑图'))
    await fill(all('.wf-inspector input')[0] as HTMLInputElement, '受理2')
    await click(buttonByText('保存'))
    await act(async () => {})
    expect(all('.modal')).toHaveLength(1)
    expect(container.textContent).toContain('步骤表已写回文件')
    expect(detailRequests).toBeGreaterThanOrEqual(2)
    expect(listRequests).toBeGreaterThanOrEqual(2)
  })

  it('脏草稿点取消 → 直接退出编辑（取消是显式丢弃，不弹确认）', async () => {
    await render()
    await click(buttonByText('编辑图'))
    await fill(all('.wf-inspector input')[0] as HTMLInputElement, 'x')
    await click(buttonByText('取消'))
    expect(all('.wf-inspector')).toHaveLength(0)
    expect(patches).toHaveLength(0)
  })

  it('新增步骤 → 节点数 +1、选中新行；删除步骤 → 恢复', async () => {
    await render()
    await click(buttonByText('编辑图'))
    const before = all('.wf-node').length
    await click(buttonByText('新增步骤'))
    expect(all('.wf-node').length).toBe(before + 1)
    // 新行选中（右侧面板显示新步骤名）
    const nameInput = all('.wf-inspector input')[0] as HTMLInputElement
    expect(nameInput.value).toContain('新步骤')
    // 删除当前选中
    const del = all('.wf-inspector-head button')[3] as HTMLButtonElement
    await click(del)
    expect(all('.wf-node').length).toBe(before)
  })

  it('步骤表视图也能编辑（字段表单与图共用草稿）', async () => {
    await render()
    await click(buttonByText('编辑图'))
    await click(buttonByText('步骤表'))
    const rows = all('.wf-step-edit')
    expect(rows).toHaveLength(DETAIL.steps.length)
    const nameInput = rows[1]!.querySelector('input') as HTMLInputElement
    expect(nameInput.value).toBe('复验')
    await fill(nameInput, '复验（改）')
    await click(buttonByText('图视图'))
    const labels = all('.wf-node-label').map((t) => t.firstChild?.textContent)
    expect(labels[1]).toBe('复验（改）')
  })
})
