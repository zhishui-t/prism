/**
 * F1（v11）库内选取器的**样式契约**。
 *
 * 锁三件事：
 *  1. **`.modal-md` 与 `.modal-lg` 是同一版式的两个上限**：头 / 内容 / 脚三段结构、`max-height`、
 *     `padding: 0` 两档一致，只有 `width` 不同——并且**两条规则各自成条**（不合并选择器）：
 *     `styles-role-modal.test.ts` 按字面 `\n.modal.modal-lg {` 定位规则体，合并会让那条断言
 *     静默变成「找不到规则」；
 *  2. **选取器的三件版式**：库列表自滚且有上限、选中行引线与 `.md-row` 同宽（3px）、
 *     手动添加区与 `.scope-callout` 同构（`--sheet-2` 底 + 左 3px `--warn` 引线）；
 *  3. **不新增颜色**：新增规则里没有裸色值，全部走既有 token（选中 `--buckram` / 未装 `--warn`）。
 *
 * 用「读文件 + 断言规则文本」而不是 `getComputedStyle`，理由同
 * `styles-role-modal.test.ts`：happy-dom 不解析外部样式表，计算样式探针是恒绿空断言。
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

describe('F1 选取器弹层：`.modal-md` 与 `.modal-lg` 同版式两上限', () => {
  it('中版与大连版的结构一致（列向 / 高度上限 / 面板自身不收内边距），只有 `width` 不同', () => {
    const md = body('.modal.modal-md')
    for (const shared of ['display: flex', 'flex-direction: column', 'max-height: 85vh', 'padding: 0']) {
      expect(md, '.modal-md 少了共享声明').toContain(shared)
      expect(body('.modal.modal-lg'), '.modal-lg 少了共享声明').toContain(shared)
    }
    // 两个上限：选取器与 560px 的表单抽屉同宽，读全文那条仍是 880px
    expect(md).toContain('width: min(560px, calc(100vw - var(--s-6)))')
    expect(body('.modal.modal-lg')).toContain('width: min(880px, calc(100vw - var(--s-6)))')
  })

  it('**两条规则各自成条**（不合并选择器）：合并会让 `.modal-lg` 的规则体断言静默失配', () => {
    // 字面形态就是契约：`\n.modal.modal-lg {` 与 `\n.modal.modal-md {` 都必须独立存在
    expect(BARE).toContain('\n.modal.modal-lg {')
    expect(BARE).toContain('\n.modal.modal-md {')
    expect(BARE).not.toMatch(/\n\.modal\.modal-lg\s*,/)
    expect(BARE).not.toMatch(/\n\.modal\.modal-md\s*,/)
  })

  it('中版的脚同款（常驻分隔线 + 内边距）：滚动时动作仍读得到', () => {
    expect(body('.modal.modal-md .modal-foot')).toContain('border-top: 1px solid var(--rule)')
    expect(decl('.modal.modal-md .modal-foot', 'padding')).toBe('var(--s-3) var(--s-4)')
  })
})

describe('F1 选取器内容：列表自滚 / 选中引线 / 手动区与 callout 同构', () => {
  it('库列表自己滚且有上限（内容区里唯一会长的一件，其余三件常驻）', () => {
    const rule = body('.pick-list')
    expect(rule).toContain('overflow-y: auto')
    expect(rule).toContain('max-height: 38vh')
  })

  it('库内一行：3px 透明左边线——选中换成 `--buckram`（与 `.md-row` / `.list-row` 同宽）', () => {
    expect(decl('.pick-row', 'border-left')).toBe('3px solid transparent')
    expect(decl('.pick-row.on', 'border-left-color')).toBe('var(--buckram)')
    // 长名不撑破弹层（与 `.skill-detail` 的行内兜底同款）
    expect(decl('.pick-row .pick-name', 'overflow-wrap')).toBe('anywhere')
  })

  it('手动添加区与 `.scope-callout` 同构：`--sheet-2` 底 + 左 3px `--warn` 引线', () => {
    expect(decl('.picker-manual', 'border-left')).toBe('3px solid var(--warn)')
    expect(decl('.picker-manual', 'background')).toBe('var(--sheet-2)')
  })

  it('未装 chip：`--warn` 边线 + `--warn` 文字（lamp 是既有 `.scope-lamp`，不新增色）', () => {
    expect(decl('.chip.missing', 'border-color')).toContain('var(--warn)')
    expect(decl('.chip-note', 'color')).toBe('var(--warn)')
  })
})

describe('F1 选取器：不新增颜色（全部走既有 token）', () => {
  it('新增规则里没有裸色值', () => {
    const rules = [
      '.modal.modal-md',
      '.modal.modal-md .modal-foot',
      '.picker-body',
      '.pick-list',
      '.pick-row',
      '.pick-row:hover',
      '.pick-row.on',
      '.picker-manual',
      '.chip',
      '.chip.missing',
      '.chip-note',
      '.chip button',
    ]
    for (const sel of rules) {
      const rule = body(sel)
      expect(rule, sel).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(rule, sel).not.toMatch(/\brgba?\(/)
    }
  })
})
