/**
 * 工作流单元解析测试（workflow-asset.md §3）。
 * 全部用内联 fixture 字符串——不写任何宿主目录（红线 R5/R6）。
 */
import { describe, expect, it } from 'vitest'

import {
  STEP_TABLE_HEADING,
  WorkflowParseError,
  parseWorkflowMarkdown,
} from '../src/workflow/parse.js'

const BASE = `---
workflow: demo-flow
name: 演示单元
level: role
binds:
  - dev
skills:
  - spec-guard
---

# 演示单元（demo-flow）

${STEP_TABLE_HEADING}

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流路径 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 装载 | dev | spec-guard | tasks.md | 上下文 | 文件读完 | — |
| 2 | 执行 | dev + 队长 | — | 上下文 | diff | 自测过 | 回 1 |

## 硬性约束

- 只读测试。
`

describe('parseWorkflowMarkdown', () => {
  it('五键 + 步骤表全列解析', () => {
    const wf = parseWorkflowMarkdown(BASE)
    expect(wf.workflow).toBe('demo-flow')
    expect(wf.name).toBe('演示单元')
    expect(wf.level).toBe('role')
    expect(wf.binds).toEqual(['dev'])
    expect(wf.skills).toEqual(['spec-guard'])
    expect(wf.steps).toHaveLength(2)
    expect(wf.steps[0]).toMatchObject({ order: 1, step: '装载', owner: ['dev'], skills: 'spec-guard' })
    // owner 多值（+ 分隔）；缺省列（第 2 行的 skill 写 —）原样保留为文本
    expect(wf.steps[1]!.owner).toEqual(['dev', '队长'])
    expect(wf.steps[1]!.skills).toBe('—')
    expect(wf.body).toContain('## 硬性约束')
  })

  it('列同义词：序号/名称/负责/技能/输入/输出/判定/回流 全部命中', () => {
    const wf = parseWorkflowMarkdown(`---
workflow: syn
name: 同义词
level: team
---
# x
${STEP_TABLE_HEADING}
| 序号 | 名称 | 负责 | 技能 | 输入 | 输出 | 判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 步 | 队长 | s | a | b | c | d |
`)
    expect(wf.steps[0]).toMatchObject({ order: 1, step: '步', owner: ['队长'], input: 'a', output: 'b', done: 'c', reflow: 'd' })
  })

  it('level 缺省/非法 → 按 role 收敛（validate 报 error）', () => {
    const wf = parseWorkflowMarkdown(`---
workflow: x
name: x
---
# x
${STEP_TABLE_HEADING}
| # | 步骤 | 承接 | 输入 | 输出 | 完成判定 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | s | dev | a | b | c |
`)
    expect(wf.level).toBe('role')
  })

  it('无 frontmatter → WorkflowParseError(no_frontmatter)', () => {
    expect(() => parseWorkflowMarkdown('# 只有正文\n')).toThrowError(WorkflowParseError)
  })

  it('缺 ## 步骤表 小节 → steps 空 + steps_section_missing issue（warning 并入 issues）', () => {
    const wf = parseWorkflowMarkdown('---\nworkflow: x\nname: x\n---\n# 没有步骤表\n')
    expect(wf.steps).toEqual([])
    expect(wf.issues?.some((i) => i.code === 'steps_section_missing' && i.level === 'warning')).toBe(true)
  })

  it('小节内无表格 → steps_table_missing；第二张表只认第一张', () => {
    const noTable = parseWorkflowMarkdown(`---
workflow: x
name: x
---
# x
${STEP_TABLE_HEADING}
只有自由文本。
`)
    expect(noTable.issues?.some((i) => i.code === 'steps_table_missing')).toBe(true)

    const two = parseWorkflowMarkdown(`---
workflow: x
name: x
---
# x
${STEP_TABLE_HEADING}
| # | 步骤 | 承接 | 输入 | 输出 | 完成判定 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | a | dev | i | o | d |
| 2 | b | dev | i | o | d |

| # | 步骤 | 承接 | 输入 | 输出 | 完成判定 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 第二张 | dev | i | o | d |
`)
    expect(two.steps).toHaveLength(2)
    expect(two.issues?.some((i) => i.code === 'steps_multiple_tables')).toBe(true)
  })

  it('行级降级：ragged 行截断/补空；非正整数 order 按行号回退', () => {
    const wf = parseWorkflowMarkdown(`---
workflow: x
name: x
---
# x
${STEP_TABLE_HEADING}
| # | 步骤 | 承接 | 输入 | 输出 | 完成判定 | 回流 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| x | 坏序号 | dev | i | o | d | r |
| 2 | 列少 | dev | i | o | d |
`)
    expect(wf.steps[0]!.order).toBe(1)
    expect(wf.issues?.some((i) => i.code === 'step_order_defaulted')).toBe(true)
    expect(wf.issues?.some((i) => i.code === 'step_row_ragged')).toBe(true)
    // 列少的行补空：reflow 为空串
    expect(wf.steps[1]!.reflow).toBe('')
  })

  it('单元格转义 \\| 还原；### 小节不截断步骤表', () => {
    const wf = parseWorkflowMarkdown(`---
workflow: x
name: x
---
# x
${STEP_TABLE_HEADING}
| # | 步骤 | 承接 | 输入 | 输出 | 完成判定 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | a\\|b | dev | i | o | c |

### 小节说明（不截断，属步骤表小节内）
`)
    expect(wf.steps[0]!.step).toBe('a|b')
  })
})
