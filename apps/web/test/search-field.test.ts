// @vitest-environment happy-dom
/**
 * v19 搜索 / 过滤输入：清空按钮、`/` 快捷键提示、Escape 清空、`data-search-input` 接线。
 *
 * 四处页面共用这一个零件；这里锁交互，不重复测每页的本地过滤逻辑。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { SearchField } from '../src/components/SearchField.tsx'
import { setLang } from '../src/i18n.ts'

let container: HTMLDivElement
let root: Root

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

async function render(props: Parameters<typeof SearchField>[0]): Promise<void> {
  await act(async () => {
    root.render(createElement(SearchField, props))
  })
}

function input(): HTMLInputElement {
  const hit = container.querySelector<HTMLInputElement>('input')
  if (hit === null) throw new Error('未找到输入框')
  return hit
}

describe('v19 搜索框：清空 / 快捷键提示 / Escape', () => {
  it('有值时出现清空按钮，点击后回调空串并触发 onClear', async () => {
    const onChange = vi.fn()
    const onClear = vi.fn()
    await render({ value: 'abc', onChange, onClear, placeholder: '筛选' })

    const clear = container.querySelector<HTMLButtonElement>('.search-clear')
    expect(clear).not.toBeNull()
    expect(clear?.getAttribute('aria-label')).toBe('清空')
    expect(container.querySelector('.search-kbd')).toBeNull()

    await act(async () => {
      clear?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('')
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('空值时显示 `/` 快捷键提示，清空按钮不出现', async () => {
    await render({ value: '', onChange: () => {}, placeholder: '筛选' })
    expect(container.querySelector('.search-kbd')?.textContent).toBe('/')
    expect(container.querySelector('.search-clear')).toBeNull()
  })

  it('Escape 清空、触发 onClear 并失焦（不把「清空」做成只改显示）', async () => {
    const onChange = vi.fn()
    const onClear = vi.fn()
    await render({ value: 'abc', onChange, onClear, placeholder: '筛选' })

    const el = input()
    el.focus()
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('')
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(el)
  })

  it('保留调用方给的 className（既有 `.role-filter` 宽度口径不被破坏）', async () => {
    await render({ value: '', onChange: () => {}, placeholder: '筛选' })
    expect(input().classList.contains('role-filter')).toBe(true)
  })

  it('输入框带 `data-search-input`，供 Shell 的全局 `/` 快捷键定位', async () => {
    await render({ value: '', onChange: () => {}, placeholder: '筛选' })
    expect(input().hasAttribute('data-search-input')).toBe(true)
  })

  it('Enter 透传给调用方（知识库用它升级全文检索）', async () => {
    const onKeyDown = vi.fn()
    await render({ value: '架构', onChange: () => {}, placeholder: '检索', onKeyDown })
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })
})
