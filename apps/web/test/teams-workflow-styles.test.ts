/**
 * F2（v11）工作流编排器的**样式契约**。
 *
 * 锁四件事：
 *  1. **`.stage-num` 的选择器被有意放宽**到类本身：卡片头与流程预览共用同一颗序号徽标
 *     （原先只有 `.flow-stage .stage-num`，卡片头拿不到）——放宽是改动，不是笔误；
 *  2. **`.wf-callout` 与 `.scope-callout` 同版式、只换引线色**：前者是「说明」（`--buckram`），
 *     后者是「要留意」（`--warn`）；两者除引线外逐条相同，谁被顺手改单边都能被发现；
 *  3. **两处「内容区里唯一会长的一件」都自滚并有上限**：自由文本容器 `.wf-prose-body`
 *     （42vh）与弹层库列表 `.pick-list`（38vh，F1 已锁）同属这一族；
 *  4. **不新增颜色**：新增规则里没有裸色值，全部走既有 token（`--sheet` / `--sheet-2` /
 *     `--rule` / `--mute` / `--buckram` / `--paper`）。
 *
 * 用「读文件 + 断言规则文本」而不是 `getComputedStyle`，理由同 `styles-picker.test.ts`：
 * happy-dom 不解析外部样式表，计算样式探针是恒绿空断言。
 *
 * 环境：默认 node（同既有 `styles-*.test.ts`）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8')

/** 去注释：注释里写着「刻意区分」「原来只有…」之类的说明，不剥掉会被断言误伤。 */
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

describe('F2 编排器：序号徽标的选择器放宽', () => {
  it('`.stage-num` 自成一条（卡片头与预览共用），不再挂在 `.flow-stage` 下', () => {
    expect(BARE).toContain('\n.stage-num {')
    expect(BARE).not.toContain('.flow-stage .stage-num')
    // 放宽后仍是原来那颗徽标（面 / 字 / 尺寸都没换）
    const rule = body('.stage-num')
    expect(rule).toContain('background: var(--buckram)')
    expect(rule).toContain('color: var(--paper)')
    expect(rule).toContain('width: 22px')
  })
})

describe('F2 编排器：`.wf-callout` 与 `.scope-callout` 同版式、只换引线色', () => {
  it('两条规则除引线色外逐条相同（说明 = `--buckram`，要留意 = `--warn`）', () => {
    const shared = [
      'display: flex',
      'flex-direction: column',
      'gap: var(--s-2)',
      'margin: var(--s-2) 0',
      'padding: var(--s-2) var(--s-3)',
      'background: var(--sheet-2)',
      'border-radius: var(--r-2)',
    ]
    for (const declaration of shared) {
      expect(body('.wf-callout'), '.wf-callout 少了共享声明').toContain(declaration)
      expect(body('.scope-callout'), '.scope-callout 少了共享声明').toContain(declaration)
    }
    expect(decl('.wf-callout', 'border-left')).toBe('3px solid var(--buckram)')
    expect(decl('.scope-callout', 'border-left')).toBe('3px solid var(--warn)')
  })
})

describe('F2 编排器：会长的两处都自滚且有上限', () => {
  it('自由文本容器（`.wf-prose-body`）自滚 + 42vh：与 `.pick-list` 同族（不把抽屉撑爆）', () => {
    const rule = body('.wf-prose-body')
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('max-height: 42vh')
    // 与库列表（F1）同属「内容区里唯一会长的一件」，各有一条上限
    expect(body('.pick-list')).toContain('max-height: 38vh')
  })

  it('自由文本容器自己有一层纸底（Markdown 正文不直接趴在抽屉面上）', () => {
    expect(decl('.wf-prose-body', 'background')).toBe('var(--paper)')
    expect(decl('.wf-prose-body', 'border')).toBe('1px solid var(--rule)')
  })
})

describe('F2 编排器：卡片 / 列条 / 字段的版式钩子', () => {
  it('阶段卡列表列向排列，卡片是「面 + 1px 线」的既有卡片脸', () => {
    expect(decl('.stage-cards', 'display')).toBe('flex')
    expect(decl('.stage-cards', 'flex-direction')).toBe('column')
    expect(decl('.stage-card', 'background')).toBe('var(--sheet)')
    expect(decl('.stage-card', 'border')).toBe('1px solid var(--rule)')
  })

  it('卡片头：序号 + 标题在左、动作组靠右（`.spacer` 顶到行尾）', () => {
    expect(decl('.stage-card-head', 'display')).toBe('flex')
    expect(decl('.stage-card-head .spacer', 'margin-left')).toBe('auto')
  })

  it('列映射条换行摆放（缺列时按钮数量随字段数变，不能挤成一行）', () => {
    expect(decl('.wf-cols', 'flex-wrap')).toBe('wrap')
  })

  it('自定义列条与 callout 同构但引线取中性 `--rule`（它既不是说明也不是告警）', () => {
    expect(decl('.wf-custom', 'border-left')).toBe('3px solid var(--rule)')
    expect(decl('.wf-custom', 'background')).toBe('var(--sheet-2)')
  })

  it('卡内字段是「标签在上、控件在下」，标签走 `--mute`', () => {
    expect(decl('.wf-field', 'flex-direction')).toBe('column')
    expect(decl('.wf-field .label', 'color')).toBe('var(--mute)')
  })
})

describe('F2 编排器：不新增颜色（全部走既有 token）', () => {
  it('新增规则里没有裸色值', () => {
    const rules = [
      '.wf-cols',
      '.wf-col-on',
      '.wf-callout',
      '.wf-prose-body',
      '.stage-cards',
      '.stage-card',
      '.stage-card-head',
      '.stage-card-head .spacer',
      '.stage-card-title',
      '.wf-field',
      '.wf-field .label',
      '.wf-custom',
      '.wf-preview',
    ]
    for (const sel of rules) {
      const rule = body(sel)
      expect(rule, sel).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(rule, sel).not.toMatch(/\brgba?\(/)
    }
  })
})
