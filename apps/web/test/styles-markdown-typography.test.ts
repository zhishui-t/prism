/**
 * F9 正文档排版契约：**文本级**存在性锁。
 *
 * 用「读文件 + 断言规则文本」而不是 `getComputedStyle`，理由同 `styles-motion-tokens.test.ts`：
 * happy-dom 不解析外部样式表（`styles.css` 由 Vite 注入，测试里根本没有样式表），
 * 计算样式探针会得到恒绿的空断言。这里锁「规则写下来了没有、值对不对」。
 *
 * 最贵的一条是病因 1（`--font-read` 让 Windows 中文正文落到 SimSun，影响面 100%）——
 * 它只在真实浏览器里可见，本文件是它在 CI 里的唯一守卫。
 *
 * 环境：默认 node（不写环境 pragma，理由同 styles-motion-tokens.test.ts 的头注）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

/** 去注释：注释里写着「不许这样写」之类的反例说明，不剥掉会被下面的断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** `:root { … }`（深色默认块）里某个 token 的声明值。 */
function token(name: string): string {
  const at = BARE.indexOf(':root {')
  const root = BARE.slice(BARE.indexOf('{', at) + 1, BARE.indexOf('}', at))
  return new RegExp(`${name}:\\s*([^;]+);`).exec(root)?.[1]?.trim() ?? ''
}

/** 某条规则的规则体（选择器按字面匹配，须与 styles.css 里写法逐字一致）。
 *  ⚠ 从**行首**起匹配：`.md-read .md-h4` 也出现在 h1–h4 的**组选择器**里，
 *  不限定行首会取到组规则的规则体（实测踩中）。 */
function body(selector: string): string {
  const at = BARE.indexOf(`\n${selector} {`)
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1)
  const open = BARE.indexOf('{', at)
  return BARE.slice(open + 1, BARE.indexOf('}', open))
}

