/**
 * 长文档分段切分器（software-design-v13 §1 / spec-v13 SPEC-1）。
 *
 * 纯函数，零仓库内依赖（不 import 任何 @prism/*，不做平台判断）。
 *
 * 输入口径：body = 已剥 frontmatter 的条目正文；正文首行恰为 `---` 时按普通行
 * （主题分隔线）处理，其后内容不被吞。charStart/charEnd 为**原始输入串**的
 * UTF-16 code unit 偏移，全程不做行尾归一化（`\r\n` 计 2）；chunk.text 由行重建
 * （行尾符不计入文本）。
 */

export interface ChunkOptions {
  /** 单段字符上限；缺省 2000。显式值 ≤ minChars 时抬升为 minChars×2（不死循环）。 */
  maxChars?: number
  /** 短段合并阈值；缺省 120。 */
  minChars?: number
  /** 结构标题层级上限；缺省 3。层级内无标题时上浮至最浅存在层级。 */
  splitDepth?: number
}

export interface Chunk {
  /** 0 起、等于输出数组下标、连续。 */
  seq: number
  /** 标题路径（分隔符 ' › '）；正文首标题前的导语段为 ''。 */
  headingPath: string
  /** [charStart, charEnd) 内排除结构标题行后的原始行内容，去首尾空白行。 */
  text: string
  charStart: number
  charEnd: number
}

const DEFAULT_MIN_CHARS = 120
const DEFAULT_MAX_CHARS = 2000
const DEFAULT_SPLIT_DEPTH = 3
/** 标题路径分隔符（冻结）。 */
const HEADING_SEPARATOR = ' › '
/** 二切用的句末标点（冻结）。 */
const SENTENCE_END = new Set(['。', '！', '？', '；', '.', '!', '?', ':', ';'])

// ── 行模型 ────────────────────────────────────────────────────────────────────

interface Line {
  /** 行首在原串中的偏移。 */
  start: number
  /** 行内容（不含行尾符）在原串中的结束偏移。 */
  contentEnd: number
  /** 行内容（不含行尾符；CRLF 的 `\r` 视为行尾符）。 */
  text: string
  /** ATX 标题层级，0 = 非标题。 */
  headingLevel: number
  headingTitle: string
}

interface LineEntry {
  bodyStart: number
  bodyEnd: number
  text: string
}

/** 一个结构段（标题事件之间；含其标题行区间）。 */
interface Segment {
  headings: string[]
  /** 内容行（已去首尾空白行）；结构标题行不在其中。 */
  entries: LineEntry[]
  rangeStart: number
  rangeEnd: number
  /** 由 entries 重建的文本（不含标题行）。 */
  text: string
}

/** 输出前的区间件（段本身或二切子段）。 */
interface Range {
  rangeStart: number
  rangeEnd: number
  text: string
}

/** 行内 code / URL 保护区。 */
interface Span {
  start: number
  end: number
}

function splitLines(body: string): Line[] {
  const lines: Line[] = []
  let pos = 0
  while (pos < body.length) {
    const nl = body.indexOf('\n', pos)
    const raw = nl === -1 ? body.slice(pos) : body.slice(pos, nl)
    const end = nl === -1 ? body.length : nl + 1
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    lines.push({
      start: pos,
      contentEnd: pos + text.length,
      text,
      headingLevel: 0,
      headingTitle: '',
    })
    pos = end
  }
  return lines
}

// ── 检测：围栏与 ATX 标题（单趟状态机）────────────────────────────────────────

/** 开栏：0–3 空格缩进（tab 不算）+ 同字符 ≥3 个。≥4 空格缩进不在此列。 */
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})/

