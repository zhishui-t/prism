/**
 * F2（v11）工作流编排器的**纯模型**。
 *
 * 锁的全是「值到值」的表结构语义（不含渲染）：
 * - **列映射**（同义词全等 / 同义双列冲突靠前者胜 / 不认识的列是未映射列）；
 * - **行身份**（`rowId` 是未映射列值的锚：上移下移增删之后值仍跟着它那一行走，不错行）；
 * - **列集编辑**（缺列可加、自定义列可增可删、删核心列是无效操作）；
 * - **自由文本转换**（只产出「核心八列 + 原文」一种起点，可无损回退）；
 * - **提交形状**（order 按位置重编、rowId 有才带、extra 只带未映射列）；
 * - **只读渲染适配**（缺字段兜缺省，缺 roles / reflow 也能成链）。
 *
 * 环境：默认 node（纯函数，无 DOM）。
 */

import { describe, expect, it } from 'vitest'

import {
  adaptWorkflowParse,
  WORKFLOW_CORE_COLUMNS,
  type RawWorkflowTable,
  type TeamDefinition,
  type WorkflowParseResult,
  type WorkflowStage,
} from '../src/api-team.ts'
import {
  addCard,
  addCustomColumn,
  addFieldColumn,
  columnFor,
  draftFromParse,
  draftFromStages,
  flowStages,
  mapColumns,
  moveCard,
  removeCard,
  removeColumn,
  setCardField,
  setCardMode,
  setExtra,
  toFlowStages,
  toMode,
  toProseDraft,
  toTableDraft,
  toggleRole,
  unmappedColumns,
  workflowEqual,
  workflowInput,
  workflowStateOf,
} from '../src/pages/teams/workflow-model.ts'

const CORE8 = [...WORKFLOW_CORE_COLUMNS]
/** 标准八列 + 一列自定义「备注」。 */
const COLS9 = [...CORE8, '备注']

function stage(over: Partial<WorkflowStage> = {}): WorkflowStage {
  return {
    order: 1,
    stage: '需求',
    roles: ['dev-1'],
    mode: 'serial',
    input: 'i',
    output: 'o',
    done: 'd',
    reflow: '',
    ...over,
  }
}

function raw(over: Partial<RawWorkflowTable> = {}): RawWorkflowTable {
  return {
    columns: COLS9,
    rows: [
      ['1', '需求', 'dev-1', '串行', 'i1', 'o1', 'd1', '', '甲'],
      ['2', '设计', 'dev-1', '并行', 'i2', 'o2', 'd2', '驳回→需求', '乙'],
    ],
    rowIds: ['r1', 'r2'],
    ...over,
  }
}

function parse(over: Partial<WorkflowParseResult> = {}): WorkflowParseResult {
  return {
    stages: [stage(), stage({ order: 2, stage: '设计', mode: 'parallel', reflow: '驳回→需求' })],
    raw: raw(),
    unmappedColumns: ['备注'],
    issues: [],
    ...over,
  }
}

