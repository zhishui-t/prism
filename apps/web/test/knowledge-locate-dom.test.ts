// @vitest-environment happy-dom
/**
 * v13 W-3（SPEC-4.3/4.4）：**定位链路的接线**回归——判据本身（区间相交 / 前缀 / 偏移→行号）
 * 由 `knowledge-locate.test.ts` 的 node 单测覆盖，本文件只锁「页面真的接上了」：
 *
 *  1. 点命中段 → 选中条目 → 滚动到 chunk 区间首个相交块 + `.hit-highlight`（渲染视图）；
 *  2. `>256KB` 降级 → 源码视图按偏移定位到对应 `.md-line` + 降级提示（i18n，SPEC-4.3）；
 *  3. **两个响应级标记位**（`chunk_scan_degraded` / `hits_truncated`）在结果区顶部各出一次——
 *     真机炸点 2：旧实现读条目级 `hits_truncated`，永不出现。
 *
 * 渲染路径与 `knowledge-arch-dom.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`（根 vitest.config.ts 的 include 只收 `.test.ts`，故不用 JSX，走 `createElement`）。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { chunkMarkdown } from '../../../packages/knowledge/src/chunker.ts'
import type { BookNode } from '../src/api.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const data = vi.hoisted(() => ({
  tree: [] as unknown[],
  catalog: [] as unknown[],
  search: {} as unknown,
  entry: null as unknown,
}))

vi.mock('../src/api.ts', () => ({
  api: {
    kbTree: () => Promise.resolve(data.tree),
    kbStats: () => Promise.resolve({ layers: {}, books: 1, entries: 1 }),
    kbConflicts: () => Promise.resolve([]),
    kbCatalog: () => Promise.resolve(data.catalog),
    kbSearch: () => Promise.resolve(data.search),
    kbGet: () => Promise.resolve(data.entry),
    kbVersions: () => Promise.resolve([]),
    kbBookStructure: () => Promise.resolve(null),
    archDiagrams: () => Promise.resolve([]),
  },
}))

import { setLang } from '../src/i18n.ts'
import { frontmatterPrefix } from '../src/markdown.ts'
import { KnowledgePage } from '../src/pages/Knowledge.tsx'

/** 两个 >minChars(120) 的段落，保证切分器不把它们合并（否则只有 1 段、没有 seq 1）。 */
const BODY = ['# 一', '', '甲'.repeat(130), '', '## 二', '', '乙'.repeat(130)].join('\n')
/** 带 frontmatter：定位必须先把前缀加回，才能与块区间对上（见本测试的设计意图）。 */
const CONTENT = ['---', 'id: KB-1', '---', BODY].join('\n')

function book(name: string): BookNode {
  return { layer: 'project', owner: 'prism', book: name, modules: [{ name: 'doc', count: 1 }], total: 1 }
}

function entry(content: string) {
  return {
    id: 'KB-1',
    version: 1,
    title: 'Doc',
    type: 'doc',
    layer: 'project',
    owner: 'prism',
    book: 'prism',
    module: 'doc',
    status: 'active',
    risk: '',
    confidence: 1,
    tags: [],
    content,
    path: 'K:\\p\\a.md',
    created_at: '2026-09-16T08:00:00.000Z',
    updated_at: '2026-09-16T08:00:00.000Z',
  }
}

function rowWith(hits: unknown[], id = 'KB-1') {
  return {
    id,
    version: 1,
    title: 'Doc',
    type: 'doc',
    layer: 'project',
    owner: 'prism',
    book: 'prism',
    module: 'doc',
    excerpt: '',
    score: 1,
    source: 'fts',
    hits,
  }
}

let container: HTMLDivElement
let root: Root
let scrollSpy: ReturnType<typeof vi.fn>

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(KnowledgePage, { query: { q: 'perf' } }))
  })
  await act(async () => {})
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

