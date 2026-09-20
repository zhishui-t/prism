import { describe, expect, it } from 'vitest'

import { bigram, toMatchExpression } from '../src/tokenize.js'

describe('bigram（design §3.4 硬约束：CJK 二元滑窗 + 非 CJK 小写原词）', () => {
  it('两字中文词保持原词', () => {
    expect(bigram('性能')).toBe('性能')
    expect(bigram('日志')).toBe('日志')
    expect(bigram('接口')).toBe('接口')
  })

  it('四字中文词滑窗出三个 bigram', () => {
    expect(bigram('异常处理')).toBe('异常 常处 处理')
    expect(bigram('敏感信息')).toBe('敏感 感信 信息')
    expect(bigram('性能优化指南')).toBe('性能 能优 优化 化指 指南')
  })

  it('非 CJK 小写原词，空格连接', () => {
    expect(bigram('Hello World')).toBe('hello world')
    expect(bigram('DATABASE')).toBe('database')
  })

  it('中英混排', () => {
    expect(bigram('Java性能优化指南')).toBe('java 性能 能优 优化 化指 指南')
    expect(bigram('Java 异常处理')).toBe('java 异常 常处 处理')
  })

  it('CJK 标点切断滑窗且被丢弃', () => {
    // 。(U+3002) 不属 CJK 表意区 → 分隔符
    expect(bigram('性能。优化')).toBe('性能 优化')
    expect(bigram('性能，优化')).toBe('性能 优化')
  })

  it('单字 CJK 保留自身（无二元可取）', () => {
    expect(bigram('性')).toBe('性')
  })

  it('空输入与纯符号输入返回空串', () => {
    expect(bigram('')).toBe('')
    expect(bigram('   ')).toBe('')
    expect(bigram('!!!')).toBe('')
  })

  it('正文与查询两侧对称：同一函数同一结果', () => {
    const text = '统一异常处理器捕获业务异常'
    const query = '异常处理'
    // 查询的每个 bigram 必须都在正文的 bigram 集合中（AND 命中的前提）
    const textTokens = new Set(bigram(text).split(' '))
    for (const token of bigram(query).split(' ')) {
      expect(textTokens.has(token)).toBe(true)
    }
  })
})

// ── D-v15-2：长连段不再撞「实参栈上限」 ───────────────────────────────────────
//
// 缺陷：`String.fromCodePoint(...cps.slice(i, j))` 把**整个连段**展开成实参，
// 每个元素占一个栈槽；单一连段超过约 1.2e5 码点即 `RangeError: Maximum call
// stack size exceeded`。实测：单一 CJK 连段 130,000 起必炸（120,000 尚可），
// 黑盒侧 268,868 字符 deposit 稳定复现。后果是 >256KB 条目的降级路径永远到不了。

/** CJK 判定（与 `src/tokenize.ts` 同式；仅用于把修前实现原样冻结成基准）。 */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2a6df)
  )
}

const SAFE_WORD_RE = /[\p{L}\p{N}]/u

/**
 * **修前实现逐字节冻结**（`String.fromCodePoint(...cps.slice(i, j))`）。
 * 只在「展开实参不会炸」的尺寸（≤ 5 万码点）上用作基准，验证改动零行为差异。
 */
function legacyBigram(input: string): string {
  if (!input) return ''
  const cps = Array.from(input).map((c) => {
    const point = c.codePointAt(0)
    return point === undefined ? 0 : point
  })
  const tokens: string[] = []
  let i = 0
  while (i < cps.length) {
    if (isCjk(cps[i])) {
      let j = i
      while (j < cps.length && isCjk(cps[j])) j++
      const run = String.fromCodePoint(...cps.slice(i, j))
      if (run.length === 1) {
        tokens.push(run)
      } else {
        for (let k = i; k < j - 1; k++) tokens.push(String.fromCodePoint(cps[k], cps[k + 1]))
      }
      i = j
      continue
    }
    let j = i
    while (j < cps.length && !isCjk(cps[j])) j++
    const run = String.fromCodePoint(...cps.slice(i, j))
    for (const word of run.toLowerCase().split(/\s+/)) {
      if (word && SAFE_WORD_RE.test(word)) tokens.push(word)
    }
    i = j
  }
  return tokens.join(' ')
}

