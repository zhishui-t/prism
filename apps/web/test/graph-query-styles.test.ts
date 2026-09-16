/**
 * F4 调用链查询的**样式契约**：多义候选列表限高自滚 + 结果行布局类。
 *
 * 为什么单开一个文件（而不是放进 `graph-query-dom.test.ts`）：那个文件跑在 happy-dom 下
 * （要给四模式做 DOM 交互），而 happy-dom 里 `import.meta.url` 是 http 形态、
 * `fileURLToPath` 直接抛「The URL must be of scheme file」。本文件**不写**环境 pragma
 * （默认 node），口径与 `styles-*.test.ts` 一致：读 `styles.css` 断言规则文本——
 * happy-dom 不解析外部样式表，`getComputedStyle` 只会得到恒绿的空断言。
 *
 * ⚠ 注意：连那行 pragma 的**文字**都不能出现在本文件的注释里——vitest 扫的是首个块注释的
 * 原文，出现即被静默切到 happy-dom（`styles-motion-tokens.test.ts` 头注记了同一个坑）。
 *
 * 锁的是「候选过多时不把面板撑成无限长」这条交互契约（task-brief-v8 F4：
 * candidates 不截断，靠 max-height + overflow 收口）与 `file:line` 的文本化呈现。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')
/** 去注释：注释里写着「为什么这么写」，不剥掉会被下面的断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 某条规则的规则体（选择器从**行首**起按字面匹配）。 */
function body(selector: string): string {
  const at = BARE.indexOf(`\n${selector} {`)
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1)
  const open = BARE.indexOf('{', at)
  return BARE.slice(open + 1, BARE.indexOf('}', open))
}

describe('F4 多义候选列表：限高 + 自滚（不截断）', () => {
  it('`.graph-cand-list` 有 max-height 与 overflow-y', () => {
    const rule = body('.graph-cand-list')
    expect(rule).toContain('max-height')
    expect(rule).toContain('overflow-y: auto')
  })
})

describe('F4 结果行：布局类到位，且不自造颜色/字号', () => {
  it('结果列表复位 `pre-wrap`（`.query-result` 是给 `<pre>` 写的）', () => {
    expect(body('.graph-rel-list')).toContain('white-space: normal')
  })

  it('定位段右对齐（宽面板里 file:line 与符号分栏扫读）', () => {
    expect(body('.graph-rel-loc')).toContain('margin-left: auto')
  })

  it('本组布局类不声明字号档；颜色只用既有 token（不新增字面色）', () => {
    for (const selector of [
      '.graph-rel-list',
      '.graph-rel-node',
      '.graph-rel-dir',
      '.graph-rel-peer',
      '.graph-rel-loc',
      '.graph-chain',
      '.graph-cand',
      '.graph-cand-list',
    ]) {
      const rule = body(selector)
      // 字号档一律沿用 `.mono` / `.small`（R-v8-2：不新增字号档）
      expect(rule, selector).not.toMatch(/font-size\s*:/)
      // 颜色只许 `var(--token)`：色预算不变（写死色值即新增一档）
      const declared = /(^|[^-])color\s*:\s*([^;]+)/.exec(rule)
      if (declared !== null) expect(declared[2]!.trim(), selector).toMatch(/^var\(--/)
    }
  })
})