beforeEach(() => {
  setLang('zh')
  data.tree = [book('prism')]
  data.catalog = []
  data.entry = entry(CONTENT)
  data.search = { results: [rowWith([{ seq: 1, heading_path: '一 › 二', excerpt: '乙', score: 0.9 }])] }
  scrollSpy = vi.fn()
  ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy
  window.location.hash = ''
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

describe('W-3 定位 · 渲染视图（命中段 → 首个相交块 + 强调）', () => {
  it('点命中段 → 滚动到 chunk 区间首个相交的块（带 frontmatter 前缀加回）并加 `.hit-highlight`', async () => {
    await render()
    await click(one('.toc-hit-seg-toggle')!)
    await click(one('.toc-hit-seg-go')!)

    const marked = one<HTMLElement>('.md-read .hit-highlight')
    expect(marked).not.toBeNull()
    // seq=1 = 「## 二」那段：首个相交块就是该标题块（前缀加回后区间与块区间同坐标系）
    expect(marked?.tagName).toBe('H2')
    expect(marked?.textContent).toBe('二')
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'start' })
  })

  it('定位失败静默：chunk 区间找不到相交块时不高亮、不抛（回落条目顶部）', async () => {
    // seq 999 不存在 → 静默清理请求，正文照常渲染
    data.search = { results: [rowWith([{ seq: 999, heading_path: 'x', excerpt: 'e', score: 0.1 }])] }
    await render()
    await click(one('.toc-hit-seg-toggle')!)
    await click(one('.toc-hit-seg-go')!)

    expect(one('.md-read .hit-highlight')).toBeNull()
    expect(scrollSpy).not.toHaveBeenCalled()
    expect(one('.md-read')).not.toBeNull()
  })
})

describe('W-3 定位 · >256KB 降级（源码视图按偏移定位）', () => {
  it('大条目：切源码视图按字符偏移定位对应 `.md-line`，并给出 i18n 降级提示', async () => {
    const big = '甲'.repeat(263_000) // 单块 > 256KB（262144）
    const src = ['---', 'id: KB-1', '---', '# TOP', '', big, '', '# TARGET', '', '尾'.repeat(130)].join('\n')
    const body = src.slice(frontmatterPrefix(src))
    const chunks = chunkMarkdown(body)
    const targetSeq = chunks.findIndex((c) => c.headingPath.endsWith('TARGET'))
    expect(targetSeq).toBeGreaterThan(0)

    data.entry = entry(src)
    data.search = {
      results: [rowWith([{ seq: targetSeq, heading_path: 'TOP › TARGET', excerpt: 't', score: 0.9 }])],
    }

    await render()
    await click(one('.toc-hit-seg-toggle')!)
    await click(one('.toc-hit-seg-go')!)

    // 降级提示（i18n）
    expect(one('.md-source-bar')?.textContent).toContain('条目过大，已在源码视图按字符偏移定位。')
    const marked = one<HTMLElement>('.md-source .hit-highlight')
    expect(marked).not.toBeNull()
    expect(marked?.textContent).toContain('# TARGET')
  })
})

describe('W-3 响应级标记位（真机炸点 2）', () => {
  it('`chunk_scan_degraded` / `hits_truncated` 为真 → 结果区顶部**各一次**（多结果行也不重复）', async () => {
    // 两条结果行：若提示被误挂到结果行上（旧实现读条目级字段的形态），这里会各出两次。
    data.search = {
      results: [rowWith([], 'KB-1'), rowWith([], 'KB-2')],
      chunk_scan_degraded: true,
      hits_truncated: true,
    }
    await render()
    const count = (sub: string): number => (container.textContent ?? '').split(sub).length - 1
    expect(count('段级向量检索已降级（扫描量超上限），本次仅用条目级检索。')).toBe(1)
    expect(count('部分条目的命中段未全部列出')).toBe(1)
  })

  it('两个标记位缺省 → 两条提示都不出现（不占位）', async () => {
    await render()
    expect(container.textContent).not.toContain('段级向量检索已降级')
    expect(container.textContent).not.toContain('部分条目的命中段未全部列出')
  })
})

describe('W-3 命中强调 · 样式守卫（happy-dom 无布局引擎，按 styles.css 文本锁）', () => {
  it('渲染视图的强调选择器带 `.md-body` 层级（否则被代码块自带的 md-pre 底色同特异性盖掉）', () => {
    // 先剥注释：选择器名在规则注释里也出现过，不剥会把说明文字当成规则命中。
    const bare = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    // `<pre class="md-pre">` 自带 `background: var(--sheet-2)`，与 `.md-read .hit-highlight`
    // 同特异性 (0,2,0) 且源序更后 → 代码块命中时高亮会静默消失。多一层 `.md-body` 提到 (0,3,0)。
    expect(bare).toContain('.md-read .md-body .hit-highlight,')
    expect(bare).not.toMatch(/\.md-read \.hit-highlight\b/)
  })
})
