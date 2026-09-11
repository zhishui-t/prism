/**
 * F-C4：团队工作流 → archify workflow IR（纯函数）。
 *
 * 判据（design-v5 §2 F-C4）：同输入同字节 + 幂等；中文 / `#` 角色名已 slug 化；
 * `col ∈ 0..5`；D4 角色→类型映射；泳道 = 角色实例。
 * 真实 archify `validateDiagram` 的门禁在 `packages/server/test/arch-from-team.test.ts`（那里能调到渲染器）。
 */
import { describe, expect, it } from 'vitest'

import type { TeamDefinition } from '../src/types.js'
import { parseTeamMarkdown } from '../src/team/parse.js'
import { CORE_DEV_TEAM_MD, MINIMAL_TEAM_MD, fillTeamTemplate } from '../src/team/templates.js'
import { buildTeamWorkflowIr } from '../src/team/workflow-ir.js'

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/** 造一个最简合法团队；`rows` 是工作流表格行。 */
function makeTeam(rows: string[]): TeamDefinition {
  const md = [
    '---',
    'team_id: t1',
    'name: 测试团队',
    'description: 用于 IR 测试',
    'default: false',
    'members:',
    '  - role: dev-1',
    '    count: 2',
    '  - role: tester',
    '    count: 1',
    'skills: []',
    'knowledge:',
    '  layers: [global, project]',
    'deposit:',
    '  enabled: true',
    '  default_layer: project',
    '  default_type: pitfall',
    '  priority: medium',
    '  require_note: false',
    'arbitration: [quality]',
    'rework_limit: 2',
    '---',
    '',
    '# 测试团队',
    '',
    '## 工作流',
    '',
    '| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
    ...rows,
  ].join('\n')
  return parseTeamMarkdown(md)
}

const THREE_STAGES = [
  '| 1 | 开发 | dev-1 | 串行 | 任务书 | patch | 自验通过 | — |',
  '| 2 | 测试 | tester | 串行 | patch | test-report.md | 全项有运行证据 | — |',
  '| 3 | 收口 | 队长 | 串行 | 全部产物 | DELIVERY.md | 用户验收 | — |',
]

describe('buildTeamWorkflowIr：确定性与幂等', () => {
  it('同输入同字节（重复调用 + 重新解析都一致）', () => {
    const first = JSON.stringify(buildTeamWorkflowIr(makeTeam(THREE_STAGES)))
    const second = JSON.stringify(buildTeamWorkflowIr(makeTeam(THREE_STAGES)))
    const reparsed = JSON.stringify(buildTeamWorkflowIr(makeTeam([...THREE_STAGES])))
    expect(second).toBe(first)
    expect(reparsed).toBe(first)
  })

  it('IR 里不含时钟字段（否则哈希每次都变）', () => {
    const text = JSON.stringify(buildTeamWorkflowIr(makeTeam(THREE_STAGES)))
    expect(text).not.toMatch(/created_at|updated_at|timestamp|\d{4}-\d{2}-\d{2}T/)
  })
})

describe('buildTeamWorkflowIr：schema 约束', () => {
  it('所有 id 都合 archify 的 id 规则（字母开头，仅 [A-Za-z0-9_-]）', () => {
    const ir = buildTeamWorkflowIr(makeTeam(THREE_STAGES))
    const ids = [
      ...ir.lanes.map((l) => l.id),
      ...ir.nodes.map((n) => n.id),
      ...ir.nodes.map((n) => n.lane),
      ...ir.phases.map((p) => p.id),
      ...ir.edges.flatMap((e) => [e.from, e.to]),
      ...(ir.mainPath ?? []),
    ]
    for (const id of ids) expect(id, `非法 id: ${id}`).toMatch(ID_PATTERN)
  })

  it('col ∈ 0..5，且随 order 单调不减、同 order 同 col', () => {
    const team = makeTeam(THREE_STAGES)
    const ir = buildTeamWorkflowIr(team)
    const cols = ir.nodes.map((n) => n.col)
    expect(Math.min(...cols)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...cols)).toBeLessThanOrEqual(5)

    const colByOrder = new Map<number, number>()
    for (const node of ir.nodes) {
      const order = Number(node.id.slice(1).split('-')[0])
      const seen = colByOrder.get(order)
      if (seen !== undefined) expect(node.col).toBe(seen)
      else colByOrder.set(order, node.col)
    }
    const orders = [...colByOrder.keys()].sort((a, b) => a - b)
    for (let i = 1; i < orders.length; i++) {
      expect(colByOrder.get(orders[i])!).toBeGreaterThanOrEqual(colByOrder.get(orders[i - 1])!)
    }
  })

  it('阶段 ≥ 2 时给出 mainPath；单阶段不给（schema 要求 minItems 2）', () => {
    expect(buildTeamWorkflowIr(makeTeam(THREE_STAGES)).mainPath).toHaveLength(3)
    const single = buildTeamWorkflowIr(makeTeam(['| 1 | 开发 | dev-1 | 串行 | 任务书 | patch | — | — |']))
    expect(single.mainPath).toBeUndefined()
  })

  it('空工作流 → 抛错（不伪造节点）', () => {
    const team = makeTeam(THREE_STAGES)
    expect(() => buildTeamWorkflowIr({ ...team, workflow: [] })).toThrow(/没有工作流阶段/)
  })

  it('超过 6 个阶段时 col 封顶 5（后续阶段并到最后一列）', () => {
    const rows = Array.from({ length: 9 }, (_, i) => `| ${i + 1} | 阶段${i + 1} | dev-1 | 串行 | in | out | — | — |`)
    const ir = buildTeamWorkflowIr(makeTeam(rows))
    expect(Math.max(...ir.nodes.map((n) => n.col))).toBe(5)
    expect(new Set(ir.nodes.map((n) => n.col)).size).toBeLessThanOrEqual(6)
  })
})

