/**
 * F8 §二 团队页层级的**样式契约**：文本级存在性 + 值锁。
 *
 * 与 `teams-hierarchy.test.ts`（happy-dom，管 DOM 结构）成对：这边管「规则写下来了没有、值对不对」。
 * 分开的理由是技术性的——happy-dom 环境里 `import.meta.url` 是 http URL，`fileURLToPath` 会抛，
 * 读不了 `styles.css`；且 happy-dom 不解析外部样式表，`getComputedStyle` 探针只会得到恒绿的空断言
 * （同 `styles-markdown-typography.test.ts` 头注）。
 *
 * 本文件锁四件事（层级与密度都靠 CSS 表达，DOM 断言看不见）：
 *  1. **第一眼描述行**（`.pane-desc`）——`--fs-300` + `--lh-ui` + **2 行截断**（§2.1，全文进 `title`）；
 *  2. **深挖带口径**——`.team-deep` 与角色页的折叠带 `.role-issues` **逐值相同**（`--s-4` 顶距、
 *     summary `--fs-200` + `--mute`），不是第二套口径（v10 F2 起角色页正文区 `.role-body`
 *     改常驻、不再折叠，故比对对象是仍在的 `.role-issues`）；
 *  3. **组折叠的可发现入口**——`.scope-group > summary` 是组头（R-v8-7），有指针光标；
 *  4. **红线**：本批新增类不引入颜色/灰阶/新字号档（只用既有 token），且 F3 的两栏容器口径未动。
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

describe('F8 §2.1 第一眼②：描述收 2 行（全文进 `title`）', () => {
  it('`.pane-desc` 是 2 行截断的 `-webkit-box`（半套写法等于没截断）', () => {
    const rule = body('.pane-desc')
    expect(rule).toContain('display: -webkit-box')
    expect(rule).toContain('-webkit-line-clamp: 2')
    expect(rule).toContain('-webkit-box-orient: vertical')
    expect(rule).toContain('overflow: hidden')
  })

  it('字号/行高取既有档（第一眼 ≥ `--fs-300`，行高走界面档）', () => {
    expect(decl('.pane-desc', 'font-size')).toBe('var(--fs-300)')
    expect(decl('.pane-desc', 'line-height')).toBe('var(--lh-ui)')
  })

  it('不靠颜色表达层级：本条规则**没有任何** `color` 声明（字色继承 `body` 的 `--ink`）', () => {
    expect(body('.pane-desc')).not.toMatch(/[^-]color:/)
  })
})

describe('F8 §2.1 / v10 F2 深挖带：`.team-deep` 与角色页折叠带 `.role-issues` 同口径（不是第二套）', () => {
  it('summary 三值（光标 / 字号 / 字色）与角色页折叠带逐字相同', () => {
    expect(decl('.team-deep > summary', 'cursor')).toBe('pointer')
    expect(decl('.team-deep > summary', 'font-size')).toBe(decl('.role-issues > summary', 'font-size'))
    expect(decl('.team-deep > summary', 'color')).toBe(decl('.role-issues > summary', 'color'))
    expect(decl('.team-deep > summary', 'font-size')).toBe('var(--fs-200)')
    expect(decl('.team-deep > summary', 'color')).toBe('var(--mute)')
  })

  it('顶距与常用带拉开一档（`--s-4`，与 `.role-issues` 同值）', () => {
    expect(decl('.team-deep', 'margin-top')).toBe('var(--s-4)')
    expect(decl('.team-deep', 'margin-top')).toBe(decl('.role-issues', 'margin-top'))
  })

  it('角色页那条折叠带规则**未被改写**（v10 F2 只把 `.role-body` 从组里移出，取值一字未动）', () => {
    expect(BARE).toContain('\n.role-issues {')
    expect(BARE).toContain('\n.role-issues > summary {')
    expect(decl('.role-issues > summary', 'font-size')).toBe('var(--fs-200)')
    expect(decl('.role-issues > summary', 'color')).toBe('var(--mute)')
    // v10 F2：正文区 `role-body` 改常驻（实色 hairline），不再是这条折叠口径的兄弟
    expect(BARE).not.toContain('\n.role-issues, .role-body {')
    expect(BARE).not.toContain('\n.role-issues > summary, .role-body > summary {')
  })
})

describe('R-v8-7 组折叠：`<details>` 组头有可发现入口', () => {
  it('`.scope-group > summary` 是手型光标（原生三角即展开提示）', () => {
    expect(decl('.scope-group > summary', 'cursor')).toBe('pointer')
  })

  it('组头仍用既有 `.rsec-label`（技能页既有消费方规则不动）', () => {
    expect(body('.rsec-label')).toContain('font-size: var(--fs-100)')
  })
})

describe('F8 §0.1 红线：不新增颜色 / 灰阶 / 字号档', () => {
  it('本批新增的类里只用既有 token', () => {
    for (const sel of ['.pane-desc', '.team-deep', '.team-deep > summary', '.scope-group > summary']) {
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

  it('F3 的两栏容器口径未动（`.two-col` 仍是既有 auto-fit 栅格，子项可被压扁）', () => {
    expect(body('.two-col')).toContain('repeat(auto-fit, minmax(280px, 1fr))')
    expect(body('.two-col > .pane')).toContain('min-width: 0')
  })
})
