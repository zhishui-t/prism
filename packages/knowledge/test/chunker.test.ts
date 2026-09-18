import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  assembleChunkEmbeddingInput,
  chunkMarkdown,
  defaultMaxChars,
  type Chunk,
} from '../src/chunker.js'

// ── 夹具与不变量断言 ──────────────────────────────────────────────────────────

/** 区间不变量（SPEC-1.1）：全局有序、互不重叠、无缝、覆盖 [0, body.length)。 */
function expectPartition(body: string, chunks: Chunk[]): void {
  expect(chunks.length).toBeGreaterThan(0)
  expect(chunks[0].charStart).toBe(0)
  expect(chunks[chunks.length - 1].charEnd).toBe(body.length)
  chunks.forEach((chunk, i) => {
    expect(chunk.seq).toBe(i)
    expect(chunk.charEnd).toBeGreaterThan(chunk.charStart)
    if (i > 0) expect(chunks[i - 1].charEnd).toBe(chunk.charStart)
  })
}

/** 文本口径（SPEC-1.1 修订/口径 11）：去首尾空白行。 */
function expectNoBlankEdgeLines(chunks: Chunk[]): void {
  for (const chunk of chunks) {
    const lines = chunk.text.split('\n')
    expect(lines[0].trim()).not.toBe('')
    expect(lines[lines.length - 1].trim()).not.toBe('')
  }
}

/** 标题行不进入 text（只用于定界）。 */
function expectNoStructuralHeadingInText(chunks: Chunk[], titles: string[]): void {
  for (const chunk of chunks) {
    const [, ...tail] = chunk.headingPath.split(' › ')
    // 段自身最深的标题行不得出现在正文里
    if (tail.length > 0) expect(chunk.text).not.toContain(`# ${tail[tail.length - 1]}`)
  }
  expect(titles).toBeDefined()
}

const CJK = (n: number, ch = '甲'): string => ch.repeat(n)

// ── SPEC-1.1 结构切分 ────────────────────────────────────────────────────────

describe('SPEC-1.1 结构切分', () => {
  it('## A（300 字）+ ### B（500 字）→ 2 段，路径 A / A › B，区间无缝覆盖原文', () => {
    const a = CJK(300)
    const b = CJK(500, '乙')
    const body = `## A\n${a}\n### B\n${b}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.headingPath)).toEqual(['A', 'A › B'])
    expect(chunks[0].text).toBe(a)
    expect(chunks[1].text).toBe(b)
    // 标题行计入区间：首段区间起点 = 标题行行首
    expect(chunks[0].charStart).toBe(0)
    expect(chunks[0].charEnd).toBe(body.indexOf('### B'))
    expect(chunks[1].charEnd).toBe(body.length)
    expectPartition(body, chunks)
  })

  it('嵌套三级标题产出多级 headingPath，且标题行不进 text', () => {
    const body = `# 顶层\n${CJK(200)}\n## 中层\n${CJK(200, '乙')}\n### 深层\n${CJK(200, '丙')}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks.map((c) => c.headingPath)).toEqual(['顶层', '顶层 › 中层', '顶层 › 中层 › 深层'])
    for (const chunk of chunks) expect(chunk.text).not.toContain('#')
    expectPartition(body, chunks)
  })
})

// ── SPEC-1.2 严格 ATX ────────────────────────────────────────────────────────

describe('SPEC-1.2 严格 ATX（marker 后须空格或行尾）', () => {
  it('#5 事项 与 ##标题 均不产生段边界（按普通文本入段）', () => {
    const body = `#5 事项\n${CJK(200)}\n##标题\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toContain('#5 事项')
    expect(chunks[0].text).toContain('##标题')
    expectPartition(body, chunks)
  })

  it('## 恰在行尾是合法空标题；marker 后 tab 也是合法分隔符', () => {
    const body = `##\n${CJK(200)}\n#\t带 tab\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks.map((c) => c.headingPath)).toEqual(['', '带 tab'])
    expect(chunks[0].text).toBe(CJK(200))
    expectPartition(body, chunks)
  })

  it('7 个 # 不构成标题（#{1,6} 后须为空格或行尾）', () => {
    const body = `####### 太深\n${CJK(200)}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
  })

  it('口径②（终版裁定）：ATX 闭栏 # 序列不剥，headingPath 含 "A ##"', () => {
    const body = `## A ##\n${CJK(200)}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('A ##')
    expect(chunks[0].text).toBe(CJK(200))
  })
})

