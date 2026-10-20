// @vitest-environment happy-dom
/**
 * v20 剪贴板复制回执：成功 / 失败 / 连续复制重置计时。
 *
 * 复制是 4 个入口共用的动作（CopyButton / CopyCommand / 顶栏复制链接），
 * 这里的计时行为必须只有一个实现（`components/useClipboard.ts`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useClipboard } from '../src/components/useClipboard.ts'

function Probe() {
  const { copied, copy } = useClipboard(100)
  return createElement('button', { onClick: () => copy('hello') }, copied ? 'copied' : 'idle')
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function render(): Promise<HTMLButtonElement> {
  await act(async () => {
    root.render(createElement(Probe))
  })
  const btn = container.querySelector('button')
  if (btn === null) throw new Error('探针按钮不存在')
  return btn
}

async function click(btn: HTMLButtonElement): Promise<void> {
  await act(async () => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('useClipboard', () => {
  it('复制成功后显示回执，计时结束复位', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const btn = await render()
    await click(btn)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(btn.textContent).toBe('copied')

    await act(async () => {
      vi.advanceTimersByTime(101)
    })
    expect(btn.textContent).toBe('idle')
  })

  it('连续复制重置计时（不是从第一次起算）', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const btn = await render()
    await click(btn)
    await act(async () => {
      vi.advanceTimersByTime(70)
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(70)
    })
    expect(btn.textContent).toBe('copied')

    await act(async () => {
      vi.advanceTimersByTime(40)
    })
    expect(btn.textContent).toBe('idle')
  })

  it('剪贴板拒绝时静默失败（无回执、不抛错）', async () => {
    const writeText = vi.fn(() => Promise.reject(new Error('denied')))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const btn = await render()
    await click(btn)
    expect(btn.textContent).toBe('idle')
  })

  it('剪贴板不可用时静默失败（不把 undefined 当 Promise 用）', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const btn = await render()
    await click(btn)
    expect(btn.textContent).toBe('idle')
  })
})