describe('buildTeamWorkflowIr：D4 角色 → 类型映射', () => {
  it('按固定表映射；未匹配一律 external（保守）', () => {
    const team = makeTeam([
      '| 1 | A | dev-1 | 串行 | i | o | — | — |',
      '| 2 | B | super-dev | 串行 | i | o | — | — |',
      '| 3 | C | frontend-1 | 串行 | i | o | — | — |',
      '| 4 | D | tester | 串行 | i | o | — | — |',
      '| 5 | E | qa-checker | 串行 | i | o | — | — |',
      '| 6 | F | reviewer | 串行 | i | o | — | — |',
      '| 7 | G | 队长 | 串行 | i | o | — | — |',
      '| 8 | H | 未知角色 | 串行 | i | o | — | — |',
    ])
    const byLabel = new Map(buildTeamWorkflowIr(team).nodes.map((n) => [n.label, n.type]))
    expect(byLabel.get('A')).toBe('backend')
    expect(byLabel.get('B')).toBe('backend')
    expect(byLabel.get('C')).toBe('frontend')
    expect(byLabel.get('D')).toBe('external')
    expect(byLabel.get('E')).toBe('external')
    expect(byLabel.get('F')).toBe('external')
    expect(byLabel.get('G')).toBe('backend')
    expect(byLabel.get('H')).toBe('external')
  })

  it('映射来源写在 meta.subtitle（schema 不允许 meta 加自定义键）', () => {
    const ir = buildTeamWorkflowIr(makeTeam(THREE_STAGES))
    expect(ir.meta.subtitle).toContain('D4 固定表')
    expect(ir.meta.subtitle).toContain('dev*/super-dev/队长/leader→backend')
  })
})

