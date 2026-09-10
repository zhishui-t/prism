/**
 * 原则一致性检查（role-definition.md §2.1）。
 *
 * 三项检查（全部零 LLM、确定性）：
 *   1. **每个角色是否有原则**（已有 validateRole 覆盖，此处只做汇总入口）；
 *   2. **角色原则是否与团队仲裁链冲突**——机械判据：角色原则宣称「最终/一票否决/
 *      高于一切」类绝对话语权，而该角色在仲裁链中的优先级不是最高；
 *   3. **两个角色对同一决策都宣称最终话语权**——同团队内多个角色的原则都含
 *      绝对话语权措辞。
 *
 * 为什么用措辞启发而不是语义判断：Prism 零 LLM（红线），只能用**确定性词表**。
 * 误报率可控——检查结果是 warning（提示人工确认），不是 error（不阻断）。
 */

import type { RoleDefinition, TeamDefinition, ValidationIssue } from '../types.js'

/** 绝对话语权措辞（命中即视为宣称「最终裁决」）。 */
const FINAL_SAY_PATTERNS: RegExp[] = [
  /最终(裁决|决定|话语权|拍板)/,
  /一票(否决|通过)/,
  /(高于|压过|优先于).{0,6}(一切|所有|全部)/,
  /(安全|质量|进度|需求).{0,4}(第一|至上|高于一切)/,
  /说了算/,
  /不许(推翻|否决)/,
]

/** 是否含绝对话语权措辞。 */
export function claimsFinalSay(principle: string): boolean {
  return FINAL_SAY_PATTERNS.some((re) => re.test(principle))
}

/**
 * 角色在团队仲裁链中的位置（0 = 最高）。
 * 仲裁链形如 `安全 > 需求满足 > 质量一致性 > 进度`；条目是**价值**不是角色名，
 * 这里用角色原则与条目的字面交集做**保守**推断：角色原则提到某条目词即认为
 * 「该角色代表此价值」。推断不出（无交集）返回 null——不做任何断言。
 */
export function positionInChain(principle: string, chain: string[]): number | null {
  // 取仲裁链条目的首词（如「需求满足」→「需求」）做子串匹配
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]?.trim() ?? ''
    if (entry === '') continue
    const head = entry.split(/[>＞,，/、\s]/)[0]?.trim() ?? entry
    if (head.length >= 2 && principle.includes(head)) return i
  }
  return null
}

export interface ConsistencyOptions {
  roles: RoleDefinition[]
  teams: TeamDefinition[]
}

/** 成员角色名集合（大小写不敏感）。 */
function memberNames(team: TeamDefinition): Set<string> {
  return new Set(team.members.map((m) => m.role.toLowerCase()))
}

/**
 * 原则一致性检查：跨角色+团队的组合校验。
 * 结果为 warning 级 issue 列表（挂到各角色的 issues 上由调用方合并展示）。
 */
export function checkPrincipleConsistency(options: ConsistencyOptions): Map<string, ValidationIssue[]> {
  const byRole = new Map<string, ValidationIssue[]>()
  const push = (role: string, issue: ValidationIssue): void => {
    const list = byRole.get(role) ?? []
    list.push(issue)
    byRole.set(role, list)
  }

  const roleByName = new Map(options.roles.map((r) => [r.name.toLowerCase(), r]))

  for (const team of options.teams) {
    const chain = team.arbitration
    if (chain.length === 0) continue
    const members = memberNames(team)
    // 同团队内宣称绝对话语权的角色
    const finalSayers: Array<{ role: RoleDefinition; principle: string }> = []

    for (const [lowerName, isMember] of members.entries()) {
      if (!isMember) continue
      const role = roleByName.get(lowerName)
      if (role === undefined) continue // 成员不存在由 validateTeam 报
      const principle = role.principle?.trim() ?? ''
      if (principle === '') continue // 缺原则由 validateRole 报
      if (!claimsFinalSay(principle)) continue
      finalSayers.push({ role, principle })

      // 检查 ②：宣称最终话语权但不在仲裁链顶端
      const pos = positionInChain(principle, chain)
      if (pos !== null && pos > 0) {
        const top = chain[0]
        push(role.name, {
          level: 'warning',
          code: 'principle_conflicts_chain',
          message: `角色原则宣称最终话语权，但团队「${team.team_id}」仲裁链中「${principle.match(/[\u4e00-\u9fa5A-Za-z]+/)?.[0] ?? '该价值'}」排在第 ${pos + 1} 位（最高为「${top}」）。团队链优先；若角色确实有最终裁决权请调整仲裁链或原则措辞`,
          where: `team:${team.team_id}`,
        })
      }
    }

    // 检查 ③：多个角色都宣称最终话语权（同团队内话语权互斥）
    if (finalSayers.length >= 2) {
      const names = finalSayers.map((f) => f.role.name).join('、')
      for (const { role } of finalSayers) {
        push(role.name, {
          level: 'warning',
          code: 'principle_final_say_conflict',
          message: `团队「${team.team_id}」内 ${finalSayers.length} 个角色（${names}）的原则都宣称最终话语权——同一决策只能有一个裁决者。请确认仲裁链归属`,
          where: `team:${team.team_id}`,
        })
      }
    }
  }

  return byRole
}