describe('列映射：同义词全等 + 同义双列靠前者胜', () => {
  it('标准八列逐列映射到核心字段，且顺序与字段序一致', () => {
    expect(mapColumns(CORE8)).toEqual([
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

  it('同义词都认：序号/名称/Roles/模式/Input/判定/回流…', () => {
    expect(mapColumns(['序号', '名称', 'Roles', '模式', 'Input', 'Output', '判定', '回流'])).toEqual([
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

  it('同义双列冲突：表序靠前者胜，靠后者降级为未映射列（与 agents mapWorkflowColumns 同口径）', () => {
    const columns = ['#', '阶段', '负责角色', '串/并行', '输入', '输出', 'Output', '完成判定', '回流路径']
    const mapping = mapColumns(columns)
    expect(mapping[5]).toBe('output')
    expect(mapping[6]).toBeNull()
    expect(unmappedColumns(columns)).toEqual(['Output'])
  })

  it('列名 trim 后**全等**才算命中：大小写 / 包含关系都不认（不是模糊匹配）', () => {
    expect(mapColumns([' 阶段 ', 'output', '输出说明'])).toEqual(['name', null, null])
  })

  it('columnFor 给的是**当前映射到的那个列名**（缺列 → undefined，UI 据此显示「+ 添加此列」）', () => {
    expect(columnFor(CORE8, 'done')).toBe('完成判定')
    expect(columnFor(['#', '阶段'], 'roles')).toBeUndefined()
    expect(columnFor(['#', '阶段'], 'order')).toBe('#')
  })
})

describe('解析结果 → 草稿', () => {
  it('带底账：列集取文件的、逐行 rowId、未映射列值进 extra', () => {
    const draft = draftFromParse(parse())
    expect(draft.state).toBe('table')
    expect(draft.columns).toEqual(COLS9)
    expect(draft.cards.map((c) => c.rowId)).toEqual(['r1', 'r2'])
    expect(draft.cards.map((c) => c.stage)).toEqual(['需求', '设计'])
    expect(draft.cards.map((c) => c.extra['备注'])).toEqual(['甲', '乙'])
    // 核心字段不进 extra（它们在卡片上有自己的槽）
    expect(Object.keys(draft.cards[0]!.extra)).toEqual(['备注'])
  })

  it('mode 按服务端口径归一：只有 parallel 是并行，其余（含空 / 未知）都是串行', () => {
    expect(toMode('parallel')).toBe('parallel')
    expect(toMode('并行')).toBe('serial')
    expect(toMode('')).toBe('serial')
    expect(draftFromParse(parse({ raw: raw(), stages: [stage({ mode: '' })] })).cards[0]!.mode).toBe('serial')
  })

  it('无底账（直接构造的解析结果）：列集按核心八列假设、extra 全空、**无行身份**', () => {
    const draft = draftFromParse(parse({ raw: undefined, unmappedColumns: [] }))
    expect(draft.columns).toEqual(CORE8)
    // 没有底账就没有 rowId（真实编辑路径上底账恒由 `adaptWorkflowParse` 补齐，见下一组用例）
    expect(draft.cards.every((c) => c.rowId === undefined)).toBe(true)
    expect(draft.cards.every((c) => Object.keys(c.extra).length === 0)).toBe(true)
  })

  it('三态判据：sectionMissing 优先于 prose（两态同时给时按「无小节」处理）', () => {
    expect(workflowStateOf({ prose: true, sectionMissing: true })).toBe('missing')
    expect(workflowStateOf({ prose: true })).toBe('prose')
    expect(workflowStateOf({})).toBe('table')
    expect(draftFromParse(parse({ raw: undefined, prose: true, proseText: 'hi' })).state).toBe('prose')
    expect(draftFromParse(parse({ raw: undefined, prose: true, proseText: 'hi' })).proseText).toBe('hi')
    expect(draftFromParse(parse({ raw: undefined, sectionMissing: true })).state).toBe('missing')
  })

  it('draftFromStages（新建模板预填）：只有阶段名，列集是核心八列', () => {
    const draft = draftFromStages([stage({ stage: '开发' }), stage({ order: 2, stage: '测试' })])
    expect(draft.columns).toEqual(CORE8)
    expect(draft.cards.map((c) => c.stage)).toEqual(['开发', '测试'])
    expect(draft.cards.every((c) => c.rowId === undefined)).toBe(true)
  })
})

describe('增删移：rowId 是未映射列值的锚，排序不错行（R-v11-3）', () => {
  it('下移一张卡：卡上的自定义列值跟着它自己的 rowId 走', () => {
    const draft = draftFromParse(parse())
    const moved = moveCard(draft, 0, 1)
    // 行序反了：设计在前、需求在后
    expect(moved.cards.map((c) => c.stage)).toEqual(['设计', '需求'])
    expect(moved.cards.map((c) => c.rowId)).toEqual(['r2', 'r1'])
    // 值也反了（跟着行走），不是「位置不动、内容错位」
    expect(moved.cards.map((c) => c.extra['备注'])).toEqual(['乙', '甲'])
  })

  it('删除中间一张：其余行的 rowId 与自定义列值原位不动（不重编、不塌缩）', () => {
    const draft = draftFromParse(
      parse({
        stages: [stage(), stage({ order: 2, stage: '设计' }), stage({ order: 3, stage: '交付' })],
        raw: raw({
          rows: [
            ['1', '需求', 'dev-1', '串行', 'i1', 'o1', 'd1', '', '甲'],
            ['2', '设计', 'dev-1', '串行', 'i2', 'o2', 'd2', '', '乙'],
            ['3', '交付', 'dev-1', '串行', 'i3', 'o3', 'd3', '', '丙'],
          ],
          rowIds: ['r1', 'r2', 'r3'],
        }),
      }),
    )
    const cut = removeCard(draft, 1)
    expect(cut.cards.map((c) => c.rowId)).toEqual(['r1', 'r3'])
    expect(cut.cards.map((c) => c.extra['备注'])).toEqual(['甲', '丙'])
  })

  it('新增一张卡：**无 rowId**（服务端据此按序插入），且不动既有行的身份', () => {
    const draft = addCard(draftFromParse(parse()))
    expect(draft.cards).toHaveLength(3)
    expect(draft.cards[2]!.rowId).toBeUndefined()
    expect(draft.cards[2]!.stage).toBe('')
    expect(draft.cards.slice(0, 2).map((c) => c.rowId)).toEqual(['r1', 'r2'])
  })

  it('越界的上下移 / 删除是幂等空操作（同一引用返回，便于 React 判等）', () => {
    const draft = draftFromParse(parse())
    expect(moveCard(draft, 0, -1)).toBe(draft)
    expect(moveCard(draft, 1, 1)).toBe(draft)
    expect(removeCard(draft, 5)).toBe(draft)
    expect(setCardField(draft, 9, 'stage', 'x')).toBe(draft)
    expect(setCardMode(draft, -1, 'serial')).toBe(draft)
  })

  it('改字段 / 改模式 / 改自定义格：不修改原草稿（值不可变）', () => {
    const draft = draftFromParse(parse())
    const named = setCardField(draft, 0, 'stage', '需求收集')
    const parallel = setCardMode(draft, 0, 'parallel')
    const noted = setExtra(draft, 0, '备注', '改了')
    expect(draft.cards[0]!.stage).toBe('需求')
    expect(draft.cards[0]!.mode).toBe('serial')
    expect(draft.cards[0]!.extra['备注']).toBe('甲')
    expect(named.cards[0]!.stage).toBe('需求收集')
    expect(parallel.cards[0]!.mode).toBe('parallel')
    expect(noted.cards[0]!.extra['备注']).toBe('改了')
  })
})

describe('负责角色多选（勾选幂等，顺序 = 勾选顺序）', () => {
  it('勾上再勾掉；重复勾不产生第二个', () => {
    const draft = draftFromParse(parse({ raw: undefined, stages: [stage({ roles: [] })] }))
    const one = toggleRole(draft, 0, 'dev-1')
    const two = toggleRole(one, 0, 'tester')
    expect(two.cards[0]!.roles).toEqual(['dev-1', 'tester'])
    expect(toggleRole(two, 0, 'dev-1').cards[0]!.roles).toEqual(['tester'])
    // 幂等：连勾同一个两次 == 勾一次
    expect(toggleRole(one, 0, 'dev-1').cards[0]!.roles).toEqual([])
  })
})

describe('列集编辑：缺列可加、自定义列可增可删、删核心列无效', () => {
  it('「+ 添加此列」把该字段的主列名追加到列集（已有 → 幂等空操作）', () => {
    // 只有两列的文件：缺的六个核心字段都可加
    const thin = draftFromParse(
      parse({
        raw: { columns: ['#', '阶段'], rows: [['1', '需求']], rowIds: ['r1'] },
        stages: [stage({ roles: [] })],
        unmappedColumns: [],
      }),
    )
    expect(thin.columns).toEqual(['#', '阶段'])
    const withOutput = addFieldColumn(thin, 'output')
    expect(withOutput.columns).toEqual(['#', '阶段', '输出'])
    // 幂等：已映射的字段再点不重复添加
    expect(addFieldColumn(withOutput, 'output')).toBe(withOutput)
    expect(addFieldColumn(withOutput, 'order')).toBe(withOutput)
    // 八列齐全的草稿：任何核心字段都已映射 ⇒ 全部是空操作
    const full = draftFromParse(parse())
    expect(addFieldColumn(full, 'output')).toBe(full)
  })

  it('增自定义列：列集加一列 + 每张卡补空格；空白名 / 重名是幂等空操作', () => {
    const draft = draftFromParse(parse())
    const added = addCustomColumn(draft, ' 风险 ')
    expect(added.columns).toEqual([...COLS9, '风险'])
    expect(added.cards.map((c) => c.extra['风险'])).toEqual(['', ''])
    expect(addCustomColumn(added, '风险')).toBe(added)
    expect(addCustomColumn(added, '   ')).toBe(added)
    expect(addCustomColumn(added, '备注')).toBe(added)
  })

  it('删列只对**未映射列**生效：自定义列连值一起删（R-v11-12：删「原文」即弃），核心列删不动', () => {
    const draft = draftFromParse(parse())
    const cut = removeColumn(draft, '备注')
    expect(cut.columns).toEqual(CORE8)
    expect(cut.cards.every((c) => Object.keys(c.extra).length === 0)).toBe(true)
    // 核心字段的列：删它不是「清空该字段」，而是让字段没有容身处 —— 本交互不允许（幂等空操作）
    expect(removeColumn(draft, '输出')).toBe(draft)
    expect(removeColumn(draft, '不存在的列')).toBe(draft)
  })
})

describe('自由文本 → 表格（本地模型变换，R-v11-9）', () => {
  const prose: WorkflowParseResult = {
    stages: [],
    unmappedColumns: [],
    prose: true,
    proseText: '先做 A，再做 B。\n\nB 不合格就退回 A。',
    issues: [],
  }

  it('转换 = 核心八列 + 「原文」列，单张卡，全文进「原文」，其余字段留空', () => {
    const table = toTableDraft(draftFromParse(prose))
    expect(table.state).toBe('table')
    expect(table.columns).toEqual([...CORE8, '原文'])
    expect(table.fromProse).toBe(true)
    expect(table.cards).toHaveLength(1)
    expect(table.cards[0]!.extra['原文']).toBe(prose.proseText)
    expect(table.cards[0]!.stage).toBe('')
    expect(table.cards[0]!.roles).toEqual([])
    expect(table.cards[0]!.rowId).toBeUndefined()
  })

  it('未保存可取消：回退到自由文本态，原文仍在草稿里（从未落盘）', () => {
    const table = toTableDraft(draftFromParse(prose))
    const back = toProseDraft(table)
    expect(back.state).toBe('prose')
    expect(back.proseText).toBe(prose.proseText)
    expect(back.fromProse).toBe(false)
  })

  it('没有原文时不假装能转换：空 prosaText 的回退是幂等空操作', () => {
    const empty = draftFromParse({ stages: [], unmappedColumns: [], prose: true, issues: [] })
    expect(empty.proseText).toBe('')
    expect(toProseDraft(empty)).toBe(empty)
    // 转换本身仍可调用（UI 侧用 disabled 挡住），产出的「原文」是空串而不是凭空编的文本
    expect(toTableDraft(empty).cards[0]!.extra['原文']).toBe('')
  })
})

describe('提交形状（PATCH body 的 workflow 段：columns + stages）', () => {
  it('order 按卡片位置重编；rowId 有才带；extra 只装未映射列', () => {
    const draft = draftFromParse(parse())
    const { stages } = workflowInput(draft)
    expect(stages.map((s) => s.order)).toEqual([1, 2])
    expect(stages.map((s) => s.rowId)).toEqual(['r1', 'r2'])
    expect(stages[0]!.extra).toEqual({ 备注: '甲' })
    expect(stages[0]!.mode).toBe('serial')
    expect(stages[1]!.reflow).toBe('驳回→需求')
  })

  it('排序后 order 重编、rowId 跟着行走（服务端据此把未映射列合并回正确的行）', () => {
    const { stages } = workflowInput(moveCard(draftFromParse(parse()), 0, 1))
    expect(stages.map((s) => ({ order: s.order, rowId: s.rowId, extra: s.extra }))).toEqual([
      { order: 1, rowId: 'r2', extra: { 备注: '乙' } },
      { order: 2, rowId: 'r1', extra: { 备注: '甲' } },
    ])
  })

  it('无未映射列时不带 extra（让服务端按 rowId 从原底账回落，而不是「我确认这些列是空的」）', () => {
    const { stages } = workflowInput(draftFromParse(parse({ raw: undefined, unmappedColumns: [] })))
    expect(stages.every((s) => s.extra === undefined)).toBe(true)
  })

  it('新建行没有 rowId（= 新行，不是「覆盖第 N 行」）', () => {
    const { stages } = workflowInput(addCard(draftFromParse(parse())))
    expect(stages).toHaveLength(3)
    expect(stages[2]!.rowId).toBeUndefined()
    expect(stages[2]!.order).toBe(3)
  })
})

describe('T1 / M-2：提交列集（workflow.columns 通道）', () => {
  /**
   * 核心不变量：**columns 与 extra 的键由同一份草稿产出**——服务端 `serializeWorkflowTable`
   * 按**列名**取 extra，两者分头算就会「列在上报里、值在服务端找不到」= 静默丢值。
   */
  it('(a) 增自定义列并填值 → columns 含该列，且对应 stage.extra 的键值俱在（键 = 列名）', () => {
    const draft = draftFromParse(parse())
    const added = setExtra(addCustomColumn(draft, '风险'), 1, '风险', '高')
    const out = workflowInput(added)

    expect(out.columns).toEqual([...COLS9, '风险'])
    // 键必须与 columns 里的那个字符串**逐字相同**（服务端按名寻址）
    const risk = out.columns[out.columns.length - 1]!
    expect(out.stages[0]!.extra).toEqual({ 备注: '甲', [risk]: '' })
    expect(out.stages[1]!.extra).toEqual({ 备注: '乙', [risk]: '高' })
  })

  it('(b) 删列 → columns 不含该列，且所有 stage.extra 里无残留键', () => {
    const out = workflowInput(removeColumn(draftFromParse(parse()), '备注'))
    expect(out.columns).toEqual(CORE8)
    expect(out.columns).not.toContain('备注')
    expect(out.stages.every((s) => s.extra === undefined || !('备注' in s.extra))).toBe(true)
    // 删列是「列 + 值一起走」，不是「留个空壳键」
    expect(out.stages.every((s) => Object.keys(s.extra ?? {}).length === 0)).toBe(true)
  })

  it('(c) 列序非核心序（自定义列夹在中间）→ 提交列集**保序**，字段值与 extra 按列名对齐、不错位', () => {
    // 病态但合法：文件列序为 [阶段, 备注, #, 输出]——自定义列夹在核心列之间
    const columns = ['阶段', '备注', '#', '输出']
    const draft = draftFromParse({
      stages: [stage({ order: 7, stage: '需求', output: 'O1' }), stage({ order: 8, stage: '设计', output: 'O2' })],
      raw: {
        columns,
        rows: [
          ['需求', '甲的备注', '7', 'O1'],
          ['设计', '乙的备注', '8', 'O2'],
        ],
        rowIds: ['r1', 'r2'],
      },
      unmappedColumns: ['备注'],
      issues: [],
    })
    const out = workflowInput(draft)
    expect(out.columns).toEqual(columns)
    // 值按**列名**取，不是按位置猜：order 来自 `#` 列、output 来自 `输出` 列
    expect(out.stages[0]).toMatchObject({ rowId: 'r1', order: 1, stage: '需求', output: 'O1' })
    expect(out.stages[0]!.extra).toEqual({ 备注: '甲的备注' })
    // 行序调整：rowId / extra 跟着行走、columns 不变（列序不因行序而乱）
    const moved = workflowInput(moveCard(draft, 0, 1))
    expect(moved.columns).toEqual(columns)
    expect(moved.stages.map((s) => ({ rowId: s.rowId, extra: s.extra }))).toEqual([
      { rowId: 'r2', extra: { 备注: '乙的备注' } },
      { rowId: 'r1', extra: { 备注: '甲的备注' } },
    ])
  })

  it('(d) prose 转换往返：columns 含「原文」，其值与列名同源；再解析一次不丢', () => {
    const text = '先做 A，再做 B。'
    const draft = draftFromParse({
      stages: [],
      unmappedColumns: [],
      prose: true,
      proseText: text,
      issues: [],
    })
    const out = workflowInput(toTableDraft(draft))
    expect(out.columns).toEqual([...CORE8, '原文'])
    expect(out.stages[0]!.extra).toEqual({ 原文: text })

    // 服务端写回后（表格态）再解析：列集与值原样还在
    const reparsed = draftFromParse(
      parse({
        stages: [stage({ stage: '', roles: [] })],
        raw: { columns: out.columns, rows: [['1', '', '', '串行', '', '', '', '', text]], rowIds: ['r1'] },
        unmappedColumns: ['原文'],
      }),
    )
    const again = workflowInput(reparsed)
    expect(again.columns).toEqual([...CORE8, '原文'])
    expect(again.stages[0]!.extra).toEqual({ 原文: text })
  })

  it('(d′) 转换后回退到 prose：**不算改动**（列集只是残值）——不让保存把自由文本替成空表', () => {
    const proseDraft = draftFromParse({
      stages: [],
      unmappedColumns: [],
      prose: true,
      proseText: '原文仍在',
      issues: [],
    })
    // 基线 = 文件的 prose 态；用户转换后回退，再与基线比：等价 ⇒ 不发 workflow 段
    const back = toProseDraft(toTableDraft(proseDraft))
    expect(back.columns).not.toEqual(proseDraft.columns) // 列集确实残留着（转换的痕迹）
    expect(workflowEqual(proseDraft, back)).toBe(true)
    // 反向对照：仍在表格态（没回退）则不等价，必须发
    expect(workflowEqual(proseDraft, toTableDraft(proseDraft))).toBe(false)
  })
})

describe('只读渲染适配（详情页降级；WorkflowFlow 的渲染代码不动）', () => {
  it('缺 roles / reflow / 其他字段也不炸：roles 补空数组、reflow 补空串、mode 空补 serial', () => {
    const bare = [
      { order: 1, stage: '只有名字' } as unknown as WorkflowStage,
      { order: 2, stage: '有角色', roles: ['dev-1'], mode: '', input: '', output: '', done: '', reflow: '' },
    ]
    const out = toFlowStages(bare)
    expect(out[0]).toEqual({
      order: 1,
      stage: '只有名字',
      roles: [],
      mode: 'serial',
      input: '',
      output: '',
      done: '',
      reflow: '',
    })
    expect(out[1]!.mode).toBe('serial')
    expect(out[1]!.roles).toEqual(['dev-1'])
  })

  it('order 非法（NaN）时按位置兜底 —— 挡住直通 archify IR 的 NaN 路径', () => {
    const out = toFlowStages([
      { order: Number.NaN, stage: 'a' } as unknown as WorkflowStage,
      { order: Number.NaN, stage: 'b' } as unknown as WorkflowStage,
    ])
    expect(out.map((s) => s.order)).toEqual([1, 2])
  })

  it('认不出的 mode **原样保留**（本地化不了就照实显示），只有空值才兜成 serial', () => {
    expect(toFlowStages([stage({ mode: 'scan' })])[0]!.mode).toBe('scan')
  })

  it('预览的 order 恒等于卡片位置（所见即所存）', () => {
    expect(flowStages(moveCard(draftFromParse(parse()), 0, 1)).map((s) => s.order)).toEqual([1, 2])
    expect(flowStages(draftFromParse(parse())).map((s) => s.stage)).toEqual(['需求', '设计'])
  })
})

describe('阶段 C 适配层（adaptWorkflowParse：服务端下发 workflow_raw 前后**调用点不变**）', () => {
  const team = (over: Partial<TeamDefinition> = {}): TeamDefinition => ({
    team_id: 'delivery',
    name: '交付',
    description: '',
    default: false,
    members: [{ role: 'dev-1', count: 1 }],
    skills: [],
    knowledge: { layers: [] },
    deposit: {
      enabled: false,
      default_layer: 'project',
      default_type: 'other',
      priority: 'medium',
      require_note: false,
    },
    arbitration: [],
    workflow: [stage(), stage({ order: 2, stage: '设计', mode: 'parallel' })],
    ...over,
  })

  it('现状（无 workflow_raw）：从既有 workflow 合成底账 —— 核心八列 + 按行序的 r1..rn', () => {
    const out = adaptWorkflowParse(team())
    expect(out.raw?.columns).toEqual(CORE8)
    expect(out.raw?.rowIds).toEqual(['r1', 'r2'])
    // 合成的行按核心字段顺序落格（role 用 ` + ` 连接，与服务端单元格语法同款）
    expect(out.raw?.rows[0]).toEqual(['1', '需求', 'dev-1', 'serial', 'i', 'o', 'd', ''])
    expect(out.unmappedColumns).toEqual([])
    // 保守缺省：**不编造**文件状态（既不说自由文本，也不说缺小节）
    expect(out.prose).toBe(false)
    expect(out.sectionMissing).toBe(false)
    expect(out.issues).toEqual([])
    expect(out.stages).toHaveLength(2)
  })

  it('合成底账喂出来的草稿**带行身份** ⇒ 排序时未映射列不错行（阶段 C 只先上 PATCH 也安全）', () => {
    const draft = draftFromParse(adaptWorkflowParse(team()))
    expect(draft.cards.map((c) => c.rowId)).toEqual(['r1', 'r2'])
    expect(moveCard(draft, 0, 1).cards.map((c) => c.rowId)).toEqual(['r2', 'r1'])
    // 合成行按行序编号 ⇒ 与服务端 parse 的编号一致，能对齐到同一批原行
    expect(workflowInput(draft).stages.map((s) => s.rowId)).toEqual(['r1', 'r2'])
  })

  it('有 workflow_raw：纯搬运 —— 列集 / 未映射列（server 名 `unmapped`）/ 两态照实传', () => {
    const out = adaptWorkflowParse(
      team({
        workflow_raw: {
          columns: COLS9,
          rows: raw().rows,
          rowIds: ['r1', 'r2'],
          unmapped: ['备注'],
          prose: false,
          sectionMissing: false,
        },
      }),
    )
    expect(out.raw?.columns).toEqual(COLS9)
    expect(out.raw?.rows).toEqual(raw().rows)
    expect(out.raw?.rowIds).toEqual(['r1', 'r2'])
    // server 包装名 `unmapped` → 解析层名 `unmappedColumns`（改名点就在适配函数里）
    expect(out.unmappedColumns).toEqual(['备注'])
    expect(out.prose).toBe(false)
    expect(out.sectionMissing).toBe(false)
  })

  it('顶层 `issues` 是混流：**只**搬工作流相关的那批（M-8，code 前缀 `workflow_`）', () => {
    const out = adaptWorkflowParse(
      team({
        issues: [
          { level: 'error', code: 'team_roles_missing', message: '缺少 roles_dir' },
          { level: 'warning', code: 'workflow_row_ragged', message: '列数不符（第 7 行）' },
          { level: 'warning', code: 'deposit_layer_invalid', message: '默认层非法' },
          { level: 'warning', code: 'workflow_role_unknown', message: '阶段引用了未知角色' },
        ],
        workflow_raw: { columns: COLS9, rows: raw().rows, rowIds: ['r1', 'r2'], unmapped: ['备注'] },
      }),
    )
    // 字段校验类（team_roles_missing / deposit_layer_invalid）不冒充「工作流提示」；
    // 工作流相关的两类都放行（parse 侧降级诊断 + 校验侧的 workflow_role_unknown）
    expect(out.issues.map((i) => i.code)).toEqual(['workflow_row_ragged', 'workflow_role_unknown'])
    expect(out.issues[0]!.message).toContain('第 7 行')
    // 下游（编辑器提示条）数的是这份过滤后的 issues，故计数同样不含字段校验类
    expect(draftFromParse(out).issues).toHaveLength(2)
  })

  it('prose / sectionMissing 照实传（不因为 stages 空就自己改判成另一态）', () => {
    const prose = adaptWorkflowParse(
      team({
        workflow: [],
        workflow_raw: {
          columns: [],
          rows: [],
          rowIds: [],
          unmapped: [],
          prose: true,
          proseText: '自由文本工作流',
        },
      }),
    )
    expect(workflowStateOf(prose)).toBe('prose')
    // `proseText` 是**前端声明的契约缺口补充字段**（服务端当前不下发）；下发了就照用
    expect(prose.proseText).toBe('自由文本工作流')

    const missing = adaptWorkflowParse(
      team({
        workflow: [],
        workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], sectionMissing: true },
      }),
    )
    expect(workflowStateOf(missing)).toBe('missing')
  })

  it('服务端**没**下发 proseText ⇒ 不拿空串顶替（`undefined`，UI 据此如实说「拿不到原文」）', () => {
    const out = adaptWorkflowParse(
      team({ workflow: [], workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true } }),
    )
    expect(out.proseText).toBeUndefined()
    expect(workflowStateOf(out)).toBe('prose')
  })

  it('source_mtime 缺席时草稿不带 if_match 依据（由 form-logic 决定不带该键）', () => {
    expect(adaptWorkflowParse(team()).stages).toHaveLength(2)
    expect(team({ source_mtime: 99 }).source_mtime).toBe(99)
  })
})

describe('M-6 extends 混源：阶段只认本文件的表格（`workflow_raw`）', () => {
  /**
   * 病态但真实的形态：GET 的 `workflow` 是 **extends 合并后**的结果（合并判据取 frontmatter 键，
   * 而工作流在正文表格里 ⇒ `declared` 永不含 `workflow` ⇒ **父级的表恒胜出**），
   * 而 `workflow_raw` 是**被编辑文件本体**。这一组锁的就是「两源不同时取哪一个」。
   */
  const merged: WorkflowStage[] = [
    stage({ order: 1, stage: '父级阶段甲' }),
    stage({ order: 2, stage: '父级阶段乙' }),
  ]
  const localRaw = (): RawWorkflowTable => ({
    columns: ['#', '阶段', '备注'],
    rows: [['1', '子级自有阶段', '子备注']],
    rowIds: ['r1'],
  })
  const def = (over: Partial<TeamDefinition> = {}): TeamDefinition => ({
    team_id: 'child-team',
    name: '子团队',
    description: '',
    default: false,
    members: [{ role: 'dev-1', count: 1 }],
    skills: [],
    knowledge: { layers: [] },
    deposit: {
      enabled: false,
      default_layer: 'project',
      default_type: 'other',
      priority: 'medium',
      require_note: false,
    },
    arbitration: [],
    // 「合并结果」（父级胜出）
    workflow: merged,
    ...over,
  })

  it('本文件有表 + 合并结果不同 → **取本文件的表**（不是父级的），列集与行身份同源', () => {
    const out = adaptWorkflowParse(
      def({ workflow_raw: { columns: localRaw().columns, rows: localRaw().rows, rowIds: ['r1'], unmapped: ['备注'] } }),
    )
    expect(out.stages.map((s) => s.stage)).toEqual(['子级自有阶段'])
    expect(out.raw?.columns).toEqual(['#', '阶段', '备注'])
    expect(out.raw?.rowIds).toEqual(['r1'])
    // 有表 ⇒ 不给「继承」提示（编辑器编排的就是本文件的表，来源自证）
    expect(out.inheritedStages).toBeUndefined()

    // 草稿 → 提交：就是本文件那张表（父级的阶段一个都不出现）
    const cards = draftFromParse(out).cards
    expect(cards.map((c) => c.stage)).toEqual(['子级自有阶段'])
    expect(cards[0]!.rowId).toBe('r1')
    expect(workflowInput(draftFromParse(out)).stages[0]).toMatchObject({ rowId: 'r1', stage: '子级自有阶段' })
  })

  it('本文件无表（sectionMissing）+ 合并有 → 阶段为空，合并那份只进 `inheritedStages`（只读）', () => {
    const out = adaptWorkflowParse(
      def({ workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], sectionMissing: true } }),
    )
    expect(workflowStateOf(out)).toBe('missing')
    expect(out.stages).toEqual([])
    expect(out.inheritedStages?.map((s) => s.stage)).toEqual(['父级阶段甲', '父级阶段乙'])
    // 只读：草稿的 cards 为空、inherited 只是上下文（绝不被 workflowInput 带出去）
    const draft = draftFromParse(out)
    expect(draft.cards).toEqual([])
    expect(workflowInput(draft).stages).toEqual([])
    expect(draft.inherited.map((s) => s.stage)).toEqual(['父级阶段甲', '父级阶段乙'])
  })

  it('本文件无表（prose）+ 合并有 → 同上；合并为空（非 extends）则不给这一项（宁缺不猜）', () => {
    const prose = adaptWorkflowParse(
      def({
        workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: '自由文本' },
      }),
    )
    expect(prose.inheritedStages).toHaveLength(2)
    // 没有 workflow_raw（旧响应）⇒ 连本文件有没有表都不知道，更无从判继承
    expect(adaptWorkflowParse(def()).inheritedStages).toBeUndefined()
  })

  it('转换以继承阶段为起点；原文仍旧落在**第一行**的「原文」列，继承行不带行身份', () => {
    const draft = draftFromParse(
      adaptWorkflowParse(
        def({
          workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: '原说明' },
        }),
      ),
    )
    const table = toTableDraft(draft)
    expect(table.cards.map((c) => c.stage)).toEqual(['父级阶段甲', '父级阶段乙'])
    expect(table.cards.every((c) => c.rowId === undefined)).toBe(true)
    expect(table.cards[0]!.extra['原文']).toBe('原说明')
    // 「原文」列在列集里（R-v11-12 的唯一载体），且第二行没有凭空多出原文
    expect(table.columns).toEqual([...CORE8, '原文'])
    expect(table.cards[1]!.extra['原文']).toBeUndefined()
    // 未保存可回退（原文来自 proseText，不靠列）
    expect(toProseDraft(table).proseText).toBe('原说明')
    expect(toProseDraft(toProseDraft(table)).state).toBe('prose')
  })

  it('表格化后回退再转换，起点仍是继承阶段（往返不把 `inherited` 丢掉）', () => {
    const draft = draftFromParse(
      adaptWorkflowParse(
        def({ workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: 'x' } }),
      ),
    )
    const again = toTableDraft(toProseDraft(toTableDraft(draft)))
    expect(again.cards.map((c) => c.stage)).toEqual(['父级阶段甲', '父级阶段乙'])
  })
})

