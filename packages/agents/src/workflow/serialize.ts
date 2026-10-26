/**
 * 步骤表序列化 + `## 步骤表` 小节写回（workflow-asset v2 图编辑器）。
 *
 * 与 `workflow/parse.ts` 成对：parse 是读侧（`\|` 解码、列映射、未映射列入 steps_raw），
 * 本文件是写侧（`|` → `\|`、换行 → `<br>`、按 rowId 合并未映射列值）——口径逐条镜像
 * `team/serialize.ts`（v11 F2 的保真契约：只 splice 表格行区间、未映射列不错行、
 * 小节缺失抛错不静默）。
 */

import { STEP_TABLE_HEADING, mapStepColumns } from './parse.js'
import type { RawWorkflowTable, StepSerializeInput, StepSerializeRow } from '../types.js'

/** 标准八列（= 各核心字段的首个同义词；与 parse.ts 的 STEP_HEADER_SYNONYMS 对应）。 */
type StepField = 'order' | 'step' | 'owner' | 'skills' | 'input' | 'output' | 'done' | 'reflow'

const STEP_COLUMN_NAMES: readonly string[] = ['#', '步骤', '承接', 'skill', '输入工件', '输出工件', '完成判定', '回流路径']

/** 步骤表小节缺失（写回定位失败）——绝不静默丢弃改动。 */
export class StepsSectionMissingError extends Error {
  readonly code = 'steps_section_missing'

  constructor(message = `未找到「${STEP_TABLE_HEADING}」小节`) {
    super(`steps_section_missing: ${message}`)
    this.name = 'StepsSectionMissingError'
  }
}

/** 编辑后的步骤行 → Markdown 表格（列集 = 提交列 > raw 列 > 标准八列）。 */
export function serializeStepTable(input: StepSerializeInput): string {
  const columns = input.columns !== undefined ? [...input.columns] : input.raw !== undefined ? [...input.raw.columns] : [...STEP_COLUMN_NAMES]
  const mapping = mapStepColumns(columns)
  const rawIndexById = new Map<string, number>()
  input.raw?.rowIds.forEach((rowId, index) => rawIndexById.set(rowId, index))

  const rows = input.rows.map((row) =>
    columns.map((column, columnIndex) => {
      const field = mapping[columnIndex]
      if (field !== null) return renderField(field, row)
      const name = column.trim()
      if (row.extra !== undefined && Object.prototype.hasOwnProperty.call(row.extra, name)) {
        return row.extra[name] ?? ''
      }
      if (input.raw !== undefined && row.rowId !== undefined) {
        const index = rawIndexById.get(row.rowId)
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
 * 把渲染好的表格写回正文的 `## 步骤表` 小节（只动小节内的**表格区行区间**）。
 * 有 raw 且行号齐备 → splice `[headerLine, lastLine]`；区间外逐行原样保留。
 * 行号基于**解析入参**（cleanBody）的 0 基行号——调用方对同一字符串 parse/serialize 天然对齐。
 * 小节不存在 → `StepsSectionMissingError`。
 */
export function serializeStepSection(body: string, table: string, raw?: RawWorkflowTable): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const heading = lines.findIndex((l) => l.trim() === STEP_TABLE_HEADING)
  if (heading === -1) throw new StepsSectionMissingError()
  const range = tableRange(raw, lines.length)
  if (range !== null) {
    const spliced = [...lines.slice(0, range.headerLine), ...table.split('\n'), ...lines.slice(range.lastLine + 1)].join('\n')
    return `${spliced.trimEnd()}\n`
  }
  // 无底账回落：标题行后插入表格（保留小节内其余内容到节尾之前）
  let end = lines.length
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i]!.trim())) {
      end = i
      break
    }
  }
  const rebuilt = [...lines.slice(0, heading + 1), '', table, '', ...lines.slice(end)].join('\n')
  return `${rebuilt.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

function tableRange(raw: RawWorkflowTable | undefined, lineCount: number): { headerLine: number; lastLine: number } | null {
  if (raw === undefined) return null
  const { headerLine, lastLine } = raw
  if (headerLine === undefined || lastLine === undefined) return null
  if (!Number.isInteger(headerLine) || !Number.isInteger(lastLine)) return null
  if (headerLine < 0 || lastLine < headerLine || lastLine >= lineCount) return null
  return { headerLine, lastLine }
}

/** 核心字段 → 单元格文本（改写口径：空 owner → `—`）。 */
function renderField(field: StepField, row: StepSerializeRow): string {
  switch (field) {
    case 'order':
      return String(row.order)
    case 'step':
      return row.step
    case 'owner':
      return row.owner.length > 0 ? row.owner.join(' + ') : '—'
    case 'skills':
      return row.skills
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
