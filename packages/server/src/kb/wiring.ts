import {
  createKnowledgeService,
  defaultMaxChars,
  DEFAULT_VECTOR_SCAN_CAP,
  GRAPH_FUSION_DECAY,
} from '@prism/knowledge'
import type { ChunkOptions } from '@prism/knowledge'
import { PrismError, prismPaths } from '@prism/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  activeModel,
  activeRerankTier,
  embedText,
  embeddingInstalled,
  rerankInstalled,
  rerankText,
  setEmbeddingTier,
  setRerankTier,
} from './embedding.js'
import { RERANK_MODELS, resolveRerankTier, type RerankTier } from './embedding-models.js'
import type { KnowledgeService } from './port.js'

/** 读 `<PRISM_HOME>/prism.yaml` 某个键的值（支持 `key: value` 简单行；无则 undefined）。 */
export function prismConfigValue(home: string | undefined, key: string): string | undefined {
  try {
    const file = join(prismPaths(home).home, 'prism.yaml')
    const text = readFileSync(file, 'utf-8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed.includes(':')) continue
      const idx = trimmed.indexOf(':')
      const k = trimmed.slice(0, idx).trim()
      if (k !== key) continue
      const v = trimmed.slice(idx + 1).trim()
      return v === '' ? undefined : v
    }
  } catch {
    // 无配置文件
  }
  return undefined
}

/**
 * 应用 `<PRISM_HOME>/prism.yaml` 的档位配置（`embedding_model` / `rerank_model`）。
 * **组合根与 CLI 都要调**——否则 `prism embedding use <tier>` 写了配置、
 * 但 `status`/`reindex` 等命令不读，会报错误的生效档位。
 */
export function applyEmbeddingConfig(home?: string): void {
  setEmbeddingTier(prismConfigValue(home, 'embedding_model'))
  // v14 §1.1：rerank 档位独立配置面（同一扁平键解析手法，互不影响）
  setRerankTier(prismConfigValue(home, 'rerank_model'))
}

// ── v13 §1.1：段切分与段向量上限的配置贯通（扁平键）────────────────────────────

/**
 * 段合并阈值：本轮**固定 120**（无 `chunk_min_chars` 键），与切分器 `chunkMarkdown`
 * 的默认一致——上界公式与切分器必须用同一个 minChars，故这里显式注入而不依赖
 * 切分器的默认值。
 */
export const CHUNK_MIN_CHARS = 120

/**
 * `vector_scan_cap` 缺省（SPEC-3.7：段向量全扫的段数上限）。
 * **单一真相源在 `@prism/knowledge`**（`vector.ts` 的 `DEFAULT_VECTOR_SCAN_CAP`，
 * 与消费侧同一常量）——此处 re-export 而非重定义，避免两处默认值漂移。
 */
export { DEFAULT_VECTOR_SCAN_CAP }

/** 装配时解析出的 kb 配置（纯函数产物）。 */
export interface KbWiringConfig {
  /** 注入 `createKnowledgeService` 的段切分选项 */
  chunkOptions: ChunkOptions
  /** 注入 `createKnowledgeService` 的段向量扫描上限（缺省 50000） */
  vectorScanCap: number
  /** 违规回落告警（调用方负责输出；无违规则空数组） */
  warnings: string[]
}

export interface KbWiringInput {
  /** prism.yaml `chunk_max_chars` 原始值（undefined = 未配置） */
  chunkMaxChars?: string | undefined
  /** prism.yaml `vector_scan_cap` 原始值（undefined = 未配置） */
  vectorScanCap?: string | undefined
  /** 当前嵌入客户端单条字符上限（`activeModel().maxChars`）；嵌入未装 → undefined */
  clientMaxChars?: number | undefined
  /** 段合并阈值覆写（测试用；缺省 `CHUNK_MIN_CHARS`） */
  minChars?: number
}

/**
 * 解析 `chunk_max_chars`（纯函数，逐分档可测）。
 *
 * - 未配置 / 空串 → 静默取上界（默认分档）
 * - 非法（非数字 / ≤ 0）或超出区间 `(minChars, bound]` → **告警**并回落到 `bound`
 *
 * `bound` 即 R3 的「上界式与下限兜底合一」公式产物：`defaultMaxChars(clientMaxChars, minChars)`
 * = `max(minChars×2, min(2000, clientMaxChars−300))`（嵌入未装 → 2000）。**上界 = 回落值**，
 * 故不存在空区间。
 */
