import { describe, expect, it } from 'vitest'

import { isSafeHref, parseInline, parseMarkdown, type Block } from '../src/markdown.ts'

const first = (blocks: Block[]): Block => blocks[0]

/** 用块的源区间把原文切回来（缺区间直接抛错，免得测试静默拿到空串）。 */
function sliceOf(src: string, block: Block): string {
  if (block.srcStart === undefined || block.srcEnd === undefined) {
    throw new Error(`块 ${block.type} 没有 src 区间`)
  }
  return src.slice(block.srcStart, block.srcEnd)
}

describe('parseMarkdown · 块级', () => {
  it('ATX 标题层级 1–6（h5+ 保留 level 供组件降级为加粗段落）', () => {
    const { blocks } = parseMarkdown('# 一\n\n### 三\n\n##### 五\n\n###### 六')
    expect(blocks.map((b) => (b.type === 'heading' ? b.level : b.type))).toEqual([1, 3, 5, 6])
    const h1 = first(blocks)
    expect(h1.type).toBe('heading')
    if (h1.type === 'heading') expect(h1.content).toEqual([{ type: 'text', text: '一' }])
  })

  it('段落按 \\n\\n 分段，软换行并成空格', () => {
    const { blocks } = parseMarkdown('第一段\n续行\n\n第二段')
    expect(blocks).toHaveLength(2)
    const p = first(blocks)
    expect(p.type === 'paragraph' && p.content).toEqual([{ type: 'text', text: '第一段 续行' }])
  })

  it('无序列表两层嵌套；第三层起标 plain 并按纯文本缩进', () => {
    const { blocks } = parseMarkdown('- a\n  - b\n    - c\n- d')
    const list = first(blocks)
    expect(list.type).toBe('list')
    if (list.type !== 'list') return
    expect(list.ordered).toBe(false)
    expect(list.items).toHaveLength(2)
    expect(list.items[0].content).toEqual([{ type: 'text', text: 'a' }])
    const nested = list.items[0].children ?? []
    expect(nested).toHaveLength(1)
    expect(nested[0].content).toEqual([{ type: 'text', text: 'b' }])
    const deeper = nested[0].children ?? []
    expect(deeper).toHaveLength(1)
    expect(deeper[0].content).toEqual([{ type: 'text', text: 'c' }])
    expect(deeper[0].plain).toBe(true)
    expect(list.items[1].plain).toBeUndefined()
  })

  it('有序列表 ordered=true；子列表可持不同型', () => {
    const { blocks } = parseMarkdown('1. one\n2. two\n   - bullet')
    const list = first(blocks)
    if (list.type !== 'list') throw new Error('expected list')
    expect(list.ordered).toBe(true)
    expect(list.items[1].children?.[0].ordered).toBe(false)
  })

  it('围栏代码块原样保留（含空行），带语言标签', () => {
    const { blocks } = parseMarkdown('```ts\nconst a = 1\n\nconst b = 2\n```')
    const code = first(blocks)
    expect(code.type).toBe('code')
    if (code.type === 'code') {
      expect(code.lang).toBe('ts')
      expect(code.code).toBe('const a = 1\n\nconst b = 2')
    }
  })

  it('无语言标签的围栏 lang 为空串；未闭合吃到文末', () => {
    const { blocks } = parseMarkdown('```\nx')
    const code = first(blocks)
    if (code.type !== 'code') throw new Error('expected code')
    expect(code.lang).toBe('')
    expect(code.code).toBe('x')
  })

  it('引用块递归解析内部块', () => {
    const { blocks } = parseMarkdown('> ## 引文\n> 正文')
    const quote = first(blocks)
    expect(quote.type).toBe('quote')
    if (quote.type !== 'quote') return
    expect(quote.blocks[0].type).toBe('heading')
    expect(quote.blocks[1].type).toBe('paragraph')
  })

  it('水平线', () => {
    expect(first(parseMarkdown('a\n\n---\n\nb').blocks).type).toBe('paragraph')
    // W-1：块现在带源区间，故整块 toEqual 补上 [srcStart, srcEnd)（`---` 覆盖 0..3）。
    expect(parseMarkdown('---').blocks).toEqual([{ type: 'hr', srcStart: 0, srcEnd: 3 }])
    expect(parseMarkdown('***').blocks).toEqual([{ type: 'hr', srcStart: 0, srcEnd: 3 }])
  })

  it('GFM 表格：对齐行 → align，行补齐到表头列数', () => {
    const md = '| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| a | 1 | x |\n| 单独 |'
    const table = first(parseMarkdown(md).blocks)
    if (table.type !== 'table') throw new Error('expected table')
    expect(table.align).toEqual(['left', 'right', 'center'])
    expect(table.header.map((c) => (c[0].type === 'text' ? c[0].text : ''))).toEqual(['名称', '数量', '备注'])
    expect(table.rows).toHaveLength(2)
    expect(table.rows[1]).toHaveLength(3)
    expect(table.rows[1][2]).toEqual([])
  })

  it('YAML frontmatter 剥离为 kv，不进正文块', () => {
    const md = '---\nname: demo\ndescription: "带引号"\nallowed-tools: Read, Grep\n---\n# 标题'
    const { frontmatter, blocks } = parseMarkdown(md)
    expect(frontmatter).toEqual({ name: 'demo', description: '带引号', 'allowed-tools': 'Read, Grep' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('heading')
  })

  it('无 frontmatter 时字段缺省；未闭合 --- 不吞正文', () => {
    expect(parseMarkdown('# x').frontmatter).toBeUndefined()
    const { frontmatter } = parseMarkdown('---\nname: x\n# 这是正文')
    expect(frontmatter).toBeUndefined()
  })
})

// F9 病因 8：语法/元数据裸奔（v8-md-diagnosis.md §一 第 8 项）
describe('parseMarkdown · frontmatter 块标量（F9 病因 8①）', () => {
  it('`>-` 折叠标量：后续缩进行收编为值，**不把内容行当键**', () => {
    // 复刻 baoyu-design 技能的真实形态（describe 折行 + 下一键紧跟），
    // 且内容行里含半角冒号——老实现会把这一行整行当**键**。
    const md = [
      '---',
      'name: baoyu-design',
      'description: >-',
      '  基于朴素设计价值观的方法论；',
      '  说明: 包含设计知识沉淀与评审要点。',
      'allowed-tools: Read, Grep',
      '---',
      '# 标题',
    ].join('\n')
    const { frontmatter, blocks } = parseMarkdown(md)
    expect(frontmatter).toEqual({
      name: 'baoyu-design',
      description: '基于朴素设计价值观的方法论； 说明: 包含设计知识沉淀与评审要点。',
      'allowed-tools': 'Read, Grep',
    })
    // 正文块只剩标题：描述行没有溢出成键值对
    expect(blocks.map((b) => b.type)).toEqual(['heading'])
  })

  it('`|-` 字面标量保留换行；裁剪指示符（`-`/`+`）不影响取值', () => {
    const literal = parseMarkdown(['---', 'note: |', '  第一行', '  第二行', 'next: x', '---'].join('\n'))
    expect(literal.frontmatter).toEqual({ note: '第一行\n第二行', next: 'x' })
    // `|-` / `|+` 只裁剪尾随换行——kv 表里无差异，两者与 `|` 同读
    expect(parseMarkdown(['---', 'note: |-', '  a', '  b', '---'].join('\n')).frontmatter).toEqual({ note: 'a\nb' })
    expect(parseMarkdown(['---', 'note: >+', '  a', '  b', '---'].join('\n')).frontmatter).toEqual({ note: 'a b' })
  })

  it('折叠标量里的空行 = 段落分隔（折成换行）；单行 `key: >-` 为空值', () => {
    expect(parseMarkdown(['---', 'd: >-', '  甲', '', '  乙', '---'].join('\n')).frontmatter).toEqual({ d: '甲\n乙' })
    expect(parseMarkdown('---\nd: >-\n---').frontmatter).toEqual({ d: '' })
  })

  it('**缩进不深于键行**的行是块尾（还原成下一个键），不是块内容', () => {
    const md = ['---', 'a: >-', '   缩进四格', 'b: 平级', 'c: 尾键', '---'].join('\n')
    expect(parseMarkdown(md).frontmatter).toEqual({ a: '缩进四格', b: '平级', c: '尾键' })
  })

  it('普通单行 kv / 带引号值的行为不变（不误伤）', () => {
    const md = '---\nname: demo\ndescription: "带引号"\nflag: >-\nsep: "|"\n---'
    expect(parseMarkdown(md).frontmatter).toEqual({ name: 'demo', description: '带引号', flag: '', sep: '|' })
  })
})

describe('parseMarkdown · HTML 注释（F9 病因 8②）', () => {
  it('独立成段的注释整段剥离（prism 技能正文泄漏的正是这一行）', () => {
    const md = [
      '---',
      'name: prism',
      '---',
      '',
      '<!-- generated by prism (skill: prism) -->',
      '',
      '# Prism 使用手册',
      '',
      '正文第一段。',
    ].join('\n')
    const { blocks } = parseMarkdown(md)
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph'])
    const p = blocks[1]
    expect(p.type === 'paragraph' && p.content).toEqual([{ type: 'text', text: '正文第一段。' }])
  })

  it('多行注释同样剥离；围栏代码块内的注释**不动**', () => {
    expect(parseMarkdown('<!--\n第一行\n第二行\n-->\n\n正文').blocks.map((b) => b.type)).toEqual(['paragraph'])
    // W-1：整块 toEqual 补上区间（` ```html\n<!-- keep -->\n``` ` 共 25 个 UTF-16 code unit）。
    expect(parseMarkdown('```html\n<!-- keep -->\n```').blocks).toEqual([
      { type: 'code', lang: 'html', code: '<!-- keep -->', srcStart: 0, srcEnd: 25 },
    ])
  })

  it('未闭合 / 注释后拖正文 / 行内出现 → 一律按纯文本保留（宁可显示，不丢字）', () => {
    const unclosed = parseMarkdown('<!-- 没闭合').blocks[0]
    expect(unclosed.type === 'paragraph' && unclosed.content).toEqual([{ type: 'text', text: '<!-- 没闭合' }])
    const trailing = parseMarkdown('<!-- x --> 正文').blocks[0]
    expect(trailing.type === 'paragraph' && trailing.content).toEqual([{ type: 'text', text: '<!-- x --> 正文' }])
    const inline = parseMarkdown('前 <!-- x --> 后').blocks[0]
    expect(inline.type === 'paragraph' && inline.content).toEqual([{ type: 'text', text: '前 <!-- x --> 后' }])
  })
})

describe('parseMarkdown · 行内', () => {
  it('行内三兄弟互不嵌套：`**a**` 不被当粗体', () => {
    expect(parseInline('`**a**` 和 **b** 与 *c*')).toEqual([
      { type: 'code', text: '**a**' },
      { type: 'text', text: ' 和 ' },
      { type: 'strong', text: 'b' },
      { type: 'text', text: ' 与 ' },
      { type: 'em', text: 'c' },
    ])
  })

  it('链接白名单：http(s) 与 #/ 成链', () => {
    expect(isSafeHref('https://example.com/a')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
    expect(isSafeHref('#/knowledge/prism')).toBe(true)
    expect(isSafeHref('ftp://example.com')).toBe(false)
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    const nodes = parseInline('[外](https://e.com/x) [内](#/roles/dev-1)')
    expect(nodes[0]).toEqual({ type: 'link', href: 'https://e.com/x', text: '外' })
    expect(nodes[2]).toEqual({ type: 'link', href: '#/roles/dev-1', text: '内' })
  })

  it('非白名单链接整段降级纯文本', () => {
    expect(parseInline('[x](ftp://a/b)')).toEqual([{ type: 'text', text: '[x](ftp://a/b)' }])
    expect(parseInline('[y](javascript:alert(1))')).toEqual([{ type: 'text', text: '[y](javascript:alert(1))' }])
  })

  // MINOR-11：检视实测过安全的协议/大小写/前缀变体，逐条锁成负例（一律退纯文本，不成链）
  it('XSS 变体：大小写混合 / NUL 前缀 / data: / vbscript: / 协议相对 // 均不成链', () => {
    const hostile = [
      'JaVaScRiPt:alert(1)',
      'JAVASCRIPT:alert(1)',
      '\u0000javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example.com/x',
      'https:evil.example.com',
      'ftp://evil.example.com',
    ]
    for (const href of hostile) {
      expect(isSafeHref(href)).toBe(false)
      expect(parseInline(`[x](${href})`)).toEqual([{ type: 'text', text: `[x](${href})` }])
    }
    // 白名单内的大小写仍成链（负例不误伤 https 大小写）
    expect(isSafeHref('HTTPS://example.com/a')).toBe(true)
  })

  it('表格内 / 引用块内的恶意链接同样退纯文本', () => {
    const table = first(parseMarkdown('| 列 |\n| --- |\n| [x](javascript:alert(1)) |').blocks)
    if (table.type !== 'table') throw new Error('expected table')
    expect(table.rows[0][0]).toEqual([{ type: 'text', text: '[x](javascript:alert(1))' }])

    const quote = first(parseMarkdown('> [y](JaVaScRiPt:alert(1))').blocks)
    if (quote.type !== 'quote') throw new Error('expected quote')
    const p = quote.blocks[0]
    if (p.type !== 'paragraph') throw new Error('expected paragraph')
    expect(p.content).toEqual([{ type: 'text', text: '[y](JaVaScRiPt:alert(1))' }])
  })

  it('图片降级为「图片引用」节点（保留 alt/url）', () => {
    const { blocks } = parseMarkdown('![架构图](./assets/a.png)')
    const p = first(blocks)
    if (p.type !== 'paragraph') throw new Error('expected paragraph')
    expect(p.content).toEqual([{ type: 'image', alt: '架构图', url: './assets/a.png' }])
  })

  it('内联 HTML 按纯文本保留（转义交给 React）', () => {
    const { blocks } = parseMarkdown('前 <b onload="x">粗</b> 后')
    const p = first(blocks)
    if (p.type !== 'paragraph') throw new Error('expected paragraph')
    expect(p.content).toEqual([{ type: 'text', text: '前 <b onload="x">粗</b> 后' }])
  })

  it('未闭合的标记符退回纯文本', () => {
    expect(parseInline('a *b')).toEqual([{ type: 'text', text: 'a *b' }])
    expect(parseInline('`x')).toEqual([{ type: 'text', text: '`x' }])
  })

  // F9 病因 7：`~~…~~` 此前原样裸奔（连六个波浪号一起印在正文里）
  it('删除线 `~~…~~` → del 节点（内容不递归解析，与 `**` 同款）', () => {
    expect(parseInline('~~能否自审~~')).toEqual([{ type: 'del', text: '能否自审' }])
    expect(parseInline('前 ~~删~~ 后')).toEqual([
      { type: 'text', text: '前 ' },
      { type: 'del', text: '删' },
      { type: 'text', text: ' 后' },
    ])
    expect(parseInline('~~ 与 **粗** ~~')).toEqual([{ type: 'del', text: ' 与 **粗** ' }])
    // 段落/表格单元格里同样成立
    const p = parseMarkdown('D6 ~~能否自审~~ 待定').blocks[0]
    expect(p.type === 'paragraph' && p.content).toEqual([
      { type: 'text', text: 'D6 ' },
      { type: 'del', text: '能否自审' },
      { type: 'text', text: ' 待定' },
    ])
  })

  it('删除线边界：未闭合 / 空内容退回纯文本；单个 `~`（路径）不受影响', () => {
    expect(parseInline('~~a')).toEqual([{ type: 'text', text: '~~a' }])
    expect(parseInline('~~~~')).toEqual([{ type: 'text', text: '~~~~' }])
    expect(parseInline('见 ~/.zcode 与 ~/x')).toEqual([{ type: 'text', text: '见 ~/.zcode 与 ~/x' }])
  })
})

/**
 * W-1（SPEC-4.1）：解析层源区间。单位 = UTF-16 code unit，按**原始 src** 计（含 BOM /
 * frontmatter），`\r\n` 计 2；`[srcStart, srcEnd)` 为半开区间，`srcEnd` 落在末行的行尾
 * （不含该行换行符）。
 */
describe('parseMarkdown · W-1 源区间', () => {
  const SRC = [
    '# 标题',
    '',
    '第一段',
    '续行',
    '',
    '```ts',
    'const a = 1',
    '```',
    '',
    '- a',
    '- b',
    '',
    '> 引文一',
    '> 引文二',
    '',
    '| h1 | h2 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '---',
  ].join('\n')

  it('(a) 每种块都能用 [srcStart, srcEnd) 切回自己的原文行', () => {
    const { blocks } = parseMarkdown(SRC)
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'code',
      'list',
      'quote',
      'table',
      'hr',
    ])
    expect(blocks.map((b) => sliceOf(SRC, b))).toEqual([
      '# 标题',
      '第一段\n续行',
      '```ts\nconst a = 1\n```',
      '- a\n- b',
      '> 引文一\n> 引文二',
      '| h1 | h2 |\n| --- | --- |\n| a | b |',
      '---',
    ])
  })

  it('(b) 顶层块区间按序排列、互不重叠', () => {
    const { blocks } = parseMarkdown(SRC)
    for (let k = 0; k < blocks.length; k++) {
      expect(blocks[k].srcStart).toBeTypeOf('number')
      expect(blocks[k].srcEnd).toBeTypeOf('number')
      if (k > 0) {
        expect(blocks[k].srcStart!).toBeGreaterThanOrEqual(blocks[k - 1].srcEnd!)
        expect(blocks[k].srcStart!).toBeGreaterThan(blocks[k - 1].srcStart!)
      }
    }
  })

  it('(c) 豁免：frontmatter / 空行 / 独立注释不落区间；单行 quote 的 `>` 前缀不进内层区间', () => {
    const src = ['---', 'name: x', '---', '', '<!-- c -->', '', '# T'].join('\n')
    const { blocks } = parseMarkdown(src)
    expect(blocks).toHaveLength(1)
    expect(sliceOf(src, blocks[0])).toBe('# T')
    // frontmatter 行与注释段的字符落在任何块区间之外
    for (const at of [src.indexOf('name: x'), src.indexOf('<!-- c -->')]) {
      expect(at).toBeGreaterThan(-1)
      for (const b of blocks) {
        expect(b.srcStart! <= at && at < b.srcEnd!).toBe(false)
      }
    }

    // 单行 quote：`>` 前缀不计入内层块区间（外层 quote 是包络区间，起于行首）。
    const qsrc = '> 引文'
    const quote = first(parseMarkdown(qsrc).blocks)
    if (quote.type !== 'quote') throw new Error('expected quote')
    expect(sliceOf(qsrc, quote.blocks[0])).toBe('引文')
    expect(quote.blocks[0].srcStart).toBe(qsrc.indexOf('引文'))
  })

  it('(d) \\r\\n 计 2：偏移差 = 块端点之前的换行数；去行终止符后文本一致', () => {
    const lf = '# A\n\n段落一\n\n- x\n- y'
    const crlf = lf.replace(/\n/g, '\r\n')
    const a = parseMarkdown(lf).blocks
    const b = parseMarkdown(crlf).blocks
    expect(a).toHaveLength(b.length)
    const newlinesBefore = (text: string, at: number): number => (text.slice(0, at).match(/\n/g) ?? []).length
    for (let k = 0; k < a.length; k++) {
      const s = a[k].srcStart!
      const e = a[k].srcEnd!
      const s2 = b[k].srcStart!
      const e2 = b[k].srcEnd!
      expect(s2 - s).toBe(newlinesBefore(lf, s))
      expect(e2 - e).toBe(newlinesBefore(lf, e))
      // `\r` 是行终止符而非内容：去掉后半开区间文本相同
      expect(lf.slice(s, e)).toBe(crlf.slice(s2, e2).replace(/\r/g, ''))
    }
  })

  it('(e) frontmatter 前缀加回：正文块偏移对原始 src 有效', () => {
    const src = ['---', 'name: demo', '---', '# 标题', '', '正文'].join('\n')
    const { frontmatter, blocks } = parseMarkdown(src)
    expect(frontmatter).toEqual({ name: 'demo' })
    expect(sliceOf(src, blocks[0])).toBe('# 标题')
    expect(blocks[0].srcStart).toBe(src.indexOf('# 标题'))
    expect(sliceOf(src, blocks[1])).toBe('正文')
  })

  it('(f) quote 内层块区间映射回原始 src（内层起点 = 外层行首 + `> ` 前缀长度）', () => {
    const src = '> ## 引文\n> 正文'
    const quote = first(parseMarkdown(src).blocks)
    if (quote.type !== 'quote') throw new Error('expected quote')
    const [h, p] = quote.blocks
    expect(sliceOf(src, h)).toBe('## 引文')
    expect(sliceOf(src, p)).toBe('正文')
    expect(h.srcStart).toBe(2)
    expect(quote.srcStart).toBe(0)
    expect(quote.srcEnd).toBe(src.length)
  })
})
