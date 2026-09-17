/**
 * 工作流表格序列化 + `## 工作流` 小节写回（v11 F2，design-v11 §2 / v11.1）。
 *
 * 与 `team/parse.ts` 成对：parse 是读侧（`\|` → `|` 解码、列映射、未映射列入 raw），
 * 本文件是写侧（`|` → `\|`、单元格换行 → `<br>`、按 rowId 合并未映射列值）。
 *
 * **写回定位**：只替换 `## 工作流` 小节内的表格区，小节前后内容**语义**不动（v11.1 不再
 * 承诺字节不动——调用方 `patchTeamRaw` 对全 body 的空白归一化是既有行为，R-v11-10）。
 * 小节不存在 → 抛 `workflow_section_missing`，**不自动插入、不静默空操作**（R-v11-11）。
 *
 * **行身份合并**（R-v11-3）：提交行的 `rowId` 对齐原 raw 行合并未映射列值——阶段上移/下移/
 * 增删后，未映射列不会整体错行；原 raw 有而未提交的 rowId 连同其未映射列一起删除。
 */

import { CORE_COLUMN_NAMES, locateWorkflowSection, mapWorkflowColumns, WORKFLOW_HEADING } from './parse.js'
import type {
  RawWorkflowTable,
  WorkflowCoreField,
  WorkflowSerializeInput,
  WorkflowSerializeRow,
} from '../types.js'

/** 工作流小节缺失（写回定位失败）——绝不静默丢弃改动。 */
export class WorkflowSectionMissingError extends Error {
  readonly code = 'workflow_section_missing'

  constructor(message = `未找到「${WORKFLOW_HEADING}」小节`) {
    super(`workflow_section_missing: ${message}`)
    this.name = 'WorkflowSectionMissingError'
  }
}

/**
 * 编辑后的阶段行 → Markdown 表格。
 *
 * 列集 = 提交列集（`columns`）> 原 raw 列集（`raw.columns`）> 核心八列 + `原文`
 * （无表格起点：新建 / 自由文本转换，design-v11 §2 / R-v11-9）。
 */
export function serializeWorkflowTable(input: WorkflowSerializeInput): string {
  const columns = resolveColumns(input)
  const mapping = mapWorkflowColumns(columns)
  const rawIndexById = new Map<string, number>()
  input.raw?.rowIds.forEach((rowId, index) => rawIndexById.set(rowId, index))

  const rows = input.rows.map((row) =>
    columns.map((column, columnIndex) => {
      const field = mapping[columnIndex]
      if (field !== null) return renderField(field, row)
      // 未映射列：提交列名先去空白（= parse 侧的列名归一），extra 与 raw 回落都按**列名**寻址
      const name = column.trim()
      if (row.extra !== undefined && Object.prototype.hasOwnProperty.call(row.extra, name)) {
        return row.extra[name] ?? ''
      }
      if (input.raw !== undefined && row.rowId !== undefined) {
        const index = rawIndexById.get(row.rowId)
        // M-13：raw 回落**按列名寻址**（`raw.columns.indexOf(name)`），不能用本表 columnIndex——
        // 列集通道一开（提交 columns 与 raw.columns 列序/列集不同）按位置取即整体错位。
        if (index !== undefined) {
          const rawColumn = input.raw.columns.indexOf(name)
          if (rawColumn !== -1) return input.raw.rows[index]?.[rawColumn] ?? ''
        }
      }
      return ''
    }),
  )

  const header = `| ${columns.map(encodeCell).join(' | ')} |`
  const separator = `| ${columns.map(() => ':---').join(' | ')} |`
  return [header, separator, ...rows.map((cells) => `| ${cells.map(encodeCell).join(' | ')} |`)].join('\n')
}

/**
 * 把渲染好的表格写回正文的 `## 工作流` 小节（只动该小节内的**表格区行区间**）。
 *
 * **写回范围（v11 派修 B-1，红线 R7）**：
 * - 给了 `raw` 且 `headerLine/lastLine` 齐备 → **只 splice `[headerLine, lastLine]` 行区间**为新表格；
 *   区间外的段落/引用块/第二张表**逐行原样保留**（旧实现整节替换 → 静默删正文，零诊断）；
 * - 无 `raw`（prose → 表格转换，原文由 `原文` 列承载）→ 保持既有整节替换语义。
 *
 * 行号基于**解析输入**的 0 基行号；调用方 `patchTeamRaw` 里 parse 与 serialize 吃同一份
 * `nextBody`，天然对齐。小节不存在 → `WorkflowSectionMissingError`（code = `workflow_section_missing`）。
 */
export function serializeWorkflowSection(body: string, table: string, raw?: RawWorkflowTable): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const bounds = locateWorkflowSection(lines)
  if (bounds === null) throw new WorkflowSectionMissingError()
  const range = tableRange(raw, lines.length)
  if (range !== null) {
    const { headerLine, lastLine } = range
    const spliced = [
      ...lines.slice(0, headerLine),
      ...table.split('\n'),
      ...lines.slice(lastLine + 1),
    ].join('\n')
    return `${spliced.trimEnd()}\n`
  }
  const rebuilt = [
    ...lines.slice(0, bounds.heading + 1),
    '',
    table,
    '',
    ...lines.slice(bounds.end),
  ].join('\n')
  return `${rebuilt.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * 取 raw 的写回行区间：缺 raw / 缺行号 / 行号非法（越界 / 倒置）→ null（回落整节替换，
 * 不做半截 splice 把区间外的行静默截掉）。
 */
function tableRange(raw: RawWorkflowTable | undefined, lineCount: number): { headerLine: number; lastLine: number } | null {
  if (raw === undefined) return null
  const { headerLine, lastLine } = raw
  if (headerLine === undefined || lastLine === undefined) return null
  if (!Number.isInteger(headerLine) || !Number.isInteger(lastLine)) return null
  if (headerLine < 0 || lastLine < headerLine || lastLine >= lineCount) return null
  return { headerLine, lastLine }
}

function resolveColumns(input: WorkflowSerializeInput): string[] {
  if (input.columns !== undefined) return [...input.columns]
  if (input.raw !== undefined) return [...input.raw.columns]
  return [...CORE_COLUMN_NAMES, '原文']
}

/** 核心字段 → 单元格文本（改写口径：空 roles → `—`；非 parallel → `串行`）。 */
function renderField(field: WorkflowCoreField, row: WorkflowSerializeRow): string {
  switch (field) {
    case 'order':
      return String(row.order)
    case 'name':
      return row.stage
    case 'roles':
      return row.roles.length > 0 ? row.roles.join(' + ') : '—'
    case 'mode':
      return row.mode === 'parallel' ? '并行' : '串行'
    case 'input':
      return row.input
    case 'output':
      return row.output
    case 'done':
      return row.done
    case 'reflow':
      return row.reflow
  }
}

/** 写侧转义：`|` → `\|`；单元格内换行 → `<br>`（表头同规则）。 */
function encodeCell(value: string): string {
  return value.trim().replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>')
}