export function resolveChunkMaxChars(
  raw: string | undefined,
  bound: number,
  minChars: number,
  warnings: string[] = [],
): number {
  if (raw === undefined) return bound
  const text = raw.trim()
  if (text === '') return bound
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) {
    warnings.push(`chunk_max_chars 值非法（${text}），已按默认分档回落为 ${bound}`)
    return bound
  }
  if (value <= minChars || value > bound) {
    warnings.push(`chunk_max_chars=${value} 超出允许区间 (${minChars}, ${bound}]，已回落为 ${bound}`)
    return bound
  }
  return value
}

/** 解析正整数键（非数字 / ≤0 / 空串 → undefined，按缺失走缺省）。 */
function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw.trim())
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * 由扁平配置值解析出 kb 装配配置（**纯函数**：不读文件、不碰嵌入进程，便于逐分档测试）。
 *
 * 键（N-2：`prismConfigValue` 只支持扁平键）：
 * - `chunk_max_chars` → `chunkOptions.maxChars`（SPEC-1.13：默认按嵌入客户端分档自适应）
 * - `vector_scan_cap` → `vectorScanCap`（SPEC-3.7，缺省 50000；消费在 B-3）
 */
export function resolveKbWiringConfig(input: KbWiringInput = {}): KbWiringConfig {
  const minChars = input.minChars ?? CHUNK_MIN_CHARS
  const warnings: string[] = []
  // 上界与回落**同一公式**；未装嵌入（clientMaxChars undefined）→ 2000
  const bound = defaultMaxChars(input.clientMaxChars ?? undefined, minChars)
  const maxChars = resolveChunkMaxChars(input.chunkMaxChars, bound, minChars, warnings)
  const vectorScanCap = parseCount(input.vectorScanCap) ?? DEFAULT_VECTOR_SCAN_CAP
  return { chunkOptions: { minChars, maxChars }, vectorScanCap, warnings }
}

/**
 * 组合根与 CLI **共用的单点**：读 `<PRISM_HOME>/prism.yaml` 扁平键 + 当前嵌入客户端，
 * 解析出 kb 装配配置（分档自适应）。
 *
 * 分档自适应看「**实际装了什么**」的模型上限（R2 修订：未装 → undefined → 2000），
 * 而非档位配置——否则「选了档却没下模型」会按未生效的档位算。
 *
 * CLI `kb reindex --chunks` 必须用**同一份** chunkOptions 重切：否则与 service 写入的
 * 段不一致，跳过判据永不收敛（镜像两份解析逻辑必然漂移）。
 */
export function resolveKbConfigForHome(home?: string): KbWiringConfig {
  const installed = embeddingInstalled()
  const model = activeModel()
  return resolveKbWiringConfig({
    chunkMaxChars: prismConfigValue(home, 'chunk_max_chars'),
    vectorScanCap: prismConfigValue(home, 'vector_scan_cap'),
    clientMaxChars: installed ? model.maxChars : undefined,
  })
}

// ── v14 §1.1/§1.2：rerank 扁平键（`rerank_enabled` / `rerank_model`）────────────

/** rerank 装配输入（纯函数；档位与「已装」由调用方注入，便于逐分支测试）。 */
export interface RerankWiringInput {
  /** prism.yaml `rerank_enabled` 原始值（undefined = 未配置 → `auto`） */
  enabled?: string | undefined
  /** prism.yaml `rerank_model` 原始值（档位名或模型 id；undefined = 按算力自动） */
  model?: string | undefined
  /** 自动档位（`activeRerankTier()`：有加速后端 → gpu，否则 cpu） */
  autoTier?: RerankTier
  /** 门控（`rerankInstalled()`：二进制 + rerank 档模型） */
  installed?: boolean
  /** 违规回落告警收集器 */
  warnings?: string[]
}