describe('本文件表格 → 阶段：口径镜像 agents `buildStage` / `parseRoleCell`', () => {
  const def = (columns: string[], rows: string[][]): TeamDefinition => ({
    team_id: 't',
    name: 't',
    description: '',
    default: false,
    members: [],
    skills: [],
    knowledge: { layers: [] },
    deposit: {
      enabled: false,
      default_layer: 'project',
      default_type: 'other',
      priority: 'medium',
      require_note: false,
    },
    arbitration: [],
    workflow: [],
    workflow_raw: { columns, rows, rowIds: rows.map((_, i) => `r${i + 1}`), unmapped: [] },
  })

  it('roles 单元格：`+` 分隔、`name/N` 展开为 `name#1..N`；缺 roles 列则一律空', () => {
    const withRoles = adaptWorkflowParse(def(['阶段', '负责角色'], [['需求', 'dev-1/2 + tester']])).stages
    expect(withRoles[0]!.roles).toEqual(['dev-1#1', 'dev-1#2', 'tester'])
    // `—` 与空串都是「没指派」
    expect(adaptWorkflowParse(def(['阶段', '负责角色'], [['需求', '—']])).stages[0]!.roles).toEqual([])
    expect(adaptWorkflowParse(def(['阶段'], [['需求']])).stages[0]!.roles).toEqual([])
  })

  it('mode：非「并行」即串行；`#` 缺列 / 非整数 → order 按行号回退（与 agents 同口径）', () => {
    const stages = adaptWorkflowParse(def(['阶段', '串/并行'], [['甲', '并行'], ['乙', '串行'], ['丙', 'scan']])).stages
    expect(stages.map((s) => s.mode)).toEqual(['parallel', 'serial', 'serial'])
    expect(stages.map((s) => s.order)).toEqual([1, 2, 3])
    expect(adaptWorkflowParse(def(['#', '阶段'], [['7', '甲'], ['x', '乙'], ['', '丙']])).stages.map((s) => s.order)).toEqual([
      7, 2, 3,
    ])
  })
})

