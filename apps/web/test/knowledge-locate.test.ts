/**
 * v13 W-3（SPEC-4.3/4.4）：定位链路的**纯函数**回归——不依赖 DOM、不搭组件。
 *
 * 覆盖三件：
 *  1. `frontmatterPrefix` —— 正文体在**原始 src** 中的 code unit 偏移（BOM 计 1、
 *     `\r\n` 计 2）；有 / 无 frontmatter、有 / 无 BOM 四种都测；
 *  2. `locateChunkBlock` —— 本任务点名的两类边界（① chunk 起点落在标题行、内容块区间
 *     不含 chunkStart；② 二切把段切开、chunk 起点落在块中间）以及「无相交 → -1」；
 *  3. `lineAtOffset` —— 源码视图（>256KB 降级）的「偏移 → 行号」映射。
 *
 * 「前缀加回」的端到端一致性用真实 `chunkMarkdown`（**直接 import 切分器源码**，与
 * `Knowledge.tsx` 同一真相源）验证：`chunk.charStart + prefix` 与解析层块区间同坐标系。
 */

import { describe, expect, it } from 'vitest'

import { chunkMarkdown } from '../../../packages/knowledge/src/chunker.ts'
import { frontmatterPrefix, parseMarkdown } from '../src/markdown.ts'
import { lineAtOffset, locateChunkBlock } from '../src/pages/knowledge-logic.ts'

describe('W-3 frontmatterPrefix：正文体起点的 code unit 偏移', () => {
  it('无 frontmatter、无 BOM → 0（整篇都是正文）', () => {
    expect(frontmatterPrefix('# 标题\n\n正文')).toBe(0)
  })

  it('无 frontmatter、有 BOM → 1（BOM 计 1，切掉后 body 不含 BOM）', () => {
    const src = '\uFEFF# 标题\n正文'
    expect(frontmatterPrefix(src)).toBe(1)
    expect(src.slice(frontmatterPrefix(src))).toBe('# 标题\n正文')
  })

  it('有 frontmatter（LF）→ 前缀 = FM 块全长，body 从闭合 `---` 换行之后开始', () => {
    const src = '---\nid: KB-1\ntags: a\n---\n# 标题\n\n正文'
    const prefix = frontmatterPrefix(src)
    expect(src.slice(0, prefix)).toBe('---\nid: KB-1\ntags: a\n---\n')
    expect(src.slice(prefix).startsWith('# 标题')).toBe(true)
  })

  it('有 frontmatter + CRLF → `\\r\\n` 计 2（前缀不丢 `\\r`）', () => {
    const src = '---\r\nid: KB-1\r\n---\r\n# 标题\r\n\r\n正文'
    const prefix = frontmatterPrefix(src)
    expect(frontmatterPrefix(src)).toBe(0 + '---\r\nid: KB-1\r\n---\r\n'.length)
    expect(src.slice(prefix)).toBe('# 标题\r\n\r\n正文')
    // 前缀 + body 恰好拼回原串（无吞字、无错位）
    expect(src.slice(0, prefix) + src.slice(prefix)).toBe(src)
  })

  it('有 frontmatter + BOM → 前缀含 BOM 的那 1 个 code unit', () => {
    const bare = '---\nx: 1\n---\n正文'
    expect(frontmatterPrefix(`\uFEFF${bare}`)).toBe(frontmatterPrefix(bare) + 1)
  })

  it('只有 frontmatter、无正文 → 前缀 = src.length（body 为空）', () => {
    const src = '---\nx: 1\n---\n'
    expect(frontmatterPrefix(src)).toBe(src.length)
  })

  it('首行是 `---` 但无闭合 → 不当 frontmatter（前缀 0，逐字与解析层同口径）', () => {
    const src = '---\n这不是 FM\n正文'
    expect(frontmatterPrefix(src)).toBe(0)
  })
})

