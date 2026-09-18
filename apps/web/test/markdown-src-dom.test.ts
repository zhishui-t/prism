// @vitest-environment happy-dom
/**
 * W-1（SPEC-4.1）：`components/Markdown.tsx` **只消费**解析层给的源区间——有 `srcStart/srcEnd`
 * 的块级元素注入 `data-src-start` / `data-src-end`，缺省（手写 `Block`）一个都不注入。
 * 轻量 happy-dom 渲染（与 `knowledge-search-hit.test.ts` 同制，不引 @testing-library）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MarkdownBlocks } from '../src/components/Markdown.tsx'
import { parseMarkdown, type Block } from '../src/markdown.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function render(blocks: Block[]): void {
  act(() => {
    root.render(createElement(MarkdownBlocks, { blocks }))
  })
}

function one<T extends Element>(selector: string): T {
  const found = container.querySelector<T>(selector)
  if (found === null) throw new Error(`未找到 ${selector}`)
  return found
}

describe('MarkdownBlocks · W-1 data-src-* 注入', () => {
  const SRC = [
    '# 一',
    '',
    '段落',
    '',
    '```ts',
    'x',
    '```',
    '',
    '> 引文',
    '',
    '| a |',
    '| --- |',
    '| b |',
    '',
    '---',
  ].join('\n')

  it('块级元素注入的区间就是解析层算出的区间，且能切回该块的原文', () => {
    const { blocks } = parseMarkdown(SRC)
    render(blocks)

    // 每例都给**期望的原文切片**——只断言「非空」等于什么都没锁。
    const cases: Array<[string, Block, string]> = [
      ['h1.md-h1', blocks[0], '# 一'],
      ['p.md-p', blocks[1], '段落'],
      ['pre.md-pre', blocks[2], '```ts\nx\n```'],
      ['blockquote.md-quote', blocks[3], '> 引文'],
      ['div.md-table-wrap', blocks[4], '| a |\n| --- |\n| b |'],
      ['hr.md-hr', blocks[5], '---'],
    ]
    for (const [selector, block, text] of cases) {
      const el = one(selector)
      expect(el.getAttribute('data-src-start')).toBe(String(block.srcStart))
      expect(el.getAttribute('data-src-end')).toBe(String(block.srcEnd))
      expect(SRC.slice(block.srcStart!, block.srcEnd!)).toBe(text)
    }

    // quote 内层递归块同样带区间，且映射回原始 src（`> ` 前缀不计入内层）
    const quote = blocks[3]
    if (quote.type !== 'quote') throw new Error('expected quote')
    const inner = one('blockquote.md-quote p.md-p')
    expect(inner.getAttribute('data-src-start')).toBe(String(quote.blocks[0].srcStart))
    expect(inner.getAttribute('data-src-end')).toBe(String(quote.blocks[0].srcEnd))
    expect(SRC.slice(quote.blocks[0].srcStart!, quote.blocks[0].srcEnd!)).toBe('引文')
  })

  it('区间缺省（手写 Block）时不注入任何 data-src-* 属性', () => {
    render([{ type: 'paragraph', content: [{ type: 'text', text: '裸块' }] }])
    const p = one('p.md-p')
    expect(p.getAttribute('data-src-start')).toBeNull()
    expect(p.getAttribute('data-src-end')).toBeNull()
  })
})