/** ATX 标题：0–3 空格缩进（tab 不算）+ #{1,6} + 空格/tab/行尾。 */
const HEADING_RE = /^( {0,3})(#{1,6})(?:[ \t]|$)/

function classifyLines(lines: Line[]): void {
  let fenceChar = ''
  let fenceLen = 0
  for (const line of lines) {
    const text = line.text
    if (fenceChar !== '') {
      // 栏内内容原样为普通文本：只有同字符且长度 ≥ 开栏长度、仅尾随空白才闭合。
      if (closesFence(text, fenceChar, fenceLen)) {
        fenceChar = ''
        fenceLen = 0
      }
      continue
    }
    const fence = FENCE_OPEN_RE.exec(text)
    if (fence) {
      fenceChar = fence[2][0]
      fenceLen = fence[2].length
      continue
    }
    const heading = HEADING_RE.exec(text)
    if (heading) {
      line.headingLevel = heading[2].length
      line.headingTitle = text.slice(heading[1].length + heading[2].length).trim()
    }
  }
}

function closesFence(text: string, char: string, len: number): boolean {
  return new RegExp(`^ {0,3}${char}{${len},}[ \\t]*$`).test(text)
}

// ── 深度自适应（SPEC-1.6）─────────────────────────────────────────────────────

function resolveSplitDepth(lines: Line[], splitDepth: number | undefined): number {
  const base =
    splitDepth === undefined || !Number.isFinite(splitDepth)
      ? DEFAULT_SPLIT_DEPTH
      : Math.max(1, Math.trunc(splitDepth))
  let hasWithin = false
  let shallowest = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.headingLevel === 0) continue
    if (line.headingLevel <= base) hasWithin = true
    if (line.headingLevel < shallowest) shallowest = line.headingLevel
  }
  // 层级 ≤ splitDepth 的标题数为零且存在更深标题 → 上浮至最浅存在层级。
  return !hasWithin && Number.isFinite(shallowest) ? shallowest : base
}

// ── 成段 ──────────────────────────────────────────────────────────────────────

function trimBlankEntries(entries: LineEntry[]): LineEntry[] {
  let s = 0
  let e = entries.length
  while (s < e && entries[s].text.trim() === '') s++
  while (e > s && entries[e - 1].text.trim() === '') e--
  return s === 0 && e === entries.length ? entries : entries.slice(s, e)
}

function buildSegments(lines: Line[], splitDepth: number, bodyLength: number): Segment[] {
  const segments: Segment[] = []
  const stack: { level: number; title: string }[] = []
  let headings: string[] = []
  let raw: LineEntry[] = []
  let rangeStart = 0

  const flush = (rangeEnd: number): void => {
    const entries = trimBlankEntries(raw)
    segments.push({
      headings,
      entries,
      rangeStart,
      rangeEnd,
      text: entries.map((e) => e.text).join('\n'),
    })
  }

  for (const line of lines) {
    if (line.headingLevel > 0 && line.headingLevel <= splitDepth) {
      flush(line.start)
      while (stack.length > 0 && stack[stack.length - 1].level >= line.headingLevel) stack.pop()
      stack.push({ level: line.headingLevel, title: line.headingTitle })
      headings = stack.map((s) => s.title)
      raw = []
      rangeStart = line.start
      continue
    }
    // 深于有效层级的标题不产生边界，原样留在当前段 text。
    raw.push({ bodyStart: line.start, bodyEnd: line.contentEnd, text: line.text })
  }
  flush(bodyLength)
  return segments
}

// ── 空段跳过 + 短段合并（SPEC-1.9 / 1.7）──────────────────────────────────────

function commonPrefix(a: string[], b: string[]): string[] {
  const n = Math.min(a.length, b.length)
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) break
    out.push(a[i])
  }
  return out
}

function mergeSegments(a: Segment, b: Segment): Segment {
  const entries = a.entries.slice()
  // 两段 text 以 '\n\n' 相接：插入一条合成空行，保持 entries↔text↔body 偏移可映射。
  entries.push({ bodyStart: a.rangeEnd, bodyEnd: a.rangeEnd, text: '' })
  for (const entry of b.entries) entries.push(entry)
  return {
    headings: commonPrefix(a.headings, b.headings),
    entries,
    rangeStart: a.rangeStart,
    rangeEnd: b.rangeEnd,
    text: `${a.text}\n\n${b.text}`,
  }
}