describe('W-3 locateChunkBlock：首个相交块', () => {
  it('边界①：chunk 区间从标题行开始，内容块区间不含 chunkStart → 仍稳定落到标题块', () => {
    const body = ['# 一', '', '甲段正文。', '', '## 二', '', '乙段正文。'].join('\n')
    const chunks = chunkMarkdown(body)
    const blocks = parseMarkdown(body).blocks

    const first = chunks[0]
    expect(first.charStart).toBe(0)
    // 前置事实：标题块与内容块是两个独立区间，后者的 srcStart 严格大于 chunk 起点
    expect(blocks[0].type).toBe('heading')
    expect(blocks[1].type).toBe('paragraph')
    expect((blocks[1].srcStart ?? -1)).toBeGreaterThan(first.charStart)

    // 断言：按「相交」判据落到首个重叠块（标题块），不依赖内容块包含 chunkStart
    expect(locateChunkBlock(blocks, first.charStart, first.charEnd)).toBe(0)
  })

  it('边界②：二切把段落切开、chunk 起点落在块中间 → 落到包含该起点的块', () => {
    // 单段、无标题、无空行：一段 > maxChars(默认 2000) → 触发二切
    const body = '句子。'.repeat(1000) // 3000 字符
    const chunks = chunkMarkdown(body)
    expect(chunks.length).toBeGreaterThan(1)
    const blocks = parseMarkdown(body).blocks
    expect(blocks).toHaveLength(1)

    const second = chunks[1]
    // 前置事实：起点确实落在块内部（既非行首也非块首）
    expect(second.charStart).toBeGreaterThan(blocks[0].srcStart ?? -1)
    expect(second.charStart).toBeLessThan(blocks[0].srcEnd ?? -1)

    expect(locateChunkBlock(blocks, second.charStart, second.charEnd)).toBe(0)
  })

  it('区间跨块边界：返回**首个**相交块（靠前者胜）', () => {
    const body = ['第一段。', '', '第二段。', '', '第三段。'].join('\n')
    const blocks = parseMarkdown(body).blocks
    expect(blocks).toHaveLength(3)
    // 取一个横跨第 2、3 块前半的区间 —— 首个相交的是第 2 块
    const lo = (blocks[1].srcStart ?? 0) + 1
    const hi = (blocks[2].srcEnd ?? 0)
    expect(locateChunkBlock(blocks, lo, hi)).toBe(1)
  })

  it('无相交块 → -1', () => {
    const body = '段落。'
    const blocks = parseMarkdown(body).blocks
    expect(locateChunkBlock(blocks, 999, 1000)).toBe(-1)
  })

  it('缺区间的块被跳过（手写 Block 不参与定位）', () => {
    const blocks = [{}, { srcStart: 5, srcEnd: 10 }]
    expect(locateChunkBlock(blocks, 6, 7)).toBe(1)
    expect(locateChunkBlock(blocks, 0, 1)).toBe(-1)
  })

  it('空块数组 → -1（不抛）', () => {
    expect(locateChunkBlock([], 0, 10)).toBe(-1)
  })

  it('起点与块首对齐时判为相交（半开区间的左端闭、右端开）', () => {
    const blocks = [{ srcStart: 10, srcEnd: 20 }]
    expect(locateChunkBlock(blocks, 10, 12)).toBe(0)
    // 块右端开：chunk 起点恰在块尾不算相交
    expect(locateChunkBlock(blocks, 20, 25)).toBe(-1)
  })
})

describe('W-3 前缀加回：chunk 区间 ↔ 块区间同坐标系（真实切分器）', () => {
  const DOCS: ReadonlyArray<[string, string]> = [
    ['无 FM / LF', ['# 标题', '', '正文段落，长一点点。'].join('\n')],
    ['有 FM / LF', ['---', 'id: KB-1', '---', '# 标题', '', '正文段落，长一点点。'].join('\n')],
    ['有 FM / CRLF', ['---', 'id: KB-1', '---', '# 标题', '', '正文段落，长一点点。'].join('\r\n')],
    ['有 FM + BOM / CRLF', `\uFEFF${['---', 'id: KB-1', '---', '# 标题', '', '正文段落，长一点点。'].join('\r\n')}`],
  ]

  it.each(DOCS)('%s：首段命中 → 加回前缀后落到标题块，切片等于标题原文', (_label, src) => {
    const prefix = frontmatterPrefix(src)
    const chunks = chunkMarkdown(src.slice(prefix))
    const blocks = parseMarkdown(src).blocks

    const first = chunks[0]
    const idx = locateChunkBlock(blocks, first.charStart + prefix, first.charEnd + prefix)
    expect(idx).toBeGreaterThanOrEqual(0)
    const block = blocks[idx]
    expect(block.type).toBe('heading')
    expect(src.slice(block.srcStart, block.srcEnd)).toBe('# 标题')
  })
})

describe('W-3 lineAtOffset：源码视图的偏移 → 1 基行号', () => {
  const text = 'a\nb\nc' // 行首：1→0, 2→2, 3→4

  it('行首偏移映射到对应行', () => {
    expect(lineAtOffset(text, 0)).toBe(1)
    expect(lineAtOffset(text, 2)).toBe(2)
    expect(lineAtOffset(text, 4)).toBe(3)
  })

  it('落在 `\\n` 字符本身算**上一行**（右端开）', () => {
    expect(lineAtOffset(text, 1)).toBe(1)
    expect(lineAtOffset(text, 3)).toBe(2)
  })

  it('越界夹到 [1, 行数]', () => {
    expect(lineAtOffset(text, -5)).toBe(1)
    expect(lineAtOffset(text, 0)).toBe(1)
    expect(lineAtOffset(text, text.length)).toBe(3)
    expect(lineAtOffset(text, 999)).toBe(3)
  })

  it('CRLF 文本：偏移落在 `\\r` / `\\n` 上都不多计行（只有 `\\n` 断行）', () => {
    const crlf = 'a\r\nb' // a:0, \r:1, \n:2, b:3
    expect(lineAtOffset(crlf, 1)).toBe(1)
    expect(lineAtOffset(crlf, 2)).toBe(1)
    expect(lineAtOffset(crlf, 3)).toBe(2)
  })

  it('空串 → 1（唯一一行）', () => {
    expect(lineAtOffset('', 0)).toBe(1)
  })
})