/** rerank 装配结论（`enabled=false` → 不注入，检索侧不发请求）。 */
export interface RerankWiringConfig {
  enabled: boolean
  tier: RerankTier
  /** 精排候选数 top-N（SPEC-1.7） */
  candidates: number
  /** 单次请求超时（M2 档位超时，进日志/doctor） */
  timeoutMs: number
  /** 文档字符预算（注入侧裁剪，见 `makeRerankFn`） */
  maxDocChars: number
  warnings: string[]
}

/**
 * 解析 `rerank_enabled`（SPEC-1.3）：
 * - 未配置 / 空串 / `auto` → **档位默认**（GPU 开、CPU 关）；
 * - 显式 `on`（亦认 `true`/`1`）/ `off`（亦认 `false`/`0`）→ **优先于档位默认**；
 * - 其它值 → 告警并回落档位默认（不静默吞掉拼错的键）。
 */
export function parseRerankEnabled(raw: string | undefined, fallback: boolean, warnings: string[] = []): boolean {
  if (raw === undefined) return fallback
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'auto') return fallback
  if (v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  warnings.push(`rerank_enabled 值非法（${raw.trim()}），已按档位默认回落为 ${fallback ? 'on' : 'off'}（可用 auto/on/off）`)
  return fallback
}

/**
 * 由扁平配置值解析出 rerank 装配结论（**纯函数**：不读文件、不碰进程，逐分档可测）。
 *
 * `enabled` 是两步与：`(档位默认 ⊕ 显式覆盖) && 已装`——SPEC-1.5「`rerankInstalled()`
 * =false 或 `rerank_enabled` 短路时**不发请求**」在这里落成「干脆不注入」。
 */
export function resolveRerankWiringConfig(input: RerankWiringInput = {}): RerankWiringConfig {
  const warnings = input.warnings ?? []
  const autoTier = input.autoTier ?? 'cpu'
  const wantTier = resolveRerankTier(input.model)
  if (input.model !== undefined && input.model.trim() !== '' && wantTier === null) {
    warnings.push(`rerank_model 值未知（${input.model.trim()}），已回落自动档位 ${autoTier}（可用 gpu/cpu 或模型 id）`)
  }
  const tier = wantTier ?? autoTier
  const def = RERANK_MODELS[tier]
  const want = parseRerankEnabled(input.enabled, def.enabledByDefault, warnings)
  return {
    enabled: want && (input.installed ?? false),
    tier,
    candidates: def.candidates,
    timeoutMs: def.timeoutMs,
    maxDocChars: def.maxDocChars,
    warnings,
  }
}

/** 组合根与 CLI 共用的单点：读 prism.yaml + 当前算力/安装状态 → rerank 装配结论。 */
export function resolveRerankConfigForHome(home?: string): RerankWiringConfig {
  return resolveRerankWiringConfig({
    enabled: prismConfigValue(home, 'rerank_enabled'),
    model: prismConfigValue(home, 'rerank_model'),
    autoTier: activeRerankTier(),
    installed: rerankInstalled(),
  })
}

/**
 * 注入 knowledge 的精排函数（组合根单点）。
 *
 * 档位解析、文档预算裁剪（`maxDocChars`，SPEC-1.2/1.7）、超时（M2）与降级全部在
 * `rerankText` 内按**调用时**的生效档位处理——换档不必重建服务实例。
 */
export function makeRerankFn(): (query: string, docs: string[]) => Promise<number[] | null> {
  return (query, docs) => rerankText(query, docs)
}

// ── v14 §2：图谱融合扁平键（`graph_fusion` / `graph_fusion_decay`）──────────────

/** 图谱融合装配结论（`enabled=false` → knowledge 侧零扩展，SPEC-2.3）。 */
export interface GraphFusionWiringConfig {
  /** 是否做引用扩展（缺省 on） */
  enabled: boolean
  /** 每跳衰减系数（缺省 0.5；∉(0,1] 非法 → 回落并告警） */
  decay: number
  warnings: string[]
}

/**
 * 解析 `graph_fusion`（SPEC-2.3）：未配置 / 空串 / `on`（亦认 `true`/`1`）→ 开；
 * `off`（亦认 `false`/`0`）→ 关；其它值 → 告警并回落 **on**（默认开，不静默吞拼错的键）。
 */