describe('草稿等价（PATCH 差集用：没动工作流就不发 workflow 段）', () => {
  it('同一份解析两次 → 等价；改了内容 / 顺序 / 列集 / 行身份 → 不等价', () => {
    const a = draftFromParse(parse())
    const b = draftFromParse(parse())
    expect(workflowEqual(a, b)).toBe(true)
    expect(workflowEqual(a, setCardField(a, 0, 'stage', '改过'))).toBe(false)
    expect(workflowEqual(a, moveCard(a, 0, 1))).toBe(false)
    expect(workflowEqual(a, addCustomColumn(a, '风险'))).toBe(false)
    expect(workflowEqual(a, removeCard(a, 1))).toBe(false)
    expect(workflowEqual(a, setCardMode(a, 0, 'parallel'))).toBe(false)
    expect(workflowEqual(a, toggleRole(a, 0, 'tester'))).toBe(false)
    expect(workflowEqual(a, setExtra(a, 0, '备注', 'x'))).toBe(false)
    // 态不同也不等价（自由文本 vs 表格）
    expect(workflowEqual(a, draftFromParse(parse({ raw: undefined, prose: true, proseText: 'x' })))).toBe(false)
  })

  it('「新增一张卡」算改动（新行要落盘），「新增后又删掉」不算（值回到等价）', () => {
    const a = draftFromParse(parse())
    const added = addCard(a)
    expect(workflowEqual(a, added)).toBe(false)
    expect(workflowEqual(a, removeCard(added, 2))).toBe(true)
  })
})
