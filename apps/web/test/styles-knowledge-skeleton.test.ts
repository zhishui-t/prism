/**
 * v10 F6 知识库目录树：**骨架行（书 / 目录）字号升档**的样式契约。
 *
 * 用户原话「章节骨架字体大一些，不然分不清」——树里两种角色此前挤在同一档：
 * 书行 `--fs-300`、目录行 `--fs-200`、条目行 `--fs-300`（**目录行比它要统领的条目还小**）。
 * 本批按设计口径（design-v10「F4/F6：字号档升一级（--fs 阶梯内取值）」）各升一档：
 *   书行 `--fs-300` → `--fs-400`，目录行 `--fs-200` → `--fs-300`，**条目行不变**。
 *
 * v10 黑盒回归修订：上面「各升一档」把**目录行落到 `--fs-300`**——与条目行（也是 `--fs-300`）
 * 同档，只靠加粗分不开，用户复现「分不清」。故再修一轮，最终口径为
 *   **书行 `--fs-500` / 目录行 `--fs-400` / 条目行 `--fs-300`（不动）**，
 * 骨架两级各自大于其下一级；末尾的「字号对比」用例把这条序钉死。
 *
 * 用「读文件 + 断言规则文本」而不是 `getComputedStyle`，理由同
 * `styles-markdown-typography.test.ts`：happy-dom 不解析外部样式表（`styles.css` 由 Vite
 * 注入，测试里根本没有样式表），计算样式探针只会得到恒绿的空断言。
 *
 * 环境：默认 node（不写环境 pragma，同 `styles-*.test.ts` 的既有做法）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

/** 去注释：注释里写着「原来是 X、现在改 Y」之类的说明，不剥掉会被断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 某条规则的规则体（选择器按字面匹配、从**行首**起——否则会取到组选择器的规则体）。 */
function body(selector: string): string {
  const at = BARE.indexOf(`\n${selector} {`)
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1)
  const open = BARE.indexOf('{', at)
  return BARE.slice(open + 1, BARE.indexOf('}', open))
}

/** 从规则体里取某条声明的值（找不到就抛，避免「少了这条」被静默通过）。 */
function decl(selector: string, prop: string): string {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(body(selector))
  expect(m, `${selector} 里没有 ${prop}`).not.toBeNull()
  return m![1]!.trim()
}

describe('v10 F6 骨架行字号升档（条目行不变）', () => {
  it('书行 `--fs-500`（区块标题档：骨架第一级，必须压过目录行）', () => {
    expect(decl('.book-toc .toc-bookname', 'font-size')).toBe('var(--fs-500)')
  })

  it('目录行 `--fs-400`（黑盒回归修订：上一版落在 `--fs-300`，与条目行同档 = 「分不清」）', () => {
    expect(decl('.book-toc .toc-mod', 'font-size')).toBe('var(--fs-400)')
  })

  it('**条目行字号不变**（`--fs-300`）——本批只动骨架，不动叶子', () => {
    expect(decl('.book-toc .toc-item', 'font-size')).toBe('var(--fs-300)')
  })

  it('**书 > 目录 > 条目，三者两两不同**（锁死「骨架与条目同档」这类回归）', () => {
    const px = (token: string): number => {
      const m = new RegExp(`(?:^|;)\\s*${token}:\\s*(\\d+)px;`).exec(BARE)
      expect(m, `styles.css 的阶梯里没有 ${token}`).not.toBeNull()
      return Number(m![1])
    }
    const size = (sel: string): number => {
      const token = /var\((--fs-\d+)\)/.exec(decl(sel, 'font-size'))
      expect(token, `${sel} 的 font-size 不是 --fs 阶梯 token`).not.toBeNull()
      return px(token![1]!)
    }
    const book = size('.book-toc .toc-bookname')
    const mod = size('.book-toc .toc-mod')
    const item = size('.book-toc .toc-item')
    // 两两不同（同档正是「只靠加粗分不开」的病根）
    expect(new Set([book, mod, item]).size).toBe(3)
    // 且序为 书 > 目录 > 条目（骨架两级各自大于它统领的下一级）
    expect(book).toBeGreaterThan(mod)
    expect(mod).toBeGreaterThan(item)
  })

  it('三档都取 `--fs` 阶梯内的既有 token（不新增字号档、不写死像素）', () => {
    for (const sel of ['.book-toc .toc-bookname', '.book-toc .toc-mod', '.book-toc .toc-item']) {
      expect(decl(sel, 'font-size'), sel).toMatch(/^var\(--fs-\d+\)$/)
    }
  })

  it('只动字号：骨架行的字重 / 字色 / 缩进口径一字未动（层级不靠第二条通道表达）', () => {
    // 书行是 ink + 600（骨架），目录行是 mute + 600（比条目重），两者都保留
    expect(decl('.book-toc .toc-bookname', 'color')).toBe('var(--ink)')
    expect(decl('.book-toc .toc-bookname', 'font-weight')).toBe('600')
    expect(decl('.book-toc .toc-mod', 'color')).toBe('var(--mute)')
    expect(decl('.book-toc .toc-mod', 'font-weight')).toBe('600')
    // 缩进仍由 `--toc-depth` 驱动（本批不动层级手段）
    expect(decl('.book-toc .toc-mod', 'padding')).toContain('--toc-depth')
    expect(decl('.book-toc .toc-item', 'padding')).toContain('--toc-depth')
  })

  it('副行不跟着升（`.toc-book-sub` 仍是 `--fs-200`：它是书的元信息，不是骨架本身）', () => {
    expect(decl('.book-toc .toc-book-sub', 'font-size')).toBe('var(--fs-200)')
  })
})
