import { describe, expect, it } from 'vitest'

import { TeamParseError, parseRoleCell, parseTeamMarkdown, parseWorkflowTable } from '../src/team/parse.js'
import { renderZcodeTeam } from '../src/team/render.js'

/** 与 team-definition.md §2.1/§2.2/§8 同构的出厂团队（多角色工作流 + 队长 + 实例记号 + 规则沉淀）。 */
const CORE_DEV_TEAM = [
  '---',
  'team_id: core-dev',
  'name: 核心研发团队',
  'description: >',
  '  负责本项目的设计、开发、测试与质量收口；内置固定工作流。',
  'default: true',
  'extends: null',
  'members:',
  '  - role: dev-1',
  '    count: 2',
  '  - role: super-dev',
  '    count: 1',
  '  - role: tester',
  '    count: 1',
  '  - role: qa-checker',
  '    count: 1',
  'skills: [code_review]',
  'knowledge:',
  '  layers: [global, project]',
  '  books: []',
  'deposit:',
  '  enabled: true',
  '  default_layer: project',
  '  default_type: pitfall',
  '  priority: medium',
  '  require_note: true',
  '  rules:',
  '    - match: { type: rule }',
  '      set: { layer: global, priority: high }',
  '    - match: { tags: [security] }',
  '      set: { layer: global, priority: high }',
  'arbitration: [safety, requirement, quality, progress]',
  'rework_limit: 2',
  '---',
  '',
  '# 核心研发团队',
  '',
  '## 工作流',
  '',
  '| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |',
  '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  '| 1 | 探索 | dev-1/2 | 并行 | 任务书 | exploration.md | 结论落盘 | 缺资料 → 补调研 |',
  '| 2 | 设计 | 队长 | 串行 | exploration.md | design.md | 需求全覆盖 | — |',
  '| 3 | 设计审核 | qa-checker | 串行 | design.md | design-review.md + .design_ok | 门禁落盘 | 架构级 → 队长 |',
  '| 4 | 开发 | dev-1/2 + super-dev | 并行 | design.md | stream-N.md | 自验通过 | 卡死 2 次 → super-dev |',
  '| 5 | 测试 | tester | 串行 | 任务书 + 各流报告 | test-report.md | 全项有运行证据 | bug → 对应流 → 回归 |',
  '| 6 | 总审 | qa-checker | 串行 | 全部 | qa-report.md + .qa_ok | 门禁落盘 | 超范围 → 返工（≤2 轮） |',
  '| 7 | 交付 | 队长 | — | 全部 | DELIVERY.md | 用户验收 | — |',
  '',
  '## 门禁',
  '',
  '| 门禁文件 | 执笔 | 放行条件 |',
  '| :--- | :--- | :--- |',
  '| `.design_ok` | qa-checker | 设计覆盖全部需求 |',
].join('\n')

