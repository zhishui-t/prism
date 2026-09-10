/**
 * bigram 分词（design.md §3.4 硬约束）。
 *
 * 规则：CJK 字符二元滑窗；非 CJK 走小写原词；全部用空格连接。
 * - 查询串与正文（标题+正文）使用同一函数，两侧对称才能命中；
 * - 必须用 bigram + unicode61，禁止 trigram（trigram 检索不了两字中文词，
 *   实测见 doc/requirements/knowledge-base.md §5.1）。
 */

/** CJK 统一表意文字（含扩展 A/兼容区，不含标点）。按码点判断。 */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意文字
    (cp >= 0x20000 && cp <= 0x2a6df) // 扩展 B
  )
}

const WORD_CHAR_RE = /[\p{L}\p{N}]/u

/**
 * bigram 分词。
 *
 * - CJK 连续段：二元滑窗（如「异常处理」→「异常 常处 处理」）；
 *   段长为 1 时保留单字（单字无二元可取）；
 * - 非 CJK 段：按空白切词、小写原词；纯符号词丢弃；
 * - 输出以单空格连接；空输入返回 ''。
 */
export function bigram(input: string): string {
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
        for (let k = i; k < j - 1; k++) {
          tokens.push(String.fromCodePoint(cps[k], cps[k + 1]))
        }
      }
      i = j
      continue
    }
    // 非 CJK 段：聚成一段再按空白切词
    let j = i
    while (j < cps.length && !isCjk(cps[j])) j++
    const run = String.fromCodePoint(...cps.slice(i, j))
    for (const word of run.toLowerCase().split(/\s+/)) {
      if (word && WORD_CHAR_RE.test(word)) tokens.push(word)
    }
    i = j
  }
  return tokens.join(' ')
}

/** 把 bigram 输出转成 FTS5 MATCH 表达式：逐词双引号包裹（AND 语义）。 */
export type MatchMode = 'all' | 'any'

/**
 * 生成 FTS5 MATCH 表达式。
 * - `all`（默认）：空格分隔 = 隐式 AND，要求命中全部词元——精确检索用；
 * - `any`：显式 OR，命中任一词元即可——**长任务描述**（上下文包）用，
 *   否则「审计 src/auth.ts 的变更」这类句子会因要求全部词元而零命中。
 */
export function toMatchExpression(query: string, mode: MatchMode = 'all'): string {
  const terms = bigram(query)
    .split(' ')
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  return mode === 'any' ? terms.join(' OR ') : terms.join(' ')
}
