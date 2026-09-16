/**
 * v7.1 交互质感：**样式层契约**的存在性锁。
 *
 * 为什么用「读文件 + 断言文本」而不是渲染后读 `getComputedStyle`：
 * happy-dom **不解析外部样式表**（`styles.css` 经 Vite 注入，测试里根本没有样式表），
 * `getComputedStyle` 只会返回空串——那样写出来的用例是**恒绿的空断言**。
 * 这里锁的是「规则写下来了没有、档位对不对」，覆盖的正是本轮 regression 面
 * （有人把 prefers-reduced-motion 降级块删掉、或把滚动条两轨改成一条，测试必须响）。
 *
 * 环境：默认 node —— 本文件**故意不写**环境 pragma。⚠ 注意：连那行 pragma 的**文字**
 * 都不能出现在注释里（vitest 扫的是首个块注释的原文），否则本文件会被静默切到 happy-dom，
 * `import.meta.url` 随之变成 http 形态、`fileURLToPath` 直接抛「URL must be of scheme file」。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

/** 去掉注释：注释里写着规范条款（如「不许动 width」），不剥掉会被下面的断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取 `:root { … }`（深色默认）与 `:root[data-theme='light'] { … }` 两块 token 声明。 */
function block(selector: string): string {
  const at = BARE.indexOf(selector)
  expect(at, `styles.css 里找不到 ${selector}`).toBeGreaterThan(-1)
  const open = BARE.indexOf('{', at)
  return BARE.slice(open + 1, BARE.indexOf('}', open))
}

const DARK = block(':root {')
const LIGHT = block(":root[data-theme='light']")

/** token 的声明值（`--x: v;`），找不到返回 undefined。 */
function token(source: string, name: string): string | undefined {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(source)
  return m?.[1]?.trim()
}

describe('v7.1 动效 token（P1）', () => {
  it('三档时长 + 缓动 + 按压位移都在深色默认块里定义，值与本轮口径一致', () => {
    expect(token(DARK, '--t-fast')).toBe('120ms')
    expect(token(DARK, '--t-mid')).toBe('180ms')
    expect(token(DARK, '--ease')).toBe('cubic-bezier(0.16, 1, 0.3, 1)')
    expect(token(DARK, '--press')).toBe('1px')
  })

  it('悬停/按压契约只挂在 :where() 上（0 特异性，既有规则仍可就近覆盖）', () => {
    expect(BARE).toContain(":where(a, button, [role='button'], summary)")
    // 按压用位移、不用 scale —— 全站唯一口径，两个都不许出现在同一条规则里
    const press = /:where\(a, button, \[role='button'\], summary\):active:not\(:disabled\)\s*\{([^}]*)\}/.exec(BARE)
    expect(press, '找不到按压反馈规则').not.toBeNull()
    expect(press?.[1]).toContain('translateY(var(--press))')
    expect(press?.[1]).not.toContain('scale(')
  })

  it('展开收起用 grid 行轨道（0fr→1fr），且折叠态把整棵子树移出 Tab 序列', () => {
    expect(BARE).toMatch(/\.collapse\s*\{[^}]*grid-template-rows:\s*0fr/)
    expect(BARE).toMatch(/\.collapse\.open\s*\{[^}]*grid-template-rows:\s*1fr/)
    // 内层 open 会把 visibility 覆盖回 visible（与 display:none 不同），故必须有这条兜底
    expect(BARE).toMatch(/\.collapse:not\(\.open\)\s*\*\s*\{[^}]*visibility:\s*hidden/)
  })

  it('抽屉滑入 / 模态淡入 / 遮罩淡入 / 骨架呼吸 / 内容切换五个关键帧都有定义并被消费', () => {
    for (const name of [
      'prism-scrim-in',
      'prism-drawer-in',
      'prism-modal-in',
      'prism-breath',
      'prism-content-in',
    ]) {
      expect(BARE, `缺少 @keyframes ${name}`).toContain(`@keyframes ${name}`)
    }
    expect(BARE).toMatch(/\.drawer-mask\s*\{[^}]*animation:\s*prism-scrim-in/)
    expect(BARE).toMatch(/\.drawer\s*\{[^}]*animation:\s*prism-drawer-in/)
    expect(BARE).toMatch(/\.modal-mask\s*\{[^}]*animation:\s*prism-scrim-in/)
    expect(BARE).toMatch(/\.modal\s*\{[^}]*animation:\s*prism-modal-in/)
    expect(BARE).toMatch(/\.swap-in\s*\{[^}]*animation:\s*prism-content-in/)
  })

  it('加载骨架是「单次轻呼吸」：跑有限次，绝不无限循环', () => {
    const skeleton = /\.skeleton\s*\{([^}]*)\}/.exec(BARE)
    expect(skeleton).not.toBeNull()
    const body = skeleton?.[1] ?? ''
    expect(body).toContain('prism-breath')
    expect(body).not.toContain('infinite')
    // 呼吸只动 opacity，不动骨架条的几何
    expect(BARE).toMatch(/@keyframes prism-breath\s*\{[^}]*opacity/)
  })
})