export function parseGraphFusion(raw: string | undefined, warnings: string[] = []): boolean {
  if (raw === undefined) return true
  const v = raw.trim().toLowerCase()
  if (v === '' || v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  warnings.push(`graph_fusion 值非法（${raw.trim()}），已按默认回落为 on（可用 on/off）`)
  return true
}

/**
 * 解析 `graph_fusion_decay`（SPEC-2.1/2.2）：未配置 / 空串 → `GRAPH_FUSION_DECAY`（0.5）；
 * 非法（非有限数 / ≤0 / >1）→ 告警并回落默认（系数 >1 会让扩展分反超种子，
 * 与「扩展候选不顶掉原 top」冲突，故上界锁 1）。
 */
export function parseGraphFusionDecay(raw: string | undefined, warnings: string[] = []): number {
  if (raw === undefined) return GRAPH_FUSION_DECAY
  const text = raw.trim()
  if (text === '') return GRAPH_FUSION_DECAY
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    warnings.push(`graph_fusion_decay=${text} 非法（须 (0, 1]），已回落为 ${GRAPH_FUSION_DECAY}`)
    return GRAPH_FUSION_DECAY
  }
  return value
}

/** 组合根与 CLI 共用的单点：读 prism.yaml 的两个扁平键 → 图谱融合装配结论。 */
export function resolveGraphFusionConfigForHome(home?: string): GraphFusionWiringConfig {
  const warnings: string[] = []
  return {
    enabled: parseGraphFusion(prismConfigValue(home, 'graph_fusion'), warnings),
    decay: parseGraphFusionDecay(prismConfigValue(home, 'graph_fusion_decay'), warnings),
    warnings,
  }
}

/**
 * 组合根：装载真实知识服务（@prism/knowledge）。
 * 每次调用返回独立实例；HTTP server 与 MCP stdio 进程经 SQLite WAL 并存（design.md §3.5）。
 *
 * embedding（分档：小/默认/强，按算力自动选）：落库自动写向量、检索走 BM25+向量混合。
 * 未安装时 `embedText` 返回 ok:false → 此处转 null，knowledge 侧静默跳过、纯 BM25 降级。
 *
 * v13 §1.1：段切分的 `maxChars` 随**当前嵌入客户端**分档自适应（未装 → 2000）；
 * 用户显式 `chunk_max_chars` 越界/非法 → 告警并回落到同一公式值。
 *
 * 注：工作队列已移除。富化（摘要/分类/实体抽取/图表 IR）由宿主经 MCP `prism_kb_enrich`
 * 直接回写（见 enrich-writeback.ts），不再经队列投递。
 */
export async function loadKnowledgeService(home?: string): Promise<KnowledgeService> {
  try {
    // 应用 prism.yaml 的 embedding_model（env PRISM_EMBEDDING_MODEL 优先级更高，在
    // embedding.ts 的 activeTier 里处理）；rerank_model 同法
    applyEmbeddingConfig(home)
    const embed: (text: string) => Promise<Float32Array | null> = async (text) => {
      const r = await embedText(text)
      return r.ok && r.vector !== undefined ? r.vector : null
    }
    const config = resolveKbConfigForHome(home)
    const model = activeModel()
    for (const warning of config.warnings) console.warn(`[prism] ${warning}`)
    // v14 §1.2：rerank 只在「档位默认/显式覆盖 同意开 且 已装」时注入——不注入即不发请求
    // （SPEC-1.5）。候选数恒传入（档定 24/10，SPEC-1.7）。
    const rerank = resolveRerankConfigForHome(home)
    for (const warning of rerank.warnings) console.warn(`[prism] ${warning}`)
    // v14 §2：图谱融合（引用扩展）开关与系数——默认 on / 0.5，off 时 knowledge 侧零扩展
    const fusion = resolveGraphFusionConfigForHome(home)
    for (const warning of fusion.warnings) console.warn(`[prism] ${warning}`)
    return createKnowledgeService({
      home,
      embed,
      embeddingModel: model.id,
      chunkOptions: config.chunkOptions,
      vectorScanCap: config.vectorScanCap,
      rerankCandidates: rerank.candidates,
      ...(rerank.enabled ? { rerank: makeRerankFn() } : {}),
      graphFusion: fusion.enabled,
      graphFusionDecay: fusion.decay,
    })
  } catch (error) {
    throw new PrismError(
      'internal',
      `装载 @prism/knowledge 失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
