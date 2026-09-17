/**
 * 团队定义解析（frontmatter + 正文工作流表格 → TeamDefinition）。
 *
 * **v11 F2 弹性工作流模型**（design-v11 §1 / v11.1）：
 *
 * - 扫描**严格限定**在 `## 工作流` 小节内，至下一个 **`#` / `##`（同级或更高级）** 标题硬截断
 *   （R-v11-2：旧实现表头未命中时一路扫到文件尾，后续小节的普通表格会被误当工作流；
 *   v11 派修 M-4：`###` 及更深的标题**属小节内容**，不截断——否则 prose 小节里的
 *   「`### 阶段拆解` + 表」会劫持工作流锚点）；
 * - 表**只在 `## 工作流` 直下区间认**：直下区间内出现 `###` 及更深标题即停止找表，
 *   其后内容（含形似工作流的表）一律按正文处理，不解析、不记工作流 issue（M-4）；
 * - 表头按**单元格 trim 后全等**匹配同义词（不是「行文本包含」），命中 ≥2 个核心字段
 *   且下一行是分隔行才认表头；直下区间内第一张认定的表胜出，后续表格当正文记 issue；
 * - 行级错误**全函数不抛**（R-v11-5）：列数不符 → 截断/补空 + `workflow_row_ragged`；
 *   `#` 非整数 / 非正整数 / 缺失 → order = 行号 + `workflow_order_defaulted`（M-11：`/^\d+$/`
 *   且 ≥1 才采纳，`2abc` / `-3` / `0` 均兜底）；实例记号非法 →
 *   原样保留 token + `workflow_role_cell_invalid`。frontmatter 解析错误仍抛 TeamParseError。
 * - 字段缺省值（WorkflowStage 冻结类型不改，R-v11-6）：order←行号；mode←serial
 *   （非「并行」即串行，沿用现状口径）；roles←[]（仅当 roles 列存在才解析）；
 *   input/output/done/reflow←''。
 *
 * 转义读侧（R-v11-4）：`\|` → `|` 解码；`<br>` **不**解码（原样文本）；其余 `\` 序列不动。
 *
 * `roles` 单元格语法沿用（仅当 roles 列存在）：多角色用 `+` 分隔；`dev-1/2` 展开为
 * `dev-1#1`、`dev-1#2`（实例记号）；`队长`/`leader` 原样保留（校验豁免）。
 */

import { splitFrontmatter, stripPrismMarkerTail, type FrontmatterData, type FrontmatterValue } from '../frontmatter.js'
import type {
  DepositPolicy,
  ParseIssue,
  RawWorkflowTable,
  TeamDefinition,
  TeamMember,
  WorkflowCoreField,
  WorkflowParseResult,
  WorkflowStage,
} from '../types.js'

/** 团队文件解析失败。 */
export class TeamParseError extends Error {
  readonly code = 'team_parse_failed'
  readonly line?: number
  readonly path?: string

  constructor(message: string, line?: number, path?: string) {
    super(`team_parse_failed: ${message}${line !== undefined ? ` (line ${line})` : ''}${path ? ` (${path})` : ''}`)
    this.name = 'TeamParseError'
    this.line = line
    this.path = path
  }
}

export interface ParseTeamOptions {
  sourcePath?: string
  /**
   * 传出**显式声明**的 frontmatter 键（extends 合并用：区分「声明了空数组」与「没声明」）。
   * 传入一个 Set，解析器填入。
   */
  declaredKeys?: Set<string>
}

export interface ParseWorkflowSectionOptions {
  /**
   * 行号基准偏移：输入**已是正文**（frontmatter 已剥离）时由调用方给。
   * 给了则不再尝试在本函数内剥离 frontmatter。
   */
  baseLine?: number
}

export const WORKFLOW_HEADING = '## 工作流'

/** 小节标题的**变体**（`##工作流` / `### 工作流`）——只记账不硬兼容（design-v11 §4）。 */
const HEADING_VARIANT_RE = /^#{2,4}\s*工作流\s*$/

/** 分隔行单元格：`---` / `:---` / `---:` / `:---:`。 */
const SEPARATOR_CELL_RE = /^:?-{2,}:?$/

/** 核心字段顺序（= 无表格起点时的列序）。 */
export const WORKFLOW_CORE_FIELDS: readonly WorkflowCoreField[] = [
  'order',
  'name',
  'roles',
  'mode',
  'input',
  'output',
  'done',
  'reflow',
]

