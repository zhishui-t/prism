/**
 * v10 F5 调用链图的**视觉契约**：SVG 的尺寸/配色/动效口径 + 「SVG 里不写 inline 样式 / 不写 hex」。
 *
 * 为什么单开一个文件（而不是放进 `graph-call-chain-dom.test.ts`）：那个文件跑在 happy-dom 下
 * （要验交互），而 happy-dom 里 `import.meta.url` 是 http 形态、`fileURLToPath` 直接抛
 * 「The URL must be of scheme file」；且 happy-dom **不解析外部样式表**，
 * `getComputedStyle` 只会得到恒绿的空断言。本文件**不写**环境 pragma（默认 node），
 * 口径与 `styles-*.test.ts` / `graph-query-styles.test.ts` 一致：读文件断言规则文本。
 *
 * ⚠ 连那行 pragma 的**文字**都不能出现在注释里——vitest 扫的是首个块注释的原文，
 * 出现即被静默切到 happy-dom（`styles-motion-tokens.test.ts` 头注记了同一个坑）。
 *
 * 锁五件事：
 *  1. **自适应容器**：`.chain-graph` 宽 100% / 高 auto / max-height（几何在 `graph-logic.ts` 算，
 *     不写死 px 宽；v12 F1 起 viewBox 随内容收窄，长链靠 max-height + 默认 meet 封顶），
 *     并带 `touch-action: none`（触控拖拽平移不被浏览器抢去滚页面，SPEC-1.3）；
 *  2. **配色只用既有 token**：方向两色（出边 `--buckram` / 入边 `--lamp`）各自到位且**不相等**，
 *     中心节点用「主色面 + `--on-buckram` 字」这对配套色，全组零 hex、零字面色；
 *  3. **动效**：本组只动 `transform`、时长/缓动走 motion token、**不新增关键帧**（淡入复用
 *     `.swap-in`），幅度复用 `--press`——reduced-motion 由文件末尾的通配块统一归零（既有守卫）；
 *     而**缩放平移层本身不声明任何过渡**（v12 F1 / SPEC-1.6：平移瞬移、缩放不因归零而失效）；
 *  4. **`--lamp` 的非状态消费只有这一处**：状态语义仍只走 `--warn` 别名（防「顺手再借一个色」）；
 *  5. **v12 F1 缩放工具条**：按钮复用既有 `.tool-btn`，百分比只读且右对齐（等宽数字）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const CSS = read('../src/styles.css')
/** 去注释：注释里写着「为什么这么写」，不剥掉会被下面的断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  /** 选择器串原样（组选择器保留换行与逗号）。 */
  selector: string
  decls: string
}

/**
 * 全部规则对（选择器串 + 规则体）。
 *
 * 用正则扫 `选择器 { 声明 }` 而不是 `body(selector)` 那种「行首字面匹配」：F5 这组里有
 * 组选择器（`.chain-node.pick:hover,\n.chain-node.pick:focus-visible { … }`），
 * 「行首 + 单选择器」的写法在前一个选择器上会落空。嵌套的 `@media` 不受影响：
 * `[^{}]+` 跨不过 `{`，故内层规则会被单独扫到（外层只留下一个空体）。
 */
const RULES: Rule[] = [...BARE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: (m[1] ?? '').trim(),
  decls: m[2] ?? '',
}))

