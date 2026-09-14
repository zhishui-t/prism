/**
 * archify IR 生成器共用的**文本度量**与 **id 规整**。
 *
 * 为什么需要收在一处：archify 的 `workflow` / `architecture` / `sequence` /
 * `lifecycle` / `dataflow` 五个渲染器都把节点文本画成**不换行的单行 `<text>`**，
 * 并在「缩到 6px 仍放不下」时判节点非法（见各 `*-compiler.mjs`）。因此每个生成器
 * 都得做同一件事：**按显示宽度截断**——而不是按 `String.length`。
 *
 * 口径与 archify `shared/utils.mjs:textUnits` 对齐（保守近似，只多不少）：
 * 全角 / CJK / 星平面计 2 单位，其余计 1 单位。
 *
 * 本文件是**纯函数**：零 IO、零时钟、零随机（红线 R7：IR 是派生视图，
 * 同输入必须同字节，否则 sidecar 的 `ir_hash` 失去意义）。
 */

/** archify `common.schema.json#/$defs/id` 的正则：`^[a-zA-Z][a-zA-Z0-9_-]*$`。 */
export const ARCHIFY_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

/**
 * 宽字符判定（CJK / 全角 / 星平面）。
 *
 * 与 archify `shared/utils.mjs:textUnits` 的 `FULLWIDTH_RE` **同口径的保守近似**：
 * 列出的区段与原正则一致；不在列表内的一律按窄字符（1）计。
 * 采用「只多不少」的星平面规则（>0xFFFF → 2），使未知码点只会得到更宽的估算，
 * 不会把超限文本误判为可放。
 */
export function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint > 0xffff ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
}

/** 文本占位宽度（单位数）。 */
export function textUnits(text: string): number {
  let units = 0
  for (const ch of text) units += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
  return units
}

/** 超限则按单位截断并以 `…` 结尾（省略号占 1 单位）；不超限原样返回。 */
export function fitUnits(text: string, maxUnits: number): string {
  if (textUnits(text) <= maxUnits) return text
  const out: string[] = []
  let units = 0
  for (const ch of text) {
    const cost = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (units + cost > maxUnits - 1) break // 留 1 单位给省略号
    out.push(ch)
    units += cost
  }
  return `${out.join('').trimEnd()}…`
}

/**
 * 超限则**中间截断**：保留头尾、把 `…` 放中间（省略号占 1 单位）。
 *
 * 为什么需要它：文件路径 / 符号名这类文本，**尾部往往才是区分度所在**
 * （`test_post_suggestion_handler` 与 `test_post_suggestion_router` 的区别在尾巴）。`fitUnits`
 * 的头截断会把它们截成同一个 `test_post_suggestion…`，中间截断则给出
 * `test_post_…handler` / `test_post_…router`，仍可分辨。
 *
 * @param headRatio 头部预算占比（其余留给尾部）；0.5 表示头尾各半
 */
export function fitMiddle(text: string, maxUnits: number, headRatio = 0.5): string {
  if (textUnits(text) <= maxUnits) return text
  const budget = maxUnits - 1 // 留 1 单位给省略号
  if (budget <= 0) return '…'
  const headBudget = Math.max(1, Math.ceil(budget * headRatio))
  const tailBudget = Math.max(1, budget - headBudget)
  const head: string[] = []
  let units = 0
  for (const ch of text) {
    const cost = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (units + cost > headBudget) break
    head.push(ch)
    units += cost
  }
  const tail: string[] = []
  units = 0
  for (const ch of [...text].reverse()) {
    const cost = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (units + cost > tailBudget) break
    tail.push(ch)
    units += cost
  }
  tail.reverse()
  return `${head.join('')}…${tail.join('')}`
}

/** 生成的 id 不合 archify schema 时立即抛出（内部错误，不该流到产物里）。 */
export function assertArchifyId(id: string): void {
  if (!ARCHIFY_ID_RE.test(id)) {
    throw new Error(`内部错误：生成的 id 不合 archify schema：${id}`)
  }
}

/**
 * 原始串 → 合法 id 片段（大小写保留）。
 *
 * 只做字符规整，**不做音译**：纯中文 / 纯数字会得到空串或不合规片段，
 * 由调用方预先拼上 ascii 前缀（如 `mod-`）或走 `allocateId` 的兜底。
 */
export function slugToken(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 生成**合法且唯一**的 id，并把结果登记进 `used`。
 *
 * 规则：`raw` 经 `slugToken` 规整；若为空、撞车、或不以字母开头，
 * 则回落到 `${fallbackPrefix}-${n}`（n 取最小可用序号，保证可复现）。
 * 调用方若要固定前缀（如社区键 `0` → `mod-0`），直接把前缀拼进 `raw`。
 */
export function allocateId(raw: string, used: Set<string>, fallbackPrefix: string): string {
  let id = slugToken(raw)
  const usable = (): boolean => id !== '' && !used.has(id) && ARCHIFY_ID_RE.test(id)
  if (!usable()) {
    let n = used.size + 1
    while (used.has(`${fallbackPrefix}-${n}`)) n++
    id = `${fallbackPrefix}-${n}`
  }
  assertArchifyId(id)
  used.add(id)
  return id
}

/**
 * 稳定排序：先按 `key` 降序（数值大者在前），同 `key` 再按 `tie` 升序。
 *
 * 生成器里所有「取 top-N」都必须用这种**全序**比较——只按单一字段排序时，
 * 并列项的顺序会随 `Array.prototype.sort` 的实现/输入顺序漂移，
 * 破坏「同输入同字节」。
 */
export function stableTop<T>(items: readonly T[], key: (item: T) => number, tie: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const d = key(b.item) - key(a.item)
      if (d !== 0) return d
      const c = tie(a.item).localeCompare(tie(b.item))
      return c !== 0 ? c : a.index - b.index
    })
    .map((entry) => entry.item)
}
