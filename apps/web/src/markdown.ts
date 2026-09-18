/**
 * 零依赖 Markdown **解析器**（design-brief-v7-a §4.1 K8）。
 *
 * 产出**结构化块数组**，不产 HTML 字符串——渲染由 `components/Markdown.tsx`
 * 组 React 元素树完成，所有文本经 React 自动转义，**不存在 XSS 面**
 * （因此不写 sanitizer，也不用 `dangerouslySetInnerHTML`）。
 *
 * 范围取舍（K8 明细表）：
 * 支持 ATX 标题 `#`–`######`、段落、嵌套 ≤2 层的无序/有序列表、围栏代码块、
 * 行内 code/粗体/斜体/删除线（互不嵌套）、链接（仅 `http(s):` 与 `#/`）、引用块、
 * 水平线、GFM 表格（含对齐）、YAML frontmatter（含 `>`/`|` 块标量）。
 * **不支持**（明确）：内联 HTML（按纯文本；**独立成段**的 `<!-- … -->` 注释例外，见
 * `standaloneCommentEnd`）、脚注、数学、任务列表、定义列表、
 * 自动链接裸 URL；图片 `![]()` 降级为「图片引用」文本行（控制台不当图片宿主）。
 */

/** 行内节点：`strong`/`em`/`code`/`del` 的内层**不再递归解析**（K8「互不嵌套」）。 */
export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  /** GFM 删除线 `~~…~~`（F9 病因 7：此前原样裸奔）→ 组件渲染 `<del>`。 */
  | { type: 'del'; text: string }
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

/**
 * 块在**原始 src**（调用方传给 `parseMarkdown` 的字符串，含 BOM / frontmatter）中的
 * 半开字符区间 `[srcStart, srcEnd)`。
 *
 * - 单位 = UTF-16 code unit；`\r\n` 计 2（`srcEnd` 落在末行的 `\r` 之前，即**不含**行终止符）。
 * - 口径 = 块的**首行行首 → 末行行尾**；段落软换行合并、表格吞后续行、代码块含围栏行，
 *   都按这个包络自然覆盖（列表块整体一个区间，列表项不单独计）。
 * - 显式豁免：frontmatter 行、空行、独立成段的 `<!-- … -->` 注释不产生区间；quote 的
 *   `>` 前缀**不进内层块**区间（内层行起点 = 该行行首 + `> ` 前缀长度）——外层 quote 是
 *   跨行包络区间，起于首行行首，故其区间会覆盖这些标记字符（见 `parseBlocks` 注记）。
 * - 可选：手写 `Block` 或旧消费方不传时为 `undefined`；`components/Markdown.tsx` 只在有值时
 *   注入 `data-src-start` / `data-src-end`（W-3 的滚动定位据此）。
 */
export interface SrcRange {
  srcStart: number
  srcEnd: number
}

export type Block =
  | ({ type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] } & Partial<SrcRange>)
  | ({ type: 'paragraph'; content: Inline[] } & Partial<SrcRange>)
  | ({ type: 'code'; lang: string; code: string } & Partial<SrcRange>)
  | ({ type: 'list'; ordered: boolean; items: ListItem[] } & Partial<SrcRange>)
  | ({ type: 'quote'; blocks: Block[] } & Partial<SrcRange>)
  | ({ type: 'hr' } & Partial<SrcRange>)
  | ({
      type: 'table'
      align: Array<'left' | 'center' | 'right' | null>
      header: Inline[][]
      rows: Inline[][][]
    } & Partial<SrcRange>)

export interface ParsedMarkdown {
  /** YAML frontmatter（`---` 包围），**不进正文块**。 */
  frontmatter?: Record<string, string>
  blocks: Block[]
}

/** 链接白名单：外链 http(s) 与新窗口；站内 `#/` 走原窗口。 */
export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith('#/')
}

/** 行首缩进宽度（tab 记 1——frontmatter 用 tab 缩进属病态输入，不引 YAML 的 tab 规则）。 */
function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)![0].length
}

