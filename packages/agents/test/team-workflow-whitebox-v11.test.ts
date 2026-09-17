/**
 * v11 白盒补测（tester-whitebox）：spec-verify-matrix-v11 的缺口项。
 *
 * - W-1（矩阵 M-B6）：表头认定**阈值**——直下区间内只命中 1 个核心字段的表不认表头
 *   （design-v11 §1：「命中 ≥2 个核心字段且下一行是分隔行才认表头」）。既有测试只锁了
 *   「跨小节误命中」（小节边界）与 `###` 劫持，阈值判据本身无直测。
 * - W-2..W-4（矩阵 M-C9）：`tableRange` 的**非法行号护栏**——缺行号 / 越界 / 倒置 / 非整数
 *   → 回落整节替换，不做半截 splice 把区间外的行截掉（serialize.ts `tableRange` 分支
 *   既有测试只覆盖「缺 raw」与「合法区间」两态，护栏分支零覆盖）。
 *
 * 全部内联素材、零磁盘依赖；不触真实宿主目录（R5）。
 */

import { describe, expect, it } from 'vitest'

import { parseWorkflowSection } from '../src/team/parse.js'
import { serializeWorkflowSection, serializeWorkflowTable } from '../src/team/serialize.js'
import type { WorkflowParseResult, WorkflowSerializeRow } from '../src/types.js'

/** 直下区间内**只有 1 个核心字段**（阶段）的表——阈值判据的活体素材。 */
const ONE_CORE_FIELD_MD = `# 团队

## 工作流

| 阶段 | 技能 | 产出 |
| :--- | :--- | :--- |
| 前端 | frontend-design | brief.md |

## 备注

下一小节正文。
`

/** 合法表格 + 小节内段落 + 后续小节——行号护栏素材（先解析拿到真行号，再篡改）。 */
const TABLE_MD = `# 团队

## 工作流

本团队的工作流如下（保存时不得删除）：

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 | 串行 | 任务书 | recon.md | 结论落盘 | — | 时间盒 |

## 备注

下一小节正文。
`

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

describe('白盒补测：表头认定阈值（design-v11 §1「≥2 核心字段 + 分隔行」）', () => {
  it('W-1：直下区间内仅命中 1 个核心字段的表 → 不认表头（prose 态，不误吞）', () => {
    const result = parseWorkflowSection(ONE_CORE_FIELD_MD)
    expect(result.stages).toEqual([])
    expect(result.prose).toBe(true)
    expect(result.raw).toBeUndefined()
    // 表按正文保留在小节原文里，不参与解析、不记工作流 issue
    expect(result.proseText).toContain('| 阶段 | 技能 | 产出 |')
    expect(result.issues).toEqual([])
  })

  it('W-1′：同表加一列核心字段（≥2）即认表头——阈值边界两侧各验一次', () => {
    const twoFields = ONE_CORE_FIELD_MD.replace('| 阶段 | 技能 | 产出 |', '| 阶段 | 技能 | 输出 |')
    const result = parseWorkflowSection(twoFields)
    expect(result.prose).toBeUndefined()
    expect(result.raw).toBeDefined()
    expect(result.stages).toHaveLength(1)
    expect(result.stages[0]?.stage).toBe('前端')
    expect(result.stages[0]?.output).toBe('brief.md')
  })
})

describe('白盒补测：serializeWorkflowSection 行号护栏（tableRange 非法区间 → 整节替换）', () => {
  it('W-2：lastLine 越界（≥ 行数）→ 回落整节替换，不半截 splice 截掉后续小节', () => {
    const parsed = parseWorkflowSection(TABLE_MD)
    expect(parsed.raw).toBeDefined()
    const table = serializeWorkflowTable({ raw: parsed.raw, rows: rowsOf(parsed) })
    const out = serializeWorkflowSection(TABLE_MD, table, { ...parsed.raw!, lastLine: 99_999 })
    // 小节标题与后续小节仍完好（回落整节替换，而不是按非法区间乱切）
    expect(out).toContain('## 工作流')
    expect(out).toContain('| 1 | 探索 |')
    expect(out).toContain('## 备注')
    expect(out).toContain('下一小节正文。')
    expect(parseWorkflowSection(out).stages).toHaveLength(1)
  })

  it('W-3：lastLine < headerLine（倒置）→ 同样回落整节替换', () => {
    const parsed = parseWorkflowSection(TABLE_MD)
    const table = serializeWorkflowTable({ raw: parsed.raw, rows: rowsOf(parsed) })
    const out = serializeWorkflowSection(TABLE_MD, table, { ...parsed.raw!, lastLine: 0 })
    expect(out).toContain('## 工作流')
    expect(out).toContain('## 备注')
    expect(out).toContain('下一小节正文。')
    expect(parseWorkflowSection(out).stages).toHaveLength(1)
  })

  it('W-4：行号非整数 → 护栏拒绝（不按小数行号切）', () => {
    const parsed = parseWorkflowSection(TABLE_MD)
    const table = serializeWorkflowTable({ raw: parsed.raw, rows: rowsOf(parsed) })
    const out = serializeWorkflowSection(TABLE_MD, table, { ...parsed.raw!, headerLine: 1.5, lastLine: 2.5 })
    expect(out).toContain('## 工作流')
    expect(out).toContain('## 备注')
    expect(parseWorkflowSection(out).stages).toHaveLength(1)
  })

  it('W-5：合法行号 → 仍走表区 splice（护栏不误伤正常路径）', () => {
    const parsed = parseWorkflowSection(TABLE_MD)
    const table = serializeWorkflowTable({ raw: parsed.raw, rows: rowsOf(parsed) })
    const out = serializeWorkflowSection(TABLE_MD, table, parsed.raw)
    // 表区 splice：小节内的说明段落存活（整节替换会删掉它——两种路径必须可区分）
    expect(out).toContain('本团队的工作流如下（保存时不得删除）：')
    expect(out).toContain('## 备注')
  })
})
