/**
 * v11 F2 工作流序列化（design-v11 §2 / v11.1）：列集保真、rowId 行身份合并、转义写侧、
 * 小节写回定位。素材落文件（`test/fixtures/team-workflow/`）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseWorkflowSection } from '../src/team/parse.js'
import { serializeWorkflowSection, serializeWorkflowTable, WorkflowSectionMissingError } from '../src/team/serialize.js'
import type { WorkflowParseResult, WorkflowSerializeRow } from '../src/types.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/team-workflow/', import.meta.url))

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** 解析结果 → 序列化行（rowId 来自 raw，语义字段来自 stages）——编辑器的最简提交形态。 */
function rowsOf(result: WorkflowParseResult): WorkflowSerializeRow[] {
  return result.stages.map((stage, index) => ({
    rowId: result.raw?.rowIds[index],
    order: stage.order,
    stage: stage.stage,
    roles: stage.roles,
    mode: stage.mode,
    input: stage.input,
    output: stage.output,
    done: stage.done,
    reflow: stage.reflow,
  }))
}

/** 未映射列 × 行的值矩阵（往返保真的断言对象）。 */
function unmappedMatrix(result: WorkflowParseResult): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (result.raw === undefined) return out
  for (const column of result.unmappedColumns) {
    const index = result.raw.columns.indexOf(column)
    out[column] = result.raw.rows.map((row) => row[index] ?? '')
  }
  return out
}

/**
 * 行级降级 issue 是**读侧归一**：serialize 把归一后的值写回（`2abc` → 行号、ragged → 对齐列数），
 * 重解析后这些 issue 自然消失——不是数据丢失。故 round-trip 的 issues 等价断言按**结构级**比较；
 * 结构级 issue（如 `workflow_multiple_tables`：第二张表被删即消失）必须逐条等价（B-1）。
 */
const ROW_LEVEL_ISSUE_CODES = new Set(['workflow_row_ragged', 'workflow_order_defaulted', 'workflow_role_cell_invalid'])
const structuralIssues = (result: WorkflowParseResult) =>
  result.issues.filter((issue) => !ROW_LEVEL_ISSUE_CODES.has(issue.code))

const ROUND_TRIP_FIXTURES = [
  'standard-8col.md',
  'extra-columns.md',
  'reordered.md',
  'no-roles.md',
  'escapes.md',
  'sort-unmapped.md',
  'ragged-order.md',
  'two-tables.md',
  'mixed-content.md',
]

describe('serialize 往返等价（保真口径：stages / 列集与列序 / 未映射列值 / 结构级 issues）', () => {
  for (const name of ROUND_TRIP_FIXTURES) {
    it(`${name}：parse(serialize(parse(md))) 与 parse(md) 深等价`, () => {
      const md = fixture(name)
      const before = parseWorkflowSection(md)
      const table = serializeWorkflowTable({ raw: before.raw, rows: rowsOf(before) })
      const after = parseWorkflowSection(serializeWorkflowSection(md, table, before.raw))
      expect(after.stages).toEqual(before.stages)
      expect(after.raw?.columns).toEqual(before.raw?.columns)
      expect(unmappedMatrix(after)).toEqual(unmappedMatrix(before))
      // B-1：结构级 issue 逐条等价——旧实现整节替换会把第二张表删掉，此断言随即失败
      expect(structuralIssues(after)).toEqual(structuralIssues(before))
    })
  }
})

describe('serializeWorkflowSection：只换表格区行区间（B-1 红线回归）', () => {
  it('小节内 段落 / 引用块 / 第二张表 逐行存活，不在表格区的内容一律不动', () => {
    const md = fixture('mixed-content.md')
    const before = parseWorkflowSection(md)
    const table = serializeWorkflowTable({ raw: before.raw, rows: rowsOf(before) })
    const out = serializeWorkflowSection(md, table, before.raw)

    expect(out).toContain('本团队的工作流如下（这段说明不属于表格，保存时不得删除）：')
    expect(out).toContain('> 补充说明：引用块也不是表格，保存必须保留。')
    expect(out).toContain('| 阶段 | 说明 |')
    expect(out).toContain('| 附 | 第二张表按正文保留 |')
    expect(out).toContain('## 备注')
    expect(out).toContain('下一小节正文。')
    // 第二张表未被删 → workflow_multiple_tables 仍在（旧实现整节替换后此 issue 消失）
    expect(parseWorkflowSection(out).issues.map((i) => i.code)).toEqual(['workflow_multiple_tables'])
  })

  it('无 raw（prose 转换）→ 仍整节替换（原文由 `原文` 列承载，既有语义不变）', () => {
    const md = fixture('mixed-content.md')
    const table = serializeWorkflowTable({
      rows: [
        { order: 1, stage: '探索', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '', extra: { 原文: '本团队的工作流如下' } },
      ],
    })
    const out = serializeWorkflowSection(md, table)
    expect(out).toContain('| 原文 |')
    // 整节替换：小节内原段落/引用/第二张表不再保留（原文只存于 `原文` 列）
    expect(out).not.toContain('本团队的工作流如下（这段说明不属于表格，保存时不得删除）：')
    expect(out).not.toContain('| 阶段 | 说明 |')
    expect(out).toContain('## 备注')
  })
})

