/**
 * Markdown frontmatter 解析/序列化（零依赖 YAML 子集）。
 *
 * 支持的子集：
 * - 顶层 `key: value`；
 * - 标量：字符串（安全集不加引号，其余 JSON 双引号风格）、数字、true/false/null；
 * - 数组：行内 flow `[a, b]`；也容忍块式 `- item`；
 * - 对象：行内 flow `{k: v}`（本包序列化嵌套结构一律走 flow 风格）；
 * - `#` 注释行与空行忽略。
 */

export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[] | { [key: string]: FrontmatterValue }
export type FrontmatterData = Record<string, FrontmatterValue>

/** 安全集：不加引号也不会被误读为其他类型的纯词。 */
const SAFE_PLAIN_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@()]*$/

/** 拆开 `---\n...\n---` 头与正文；无 frontmatter 时 data 为 null。 */
export function splitFrontmatter(raw: string): { data: FrontmatterData | null; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { data: null, body: normalized }
  }
  // 从 4 开始找终止行「\n---」（后随行尾/文件尾）；\n---- 这类主题分隔行不算
  let end = normalized.indexOf('\n---', 4)
  while (end !== -1) {
    const after = normalized.slice(end + 4)
    if (after === '' || after.startsWith('\n')) {
      const yaml = normalized.slice(4, end)
      const body = after.startsWith('\n') ? after.slice(1) : ''
      return { data: parseFrontmatter(yaml), body }
    }
    end = normalized.indexOf('\n---', end + 4)
  }
  return { data: null, body: normalized }
}

/** 解析 frontmatter YAML 子集。 */
export function parseFrontmatter(yaml: string): FrontmatterData {
  const data: FrontmatterData = {}
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    i++
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = indexOfKeySeparator(trimmed)
    if (colon === -1) continue // 容忍坏行，不抛
    const key = trimmed.slice(0, colon).trim()
    const rest = trimmed.slice(colon + 1).trim()
    if (rest === '') {
      // 块式序列（- item）或空值
      if (i < lines.length && /^\s+-\s/.test(lines[i])) {
        const items: FrontmatterValue[] = []
        while (i < lines.length && /^\s+-\s/.test(lines[i])) {
          items.push(parseScalar(lines[i].trim().slice(1).trim()))
          i++
        }
        data[key] = items
      } else {
        data[key] = null
      }
      continue
    }
    data[key] = parseScalar(rest)
  }
  return data
}

/** 序列化为 frontmatter 文本（含首尾 --- 行）。 */
export function serializeFrontmatter(data: FrontmatterData): string {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${emitValue(value)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

/** 生成完整 md 文件：frontmatter（自带结尾换行）+ 正文。 */
export function renderMarkdownFile(data: FrontmatterData, content: string): string {
  return `${serializeFrontmatter(data)}${content.endsWith('\n') ? content : `${content}\n`}`
}

function indexOfKeySeparator(line: string): number {
  // 找到第一个不在引号内的 `: `（或行尾冒号）
  let inQuote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === ':' && (i + 1 === line.length || line[i + 1] === ' ')) return i
  }
  return -1
}

function parseScalar(text: string): FrontmatterValue {
  const s = text.trim()
  if (s === '' || s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as FrontmatterValue
    } catch {
      return s.slice(1).replace(/"$/, '')
    }
  }
  if (s.startsWith("'")) {
    return s.slice(1, s.endsWith("'") && s.length > 1 ? -1 : undefined).replace(/''/g, "'")
  }
  if (s.startsWith('[') && s.endsWith(']')) return parseFlowSeq(s)
  if (s.startsWith('{') && s.endsWith('}')) return parseFlowMap(s)
  const num = Number(s)
  if (s !== '' && !Number.isNaN(num)) return num
  return s
}

/** 解析行内 flow 数组：按不在引号内的顶层逗号切分。 */
function parseFlowSeq(s: string): FrontmatterValue[] {
  const inner = s.slice(1, -1).trim()
  if (inner === '') return []
  const parts = splitTopLevel(inner)
  return parts.map((p) => parseScalar(p))
}

/** 解析行内 flow 对象 `{k: v, ...}`。 */
function parseFlowMap(s: string): { [key: string]: FrontmatterValue } {
  const inner = s.slice(1, -1).trim()
  const out: { [key: string]: FrontmatterValue } = {}
  if (inner === '') return out
  for (const part of splitTopLevel(inner)) {
    const idx = part.indexOf(':')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim().replace(/^["']|["']$/g, '')
    out[key] = parseScalar(part.slice(idx + 1).trim())
  }
  return out
}

/** 按不在引号/嵌套括号内的顶层逗号切分。 */
function splitTopLevel(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inQuote: string | null = null
  let current = ''
  for (const ch of s) {
    if (inQuote) {
      current += ch
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      current += ch
      continue
    }
    if (ch === '[' || ch === '{') depth++
    if (ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

function emitValue(value: FrontmatterValue): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return emitScalar(value)
  if (Array.isArray(value)) return `[${value.map((v) => emitValue(v)).join(', ')}]`
  const entries = Object.entries(value).map(([k, v]) => `${k}: ${emitValue(v)}`)
  return `{${entries.join(', ')}}`
}

function emitScalar(s: string): string {
  if (s === '') return '""'
  if (SAFE_PLAIN_RE.test(s) && Number.isNaN(Number(s))) return s
  // JSON 字符串是合法的 YAML 双引号标量
  return JSON.stringify(s)
}