// ── SPEC-1.3 setext ──────────────────────────────────────────────────────────

describe('SPEC-1.3 setext 不支持', () => {
  it('标题\\n--- 不识别为标题，--- 按普通行', () => {
    const body = `标题\n---\n${CJK(200)}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toBe(`标题\n---\n${CJK(200)}`)
    expectPartition(body, chunks)
  })
})

// ── SPEC-1.4 围栏 ────────────────────────────────────────────────────────────

describe('SPEC-1.4 围栏（CommonMark 闭合规则）', () => {
  it('6 反引号开栏内含 3 反引号示例 → 内层不闭合外栏，栏后标题不被吞', () => {
    const body = `\`\`\`\`\`\`\n\`\`\`\n${CJK(200)}\n\`\`\`\`\`\`\n## 栏后标题\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toContain('```')
    expect(chunks[0].text).toContain(CJK(200))
    expect(chunks[0].text).not.toContain('## 栏后标题')
    expect(chunks[1].headingPath).toBe('栏后标题')
    expect(chunks[1].text).toBe(CJK(200, '乙'))
    expectPartition(body, chunks)
  })

  it('EOF 未闭合视为闭合：末段 charEnd = body.length，栏内标题不被识别', () => {
    const body = `~~~\n## 栏内标题\n${CJK(200)}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toContain('## 栏内标题')
    expectPartition(body, chunks)
    expect(chunks[chunks.length - 1].charEnd).toBe(body.length)
  })

  it('闭栏长度须 ≥ 开栏长度：3 个反引号闭不了 4 反引号的栏', () => {
    const body = `\`\`\`\`\n内容\n\`\`\`\n## 仍在栏内\n${CJK(200)}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toContain('## 仍在栏内')
  })

  it('两种 marker 独立计数：~~~ 闭不了 ``` 的栏', () => {
    const body = `\`\`\`\n~~~~~\n## 栏内\n${CJK(200)}\n\`\`\`\n## 栏后\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toContain('## 栏内')
    expect(chunks[1].headingPath).toBe('栏后')
    expectPartition(body, chunks)
  })

  it('闭栏行只允许尾随空白：带内容的闭栏行不闭合', () => {
    const body = `\`\`\`\n\`\`\` tail\n## 栏内\n${CJK(200)}\n\`\`\`\n## 栏后\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(2)
    expect(chunks[1].headingPath).toBe('栏后')
  })

  it('≥4 空格缩进的围栏行不开栏（缩进代码块），其后 ## 仍是标题', () => {
    const body = `${CJK(200)}\n    \`\`\`\n## A\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(2)
    expect(chunks[1].headingPath).toBe('A')
    expect(chunks[0].text).toContain('    ```')
    expectPartition(body, chunks)
  })

  it('口径③（终版裁定）：反引号围栏 info string 含反引号仍开栏', () => {
    const body = '``` `inline`\n## 被吞的标题\n' + CJK(200) + '\n```\n## 栏后\n' + CJK(200, '乙') + '\n'
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toContain('## 被吞的标题')
    expect(chunks[1].headingPath).toBe('栏后')
  })
})

// ── SPEC-1.5 缩进 ────────────────────────────────────────────────────────────