describe('serialize 列集通道与按列名寻址（v11 派修 M-2 / M-13）', () => {
  /** 把渲染好的表单独包成一个小节再解析（校验列集/寻址）。 */
  const parseTable = (table: string): WorkflowParseResult =>
    parseWorkflowSection(['## 工作流', '', table].join('\n'), { baseLine: 0 })

  it('M-13：提交列序与 raw 列序不同 → raw 回落**按列名**寻址（不按位置错位）', () => {
    const md = fixture('sort-unmapped.md')
    const before = parseWorkflowSection(md)
    const table = serializeWorkflowTable({
      // 「负责人」是新列（raw 里没有），插在「备注」之前 → 本表 columnIndex 与 raw 列位错开
      columns: ['#', '阶段', '负责角色', '串/并行', '输入', '输出', '完成判定', '回流路径', '负责人', '备注'],
      raw: before.raw,
      rows: rowsOf(before),
    })
    const after = parseTable(table)
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    const ownerIndex = after.raw?.columns.indexOf('负责人') ?? -1
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['甲的备注', '乙的备注', '丙的备注'])
    expect(after.raw?.rows.map((row) => row[ownerIndex])).toEqual(['', '', ''])
  })

  it('M-2：增自定义列带值 → 按列名取 extra 落盘；原未映射列仍按名回落', () => {
    const md = fixture('sort-unmapped.md')
    const before = parseWorkflowSection(md)
    const columns = [...(before.raw?.columns ?? []), '负责人']
    const owners = ['张三', '李四', '王五']
    const rows = rowsOf(before).map((row, index) => ({ ...row, extra: { 负责人: owners[index]! } }))
    const after = parseTable(serializeWorkflowTable({ columns, raw: before.raw, rows }))
    expect(after.raw?.columns).toEqual(columns)
    const ownerIndex = after.raw?.columns.indexOf('负责人') ?? -1
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    expect(after.raw?.rows.map((row) => row[ownerIndex])).toEqual(owners)
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['甲的备注', '乙的备注', '丙的备注'])
  })

  it('M-2：删未映射列 → 该列与值不入表（值随列弃）', () => {
    const md = fixture('sort-unmapped.md')
    const before = parseWorkflowSection(md)
    const columns = (before.raw?.columns ?? []).filter((column) => column !== '备注')
    const table = serializeWorkflowTable({ columns, raw: before.raw, rows: rowsOf(before) })
    expect(table.split('\n')[0]).toBe('| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |')
    expect(table).not.toContain('甲的备注')
  })

  it('M-2：删核心字段列 → 该字段不入表（值随列弃），其余字段照常', () => {
    const md = fixture('standard-8col.md')
    const before = parseWorkflowSection(md)
    const columns = (before.raw?.columns ?? []).filter((column) => column !== '输入')
    const after = parseTable(serializeWorkflowTable({ columns, raw: before.raw, rows: rowsOf(before) }))
    expect(after.raw?.columns).not.toContain('输入')
    expect(after.stages.map((stage) => stage.stage)).toEqual(before.stages.map((stage) => stage.stage))
    expect(after.stages.every((stage) => stage.input === '')).toBe(true)
  })
})

