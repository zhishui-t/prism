// @vitest-environment happy-dom
/**
 * v10 派修 P1-1：滚动锁**多层叠开**的组合语义（`overlay-stack.ts` 的 `useScrollLock`）。
 *
 * 缺陷面（code-review-v10 §1 P1-1）：旧实现每层挂载时**各快照一次** inline `overflow`、
 * 卸载时**无条件回写**自己的快照。React 18.3 删除期 effect 清理顺序是**先挂的先清**，
 * 于是两类坏态：
 *  1. 同 commit 全卸（`Modal` + `ConfirmModal` 一起消失，F1/F2 常规路径）——外层先把
 *     `''` 写回，内层随后把自己挂载时看到的 `'hidden'` 写回 ⇒ `body`/`.page` **停在
 *     `hidden`**，整站不可滚只能刷新；
 *  2. 先卸外层（内层还在）——外层无条件回写 `''` ⇒ 锁**静默丢失**，浮层底下的列表又能滚。
 *
 * 这里用与 `Roles.tsx` 同形态的**兄弟结构**（`Modal` 外层 + `ConfirmModal` 内层，均由同一
 * 状态控制、可分 commit 增删）锁住两条坏态，并首次给 `style.overflow` 加断言
 * （此前 apps/web/test 对它的断言为 0 条）。
 *
 * 渲染路径与 `roles-detail-modal.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`（根 vitest 只收 `.test.ts`，故不用 JSX）。
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConfirmModal } from '../src/components/ConfirmModal.tsx'
import { Modal } from '../src/components/ui.tsx'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => {}

let container: HTMLDivElement
let root: Root

/** 页面区（v7 之后**滚动容器是 `.page`**，`body` 不再滚 —— 两处都要锁）。 */
function pageEl(): HTMLElement {
  return document.querySelector<HTMLElement>('.page')!
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.body.style.overflow = ''
  const page = document.createElement('div')
  page.className = 'page'
  container = document.createElement('div')
  document.body.append(page, container)
  root = createRoot(container)
})

afterEach(() => {
  // 卸载所有还挂着的浮层：模块级锁计数归零，不给后续用例留脏锁
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

/**
 * 两层浮层的兄弟结构：`outer` = 详情 `Modal`，`inner` = 删除 `ConfirmModal`。
 * 每个用例**分开调**本函数即可只卸一层（React 同一 commit 只处理变化的子树）。
 */
function renderStack(layers: { outer: boolean; inner: boolean }): void {
  act(() => {
    root.render(
      createElement(
        Fragment,
        null,
        layers.outer ? createElement(Modal, { title: 'detail', onClose: noop }, 'body') : null,
        layers.inner
          ? createElement(ConfirmModal, { body: 'delete?', onConfirm: noop, onCancel: noop })
          : null,
      ),
    )
  })
}

describe('useScrollLock：单层', () => {
  it('挂载时锁 body 与 .page 的 inline overflow，卸载时逐字还原', () => {
    expect(document.body.style.overflow).toBe('')
    renderStack({ outer: true, inner: false })
    expect(document.body.style.overflow).toBe('hidden')
    expect(pageEl().style.overflow).toBe('hidden')

    renderStack({ outer: false, inner: false })
    expect(document.body.style.overflow).toBe('')
    expect(pageEl().style.overflow).toBe('')
  })

  it('挂载前的既有内联值被快照，关闭后原样还回（不吃掉别人的样式）', () => {
    document.body.style.overflow = 'auto'
    pageEl().style.overflow = 'auto'
    renderStack({ outer: true, inner: false })
    expect(document.body.style.overflow).toBe('hidden')

    renderStack({ outer: false, inner: false })
    expect(document.body.style.overflow).toBe('auto')
    expect(pageEl().style.overflow).toBe('auto')
  })
})

describe('useScrollLock：两层叠开（P1-1 的两条坏态）', () => {
  it('同 commit 全卸 → body 与 .page 都恢复（不再停在 hidden）', () => {
    renderStack({ outer: true, inner: true })
    expect(document.body.style.overflow).toBe('hidden')
    expect(pageEl().style.overflow).toBe('hidden')

    // 一个 commit 里两层一起消失（F1/F2 常规路径：关掉详情时确认模态随详情一起卸）
    renderStack({ outer: false, inner: false })
    expect(document.body.style.overflow).toBe('')
    expect(pageEl().style.overflow).toBe('')
  })

  it('先卸内层 → 外层的锁仍在（底下列表不能滚）', () => {
    renderStack({ outer: true, inner: true })
    renderStack({ outer: true, inner: false })
    expect(document.body.style.overflow).toBe('hidden')
    expect(pageEl().style.overflow).toBe('hidden')

    // 再卸外层才解锁
    renderStack({ outer: false, inner: false })
    expect(document.body.style.overflow).toBe('')
    expect(pageEl().style.overflow).toBe('')
  })

  it('先卸外层 → 内层的锁仍在（锁不静默丢失）', () => {
    renderStack({ outer: true, inner: true })
    renderStack({ outer: false, inner: true })
    expect(document.body.style.overflow).toBe('hidden')
    expect(pageEl().style.overflow).toBe('hidden')

    renderStack({ outer: false, inner: false })
    expect(document.body.style.overflow).toBe('')
    expect(pageEl().style.overflow).toBe('')
  })

  it('叠开时快照只取一次：全卸后回到**第一层打开前**的值，不回到中间态的 hidden', () => {
    document.body.style.overflow = 'auto'
    renderStack({ outer: true, inner: false })
    renderStack({ outer: true, inner: true })
    renderStack({ outer: false, inner: false })
    expect(document.body.style.overflow).toBe('auto')
  })
})