/**
 * YAML 块标量头（值写在**后续缩进行**里）：`>` / `>-` / `>+` / `>` 带缩进指示符（`>2-`
 * / `>-2`）以及 `|` 家族。裁剪指示符（`-`/`+`）与缩进数字在本模块都只用于识别，不改变读法。
 *
 * ⚠ 只认「指示符本身占满整值」这一种形态（YAML 同款歧义）：想把 `>` / `|` **当普通值**，
 * 写成引号形式即可（`separator: "|"` 不会被当块标量）。
 */
const BLOCK_SCALAR_HEAD = /^([>|])[+\-\d]*$/

/**
 * 读一个块标量（诊断病因 8①：baoyu-design 技能 `description: >-` 曾把正文首行当**键**、
 * 把 `>-` 当值，炸穿 kv 表）。
 *
 * 读法：从键行往下收编「缩进 > 键行缩进」的行（空行也属于块内），遇到第一条缩进回落
 * 的非空行即块尾（那才是下一个键）。折叠：`>` 折成一行（空行 = 段落，折成换行），
 * `|` 原样折行（保留块内相对缩进）。
 *
 * 取舍（K8「只做结构化 kv 展示」的延伸）：`+`/`-` 的**尾随换行**语义、锚点、多行折行宽度、
 * 嵌套结构等 YAML 其余特性一概不做；值统一去掉尾随空行——本模块的消费方是一格表格单元格，
 * 末尾多一个换行没有可观测差异（`<td>` 里换行会被 HTML 折叠成空格）。
 */
function readBlockScalar(
  lines: string[],
  start: number,
  end: number,
  style: '>' | '|',
): { value: string; next: number } {
  const keyIndent = indentOf(lines[start])
  const raw: string[] = []
  let blockIndent = -1
  let i = start + 1
  for (; i < end; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      raw.push('')
      continue
    }
    const indent = indentOf(line)
    if (indent <= keyIndent) break
    if (blockIndent === -1) blockIndent = indent
    raw.push(line.slice(Math.min(indent, blockIndent)))
  }
  while (raw.length > 0 && raw[raw.length - 1].trim() === '') raw.pop()
  const body = raw.map((l) => (style === '|' ? l.replace(/[ \t]+$/, '') : l.trim()))
  let value = ''
  let blank = 0
  for (const line of body) {
    if (line.trim() === '') {
      blank++
      continue
    }
    if (value === '') value = line
    else value += (style === '|' || blank > 0 ? '\n' : ' ') + line
    blank = 0
  }
  return { value, next: i }
}

/**
 * 拆出 frontmatter：仅当**首行**为 `---` 且随后存在闭合 `---` 行时生效。
 * 只做一层 `key: value`（去引号）+ `>`/`|` 块标量（`readBlockScalar`），
 * 不做嵌套/数组/锚点——K8 的定位是「结构化 kv 展示」。
 *
 * **行数组入参**（W-1）：调用方已按 `\n` 切好并去掉行尾 `\r`，含 BOM 偏移。返回值
 * `bodyStart` = 正文字首的**行号**（无 frontmatter 时为 0）——解析层据此把行游标直接落进
 * 原始 src，**不再重组 body 字符串**（重组的 `lines.join('\n')` 会在含 `\r\n` 或 frontmatter
 * 的文档上丢掉偏移，N-1）。
 */
function splitFrontmatter(lines: string[]): { frontmatter?: Record<string, string>; bodyStart: number } {
  if (lines.length === 0 || !/^---[ \t]*$/.test(lines[0])) return { bodyStart: 0 }
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      end = i
      break
    }
  }
  if (end === -1) return { bodyStart: 0 }
  const frontmatter: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key === '') continue
    const raw = line.slice(at + 1).trim()
    const scalar = BLOCK_SCALAR_HEAD.exec(raw)
    if (scalar !== null) {
      const read = readBlockScalar(lines, i, end, scalar[1] === '|' ? '|' : '>')
      frontmatter[key] = read.value
      i = read.next - 1
      continue
    }
    let value = raw
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
      value = value.slice(1, -1)
    }
    frontmatter[key] = value
  }
  return { frontmatter, bodyStart: end + 1 }
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
    // 删除线 `~~…~~`（病因 7）。与 `**`/`__` 同款：必须成对且内容非空，
    // 否则（`~~~~` / 未闭合 `~~a`）整段退回纯文本——`~` 不在任何其他语法里，
    // 故落回 buf 不会误伤。
    if (ch === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ type: 'del', text: text.slice(i + 2, end) })
        i = end + 2
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

