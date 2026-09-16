/**
 * 零依赖 Markdown **解析器**（design-brief-v7-a §4.1 K8）。
 *
 * 产出**结构化块数组**，不产 HTML 字符串——渲染由 `components/Markdown.tsx`
 * 组 React 元素树完成，所有文本经 React 自动转义，**不存在 XSS 面**
 * （因此不写 sanitizer，也不用 `dangerouslySetInnerHTML`）。
 *
 * 范围取舍（K8 明细表）：
 * 支持 ATX 标题 `#`–`######`、段落、嵌套 ≤2 层的无序/有序列表、围栏代码块、
 * 行内 code/粗体/斜体（互不嵌套）、链接（仅 `http(s):` 与 `#/`）、引用块、
 * 水平线、GFM 表格（含对齐）、YAML frontmatter。
 * **不支持**（明确）：内联 HTML（按纯文本）、脚注、数学、任务列表、定义列表、
 * 自动链接裸 URL；图片 `![]()` 降级为「图片引用」文本行（控制台不当图片宿主）。
 */

/** 行内节点：`strong`/`em`/`code` 的内层**不再递归解析**（K8「互不嵌套」）。 */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; href: string; text: string }
  | { type: 'image'; alt: string; url: string }

export interface ListItem {
  content: Inline[]
  /** 嵌套子项（depth ≥ 1）。 */
  children?: ListItem[]
  /** 该项的有序性——子列表可与父列表不同型。 */
  ordered: boolean
  /** depth ≥ 2 的更深项：无项目符号，按纯文本缩进渲染。 */
  plain?: boolean
}

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] }
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'hr' }
  | {
      type: 'table'
      align: Array<'left' | 'center' | 'right' | null>
      header: Inline[][]
      rows: Inline[][][]
    }

export interface ParsedMarkdown {
  /** YAML frontmatter（`---` 包围），**不进正文块**。 */
  frontmatter?: Record<string, string>
  blocks: Block[]
}

/** 链接白名单：外链 http(s) 与新窗口；站内 `#/` 走原窗口。 */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith('#/')
}

/**
 * 拆出 frontmatter：仅当**首行**为 `---` 且随后存在闭合 `---` 行时生效。
 * 只做一层 `key: value`（去引号），不做嵌套/数组——K8 的定位是「结构化 kv 展示」。
 */
function splitFrontmatter(src: string): { frontmatter?: Record<string, string>; body: string } {
  const normalized = src.replace(/^\uFEFF/, '')
  if (!/^---[ \t]*\r?\n/.test(normalized)) return { body: normalized }
  const lines = normalized.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      end = i
      break
    }
  }
  if (end === -1) return { body: normalized }
  const frontmatter: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key === '') continue
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
      value = value.slice(1, -1)
    }
    frontmatter[key] = value
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n') }
}

/**
 * 行内链接/图片的单次扫描上界（字符）。
 *
 * `[^\]]*` 在**无 `]` 的长文本**上是 O(n²) 灾难回溯（128KB → 数秒，code-review-v7
 * MINOR-7）。两道约束叠加把它压回线性：
 * 1. 量词上界 `{0,4096}`——alt 文本/URL 超过 4096 字符的「链接」按普通文本处理
 *    （不具任何合理语义，且降级方向与「非白名单 href 退纯文本」一致）；
 * 2. `lastIndexOf('](', …)` 一次性快筛（见 `parseInline`）——`[...](...)` 必含
 *    `](`，其后无 `](` 的位置根本不试正则。
 * 常规 markdown（合法链接/图片/嵌套方括号文本）的输出**不变**。
 */
const INLINE_SPAN = 4096
const IMAGE_RE = new RegExp(`^!\\[([^\\]]{0,${INLINE_SPAN}})\\]\\(([^\\s)]{0,${INLINE_SPAN}})\\)`)
const LINK_RE = new RegExp(`^\\[([^\\]]{0,${INLINE_SPAN}})\\]\\(([^\\s)]{0,${INLINE_SPAN}})\\)`)