/** 核心字段 → 认的列名（首中即用；列名 trim 后全等）。 */
const HEADER_SYNONYMS: Readonly<Record<WorkflowCoreField, readonly string[]>> = {
  order: ['#', '序号', 'Order'],
  name: ['阶段', '名称', 'Stage'],
  roles: ['负责角色', '角色', 'Roles'],
  mode: ['串/并行', '串·并行', '模式', 'Mode'],
  input: ['输入', 'Input'],
  output: ['输出', 'Output'],
  done: ['完成判定', '判定', 'Done'],
  reflow: ['回流路径', '回流', 'Reflow'],
}

/** 标准 8 列列名（= 各核心字段的首个同义词；design-v3 §7）。 */
export const CORE_COLUMN_NAMES: readonly string[] = WORKFLOW_CORE_FIELDS.map((field) => HEADER_SYNONYMS[field][0])

/** `## 工作流` 小节的边界（行索引）。 */
export interface WorkflowSectionBounds {
  /** 标题行的 0 基索引。 */
  heading: number
  /** 小节结束行的 0 基索引（不含）——下一个 `#` / `##` 标题或文件尾。 */
  end: number
}

/** 解析团队 Markdown。frontmatter 不支持语法时抛 TeamParseError（工作流表格不抛）。 */
export function parseTeamMarkdown(raw: string, opts: ParseTeamOptions = {}): TeamDefinition {
  let data: FrontmatterData | null
  let body: string
  try {
    ;({ data, body } = splitFrontmatter(raw))
  } catch (err) {
    throw new TeamParseError(err instanceof Error ? err.message : String(err), err instanceof Error && 'line' in err ? (err as { line?: number }).line : undefined, opts.sourcePath)
  }
  if (data === null) {
    throw new TeamParseError('缺少 frontmatter（--- 头）', undefined, opts.sourcePath)
  }

  const deposit = parseDeposit(data.deposit)
  // 工作流行号以**整份文件**计（design-v3 §7）：body 之前的行数 = 基准偏移
  const baseLine = raw.endsWith(body) ? raw.slice(0, raw.length - body.length).split('\n').length - 1 : 0
  if (opts.declaredKeys !== undefined) {
    for (const key of Object.keys(data)) opts.declaredKeys.add(key)
  }
  const team: TeamDefinition = {
    team_id: str(data.team_id) ?? '',
    name: str(data.name) ?? '',
    description: str(data.description) ?? '',
    default: data.default === true,
    extends: data.extends === undefined ? null : str(data.extends) ?? null,
    members: parseMembers(data.members),
    skills: strArray(data.skills),
    knowledge: parseKnowledge(data.knowledge),
    deposit,
    arbitration: strArray(data.arbitration),
    rework_limit: typeof data.rework_limit === 'number' ? data.rework_limit : 2,
    workflow: parseWorkflowSection(body, { baseLine }).stages,
    body: stripPrismMarkerTail(body),
  }
  return team
}

function parseDeposit(value: FrontmatterValue): DepositPolicy {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as {
    [key: string]: FrontmatterValue
  }
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map((r) => {
        const item = (typeof r === 'object' && r !== null && !Array.isArray(r) ? r : {}) as {
          [key: string]: FrontmatterValue
        }
        return {
          match: plainRecord(item.match),
          set: plainRecord(item.set),
        }
      })
    : undefined
  return {
    enabled: raw.enabled === true,
    default_layer: (str(raw.default_layer) ?? 'project') as DepositPolicy['default_layer'],
    default_type: str(raw.default_type) ?? 'other',
    priority: (str(raw.priority) ?? 'medium') as DepositPolicy['priority'],
    require_note: raw.require_note === true,
    rules,
  }
}

function parseMembers(value: FrontmatterValue): TeamMember[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const record = (typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {}) as {
      [key: string]: FrontmatterValue
    }
    return {
      role: str(record.role) ?? '',
      count: typeof record.count === 'number' ? record.count : 1,
    }
  })
}

function parseKnowledge(value: FrontmatterValue): TeamDefinition['knowledge'] {
  const record = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as {
    [key: string]: FrontmatterValue
  }
  const layers = strArray(record.layers).filter((l): l is 'global' | 'project' | 'role' =>
    (['global', 'project', 'role'] as const).includes(l as 'global' | 'project' | 'role'),
  )
  const books = strArray(record.books)
  return books.length > 0 ? { layers, books } : { layers }
}