describe('serialize 显式改写口径（fixture 断言改写后形态）', () => {
  it('实例记号展开为 `dev-1#1 + dev-1#2`；空/`—` mode → `串行`；列集 = 提交列集', () => {
    const table = serializeWorkflowTable({
      columns: ['#', '阶段', '负责角色', '串/并行'],
      rows: [
        {
          order: 1,
          stage: '收口',
          roles: ['dev-1#1', 'dev-1#2'],
          mode: 'serial',
          input: '',
          output: '',
          done: '',
          reflow: '',
        },
      ],
    })
    expect(table).toBe(
      [
        '| # | 阶段 | 负责角色 | 串/并行 |',
        '| :--- | :--- | :--- | :--- |',
        '| 1 | 收口 | dev-1#1 + dev-1#2 | 串行 |',
      ].join('\n'),
    )
  })

  it('无表格起点（无 raw / 无 columns）→ 核心八列 + `原文`（自由文本转换唯一起点）', () => {
    const table = serializeWorkflowTable({
      rows: [
        {
          order: 1,
          stage: '探索',
          roles: [],
          mode: 'serial',
          input: '',
          output: '',
          done: '',
          reflow: '',
          extra: { 原文: '自由文本\n第二行' },
        },
      ],
    })
    expect(table.split('\n')[0]).toBe('| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 | 原文 |')
    expect(table.split('\n')[2]).toBe('| 1 | 探索 | — | 串行 |  |  |  |  | 自由文本<br>第二行 |')
  })

  it('写侧转义：`|` → `\\|`、单元格换行 → `<br>`（表头同规则）', () => {
    const table = serializeWorkflowTable({
      columns: ['阶段', '输出'],
      rows: [
        { order: 1, stage: 'a|b', roles: [], mode: 'serial', input: '', output: 'x\ny', done: '', reflow: '' },
      ],
    })
    expect(table).toBe(['| 阶段 | 输出 |', '| :--- | :--- |', '| a\\|b | x<br>y |'].join('\n'))
  })
})

describe('serialize 行身份合并（R-v11-3）', () => {
  it('排序 + 删除 + 新行：未映射列按 rowId 跟随，不整体错行', () => {
    const md = fixture('sort-unmapped.md')
    const before = parseWorkflowSection(md)
    const raw = before.raw!
    const orderRow = (rowId: string, stage: string, order: number): WorkflowSerializeRow => ({
      rowId,
      order,
      stage,
      roles: ['dev-1'],
      mode: 'serial',
      input: 'i',
      output: 'o',
      done: 'd',
      reflow: '—',
    })
    const rows: WorkflowSerializeRow[] = [
      orderRow(raw.rowIds[2], '丙', 1),
      orderRow(raw.rowIds[0], '甲', 2),
      // 无 rowId = 新行（按序插入，未映射列空）
      { order: 3, stage: '丁', roles: ['dev-1'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '—' },
    ]
    const after = parseWorkflowSection(serializeWorkflowSection(md, serializeWorkflowTable({ raw, rows })))
    expect(after.stages.map((s) => s.stage)).toEqual(['丙', '甲', '丁'])
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['丙的备注', '甲的备注', ''])
  })

  it('新行可用 `extra` 显式给未映射列值（原 raw 有但未提交的 rowId → 该行连同未映射列删除）', () => {
    const md = fixture('sort-unmapped.md')
    const raw = parseWorkflowSection(md).raw!
    const rows: WorkflowSerializeRow[] = [
      {
        rowId: raw.rowIds[1],
        order: 1,
        stage: '乙',
        roles: ['dev-1'],
        mode: 'serial',
        input: 'i',
        output: 'o',
        done: 'd',
        reflow: '—',
      },
      {
        order: 2,
        stage: '丁',
        roles: ['dev-1'],
        mode: 'serial',
        input: 'i',
        output: 'o',
        done: 'd',
        reflow: '—',
        extra: { 备注: '新备注' },
      },
    ]
    const after = parseWorkflowSection(serializeWorkflowSection(md, serializeWorkflowTable({ raw, rows })))
    expect(after.stages.map((s) => s.stage)).toEqual(['乙', '丁'])
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['乙的备注', '新备注'])
  })
})

describe('serializeWorkflowSection：写回定位', () => {
  it('小节不存在 → workflow_section_missing（不自动插入、不静默空操作）', () => {
    let caught: unknown
    try {
      serializeWorkflowSection(fixture('section-missing.md'), '| # |\n| :--- |')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(WorkflowSectionMissingError)
    expect((caught as WorkflowSectionMissingError).code).toBe('workflow_section_missing')
  })

  it('只替换 `## 工作流` 小节内表格区：前后小节与 frontmatter 语义不动', () => {
    const md = fixture('extra-columns.md')
    const before = parseWorkflowSection(md)
    const out = serializeWorkflowSection(md, serializeWorkflowTable({ raw: before.raw, rows: rowsOf(before) }))
    expect(out).toContain('team_id: extra-col-team')
    expect(out).toContain('## 备注')
    expect(out).toContain('多余列靠 rowId 合并')
    expect(out).toContain('| 备注 | 负责人 |')
    expect(out.trimEnd().endsWith('多余列靠 rowId 合并，不随阶段增删排序错行。')).toBe(true)
  })
})
