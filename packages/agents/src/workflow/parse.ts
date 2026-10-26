/**
 * 工作流单元解析（`<workflows_dir>/<id>.md` → WorkflowDefinition，workflow-asset.md）。
 *
 * 形态：frontmatter 五键（workflow/name/level/binds/skills）+ 正文 `## 步骤表` 表格 + 自由正文。
 * 行级错误**不抛异常**，降级进 ParseIssue（同团队工作流表的 R-v11-5 口径：坏行不炸整库）。
 * 步骤表的「承接」列是自由文本（可写「队长 / 人 / 独立实例」），角色绑定强校验走 frontmatter
 * `binds`（见 workflow/validate.ts）——列上做强校验会制造假门禁。
 */

import {
  FrontmatterError,
  splitFrontmatter,
  stripPrismMarkerTail,
  type FrontmatterData,
  type FrontmatterValue,
} from '../frontmatter.js'
import type { ParseIssue, RawWorkflowTable, WorkflowDefinition, WorkflowStep } from '../types.js'

/** 工作流文件解析失败。 */
export class WorkflowParseError extends Error {
  readonly code: 'no_frontmatter' | 'parse_failed'
  readonly path?: string

  constructor(code: WorkflowParseError['code'], message: string, path?: string) {
    super(`${code}: ${message}${path ? ` (${path})` : ''}`)
    this.name = 'WorkflowParseError'
    this.code = code
    this.path = path
  }
}

export interface ParseWorkflowOptions {
  /** 来源文件路径（记录到 sourcePath）。 */
  sourcePath?: string
}

/** 步骤表小节标题。 */
export const STEP_TABLE_HEADING = '## 步骤表'

/** 分隔行单元格：`---` / `:---` / `---:` / `:---:`。 */
const SEPARATOR_CELL_RE = /^:?-{2,}:?$/

/** 步骤表核心字段序。 */
export const STEP_CORE_FIELDS = ['order', 'step', 'owner', 'skills', 'input', 'output', 'done', 'reflow'] as const

export type StepCoreField = (typeof STEP_CORE_FIELDS)[number]

/** 核心字段 → 认的列名（trim 后全等，首中即用）。 */
const STEP_HEADER_SYNONYMS: Readonly<Record<StepCoreField, readonly string[]>> = {
  order: ['#', '序号', 'Order'],
  step: ['步骤', '名称', 'Step'],
  owner: ['承接', '负责', 'Owner'],
  skills: ['skill', 'Skill', '技能'],
  input: ['输入工件', '输入', 'Input'],
  output: ['输出工件', '输出', 'Output'],
  done: ['完成判定', '判定', 'Done'],
  reflow: ['回流路径', '回流', 'Reflow'],
}

/** 解析工作流单元 Markdown。frontmatter 缺失/语法不支持抛 WorkflowParseError；步骤表坏行降级 issues。 */
export function parseWorkflowMarkdown(raw: string, opts: ParseWorkflowOptions = {}): WorkflowDefinition {
  let data: FrontmatterData | null
  let body: string
  try {
    ;({ data, body } = splitFrontmatter(raw))
  } catch (err) {
    if (err instanceof FrontmatterError) {
      throw new WorkflowParseError(err.code === 'parse_unsupported' ? 'parse_failed' : 'parse_failed', err.message, opts.sourcePath)
    }
    throw new WorkflowParseError('parse_failed', err instanceof Error ? err.message : String(err), opts.sourcePath)
  }
  if (data === null) {
    throw new WorkflowParseError('no_frontmatter', '缺少 frontmatter（--- 头）', opts.sourcePath)
  }
  const cleanBody = stripPrismMarkerTail(body)
  const issues: ParseIssue[] = []
  const { steps, raw: stepsRaw } = parseStepTable(cleanBody, issues)
  const wf: WorkflowDefinition = {
    workflow: str(data.workflow) ?? '',
    name: str(data.name) ?? '',
    level: (str(data.level) === 'team' ? 'team' : 'role') as WorkflowDefinition['level'],
    binds: strArray(data.binds),
    skills: strArray(data.skills),
    steps,
    ...(stepsRaw !== null ? { steps_raw: stepsRaw } : {}),
    body: cleanBody,
  }
  if (opts.sourcePath !== undefined) wf.sourcePath = opts.sourcePath
  if (issues.length > 0) {
    wf.issues = issues.map((i) => ({ level: 'warning' as const, code: i.code, message: i.message, ...(i.line !== undefined ? { where: `L${i.line}` } : {}) }))
  }
  return wf
}

/** 步骤表解析结果：steps（语义投影）+ raw（底账；无表格 → null）。 */
interface StepTableParse {
  steps: WorkflowStep[]
  raw: RawWorkflowTable | null
}

/**
 * 解析正文 `## 步骤表` 小节的第一张表格（到下一个 `#`/`##` 标题为止；无表格 → 空数组 + issue）。
 * `raw` 的 headerLine/lastLine 是**解析入参字符串**（cleanBody）里的 0 基行号——写回定位由
 * write.ts 对文件本体重扫（同一单点），不跨层信任存储的行号。
 */
