/**
 * `.gitignore` 解析与匹配（`packages/server/src/kb/gitignore.ts`）。
 *
 * 这些是**纯函数**测试：只验语义，不碰文件系统（集成行为在 `scan.test.ts`）。
 */
import { describe, expect, it } from 'vitest'

import { createGitignoreMatcher, parseGitignore } from '../src/kb/gitignore.js'

/** 用一段 gitignore 文本构造匹配器并断言若干路径。 */
function check(
  text: string,
  cases: Array<[rel: string, isDir: boolean, expected: boolean]>,
): void {
  const matcher = createGitignoreMatcher(text)
  for (const [rel, isDir, expected] of cases) {
    expect(matcher.ignores(rel, isDir), `${rel}${isDir ? '/' : ''} ← ${JSON.stringify(text)}`).toBe(expected)
  }
}

describe('.gitignore 解析', () => {
  it('空文本 → 零规则，一切都不忽略', () => {
    expect(parseGitignore('').length).toBe(0)
    check('', [['anything.md', false, false], ['a/b', true, false]])
  })

  it('注释与空行被跳过；`\\#` 与 `\\!` 转义后当普通模式', () => {
    const rules = parseGitignore('# 注释\n\n   \n\\#not-a-comment\n\\!literal')
    expect(rules.map((r) => r.raw)).toEqual(['\\#not-a-comment', '\\!literal'])
    expect(rules[0]?.negated).toBe(false)
    expect(rules[1]?.negated).toBe(false)
  })
})

describe('.gitignore 匹配语义', () => {
  it('不含 `/` 的模式匹配任意层级（文件或目录）', () => {
    check('node_modules', [
      ['node_modules', true, true],
      ['a/node_modules', true, true],
      ['a/b/node_modules', true, true],
      ['node_modules_x', true, false],
      ['docs/node_modules.md', false, false],
    ])
  })

  it('尾部 `/` 只匹配目录，不匹配同名文件', () => {
    check('build/', [
      ['build', true, true],
      ['build', false, false],
      ['x/build', true, true],
    ])
  })

  it('含 `/` 的模式锚定到根（不再匹配任意层级）', () => {
    check('docs/secret.md', [
      ['docs/secret.md', false, true],
      ['a/docs/secret.md', false, false],
      ['docs/other.md', false, false],
    ])
  })

  it('`/` 开头的模式锚定到根', () => {
    check('/root-only.md', [
      ['root-only.md', false, true],
      ['sub/root-only.md', false, false],
    ])
  })

  it('`*` 不跨 `/`，`**` 跨层', () => {
    check('*.log', [
      ['a.log', false, true],
      ['deep/dir/b.log', false, true],
      ['a.txt', false, false],
    ])
    check('docs/*.md', [
      ['docs/a.md', false, true],
      ['docs/sub/a.md', false, false], // `*` 不跨 `/`
    ])
    check('docs/**/*.md', [
      ['docs/a.md', false, true], // `**/` 匹配 0 层
      ['docs/sub/deep/a.md', false, true],
      ['other/a.md', false, false],
    ])
  })

  it('取反 `!` 按书写顺序覆盖前面的判定', () => {
    check('*.log\n!keep.log', [
      ['a.log', false, true],
      ['keep.log', false, false],
      ['deep/keep.log', false, false],
    ])
  })

  it('字符类 `[...]` 与取反类 `[!...]`', () => {
    check('file[0-9].txt', [
      ['file1.txt', false, true],
      ['fileX.txt', false, false],
    ])
    check('file[!0-9].txt', [
      ['file1.txt', false, false],
      ['fileX.txt', false, true],
    ])
  })

  it('match() 三态：命中忽略 / 命中取反 / 本层没意见（多级叠加的前提）', () => {
    const matcher = createGitignoreMatcher('generated/\n!keep.md\n')
    expect(matcher.match('generated', true)).toBe(true) // 命中忽略
    expect(matcher.match('a/keep.md', false)).toBe(false) // 命中取反 → 显式捞回
    expect(matcher.match('unrelated.md', false)).toBeUndefined() // 本层无规则命中
    // 压成布尔的旧口径会把「本层没意见」误判成「不忽略」
    expect(matcher.ignores('unrelated.md', false)).toBe(false)
  })

  it('目录被忽略时，其后代在「逐层 walk」中不会到达（父目录已挡）', () => {
    // 这里只验匹配器本身：后代路径仍会命中非锚定模式
    check('generated/', [['generated', true, true], ['generated/deep/nested', true, true]])
  })

  it('行尾空格被剥除（除非反斜杠转义）', () => {
    check('trailing   ', [['trailing', true, true]])
    expect(parseGitignore('escaped\\ ')[0]?.raw).toBe('escaped\\ ')
  })

  it('未闭合的字符类当普通字符处理，不抛错', () => {
    const rules = parseGitignore('bad[pattern')
    expect(rules.length).toBe(1)
  })
})
