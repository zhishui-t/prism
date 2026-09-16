/**
 * F8 §三 技能页层级的**样式契约**：文本级存在性 + 值锁。
 *
 * 与 `skills-hierarchy.test.ts`（happy-dom，管 DOM 结构）成对：这边管「规则写下来了没有、值对不对」。
 * 分开的理由是技术性的——happy-dom 环境里 `import.meta.url` 是 http URL，`fileURLToPath` 会抛，
 * 读不了 `styles.css`；且 happy-dom 不解析外部样式表，`getComputedStyle` 探针只会得到恒绿的空断言
 * （同 `styles-markdown-typography.test.ts` 头注）。
 *
 * 本文件锁五件事（层级与密度都靠 CSS 表达，DOM 断言看不见）：
 *  1. **列表行摘要 1 行**（`.md-row .s`）——§3.4 #5：2 行 clamp → 1 行，配 `firstSentence(desc, 32)`；
 *  2. **第一眼描述正文**（`.skill-desc`）——`--fs-300` + `--lh-ui`、**不截断**（全文落这里）、不上色；
 *  3. **深挖带口径**——`.skill-deep > summary` 与角色页 `.role-body > summary` **逐值相同**
 *     （`--s-4` 顶距、summary `--fs-200` + `--mute`），不是第二套口径；
 *  4. **未装命令块**（`.scope-callout`）仍是 `--sheet-2` 底 + 左 3px `--warn` 边（F8 §3.1 常用带）；
 *  5. **红线**：本批新增类不引入颜色 / 灰阶 / 新字号档（只用既有 token），且 F3 的两栏容器口径未动。
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

/**
 * 组选择器（`.a, .b > summary` 这种）的规则体：`body()` 只认从行首起、**单个**选择器的写法，
 * 角色页深挖带是组选择器，故另开一个入口按整串匹配。
 */
function groupDecl(group: string, prop: string): string {
  const at = BARE.indexOf(`\n${group} {`)
  expect(at, `styles.css 里找不到组规则 ${group}`).toBeGreaterThan(-1)
  const rule = BARE.slice(BARE.indexOf('{', at) + 1, BARE.indexOf('}', at))
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(rule)
  expect(m, `${group} 里没有 ${prop}`).not.toBeNull()
  return m![1]!.trim()
}

describe('F8 §3.4 #5 左列表行摘要：1 行 clamp（2 行是旧口径）', () => {
  it('`.md-row .s` 是 **1 行**截断的 `-webkit-box`（半套写法等于没截断）', () => {
    const rule = body('.md-row .s')
    expect(rule).toContain('display: -webkit-box')
    expect(rule).toContain('-webkit-line-clamp: 1')
    expect(rule).toContain('-webkit-box-orient: vertical')
    expect(rule).toContain('overflow: hidden')
    // 回归红线：2 行 clamp 是本批要砍掉的旧口径
    expect(rule).not.toContain('-webkit-line-clamp: 2')
  })

  it('字号/行高取既有档（摘要属第二眼：`--fs-200` + `--lh-ui` + `--mute`）', () => {
    expect(decl('.md-row .s', 'font-size')).toBe('var(--fs-200)')
    expect(decl('.md-row .s', 'line-height')).toBe('var(--lh-ui)')
    expect(decl('.md-row .s', 'color')).toBe('var(--mute)')
  })
})

describe('F8 §3.4 #6 详情第一眼：描述直接作为正文', () => {
  it('`.skill-desc` 是 `--fs-300` + `--lh-ui`（第一眼正文档）', () => {
    expect(decl('.skill-desc', 'font-size')).toBe('var(--fs-300)')
    expect(decl('.skill-desc', 'line-height')).toBe('var(--lh-ui)')
  })

  it('**不截断**（列表那 32 字摘要只是入口，全文落在详情）', () => {
    for (const prop of ['-webkit-line-clamp', 'overflow', 'max-height']) {
      expect(body('.skill-desc'), prop).not.toContain(prop)
    }
  })

  it('不靠颜色表达层级：本条规则**没有任何** `color` 声明（字色继承 `body` 的 `--ink`）', () => {
    expect(body('.skill-desc')).not.toMatch(/[^-]color:/)
  })
})

describe('F8 §3.1 深挖带：`.skill-deep` 与 `.role-body` 同口径（不是第二套）', () => {
  it('summary 三值（光标 / 字号 / 字色）与角色页深挖带逐字相同', () => {
    const roleSummary = '.role-issues > summary, .role-body > summary'
    expect(decl('.skill-deep > summary', 'cursor')).toBe('pointer')
    expect(decl('.skill-deep > summary', 'font-size')).toBe(groupDecl(roleSummary, 'font-size'))
    expect(decl('.skill-deep > summary', 'color')).toBe(groupDecl(roleSummary, 'color'))
    expect(decl('.skill-deep > summary', 'font-size')).toBe('var(--fs-200)')
    expect(decl('.skill-deep > summary', 'color')).toBe('var(--mute)')
  })

  it('顶距与常用带拉开一档（`--s-4`，与 `.role-issues` / `.role-body` 同值）', () => {
    expect(decl('.skill-deep', 'margin-top')).toBe('var(--s-4)')
    expect(decl('.skill-deep', 'margin-top')).toBe(groupDecl('.role-issues, .role-body', 'margin-top'))
  })

  it('与团队页那条同源新规则逐值相同（三页同一条深挖口径）', () => {
    expect(decl('.skill-deep', 'margin-top')).toBe(decl('.team-deep', 'margin-top'))
    expect(decl('.skill-deep > summary', 'font-size')).toBe(decl('.team-deep > summary', 'font-size'))
    expect(decl('.skill-deep > summary', 'color')).toBe(decl('.team-deep > summary', 'color'))
  })

  it('角色页那两条既有规则**未被改写**（本轮只加同值的新选择器，不动别人的断言面）', () => {
    expect(BARE).toContain('\n.role-issues, .role-body {')
    expect(BARE).toContain('\n.role-issues > summary, .role-body > summary {')
  })
})

describe('F8 §3.1 常用带：未装命令块的强调块口径', () => {
  it('`.scope-callout` 仍是 `--sheet-2` 底 + 左 3px `--warn` 边（未装才出现）', () => {
    const rule = body('.scope-callout')
    expect(rule).toContain('background: var(--sheet-2)')
    expect(rule).toContain('border-left: 3px solid var(--warn)')
  })
})

describe('F8 §0.1 红线：不新增颜色 / 灰阶 / 字号档', () => {
  it('本批新增的类里只用既有 token', () => {
    for (const sel of ['.skill-desc', '.skill-deep', '.skill-deep > summary']) {
      const rule = body(sel)
      // 任何十六进制色 / rgb() 字面量都是「新增色」的信号（本项目颜色只经 token）
      expect(rule, sel).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(rule, sel).not.toMatch(/\brgba?\(/)
      // 字号只取既有档位
      for (const m of rule.matchAll(/font-size:\s*([^;]+);/g)) {
        expect(m[1]?.trim(), sel).toMatch(/^var\(--fs-\d+\)$/)
      }
    }
  })

  it('F3 的两栏容器口径未动（技能页左右两栏仍各自滚、整页不滚）', () => {
    expect(body('.md')).toContain('minmax(220px, 300px)')
    expect(body('.md')).not.toMatch(/height:\s*calc\(/)
    expect(body('.md-list')).toContain('overflow-y: auto')
    expect(body('.md-detail')).toContain('overflow-y: auto')
  })
})
