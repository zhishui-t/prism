/**
 * 浮层栈纯逻辑回归（M1 的判定核心）。
 *
 * 缺陷面：`Drawer` 与 `ConfirmModal` 各自在 `window` 上挂 Esc，无层级概念——叠开时
 * 一次 Esc 两层同关（`Roles.tsx` 详情抽屉上压删除确认，探针实测 closeDrawer=1 且 cancelModal=1）。
 * 这里只锁「谁在栈顶 / 谁摘掉自己」这套判定；组件级行为（按两次 Esc）见 `overlay-esc.test.ts`。
 *
 * 令牌是模块级栈，用例之间必须清零：统一用 `open()` 记账，`afterEach` 全部 release
 * （断言中途失败也不给后续用例留脏栈）。
 */
import { afterEach, describe, expect, it } from 'vitest'

import { acquireOverlay, type OverlayToken } from '../src/components/overlay-stack.ts'

let held: OverlayToken[] = []

/** 入栈并记账，返回令牌（=组件挂载时 `useOverlayLayer` 的行为）。 */
function open(): OverlayToken {
  const token = acquireOverlay()
  held.push(token)
  return token
}

afterEach(() => {
  for (const token of held) token.release()
  held = []
})

describe('acquireOverlay：Esc 只认栈顶（M1）', () => {
  it('单层：入栈即为栈顶，release 后不再是', () => {
    const drawer = open()
    expect(drawer.isTop()).toBe(true)
    drawer.release()
    expect(drawer.isTop()).toBe(false)
  })

  it('叠开两层：只有栈顶为真（模态压住抽屉 → 抽屉对 Esc 失效）', () => {
    const drawer = open()
    const modal = open()
    expect(drawer.isTop()).toBe(false)
    expect(modal.isTop()).toBe(true)
  })

  it('release 栈顶后次层变顶（模态关 → 再按 Esc 才关抽屉）', () => {
    const drawer = open()
    const modal = open()
    modal.release()
    expect(modal.isTop()).toBe(false)
    expect(drawer.isTop()).toBe(true)
  })

  it('release 中层：顶层仍顶，底层仍不顶（摘自己不影响邻居）', () => {
    const bottom = open()
    const middle = open()
    const top = open()
    middle.release()
    expect(top.isTop()).toBe(true)
    expect(bottom.isTop()).toBe(false)
  })

  it('重复 release 幂等，且不会连带摘掉别人（StrictMode 双挂载 / 迟到 cleanup）', () => {
    const drawer = open()
    const modal = open()
    modal.release()
    modal.release()
    modal.release()
    expect(drawer.isTop()).toBe(true)
    drawer.release()
    expect(drawer.isTop()).toBe(false)
  })

  it('StrictMode 双挂载（acquire→release→acquire）后仅剩一份自己，且仍是栈顶', () => {
    const drawer = open()
    const first = open()
    first.release() // StrictMode：effect cleanup
    const second = open() // 同一个模态再挂一次
    expect(second.isTop()).toBe(true)
    expect(drawer.isTop()).toBe(false)
    second.release()
    expect(drawer.isTop()).toBe(true)
  })
})