/**
 * 独立成段的 HTML 注释（病因 8②：prism 技能正文印出字面
 * `<!-- generated by prism (skill: prism) -->`）。
 *
 * 判定刻意收紧到「独占段落」这一种形态，返回**下一个块起点**（注释尾行的下一行），
 * 否则 -1（按纯文本原样显示）：
 * - 起始行必须以 `<!--` 开头（行内的 `<!--` 依然是纯文本——K8 不含 HTML 语义）；
 * - 结尾行必须以 `-->` 收尾。`<!-- x --> 正文` 这种「注释后面还拖正文」的写法不剥，
 *   免得连带吃掉后面的文字（宁可显示一个注释，不可丢正文）；
 * - 找不到 `-->`（未闭合）不剥——与 `parseInline` 的「未闭合标记符退回纯文本」同一条口径。
 */
function standaloneCommentEnd(lines: string[], start: number): number {
  if (!/^\s*<!--/.test(lines[start])) return -1
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].includes('-->')) continue
    return /-->\s*$/.test(lines[i]) ? i + 1 : -1
  }
  return -1
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
function parseList(
  lines: string[],
  start: number,
): { block: Extract<Block, { type: 'list' }>; next: number } {
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

/**
 * 行游标解析：`lines[k]` 与 `starts[k]`（该行行首在**原始 src** 中的偏移）一一对应。
 * 区间由行游标**直接查表**得到，零额外扫描——`srcEnd` = 末行行首 + 该行文本长度
 * （`lines[k]` 已去行尾 `\r`，故 `\r\n` 的 `\r` 不计入，见 `SrcRange`）。
 *
 * `start` = 首行行号（frontmatter 已剥离时 > 0）；递归（quote）时传入内层行数组与
 * **映射回原始 src 的内层起点表**，于是内层块区间天然落在原始坐标里。
 */
function parseBlocks(lines: string[], starts: number[], start: number): Block[] {
  const blocks: Block[] = []
  /** 第 line 行的行尾偏移（不含该行换行符）。 */
  const lineEnd = (line: number): number => starts[line] + lines[line].length
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (isBlank(line)) {
      i++
      continue
    }
    // 独立成段的 HTML 注释：整段丢弃（围栏代码块内的注释不受影响——那些行在上面的
    // fence 分支里被一次性吃掉，根本走不到这里）。
    const commentEnd = standaloneCommentEnd(lines, i)
    if (commentEnd !== -1) {
      i = commentEnd
      continue
    }
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const fenceStart = i
      const marker = fence[1][0]
      const code: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}{3,}\\s*$`).test(lines[i])) {
        code.push(lines[i])
        i++
      }
      // 闭合围栏行 = i（未闭合则为末行）；区间含围栏行本身。
      const fenceEnd = Math.min(i, lines.length - 1)
      i++ // 吃掉闭合围栏（缺失则到文末）
      blocks.push({
        type: 'code',
        lang: fence[2],
        code: code.join('\n'),
        srcStart: starts[fenceStart],
        srcEnd: lineEnd(fenceEnd),
      })
      continue
    }
    if (HR.test(line)) {
      blocks.push({ type: 'hr', srcStart: starts[i], srcEnd: lineEnd(i) })
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = Math.min(heading[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({
        type: 'heading',
        level,
        content: parseInline(heading[2]),
        srcStart: starts[i],
        srcEnd: lineEnd(i),
      })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      const quoteStart = i
      const inner: string[] = []
      const innerStarts: number[] = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        const m = QUOTE.exec(lines[i])!
        inner.push(m[1])
        // 内层行起点 = 该行行首 + `> ` 前缀长度（`m[0]` 整行匹配 = 前缀 + `m[1]` 内容）。
        innerStarts.push(starts[i] + (m[0].length - m[1].length))
        i++
      }
      // 外层 quote = 跨行**包络**区间（首行行首 → 末行行尾）；内层块区间已映射回原始坐标。
      blocks.push({
        type: 'quote',
        blocks: parseBlocks(inner, innerStarts, 0),
        srcStart: starts[quoteStart],
        srcEnd: lineEnd(i - 1),
      })
      continue
    }
    const table = parseTable(lines, i)
    if (table !== null) {
      blocks.push({ ...table.block, srcStart: starts[i], srcEnd: lineEnd(table.next - 1) })
      i = table.next
      continue
    }
    if (LIST.test(line)) {
      const list = parseList(lines, i)
      blocks.push({ ...list.block, srcStart: starts[i], srcEnd: lineEnd(list.next - 1) })
      i = list.next
      continue
    }
    // 段落：吃到下一个空行或新的块起始（`\n\n` 分段；软换行并成空格）。
    const paraStart = i
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
    blocks.push({
      type: 'paragraph',
      content: parseInline(para.join(' ')),
      srcStart: starts[paraStart],
      srcEnd: lineEnd(i - 1),
    })
  }
  return blocks
}

/**
 * 原始 src → 行数组 + 行首偏移表。
 *
 * - BOM 计入「原始 src 偏移」：`starts[0]` 起于 `bom`（0/1），故
 *   `src.slice(srcStart, srcEnd)` 仍取到块原文；
 * - 按 `\n` 切行并去掉行尾 `\r`（与旧 `split(/\r?\n/)` 的**行内容**等价），
 *   同时逐 `\n` 记行首偏移（`\r\n` 计 2）。
 *
 * `parseMarkdown` 与 `frontmatterPrefix` **共用**这一份切行/偏移逻辑——两处各写一遍
 * 必然漂移（W-3 的前缀口径就建立在这张表上）。
 */
function splitSrcLines(src: string): { lines: string[]; starts: number[] } {
  const bom = src.startsWith('\uFEFF') ? 1 : 0
  const normalized = bom === 1 ? src.slice(1) : src
  const lines = normalized.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  const starts: number[] = [bom]
  for (let at = 0; at < normalized.length; at++) {
    if (normalized[at] === '\n') starts.push(bom + at + 1)
  }
  return { lines, starts }
}

/** 解析入口。frontmatter 独立返回，`blocks` 只含正文。 */
export function parseMarkdown(src: string): ParsedMarkdown {
  const { lines, starts } = splitSrcLines(src)
  const { frontmatter, bodyStart } = splitFrontmatter(lines)
  const blocks = parseBlocks(lines, starts, bodyStart)
  return frontmatter === undefined ? { blocks } : { frontmatter, blocks }
}

/**
 * 正文体（已剥 frontmatter）起点在**原始 src** 中的 UTF-16 code unit 偏移
 * （= frontmatter 前缀长度，BOM 计 1；无 frontmatter 时即 BOM 长度 0/1）。
 *
 * W-3 定位链路的坐标换算支点：块区间（`Block.srcStart/srcEnd`）按**含前缀**的原始
 * src 计，而 `chunkMarkdown` 的输入要求**已剥 FM 的 body**、chunk 区间按 body 计——
 * 故 `body = src.slice(frontmatterPrefix(src))`，chunk 区间逐段 `+ prefix` 即回到
 * 块区间的坐标系（两者都含 BOM 偏移）。
 */
export function frontmatterPrefix(src: string): number {
  const { lines, starts } = splitSrcLines(src)
  const { bodyStart } = splitFrontmatter(lines)
  return starts[bodyStart] ?? src.length
}