/**
 * 解析 `## 工作流` 小节（design-v11 §1）。入参可以是**整份 markdown**（内部剥离 frontmatter）
 * 或**正文**（此时由调用方给 `baseLine`）；行号按整份文件计。
 *
 * `raw.headerLine/lastLine`（B-1 写回行区间）按**解析入参字符串**的 0 基行号计：
 * - 入参已是正文（给了 `baseLine`）→ 就是 `lines` 的下标（写方 `patchTeamRaw` 吃同一份 body，天然对齐）；
 * - 入参是整份 markdown（未给 `baseLine`）→ 加回 frontmatter 前缀行数（写方若拿整份 markdown 走
 *   `serializeWorkflowSection` 亦对齐）。
 *
 * 全函数不抛：表格级/行级问题一律降级进 `issues`。
 */
export function parseWorkflowSection(markdown: string, opts: ParseWorkflowSectionOptions = {}): WorkflowParseResult {
  let body: string
  let baseLine: number
  /** `lines` 下标 → **入参字符串**行下标的偏移（见函数头注）。 */
  let inputOffset: number
  if (opts.baseLine !== undefined) {
    body = markdown
    baseLine = opts.baseLine
    inputOffset = 0
  } else {
    ;({ body, baseLine } = locateBody(markdown))
    inputOffset = baseLine
  }
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const bounds = locateWorkflowSection(lines)
  if (bounds === null) {
    const issues: ParseIssue[] = []
    const variant = lines.findIndex((line) => HEADING_VARIANT_RE.test(line.trim()))
    if (variant !== -1) {
      issues.push({
        code: 'workflow_heading_variant',
        line: baseLine + variant + 1,
        message: `未识别的工作流小节标题：「${lines[variant].trim()}」——只认「${WORKFLOW_HEADING}」，该小节按未定义处理`,
      })
    }
    return { stages: [], unmappedColumns: [], sectionMissing: true, issues }
  }
  return scanWorkflowSection(lines, bounds, baseLine, inputOffset)
}

/**
 * ATX 标题层级（v11 派修 M-4）：`#`~`######` **后跟空白**才算标题；非标题 → 0。
 * 用于小节边界（`≤2` 截止）与「直下区间」（`≥3` 截止），保证两处同一判定。
 */
function headingLevelOf(line: string): number {
  const match = /^(#{1,6})\s/.exec(line)
  return match === null ? 0 : match[1].length
}

/** 定位 `## 工作流` 小节（`trim()` 全等匹配标题；下一个 `#`/`##` 标题硬截断）。 */
export function locateWorkflowSection(lines: readonly string[]): WorkflowSectionBounds | null {
  const heading = lines.findIndex((line) => line.trim() === WORKFLOW_HEADING)
  if (heading === -1) return null
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i++) {
    // 同级或更高级标题（`#` / `##`）才是小节边界；`###` 及更深属小节内容（M-4）
    const level = headingLevelOf(lines[i])
    if (level === 1 || level === 2) {
      end = i
      break
    }
  }
  return { heading, end }
}

/** 表头列 → 核心字段；`null` = 未映射列（含同义双列冲突中表序靠后的那列）。 */
export function mapWorkflowColumns(columns: readonly string[]): Array<WorkflowCoreField | null> {
  const used = new Set<WorkflowCoreField>()
  return columns.map((column) => {
    const name = decodeCell(column.trim())
    for (const field of WORKFLOW_CORE_FIELDS) {
      if (used.has(field)) continue
      if (HEADER_SYNONYMS[field].includes(name)) {
        used.add(field)
        return field
      }
    }
    return null
  })
}

/** 解析 `## 工作流` 下的表格，只返回语义 stages（签名与旧实现一致；行级错误降级不抛）。 */
export function parseWorkflowTable(body: string, baseLine = 0): WorkflowStage[] {
  return parseWorkflowSection(body, { baseLine }).stages
}

/**
 * 解析「负责角色」单元格：`+` 分隔多角色；`dev-1/2` 展开实例；`—` 空。
 * 实例记号非法（如 `dev-1/0`）**不抛**：原样保留 token + 记 issue（R-v11-5）。
 */
