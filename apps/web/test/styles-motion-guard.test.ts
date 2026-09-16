/**
 * v7.1 动效护栏：**只动 transform / opacity**（外加颜色与一条被豁免的高度技巧）。
 *
 * 这条护栏针对的是简报的硬约束（§6.A 硬件加速）与本轮红线：「全部动效只用 transform/opacity，
 * 例外仅滚动条样式与 grid-rows 高度技巧」。它比「有没有写动画」更值钱——动画写多了之后，
 * 第一个悄悄溜进来的通常是 `transition: left .2s` 或 `transition: all`，肉眼难察、帧率难抓。
 *
 * 做法：把 CSS 里**所有** `transition` 声明的属性名与**所有** `@keyframes` 里的声明属性名
 * 抽出来，逐个对照白名单。白名单式（而不是黑名单式）故意的：白名单能拦住还没被想过的
 * 新写法（`inset` / `rotate` / `translate` / 拼错的属性），黑名单只能拦住已知的那些。
 *
 * 环境：默认 node（理由与用法同 `styles-motion-tokens.test.ts`，本文件不写环境 pragma）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 允许被过渡/动画的属性。
 * - `transform` / `opacity`：只走合成器，不触发布局与重绘（简报 §6.A）。
 * - `color` 一族：只重绘、不重排，且是「悬停/选中态平滑」的唯一手段。
 * - `visibility`：离散属性，用来让折叠子树退出 Tab 序列（`0s` + 延时，不是视觉动画）。
 * - `grid-template-rows`：**唯一豁免**的高度技巧（P1 展开收起），代价是重排但只在一格内，
 *   且是全站唯一一处——所以这里把它显式列出来，而不是让它藏在一堆属性里。
 */
const ALLOWED = new Set([
  'transform',
  'opacity',
  'color',
  'background-color',
  'border-color',
  'outline-color',
  'visibility',
  'grid-template-rows',
])

/** 按**顶层**逗号切分（`cubic-bezier(0.16, 1, 0.3, 1)` 里的逗号不是分隔符）。 */
function splitTop(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/** 所有 `transition:`（longhand 的 `transition-duration` 等不匹配）声明的属性名。
 *  一条 `transition` 可以写多个属性（逗号分隔），**每个都要收**——只取第一个会让护栏
 *  在 `transition: width … , opacity …` 这种写法上瞎掉。 */
function transitionProps(): string[] {
  return [...BARE.matchAll(/transition\s*:\s*([^;}]+)/g)].flatMap((m) =>
    splitTop(m[1] ?? '').map((part) => part.split(/\s+/)[0] ?? ''),
  )
}

/**
 * 所有 `@keyframes` 体内声明的属性名。
 * 关键帧的形态是 `@keyframes N { 0% { … } 50% { … } }`——**两层花括号**，
 * 所以先配对到关键帧整体，再逐个档位块取声明；直接按 `;` 切会把档位选择器当属性名。
 */
function keyframeProps(): string[] {
  const props: string[] = []
  for (const m of BARE.matchAll(/@keyframes\s+[\w-]+\s*\{/g)) {
    const start = (m.index ?? 0) + m[0].length
    let depth = 1
    let i = start
    while (i < BARE.length && depth > 0) {
      if (BARE[i] === '{') depth++
      else if (BARE[i] === '}') depth--
      i++
    }
    const body = BARE.slice(start, i - 1)
    for (const step of body.matchAll(/\{([^{}]*)\}/g)) {
      for (const decl of (step[1] ?? '').split(';')) {
        const name = (decl.split(':')[0] ?? '').trim()
        if (name !== '') props.push(name)
      }
    }
  }
  return props
}

describe('v7.1 动效护栏：只动 transform / opacity', () => {
  it('样式表里确实有过渡与关键帧（否则下面的白名单断言是空跑）', () => {
    expect(transitionProps().length).toBeGreaterThan(5)
    expect(keyframeProps().length).toBeGreaterThan(5)
  })

  it('所有 transition 的属性名都在白名单里', () => {
    const offenders = transitionProps().filter((p) => !ALLOWED.has(p))
    expect(offenders).toEqual([])
  })

  it('所有 @keyframes 里的声明属性名都在白名单里（含嵌套档位）', () => {
    const offenders = keyframeProps().filter((p) => !ALLOWED.has(p))
    expect(offenders).toEqual([])
  })

  it('几何豁免只有一处：`grid-template-rows`（出现第二个几何属性即红）', () => {
    /** 「不算几何」的那一档：合成器属性、纯颜色、以及用来退出 Tab 序列的 `visibility`。 */
    const notGeometry = new Set([
      'transform',
      'opacity',
      'color',
      'background-color',
      'border-color',
      'outline-color',
      'visibility',
    ])
    const distinct = new Set([...transitionProps(), ...keyframeProps()])
    const geometry = [...distinct].filter((p) => !notGeometry.has(p)).sort()
    expect(geometry).toEqual(['grid-template-rows'])
    // 明确禁掉「顺手 all 一下」：`transition: all` 会把每一次布局变化都变成动画
    expect(distinct.has('all')).toBe(false)
  })

  it('没有任何无限循环动画（骨架呼吸也必须跑有限次）', () => {
    expect(BARE).not.toContain('infinite')
  })

  it('不劫持滚动：没有 scroll-behavior: smooth', () => {
    expect(BARE).not.toMatch(/scroll-behavior\s*:\s*smooth/)
  })
})