/** 正常尺寸语料：边界码点/代理对/标点/混排/多行全在内。 */
const NORMAL_CORPUS: string[] = [
  '',
  '性能',
  '异常处理',
  'Java性能优化指南',
  '性能。优化',
  '性',
  '   ',
  '!!!',
  'Hello World',
  'DATABASE',
  'Java 异常处理',
  '第一行\n第二行\tTabbed',
  '\u{20000}\u{20001}', // 扩展 B：单码点连段 + 代理对
  '\u{20000}\u{20001}\u{20002}甲',
  '\uD800', // 孤立代理项（非 CJK → 丢弃）
  'a\uD800b',
  '\u4e00\u3400\uF900\u2A6DF\u9FFF\u3002',
  '😀 甲😀乙 😀',
  `${'甲'.repeat(300)}${'word '.repeat(50)}${'乙'.repeat(300)}`,
]

describe('D-v15-2 大输入（原实参展开会栈溢出）', () => {
  it('正常尺寸输出与修前实现逐字节一致（含 5 万码点的长连段）', () => {
    for (const text of NORMAL_CORPUS) {
      expect(bigram(text), `corpus: ${JSON.stringify(text.slice(0, 40))}`).toBe(legacyBigram(text))
    }
    for (const medium of ['甲'.repeat(50_000), 'A'.repeat(50_000), 'ab '.repeat(20_000)]) {
      expect(bigram(medium)).toBe(legacyBigram(medium))
    }
  })

  it('单一 CJK 连段 268,868 码点：不抛 RangeError，词元数与滑窗一致', () => {
    const n = 268_868
    const out = bigram('甲'.repeat(n))
    const tokens = out.split(' ')
    expect(tokens).toHaveLength(n - 1)
    expect(tokens[0]).toBe('甲甲')
    expect(tokens[n - 2]).toBe('甲甲')
    expect(out).toBe(new Array<string>(n - 1).fill('甲甲').join(' '))
  })

  it('单一非 CJK 连段 268,868 码点（无空白）：不抛 RangeError，小写原词', () => {
    const n = 268_868
    expect(bigram('A'.repeat(n))).toBe('a'.repeat(n))
  })

  it('连段跨过实测临界（130,000）与黑盒复现长度（268,868）均成立', () => {
    for (const n of [130_000, 150_000, 268_868]) {
      expect(bigram('甲'.repeat(n)).split(' ')).toHaveLength(n - 1)
    }
  })
})

describe('toMatchExpression（FTS5 MATCH 表达式）', () => {
  it('逐词双引号包裹（AND 语义）', () => {
    expect(toMatchExpression('性能')).toBe('"性能"')
    expect(toMatchExpression('异常处理')).toBe('"异常" "常处" "处理"')
    expect(toMatchExpression('Java 性能')).toBe('"java" "性能"')
  })

  it('双引号在词内时翻倍转义', () => {
    expect(toMatchExpression('a"b')).toBe('"a""b"')
  })

  it('无效词元返回空串', () => {
    expect(toMatchExpression('!!!')).toBe('')
  })
})

/** 回归：长任务描述需 OR 语义（AND 会零命中）。 */
describe('toMatchExpression 匹配模式', () => {
  it('默认 all：空格分隔（隐式 AND）', () => {
    const expr = toMatchExpression('凭证 令牌')
    expect(expr).not.toContain(' OR ')
  })

  it('any：显式 OR（长任务描述用）', () => {
    const expr = toMatchExpression('凭证 令牌', 'any')
    expect(expr).toContain(' OR ')
  })

  it('两种模式都做引号转义', () => {
    expect(toMatchExpression('a"b', 'any')).toContain('""')
  })
})