describe('SPEC-1.5 缩进配额（tab 一律不算）', () => {
  it('4 空格缩进的 # x 是缩进代码块；0–3 空格的 # y 是标题', () => {
    const body = `    # x\n${CJK(200)}\n   # y\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toBe(`    # x\n${CJK(200)}`)
    expect(chunks[1].headingPath).toBe('y')
    expect(chunks[1].text).toBe(CJK(200, '乙'))
    expectPartition(body, chunks)
  })

  it('行首 tab 不算缩进配额：\\t# x 不是标题', () => {
    const body = `\t# x\n${CJK(200)}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
  })
})

// ── SPEC-1.6 深度自适应 ──────────────────────────────────────────────────────

describe('SPEC-1.6 深度自适应', () => {
  it('全文仅 h4/h5 → 阈值上浮至 4，按 h4 分段（≥2 个 h4 可观测）', () => {
    const body = `#### H4A\n${CJK(200)}\n##### H5A\n${CJK(200, '乙')}\n#### H4B\n${CJK(200, '丙')}\n`
    const chunks = chunkMarkdown(body)

    // 不上浮时全文无 ≤3 标题 → 只会有 1 段；上浮到 4 才得到两个 h4 边界
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((c) => c.headingPath)).toEqual(['H4A', 'H4B'])
    // 深于有效层级的 h5 不产生边界，原样留在 text
    expect(chunks[0].text).toContain('##### H5A')
    expectPartition(body, chunks)
  })

  it('层级 ≤ splitDepth 的标题存在时不上浮（h2 与 h5 并存按 h2 分段）', () => {
    const body = `## A\n${CJK(200)}\n##### H5\n${CJK(200, '乙')}\n## B\n${CJK(200, '丙')}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks.map((c) => c.headingPath)).toEqual(['A', 'B'])
    expect(chunks[0].text).toContain('##### H5')
  })

  it('显式 splitDepth 更深时深标题参与分段', () => {
    const body = `#### H4A\n${CJK(200)}\n##### H5A\n${CJK(200, '乙')}\n#### H4B\n${CJK(200, '丙')}\n`
    const chunks = chunkMarkdown(body, { splitDepth: 5 })
    expect(chunks.map((c) => c.headingPath)).toEqual(['H4A', 'H4A › H5A', 'H4B'])
  })
})

// ── SPEC-1.7 短段合并 ────────────────────────────────────────────────────────

describe('SPEC-1.7 短段合并', () => {
  it('30 字短段并入前段，headingPath 取公共祖先 [A,B,D]+[A,B] → A › B', () => {
    const body = `## A\n${CJK(200)}\n### B\n${CJK(200, '乙')}\n#### D\n${CJK(30, '丁')}\n`
    const chunks = chunkMarkdown(body, { splitDepth: 6 })

    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.headingPath)).toEqual(['A', 'A › B'])
    expect(chunks[1].text).toBe(`${CJK(200, '乙')}\n\n${CJK(30, '丁')}`)
    expectPartition(body, chunks)
  })

  it('合并段 headingPath 公共祖先：[A,B,D]+[A,C] → A', () => {
    const body =
      `## A\n${CJK(200)}\n### B\n${CJK(200, '乙')}\n#### D\n${CJK(30, '丁')}\n### C\n${CJK(30, '丙')}\n`
    const chunks = chunkMarkdown(body, { splitDepth: 6 })

    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.headingPath)).toEqual(['A', 'A'])
    expect(chunks[1].text).toBe(`${CJK(200, '乙')}\n\n${CJK(30, '丁')}\n\n${CJK(30, '丙')}`)
    expectPartition(body, chunks)
  })

  it('首段过小并入后段，路径 [\'\']+[\'A\'] → \'\'，区间仍从 0 起', () => {
    const body = `导语\n## A\n${CJK(200)}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toBe(`导语\n\n${CJK(200)}`)
    expect(chunks[0].charStart).toBe(0)
    expect(chunks[0].charEnd).toBe(body.length)
    expectPartition(body, chunks)
  })

  it('合并先于二切：合并后仍超 maxChars 照常二切', () => {
    const body = `## A\n${CJK(200)}\n### B\n${CJK(30, '乙')}\n`
    const chunks = chunkMarkdown(body, { maxChars: 150, minChars: 120 })

    // B(30 字) < minChars → 先并入前段 A；合并后 text = 200 + \n\n + 30 = 232 > 150 → 再二切
    // 合并段 path 取 LCP(['A'], ['A','B']) = 'A'
    const merged = `${CJK(200)}\n\n${CJK(30, '乙')}`
    expect(merged.length).toBe(232)
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) expect(chunk.headingPath).toBe('A')
    expect(chunks[0].text.length).toBe(150)
    expect(chunks[1].text.length).toBe(82)
    expectPartition(body, chunks)
  })
})

