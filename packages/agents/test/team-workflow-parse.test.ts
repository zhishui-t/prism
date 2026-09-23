/**
 * v11 F2 弹性工作流解析（design-v11 §1 / v11.1）。
 *
 * 素材一律取自 `test/fixtures/team-workflow/*.md`（落文件，非内联字符串）：
 * 非标准形态（prose / 无 roles 列 / 多余列 / 列序不同 / 两张表 / 转义 / 行级降级）
 * 与标准 8 列快照（`standard-8col.md` 复制 `examples/teams/delivery.md`）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { splitFrontmatter } from '../src/frontmatter.js'
import {
  mapWorkflowColumns,
  parseTeamMarkdown,
  parseWorkflowSection,
  parseWorkflowTable,
} from '../src/team/parse.js'
import type { WorkflowStage } from '../src/types.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/team-workflow/', import.meta.url))

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

function fixtureJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T
}

const STANDARD_COLUMNS = ['#', '阶段', '负责角色', '串/并行', '输入', '输出', '完成判定', '回流路径']

describe('parseWorkflowSection：标准 8 列回归锁（delivery 同构）', () => {
  it('stages 逐字段等价 + raw 底账齐备 + 零 issue', () => {
    const md = fixture('standard-8col.md')
    const result = parseWorkflowSection(md)
    expect(result.stages).toEqual(fixtureJson<WorkflowStage[]>('standard-8col.stages.json'))
    expect(result.raw?.columns).toEqual(STANDARD_COLUMNS)
    expect(result.raw?.rowIds).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'])
    expect(result.raw?.rows).toHaveLength(9)
    expect(result.unmappedColumns).toEqual([])
    expect(result.prose).toBeUndefined()
    expect(result.sectionMissing).toBeUndefined()
    expect(result.issues).toEqual([])
  })

  it('parseTeamMarkdown 对外行为不变：workflow 只含语义 stages（与 parseWorkflowSection 同源）', () => {
    const md = fixture('standard-8col.md')
    expect(parseTeamMarkdown(md).workflow).toEqual(parseWorkflowSection(md).stages)
  })

  it('delivery 的「前端三技能组合」普通表不被误吞（小节硬截断）', () => {
    // 该小节表头 `| 阶段 | 技能 | 做什么 | 产物 |` 只含一个核心字段；delivery 文件里还有
    // `| 步骤 | 承接 | … |` —— 二者都不该进入工作流（旧实现无小节边界时会扫到文件尾）
    expect(parseWorkflowSection(fixture('standard-8col.md')).stages).toHaveLength(9)
  })
})

describe('parseWorkflowSection：prose 与 sectionMissing 两态（R-v11-7）', () => {
  it('prose：小节存在但无表格 → stages [] / prose true / 无 raw；后续小节含「阶段+输出」表也不误命中', () => {
    const md = fixture('prose.md')
    const result = parseWorkflowSection(md)
    expect(result.prose).toBe(true)
    expect(result.sectionMissing).toBeUndefined()
    expect(result.stages).toEqual([])
    expect(result.raw).toBeUndefined()
    expect(result.unmappedColumns).toEqual([])
    expect(result.issues).toEqual([])
    expect(parseTeamMarkdown(md).workflow).toEqual([])
  })

  it('proseText：小节原文（去首尾空行、保留内部行）；表格态 / sectionMissing 无此字段', () => {
    const prose = parseWorkflowSection(fixture('prose.md'))
    expect(prose.proseText).toBe('先探索，再设计，最后交付。没有表格。')

    expect(parseWorkflowSection(fixture('standard-8col.md')).proseText).toBeUndefined()
    expect(parseWorkflowSection(fixture('section-missing.md')).proseText).toBeUndefined()
  })

  it('proseText：仅去首尾空行，内部空行与行序保留', () => {
    const result = parseWorkflowSection('## 工作流\n\n第一段\n\n第二段\n\n## 其他\n\nx\n', { baseLine: 0 })
    expect(result.prose).toBe(true)
    expect(result.proseText).toBe('第一段\n\n第二段')
  })

  it('sectionMissing：全文无 `## 工作流` → sectionMissing true（与 prose 区分）', () => {
    const result = parseWorkflowSection(fixture('section-missing.md'))
    expect(result.sectionMissing).toBe(true)
    expect(result.prose).toBeUndefined()
    expect(result.stages).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('标题变体（`##工作流` 无空格）不硬兼容 → sectionMissing + workflow_heading_variant', () => {
    const result = parseWorkflowSection(fixture('heading-variant.md'))
    expect(result.sectionMissing).toBe(true)
    expect(result.stages).toEqual([])
    expect(result.issues.map((i) => i.code)).toEqual(['workflow_heading_variant'])
  })
})

describe('parseWorkflowSection：缺列 / 多余列 / 列序不同 / 两张表', () => {
  it('无「负责角色」列：核心字段照解析（roles 全空），unmappedColumns 为空', () => {
    const result = parseWorkflowSection(fixture('no-roles.md'))
    expect(result.stages.map((s) => s.stage)).toEqual(['探索', '开发', '交付'])
    expect(result.stages.every((s) => s.roles.length === 0)).toBe(true)
    expect(result.stages[1].mode).toBe('parallel')
    expect(result.stages[2].reflow).toBe('—')
    expect(result.raw?.columns).toEqual(['#', '阶段', '串/并行', '输入', '输出', '完成判定', '回流路径'])
    expect(result.unmappedColumns).toEqual([])
    expect(result.issues).toEqual([])
  })

  it('多余列：列集原样保留 / 未映射列入 unmappedColumns / 值留在 raw（不丢）', () => {
    const result = parseWorkflowSection(fixture('extra-columns.md'))
    expect(result.stages[0].roles).toEqual(['dev-1#1', 'dev-1#2'])
    expect(result.unmappedColumns).toEqual(['备注', '负责人'])
    expect(result.raw?.columns).toEqual([...STANDARD_COLUMNS, '备注', '负责人'])
    const noteIndex = result.raw?.columns.indexOf('备注') ?? -1
    expect(result.raw?.rows.map((row) => row[noteIndex])).toEqual(['时间盒 2 天', '冒烟先行', '无'])
    expect(result.issues).toEqual([])
  })

  it('列序不同：按列名映射（不按列位），列序原样保留', () => {
    const result = parseWorkflowSection(fixture('reordered.md'))
    expect(result.raw?.columns).toEqual(['阶段', '#', '输出', '输入', '负责角色', '串/并行', '完成判定', '回流路径'])
    expect(result.stages).toEqual([
      {
        order: 1,
        stage: '探索',
        roles: ['dev-1#1', 'dev-1#2'],
        mode: 'parallel',
        input: '任务书',
        output: 'recon.md',
        done: '结论落盘',
        reflow: '缺资料 → 补调研',
      },
      {
        order: 2,
        stage: '交付',
        roles: ['队长'],
        mode: 'serial',
        input: '全部',
        output: 'DELIVERY.md',
        done: '用户验收',
        reflow: '—',
      },
    ])
    expect(result.unmappedColumns).toEqual([])
  })

  it('两张表：第一张胜出，第二张按正文保留 + workflow_multiple_tables（行为变更回归）', () => {
    const result = parseWorkflowSection(fixture('two-tables.md'))
    expect(result.stages.map((s) => s.stage)).toEqual(['探索', '交付'])
    expect(result.stages).toHaveLength(2)
    expect(result.issues.map((i) => i.code)).toEqual(['workflow_multiple_tables'])
  })
})

describe('parseWorkflowSection：`###` 子标题不劫持工作流锚点（v11 派修 M-4）', () => {
  it('prose 小节内 `### 阶段拆解` 下的表 → stages [] / prose true / proseText 含该表原文', () => {
    const result = parseWorkflowSection(fixture('prose-subheading.md'))
    expect(result.stages).toEqual([])
    expect(result.prose).toBe(true)
    expect(result.raw).toBeUndefined()
    expect(result.issues).toEqual([])
    expect(result.proseText).toContain('### 阶段拆解')
    expect(result.proseText).toContain('| 阶段 | 输出 |')
    expect(parseTeamMarkdown(fixture('prose-subheading.md')).workflow).toEqual([])
  })

  it('直下区间的真表胜出；`###` 之后的形似工作流表一律正文（不解析、不记 issue）', () => {
    const result = parseWorkflowSection(fixture('subheading-table.md'))
    expect(result.stages.map((s) => s.stage)).toEqual(['探索'])
    expect(result.prose).toBeUndefined()
    // `###` 之后那张表**不是**「小节内的第二张表」——不产生 workflow_multiple_tables
    expect(result.issues).toEqual([])
    expect(result.raw?.headerLine).toBeTypeOf('number')
  })

  it('`# ` 一级标题也是小节边界（同级或更高级标题硬截断）', () => {
    const md = [
      '## 工作流',
      '',
      '| # | 阶段 |',
      '| :--- | :--- |',
      '| 1 | 甲 |',
      '',
      '# 新章',
      '',
      '| # | 阶段 |',
      '| :--- | :--- |',
      '| 9 | 乙 |',
    ].join('\n')
    const result = parseWorkflowSection(md, { baseLine: 0 })
    expect(result.stages.map((s) => s.stage)).toEqual(['甲'])
    expect(result.issues).toEqual([])
  })
})

describe('parseWorkflowSection：order 严格解析（v11 派修 M-11）', () => {
  it('`2abc` / `-3` / `0` 均不采纳 → order = 行号 + workflow_order_defaulted', () => {
    const md = [
      '## 工作流',
      '',
      '| # | 阶段 |',
      '| :--- | :--- |',
      '| 2abc | 甲 |',
      '| -3 | 乙 |',
      '| 0 | 丙 |',
      '| 7 | 丁 |',
    ].join('\n')
    const result = parseWorkflowSection(md, { baseLine: 0 })
    expect(result.stages.map((s) => s.order)).toEqual([1, 2, 3, 7])
    expect(result.issues.map((i) => i.code)).toEqual([
      'workflow_order_defaulted',
      'workflow_order_defaulted',
      'workflow_order_defaulted',
    ])
  })
})

describe('parseWorkflowSection：转义读侧（R-v11-4）', () => {
  it('`\\|` → `|` 解码；`<br>` 原样保留；裸 `|` 裂列 → 截断 + workflow_row_ragged', () => {
    const result = parseWorkflowSection(fixture('escapes.md'))
    expect(result.stages[0]).toEqual({
      order: 1,
      stage: '转义',
      roles: ['dev-1#1', 'dev-1#2'],
      mode: 'serial',
      input: '需求 | 设计',
      output: '结论 | 证据',
      done: '门禁落盘',
      reflow: '—',
    })
    expect(result.raw?.rows[0][8]).toBe('第一行<br>第二行 | 第三段')
    expect(result.stages[1]).toEqual({
      order: 2,
      stage: '裸竖线',
      roles: ['dev-1'],
      mode: 'serial',
      input: 'x',
      output: 'y',
      done: 'z',
      reflow: '—',
    })
    expect(result.raw?.rows[1][8]).toBe('值含裸')
    expect(result.raw?.columns[8]).toBe('原文')
    expect(result.unmappedColumns).toEqual(['原文'])
    expect(result.issues.map((i) => i.code)).toEqual(['workflow_row_ragged'])
  })
})

describe('parseWorkflowSection：行级降级全函数不抛（R-v11-5/6）', () => {
  it('列数不齐 / 「#」非整数或缺失 / 实例记号非法 → 不抛，降级 + issue', () => {
    const result = parseWorkflowSection(fixture('ragged-order.md'))
    expect(result.stages.map((s) => s.order)).toEqual([1, 2, 3, 4])
    expect(result.stages.map((s) => s.stage)).toEqual(['探索', '设计', '开发', '测试'])
    expect(result.stages[2].reflow).toBe('—')
    expect(result.stages[3].roles).toEqual(['dev-1/0']) // 非法实例记号原样保留
    expect(result.issues.map((i) => i.code)).toEqual([
      'workflow_row_ragged',
      'workflow_order_defaulted',
      'workflow_order_defaulted',
      'workflow_role_cell_invalid',
    ])
    // C-10①：issue **行号直接断言**（按整份文件计；3=ragged 行、4=实例记号行——见 fixture）。
    expect(result.issues.map((i) => i.line)).toEqual([17, 17, 18, 19])
  })

  it('C-10① 行号基准：整份 markdown 与「正文 + 显式 baseLine」两种入参 issue 行号逐条一致', () => {
    const md = fixture('ragged-order.md')
    const { body } = splitFrontmatter(md)
    // body 首行 = 整份文件第 9 行 → baseLine = 8（同 locateBody 的内部推算）
    const fromFull = parseWorkflowSection(md)
    const fromBody = parseWorkflowSection(body, { baseLine: 8 })

    const shape = (r: ReturnType<typeof parseWorkflowSection>): Array<[string, number]> =>
      r.issues.map((i) => [i.code, i.line as number])
    expect(shape(fromFull)).toEqual(shape(fromBody))
    expect(fromFull.issues.map((i) => i.line)).toEqual([17, 17, 18, 19])
  })

  it('parseWorkflowTable 签名与返回值不变（body + baseLine → WorkflowStage[]）', () => {
    const md = fixture('standard-8col.md')
    const body = md.slice(md.indexOf('## 工作流'))
    expect(parseWorkflowTable(body)).toHaveLength(9)
    expect(parseWorkflowTable(body, 100)).toHaveLength(9)
  })
})

describe('mapWorkflowColumns（同义词表，R-v11-8）', () => {
  it('同义词首中即用（trim 后全等，非「行文本包含」）', () => {
    expect(mapWorkflowColumns(['序号', '名称', '角色', '模式', '输入', '输出', '判定', '回流'])).toEqual([
      'order',
      'name',
      'roles',
      'mode',
      'input',
      'output',
      'done',
      'reflow',
    ])
    expect(mapWorkflowColumns(['Order', 'Stage', 'Roles', 'Mode', 'Input', 'Output', 'Done', 'Reflow'])).toEqual([
      'order',
      'name',
      'roles',
      'mode',
      'input',
      'output',
      'done',
      'reflow',
    ])
  })

  it('两列映射同一核心字段 → 表序靠前者胜，靠后者按未映射列', () => {
    expect(mapWorkflowColumns(['输出', 'Output', '阶段'])).toEqual(['output', null, 'name'])
  })

  it('非核心列（技能/做什么/产物）不映射', () => {
    expect(mapWorkflowColumns(['阶段', '技能', '做什么', '产物'])).toEqual(['name', null, null, null])
  })
})
