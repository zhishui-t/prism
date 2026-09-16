/**
 * F7（技能分类分组 + 详情居中）的**样式契约**：文本级存在性 + 值锁。
 *
 * 与 `skills-groups-dom.test.ts`（happy-dom，管 DOM 结构）成对：这边管「规则写下来了没有、值对不对」。
 * 分开的理由是技术性的——happy-dom 环境里 `import.meta.url` 是 http URL，`fileURLToPath` 会抛，
 * 读不了 `styles.css`；且 happy-dom 不解析外部样式表，`getComputedStyle` 探针只会得到恒绿的空断言
 * （同 `styles-markdown-typography.test.ts` 头注）。
 *
 * 本文件锁四件事：
 *  1. **组头**——`.skill-group-head` 是 flex 的可点行（cursor 与 hover 底是它「能点」的信号），
 *     左 3px 透明边与 `.md-row` 同宽（组名与行名左对齐）；
 *  2. **chev 复用既有类**——`.toc-chev` 仍是**一条规则**覆盖两个挂载点（`.book-toc` / `.skill-group`），
 *     取值不复制（两个挂载点漂一处就红），展开态仍 `rotate(90deg)` + `--t-mid`；
 *  3. **详情居中**——`.skill-detail` 用 `.md-read` 的既有 66ch 口径 + `margin: 0 auto`；居中的单位是
 *     **详情整体**（`.md-read` 正文段自己**没有** margin），且它是 `.md-detail` 的**内层**包裹
 *     （滚动容器与左列表宽度都不动 = F3 契约不破）；
 *  4. **长串不撑破列宽**——列内 `min-width: 0` + `overflow-wrap: anywhere` 兜底；
 *     命令块 `.cmd` 保持自己的横滚（`white-space: nowrap` + `overflow-x: auto`）不折行。
 *
 * 环境：默认 node（不写环境 pragma，同 `styles-*.test.ts` 的既有做法）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

/** 去注释：注释里写着「原来是 X、现在改 Y」之类的说明，不剥掉会被断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 某条规则的规则体（选择器按字面匹配、从**行首**起——否则会取到组选择器的规则体）。 */
function body(selector: string): string {
  const at = BARE.indexOf(`\n${selector} {`)
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1)
  const open = BARE.indexOf('{', at)
  return BARE.slice(open + 1, BARE.indexOf('}', open))
}

/** 从规则体里取某条声明的值（找不到就抛，避免「少了这条」被静默通过）。 */
function decl(selector: string, prop: string): string {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(body(selector))
  expect(m, `${selector} 里没有 ${prop}`).not.toBeNull()
  return m![1]!.trim()
}

describe('F7 组头：可点行（同知识库目录树的行口径）', () => {
  it('`.skill-group-head` 是 flex 行，左 3px 透明边与 `.md-row` 同宽（组名对齐行名）', () => {
    const rule = body('.skill-group-head')
    expect(rule).toContain('display: flex')
    expect(rule).toContain('border-left: 3px solid transparent')
    expect(decl('.md-row', 'border-left')).toBe('3px solid transparent')
    // 「能点」的视觉信号：指针 + hover 底（`.md-row:hover` 同款底）
    expect(decl('.skill-group-head', 'cursor')).toBe('pointer')
    expect(body('.skill-group-head:hover')).toContain('background: var(--sheet-2)')
  })

  it('组头不新增颜色 / 字号档（层级与状态都走既有 token）', () => {
    const rule = body('.skill-group-head')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rule).not.toMatch(/\brgba?\(/)
    expect(rule).not.toMatch(/font-size/)
  })

  it('chev 复用既有类：`.toc-chev` **只有一条规则体**覆盖两个挂载点（不复制取值）', () => {
    expect(BARE).toContain('\n.book-toc .toc-chev, .skill-group .toc-chev {')
    expect(BARE).toContain('\n.book-toc .toc-chev.open, .skill-group .toc-chev.open {')
    // 回归红线：`.skill-group .toc-chev` **不得**自己再成一条规则（那就是第二套口径）
    expect(BARE).not.toContain('\n.skill-group .toc-chev {')
    expect(decl('.book-toc .toc-chev, .skill-group .toc-chev', 'transition')).toBe(
      'transform var(--t-mid) var(--ease)',
    )
    expect(body('.book-toc .toc-chev.open, .skill-group .toc-chev.open')).toContain('transform: rotate(90deg)')
  })
})

describe('F7 详情居中：居中的单位是详情整体', () => {
  it('`.skill-detail` 放宽为 min(75rem, 100%) + `margin: 0 auto`（2026-09-17 用户反馈：66ch 在宽屏只剩中间一小条）', () => {
    expect(decl('.skill-detail', 'max-width')).toBe('min(75rem, 100%)')
    expect(decl('.skill-detail', 'margin')).toBe('0 auto')
    // 「同口径」是可验证的：技能/角色详情取同一个值；知识库阅读度量 `.md-read` 仍保持 66ch（长文阅读页）
    expect(decl('.skill-detail', 'max-width')).toBe(decl('.role-detail', 'max-width'))
    expect(decl('.md-read', 'max-width')).toBe('66ch')
  })

  it('正文段自己**没有**居中（居中是详情整体，不是正文段——否则命令块与 scope 会左贴）', () => {
    expect(body('.md-read')).not.toMatch(/(^|;|\s)margin/)
  })

  it('F3 契约不破：滚动的仍是 `.md-detail`（居中列是它的**内层**包裹）', () => {
    const detail = body('.md-detail')
    expect(detail).toContain('overflow-y: auto')
    expect(detail).toContain('min-height: 0')
    expect(detail).toContain('min-width: 0')
    // 滚动容器自身不被加宽/收窄约束（约束落在那层包裹上）
    expect(detail).not.toMatch(/max-width/)
  })

  it('不影响左列表宽度（`.md` 网格与 `.md-list` 的滚动口径一字未动）', () => {
    const md = body('.md')
    expect(md).toContain('grid-template-columns: minmax(220px, 300px) minmax(0, 1fr)')
    expect(md).not.toMatch(/height:\s*calc\(/)
    expect(body('.md-list')).toContain('overflow-y: auto')
  })
})

describe('F7 折行长串不撑破居中列', () => {
  it('列内 `min-width: 0` + `overflow-wrap: anywhere`（无空格可断时的兜底断点）', () => {
    expect(decl('.skill-detail', 'min-width')).toBe('0')
    expect(decl('.skill-detail', 'overflow-wrap')).toBe('anywhere')
  })

  it('命令块保持自己的横滚（不折行、也不把列撑宽）', () => {
    const cmd = body('.cmd')
    expect(cmd).toContain('overflow-x: auto')
    expect(cmd).toContain('white-space: nowrap')
    expect(cmd).toContain('min-width: 12.5rem')
  })
})