// ── SPEC-1.8 超长二切 ────────────────────────────────────────────────────────

describe('SPEC-1.8 超长二切', () => {
  const MAX = 2000

  it('切点优先落空行（即便后面还有更靠后的句末标点）', () => {
    const head = CJK(1000, 'a')
    const tail = `${CJK(500, 'b')}。${CJK(1000, 'c')}`
    const body = `## A\n${head}\n\n${tail}\n`
    const chunks = chunkMarkdown(body, { maxChars: MAX })

    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe(head)
    expect(chunks[1].text).toBe(tail)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX * 1.1)
    expectPartition(body, chunks)
  })

  it('无空行时回落到句末标点', () => {
    const head = `${CJK(1500, 'a')}。`
    const tail = CJK(1000, 'b')
    const body = `## A\n${head}${tail}\n`
    const chunks = chunkMarkdown(body, { maxChars: MAX })

    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe(head)
    expect(chunks[1].text).toBe(tail)
    expectPartition(body, chunks)
  })

  it('空行 > 句末标点的优先级：窗口内既有空行又有句号时取空行', () => {
    // 句号在 1500（窗口内、比空行更靠后），空行在 1200 → 仍取空行
    const head = `${CJK(1199, 'a')}。`
    const tail = `${CJK(1000, 'b')}。${CJK(500, 'c')}`
    const body = `## A\n${head}\n\n${tail}\n`
    const chunks = chunkMarkdown(body, { maxChars: MAX })

    expect(chunks[0].text).toBe(head)
    expect(chunks[1].text).toBe(tail)
    expectPartition(body, chunks)
  })

  it('行内 code 内不落切点（子段边界不撕裂反引号 span）', () => {
    const prefix = CJK(1500, 'a')
    const code = `\`${CJK(200, 'c')}。${CJK(200, 'd')}\``
    const body = `## A\n${prefix} ${code} ${CJK(800, 'b')}\n`
    const chunks = chunkMarkdown(body, { maxChars: MAX })

    // 句号在 code span 内 → 回退到 span 之外
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe(`${prefix} `)
    expect(chunks[1].text.startsWith(code)).toBe(true)
    for (const chunk of chunks) {
      const backticks = [...chunk.text].filter((ch) => ch === '`').length
      expect(backticks % 2).toBe(0)
    }
    expectPartition(body, chunks)
  })

  it('URL 内不落切点（子段边界不撕裂 URL）', () => {
    const prefix = CJK(1500, 'a')
    const url = 'https://example.com/' + CJK(600, 'z')
    const body = `## A\n${prefix} ${url}\n${CJK(300, 'b')}\n`
    const chunks = chunkMarkdown(body, { maxChars: MAX })

    expect(chunks).toHaveLength(2)
    expect(chunks[1].text.startsWith(url)).toBe(true)
    for (const chunk of chunks) {
      const at = chunk.text.indexOf('https://')
      if (at >= 0) expect(chunk.text.slice(at, at + url.length)).toBe(url)
    }
    expectPartition(body, chunks)
  })

  it('硬截断兜底：无空行、无标点、无保护区的超长串按 maxChars 切', () => {
    const body = `## A\n${CJK(5000, 'x')}\n`
    const chunks = chunkMarkdown(body, { maxChars: 1000, minChars: 120 })

    expect(chunks).toHaveLength(5)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBe(1000)
      expect(chunk.headingPath).toBe('A')
    }
    expectPartition(body, chunks)
  })

  it('硬截断兜底（声明例外）：无切点的超长 URL 允许被切开', () => {
    const url = 'https://e.com/' + CJK(5000, 'z')
    const body = `## A\n${url}\n`
    const chunks = chunkMarkdown(body, { maxChars: 1000, minChars: 120 })

    expect(chunks).toHaveLength(6)
    expect(chunks[0].text.length).toBe(1000)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1000 * 1.1)
    expectPartition(body, chunks)
  })

  it('二切后子段延续原段 headingPath，且区间不越出原段', () => {
    const body = `## A\n${CJK(200)}\n### B\n${CJK(6000, 'b')}\n`
    const chunks = chunkMarkdown(body, { maxChars: 1000, minChars: 120 })

    const bChunks = chunks.filter((c) => c.headingPath === 'A › B')
    expect(bChunks.length).toBeGreaterThan(1)
    expect(bChunks[0].charStart).toBe(body.indexOf('### B'))
    expect(bChunks[bChunks.length - 1].charEnd).toBe(body.length)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1000 * 1.1)
    expectPartition(body, chunks)
    expectNoBlankEdgeLines(chunks)
  })
})

