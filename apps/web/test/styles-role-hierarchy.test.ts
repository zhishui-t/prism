/**
 * F8 §一 角色页层级的**样式契约**：文本级存在性 + 值锁。
 *
 * 与 `roles-hierarchy.test.ts`（happy-dom，管 DOM 结构）成对：这边管「规则写下来了没有、
 * 值对不对」。分开的理由是技术性的——happy-dom 环境里 `import.meta.url` 是 http URL，
 * `fileURLToPath` 会抛，读不了 `styles.css`；且 happy-dom 不解析外部样式表，
 * `getComputedStyle` 探针只会得到恒绿的空断言（同 `styles-markdown-typography.test.ts` 头注）。
 *
 * 本文件锁五件事（层级与密度都靠 CSS 表达，DOM 断言看不见）：
 *  1. **底行三计数同行**（§1.4 那 −40px 的来源）——`.role-metrics` 由 `column` 改 `row`；
 *  2. **卡面与抽屉共用规则**（§1.3 同构的结构保证）——`.role-desc` / `.role-tags` 不再带
 *     `.role-card` 前缀，否则两边各写一份必然漂移；
 *  3. **截断档**：职责 1 行、原则 2 行（§1.5 #2 / §1.1）；
 *  4. **深挖带口径**：校验清单与完整定义正文共用 summary，且两处都默认折叠（`<details>` 语义）；
 *  5. **砍掉的东西不再回来**：`.role-drawer-desc` / `.rsec-hint` / `.rsec-sub` / `.rsec-eff`
 *     / `.rsec-mark` 五条规则整条删除（`.rsec-label` 保留——`SkillScopeList.tsx` 仍在用）；
 *  6. **R-v8-1 的内容列口径**（评审 MIN-4）：角色详情抽屉内容列 `.role-detail` = 66ch 居中，
 *     与 `.skill-detail` 同源；且**不写进共用** `.drawer-body`（表单 / 团队页抽屉共用它）。
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

describe('F8 §1.1/§1.4 卡片正面', () => {
  it('底行三计数**同行**：`.role-metrics` 是 row（旧实现 column ⇒ 卡片高 3 行）', () => {
    const rule = body('.role-metrics')
    expect(rule).toContain('display: flex')
    expect(rule).toContain('flex-direction: row')
    expect(rule).not.toContain('flex-direction: column')
    // 仍是「钉底行」：信息未减，只是不再占 3 行
    expect(rule).toContain('margin-top: auto')
    expect(rule).toContain('border-top: 1px solid var(--rule)')
  })

  it('三格等分同一行（否则同行会挤在左侧、右侧留白）', () => {
    expect(body('.role-metrics .count-line')).toContain('flex: 1')
  })

  it('职责收 1 行（§1.5 #2，原 2 行）；原则正文 2 行（§1.1）', () => {
    expect(body('.role-desc')).toContain('-webkit-line-clamp: 1')
    expect(body('.role-principle .rp-text')).toContain('-webkit-line-clamp: 2')
    // 两个 clamp 都要 `-webkit-box` + `overflow: hidden` 才生效（半套写法等于没截断）
    for (const sel of ['.role-desc', '.role-principle .rp-text']) {
      const rule = body(sel)
      expect(rule, sel).toContain('-webkit-box-orient: vertical')
      expect(rule, sel).toContain('overflow: hidden')
    }
  })

  it('强调块口径不变：`--sheet-2` 底 + 左 3px `--buckram` 边 + `--r-2`；空值走 `.missing`', () => {
    const rule = body('.role-principle')
    expect(rule).toContain('background: var(--sheet-2)')
    expect(rule).toContain('border-left: 3px solid var(--buckram)')
    expect(rule).toContain('border-radius: var(--r-2)')
    // `.rp-label` 是强调块里唯一带 `--buckram` 字色的零件；`.missing` 把它与左边一起降为中性
    expect(body('.role-principle .rp-label')).toContain('color: var(--buckram)')
    expect(body('.role-principle.missing')).toContain('border-left-color: var(--rule)')
    expect(body('.role-principle.missing .rp-label')).toContain('color: var(--mute)')
  })

  it('卡面与抽屉**共用规则**（§1.3 同构不会漂移）', () => {
    // 不带容器前缀 ⇒ 两处同一份声明
    expect(BARE).toMatch(/\n\.role-desc \{/)
    expect(BARE).toMatch(/\n\.role-tags \{/)
    expect(BARE).not.toMatch(/\.role-card \.role-desc\b/)
    expect(BARE).not.toMatch(/\.role-card \.role-tags\b/)
    expect(body('.role-card .role-name')).toContain('font-size: var(--fs-500)')
    expect(body('.drawer-head h3')).toContain('font-size: var(--fs-500)')
  })
})

describe('F8 §0.1 深挖带（默认折叠，summary 一行常驻）', () => {
  it('校验清单与完整定义正文共用同一 summary 口径', () => {
    const group = '\n.role-issues > summary, .role-body > summary {'
    expect(BARE).toContain(group)
    const rule = BARE.slice(BARE.indexOf(group), BARE.indexOf('}', BARE.indexOf(group)))
    expect(rule).toContain('cursor: pointer')
    expect(rule).toContain('font-size: var(--fs-200)')
    expect(rule).toContain('color: var(--mute)')
  })

  it('两条深挖带都带 `margin-top: var(--s-4)`（与常用带拉开一档留白）', () => {
    expect(body('.role-issues, .role-body')).toContain('margin-top: var(--s-4)')
  })

  it('error 级校验文本走 `--madder`（层级外的唯一着色，与层级无关）', () => {
    expect(body('.rsec-issue-text.err')).toContain('color: var(--madder)')
  })
})

describe('F8 §1.5 砍单：死掉的规则整条删除', () => {
  it('抽屉全量描述 / 两行口径说明 / 差集行——五条规则都不在 styles.css 里', () => {
    for (const sel of ['.role-drawer-desc', '.rsec-hint', '.rsec-sub', '.rsec-eff', '.rsec-mark']) {
      expect(BARE, `${sel} 应随 F8 §1.5 一并删除`).not.toMatch(
        new RegExp(`\\n\\${sel}[ ,{]`),
      )
    }
  })

  it('`.rsec-label` **保留**（`components/SkillScopeList.tsx` 仍在消费）', () => {
    expect(BARE).toMatch(/\n\.rsec-label \{/)
    expect(body('.rsec-label')).toContain('font-size: var(--fs-100)')
  })
})

describe('R-v8-1 内容列居中（MIN-4，2026-09-17 用户反馈后放宽）', () => {
  it('角色详情抽屉内容列 = min(75rem, 100%) + auto 外边距（与技能详情 `.skill-detail` 同口径）', () => {
    const rule = body('.role-detail')
    expect(rule).toContain('max-width: min(75rem, 100%)')
    expect(rule).toContain('margin: 0 auto')
    // 「同口径」的可证伪形式：两边取的是同一个值
    expect(body('.skill-detail')).toContain('max-width: min(75rem, 100%)')
  })

  it('居中列**不落到共用** `.drawer-body`：编辑表单（560）与团队页抽屉不受影响', () => {
    const rule = body('.drawer-body')
    expect(rule).not.toContain('max-width')
    expect(rule).not.toContain('margin: 0 auto')
    // 滚动容器仍是 `.drawer-body`（居中列是它的**内层**——与 `.skill-detail` 嵌在 `.md-detail` 同结构）
    expect(rule).toContain('overflow-y: auto')
  })
})

describe('F8 §0.1 红线：不新增颜色 / 灰阶 / 字号档', () => {
  it('本批新增的类里只用既有 token（`--sheet-2`/`--rule`/`--buckram`/`--mute`/`--warn`/`--madder`）', () => {
    for (const sel of ['.role-desc', '.role-tags', '.role-metrics', '.role-issues, .role-body']) {
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
})