describe('团队解析（frontmatter + 工作流表格）', () => {
  const team = parseTeamMarkdown(CORE_DEV_TEAM, { sourcePath: 'teams/core-dev.md' })

  it('frontmatter 全字段解析（多行 > / flow / 嵌套映射 / 序列-of-映射）', () => {
    expect(team.team_id).toBe('core-dev')
    expect(team.name).toBe('核心研发团队')
    expect(team.description).toContain('固定工作流')
    expect(team.default).toBe(true)
    expect(team.extends).toBeNull()
    expect(team.members).toEqual([
      { role: 'dev-1', count: 2 },
      { role: 'super-dev', count: 1 },
      { role: 'tester', count: 1 },
      { role: 'qa-checker', count: 1 },
    ])
    expect(team.skills).toEqual(['code_review'])
    expect(team.knowledge).toEqual({ layers: ['global', 'project'] })
    expect(team.deposit.enabled).toBe(true)
    expect(team.deposit.default_layer).toBe('project')
    expect(team.deposit.default_type).toBe('pitfall')
    expect(team.deposit.priority).toBe('medium')
    expect(team.deposit.require_note).toBe(true)
    expect(team.deposit.rules).toEqual([
      { match: { type: 'rule' }, set: { layer: 'global', priority: 'high' } },
      { match: { tags: ['security'] }, set: { layer: 'global', priority: 'high' } },
    ])
    expect(team.arbitration).toEqual(['safety', 'requirement', 'quality', 'progress'])
    expect(team.rework_limit).toBe(2)
    expect(team.body).toContain('## 门禁')
  })

  it('工作流表：7 个阶段；dev-1/2 展开实例记号；队长保留；「—」按串行', () => {
    expect(team.workflow).toHaveLength(7)
    const explore = team.workflow[0]
    expect(explore.order).toBe(1)
    expect(explore.stage).toBe('探索')
    expect(explore.roles).toEqual(['dev-1#1', 'dev-1#2'])
    expect(explore.mode).toBe('parallel')
    const design = team.workflow[1]
    expect(design.roles).toEqual(['队长'])
    expect(design.mode).toBe('serial')
    const develop = team.workflow[3]
    expect(develop.roles).toEqual(['dev-1#1', 'dev-1#2', 'super-dev'])
    expect(develop.mode).toBe('parallel')
    const deliver = team.workflow[6]
    expect(deliver.mode).toBe('serial') // 「—」无串并行语义 → 默认串行
    expect(deliver.output).toBe('DELIVERY.md')
  })

  it('缺失「## 工作流」小节 → 空数组（不炸）', () => {
    const bare = parseTeamMarkdown('---\nteam_id: t\nname: n\ndescription: d\n---\n\n正文')
    expect(bare.workflow).toEqual([])
  })

  it('表格行不合法 → team_parse_failed 带行号（design-v3 §7）', () => {
    const bad = [
      '---',
      'team_id: t',
      'name: n',
      'description: d',
      '---',
      '',
      '## 工作流',
      '',
      '| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
      '| 1 | 探索 | dev-1 | 并行 | 任务书 | exploration.md | 结论落盘 |',
    ].join('\n')
    expect(() => parseTeamMarkdown(bad)).toThrow(TeamParseError)
    try {
      parseTeamMarkdown(bad)
    } catch (err) {
      expect((err as TeamParseError).code).toBe('team_parse_failed')
      expect((err as TeamParseError).line).toBe(11) // 坏行在整份文件的第 11 行
    }
  })

  it('缺 frontmatter → team_parse_failed；frontmatter 不支持语法同样可读报错', () => {
    expect(() => parseTeamMarkdown('# 无 frontmatter')).toThrow(TeamParseError)
    expect(() => parseTeamMarkdown('---\nteam_id: &a x\n---\n')).toThrow(TeamParseError)
  })

  it('渲染 → 再解析往返等价（renderZcodeTeam ∘ parseTeamMarkdown）', () => {
    const round = parseTeamMarkdown(renderZcodeTeam(team))
    expect(round.team_id).toBe(team.team_id)
    expect(round.name).toBe(team.name)
    expect(round.description).toBe(team.description)
    expect(round.default).toBe(team.default)
    expect(round.extends).toBeNull()
    expect(round.members).toEqual(team.members)
    expect(round.skills).toEqual(team.skills)
    expect(round.knowledge).toEqual(team.knowledge)
    expect(round.deposit).toEqual(team.deposit)
    expect(round.arbitration).toEqual(team.arbitration)
    expect(round.rework_limit).toBe(team.rework_limit)
    expect(round.workflow).toEqual(team.workflow)
    expect(round.body).toBe(team.body)
  })

  it('parseRoleCell：多角色 + 实例记号 + 空位', () => {
    expect(parseRoleCell('dev-1/2 + super-dev', 1)).toEqual(['dev-1#1', 'dev-1#2', 'super-dev'])
    expect(parseRoleCell('队长', 1)).toEqual(['队长'])
    expect(parseRoleCell('dev-1#2', 1)).toEqual(['dev-1#2'])
    expect(parseRoleCell('—', 1)).toEqual([])
  })

  it('parseWorkflowTable 独立可用', () => {
    const stages = parseWorkflowTable(CORE_DEV_TEAM.slice(CORE_DEV_TEAM.indexOf('## 工作流')))
    expect(stages).toHaveLength(7)
  })
})