// ── SPEC-1.9 空段跳过 ────────────────────────────────────────────────────────

describe('SPEC-1.9 空段跳过', () => {
  it('两标题间零内容 → 不产该段，空标题行区间并入前段，全局仍无缝', () => {
    const body = `## A\n${CJK(200)}\n## B\n## C\n${CJK(200, '丙')}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.headingPath)).toEqual(['A', 'C'])
    // B 的标题行区间归入前段 A
    expect(chunks[0].charEnd).toBe(body.indexOf('## C'))
    expectPartition(body, chunks)
  })

  it('无前段时空标题行区间并入后段', () => {
    const body = `## A\n## B\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('B')
    expect(chunks[0].charStart).toBe(0)
    expect(chunks[0].charEnd).toBe(body.length)
    expectPartition(body, chunks)
  })

  it('空段 + 前段过短：先跳过空段（区间并入），再把过短首段并入后段', () => {
    const body = `## A\n短\n## B\n## C\n${CJK(200, '丙')}\n`
    const chunks = chunkMarkdown(body)

    // A(1 字) 过短 → 并入后段 C；LCP(['A'], ['C']) = [] → ''
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toBe(`短\n\n${CJK(200, '丙')}`)
    expect(chunks[0].charStart).toBe(0)
    expect(chunks[0].charEnd).toBe(body.length)
    expectPartition(body, chunks)
  })
})

// ── SPEC-1.10 / 1.14 输入口径 ────────────────────────────────────────────────

describe('SPEC-1.10 / 1.14 输入口径（chunker 不做 frontmatter 语义）', () => {
  it('body 首行 --- 按普通行（主题分隔线），其后内容不被吞', () => {
    const body = `---\n${CJK(200)}\n## A\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toBe(`---\n${CJK(200)}`)
    expect(chunks[1].headingPath).toBe('A')
    expectPartition(body, chunks)
  })

  it('正文中部的 ---\\ntitle: x\\n--- 仅按普通行处理（不剥 FM）', () => {
    const body = `## A\n${CJK(200)}\n---\ntitle: x\n---\n${CJK(200, '乙')}\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('A')
    expect(chunks[0].text).toContain('---\ntitle: x\n---')
    expectPartition(body, chunks)
  })

  it('口径①（终版裁定）：CRLF 文档 text 不含 \\r，但偏移按原始串计（\\r\\n=2）', () => {
    const body = `## A\r\n${CJK(200)}\r\n### B\r\n${CJK(200, '乙')}\r\n`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe(CJK(200))
    expect(chunks[0].text.includes('\r')).toBe(false)
    expect(chunks[0].charEnd).toBe(body.indexOf('### B'))
    expect(chunks[1].charEnd).toBe(body.length)
    expectPartition(body, chunks)
  })
})

// ── SPEC-1.11 幂等 ───────────────────────────────────────────────────────────

describe('SPEC-1.11 幂等（纯函数）', () => {
  it('同 content 同 opts 两次调用逐字段相等', () => {
    const body =
      `## A\n${CJK(3000)}\n### B\n${CJK(300, '乙')}\n` +
      '````\n' + CJK(300, '丙') + '\n````\n'
    expect(chunkMarkdown(body)).toEqual(chunkMarkdown(body))
    expect(chunkMarkdown(body, { maxChars: 500 })).toEqual(chunkMarkdown(body, { maxChars: 500 }))
    expect(chunkMarkdown(body, { maxChars: 150, minChars: 120 })).toEqual(
      chunkMarkdown(body, { maxChars: 150, minChars: 120 }),
    )
  })

  it('输入对象未被修改（opts 只读）', () => {
    const opts = { maxChars: 300, minChars: 120, splitDepth: 3 }
    const snapshot = { ...opts }
    chunkMarkdown(`## A\n${CJK(1000)}\n`, opts)
    expect(opts).toEqual(snapshot)
  })
})

