/**
 * v10 F8 + F9ui 的**视觉契约**：主区两态（初始引导 / 层级探索）的布局、配色、动效口径。
 *
 * 为什么单开一个文件（而不是放进 `graph-explore-dom.test.ts`）：那个文件跑在 happy-dom 下
 * （要验下钻交互），而 happy-dom 里 `import.meta.url` 是 http 形态、`fileURLToPath` 直接抛
 * 「The URL must be of scheme file」；且 happy-dom **不解析外部样式表**，
 * `getComputedStyle` 只会得到恒绿的空断言。本文件**不写**环境 pragma（默认 node），
 * 口径与 `styles-*.test.ts` / `graph-query-styles.test.ts` 一致：读 `styles.css` 断言规则文本。
 *
 * ⚠ 连那行 pragma 的**文字**都不能出现在注释里——vitest 扫的是首个块注释的原文，
 * 出现即被静默切到 happy-dom（`styles-motion-tokens.test.ts` 头注记了同一个坑）。
 *
 * 锁五件事：
 *  1. **主区框架**：`.graph-main` 吃满剩余高度、自己不留 padding/不滚（滚动交给内层），
 *     内层结果面板不再画第二道框（F8 拆掉 Studio 分栏后必须收掉的那些声明）；
 *  2. **旧分栏残留不复活**：`.studio-split` / `.studio-note` / `.graph-studio-card` 已从
 *     样式表删除；`.iframe-wrap` **仍在**（知识库架构图视图还在用它）；
 *  3. **探索组零新增颜色**：全部 `var(--…)`；尤其**不得再用 `--lamp`**
 *     （F5 已把该 token 的非状态消费钉成三处，`styles-call-chain-graph.test.ts` 守着）；
 *  4. **面包屑不做层级缩进**：三层是独立投影不是包含树，缩进会暗示归属；
 *  5. **动效只动 transform** + motion token，不新增关键帧，幅度复用 `--press`。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const CSS = read('../src/styles.css')
/** 去注释：注释里写着「为什么这么写」，不剥掉会被下面的断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 全部规则对（选择器串 + 规则体）；组选择器保留换行与逗号。 */
const RULES = [...BARE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? '').trim(),
  decls: m[2] ?? '',
}))

