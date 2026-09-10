/**
 * 团队继承合并（team-definition.md §2.1 `extends`，决策 #5）。
 *
 * 语义（标准「基底 + 覆盖」）：
 * - 父团队定义做**基底**；
 * - 子团队**显式声明**的字段覆盖父级；
 * - 数组字段（members/skills/arbitration/workflow）**子级整体替换**——
 *   声明即全量，不做隐式拼接（拼接的意外组合比少几项更危险）；
 * - 标量（description/default/deposit/rework_limit/knowledge）子级未声明则继承；
 * - 环检测与最大深度护栏：extends 链最多 8 层，成环 → `team_extends_cycle`。
 */

import { PrismError } from '@prism/core'

import type { TeamDefinition } from '../types.js'

/** 最大继承深度（护栏：防止恶意/误写的深链）。 */
export const MAX_EXTENDS_DEPTH = 8

/** 父团队加载器（teamsDir 下的按 id 解析）。 */
export type TeamResolver = (teamId: string) => Promise<TeamDefinition | null>

/** 需要判「子级是否显式声明」的字段（解析器产出的 TeamDefinition 无法区分 null/缺省，故由调用方传入源数据）。 */
export interface MergeTeamInput {
  /** 子团队定义（已解析） */
  team: TeamDefinition
  /** 子团队**显式声明**的字段名集合（来自 frontmatter 原始键） */
  declared: Set<string>
}

/**
 * 判断字段该用子级还是父级：数组字段只要声明即全量替换；标量未声明则继承。
 */
function pick<T>(childValue: T | undefined, declared: boolean, parentValue: T | undefined): T | undefined {
  // 声明且非空 → 子级生效
  if (declared && childValue !== undefined && childValue !== ('' as unknown) && !(Array.isArray(childValue) && (childValue as unknown[]).length === 0)) {
    return childValue
  }
  // 未声明但解析器补了非空默认（如空串）→ 仍视为未声明，回落父级
  return parentValue ?? childValue
}

/**
 * 解析 extends 链并合并。
 *
 * @param input 子团队 + 显式声明字段
 * @param resolve 按 id 加载父团队
 */
export async function resolveTeamExtends(
  input: MergeTeamInput,
  resolve: TeamResolver,
): Promise<TeamDefinition> {
  const chain: string[] = []
  let current = input.team
  let declared = input.declared

  // 沿 extends 链向上收集，逐层以父级做基底
  for (let depth = 0; ; depth++) {
    const parentId = current.extends
    if (parentId === null || parentId === undefined || parentId === '') break
    if (depth >= MAX_EXTENDS_DEPTH) {
      throw new PrismError(
        'team_extends_depth',
        `extends 链超过 ${MAX_EXTENDS_DEPTH} 层（起点 ${input.team.team_id}；最后一级 ${parentId}）`,
      )
    }
    if (chain.includes(parentId)) {
      throw new PrismError(
        'team_extends_cycle',
        `extends 成环: ${[...chain, parentId].join(' → ')}`,
        { chain: [...chain, parentId] },
      )
    }
    const parent = await resolve(parentId)
    if (parent === null) {
      throw new PrismError('not_found', `extends 的父团队不存在: ${parentId}（${input.team.team_id} 继承它）`)
    }
    chain.push(parentId)
    // 合并：parent 基底 + current 覆盖。
    // **合并结果清掉 extends**——这条继承边已消费；下一轮该看父级自己的 extends
    //（已并入 parent.extends），否则会重复解析同一父级被误判成环。
    const merged = mergeInto(parent, current, declared)
    current = { ...merged, extends: parent.extends }
    // 上一层的「显式声明」对再上一层不生效（父级自己的 extends 由父级文件决定）
    declared = new Set<string>(['team_id', 'name', 'extends'])
  }
  return current
}

/** 以 base 为基底、overlay 覆盖，产出合并定义。 */
function mergeInto(base: TeamDefinition, overlay: TeamDefinition, declared: Set<string>): TeamDefinition {
  return {
    team_id: overlay.team_id,
    name: overlay.name,
    description: pick(overlay.description, declared.has('description'), base.description) ?? '',
    default: declared.has('default') ? overlay.default : base.default,
    extends: overlay.extends,
    members: pick(overlay.members, declared.has('members'), base.members) ?? [],
    skills: pick(overlay.skills, declared.has('skills'), base.skills) ?? [],
    knowledge: pick(overlay.knowledge, declared.has('knowledge'), base.knowledge) ?? {
      layers: ['global', 'project'],
    },
    deposit: declared.has('deposit') ? overlay.deposit : base.deposit,
    arbitration: pick(overlay.arbitration, declared.has('arbitration'), base.arbitration) ?? [],
    rework_limit: declared.has('rework_limit') ? overlay.rework_limit : base.rework_limit,
    workflow: pick(overlay.workflow, declared.has('workflow'), base.workflow) ?? [],
    body: overlay.body,
  }
}