// ── SPEC-1.12 嵌入输入 ───────────────────────────────────────────────────────

describe('SPEC-1.12 段向量嵌入输入拼装', () => {
  it('assembleChunkEmbeddingInput = `${title}\\n${headingPath}\\n${text}`', () => {
    const body = `## A\n### B\n${CJK(200)}\n`
    const [chunk] = chunkMarkdown(body)
    expect(chunk.headingPath).toBe('A › B')
    expect(assembleChunkEmbeddingInput('条目一', chunk)).toBe(`条目一\n${chunk.headingPath}\n${chunk.text}`)
  })

  it('导语段（headingPath 为空）拼出中间空行', () => {
    const chunk: Chunk = { seq: 0, headingPath: '', text: '正文', charStart: 0, charEnd: 2 }
    expect(assembleChunkEmbeddingInput('T', chunk)).toBe('T\n\n正文')
  })
})

// ── SPEC-1.13 配置分档与选项归一 ─────────────────────────────────────────────

describe('SPEC-1.13 默认 maxChars 分档与选项归一', () => {
  it('defaultMaxChars：undefined → 2000 / 400 → 240 / 1500 → 1200', () => {
    expect(defaultMaxChars(undefined)).toBe(2000)
    expect(defaultMaxChars(400)).toBe(240)
    expect(defaultMaxChars(1500)).toBe(1200)
  })

  it('defaultMaxChars 下限兜底 minChars×2 与 2000 上界', () => {
    expect(defaultMaxChars(400, 500)).toBe(1000)
    expect(defaultMaxChars(1_000_000)).toBe(2000)
  })

  it('显式 maxChars ≤ minChars → 抬升为 minChars×2（minChars=120, maxChars=100 → 240）', () => {
    const body = `## A\n${CJK(500)}\n`
    const chunks = chunkMarkdown(body, { maxChars: 100, minChars: 120 })

    expect(chunks).toHaveLength(3)
    expect(chunks[0].text.length).toBe(240)
    expect(chunks[1].text.length).toBe(240)
    expect(chunks[2].text.length).toBe(20)
    expectPartition(body, chunks)
  })

  it('缺省 maxChars 为 2000（默认切分下不超上限）', () => {
    const body = `## A\n${CJK(2000, 'x')}\n`
    const chunks = chunkMarkdown(body)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text.length).toBe(2000)

    const longer = chunkMarkdown(`## A\n${CJK(2001, 'x')}\n`)
    expect(longer).toHaveLength(2)
  })
})

// ── 边界补充 ─────────────────────────────────────────────────────────────────

describe('边界补充', () => {
  it('空输入 → []', () => {
    expect(chunkMarkdown('')).toEqual([])
  })

  it('纯空白行输入 → []', () => {
    expect(chunkMarkdown('\n\n\n')).toEqual([])
  })

  it('整篇无标题 → 单一导语段（headingPath = \'\'）', () => {
    const body = `第一段\n\n第二段\n${CJK(200)}`
    const chunks = chunkMarkdown(body)

    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toBe(body)
    expect(chunks[0].charStart).toBe(0)
    expect(chunks[0].charEnd).toBe(body.length)
    expectPartition(body, chunks)
  })

  it('全标题无内容 / 仅空段 → []（区间不变量仅非空输出时断言）', () => {
    expect(chunkMarkdown('## A\n## B\n')).toEqual([])
    expect(chunkMarkdown('## A\n\n\n## B\n')).toEqual([])
  })

  it('单行短文档 → 恰 1 段（不因短而被丢弃）', () => {
    const chunks = chunkMarkdown('一句话。')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].headingPath).toBe('')
    expect(chunks[0].text).toBe('一句话。')
  })

  it('各段 text 无首尾空白行', () => {
    const body = `## A\n\n${CJK(200)}\n\n## B\n\n${CJK(200, '乙')}\n\n`
    const chunks = chunkMarkdown(body)
    expectNoBlankEdgeLines(chunks)
    expectNoStructuralHeadingInText(chunks, ['A', 'B'])
    expectPartition(body, chunks)
  })
})