describe('F9 字体栈（病因 1：Windows 中文落 SimSun + 标题合成粗）', () => {
  it('`--font-read` 里没有 SimSun，且中文无衬线三档排在中文字体之前', () => {
    const stack = token('--font-read')
    expect(stack).not.toContain('SimSun')
    // 三档必须齐全且**顺序**正确（任一档先命中即可；Windows 靠 Microsoft YaHei 兜底）
    const order = ['"Source Han Sans SC"', '"Noto Sans CJK SC"', '"Microsoft YaHei"', '"Songti SC"']
    const idx = order.map((f) => stack.indexOf(f))
    expect(idx.every((i) => i > -1), `--font-read 缺字体：${stack}`).toBe(true)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    // 栈尾仍是泛型 serif（未声明者由系统兜底，不是硬编码某个具体字体）
    expect(stack.endsWith('serif')).toBe(true)
  })

  it('`--font-ui` 用雅黑承接 Windows 中文（标题改走它，才有真粗字重）', () => {
    expect(token('--font-ui')).toContain('"Microsoft YaHei"')
  })

  it('`--font-code` 在泛型 monospace 之前补中文面（块内中文不再回退宋体）', () => {
    const stack = token('--font-code')
    const cjk = stack.indexOf('"Microsoft YaHei"')
    expect(cjk).toBeGreaterThan(-1)
    expect(cjk).toBeLessThan(stack.lastIndexOf('monospace'))
    // 刻意不选 NSimSun：它是宋体面孔（正是病因 1 要避开的那一档）
    expect(stack).not.toContain('NSimSun')
  })

  it('字体栈只列本机字体名：不引网络字体、不随包分发（无 @font-face / 无外链）', () => {
    expect(BARE).not.toContain('@font-face')
    expect(BARE).not.toMatch(/url\(\s*['"]?https?:/i)
  })
})

describe('F9 标题阶梯（病因 3：h1–h4 全靠 UA 默认、h4 与正文同大、h5/h6 塌成段落）', () => {
  it('h1–h4 各自显式字号，取自**阅读阶梯** token（不与界面档位互换）', () => {
    const pairs = [
      ['.md-read .md-h1', '--fs-h1'],
      ['.md-read .md-h2', '--fs-h2'],
      ['.md-read .md-h3', '--fs-h3'],
      ['.md-read .md-h4', '--fs-h4'],
    ] as const
    for (const [selector, tok] of pairs) {
      expect(body(selector), selector).toContain(`font-size: var(${tok})`)
      expect(body(selector), selector).toContain('font-weight:')
      expect(token(tok), tok).toMatch(/^\d+px$/)
    }
    // 阶梯严格递减，且 h4 与正文同号（靠族 + 字重区分，见 token 注释）
    const [h1, h2, h3, h4] = ['--fs-h1', '--fs-h2', '--fs-h3', '--fs-h4'].map((t) => parseInt(token(t), 10))
    expect(h1).toBeGreaterThan(h2)
    expect(h2).toBeGreaterThan(h3)
    expect(h3).toBeGreaterThanOrEqual(h4)
    expect(token('--fs-h4')).toBe(token('--fs-read'))
  })

  it('标题组改 `--font-ui`（消合成粗），并由 `.md-h*` 自持正色（不落全局 th 的灰）', () => {
    expect(BARE).toMatch(/\.md-read \.md-h1[^{]*\{[^}]*font-family: var\(--font-ui\)/)
  })

  it('顶距按层级拉开：h2 `--s-6`、h3 `--s-5`', () => {
    expect(body('.md-read .md-h2')).toContain('margin: var(--s-6) 0 var(--s-2)')
    expect(body('.md-read .md-h3')).toContain('margin: var(--s-5) 0 var(--s-2)')
  })

  it('h5/h6（`.md-h-plain`）与正文可辨：UI 族 + 600 字重 + 一档字号', () => {
    const plain = body('.md-read .md-p.md-h-plain')
    expect(plain).toContain('font-family: var(--font-ui)')
    expect(plain).toContain('font-size: var(--fs-500)')
    expect(plain).toContain('font-weight: 600')
  })
})

describe('F9 代码字号（病因 5）', () => {
  it('围栏代码块 13.5px（token），行高 ≤1.6', () => {
    expect(token('--fs-code')).toBe('13.5px')
    const block = body('.md-read .md-code-block')
    expect(block).toContain('font-size: var(--fs-code)')
    const lh = parseFloat(/line-height:\s*([\d.]+)/.exec(block)?.[1] ?? '9')
    expect(lh).toBeLessThanOrEqual(1.6)
    expect(block).toContain('white-space: pre')
  })

  it('行内 code **只**改字号：`.md-code` 规则里不得出现 color（修订 #14）', () => {
    const inline = body('.md-read .md-code')
    expect(inline).not.toContain('color')
    expect(inline).toContain('font-size:')
    expect(inline).toContain('font-family: var(--font-code)')
  })
})

describe('F9 表格（病因 6：CJK 列宽塌缩 / 表头 12px 失配）', () => {
  it('固定布局 + 首列宽度策略（列宽不再由「最短可断行」决定）', () => {
    expect(body('.md-read .md-table')).toContain('table-layout: fixed')
    expect(BARE).toMatch(/\.md-read \.md-table th:first-child, \.md-read \.md-table td:first-child \{[^}]*width: 25%/)
    // 横滚容器保留（列内不可断内容仍可能顶出表宽）
    expect(body('.md-read .md-table-wrap')).toContain('overflow-x: auto')
  })

  it('禁 CJK 逐字竖排 + 兜底可断：keep-all 与 anywhere 必须同时在场', () => {
    const cell = body('.md-read .md-th, .md-read .md-td')
    expect(cell).toContain('word-break: keep-all')
    expect(cell).toContain('overflow-wrap: anywhere')
  })

  it('表头字号/正色对齐 td（全局 `th` 的 12px/--mute 不再压在上面）', () => {
    const th = body('.md-read .md-th')
    expect(th).toContain('font-size: inherit')
    expect(th).toContain('color: var(--ink)')
    // 全局 th 规则仍在（只被 .md-read 内的表格覆盖，不误伤其他页面表格）
    expect(BARE).toMatch(/\nth \{[^}]*font-size: var\(--fs-200\)/)
  })
})

/**
 * F9-2：**病因 6 的同一个病落在另一个组件上**——`.md-frontmatter` 是独立的 kv 组件
 * （自带 table/单元格规则），上面 `.md-table` 的修法覆盖不到它。实测键单元格
 * 20px × 251px、`overflow-wrap: anywhere`（`word-break: normal`），`description` 逐字母竖排。
 *
 * 压扁键列的机制与表格同一根因（`anywhere` 参与 min-content 计算），但**修法不同形**：
 * 键是短标识 ⇒ 直接禁换行（nowrap）+ 清掉继承来的断行许可，而不是 keep-all/fixed 组合。
 * 断言落在**规则文本**上（happy-dom 不解析外部样式表，计算样式探针会恒绿，理由同本文件头注）。
 */
describe('F9-2 frontmatter kv 键列（`description` 逐字母竖排）', () => {
  it('键列禁换行 + 反向清掉继承来的 `anywhere`（键列自己说了算，不靠祖先作用域）', () => {
    const th = body('.md-frontmatter th')
    expect(th).toContain('white-space: nowrap')
    expect(th).toContain('overflow-wrap: normal')
    // 关键：不能留 `anywhere`——它参与 min-content ⇒ 键列的「最小宽度」退化成单字符宽
    // （这正是 `.skill-detail { overflow-wrap: anywhere }` 继承下来后键列变 20px 的路径）
    expect(th).not.toContain('overflow-wrap: anywhere')
  })

  it('键列宽度交给 auto 布局收缩（`width: 1%`），值列保留兜底断行', () => {
    expect(body('.md-frontmatter th')).toContain('width: 1%')
    // 值列才是不定长自由文本：长 URL / 无空格串仍须能在列内折断，不撑破详情 66ch 列
    expect(body('.md-frontmatter td')).toContain('overflow-wrap: anywhere')
  })

  it('深浅两主题同一条规则（不写主题覆盖）：`.md-frontmatter th` 在文件里只有一处', () => {
    // 修法本身不含任何主题相关声明；若将来有人「深色里再覆盖一套」，条数就会 >1
    expect((BARE.match(/\.md-frontmatter th \{/g) ?? []).length).toBe(1)
  })

  it('病因源头仍在（`.skill-detail` 的 `anywhere` 是长串兜底，不该删）：键列靠自己的 `normal` 挡住', () => {
    // 反向锁：修的是**键列**，不是把祖先的兜底删掉（那是另一个缺陷的修法）
    expect(body('.skill-detail')).toContain('overflow-wrap: anywhere')
  })

  it('不回退 `.md-table` 既有的病因 6 修法（两个组件各修各的，不互相代偿）', () => {
    expect(body('.md-read .md-table')).toContain('table-layout: fixed')
    const cell = body('.md-read .md-th, .md-read .md-td')
    expect(cell).toContain('word-break: keep-all')
    expect(cell).toContain('overflow-wrap: anywhere')
  })
})
