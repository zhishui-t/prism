import { createKnowledgeService, defaultMaxChars, DEFAULT_VECTOR_SCAN_CAP } from '@prism/knowledge'
import type { ChunkOptions } from '@prism/knowledge'
import { PrismError, prismPaths } from '@prism/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { activeModel, embedText, embeddingInstalled, setEmbeddingTier } from './embedding.js'
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
 * 应用 `<PRISM_HOME>/prism.yaml` 的 embedding 档位配置（`embedding_model`）。
 * **组合根与 CLI 都要调**——否则 `prism embedding use <tier>` 写了配置、
 * 但 `status`/`reindex` 等命令不读，会报错误的生效档位。
 */
export function applyEmbeddingConfig(home?: string): void {
  setEmbeddingTier(prismConfigValue(home, 'embedding_model'))
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
    // embedding.ts 的 activeTier 里处理）
    applyEmbeddingConfig(home)
    const embed: (text: string) => Promise<Float32Array | null> = async (text) => {
      const r = await embedText(text)
      return r.ok && r.vector !== undefined ? r.vector : null
    }
    const config = resolveKbConfigForHome(home)
    const model = activeModel()
    for (const warning of config.warnings) console.warn(`[prism] ${warning}`)
    return createKnowledgeService({
      home,
      embed,
      embeddingModel: model.id,
      chunkOptions: config.chunkOptions,
      vectorScanCap: config.vectorScanCap,
    })
  } catch (error) {
    throw new PrismError(
      'internal',
      `装载 @prism/knowledge 失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
