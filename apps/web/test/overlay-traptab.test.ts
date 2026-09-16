// @vitest-environment happy-dom
/**
 * trapTab 的「容器自身持焦」分支回归（复检 MINOR-③）。
 *
 * 缺陷面：`useOverlayLayer` 在优先元素不可聚焦时把焦点落到容器本身（`tabIndex={-1}`），
 * 而 `container.contains(container)` 为真——旧代码把「容器自身持焦」当成 inside，
 * Tab 的默认行为把焦点送进 DOM 序里容器之后的元素，圈闭第一次 Tab 就漏。
 *
 * happy-dom 无法复现「真实焦点落在 tabindex=-1 容器上」的完整行为，故本文件不走
 * 真实 focus 链路：用可配置的 `document.activeElement` 影子属性精确摆出被测焦点态，
 * `preventDefault` / `focus` 用 spy 断言——被测对象是 `trapTab` 的**判定**，不是 DOM 焦点机制。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { trapTab } from '../src/components/overlay-stack.ts'

/** 造一个只带 trapTab 所需字段的伪事件（判定只读 key/shiftKey、调 preventDefault）。 */
function tabEvent(shift = false): KeyboardEvent {
  return { key: 'Tab', shiftKey: shift, preventDefault: vi.fn() } as unknown as KeyboardEvent
}

/** 影子 `document.activeElement`（own property 盖住原型 getter），`restore` 删影子还原。 */
function setActive(el: Element | null): void {
  Object.defineProperty(document, 'activeElement', { value: el, configurable: true })
}
function restoreActive(): void {
  delete (document as unknown as Record<string, unknown>).activeElement
}

let container: HTMLElement
let first: HTMLButtonElement
let last: HTMLButtonElement

beforeEach(() => {
  container = document.createElement('div')
  container.setAttribute('tabindex', '-1')
  first = document.createElement('button')
  last = document.createElement('button')
  container.append(first, last)
  document.body.appendChild(container)
})

afterEach(() => {
  restoreActive()
  container.remove()
})

describe('trapTab · 容器自身持焦的圈闭（复检 MINOR-③）', () => {
  it('容器自身持焦 + Tab → preventDefault 且落 first（旧代码：两者都不做，焦点逃逸）', () => {
    setActive(container)
    const firstFocus = vi.spyOn(first, 'focus')
    const ev = tabEvent(false)

    trapTab(ev, container)

    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
    expect(firstFocus).toHaveBeenCalledTimes(1)
  })

  it('容器自身持焦 + Shift+Tab → 落 last（反向圈闭同样接管）', () => {
    setActive(container)
    const lastFocus = vi.spyOn(last, 'focus')
    const ev = tabEvent(true)

    trapTab(ev, container)

    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
    expect(lastFocus).toHaveBeenCalledTimes(1)
  })

  it('焦点在首元素（真在内）+ Tab → 不拦截：中间元素走浏览器默认序（防过度接管）', () => {
    setActive(first)
    const ev = tabEvent(false)

    trapTab(ev, container)

    expect(ev.preventDefault).not.toHaveBeenCalled()
  })

  it('焦点在末元素 + Tab → 回绕到 first（既有圈闭不回归）', () => {
    setActive(last)
    const firstFocus = vi.spyOn(first, 'focus')
    const ev = tabEvent(false)

    trapTab(ev, container)

    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
    expect(firstFocus).toHaveBeenCalledTimes(1)
  })

  it('焦点已逃逸到容器外 → 拉回 first（「焦点不在内」分支不回归）', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    setActive(outside)
    const firstFocus = vi.spyOn(first, 'focus')
    const ev = tabEvent(false)

    trapTab(ev, container)

    expect(ev.preventDefault).toHaveBeenCalledTimes(1)
    expect(firstFocus).toHaveBeenCalledTimes(1)
    outside.remove()
  })
})
