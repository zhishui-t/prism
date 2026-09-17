/**
 * v11 F2 团队写盘（design-v11 §3「本轮必改」）：
 * - `editTeam` 双形态（**目录式 `<id>/AGENTS.md` 优先**，其次扁平 `<id>.md`；M-7 与
 *   `wiring.loadTeam` 候选序对齐）——P0-5 / R-v11-14；
 * - `patchTeamRaw` 名册收窄走 serialize，roles 列缺失 / prose / 小节缺失 → 整体跳过 + warning
 *   （不整段清空工作流）——R-v11-1；未映射列按 rowId 保住。
 *
 * 全部落在临时目录（红线 R5：测试绝不写真实宿主目录）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { narrowWorkflow } from '../src/team/init.js'
import { parseWorkflowSection } from '../src/team/parse.js'
import { WorkflowSectionMissingError } from '../src/team/serialize.js'
import { editTeam, patchTeamRaw, resolveTeamFile, TeamWriteError } from '../src/team/write.js'
import type { WorkflowSerializeRow, WorkflowStage } from '../src/types.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/team-workflow/', import.meta.url))

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

const tmpDirs: string[] = []
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prism-team-write-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

/** 取 `## 工作流` 小节的有意义文本（去空白行/行尾空白）——「正文不动」的判据。 */
function meaningfulWorkflowSection(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => line.trim() === '## 工作流')
  if (start === -1) return ''
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return lines
    .slice(start, end)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n')
}

describe('resolveTeamFile / editTeam 双形态（P0-5 回归）', () => {
  it('resolveTeamFile：目录式优先 → 扁平 → null', () => {
    const teamsDir = makeTmp()
    expect(resolveTeamFile(teamsDir, 'demo')).toBeNull()
    writeFileSync(join(teamsDir, 'demo.md'), 'x', 'utf8')
    expect(resolveTeamFile(teamsDir, 'demo')).toBe(join(teamsDir, 'demo.md'))
    mkdirSync(join(teamsDir, 'demo'), { recursive: true })
    writeFileSync(join(teamsDir, 'demo', 'AGENTS.md'), 'x', 'utf8')
    // M-7 行为修正：目录式优先，候选序对齐 wiring.loadTeam 的 [<id>/AGENTS.md, <id>.md]——
    // 双形态共存（病理态）时 GET raw/mtime 与写落点必须同一文件，否则「读 A 写 B」。
    expect(resolveTeamFile(teamsDir, 'demo')).toBe(join(teamsDir, 'demo', 'AGENTS.md'))
  })

  it('editTeam：双形态共存 → 写到目录式那份，扁平那份原封不动（M-7）', async () => {
    const teamsDir = makeTmp()
    mkdirSync(join(teamsDir, 'dup'), { recursive: true })
    const dirTarget = join(teamsDir, 'dup', 'AGENTS.md')
    const flatTarget = join(teamsDir, 'dup.md')
    writeFileSync(dirTarget, fixture('no-roles.md').replace('no-roles-team', 'dup'), 'utf8')
    writeFileSync(flatTarget, fixture('no-roles.md').replace('no-roles-team', 'dup'), 'utf8')
    const flatBefore = readFileSync(flatTarget, 'utf8')

    const result = await editTeam({ teamId: 'dup', teamsDir, patch: { name: '目录式改名' } })
    expect(result.written).toEqual([dirTarget])
    expect(readFileSync(dirTarget, 'utf8')).toContain('目录式改名')
    expect(readFileSync(flatTarget, 'utf8')).toBe(flatBefore)
  })

  it('editTeam：扁平形态就地保存', async () => {
    const teamsDir = makeTmp()
    writeFileSync(join(teamsDir, 'no-roles-team.md'), fixture('no-roles.md'), 'utf8')
    const result = await editTeam({ teamId: 'no-roles-team', teamsDir, patch: { name: '改名后' } })
    expect(result.written).toEqual([join(teamsDir, 'no-roles-team.md')])
    expect(readFileSync(join(teamsDir, 'no-roles-team.md'), 'utf8')).toContain('改名后')
  })

  it('editTeam：目录式 `<id>/AGENTS.md` 就地保存（不再 team_not_found）', async () => {
    const teamsDir = makeTmp()
    mkdirSync(join(teamsDir, 'delivery'), { recursive: true })
    const target = join(teamsDir, 'delivery', 'AGENTS.md')
    writeFileSync(target, fixture('extra-columns.md'), 'utf8')
    const result = await editTeam({ teamId: 'delivery', teamsDir, patch: { description: '改述后' } })
    expect(result.written).toEqual([target])
    const saved = readFileSync(target, 'utf8')
    expect(saved).toContain('改述后')
    expect(existsSync(join(teamsDir, 'delivery.md'))).toBe(false)
  })

  it('editTeam：两形态都不存在 → team_not_found（只改不隐式新建）', async () => {
    const teamsDir = makeTmp()
    await expect(editTeam({ teamId: 'nope', teamsDir, patch: { name: 'x' } })).rejects.toBeInstanceOf(TeamWriteError)
    expect(existsSync(join(teamsDir, 'nope.md'))).toBe(false)
  })
})

