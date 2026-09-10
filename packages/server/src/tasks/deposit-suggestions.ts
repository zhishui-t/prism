/**
 * 任务完成 → 沉淀建议清单（design-v4 F-E3；队长裁决 A4）。
 *
 * 口径（裁决 A4）：
 * - `COMPLETED` → **只提示「待收口后沉淀」**（`deposit_hint: 'await_close'`），**不给清单**
 *   （返工后建议会过期，早给等于制造返工）；
 * - `CLOSED` → 给 `deposit_suggestions` 清单（终态，不会再返工）。
 *
 * 来源（零 LLM，确定性）：任务行 `team_id` → 团队 `deposit` 规则
 * + 任务 `stage`/`description` 关键词映射。**只建议、不落库**（R3：Prism 不做审核）。
 *
 * 不返回该字段的三种情况（不打扰）：无团队 / `deposit.enabled=false` / 团队无规则。
 */

import type { DepositPolicy, DepositRule } from '@prism/agents'

/** 一条沉淀建议（形状见 design-v4 F-E3；**不加额外字段**，避免与冻结口径漂移）。 */
export interface DepositSuggestion {
  /** 建议的条目类型（EntryType） */
  kind: string
  /** 建议的层（global/project/role） */
  layer: string
  /** 建议优先级（low/medium/high） */
  priority: string
  /** 为什么给出这条建议（可解释：命中的规则或默认配置） */
  reason: string
  /** 团队是否要求带来源说明（落库时 `require_note` 的机械校验） */
  require_note: boolean
}

export interface DepositSuggestionInput {
  policy: DepositPolicy
  /** 任务阶段（`tasks.stage`） */
  stage?: string
  /** 任务描述（`tasks.description`） */
  description?: string
}

/**
 * 关键词 → 条目类型的确定性映射（首个命中的顺序即优先级）。
 * 只做**子串包含**（大小写不敏感），零 LLM、可复现。
 */
const TYPE_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['pitfall', ['坑', '陷阱', '踩坑', '故障', '事故', '教训', '缺陷', 'bug', 'pitfall']],
  ['rule', ['规范', '约定', '红线', '规则', '标准', '必须', '禁止', 'rule']],
  ['pattern', ['模式', '范式', '套路', '复用', 'pattern']],
  ['guide', ['指南', '步骤', '流程', '怎么做', 'guide']],
  ['diagram', ['架构图', '时序图', '数据流图', '生命周期图', 'diagram']],
  ['doc', ['文档', '说明', '设计稿', 'doc']],
]

/** 从任务文本（stage + description）推断候选条目类型（保序去重）。 */
export function inferDepositKinds(text: string): string[] {
  const haystack = text.toLowerCase()
  if (haystack.trim() === '') return []
  const kinds: string[] = []
  for (const [type, keywords] of TYPE_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k.toLowerCase()))) kinds.push(type)
  }
  return kinds
}

/** 规则是否适用于「任务行」这一上下文（任务行没有 layer/risk/book/module，故这几类键不可判定 → 不适用）。 */
function ruleAppliesToTask(rule: DepositRule, facts: { kinds: string[]; text: string }): boolean {
  for (const [key, expected] of Object.entries(rule.match)) {
    if (key === 'type') {
      if (typeof expected !== 'string' || !facts.kinds.includes(expected)) return false
    } else if (key === 'tags') {
      const want = Array.isArray(expected) ? expected.map(String) : [String(expected)]
      if (!want.every((tag) => tag !== '' && facts.text.toLowerCase().includes(tag.toLowerCase()))) return false
    } else {
      // layer/risk/book/module/未知键：任务行推不出该维度 → 保守不适用（不猜，避免给出错误落点）
      return false
    }
  }
  return true
}

/** `match` 的可读渲染（进 `reason`，供宿主/用户核对规则来源）。 */
function describeMatch(rule: DepositRule): string {
  return Object.entries(rule.match)
    .map(([key, value]) => `${key}:${Array.isArray(value) ? value.map(String).join('|') : String(value)}`)
    .join(',')
}

/**
 * 生成沉淀建议清单。
 *
 * 返回空数组 = 「不返回该字段」的三种情况（无规则 / `enabled=false` / 关键词与规则都推不出内容）。
 */
export function buildDepositSuggestions(input: DepositSuggestionInput): DepositSuggestion[] {
  const policy = input.policy
  if (!policy.enabled) return []
  const rules = policy.rules ?? []
  if (rules.length === 0) return []

  const text = `${input.stage ?? ''}\n${input.description ?? ''}`
  const facts = { kinds: inferDepositKinds(text), text }

  const out: DepositSuggestion[] = []
  const seen = new Set<string>()
  const push = (suggestion: DepositSuggestion): void => {
    const key = `${suggestion.kind}|${suggestion.layer}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(suggestion)
  }

  for (const rule of rules) {
    if (!ruleAppliesToTask(rule, facts)) continue
    const matchedKind = typeof rule.match['type'] === 'string' ? (rule.match['type'] as string) : undefined
    const kind = typeof rule.set['type'] === 'string' ? (rule.set['type'] as string) : (matchedKind ?? policy.default_type)
    const layer = typeof rule.set['layer'] === 'string' ? (rule.set['layer'] as string) : policy.default_layer
    const priority = typeof rule.set['priority'] === 'string' ? (rule.set['priority'] as string) : policy.priority
    push({
      kind,
      layer,
      priority,
      reason: `团队规则 match{${describeMatch(rule)}}`,
      require_note: policy.require_note,
    })
  }

  // 规则存在但都没命中任务事实 → 按团队默认配置给一条（仍属「有规则」，不违反「不打扰」）
  if (out.length === 0) {
    push({
      kind: facts.kinds[0] ?? policy.default_type,
      layer: policy.default_layer,
      priority: policy.priority,
      reason: '团队默认配置（default_type/default_layer）',
      require_note: policy.require_note,
    })
  }
  return out
}