function parseStepTable(body: string, issues: ParseIssue[]): StepTableParse {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const headingIdx = lines.findIndex((l) => l.trim() === STEP_TABLE_HEADING)
  if (headingIdx === -1) {
    issues.push({ code: 'steps_section_missing', message: `正文缺少「${STEP_TABLE_HEADING}」小节（步骤表是工作流单元的必要组成）` })
    return { steps: [], raw: null }
  }
  // 小节边界：下一个 # / ## 标题（### 属小节内不截断，同 team/parse 口径）
  let sectionEnd = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i]!.trim())) {
      sectionEnd = i
      break
    }
  }
  // 找表头：≥2 核心列命中 + 下一行是分隔行
  let headerIdx = -1
  for (let i = headingIdx + 1; i < sectionEnd - 1; i++) {
    const cells = rowCells(lines[i]!)
    if (cells === null) continue
    const next = rowCells(lines[i + 1]!)
    const mapped = mapStepColumns(cells)
    if (mapped.filter((m) => m !== null).length >= 2 && next !== null && isSeparatorRow(next)) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) {
    issues.push({ code: 'steps_table_missing', line: headingIdx + 1, message: `「${STEP_TABLE_HEADING}」小节内未找到表格（需表头 + 分隔行）` })
    return { steps: [], raw: null }
  }
  const columns = rowCells(lines[headerIdx]!)!
  const mapping = mapStepColumns(columns)
  const steps: WorkflowStep[] = []
  const rows: string[][] = []
  const rowIds: string[] = []
  const rowLines: number[] = []
  let sawSecondTable = false
  for (let cursor = headerIdx + 2; cursor < sectionEnd; cursor++) {
    const trimmed = lines[cursor]!.trim()
    if (trimmed === '' || !trimmed.startsWith('|')) {
      // 表格结束；其后若再出现表格行 → 只认第一张（记 issue）
      if (!sawSecondTable) {
        for (let j = cursor; j < sectionEnd; j++) {
          if (lines[j]!.trim().startsWith('|')) {
            issues.push({ code: 'steps_multiple_tables', line: j + 1, message: `「${STEP_TABLE_HEADING}」小节内出现第二张表格（第 ${j + 1} 行起），按正文保留、不参与解析（只认第一张）` })
            sawSecondTable = true
            break
          }
        }
      }
      break
    }
    let cells = rowCells(trimmed)!
    if (isSeparatorRow(cells)) continue
    if (cells.length !== columns.length) {
      const actual = cells.length
      cells = cells.slice(0, columns.length)
      while (cells.length < columns.length) cells.push('')
      issues.push({
        code: 'step_row_ragged',
        line: cursor + 1,
        message: `步骤表第 ${cursor + 1} 行列数（${actual}）与表头（${columns.length}）不一致，已${actual > columns.length ? '截断' : '补空'}`,
      })
    }
    steps.push(buildStep(cells, mapping, steps.length + 1, cursor + 1, issues))
    rows.push(cells)
    rowIds.push(`r${rows.length}`)
    rowLines.push(cursor)
  }
  return {
    steps,
    raw: {
      columns,
      rows,
      rowIds,
      headerLine: headerIdx,
      lastLine: rowLines.length > 0 ? rowLines[rowLines.length - 1]! : headerIdx + 1,
    },
  }
}

function buildStep(
  cells: readonly string[],
  mapping: ReadonlyArray<StepCoreField | null>,
  rowNo: number,
  line: number,
  issues: ParseIssue[],
): WorkflowStep {
  const valueOf = (field: StepCoreField): string => {
    const index = mapping.indexOf(field)
    return index === -1 ? '' : (cells[index] ?? '').trim()
  }
  const orderText = valueOf('order')
  const parsed = /^\d+$/.test(orderText) ? Number.parseInt(orderText, 10) : Number.NaN
  let order = parsed
  if (Number.isNaN(parsed) || parsed < 1) {
    order = rowNo
    issues.push({
      code: 'step_order_defaulted',
      line,
      message: `步骤表第 ${line} 行的「#」缺失或非正整数（${orderText === '' ? '空' : orderText}）——已按行号回退为 ${rowNo}`,
    })
  }
  const ownerCell = valueOf('owner')
  return {
    order,
    step: valueOf('step'),
    owner: ownerCell.split(/[+＋]/).map((s) => s.trim()).filter((s) => s !== ''),
    skills: valueOf('skills'),
    input: valueOf('input'),
    output: valueOf('output'),
    done: valueOf('done'),
    reflow: valueOf('reflow'),
  }
}

/** 列名 → 核心字段（未映射列 → null）。serialize 侧共用（单一映射真相）。 */
export function mapStepColumns(columns: readonly string[]): Array<StepCoreField | null> {
  return columns.map((col) => {
    for (const field of STEP_CORE_FIELDS) {
      if (STEP_HEADER_SYNONYMS[field].includes(col)) return field
    }
    return null
  })
}

/** 表格行 → 单元格（去首尾管道；非表格行 → null）。
 *  先按「未被反斜杠转义的 |」切分（`\|` 是单元格内的字面管道，切分时必须避让），再逐格还原 `\|` → `|`。 */
function rowCells(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  let inner = trimmed.slice(1)
  if (inner.endsWith('|') && !inner.endsWith('\\|')) inner = inner.slice(0, -1)
  return inner.split(/(?<!\\)\|/).map((c) => unescapeCell(c.trim()))
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((c) => SEPARATOR_CELL_RE.test(c))
}

/** 单元格转义解码（`\|` → `|`；同 team 工作流表的转义契约）。 */
function unescapeCell(cell: string): string {
  return cell.replaceAll('\\|', '|')
}

function str(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strArray(value: FrontmatterValue | undefined): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}
