import { describe, expect, it } from 'vitest'

import { checkPrincipleConsistency, claimsFinalSay, positionInChain } from '../src/role/consistency.js'
import type { RoleDefinition, TeamDefinition } from '../src/types.js'

function role(name: string, principle: string): RoleDefinition {
  return {
    name,
    description: `${name} desc`,
    skills: [],
    knowledge: { layers: ['global', 'project'] },
    principle,
    body: `## 核心第一原则\n${principle}\n`,
  }
}

function team(members: string[], arbitration: string[]): TeamDefinition {
  return {
    team_id: 'core-dev',
    name: 'Core Dev',
    description: 'x',
    default: true,
    extends: null,
    members: members.map((m) => ({ role: m, count: 1 })),
    skills: [],
    knowledge: { layers: ['global'] },
    deposit: {
      enabled: true,
      default_layer: 'project',
      default_type: 'pitfall',
      priority: 'medium',
      require_note: false,
    },
    arbitration,
    rework_limit: 2,
    workflow: [],
    body: '',
  }
}

/** 原则一致性检查（role-definition.md §2.1）。 */
describe('claimsFinalSay', () => {
  it('识别常见绝对话语权措辞', () => {
    expect(claimsFinalSay('安全问题我说了算，最终裁决')).toBe(true)
    expect(claimsFinalSay('存疑即阻断，拥有一票否决权')).toBe(true)
    expect(claimsFinalSay('安全高于一切其他考量')).toBe(true)
    expect(claimsFinalSay('先证明可行再承诺')).toBe(false)
    expect(claimsFinalSay('交付可运行增量，绝不扩大战场')).toBe(false)
  })
})

describe('positionInChain', () => {
  it('按首词匹配仲裁链位置', () => {
    expect(positionInChain('质量一致性优先', ['安全', '质量一致性', '进度'])).toBe(1)
    expect(positionInChain('安全红线不可破', ['安全', '质量一致性', '进度'])).toBe(0)
  })

  it('无交集 → null（不做断言）', () => {
    expect(positionInChain('快速迭代', ['安全', '质量一致性'])).toBeNull()
  })
})

describe('checkPrincipleConsistency', () => {
  it('多个角色宣称最终话语权 → 话语权互斥告警', () => {
    const roles = [
      role('security', '安全问题最终裁决'),
      role('quality', '质量一票否决'),
      role('dev', '交付可运行增量'),
    ]
    const teams = [team(['security', 'quality', 'dev'], ['安全', '质量', '进度'])]
    const result = checkPrincipleConsistency({ roles, teams })

    const secIssues = result.get('security') ?? []
    expect(secIssues.some((i) => i.code === 'principle_final_say_conflict')).toBe(true)
    expect(result.get('quality')?.some((i) => i.code === 'principle_final_say_conflict')).toBe(true)
    // 普通角色无告警
    expect(result.get('dev')).toBeUndefined()
  })

  it('宣称最终话语权但不在链顶端 → 冲突告警', () => {
    const roles = [role('quality', '质量一致性说了算')]
    const teams = [team(['quality'], ['安全', '质量一致性', '进度'])] // 安全在顶端
    const result = checkPrincipleConsistency({ roles, teams })
    expect(result.get('quality')?.some((i) => i.code === 'principle_conflicts_chain')).toBe(true)
  })

  it('在链顶端且唯一 → 无告警', () => {
    const roles = [role('security', '安全高于一切'), role('dev', '交付可运行增量')]
    const teams = [team(['security', 'dev'], ['安全', '进度'])]
    const result = checkPrincipleConsistency({ roles, teams })
    expect(result.size).toBe(0)
  })

  it('成员不属于该团队 → 不检查该角色', () => {
    const roles = [role('security', '安全高于一切'), role('other', '进度说了算')]
    const teams = [team(['security'], ['安全'])] // other 不在团队里
    const result = checkPrincipleConsistency({ roles, teams })
    expect(result.size).toBe(0)
  })

  it('空仲裁链 → 跳过', () => {
    const roles = [role('a', '安全说了算'), role('b', '进度说了算')]
    const teams = [team(['a', 'b'], [])]
    const result = checkPrincipleConsistency({ roles, teams })
    expect(result.size).toBe(0)
  })
})