export function parseRoleCell(cell: string, line: number, issues?: ParseIssue[]): string[] {
  const text = cell.trim()
  if (text === '' || text === '—' || text === '-') return []
  const tokens = text.split('+').map((t) => t.trim()).filter((t) => t !== '' && t !== '—')
  const roles: string[] = []
  for (const token of tokens) {
    const shorthand = /^([^/#]+)\/(\d+)$/.exec(token)
    if (shorthand) {
      const n = Number.parseInt(shorthand[2], 10)
      if (Number.isNaN(n) || n < 1) {
        issues?.push({
          code: 'workflow_role_cell_invalid',
          line,
          message: `工作流表格第 ${line} 行的实例记号不合法：${token}（已原样保留）`,
        })
        roles.push(token)
        continue
      }
      for (let k = 1; k <= n; k++) roles.push(`${shorthand[1].trim()}#${k}`)
    } else {
      roles.push(token)
    }
  }
  return roles
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 剥离 frontmatter 求正文与行号基准（frontmatter 语法错误时不抛，退化为整体当正文）。 */
function locateBody(markdown: string): { body: string; baseLine: number } {
  const normalized = markdown.replace(/\r\n/g, '\n')
  try {
    const { data, body } = splitFrontmatter(normalized)
    if (data === null) return { body: normalized, baseLine: 0 }
    const baseLine = normalized.endsWith(body)
      ? normalized.slice(0, normalized.length - body.length).split('\n').length - 1
      : 0
    return { body, baseLine }
  } catch {
    return { body: normalized, baseLine: 0 }
  }
}

/**
 * `## 工作流` 小节的**原文**（v11 收口）：标题行之后至下一个 `## ` 标题之前的内容，
 * 去**首尾**空行、保留内部行（便于 UI 原样展示自由文本）。
 */
function proseTextOf(lines: readonly string[], bounds: WorkflowSectionBounds): string {
  const slice = lines.slice(bounds.heading + 1, bounds.end)
  let start = 0
  let end = slice.length
  while (start < end && slice[start].trim() === '') start++
  while (end > start && slice[end - 1].trim() === '') end--
  return slice.slice(start, end).join('\n')
}

function scanWorkflowSection(
  lines: readonly string[],
  bounds: WorkflowSectionBounds,
  baseLine: number,
  inputOffset: number,
): WorkflowParseResult {
  const issues: ParseIssue[] = []
  const { heading, end } = bounds

  // 直下区间（M-4）：「`## 工作流` 标题之后」到第一个 `###` 及更深标题之前。
  // 表只在这里认——`###` 之下的表是子小节正文，解析它会让散文静默变流水线（R-v11-2 下沉一级）。
  let directEnd = end
  for (let i = heading + 1; i < end; i++) {
    if (headingLevelOf(lines[i]) >= 3) {
      directEnd = i
      break
    }
  }

  // ① 第一张认定的表：≥2 个核心字段 + 下一行是分隔行（仅直下区间）
  let headerIdx = -1
  for (let i = heading + 1; i < directEnd; i++) {
    const cells = tableCellsAt(lines, i)
    if (cells === null || !isHeaderCandidate(cells)) continue
    const next = tableCellsAt(lines, i + 1)
    if (next === null || !isSeparatorRow(next)) continue
    headerIdx = i
    break
  }
  if (headerIdx === -1) {
    return { stages: [], unmappedColumns: [], prose: true, proseText: proseTextOf(lines, bounds), issues }
  }

  const columns = (tableCellsAt(lines, headerIdx) ?? []).map((cell) => cell.trim())
  const mapping = mapWorkflowColumns(columns)

  // ② 数据行：空白行 / 非表格行 / 下一张表头 三选一即结束（不越过直下区间）
  const rows: string[][] = []
  const rowIds: string[] = []
  const rowLines: number[] = []
  let cursor = headerIdx + 2
  for (; cursor < directEnd; cursor++) {
    const trimmed = lines[cursor].trim()
    if (trimmed === '' || !trimmed.startsWith('|')) break
    let cells = splitTableRow(lines[cursor])
    if (isSeparatorRow(cells)) continue
    const next = tableCellsAt(lines, cursor + 1)
    if (isHeaderCandidate(cells) && next !== null && isSeparatorRow(next)) break
    if (cells.length !== columns.length) {
      const actual = cells.length
      cells = cells.slice(0, columns.length)
      while (cells.length < columns.length) cells.push('')
      issues.push({
        code: 'workflow_row_ragged',
        line: baseLine + cursor + 1,
        message: `工作流表格第 ${baseLine + cursor + 1} 行列数（${actual}）与表头（${columns.length}）不一致，已${actual > columns.length ? '截断' : '补空'}`,
      })
    }
    rows.push(cells)
    rowIds.push(`r${rows.length}`)
    rowLines.push(cursor)
  }

  // ③ 直下区间内的后续表格当正文（旧实现对第二张表抛错——行为变更）。
  // B-1 后第二张表**真的存活**（写回只换表区行区间），故文案与行为对齐。
  for (let i = cursor; i < directEnd; i++) {
    if (lines[i].trim().startsWith('|')) {
      issues.push({
        code: 'workflow_multiple_tables',
        line: baseLine + i + 1,
        message: `「${WORKFLOW_HEADING}」小节内出现第二张表格（第 ${baseLine + i + 1} 行起），按正文保留、不参与工作流解析（只认第一张）`,
      })
      break
    }
  }

  const stages = rows.map((cells, index) =>
    buildStage(cells, mapping, index + 1, baseLine + rowLines[index] + 1, issues),
  )
  // headerLine / lastLine：写回定位的行区间（0 基，按**解析入参字符串**计，见 parseWorkflowSection 头注）；
  // 空表（无数据行）→ lastLine = 分隔行，保证 `| 表头 |` + `| :--- |` 整体被替换。
  const raw: RawWorkflowTable = {
    columns,
    rows,
    rowIds,
    headerLine: headerIdx + inputOffset,
    lastLine: (rowLines.length > 0 ? rowLines[rowLines.length - 1]! : headerIdx + 1) + inputOffset,
  }
  return {
    stages,
    raw,
    unmappedColumns: columns.filter((_, index) => mapping[index] === null),
    issues,
  }
}

function buildStage(
  cells: readonly string[],
  mapping: ReadonlyArray<WorkflowCoreField | null>,
  rowNo: number,
  line: number,
  issues: ParseIssue[],
): WorkflowStage {
  const valueOf = (field: WorkflowCoreField): string => {
    const index = mapping.indexOf(field)
    return index === -1 ? '' : (cells[index] ?? '').trim()
  }
  const orderText = valueOf('order')
  // M-11：严格口径 `/^\d+$/` 且 ≥1 才采纳——`2abc`（parseInt 宽松）、`-3`、`0`
  // 一律按行号回退并记 issue，堵住非正 order 直通 workflow-ir 列映射。
  const parsedOrder = /^\d+$/.test(orderText) ? Number.parseInt(orderText, 10) : Number.NaN
  let order = parsedOrder
  if (Number.isNaN(parsedOrder) || parsedOrder < 1) {
    order = rowNo
    issues.push({
      code: 'workflow_order_defaulted',
      line,
      message: `工作流表格第 ${line} 行的「#」缺失或非正整数（${orderText === '' ? '空' : orderText}）——须为 ≥1 的整数，已按行号回退为 ${rowNo}`,
    })
  }
  return {
    order,
    stage: valueOf('name'),
    roles: mapping.includes('roles') ? parseRoleCell(valueOf('roles'), line, issues) : [],
    mode: valueOf('mode').includes('并行') ? 'parallel' : 'serial',
    input: valueOf('input'),
    output: valueOf('output'),
    done: valueOf('done'),
    reflow: valueOf('reflow'),
  }
}

/** 该行是否为表格行；是则返回解码后的单元格。 */
function tableCellsAt(lines: readonly string[], index: number): string[] | null {
  if (index < 0 || index >= lines.length) return null
  const trimmed = lines[index].trim()
  if (!trimmed.startsWith('|')) return null
  return splitTableRow(lines[index])
}

/** 表头候选：命中 ≥2 个核心字段（同义词 trim 后全等）。 */
function isHeaderCandidate(cells: readonly string[]): boolean {
  return mapWorkflowColumns(cells).filter((field) => field !== null).length >= 2
}

/** 分隔行：`| :--- | --- |`（空单元格容忍）。 */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => cell === '' || SEPARATOR_CELL_RE.test(cell))
}

/**
 * 按裸 `|` 切单元格，但 `\|` 是转义（不切）并就地解码为 `|`（R-v11-4）。
 * `<br>` 与其余 `\` 序列不动（原样文本，GFM 兼容）。
 */
function splitTableRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && text[text.length - 2] !== '\\') text = text.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

/** 解码 `\|` → `|`（其余 `\` 序列不动）。 */
function decodeCell(text: string): string {
  return text.replace(/\\\|/g, '|')
}

function plainRecord(value: FrontmatterValue): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function str(value: FrontmatterValue): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strArray(value: FrontmatterValue): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}
