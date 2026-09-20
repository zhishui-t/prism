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

// ── Rerank（v14 §1.1 / SPEC-1.1–1.3、1.6–1.7）───────────────────────────────
//
// **第二 llama-server 实例**（M1 修订）：rerank 是交叉编码器（cross-encoder），
// 与 embedding 模型是两个不同 GGUF；且 `--rerank` 会把实例池化全局改成
// `LLAMA_POOLING_TYPE_RANK`（vendored arg.cpp:3471-3476），同实例下 `/embedding`
// 会吐出一维 rerank 分而非语义向量——两者**必须分进程**（见 embedding.ts）。
//
// 分档判定**复用既有 `accelBackend()`**（有加速后端 → gpu 档，否则 cpu 档），
// 不新写平台判断（AGENTS.md §3.4「唯一真相源」）。
//
// | 档位  | 模型                  | 量化      | 体积   | 候选 | doc 预算 | 超时 | 默认 |
// | :---- | :-------------------- | :-------- | -----: | ---: | -------: | ---: | :--- |
// | gpu   | bge-reranker-v2-m3    | Q4_K_M    | 438MB  |   24 |   512tok |  3s  | 开   |
// | cpu   | bge-reranker-base     | Q4_K_M    | 209MB  |   10 |   256tok | 10s  | **关** |
//
// - 体积为 2026-09-20 实查所得（设计稿估 ≈350-400MB，v2-m3 实测 438MB、base 209MB）；
// - **CPU 档模型由波次 3 真机裁决改为 bge-reranker-base**（design-review S7 的回落分支）：
//   原候选 Qwen3-Reranker-0.6B 判别分无效（相关对 0.0000 / 无关对 ~0.99，方向相反）——
//   它是因果 LM，靠 yes/no token 概率打分，而 llama.cpp `--rerank` 要的是**分类头**
//   （`LLAMA_POOLING_TYPE_RANK`，仅 BERT 系有）；换交叉编码器后 5 组全部相关对更高。
//   结论与分数表见 `.agent-team/v14-backend-report.md` §波次 3；
// - CPU 档默认关（SPEC-1.3）：需 `rerank_enabled: 'on'` 显式开启；
// - `timeoutMs` 随档走（M2）：GPU 3s / CPU 10s——CPU 档实测单请求 108–196ms（远小于 10s），
//   不再是必然超时的死配置。

/** rerank 档位名（也是 `rerank_model` 的取值）。 */
export type RerankTier = 'gpu' | 'cpu'

export interface RerankModelDef {
  /** 稳定 id（`rerank_model` 可用它替代档位名） */
  id: string
  tier: RerankTier
  /** 人类可读名 */
  label: string
  /** GGUF 文件名（放在 <llama>/models/ 下） */
  file: string
  /** GitHub/HF 下载源（镜像由安装脚本统一加前缀） */
  repo: string
  /** llama-server 的 `-c/-b/--ubatch-size`（M1：query+doc+模板 ≥ 1024） */
  ctx: number
  /** 精排候选数上限 top-N（SPEC-1.7：不新增扫描面） */
  candidates: number
  /**
   * 单篇候选文档送入 `/rerank` 的**字符**上限。
   * token 预算（512/256）按「CJK 1 字符 ≈ 1 token」保守折算——宁可少喂，
   * 也不要超 ctx 让服务端报错（客户端不引分词器，R4 预算口径）。
   */
  maxDocChars: number
  /** 单次 `/rerank` 请求超时（M2 档位超时） */
  timeoutMs: number
  /** 该档缺省是否开启（SPEC-1.3：显式 on/off 优先于此） */
  enabledByDefault: boolean
}

export const RERANK_MODELS: Record<RerankTier, RerankModelDef> = {
  gpu: {
    id: 'bge-reranker-v2-m3-q4',
    tier: 'gpu',
    label: 'BGE-reranker-v2-m3（GPU 档）',
    file: 'bge-reranker-v2-m3-Q4_K_M.gguf',
    repo: 'gpustack/bge-reranker-v2-m3-GGUF',
    ctx: 1024,
    candidates: 24,
    maxDocChars: 512,
    timeoutMs: 3_000,
    enabledByDefault: true,
  },
  cpu: {
    // 波次 3 真机裁决（S7）：原候选 `Mungert/Qwen3-Reranker-0.6B-GGUF` 判别分**无效**
    // （5 组相关/无关对：相关恒 0.0000、无关 ~0.99，方向相反）——Qwen3-Reranker 是因果
    // LM，靠 yes/no token 概率打分，而 llama.cpp 的 `--rerank` 要的是**分类头**
    // （`LLAMA_POOLING_TYPE_RANK`，仅 BERT 系有），故 0.6B 在 llama-server 上不可用。
    // 换成同级**交叉编码器** bge-reranker-base（XLM-R + 分类头），实测 5 组全部
    // 相关对 > 无关对（差值 2.50–14.19），CPU 单请求 108–196ms（< timeoutMs 10s）。
    id: 'bge-reranker-base-q4',
    tier: 'cpu',
    label: 'BGE-reranker-base（CPU 档）',
    file: 'bge-reranker-base-q4_k_m.gguf',
    repo: 'sabafallah/bge-reranker-base-Q4_K_M-GGUF',
    ctx: 1024,
    candidates: 10,
    maxDocChars: 256,
    timeoutMs: 10_000,
    enabledByDefault: false,
  },
}

export const RERANK_TIERS: readonly RerankTier[] = ['gpu', 'cpu']

/** 把用户输入解析成 rerank 档位：接受档位名或模型 id；未知返回 null。 */
export function resolveRerankTier(input: string | undefined): RerankTier | null {
  if (input === undefined || input.trim() === '') return null
  const v = input.trim().toLowerCase()
  if ((RERANK_TIERS as readonly string[]).includes(v)) return v as RerankTier
  for (const tier of RERANK_TIERS) {
    if (RERANK_MODELS[tier].id === v) return tier
  }
  return null
}