function parts(selector: string): string[] {
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function rulesFor(selector: string): { selector: string; decls: string }[] {
  const hit = RULES.filter((r) => parts(r.selector).includes(selector))
  expect(hit.length, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(0)
  return hit
}

/** 某选择器上某条声明的值（跨规则取第一条命中）。 */
function decl(selector: string, prop: string): string {
  for (const rule of rulesFor(selector)) {
    const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`).exec(rule.decls)
    if (m !== null) return m[1]!.trim()
  }
  throw new Error(`${selector} 里没有 ${prop}`)
}

/** 本批（F8 主区 + F9ui 探索）的选择器。 */
const OWN_PREFIXES = ['.graph-main', '.graph-view-bar', '.graph-guide', '.graph-loading', '.explore-', '.crumb']
function ownRules(): { selector: string; decls: string }[] {
  return RULES.filter((r) => parts(r.selector).some((s) => OWN_PREFIXES.some((p) => s.startsWith(p))))
}

describe('F8 主区框架：吃满剩余高度，滚动只发生在内层', () => {
  it('`.graph-main` 是弹性列子项、自己不留 padding 也不滚（否则内层滚动区被 padding 卡住）', () => {
    expect(decl('.graph-main', 'flex')).toBe('1 1 auto')
    expect(decl('.graph-main', 'flex-direction')).toBe('column')
    expect(decl('.graph-main', 'min-height')).toBe('0')
    expect(decl('.graph-main', 'padding')).toBe('0')
    expect(decl('.graph-main', 'overflow')).toBe('hidden')
  })

  it('视图分段控件那行是一条 hairline（与面板头同族），内边距走间距档', () => {
    expect(decl('.graph-view-bar', 'border-bottom')).toBe('1px solid var(--rule)')
    expect(decl('.graph-view-bar', 'padding')).toMatch(/var\(--s-\d\)/)
  })

  it('主区里的结果面板不再画第二道框（`.pane.graph-main` 就是那道框，套两层会成双线）', () => {
    expect(decl('.graph-main > .query-panel', 'border')).toBe('0')
    expect(decl('.graph-main > .query-panel', 'border-radius')).toBe('0')
  })

  it('初始引导与探索视图各自内滚（主区高度固定，页面不跟着长）；在途骨架共用同一版位', () => {
    expect(decl('.graph-guide', 'overflow')).toBe('auto')
    expect(decl('.graph-guide', 'padding')).toMatch(/var\(--s-\d\)/)
    expect(decl('.explore-wrap', 'overflow')).toBe('auto')
    expect(decl('.explore-wrap', 'padding')).toMatch(/var\(--s-\d\)/)
    expect(decl('.explore-wrap', 'min-height')).toBe('0')
    // `.graph-loading` 与 `.graph-guide` 同一条规则（切换骨架/引导不该有位移）
    const shared = rulesFor('.graph-loading')
    expect(parts(shared[0]!.selector)).toEqual(
      expect.arrayContaining(['.graph-guide', '.graph-loading']),
    )
  })

  it('旧 Studio 分栏的样式**已删除**（分栏与 iframe 一起退场），但 `.iframe-wrap` 保留给知识库', () => {
    for (const gone of ['.studio-split', '.studio-note', '.graph-studio-card']) {
      expect(
        RULES.some((r) => parts(r.selector).includes(gone)),
        `${gone} 不该还在样式表里`,
      ).toBe(false)
    }
    expect(RULES.some((r) => parts(r.selector).includes('.iframe-wrap'))).toBe(true)
  })
})

describe('F9ui 探索：卡片网格与配色走既有 token', () => {
  it('卡片网格自适应列宽（窄屏自然回落，不需要媒体查询）', () => {
    expect(decl('.explore-grid', 'display')).toBe('grid')
    expect(decl('.explore-grid', 'grid-template-columns')).toMatch(/repeat\(auto-fill,/)
    // 列宽下限必须是 rem 档（不是裸 px 魔法数）
    expect(decl('.explore-grid', 'grid-template-columns')).toMatch(/\d+rem/)
  })

  it('卡片面/线/圆角都取既有档（第三档面 + 排版线 + `--r-2`）', () => {
    expect(decl('.explore-card', 'background')).toBe('var(--sheet-2)')
    expect(decl('.explore-card', 'border')).toBe('1px solid var(--rule)')
    expect(decl('.explore-card', 'border-radius')).toBe('var(--r-2)')
    // 卡片是 `<button>`：字族字号必须继承（否则会被浏览器默认按钮样式改掉）
    expect(decl('.explore-card', 'font')).toBe('inherit')
  })

  it('「查此节点」的强调色走全局主色（不新开一档色）', () => {
    expect(decl('.explore-open', 'color')).toBe('var(--buckram)')
  })

  it('符号行铺满面板、id 右对齐（与多义候选行的排法同源）', () => {
    expect(decl('.explore-symbol', 'width')).toBe('100%')
    expect(decl('.explore-symbol-id', 'margin-left')).toBe('auto')
  })

  it('本组零 hex、零字面色：颜色类声明一律 `var(--…)`（`none` / `currentColor` 除外）', () => {
    const colorish = /(?:^|;)\s*(color|fill|stroke|background|background-color|outline-color|border-color)\s*:\s*([^;]+);/g
    for (const rule of ownRules()) {
      expect(rule.decls, rule.selector).not.toMatch(/#[0-9a-fA-F]{3}/)
      for (const m of rule.decls.matchAll(colorish)) {
        const value = (m[2] ?? '').trim()
        expect(
          /^var\(--/.test(value) || ['none', 'currentColor', 'transparent', 'inherit'].includes(value),
          `${rule.selector} 的 ${m[1]} 不是 token：${value}`,
        ).toBe(true)
      }
    }
  })

  it('本组不新借 `--lamp`（F5 已把它的非状态消费钉成三处，别处再借就破了那条守卫）', () => {
    for (const rule of ownRules()) {
      expect(rule.decls, rule.selector).not.toContain('var(--lamp)')
    }
  })
})

describe('F9ui 面包屑：只表达探索路径，不做层级缩进', () => {
  it('面包屑与其单元格都没有左缩进/树形符号（缩进会暗示「目录属于社区」）', () => {
    expect(rulesFor('.crumb')[0]!.decls).not.toMatch(/(?:^|;)\s*(padding-left|margin-left)\s*:/)
    expect(rulesFor('.crumb-cell')[0]!.decls).not.toMatch(/(?:^|;)\s*(padding-left|margin-left)\s*:/)
    expect(decl('.crumb-cell', 'display')).toBe('inline-flex')
  })

  it('回退段是可点的文字按钮（下划线 + `--mute`），当前段是加重文字', () => {
    expect(rulesFor('.crumb-back')[0]!.decls).toContain('cursor: pointer')
    expect(decl('.crumb-back', 'color')).toBe('var(--mute)')
    expect(decl('.crumb-here', 'font-weight')).toBe('600')
  })

  it('口径说明不写死字号/颜色（沿用 `.small muted` 既有件）', () => {
    const rule = rulesFor('.explore-note')[0]!.decls
    expect(rule).not.toMatch(/font-size\s*:/)
    expect(rule).not.toMatch(/color\s*:/)
  })
})

describe('F9ui 动效：只动 transform，时长走 token，不新增关键帧', () => {
  it('卡片抬起的过渡只含 `transform`，且时长/缓动都是 motion token', () => {
    const transition = decl('.explore-card', 'transition')
    const props = transition.split(',').map((s) => s.trim().split(/\s+/)[0] ?? '')
    expect(props).toEqual(['transform'])
    expect(transition).toContain('var(--t-fast)')
    expect(transition).toContain('var(--ease)')
  })

  it('抬起幅度复用 `--press`（方向取反），不写裸 px', () => {
    const lifted = RULES.filter((r) =>
      parts(r.selector).some((s) => s.startsWith('.explore-card:hover') || s.startsWith('.explore-card:focus-visible')),
    ).map((r) => r.decls)
    const hit = lifted.find((d) => d.includes('transform'))
    expect(hit, '找不到抬起规则').toBeDefined()
    expect(hit).toContain('translateY(calc(-1 * var(--press)))')
  })

  it('本组不新增关键帧、不写 animation、也没有无限循环', () => {
    for (const rule of ownRules()) {
      expect(rule.decls, rule.selector).not.toMatch(/(?:^|;)\s*animation\s*:/)
      expect(rule.decls, rule.selector).not.toContain('infinite')
    }
  })
})

describe('F9ui 组件源码：不写 inline 样式、不写 hex', () => {
  const SRC = read('../src/pages/GraphExplore.tsx').replace(/\/\*[\s\S]*?\*\//g, '')

  it('组件里没有 `style={{…}}`（外观与几何都走类 / 属性）', () => {
    expect(SRC).not.toContain('style={{')
  })

  it('组件里没有 hex 颜色（颜色只在 styles.css 的 token 里出现）', () => {
    expect(SRC).not.toMatch(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/)
  })
})
