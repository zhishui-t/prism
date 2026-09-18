/**
 * 向量原语（变更 2，2026-09-10 用户裁决：Prism 自理 embedding）。
 *
 * knowledge 包只负责**存向量、算相似度、融合排序**，不依赖任何 embedding 实现——
 * 文本 → 向量的能力由 server 装配时以 `options.embed` 注入（BGE-M3 via llama.cpp）。
 * 未注入时全部走纯 BM25，行为与既有逐字节一致。
 *
 * 存储：SQLite BLOB（Float32 小端裸字节），条目量数千级用全表扫算余弦足够；
 * 更大规模再换 sqlite-vec（接口不变）。
 */

/** 倒数排名融合（RRF）常数，业界常用 60。 */
export const RRF_K = 60

/** 向量候选余弦下限：低于此值视为不相关，不参与融合（防噪声经 RRF 混入结果）。 */
export const VECTOR_FLOOR = 0.42

/** 向量候选相对阈值：低于 `top * 此系数` 的丢弃（保证只保留与最佳命中同量级的候选）。 */
export const VECTOR_RELATIVE = 0.92

/** 混合检索时每路取回的候选数上限（最终再截断到 limit）。 */
export const HYBRID_CANDIDATES = 50

/**
 * 段向量全扫的段数上限（v13 §4/SPEC-3.7，扁平键 `vector_scan_cap` 的**唯一真相源**）。
 *
 * 为什么按「段数」而非字节：每段向量 ≈ 维度 × 4B（1024 维 ≈ 4KB），段数即成本的
 * 决定变量。design-review-v13 §M-3 以「5 万 chunk ≈ 每查询 200MB BLOB 全扫」标定本默认值。
 * 超过 → 段向量路**整体缺席**并置 `chunk_scan_degraded`（冻结：不做按 book 收窄）。
 *
 * `packages/server/src/kb/wiring.ts` 直接 re-export 本常量（消除双真相源）。
 */
export const DEFAULT_VECTOR_SCAN_CAP = 50_000

/** 每条目回传的段级命中上限（v13 §M-6：K=4，按段分截断，截断时置 `hits_truncated`）。 */
export const CHUNK_HITS_PER_ENTRY = 4

/** 余弦相似度（显式归一，容忍未单位化的向量）。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** Float32Array → BLOB 字节（Node Buffer，SQLite 直接存）。 */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
}

/** BLOB 字节 → Float32Array（拷贝一份，避免共享底层 buffer）。 */
export function blobToVector(blob: Uint8Array | Buffer): Float32Array {
  const copy = new Float32Array(blob.byteLength >> 2)
  new Uint8Array(copy.buffer).set(blob.subarray(0, copy.byteLength))
  return copy
}

/**
 * 倒数排名融合：`score(key) = Σ w_route / (k + rank)`，rank 从 1 起。
 * 入参为若干「已按相关性降序排列的 key 列表」；同一 key 在多路命中则分数累加。
 * 返回 key → 融合分（越大越相关）。
 *
 * `k` 与 `weights`（分路权重，按 lists 下标对应，F-B3）**均可选**：
 * 不传时 `k = RRF_K`、每路权重 1 —— 与既有 2 参调用**逐字节等价**。
 */
export function rrfFuse(
  lists: ReadonlyArray<ReadonlyArray<number>>,
  k: number = RRF_K,
  weights?: ReadonlyArray<number>,
): Map<number, number> {
  const fused = new Map<number, number>()
  for (let route = 0; route < lists.length; route++) {
    const list = lists[route]!
    const weight = weights?.[route] ?? 1
    if (weight === 0) continue
    for (let i = 0; i < list.length; i++) {
      const key = list[i]!
      fused.set(key, (fused.get(key) ?? 0) + weight / (k + i + 1))
    }
  }
  return fused
}