describe('buildTeamWorkflowIr：slug 化与泳道', () => {
  it('中文角色名 slug 化（队长 → leader），实例记号 slug 化（dev-1#2 → dev-1-2）', () => {
    const team = makeTeam([
      '| 1 | 开发 | dev-1/2 | 并行 | 任务书 | patch | — | — |',
      '| 2 | 收口 | 队长 | 串行 | 全部 | DELIVERY.md | — | — |',
    ])
    const ir = buildTeamWorkflowIr(team)
    expect(ir.lanes.map((l) => l.id).sort()).toEqual(['dev-1-1', 'dev-1-2', 'leader'])
    // label 保留原始中文/实例记号（人读的是 label，不是 id）
    expect(ir.lanes.map((l) => l.label)).toContain('队长')
    expect(ir.lanes.map((l) => l.label)).toContain('dev-1#2')
    expect(JSON.stringify(ir.lanes.map((l) => l.id))).not.toMatch(/[\u4e00-\u9fa5#]/)
  })

  it('并行阶段的每个角色各占一条泳道，同阶段节点同 col', () => {
    const ir = buildTeamWorkflowIr(
      makeTeam(['| 1 | 探索 | dev-1/2 + super-dev | 并行 | 任务书 | exploration.md | — | — |']),
    )
    expect(ir.lanes).toHaveLength(3)
    expect(new Set(ir.nodes.map((n) => n.col)).size).toBe(1)
    expect(ir.nodes.every((n) => n.tag === '并行')).toBe(true)
  })

  it('阶段无角色时落合成泳道 workflow（否则该阶段会从图上消失）', () => {
    const ir = buildTeamWorkflowIr(
      makeTeam([
        '| 1 | 开发 | dev-1 | 串行 | 任务书 | patch | — | — |',
        '| 2 | 空阶段 | — | 串行 | — | — | — | — |',
      ]),
    )
    expect(ir.lanes.some((l) => l.id === 'workflow')).toBe(true)
    expect(ir.nodes.map((n) => n.label)).toContain('空阶段')
  })

  it('相邻阶段之间连线（主路径），边两端都指向存在的节点', () => {
    const ir = buildTeamWorkflowIr(makeTeam(THREE_STAGES))
    const ids = new Set(ir.nodes.map((n) => n.id))
    expect(ir.edges.length).toBeGreaterThanOrEqual(2)
    for (const edge of ir.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })
})

/**
 * archify 把节点 `label`/`sublabel`/`tag` 画成**不换行的单行 `<text>`**，并拒绝
 * 「缩到 6px 仍放不下」的节点（`workflow-compiler.mjs:2265-2273`）。
 * 加宽节点不是出路（实测引发自动布线错位），故 IR 侧必须收敛文本。
 */
describe('buildTeamWorkflowIr：节点文本收敛（archify 单行不换行）', () => {
  /** 与实现同口径的文本单位（全角/星平面 = 2）。 */
  const units = (text: string): number => {
    let total = 0
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0
      total += cp > 0xffff || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xff01 && cp <= 0xff60) ? 2 : 1
    }
    return total
  }

  it('超长 label / sublabel 按单位截断并以省略号收尾（不静默丢字）', () => {
    const longName = '阶段'.repeat(20)
    const longOutput = 'x'.repeat(80)
    const ir = buildTeamWorkflowIr(
      makeTeam([`| 1 | ${longName} | dev-1 | 串行 | in | ${longOutput} | — | — |`]),
    )
    const node = ir.nodes[0]
    expect(node.label.endsWith('…')).toBe(true)
    expect(node.sublabel?.endsWith('…')).toBe(true)
    // 保留前缀（截断而不是清空）
    expect(node.label.startsWith('阶段')).toBe(true)
    expect(node.sublabel?.startsWith('x')).toBe(true)
    // 截断后必须落进可画预算：label ≤ 15 单位、sublabel ≤ 23 单位（默认节点宽 92px 推导）
    expect(units(node.label)).toBeLessThanOrEqual(15)
    expect(units(node.sublabel ?? '')).toBeLessThanOrEqual(23)
  })

  it('短文本原样保留（不引入无谓省略号）', () => {
    const ir = buildTeamWorkflowIr(makeTeam(THREE_STAGES))
    expect(ir.nodes.map((n) => n.label)).toEqual(['开发', '测试', '收口'])
    for (const node of ir.nodes) {
      expect(node.label).not.toContain('…')
      expect(node.sublabel ?? '').not.toContain('…')
    }
  })

  it('截断是确定性的：超长输入下仍同输入同字节', () => {
    const rows = [`| 1 | ${'阶段'.repeat(20)} | dev-1 | 串行 | in | ${'x'.repeat(80)} | — | — |`]
    expect(JSON.stringify(buildTeamWorkflowIr(makeTeam(rows)))).toBe(
      JSON.stringify(buildTeamWorkflowIr(makeTeam(rows))),
    )
  })

  it('阶段名为空 → 稳定兜底标签（schema 要求 label 非空）', () => {
    const team = makeTeam(THREE_STAGES)
    const patched: TeamDefinition = {
      ...team,
      workflow: [{ ...team.workflow[0], stage: '   ' }],
    }
    const node = buildTeamWorkflowIr(patched).nodes[0]
    expect(node.label).toBe('阶段 1') // 稳定兜底，不与真实阶段名冲突
  })
})

describe('buildTeamWorkflowIr：内置模板（真实团队）', () => {
  it('minimal 模板（3 阶段）产出合法 IR', () => {
    const team = fillTeamTemplate(MINIMAL_TEAM_MD, { teamId: 'min-1', name: '最小团队', description: 'x' })
    const ir = buildTeamWorkflowIr(parseTeamMarkdown(team))
    expect(ir.nodes).toHaveLength(3)
    expect(ir.lanes.map((l) => l.id)).toEqual(['dev-1', 'tester', 'leader'])
  })

  it('core-dev 模板（7 阶段）产出合法 IR，col 不超上限', () => {
    const team = fillTeamTemplate(CORE_DEV_TEAM_MD, { teamId: 'core-1', name: '核心研发团队', description: 'x' })
    const ir = buildTeamWorkflowIr(parseTeamMarkdown(team))
    // 7 个阶段 = 7 个节点「列」；并行阶段（`dev-1 + dev-2`、`+ super-dev`）每个角色各一节点 → 共 10
    expect(ir.mainPath).toHaveLength(7)
    expect(ir.nodes).toHaveLength(10)
    expect(Math.max(...ir.nodes.map((n) => n.col))).toBeLessThanOrEqual(5)
  })
})