describe('patchTeamRaw 收窄：roles 未映射 / prose / 无小节 → 整体跳过（R-v11-1）', () => {
  it('prose 工作流改 members → 小节原样保留 + workflow_narrow_skipped（不整段清空）', () => {
    const md = fixture('prose.md')
    const { markdown, issues } = patchTeamRaw(md, { members: [{ role: 'dev-1', count: 1 }] })
    expect(meaningfulWorkflowSection(markdown)).toBe(meaningfulWorkflowSection(md))
    expect(markdown).toContain('先探索，再设计，最后交付。没有表格。')
    expect(issues.map((i) => i.code)).toContain('workflow_narrow_skipped')
    expect(issues.map((i) => i.code)).not.toContain('workflow_pruned')
  })

  it('无「负责角色」列改 members → 工作流表逐行原样保留 + workflow_narrow_skipped', () => {
    const md = fixture('no-roles.md')
    const { markdown, issues } = patchTeamRaw(md, { members: [{ role: 'dev-1', count: 1 }] })
    expect(meaningfulWorkflowSection(markdown)).toBe(meaningfulWorkflowSection(md))
    expect(issues.map((i) => i.code)).toContain('workflow_narrow_skipped')
    expect(issues.map((i) => i.code)).not.toContain('workflow_pruned')
  })

  it('无 `## 工作流` 小节改 members → workflow_narrow_skipped（不造小节）', () => {
    const md = fixture('section-missing.md')
    const { markdown, issues } = patchTeamRaw(md, { members: [{ role: 'dev-1', count: 1 }] })
    expect(markdown).not.toContain('## 工作流')
    expect(issues.map((i) => i.code)).toContain('workflow_narrow_skipped')
  })
})

describe('patchTeamRaw 收窄：roles 已映射 → serialize 保列集', () => {
  it('多余列：未映射列按 rowId 保住，被剔除阶段的行连同其列一起删除', () => {
    const md = fixture('extra-columns.md')
    const { markdown, issues } = patchTeamRaw(md, { members: [{ role: 'dev-1', count: 2 }] })
    expect(issues.map((i) => i.code)).toContain('workflow_pruned')
    expect(issues.map((i) => i.code)).not.toContain('workflow_narrow_skipped')

    const after = parseWorkflowSection(markdown)
    expect(after.raw?.columns).toEqual([
      '#',
      '阶段',
      '负责角色',
      '串/并行',
      '输入',
      '输出',
      '完成判定',
      '回流路径',
      '备注',
      '负责人',
    ])
    expect(after.stages.map((s) => s.stage)).toEqual(['探索', '交付'])
    expect(after.stages.map((s) => s.roles)).toEqual([['dev-1#1', 'dev-1#2'], ['dev-1']])
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    const ownerIndex = after.raw?.columns.indexOf('负责人') ?? -1
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['时间盒 2 天', '无'])
    expect(after.raw?.rows.map((row) => row[ownerIndex])).toEqual(['张三', '张三'])
    expect(after.unmappedColumns).toEqual(['备注', '负责人'])
  })

  it('标准 8 列收窄：剔除阶段并重编号、角色按名册裁剪（既有口径不变）', () => {
    const md = fixture('standard-8col.md')
    const { markdown, issues } = patchTeamRaw(md, {
      members: [
        { role: 'dev', count: 2 },
        { role: 'reviewer', count: 1 },
      ],
    })
    expect(issues.map((i) => i.code)).toContain('workflow_pruned')

    const after = parseWorkflowSection(markdown)
    expect(after.stages.map((s) => s.stage)).toEqual([
      '需求收集',
      '设计',
      '设计审核',
      '任务分解',
      '开发+自测',
      '代码检视',
      '验收',
    ])
    expect(after.stages.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(after.stages[4].roles).toEqual(['dev'])
    expect(after.raw?.columns).toEqual(['#', '阶段', '负责角色', '串/并行', '输入', '输出', '完成判定', '回流路径'])
    expect(after.unmappedColumns).toEqual([])
    expect(after.issues).toEqual([])
  })
})