function selectSegments(segments: Segment[], minChars: number): Segment[] {
  // ① 空段跳过：无内容行 → 区间并入前段，无前段并入后段，保持全局无缝。
  const kept: Segment[] = []
  let pendingStart: number | null = null
  for (const seg of segments) {
    if (seg.text === '') {
      if (kept.length > 0) kept[kept.length - 1].rangeEnd = seg.rangeEnd
      else if (pendingStart === null) pendingStart = seg.rangeStart
      continue
    }
    if (pendingStart !== null) seg.rangeStart = pendingStart
    pendingStart = null
    kept.push(seg)
  }
  if (kept.length === 0) return []

  // ② 短段合并：并入前段，无前段并入后段。
  const out: Segment[] = []
  for (let i = 0; i < kept.length; i++) {
    const seg = kept[i]
    if (seg.text.length >= minChars) {
      out.push(seg)
      continue
    }
    if (out.length > 0) {
      out[out.length - 1] = mergeSegments(out[out.length - 1], seg)
      continue
    }
    if (i + 1 < kept.length) {
      kept[i + 1] = mergeSegments(seg, kept[i + 1])
      continue
    }
    out.push(seg)
  }
  return out
}

// ── 二切（SPEC-1.8）───────────────────────────────────────────────────────────

function lastInWindow(values: number[], lo: number, hi: number): number {
  let result = -1
  let left = 0
  let right = values.length - 1
  while (left <= right) {
    const mid = (left + right) >> 1
    if (values[mid] <= hi) {
      result = values[mid]
      left = mid + 1
    } else {
      right = mid - 1
    }
  }
  return result !== -1 && result > lo ? result : -1
}

function findBacktickRun(text: string, from: number, len: number): number {
  let i = from
  while (i < text.length) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let j = i
    while (j < text.length && text[j] === '`') j++
    if (j - i === len) return i
    i = j
  }
  return -1
}

/** 行内 code 跨越与 URL 词元（用于二切尽量绕开；非绝对）。 */
function protectedSpans(text: string): Span[] {
  const spans: Span[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let j = i
    while (j < text.length && text[j] === '`') j++
    const close = findBacktickRun(text, j, j - i)
    if (close === -1) {
      i = j
      continue
    }
    spans.push({ start: i, end: close + (j - i) })
    i = close + (j - i)
  }
  const urlRe = /\b(?:https?:\/\/|www\.)[^\s<>()]+/g
  let match: RegExpExecArray | null
  while ((match = urlRe.exec(text)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length })
    if (match.index === urlRe.lastIndex) urlRe.lastIndex++
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  return spans
}

function spanAt(spans: Span[], offset: number): Span | null {
  for (const span of spans) {
    if (span.start >= offset) break
    if (offset < span.end) return span
  }
  return null
}

function mapTextToBody(entries: LineEntry[], lineStarts: number[], offset: number): number {
  for (let k = 0; k < entries.length; k++) {
    const start = lineStarts[k]
    const end = start + entries[k].text.length
    if (offset <= end) return entries[k].bodyStart + Math.max(0, offset - start)
  }
  return entries[entries.length - 1].bodyEnd
}

function trimBlankLines(text: string): string {
  const parts = text.split('\n')
  let s = 0
  let e = parts.length
  while (s < e && parts[s].trim() === '') s++
  while (e > s && parts[e - 1].trim() === '') e--
  return parts.slice(s, e).join('\n')
}