/** 选择器串里的单个选择器（按顶层逗号切，各自 trim）。 */
function parts(selector: string): string[] {
  return selector
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 命中该选择器的**全部**规则体（拼起来；同一个选择器可能出现在多条规则里）。 */
function rulesFor(selector: string): Rule[] {
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

/** F5 本组的选择器（含选择器串里带它们的组规则）。 */
function ownRules(): Rule[] {
  return RULES.filter((r) =>
    parts(r.selector).some(
      (s) => s.startsWith('.chain-') || s === '.graph-seq-bar' || s.startsWith('.graph-seq-bar ') || s.startsWith('.graph-seq-bar.'),
    ),
  )
}

describe('F5 图容器：尺寸自适应，几何不进样式表', () => {
  it('`.chain-graph` 宽 100% / 高 auto / 有 max-height（v12 F1：letterbox，不拉伸不爆高）', () => {
    expect(decl('.chain-graph', 'display')).toBe('block')
    expect(decl('.chain-graph', 'width')).toBe('100%')
    expect(decl('.chain-graph', 'height')).toBe('auto')
    // v12 F1：viewBox 收窄后长链会很高，给一个上限；比例仍由 viewBox 定
    expect(decl('.chain-graph', 'max-height')).toBe('70vh')
  })

  it('v12 F1 触控与指针：`touch-action: none`（拖拽平移不被浏览器截胡）+ grab / grabbing 光标', () => {
    expect(decl('.chain-graph', 'touch-action')).toBe('none')
    expect(decl('.chain-graph', 'cursor')).toBe('grab')
    expect(decl('.chain-graph.dragging', 'cursor')).toBe('grabbing')
  })

  it('SVG 文字的字号 / 字族走既有阶梯（`--fs-200` + `--font-code`），并显式居中', () => {
    expect(decl('.chain-graph text', 'font-family')).toBe('var(--font-code)')
    expect(decl('.chain-graph text', 'font-size')).toBe('var(--fs-200)')
    expect(decl('.chain-graph text', 'fill')).toBe('var(--ink)')
    expect(decl('.chain-graph text', 'text-anchor')).toBe('middle')
    expect(decl('.chain-graph text', 'dominant-baseline')).toBe('middle')
  })
})

describe('F5 配色：方向两色 + 中心配套色，全部走 token', () => {
  it('入边 / 出边各一色且**不相等**（同色即方向不可分）', () => {
    expect(decl('.chain-edge.in', 'stroke')).toBe('var(--lamp)')
    expect(decl('.chain-edge.out', 'stroke')).toBe('var(--buckram)')
    expect(decl('.chain-edge.in', 'stroke')).not.toBe(decl('.chain-edge.out', 'stroke'))
    // 纵向链没有「入/出」之分，同出边一档
    expect(decl('.chain-edge.down', 'stroke')).toBe('var(--buckram)')
    // 箭头跟随边色（marker 不继承 currentColor，故各自显式给）
    expect(decl('.chain-arrow.in', 'fill')).toBe('var(--lamp)')
    expect(decl('.chain-arrow.out', 'fill')).toBe('var(--buckram)')
    expect(decl('.chain-arrow.down', 'fill')).toBe('var(--buckram)')
  })

  it('中心节点是「主色面 + `--on-buckram` 字」的配套对（不手挑前景色）', () => {
    expect(decl('.chain-node.center rect', 'fill')).toBe('var(--buckram)')
    expect(decl('.chain-node.center text', 'fill')).toBe('var(--on-buckram)')
    // 普通节点走第二档面 + 排版线
    expect(decl('.chain-node rect', 'fill')).toBe('var(--sheet-2)')
    expect(decl('.chain-node rect', 'stroke')).toBe('var(--rule)')
  })

  it('图例色块用 `currentColor`（不为其单开颜色）：三条各自的定色规则都在', () => {
    expect(decl('.chain-dot', 'background')).toBe('currentColor')
    expect(decl('.chain-key.center', 'color')).toBe('var(--buckram)')
    expect(decl('.chain-key.out', 'color')).toBe('var(--buckram)')
    expect(decl('.chain-key.in', 'color')).toBe('var(--lamp)')
  })

  it('`--lamp` 的**非状态**消费只此一处（F5 入边）——防「顺手再借一个色」', () => {
    /* 两块 token 定义（深色默认 / 浅色覆盖）不算消费：`--warn: var(--lamp)` 是别名行 */
    const tokenBlocks = [':root', ":root[data-theme='light']"]
    const users = RULES.filter((r) => r.decls.includes('var(--lamp)'))
      .filter((r) => !tokenBlocks.includes(r.selector))
      .flatMap((r) => parts(r.selector))
      .sort()
    expect(users).toEqual(['.chain-arrow.in', '.chain-edge.in', '.chain-key.in'])
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
})

describe('F5 动效：只动 transform，时长走 token，不新增关键帧', () => {
  it('可点节点的过渡只含 `transform`，且时长/缓动都是 motion token', () => {
    const transition = decl('.chain-node.pick', 'transition')
    // 顶层逗号切分后逐个属性名对照白名单（与 styles-motion-guard 同口径）
    const props = transition.split(',').map((s) => s.trim().split(/\s+/)[0] ?? '')
    expect(props).toEqual(['transform'])
    expect(transition).toContain('var(--t-fast)')
    expect(transition).toContain('var(--ease)')
  })

  it('抬起幅度复用 `--press`（方向取反），不写裸 px', () => {
    const lifted = RULES.filter((r) => parts(r.selector).some((s) => s.startsWith('.chain-node.pick:'))).map(
      (r) => r.decls,
    )
    const hit = lifted.find((d) => d.includes('transform'))
    expect(hit, '找不到抬起规则').toBeDefined()
    expect(hit).toContain('translateY(calc(-1 * var(--press)))')
  })

  it('本组不新增关键帧、不写 animation（淡入复用既有 `.swap-in`），也没有无限循环', () => {
    for (const rule of ownRules()) {
      expect(rule.decls, rule.selector).not.toMatch(/(?:^|;)\s*animation\s*:/)
      expect(rule.decls, rule.selector).not.toContain('infinite')
    }
  })
})

describe('F5 导出条与分组：布局类到位', () => {
  it('`.graph-seq-bar` 有分隔线（与面板头同族的 hairline），说明文字占满余宽', () => {
    expect(decl('.graph-seq-bar', 'border-bottom')).toBe('1px solid var(--rule)')
    expect(decl('.graph-seq-bar', 'padding')).toMatch(/var\(--s-\d\)/)
    expect(decl('.graph-seq-bar .small', 'flex')).toBe('1')
  })

  it('导出失败块就地贴按钮下方（复用 `.act-bar.err`，只收掉外距）', () => {
    const rule = rulesFor('.graph-seq-bar .act-bar')
    expect(rule[0]!.decls).toMatch(/(?:^|;)\s*margin:\s*var\(--s-2\) 0 0;/)
  })

  it('affected 首组抹掉头顶留白（组头沿用既有 `.count-line.section`，不另起一套）', () => {
    expect(decl('.chain-group:first-child .count-line', 'margin-top')).toBe('0')
    // 组头与组内行**没有**新样式：它们就是既有 `.count-line` / `.list-row`（口径只有一处）
    for (const selector of ['.chain-group .count-line', '.chain-group .graph-rel-row']) {
      expect(
        RULES.some((r) => parts(r.selector).includes(selector)),
        `${selector} 不该有新规则`,
      ).toBe(false)
    }
  })
})

describe('v12 F1 缩放层与工具条：瞬移无过渡，工具条不另起一套控件', () => {
  const ZOOM_LAYER = '.chain-zoom-layer'

  it('缩放层只声明变换原点，**不声明过渡 / 动画**（SPEC-1.6：平移瞬移、缩放不受 reduced-motion 限制）', () => {
    expect(decl(ZOOM_LAYER, 'transform-origin')).toBe('0 0')
    for (const rule of rulesFor(ZOOM_LAYER)) {
      expect(rule.decls, rule.selector).not.toMatch(/(?:^|;)\s*transition\s*:/)
      expect(rule.decls, rule.selector).not.toMatch(/(?:^|;)\s*animation\s*:/)
    }
    // 容器同理：`transform` 写在属性上、没有过渡，跟手才不慢半拍
    for (const rule of rulesFor('.chain-graph')) {
      expect(rule.decls, rule.selector).not.toMatch(/(?:^|;)\s*transition\s*:/)
    }
  })

  it('工具条一行排列、百分比只读右对齐（等宽数字，数字跳动不抖宽）', () => {
    expect(decl('.chain-zoom', 'display')).toBe('flex')
    expect(decl('.chain-zoom', 'gap')).toBe('var(--s-1)')
    expect(decl('.chain-zoom-pct', 'margin-left')).toBe('auto')
    expect(decl('.chain-zoom-pct', 'font-variant-numeric')).toBe('tabular-nums')
  })

  it('工具条按钮复用既有 `.tool-btn`（不为它另起一套按钮样式）', () => {
    for (const selector of ['.chain-zoom button', '.chain-zoom .btn', '.chain-zoom-btn']) {
      expect(RULES.some((r) => parts(r.selector).includes(selector)), `${selector} 不该有新规则`).toBe(false)
    }
  })
})

describe('F5 SVG 组件源码：不写 inline 样式、不写 hex', () => {
  const SRC = read('../src/pages/CallChainGraph.tsx').replace(/\/\*[\s\S]*?\*\//g, '')

  it('组件里没有 `style={{…}}`（几何走属性、外观走类）', () => {
    expect(SRC).not.toContain('style={{')
  })

  it('组件里没有 hex 颜色（颜色只在 styles.css 的 token 里出现）', () => {
    expect(SRC).not.toMatch(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/)
  })

  it('半径 / 箭头等外观参数不写死在组件里（`rx` 这类几何也是常量级的）', () => {
    // `rx="3"` 是控件圆角的既有档位（`--r-1`），属于「几何属性」而非「颜色」——
    // 这里只锁「不出现小数级魔法尺寸」（`rx="3.5"` 这种就地微调）
    expect(SRC).not.toMatch(/rx="[^"]*\./)
  })

  it('不覆盖 `preserveAspectRatio`（保持默认 `xMidYMid meet` ⇒ 宽容器里 letterbox，不拉伸）', () => {
    // v12 F1：容器加了 max-height，若有人把它改成 `none` 就会拉伸变形——故锁「不设置」
    expect(SRC).not.toContain('preserveAspectRatio')
  })

  it('v12 F1：滚轮走**原生** `addEventListener(..., { passive: false })`（React 合成 onWheel 是 passive，preventDefault 无效）', () => {
    expect(SRC).toContain("addEventListener('wheel'")
    expect(SRC).toContain('{ passive: false }')
    expect(SRC).not.toContain('onWheel=')
    // 缩放平移只施加在内层 `<g>` 上（viewBox 属性仍写的是内容包围盒）
    expect(SRC).toContain('className="chain-zoom-layer"')
    expect(SRC).toContain('transform={zoom.transform}')
  })
})
