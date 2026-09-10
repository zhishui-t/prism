/**
 * 团队沉淀策略的**机械执行**（team-definition.md §5）。
 *
 * 红线：Prism 不审核内容，只做「声明 → 机械校验 → 落库」。
 * 这里只做四件事，全部确定性、零 LLM：
 *   1. `enabled` 为 false → 拒绝落库（团队自己关的）；
 *   2. `require_note` 为 true 且缺 `source.ref`/说明 → 拒绝（机械校验）；
 *   3. `default_layer`/`default_type` 填默认值（调用方未显式给时）；
 *   4. `rules` 按 `match`（type/tags）匹配后 `set` 覆盖（layer/type/priority）。
 *
 * 规则本身由团队定义提供，Prism 不判断规则对错。
 */

import type { DepositPolicy, DepositRule } from '../types.js'

/** 落库输入的最小形状（与 @prism/knowledge 的 DepositInput 结构兼容，避免反向依赖）。 */
export interface PolicyDepositInput {
  title: string
  type: string
  layer: string
  owner?: string
  book: string
  module?: string
  content: string
  tags?: string[]
  risk?: string
  confidence?: number
  overrides?: string[]
  visibility?: string
  source?: { kind: 'import' | 'agent' | 'manual'; ref?: string }
  deposited_by?: { subject: string; team?: string }
}

export interface DepositPolicyOutcome {
  /** 是否允许落库（false 时 `errors` 给出原因） */
  allowed: boolean
  /** 拒绝原因（机械校验失败） */
  errors: string[]
  /** 应用默认值与规则覆盖后的输入 */
  input: PolicyDepositInput
  /** 命中的规则下标（留痕/调试） */
  matched_rules: number[]
  /** 富化队列优先级（low=0 / medium=5 / high=10） */
  priority: number
}

const PRIORITY_SCORE: Record<string, number> = { low: 0, medium: 5, high: 10 }

/** 把 `low|medium|high` 映射为工作队列的数值优先级。 */
export function priorityScore(priority: string): number {
  return PRIORITY_SCORE[priority] ?? 5
}

/** 单条规则是否匹配输入（`match` 里所有键都要满足）。 */
function ruleMatches(rule: DepositRule, input: PolicyDepositInput): boolean {
  for (const [key, expected] of Object.entries(rule.match)) {
    if (key === 'type') {
      if (input.type !== expected) return false
    } else if (key === 'layer') {
      if (input.layer !== expected) return false
    } else if (key === 'tags') {
      // tags 匹配：期望是数组时要求「包含全部」；标量时要求「包含该值」
      const want = Array.isArray(expected) ? expected.map(String) : [String(expected)]
      const have = new Set((input.tags ?? []).map(String))
      if (!want.every((t) => have.has(t))) return false
    } else if (key === 'risk') {
      if (input.risk !== expected) return false
    } else {
      // 未知匹配键：不匹配（保守，避免误覆盖）
      return false
    }
  }
  return true
}

/** 应用一条规则的 `set`（只认已知键，未知键忽略）。 */
function applySet(target: PolicyDepositInput, set: Record<string, unknown>): void {
  if (typeof set['layer'] === 'string') target.layer = set['layer']
  if (typeof set['type'] === 'string') target.type = set['type']
  if (typeof set['risk'] === 'string') target.risk = set['risk']
  if (typeof set['visibility'] === 'string') target.visibility = set['visibility']
}

/**
 * 执行团队沉淀策略。
 *
 * @param policy 团队定义里的 `deposit` 配置
 * @param input 宿主提交的落库输入
 */
export function applyDepositPolicy(
  policy: DepositPolicy,
  input: PolicyDepositInput,
): DepositPolicyOutcome {
  const errors: string[] = []

  // ① 团队是否启用沉淀
  if (!policy.enabled) {
    return {
      allowed: false,
      errors: ['团队未启用沉淀（deposit.enabled=false）'],
      input,
      matched_rules: [],
      priority: priorityScore(policy.priority),
    }
  }

  // ② 必带说明（机械校验：source.ref 或 content 非空都算「有说明」）
  if (policy.require_note) {
    const hasNote =
      (input.source?.ref !== undefined && input.source.ref.trim() !== '') ||
      input.content.trim() !== ''
    if (!hasNote) {
      errors.push('团队要求落库必须带说明（deposit.require_note=true），请提供 source.ref 或 content')
    }
  }

  // ③ 默认值（仅当调用方未显式给）
  const next: PolicyDepositInput = { ...input }
  if (next.layer === '' || next.layer === undefined) next.layer = policy.default_layer
  if (next.type === '' || next.type === undefined) next.type = policy.default_type

  // ④ rules 覆盖（按声明顺序，后者覆盖前者）
  let priority: string = policy.priority
  const matched: number[] = []
  for (const [index, rule] of (policy.rules ?? []).entries()) {
    if (!ruleMatches(rule, next)) continue
    matched.push(index)
    applySet(next, rule.set)
    if (typeof rule.set['priority'] === 'string') priority = rule.set['priority']
  }

  return {
    allowed: errors.length === 0,
    errors,
    input: next,
    matched_rules: matched,
    priority: priorityScore(priority),
  }
}
