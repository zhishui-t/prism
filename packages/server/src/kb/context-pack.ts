/**
 * 上下文包（knowledge-injection.md §4 模式 B）。
 *
 * 何时用：派发子 agent 任务时，某些知识**必须**在上下文里（安全红线、编码规范），
 * 让 agent 自己去查可能漏查。宿主调 `prism_context_pack { role, task, budget_tokens }`，
 * Prism 按**角色知识绑定 + 任务关键词**检索，组装带预算的包返回。
 *
 * 边界（红线）：
 * - **Prism 只产出包，不控制 prompt**——宿主自己决定拼进 prompt / 存附件 / 只用 sources；
 * - **零 LLM**——纯检索 + 排序 + 截断；
 * - **不塞全库**——预算硬截断并标 `truncated`。
 */

import type { KnowledgeService, Layer, SearchResult } from '@prism/knowledge'

import type { KnowledgeBinding } from '@prism/agents'

export interface ContextPackOptions {
  /** 角色名（用于取 knowledge binding） */
  role: string
  /** 角色定义里的知识绑定 */
  binding: KnowledgeBinding
  /** 任务描述（作为检索词） */
  task: string
  /** token 预算（默认 4000） */
  budgetTokens?: number
  /** 每个命中项最多保留的正文字符数（默认 600） */
  maxExcerptChars?: number
}

export interface ContextPackItem {
  id: string
  version: number
  title: string
  layer: Layer
  book: string
  module: string
  excerpt: string
  /** 归一化相关度（0-1，含分层权重） */
  relevance: number
  /** 来源地址（层[/owner]/书/模块/ID@版次） */
  source: string
}

export interface ContextPack {
  role: string
  task_summary: string
  items: ContextPackItem[]
  /** 知识绑定（原样回传，便于宿主核对） */
  knowledge_binding: KnowledgeBinding
  total_chars: number
  /** token 估算（供宿主核对预算） */
  total_tokens: number
  truncated: boolean
  sources: string[]
}

/** 分层权重：同相关度下 role 层知识优先（§4.5）。 */
const LAYER_WEIGHT: Record<string, number> = { role: 1.0, project: 0.85, global: 0.72 }

/**
 * token 估算：CJK 字符 ≈ 1 token/字，其余 ≈ 1 token/4 字符。
 * 保守偏大（宁可早截断），零依赖。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // CJK 统一表意 / 假名 / 谚文 / 全角标点
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk + other / 4)
}

/** 归一化相关度并叠加分层权重。 */
function scoredRelevance(hit: SearchResult, maxScore: number): number {
  const base = maxScore > 0 ? Math.min(1, hit.score / maxScore) : 0
  const weight = LAYER_WEIGHT[hit.layer] ?? 0.5
  return Number((base * weight).toFixed(4))
}

/**
 * 组装上下文包。
 *
 * @param kb 知识服务
 * @param options 角色 + 知识绑定 + 任务 + 预算
 */
export async function buildContextPack(
  kb: KnowledgeService,
  options: ContextPackOptions,
): Promise<ContextPack> {
  const budget = options.budgetTokens ?? 4000
  const maxExcerpt = options.maxExcerptChars ?? 600
  const task = options.task.trim()

  const pack: ContextPack = {
    role: options.role,
    task_summary: task,
    items: [],
    knowledge_binding: options.binding,
    total_chars: 0,
    total_tokens: 0,
    truncated: false,
    sources: [],
  }
  if (task === '' || options.binding.layers.length === 0) return pack

  // 检索：先取较多候选（layers 由绑定限定），再按 books 过滤 + 分层权重重排 + 预算截断
  const hits = await kb.search({
    q: task,
    layers: options.binding.layers,
    limit: 60,
    // 任务描述是长句子：用 OR 语义（命中任一词元），否则零命中
    match_mode: 'any',
  })
  const bookFilter = options.binding.books
  const candidates = bookFilter !== undefined && bookFilter.length > 0
    ? hits.filter((h) => bookFilter.includes(h.book))
    : hits
  if (candidates.length === 0) return pack

  const maxScore = Math.max(...candidates.map((h) => h.score), 0)
  const ranked = candidates
    .map((hit) => ({ hit, relevance: scoredRelevance(hit, maxScore) }))
    .sort((a, b) => b.relevance - a.relevance)

  for (const { hit, relevance } of ranked) {
    const excerpt = hit.excerpt.slice(0, maxExcerpt)
    const item: ContextPackItem = {
      id: hit.id,
      version: hit.version,
      title: hit.title,
      layer: hit.layer,
      book: hit.book,
      module: hit.module,
      excerpt,
      relevance,
      source: hit.source,
    }
    // 预算检查：该项会超预算 → 截断收尾（保持包紧凑，不半塞）
    const cost = estimateTokens(`${item.title}\n${excerpt}`)
    if (pack.total_tokens + cost > budget) {
      pack.truncated = true
      break
    }
    pack.items.push(item)
    pack.sources.push(item.source)
    pack.total_tokens += cost
    pack.total_chars += item.title.length + excerpt.length
  }
  return pack
}
