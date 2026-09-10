/**
 * Embedding 模型档位注册表（变更：按算力分档）。
 *
 * 背景：BGE-M3 是 568M 参数（XLM-RoBERTa-large），CPU 上极慢（1500 字 ≈ 7.5s）。
 * 但「语义检索」不该被有没有显卡决定成败——所以按算力分档：
 *
 * | 档位      | 模型                    | 维度 | 体积  | 定位               |
 * | :-------- | :---------------------- | ---: | ----: | :----------------- |
 * | `small`   | bge-small-zh-v1.5 Q8_0  |  512 | 25MB  | 无 GPU（CPU 友好） |
 * | `default` | bge-m3 Q8_0             | 1024 | 605MB | 多语言基线         |
 * | `large`   | Qwen3-Embedding-0.6B Q8 | 1024 | 609MB | 有 GPU（更强）     |
 *
 * 实测（本机 RTX 2060S / i-CPU，单条 500 字）：
 * - small：CPU 273ms（bge-m3 CPU 1858ms，约快 7 倍）；判别力 相关0.556/无关0.289
 * - default：GPU 233ms；相关0.601/无关0.376/跨语言0.638
 * - large：GPU 156ms；相关0.605 / 无关0.149 / 跨语言0.848（判别力显著更强）
 *
 * **维度不同（512 vs 1024）也不可直接混用**：即便同为 1024，bge-m3 与 Qwen3 的向量
 * 空间也不共通。故 kb_vectors 每行记 `model`，检索只比同模型向量（见 service.ts）。
 *
 * 安装脚本 (scripts/setup-embedding.mjs) 维护同表用于下载；`embedding-models.test.ts`
 * 读脚本文本做一致性校验，防止两处漂移。
 */

/** 档位名（也是 CLI/env 的取值）。 */
export type EmbeddingTier = 'small' | 'default' | 'large'

export interface EmbeddingModelDef {
  /** 稳定 id（写入 kb_vectors.model；不要随意改，改了旧向量即失效） */
  id: string
  tier: EmbeddingTier
  /** 人类可读名 */
  label: string
  /** GGUF 文件名（放在 <llama>/models/ 下） */
  file: string
  /** 向量维度（写库校验 + 检索过滤） */
  dim: number
  /** 上下文窗口 token 数（llama-server 的 -c/-b/--ubatch-size） */
  ctx: number
  /** 客户端单条输入字符上限（略低于 ctx，留模板余量） */
  maxChars: number
  /** GitHub/HF 下载源（镜像由安装脚本统一加前缀） */
  repo: string
  /** llama-server pooling 参数（causal 模型如 Qwen3 需 `last`） */
  pooling?: 'last' | 'mean' | 'cls'
}

export const EMBEDDING_MODELS: Record<EmbeddingTier, EmbeddingModelDef> = {
  small: {
    id: 'bge-small-zh-v1.5-q8',
    tier: 'small',
    label: 'BGE-small-zh-v1.5（轻量，CPU）',
    file: 'bge-small-zh-v1.5-q8_0.gguf',
    dim: 512,
    ctx: 512,
    maxChars: 400,
    repo: 'CompendiumLabs/bge-small-zh-v1.5-gguf',
  },
  default: {
    id: 'bge-m3-q8',
    tier: 'default',
    label: 'BGE-M3（多语言基线）',
    file: 'bge-m3-Q8_0.gguf',
    dim: 1024,
    ctx: 2048,
    maxChars: 1500,
    repo: 'gpustack/bge-m3-GGUF',
  },
  large: {
    id: 'qwen3-embedding-0.6b-q8',
    tier: 'large',
    label: 'Qwen3-Embedding-0.6B（更强，GPU）',
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
    dim: 1024,
    ctx: 2048,
    maxChars: 1500,
    repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    pooling: 'last',
  },
}

export const EMBEDDING_TIERS: readonly EmbeddingTier[] = ['small', 'default', 'large']

/** 把用户输入解析成档位：接受档位名或模型 id；未知返回 null。 */
export function resolveTier(input: string | undefined): EmbeddingTier | null {
  if (input === undefined || input.trim() === '') return null
  const v = input.trim().toLowerCase()
  if ((EMBEDDING_TIERS as readonly string[]).includes(v)) return v as EmbeddingTier
  for (const tier of EMBEDDING_TIERS) {
    if (EMBEDDING_MODELS[tier].id === v) return tier
  }
  return null
}
