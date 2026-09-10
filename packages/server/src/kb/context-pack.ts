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
 *
 * design-v4 F-B1/F-B2（本文件是 server 内部契约，不入 `@prism/knowledge`）：
 * - `relevance` 乘法链：`base`（本次候选 maxScore 归一）→ `layerWeight` → `freshnessFactor`
 *   → `graphBoost` → **末尾统一 `clamp(0,1)`**；
 * - `freshness` 缺省（或 =1.0）⇒ 因子恰为 `1.0` ⇒ 与改动前**逐字节一致**；
 * - `normalized_by: 'candidate_max'` 明示「跨查询不可比」的归一语义（裁决 #5）；
 * - `symbols` 命中判定基 = `title` + `excerpt`，**大小写敏感**子串，命中项 `relevance *= 1.15`
 *   并在 `items[].graph_hits` 写出命中的符号（**不做**图谱邻近度，队长裁决 A3）。
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
  /** F-B1：显式覆盖角色绑定的层集合（缺省取 `binding.layers`）；空数组 = 明确的空集（返回空包）。 */
  layers?: Layer[]
  /** F-B1：显式覆盖角色绑定的书过滤（缺省取 `binding.books`）；空数组 = 不过滤（与缺省同）。 */
  books?: string[]
  /** F-B2：代码符号 / 文件路径（命中 `title`+`excerpt` → `relevance *= 1.15`）。 */
  symbols?: string[]
}

export interface ContextPackItem {
  id: string
  version: number
  title: string
  layer: Layer
  book: string
  module: string
  excerpt: string
  /** 归一化相关度（0-1，乘法链见文件头；末尾已 clamp） */
  relevance: number
  /** 来源地址（层[/owner]/书/模块/ID@版次） */
  source: string
  /** F-B2：命中的 `symbols`（去重、保持入参顺序；无命中 → 空数组） */
  graph_hits: string[]
}

export interface ContextPack {
  role: string
  task_summary: string
  items: ContextPackItem[]
  /** 知识绑定（原样回传，便于宿主核对；`layers`/`books` 显式覆盖时仍回传原绑定） */
  knowledge_binding: KnowledgeBinding
  total_chars: number
  /** token 估算（供宿主核对预算） */
  total_tokens: number
  truncated: boolean
  sources: string[]
  /** F-B1/裁决 #5：`relevance` 以**本次候选** maxScore 归一 → 跨查询不可比（显式声明） */
  normalized_by: 'candidate_max'
}

/** 分层权重：同相关度下 role 层知识优先（§4.5）。 */
const LAYER_WEIGHT: Record<string, number> = { role: 1.0, project: 0.85, global: 0.72 }

/** F-B1 新鲜度因子：`0.9 + 0.1 * clamp(freshness, 0, 1)`。 */
const FRESHNESS_FLOOR = 0.9
const FRESHNESS_SPAN = 0.1

/** F-B2 符号命中加权（乘法因子，末尾统一 clamp）。 */
const SYMBOL_BOOST = 1.15

/** 夹取到 [0, 1]（NaN 归 0，避免污染排序）。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

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

/**
 * F-B2 命中判定：基 = `title` + `excerpt`（上下文包只有 excerpt，无完整正文）。
 * **大小写敏感**子串包含；`symbols` 去重（保持入参顺序），空串忽略。
 */
function symbolHits(hit: SearchResult, symbols: readonly string[]): string[] {
  if (symbols.length === 0) return []
  const haystack = `${hit.title}\n${hit.excerpt}`
  return symbols.filter((symbol) => symbol !== '' && haystack.includes(symbol))
}

/**
 * F-B1/F-B2 归一化相关度乘法链（顺序即设计口径）：
 * `base = min(1, score/maxScore)` → `× layerWeight` → `× freshnessFactor` → `× graphBoost`
 * → **末尾 `clamp(0,1)`** → 保留 4 位小数（既有精度口径）。
 *
 * `freshness` 缺省视为 1.0：因子 = `0.9 + 0.1 * 1 = 1.0`，乘积与改动前逐字节一致。
 */
function scoredRelevance(hit: SearchResult, maxScore: number, graphHitCount: number): number {
  const base = maxScore > 0 ? Math.min(1, hit.score / maxScore) : 0
  const weight = LAYER_WEIGHT[hit.layer] ?? 0.5
  const freshnessFactor = FRESHNESS_FLOOR + FRESHNESS_SPAN * clamp01(hit.freshness ?? 1.0)
  const graphBoost = graphHitCount > 0 ? SYMBOL_BOOST : 1
  return Number(clamp01(base * weight * freshnessFactor * graphBoost).toFixed(4))
}

/**
 * 组装上下文包。
 *
 * @param kb 知识服务
 * @param options 角色 + 知识绑定 + 任务 + 预算（+ F-B1/F-B2 可选覆盖）
 */
export async function buildContextPack(
  kb: KnowledgeService,
  options: ContextPackOptions,
): Promise<ContextPack> {
  const budget = options.budgetTokens ?? 4000
  const maxExcerpt = options.maxExcerptChars ?? 600
  const task = options.task.trim()
  // F-B1：显式覆盖优先，缺省仍取角色绑定（既有行为不变）
  const layers = options.layers ?? options.binding.layers
  const books = options.books ?? options.binding.books

  const pack: ContextPack = {
    role: options.role,
    task_summary: task,
    items: [],
    knowledge_binding: options.binding,
    total_chars: 0,
    total_tokens: 0,
    truncated: false,
    sources: [],
    normalized_by: 'candidate_max',
  }
  if (task === '' || layers.length === 0) return pack

  // 检索：先取较多候选（layers 由绑定/覆盖限定），再按 books 过滤 + 乘法链重排 + 预算截断
  const hits = await kb.search({
    q: task,
    layers,
    limit: 60,
    // 任务描述是长句子：用 OR 语义（命中任一词元），否则零命中
    match_mode: 'any',
  })
  const candidates = books !== undefined && books.length > 0
    ? hits.filter((h) => books.includes(h.book))
    : hits
  if (candidates.length === 0) return pack

  const maxScore = Math.max(...candidates.map((h) => h.score), 0)
  const symbols = options.symbols === undefined ? [] : [...new Set(options.symbols)]
  const ranked = candidates
    .map((hit) => {
      const graphHits = symbolHits(hit, symbols)
      return { hit, graphHits, relevance: scoredRelevance(hit, maxScore, graphHits.length) }
    })
    .sort((a, b) => b.relevance - a.relevance)

  for (const { hit, graphHits, relevance } of ranked) {
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
      graph_hits: graphHits,
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
