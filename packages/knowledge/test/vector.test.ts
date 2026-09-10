import { describe, expect, it } from 'vitest'

import { blobToVector, cosine, rrfFuse, vectorToBlob } from '../src/vector.js'

describe('向量原语（变更 2）', () => {
  it('cosine：同向 = 1，正交 = 0，反向 = -1', () => {
    const a = Float32Array.from([1, 0, 0])
    expect(cosine(a, a)).toBeCloseTo(1, 6)
    expect(cosine(a, Float32Array.from([0, 1, 0]))).toBeCloseTo(0, 6)
    expect(cosine(a, Float32Array.from([-1, 0, 0]))).toBeCloseTo(-1, 6)
  })

  it('cosine：容忍未归一化向量（比值而非点积）', () => {
    expect(cosine(Float32Array.from([3, 0]), Float32Array.from([7, 0]))).toBeCloseTo(1, 6)
  })

  it('cosine：零向量不除零（返回 0）', () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0)
  })

  it('BLOB 往返无损', () => {
    const v = Float32Array.from([0.5, -1.25, 3.75, 0])
    const back = blobToVector(vectorToBlob(v))
    expect(Array.from(back)).toEqual(Array.from(v))
  })

  it('rrfFuse：双路命中的 key 分数高于单路（融合加分）', () => {
    // key 7 在 a、b 两路都排第一；key 9 只在 a 路第二
    const a = [7, 9]
    const b = [7]
    const fused = rrfFuse([a, b], 60)
    expect(fused.get(7)!).toBeGreaterThan(fused.get(9)!)
    // 7: 1/61 + 1/61，9: 1/62
    expect(fused.get(7)!).toBeCloseTo(2 / 61, 10)
    expect(fused.get(9)!).toBeCloseTo(1 / 62, 10)
  })

  it('rrfFuse：空入参 → 空表', () => {
    expect(rrfFuse([[], []]).size).toBe(0)
  })
})
