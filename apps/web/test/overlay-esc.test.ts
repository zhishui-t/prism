// @vitest-environment happy-dom
/**
 * M1 + MINOR-10 的组件级回归：真实 `Drawer` 与 `ConfirmModal` **叠开**（复刻 `Roles.tsx`
 * 的姿态——详情抽屉上压删除确认模态）。
 *
 * 缺陷面（M1）：两处各自在 `window` 上判 `Escape`，一次 Esc 两层同关，用户被弹回列表
 * （检视探针实测：closeDrawer=1 且 cancelModal=1）。缺陷面（MINOR-10）：无焦点圈闭，
 * Tab 可逃逸浮层、关闭不还焦。
 *
 * 渲染路径沿用 `teams-page-drawer.test.ts` 确立的最小方式：happy-dom + 裸 `react-dom/client`
 * + `react.act`，不引 @testing-library；根 vitest 的 include 只收 `.test.ts`，故本文件不用 JSX。
 */
import { act, createElement, StrictMode, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmModal } from '../src/components/ConfirmModal.tsx'
import { Drawer } from '../src/components/ui.tsx'
import { setLang } from '../src/i18n.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let onCloseDrawer: ReturnType<typeof vi.fn>
let onCancelModal: ReturnType<typeof vi.fn>
let onConfirmModal: ReturnType<typeof vi.fn>

/**
 * 复刻 `Roles.tsx:231` 详情抽屉 + `:388` 删除确认的装配。两点刻意：
 * - 外层套 `StrictMode`（`main.tsx` 就是 `StrictMode`，双挂载下令牌必须幂等）；
 * - `onClose`/`onCancel` **每次渲染都是新箭头函数**（真实页面如此）——若注册 effect 不是
 *   挂载级，抽屉会因 `onClose` 换引用而「重新入栈」压到模态之上，「一次 Esc 只关模态」立刻变红。
 */
function Harness({ drawer, modal, busy }: { drawer: boolean; modal: boolean; busy: boolean }): ReactElement {
  return createElement(
    StrictMode,
    null,
    drawer
      ? createElement(Drawer, {
          title: '角色详情',
          onClose: () => onCloseDrawer(),
          // @types/react 18 的 createElement 重载要求 children 进 props（JSX 亦然）
          children: createElement('button', { type: 'button' }, '抽屉里的按钮'),
        })
      : null,
    modal
      ? createElement(ConfirmModal, {
          title: '删除角色',
          body: '确认删除该角色？',
          busy,
          onConfirm: () => onConfirmModal(),
          onCancel: () => onCancelModal(),
        })
      : null,
  )
}

let container: HTMLDivElement
let root: Root

async function render(state: { drawer?: boolean; modal?: boolean; busy?: boolean }): Promise<void> {
  const { drawer = true, modal = false, busy = false } = state
  await act(async () => {
    root.render(createElement(Harness, { drawer, modal, busy }))
  })
}

function el<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

/** 在 `window` 上派发键盘事件（两个浮层的监听都注册在 window 上，与真实按键同路）。 */
async function press(key: string, shift = false): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  setLang('zh')
  onCloseDrawer = vi.fn()
  onCancelModal = vi.fn()
  onConfirmModal = vi.fn()
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

describe('Drawer + ConfirmModal 叠开（M1：Esc 只关栈顶）', () => {
  it('只有一层时 Esc 照旧关抽屉（引入浮层栈后无回退）', async () => {
    await render({})

    await press('Escape')

    expect(onCloseDrawer).toHaveBeenCalledTimes(1)
  })

  it('模态叠在抽屉上：一次 Esc 只关模态，抽屉不动（主回归）', async () => {
    await render({ modal: true })
    expect(el('.drawer')).not.toBeNull()
    expect(el('.modal')).not.toBeNull()

    await press('Escape')

    expect(onCancelModal).toHaveBeenCalledTimes(1)
    expect(onCloseDrawer).not.toHaveBeenCalled()
  })

  it('模态收掉后再按 Esc 才关抽屉（栈顶回落）', async () => {
    await render({ modal: true })
    await press('Escape')
    await render({}) // 父级响应 onCancel，把模态摘掉

    await press('Escape')

    expect(onCancelModal).toHaveBeenCalledTimes(1)
    expect(onCloseDrawer).toHaveBeenCalledTimes(1)
  })

  it('模态取消钮不受栈影响（Esc 之外的出路仍通）', async () => {
    await render({ modal: true })

    await act(async () => {
      el('.modal-foot button.tool-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onCancelModal).toHaveBeenCalledTimes(1)
    expect(onCloseDrawer).not.toHaveBeenCalled()
  })
})

describe('焦点圈闭（MINOR-10）', () => {
  it('打开即把焦点移入浮层：抽屉落容器本身，模态落确认钮', async () => {
    await render({})
    expect(document.activeElement).toBe(el('.drawer'))

    await render({ modal: true })
    expect(document.activeElement).toBe(el('.modal .btn-danger'))
  })

  it('确认钮禁用（提交中）时焦点回落模态容器，不留在背后的抽屉里', async () => {
    await render({ modal: true, busy: true })

    expect(el<HTMLButtonElement>('.modal .btn-danger')?.disabled).toBe(true)
    expect(document.activeElement).toBe(el('.modal'))
  })

  it('Tab / Shift+Tab 在模态内首尾回绕，逃不出浮层', async () => {
    await render({ modal: true })
    const cancel = el('.modal-foot button.tool-btn')
    const confirm = el('.modal .btn-danger')
    expect(document.activeElement).toBe(confirm) // 模态内最后一个可聚焦元素

    await press('Tab')
    expect(document.activeElement).toBe(cancel) // 末位 → 首位

    await press('Tab', true)
    expect(document.activeElement).toBe(confirm) // 首位 → 末位
  })

  it('关闭逐层还焦：模态关 → 回抽屉；抽屉关 → 回打开前的元素', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    await render({ modal: true })
    await render({}) // 模态关
    expect(document.activeElement).toBe(el('.drawer'))

    await render({ drawer: false }) // 抽屉也关
    expect(document.activeElement).toBe(outside)

    outside.remove()
  })
})