describe('v7.1 滚动条（P0）', () => {
  it('双轨齐备：webkit 伪元素族 + 标准 scrollbar-width/scrollbar-color', () => {
    expect(BARE).toMatch(/::-webkit-scrollbar\s*\{[^}]*width:\s*10px/)
    expect(BARE).toMatch(/::-webkit-scrollbar\s*\{[^}]*height:\s*10px/)
    expect(BARE).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*border-radius/)
    expect(BARE).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*content-box/)
    expect(BARE).toMatch(/scrollbar-width:\s*thin/)
    expect(BARE).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\)\s+transparent/)
    // track 必须透明（透明轨道是「格格不入」的主因之一）
    expect(BARE).toMatch(/::-webkit-scrollbar-track[^{]*\{[^}]*background:\s*transparent/)
  })

  it('两条轨都吃**同一对 token**（改一处即两轨同步，不会一边深一边浅）', () => {
    expect(BARE).toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--scroll-thumb\)/)
    expect(BARE).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--scroll-thumb-hover\)/)
    // 悬停态必须重复 background-clip：`background` 简写会把它重置回 border-box
    expect(BARE).toMatch(/::-webkit-scrollbar-thumb:hover\s*\{[^}]*background-clip:\s*content-box/)
  })

  it('深/浅主题各配一份且**方向相反**（浅色主题的 thumb 更重，不是照抄深色）', () => {
    expect(token(DARK, '--scroll-thumb')).toBeDefined()
    expect(token(LIGHT, '--scroll-thumb')).toBeDefined()
    expect(token(LIGHT, '--scroll-thumb-hover')).toBeDefined()
    expect(token(DARK, '--scroll-thumb-hover')).not.toBe(token(DARK, '--scroll-thumb'))
    // 两块混的百分比不同 ⇒ 浅色主题确实另调了一档，不是「深色值抄一份」
    expect(token(DARK, '--scroll-thumb')).not.toBe(token(LIGHT, '--scroll-thumb'))
  })
})

describe('v7.1 reduced-motion 降级（P1，本轮从可选升为必须）', () => {
  it('存在全局通配降级块，且把时长与延迟都按住', () => {
    const at = BARE.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(at, '找不到 reduced-motion 降级块').toBeGreaterThan(-1)
    const body = BARE.slice(BARE.indexOf('{', at) + 1, BARE.length)
    // 通配（含伪元素）——只写个别类名会漏掉本轮新增的动效
    expect(body).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/)
    expect(body).toMatch(/animation-duration:\s*[\d.]+m?s\s*!important/)
    expect(body).toMatch(/animation-iteration-count:\s*1\s*!important/)
    expect(body).toMatch(/transition-duration:\s*[\d.]+m?s\s*!important/)
    // 延迟不清零的话，`.collapse` 那条 `visibility 0s linear var(--t-mid)` 会继续生效
    expect(body).toMatch(/transition-delay:\s*0m?s\s*!important/)
    expect(body).toMatch(/animation-delay:\s*0m?s\s*!important/)
  })
})