describe('narrowWorkflow：区分「roles 为空」与「roles 未映射」', () => {
  it('rolesMapped=false → 不裁剪/不删除/不重编号；缺省 true → roles 为空的阶段删除', () => {
    const stages: WorkflowStage[] = [
      { order: 5, stage: '甲', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '' },
    ]
    const unmapped = narrowWorkflow(stages, new Set(['dev-1']), { rolesMapped: false })
    expect(unmapped.stages).toEqual(stages)
    expect(unmapped.prunedRoles).toEqual([])
    expect(unmapped.prunedStages).toEqual([])
    expect(unmapped.keptIndexes).toEqual([0])

    const mapped = narrowWorkflow(stages, new Set(['dev-1']))
    expect(mapped.prunedStages).toEqual(['甲'])
    expect(mapped.stages).toEqual([])
    expect(mapped.keptIndexes).toEqual([])
  })
})

/** 解析结果 → PATCH 提交形态（带 rowId，模拟前端「读 raw → 编辑 → 提交」）。 */
function toRows(parsed: ReturnType<typeof parseWorkflowSection>): WorkflowSerializeRow[] {
  const rowIds = parsed.raw?.rowIds ?? []
  return parsed.stages.map((stage, index) => ({
    rowId: rowIds[index],
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

/**
 * v11 F2 批 B：`TeamPatch.workflow`（结构化保存工作流语义）+ `EditTeamInput.ifMatch`
 * （陈旧写防护）。design-v11 §2/§3（R-v11-3 / R-v11-11 / R-v11-13 / R-v11-15）。
 */
describe('patchTeamRaw workflow 分支（结构化保存）', () => {
  it('保未映射列：仅改列序（阶段排序）→ 未映射列按 rowId 跟随，不错行', () => {
    const md = fixture('sort-unmapped.md')
    const parsed = parseWorkflowSection(md)
    const rows = toRows(parsed)
    // 新顺序 = 丙 → 甲 → 乙（rowId 随行携带）
    const submitted = [rows[2], { ...rows[0], stage: '甲改' }, rows[1]].map((row, index) => ({
      ...row,
      order: index + 1,
    }))
    const { markdown, issues } = patchTeamRaw(md, { workflow: { stages: submitted } })
    expect(issues.map((i) => i.code)).not.toContain('workflow_narrow_skipped')

    const after = parseWorkflowSection(markdown)
    expect(after.stages.map((s) => s.stage)).toEqual(['丙', '甲改', '乙'])
    expect(after.stages.map((s) => s.order)).toEqual([1, 2, 3])
    expect(after.raw?.columns).toEqual([
      '#',
      '阶段',
      '负责角色',
      '串/并行',
      '输入',
      '输出',
      '完成判定',
      '回流路径',
      '备注',
    ])
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['丙的备注', '甲的备注', '乙的备注'])
  })

  it('删除行：原 raw 有而未提交的 rowId 连同未映射列一起消失', () => {
    const md = fixture('extra-columns.md')
    const rows = toRows(parseWorkflowSection(md))
    // 只提交第 1、3 行（r2 测试行删除）
    const { markdown } = patchTeamRaw(md, {
      workflow: { stages: [rows[0], { ...rows[2], order: 2 }] },
    })
    const after = parseWorkflowSection(markdown)
    expect(after.stages.map((s) => s.stage)).toEqual(['探索', '交付'])
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['时间盒 2 天', '无'])
  })

  it('prose → 无 raw 起点：列集 = 核心八列 + `原文`（前端的「结构化为表格」）', () => {
    const md = fixture('prose.md')
    const original = '先探索，再设计，最后交付。没有表格。'
    const { markdown } = patchTeamRaw(md, {
      workflow: {
        stages: [
          {
            order: 1,
            stage: '探索',
            roles: ['dev-1'],
            mode: 'serial',
            input: '任务书',
            output: 'recon.md',
            done: '结论落盘',
            reflow: '',
            extra: { 原文: original },
          },
        ],
      },
    })
    const after = parseWorkflowSection(markdown)
    expect(after.raw?.columns).toEqual([
      '#',
      '阶段',
      '负责角色',
      '串/并行',
      '输入',
      '输出',
      '完成判定',
      '回流路径',
      '原文',
    ])
    expect(after.unmappedColumns).toEqual(['原文'])
    const originIndex = after.raw?.columns.indexOf('原文') ?? -1
    expect(after.raw?.rows.map((row) => row[originIndex])).toEqual([original])
    // 只动 `## 工作流` 小节；后续小节（含「阶段」表）语义不动（R-v11-2）
    expect(markdown).toContain('frontend-design')
    expect(markdown).toContain('## 交付技能组合（跨小节误命中回归）')
  })

  it('转义写侧：值含 `|` / 多行 → 写 `\\|` / `<br>`，读回逐字等价', () => {
    const md = fixture('sort-unmapped.md')
    const rows = toRows(parseWorkflowSection(md)).slice(0, 1)
    const { markdown } = patchTeamRaw(md, {
      workflow: {
        stages: [
          {
            ...rows[0],
            stage: '甲',
            extra: { 备注: '含裸竖线 | 与第二行\n第三行' },
          },
        ],
      },
    })
    expect(markdown).toContain('\\|')
    expect(markdown).toContain('<br>')
    const after = parseWorkflowSection(markdown)
    const noteIndex = after.raw?.columns.indexOf('备注') ?? -1
    // `\|` 解码回 `|`，`<br>` 原样保留（读侧不解码换行，design-v11 §2）
    expect(after.raw?.rows.map((row) => row[noteIndex])).toEqual(['含裸竖线 | 与第二行<br>第三行'])
  })

  it('无 `## 工作流` 小节 → 抛 WorkflowSectionMissingError（不静默空操作、不自动插小节）', () => {
    const md = fixture('section-missing.md')
    expect(() =>
      patchTeamRaw(md, {
        workflow: {
          stages: [
            {
              order: 1,
              stage: '探索',
              roles: [],
              mode: 'serial',
              input: '',
              output: '',
              done: '',
              reflow: '',
            },
          ],
        },
      }),
    ).toThrow(WorkflowSectionMissingError)
    try {
      patchTeamRaw(md, { workflow: { stages: [] } })
    } catch (err) {
      expect((err as WorkflowSectionMissingError).code).toBe('workflow_section_missing')
    }
  })

  it('members 与 workflow 同给 → workflow 胜（名册不触发收窄）+ workflow_narrow_skipped', () => {
    const md = fixture('extra-columns.md')
    const rows = toRows(parseWorkflowSection(md))
    const { markdown, issues } = patchTeamRaw(md, {
      members: [{ role: 'dev-1', count: 1 }],
      workflow: { stages: rows },
    })
    expect(issues.map((i) => i.code)).toContain('workflow_narrow_skipped')
    expect(issues.map((i) => i.code)).not.toContain('workflow_pruned')

    const after = parseWorkflowSection(markdown)
    // tester 不在新名册里，但 workflow 胜 → 阶段原样保留（未收窄）
    expect(after.stages.map((s) => s.stage)).toEqual(['探索', '测试', '交付'])
    expect(markdown).toContain('- role: dev-1')
    expect(markdown).not.toContain('- role: tester')
  })

  it('workflow-only 补丁不改 frontmatter（只动工作流表）', () => {
    const md = fixture('sort-unmapped.md')
    const rows = toRows(parseWorkflowSection(md))
    const { markdown } = patchTeamRaw(md, { workflow: { stages: rows } })
    expect(markdown).toContain('team_id: sort-team')
    // frontmatter 由 renderMarkdownFile 重排（既有行为）：只断言语义值仍在，不断言原始引号形态
    expect(markdown).toContain('阶段增删排序后，未映射列必须按 rowId 跟随（不错行）。')
    expect(markdown).toContain('- role: dev-1')
  })
})

/**
 * v11 派修 B-1（红线 R7）：写回只换**表格区行区间**——小节内的段落/引用块/第二张表
 * 逐行存活；workflow 分支把读侧 issue 原样透出（旧实现 `issues: []`，删正文却零诊断）。
 */
describe('patchTeamRaw：小节内混排存活（B-1 红线回归）', () => {
  it('workflow 补丁：段落 / 引用块 / 第二张表 保存后逐行存活 + 读侧 issues 透传', () => {
    const md = fixture('mixed-content.md')
    const parsed = parseWorkflowSection(md)
    const { markdown, issues } = patchTeamRaw(md, { workflow: { stages: toRows(parsed) } })

    expect(markdown).toContain('本团队的工作流如下（这段说明不属于表格，保存时不得删除）：')
    expect(markdown).toContain('> 补充说明：引用块也不是表格，保存必须保留。')
    expect(markdown).toContain('| 附 | 第二张表按正文保留 |')
    expect(markdown).toContain('下一小节正文。')
    // workflow 分支透传读侧 issue（B-1：旧实现此数组恒空）
    expect(issues.map((i) => i.code)).toContain('workflow_multiple_tables')
    expect(issues.every((i) => i.level === 'warning')).toBe(true)
    // 语义仍正确回读
    expect(parseWorkflowSection(markdown).stages.map((s) => s.stage)).toEqual(['探索', '交付'])
  })

  it('members 收窄路径同样只换表区（段落 / 第二张表 不丢）', () => {
    const md = fixture('mixed-content.md')
    const { markdown, issues } = patchTeamRaw(md, { members: [{ role: 'dev-1', count: 1 }] })
    expect(markdown).toContain('本团队的工作流如下（这段说明不属于表格，保存时不得删除）：')
    expect(markdown).toContain('> 补充说明：引用块也不是表格，保存必须保留。')
    expect(markdown).toContain('| 附 | 第二张表按正文保留 |')
    expect(issues.map((i) => i.code)).toContain('workflow_multiple_tables')
  })

  it('M-12：prose 转表格 → workflow_prose_replaced warning（原文不会自动保留）', () => {
    const md = fixture('prose.md')
    const { markdown, issues } = patchTeamRaw(md, {
      workflow: {
        stages: [
          { order: 1, stage: '探索', roles: ['dev-1'], mode: 'serial', input: '', output: '', done: '', reflow: '' },
        ],
      },
    })
    expect(issues.map((i) => i.code)).toContain('workflow_prose_replaced')
    expect(markdown).not.toContain('先探索，再设计，最后交付。没有表格。')
    expect(parseWorkflowSection(markdown).stages.map((s) => s.stage)).toEqual(['探索'])
  })
})

/**
 * v11 派修 M-5：`bodyLineOffset` 的 `raw.endsWith(body)` 在 CRLF 下恒 false（body 已 LF 归一）
 * → prefix=0 → 同一内容 CRLF 与 LF 报不同行号。CRLF 语料在测试内构造：仓库 `.gitattributes`
 * 是 `* text=auto eol=lf`，提交一个 CRLF fixture 会在 checkout 时被归一成 LF（测不到真路径）。
 */
describe('patchTeamRaw：issue 行号 CRLF/LF 一致（M-5）', () => {
  it('同一内容 CRLF 与 LF 报同行号，且行号来自整份文件', () => {
    const lf = fixture('ragged-order.md')
    const crlf = lf.replace(/\n/g, '\r\n')
    const lfIssues = patchTeamRaw(lf, { members: [{ role: 'dev-1', count: 1 }] }).issues
    const crlfIssues = patchTeamRaw(crlf, { members: [{ role: 'dev-1', count: 1 }] }).issues
    expect(crlfIssues).toEqual(lfIssues)

    const defaulted = lfIssues.find((issue) => issue.code === 'workflow_order_defaulted')
    expect(defaulted).toBeDefined()
    const line = Number(/第 (\d+) 行/.exec(defaulted!.message)?.[1])
    expect(line).toBeGreaterThan(10)
    expect(lfIssues.find((issue) => issue.code === 'workflow_row_ragged')?.message).toContain('第 17 行')
  })
})

/**
 * v11 派修 M-2：`workflow.columns` 列集通道（agents 层）——增自定义列带值落盘、
 * 删列生效（值不再出现）。列序错位的按名寻址在 `team-workflow-serialize.test.ts`。
 */
describe('patchTeamRaw workflow：columns 列集通道（M-2）', () => {
  it('增自定义列带值 → 列与值落盘；删列 → 列与值不再出现', () => {
    const md = fixture('sort-unmapped.md')
    const parsed = parseWorkflowSection(md)
    const columns = parsed.raw?.columns ?? []
    const owners = ['张三', '李四', '王五']
    const rows = toRows(parsed).map((row, index) => ({ ...row, extra: { 负责人: owners[index]! } }))

    const added = patchTeamRaw(md, { workflow: { stages: rows, columns: [...columns, '负责人'] } })
    const afterAdd = parseWorkflowSection(added.markdown)
    expect(afterAdd.raw?.columns).toEqual([...columns, '负责人'])
    const ownerIndex = afterAdd.raw?.columns.indexOf('负责人') ?? -1
    expect(afterAdd.raw?.rows.map((row) => row[ownerIndex])).toEqual(owners)
    // 原未映射列「备注」按名回落仍在
    const noteIndex = afterAdd.raw?.columns.indexOf('备注') ?? -1
    expect(afterAdd.raw?.rows.map((row) => row[noteIndex])).toEqual(['甲的备注', '乙的备注', '丙的备注'])

    const dropped = patchTeamRaw(md, {
      workflow: { stages: toRows(parsed), columns: columns.filter((column) => column !== '备注') },
    })
    expect(dropped.markdown).not.toContain('甲的备注')
    expect(parseWorkflowSection(dropped.markdown).raw?.columns).not.toContain('备注')
  })
})

describe('editTeam ifMatch（陈旧写防护，R-v11-15）', () => {
  it('ifMatch 匹配 → 写入成功；不匹配 → stale_write 且不落盘', async () => {
    const teamsDir = makeTmp()
    const path = join(teamsDir, 'no-roles-team.md')
    writeFileSync(path, fixture('no-roles.md'), 'utf8')
    const fresh = Math.round(statSync(path).mtimeMs)

    const first = await editTeam({ teamId: 'no-roles-team', teamsDir, patch: { name: '第一次' }, ifMatch: fresh })
    expect(first.written).toEqual([path])
    expect(readFileSync(path, 'utf8')).toContain('第一次')

    const stale = await editTeam({ teamId: 'no-roles-team', teamsDir, patch: { name: '第二次' }, ifMatch: fresh }).catch(
      (err: unknown) => err,
    )
    expect(stale).toBeInstanceOf(TeamWriteError)
    expect((stale as TeamWriteError).code).toBe('stale_write')
    // 不落盘：文件名仍是第一次写的内容
    expect(readFileSync(path, 'utf8')).toContain('第一次')
    expect(readFileSync(path, 'utf8')).not.toContain('第二次')

    // 带上新 mtime → 放行
    const retry = await editTeam({
      teamId: 'no-roles-team',
      teamsDir,
      patch: { name: '第二次' },
      ifMatch: Math.round(statSync(path).mtimeMs),
    })
    expect(retry.written).toEqual([path])
    expect(readFileSync(path, 'utf8')).toContain('第二次')
  })

  it('未给 ifMatch → 不做并发校验（向后兼容，既有调用方不受影响）', async () => {
    const teamsDir = makeTmp()
    const path = join(teamsDir, 'no-roles-team.md')
    writeFileSync(path, fixture('no-roles.md'), 'utf8')
    const result = await editTeam({ teamId: 'no-roles-team', teamsDir, patch: { name: '无防护' } })
    expect(result.written).toEqual([path])
  })

  it('ifMatch 在目标不存在时仍报 team_not_found（先判存在再判陈旧）', async () => {
    const teamsDir = makeTmp()
    const err = await editTeam({ teamId: 'ghost', teamsDir, patch: { name: 'x' }, ifMatch: 1 }).catch(
      (e: unknown) => e,
    )
    expect((err as TeamWriteError).code).toBe('team_not_found')
  })
})