// ── 真实长文档 ───────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REAL_DOC_PATH = fileURLToPath(
  new URL('../../../doc/requirements/knowledge-base.md', import.meta.url),
)

/** 测试侧独立提取标题（与 chunker 同规则），用于校验 headingPath 的每一级真实存在。 */
function extractHeadingTitles(md: string): string[] {
  const titles: string[] = []
  let fence = ''
  let fenceLen = 0
  for (const raw of md.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (fence !== '') {
      if (new RegExp(`^ {0,3}${fence}{${fenceLen},}[ \\t]*$`).test(line)) {
        fence = ''
        fenceLen = 0
      }
      continue
    }
    const opened = /^( {0,3})(`{3,}|~{3,})/.exec(line)
    if (opened) {
      fence = opened[2][0]
      fenceLen = opened[2].length
      continue
    }
    const heading = /^( {0,3})(#{1,6})(?:[ \t]|$)/.exec(line)
    if (heading) titles.push(line.slice(heading[1].length + heading[2].length).trim())
  }
  return titles
}

describe('真实长文档（doc/requirements/knowledge-base.md）', () => {
  const doc = readFileSync(REAL_DOC_PATH, 'utf8')

  it('样本足够长（> 2×2000 字符）', () => {
    expect(REPO_ROOT).toContain('prism')
    expect(doc.length).toBeGreaterThan(2 * 2000)
  })

  it('区间 partition 不变量：有序、不重叠、无缝覆盖全文（与行尾风格无关）', () => {
    const chunks = chunkMarkdown(doc)
    expect(chunks.length).toBeGreaterThan(1)
    expectPartition(doc, chunks)
    expectNoBlankEdgeLines(chunks)

    const covered = chunks.reduce((sum, c) => sum + (c.charEnd - c.charStart), 0)
    expect(covered).toBe(doc.length)
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(2000 * 1.1)
  })

  it('headingPath 层级结构合理：每级都是文中真实标题，且存在多级路径', () => {
    const titles = new Set(extractHeadingTitles(doc))
    expect(titles.size).toBeGreaterThan(10)

    const chunks = chunkMarkdown(doc)
    for (const chunk of chunks) {
      if (chunk.headingPath === '') continue
      for (const part of chunk.headingPath.split(' › ')) expect(titles.has(part)).toBe(true)
    }
    expect(chunks.some((c) => c.headingPath.split(' › ').length >= 2)).toBe(true)
  })

  it('真实触发短段合并与超长二切', () => {
    const def = chunkMarkdown(doc)
    const noSplit = chunkMarkdown(doc, { maxChars: 10_000_000 })
    const noMerge = chunkMarkdown(doc, { minChars: 1, maxChars: 10_000_000 })
    const allMerge = chunkMarkdown(doc, { minChars: 10_000_000 })

    // 二切：放宽上限后段数变少
    expect(def.length).toBeGreaterThan(noSplit.length)
    // 合并：收紧阈值后全部并为一段
    expect(noMerge.length).toBeGreaterThan(allMerge.length)
    expect(allMerge).toHaveLength(1)
    expect(allMerge[0].charStart).toBe(0)
    expect(allMerge[0].charEnd).toBe(doc.length)

    expectPartition(doc, def)
    expectPartition(doc, allMerge)
  })

  it('行尾无关：CRLF 变体产出同构结果（路径与文本一致、偏移随原文缩放）', () => {
    const crlf = doc.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
    expect(crlf.length).toBeGreaterThan(doc.length)

    const lf = chunkMarkdown(doc)
    const win = chunkMarkdown(crlf)
    expect(win.map((c) => c.headingPath)).toEqual(lf.map((c) => c.headingPath))
    expect(win.map((c) => c.text)).toEqual(lf.map((c) => c.text))
    expectPartition(crlf, win)
  })
})