function splitSegment(seg: Segment, minChars: number, maxChars: number): Range[] {
  const { text, entries } = seg
  const bounds: number[] = []

  if (entries.length > 0 && text.length > maxChars) {
    const lineStarts: number[] = []
    let acc = 0
    for (const entry of entries) {
      lineStarts.push(acc)
      acc += entry.text.length + 1
    }
    // 候选一：空行（行首落在窗口内的非空行，其前一行是空白行）。
    const blankCuts: number[] = []
    for (let k = 1; k < entries.length; k++) {
      if (entries[k].text.trim() !== '' && entries[k - 1].text.trim() === '') blankCuts.push(lineStarts[k])
    }
    // 候选二：句末标点（切在标点之后）。
    const sentCuts: number[] = []
    for (let i = 0; i < text.length; i++) if (SENTENCE_END.has(text[i])) sentCuts.push(i + 1)
    const guards = protectedSpans(text)

    let start = 0
    bounds.push(0)
    while (text.length - start > maxChars) {
      const lo = start + minChars
      const hi = start + maxChars
      let cut = lastInWindow(blankCuts, lo, hi)
      if (cut === -1) cut = lastInWindow(sentCuts, lo, hi)
      if (cut === -1) {
        cut = hi // 硬截断（最终兜底；允许切开超长 code/URL——声明例外）
      } else {
        const guard = spanAt(guards, cut)
        // 候选点落在行内 code/URL 内 → 回退到其外安全点，找不到才硬切。
        if (guard) cut = guard.start > lo ? guard.start : hi
      }
      if (cut <= start || cut > text.length) cut = Math.min(start + maxChars, text.length)
      bounds.push(cut)
      start = cut
    }
    bounds.push(text.length)

    const out: Range[] = []
    for (let i = 0; i + 1 < bounds.length; i++) {
      const ps = bounds[i]
      const pe = bounds[i + 1]
      const isLast = i + 2 === bounds.length
      out.push({
        rangeStart: i === 0 ? seg.rangeStart : mapTextToBody(entries, lineStarts, ps),
        rangeEnd: isLast ? seg.rangeEnd : mapTextToBody(entries, lineStarts, pe),
        text: trimBlankLines(text.slice(ps, pe)),
      })
    }
    return out
  }

  return [{ rangeStart: seg.rangeStart, rangeEnd: seg.rangeEnd, text }]
}

// ── 选项归一 ──────────────────────────────────────────────────────────────────

function normalizeMinChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MIN_CHARS
  return Math.max(1, Math.trunc(value))
}

function normalizeMaxChars(value: number | undefined, minChars: number): number {
  const max =
    value === undefined || !Number.isFinite(value) ? DEFAULT_MAX_CHARS : Math.trunc(value)
  return max <= minChars ? minChars * 2 : max
}

// ── 公共 API ──────────────────────────────────────────────────────────────────

/**
 * 把已剥 frontmatter 的正文切分为有序、互不重叠、无缝连续的段。
 *
 * - chunk[0].charStart = 0；chunk[i].charEnd = chunk[i+1].charStart；末段 charEnd = body.length；
 * - 每段区间起点 = 该段标题行行首（标题行计入区间，text 不含标题行）；
 * - 幂等纯函数：同输入 + 同 opts 逐字段同输出。
 */
export function chunkMarkdown(body: string, opts: ChunkOptions = {}): Chunk[] {
  const minChars = normalizeMinChars(opts.minChars)
  const maxChars = normalizeMaxChars(opts.maxChars, minChars)
  const lines = splitLines(body)
  if (lines.length === 0) return []
  classifyLines(lines)

  const splitDepth = resolveSplitDepth(lines, opts.splitDepth)
  const segments = selectSegments(buildSegments(lines, splitDepth, body.length), minChars)

  const chunks: Chunk[] = []
  for (const seg of segments) {
    const headingPath = seg.headings.join(HEADING_SEPARATOR)
    const parts: Range[] =
      seg.text.length > maxChars
        ? splitSegment(seg, minChars, maxChars)
        : [{ rangeStart: seg.rangeStart, rangeEnd: seg.rangeEnd, text: seg.text }]
    for (const part of parts) {
      chunks.push({
        seq: chunks.length,
        headingPath,
        text: part.text,
        charStart: part.rangeStart,
        charEnd: part.rangeEnd,
      })
    }
  }
  return chunks
}

/**
 * 默认分段上限（SPEC-1.13 分档公式，B-2 wiring 消费）。
 *
 * 嵌入未装（undefined）→ 2000；否则 `max(minChars*2, min(2000, clientMaxChars - 300))`。
 * 标题/路径预算 300：small 档客户截断 400 → 240（下限兜底），default/large → 1200。
 */
export function defaultMaxChars(clientMaxChars: number | undefined, minChars = DEFAULT_MIN_CHARS): number {
  if (clientMaxChars === undefined || !Number.isFinite(clientMaxChars)) return DEFAULT_MAX_CHARS
  return Math.max(minChars * 2, Math.min(2000, clientMaxChars - 300))
}

/**
 * 段向量嵌入输入拼装（SPEC-1.12）：`条目标题\nheadingPath\n段文本`。
 */
export function assembleChunkEmbeddingInput(title: string, chunk: Chunk): string {
  return `${title}\n${chunk.headingPath}\n${chunk.text}`
}
