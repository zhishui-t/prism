/**
 * 工作流编辑域测试（v2 图编辑器写路径）：serialize 往返保未映射列 / editWorkflow 的
 * if_match 与校验拒绝 / rowId 对齐。全临时目录（R5/R6）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseWorkflowMarkdown } from '../src/workflow/parse.js'
import { serializeStepTable } from '../src/workflow/serialize.js'
import { editWorkflow, patchWorkflowRaw, WorkflowWriteError } from '../src/workflow/write.js'

const UNIT_MD = `---
workflow: demo-flow
name: 演示
level: role
binds:
  - dev
---
# 演示（demo-flow）

## 步骤表

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流路径 | 自定义列 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 装载 | dev | — | a | b | c | — | 甲 |
| 2 | 执行 | dev | — | d | e | f | 回 1 | 乙 |

## 硬性约束

- 测试。
`

describe('serializeStepTable 往返保真', () => {
  it('未映射列按 rowId 合并不错行；改序后仍对齐', () => {
    const wf = parseWorkflowMarkdown(UNIT_MD)
    const raw = wf.steps_raw!
    expect(raw.columns).toContain('自定义列')
    // 交换两行 + 改文字，未映射列应跟随各自的 rowId
    const rows = [
      { rowId: 'r2', order: 1, step: '执行改', owner: ['dev'], skills: '', input: 'd', output: 'e', done: 'f', reflow: '—' },
      { rowId: 'r1', order: 2, step: '装载改', owner: ['dev'], skills: '', input: 'a', output: 'b', done: 'c', reflow: '回 1' },
    ]
    const table = serializeStepTable({ rows, raw })
    expect(table).toContain('| 执行改 |')
    // r2 的自定义列值（乙）现在在第一行
    const firstDataRow = table.split('\n').find((l) => l.includes('执行改'))!
    expect(firstDataRow.trim().endsWith('| 乙 |')).toBe(true)
    // 再解析：未映射列读回到 raw
    const next = patchWorkflowRaw(UNIT_MD, { steps: rows }).next
    expect(next).toContain('乙')
    const reparsed = parseWorkflowMarkdown(next)
    expect(reparsed.steps_raw!.rows[0]![raw.columns.indexOf('自定义列')]).toBe('乙')
  })
})

describe('editWorkflow（if_match / 校验拒绝 / not_found）', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prism-wf-edit-'))
    await writeFile(join(dir, 'demo-flow.md'), UNIT_MD, 'utf-8')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  const rows = [
    { rowId: 'r1', order: 1, step: '装载', owner: ['dev'], skills: '', input: 'a', output: 'b', done: 'c', reflow: '—' },
    { rowId: 'r2', order: 2, step: '执行', owner: ['dev'], skills: '', input: 'd', output: 'e', done: 'f', reflow: '回 1' },
  ]

  it('正常写回：正文其余保留、结果带新 mtime', async () => {
    const result = editWorkflow({ workflow: 'demo-flow', workflowsDir: dir, patch: { steps: rows } })
    expect(result.sourceMtime).toBeGreaterThan(0)
    const written = await readFile(join(dir, 'demo-flow.md'), 'utf-8')
    expect(written).toContain('## 硬性约束')
    expect(written).toContain('workflow: demo-flow')
  })

  it('if_match 不符 → stale_write', () => {
    expect(() =>
      editWorkflow({ workflow: 'demo-flow', workflowsDir: dir, patch: { steps: rows }, ifMatch: 123 }),
    ).toThrowError(WorkflowWriteError)
    try {
      editWorkflow({ workflow: 'demo-flow', workflowsDir: dir, patch: { steps: rows }, ifMatch: 123 })
    } catch (e) {
      expect((e as WorkflowWriteError).code).toBe('stale_write')
    }
  })

  it('清空步骤（steps_empty）→ workflow_invalid 拒落盘，文件不动', async () => {
    const before = await readFile(join(dir, 'demo-flow.md'), 'utf-8')
    try {
      editWorkflow({ workflow: 'demo-flow', workflowsDir: dir, patch: { steps: [] } })
      expect.unreachable('应抛 workflow_invalid')
    } catch (e) {
      expect((e as WorkflowWriteError).code).toBe('workflow_invalid')
      expect((e as WorkflowWriteError).issues?.some((i) => i.code === 'workflow_steps_empty')).toBe(true)
    }
    expect(await readFile(join(dir, 'demo-flow.md'), 'utf-8')).toBe(before)
  })

  it('不存在 → workflow_not_found；坏 id → workflow_id_invalid', () => {
    try {
      editWorkflow({ workflow: 'no-such', workflowsDir: dir, patch: { steps: rows } })
      expect.unreachable()
    } catch (e) {
      expect((e as WorkflowWriteError).code).toBe('workflow_not_found')
    }
    try {
      editWorkflow({ workflow: 'Bad_Id', workflowsDir: dir, patch: { steps: rows } })
      expect.unreachable()
    } catch (e) {
      expect((e as WorkflowWriteError).code).toBe('workflow_id_invalid')
    }
  })
})
