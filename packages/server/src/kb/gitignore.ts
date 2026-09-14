/**
 * `.gitignore` 解析与匹配（精简实现，**零外部依赖**）。
 *
 * 为什么自研：`packages/server` 运行时依赖只有 workspace 内的 `@prism/*`，
 * 不引第三方 npm 包——分发体积与供应链面都要小。这里覆盖 gitignore 的**常用语义**：
 *
 * - 空行与 `#` 注释（`\#` 转义）；行尾未转义空格剥除；
 * - `!` 取反（`\!` 转义）；
 * - 尾部 `/` = 只匹配目录；
 * - 模式含 `/`（非尾部）→ 锚定到 .gitignore 所在目录；否则匹配**任意层级**；
 * - `*`（不跨 `/`）、`?`（单字符，不跨 `/`）、`[...]` 字符类、`**`（跨 `/`）。
 *
 * **有意不覆盖**：多级 `.gitignore` 叠加（子目录内的）、`.git/info/exclude`、
 * `core.excludesFile`、`--no-index`。需要这些的宿主可用 `ScanOptions.ignoreDirs`
 * 或 `respectGitignore: false` 自行处理。
 *
 * 匹配语义按「逐层 walk」设计：调用方从根往下走，父目录一旦被忽略就不再进入，
 * 因此 `ignores(rel, isDir)` 只需判断**单条相对路径**，无需自己展开子树。
 */

/** 一条编译好的忽略规则。 */
export interface GitignoreRule {
  /** `!` 前缀：命中则**取消**忽略 */
  negated: boolean
  /** 以 `/` 结尾：只对目录生效 */
  dirOnly: boolean
  /** 编译后的正则（匹配 POSIX 相对路径） */
  regex: RegExp
  /** 原始行（诊断/调试用） */
  raw: string
}

/** 把 glob 片段编译为正则源码（不含首尾锚点）。 */
function globToRegexSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      const prev = glob[i - 1]
      const isDouble = glob[i + 1] === '*'
      if (isDouble && (prev === undefined || prev === '/') && glob[i + 2] === '/') {
        // 前导 `**/` → 任意层（含 0 层）
        out += '(?:.*/)?'
        i += 2
        continue
      }
      if (isDouble && prev === '/' && glob[i + 2] === undefined) {
        // 尾部 `/**` → 目录内一切
        out += '.*'
        i += 1
        continue
      }
      if (isDouble) {
        // 其它位置的 `**` 一律当「跨层任意」
        out += '.*'
        i += 1
        continue
      }
      out += '[^/]*'
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    if (ch === '[') {
      // 字符类：`[!...]` / `[^...]` 为取反
      let j = i + 1
      let negate = false
      if (glob[j] === '!' || glob[j] === '^') {
        negate = true
        j++
      }
      let body = ''
      for (; j < glob.length && glob[j] !== ']'; j++) {
        const c = glob[j]!
        body += c === '\\' ? '\\\\' : c
      }
      if (j >= glob.length) {
        // 未闭合 → 当普通字符
        out += '\\['
        continue
      }
      out += `[${negate ? '^' : ''}${body}]`
      i = j
      continue
    }
    if ('\\^$.|+(){}'.includes(ch)) {
      out += `\\${ch}`
      continue
    }
    out += ch
  }
  return out
}

/** 解析 `.gitignore` 文本为规则表（顺序保留——后面的规则覆盖前面）。 */
export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    // 行尾未转义空格剥除（git 语义）
    let line = rawLine.replace(/(?<!\\)\s+$/, '')
    if (line === '' || line.startsWith('#')) continue

    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1)
    }
    if (line === '') continue

    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }
    if (line === '') continue

    // **去掉尾部 `/` 之后**再判断是否锚定：`foo/` 是非锚定的目录规则
    const anchored = line.includes('/')
    const body = globToRegexSource(line.replace(/^\/+/, ''))
    // 尾部 `(?:/.*)?` 承载 git 的「父路径被忽略 ⇒ 后代全被忽略」。
    // 逐层 walk 时父目录会先被挡、用不到这一层，但让规则**自洽**——
    // 单独用匹配器判断深层路径（如 `generated/deep/nested`）也应命中。
    const source = anchored ? `^${body}(?:/.*)?$` : `(?:^|.*/)${body}(?:/.*)?$`
    try {
      rules.push({ negated, dirOnly, regex: new RegExp(source), raw: rawLine })
    } catch {
      // 非法正则（含畸形字符类）→ 忽略该行，不猜不崩
    }
  }
  return rules
}

/** 已编译规则表上的匹配器。 */
export class GitignoreMatcher {
  readonly #rules: GitignoreRule[]

  constructor(rules: GitignoreRule[]) {
    this.#rules = rules
  }

  get size(): number {
    return this.#rules.length
  }

  /**
   * `rel` 是否被忽略。`rel` 是 POSIX 相对路径（无前导 `./`、无盘符）。
   * 取反规则按书写顺序覆盖前面的判定（git 语义）。
   */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false
    for (const rule of this.#rules) {
      if (rule.dirOnly && !isDir) continue
      if (rule.regex.test(rel)) ignored = !rule.negated
    }
    return ignored
  }
}

/** 从文本构造匹配器（空文本 → 空规则，`ignores` 恒 false）。 */
export function createGitignoreMatcher(text: string): GitignoreMatcher {
  return new GitignoreMatcher(parseGitignore(text))
}