/** 行内扫描：单遍，命中即整体吃进，**不在其内部再解析**（互不嵌套）。 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  const flush = (): void => {
    if (buf !== '') {
      out.push({ type: 'text', text: buf })
      buf = ''
    }
  }
  // MINOR-7 快筛：`]` 后跟 `(` 的最后位置。链接/图片都必含 `](`，故 `i >= lastLinkOpen`
  // 之后的 `[` / `![` 一定不成链——直接跳过正则，免掉「满屏 `[` 无 `]`」的逐字符回溯。
  const lastLinkOpen = text.lastIndexOf('](')
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    // 行内代码：先于 `*`/`[` 判定，`**` 落在代码里不应被当粗体。
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ type: 'code', text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    // 图片：`![alt](url)` → 降级为「图片引用」节点（保留 alt/url 供组件展示复制路径）。
    if (ch === '!' && text[i + 1] === '[' && i < lastLinkOpen) {
      const img = IMAGE_RE.exec(text.slice(i))
      if (img !== null) {
        flush()
        out.push({ type: 'image', alt: img[1], url: img[2] })
        i += img[0].length
        continue
      }
    }
    // 链接：仅白名单 href 成链，其余**整段退回纯文本**（K8）。
    if (ch === '[' && i < lastLinkOpen) {
      const link = LINK_RE.exec(text.slice(i))
      if (link !== null && isSafeHref(link[2])) {
        flush()
        out.push({ type: 'link', href: link[2], text: link[1] })
        i += link[0].length
        continue
      }
    }
    if (ch === '*' || ch === '_') {
      const marker = ch === '*' ? '**' : '__'
      if (text.startsWith(marker, i)) {
        const end = text.indexOf(marker, i + 2)
        if (end > i + 2) {
          flush()
          out.push({ type: 'strong', text: text.slice(i + 2, end) })
          i = end + 2
          continue
        }
      }
      const single = text.indexOf(ch, i + 1)
      if (single > i + 1) {
        flush()
        out.push({ type: 'em', text: text.slice(i + 1, single) })
        i = single + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const LIST = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/
const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** 表格行 → 单元格（去首尾空管，保留内部空单元）。 */
function splitRow(line: string): string[] {
  const cells = line.trim().split('|')
  if (cells.length > 0 && cells[0].trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim())
}

function parseAlign(line: string): Array<'left' | 'center' | 'right' | null> {
  return splitRow(line).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

function parseTable(lines: string[], start: number): { block: Block; next: number } | null {
  const header = lines[start]
  if (!header.includes('|')) return null
  const delim = lines[start + 1]
  if (delim === undefined || !TABLE_DELIM.test(delim) || !delim.includes('-')) return null
  const align = parseAlign(delim)
  const cols = splitRow(header).length
  const rows: Inline[][][] = []
  let i = start + 2
  const pad = (cells: string[]): Inline[][] => {
    const out: Inline[][] = []
    for (let c = 0; c < cols; c++) out.push(parseInline(cells[c] ?? ''))
    return out
  }
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
    rows.push(pad(splitRow(lines[i])))
    i++
  }
  return {
    block: { type: 'table', align, header: pad(splitRow(header)), rows },
    next: i,
  }
}

/** 列表：按缩进栈定层级，**上限 2 层**；更深的项标 `plain`（无符号缩进文本）。 */
function parseList(lines: string[], start: number): { block: Block; next: number } {
  const items: ListItem[] = []
  const indentStack: number[] = []
  const byLevel: ListItem[] = []
  let i = start
  let topOrdered = false
  while (i < lines.length) {
    const m = LIST.exec(lines[i])
    if (m === null) break
    const indent = m[1].replace(/\t/g, '  ').length
    while (indentStack.length > 0 && indent < indentStack[indentStack.length - 1]) indentStack.pop()
    if (indentStack.length === 0 || indent > indentStack[indentStack.length - 1]) indentStack.push(indent)
    const level = indentStack.length - 1
    const ordered = m[3] !== undefined
    if (level === 0 && items.length === 0) topOrdered = ordered
    const item: ListItem = { content: parseInline(m[4]), ordered }
    if (level >= 2) item.plain = true
    if (level === 0) {
      items.push(item)
    } else {
      const parent = byLevel[Math.min(level - 1, 1)]
      if (parent === undefined) items.push(item)
      else (parent.children ??= []).push(item)
    }
    byLevel[level] = item
    i++
  }
  return { block: { type: 'list', ordered: topOrdered, items }, next: i }
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1][0]
      const code: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(lines[i])) {
        code.push(lines[i])
        i++
      }
      i++ // 吃掉闭合围栏（缺失则到文末）
      blocks.push({ type: 'code', lang: fence[2], code: code.join('\n') })
      continue
    }
    if (HR.test(line)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(heading[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({ type: 'heading', level, content: parseInline(heading[2]) })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        inner.push(QUOTE.exec(lines[i])![1])
        i++
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner) })
      continue
    }
    const table = parseTable(lines, i)
    if (table !== null) {
      blocks.push(table.block)
      i = table.next
      continue
    }
    if (LIST.test(line)) {
      const list = parseList(lines, i)
      blocks.push(list.block)
      i = list.next
      continue
    }
    // 段落：吃到下一个空行或新的块起始（`\n\n` 分段；软换行并成空格）。
    const para: string[] = []
    while (i < lines.length) {
      const cur = lines[i]
      if (isBlank(cur)) break
      if (
        FENCE.test(cur) ||
        HR.test(cur) ||
        HEADING.test(cur) ||
        QUOTE.test(cur) ||
        LIST.test(cur) ||
        (para.length > 0 && parseTable(lines, i) !== null)
      ) {
        break
      }
      para.push(cur.trim())
      i++
    }
    blocks.push({ type: 'paragraph', content: parseInline(para.join(' ')) })
  }
  return blocks
}

/** 解析入口。frontmatter 独立返回，`blocks` 只含正文。 */
export function parseMarkdown(src: string): ParsedMarkdown {
  const { frontmatter, body } = splitFrontmatter(src)
  const blocks = parseBlocks(body.split(/\r?\n/))
  return frontmatter === undefined ? { blocks } : { frontmatter, blocks }
}
