/**
 * v10 F2 角色详情：**居中模态**（`<Modal>` + `.modal-lg`）的样式契约。
 *
 * 用户原话「侧边栏改成居中弹窗吧，侧边栏好难受」——详情从 `.drawer`（右侧、整屏高）
 * 搬到 `.modal.modal-lg`（居中、有高度上限）。本文件锁三件事：
 *  1. **大版与确认框分工**：`.modal-lg` 只加尺寸与滚动结构，`.modal-mask` / `.modal`
 *     （遮罩 / 面板 / 进场动画）与 K12 的 420px 确认框一笔不动；
 *  2. **内容区自滚**：面板 `max-height` 有上限 + 内容区 `overflow-y: auto`——长正文
 *     撑不破视口（`.drawer` 那时有整屏高，居中版式必须自己给上限）；
 *  3. **正文区与信息区的分割**：`.role-body` 实色 hairline + 间距档（与
 *     `styles-role-hierarchy.test.ts` 的分割断言同源，此处补模态侧的尺寸口径）。
 *
 * 用「读文件 + 断言规则文本」而不是 `getComputedStyle`，理由同
 * `styles-markdown-typography.test.ts`：happy-dom 不解析外部样式表，计算样式探针是恒绿空断言。
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

describe('v10 F2 居中模态的大版（`.modal-lg`）', () => {
  it('面板是列向弹性盒 + 有**高度上限**（居中版式不能像抽屉那样吃满屏高）', () => {
    const rule = body('.modal.modal-lg')
    expect(rule).toContain('display: flex')
    expect(rule).toContain('flex-direction: column')
    expect(rule).toContain('max-height: 85vh')
    // 尺寸：撑住「一条定义的全文」，窄屏回落 `100vw − --s-6`
    expect(rule).toContain('width: min(880px, calc(100vw - var(--s-6)))')
    // 面板自身不收内边距（头 / 内容 / 脚各自给），否则脚上的上边框会内缩
    expect(rule).toContain('padding: 0')
  })

  it('内容区吃剩余高度并**自滚**（长正文不把面板顶出视口）', () => {
    const rule = body('.modal-content')
    expect(rule).toContain('flex: 1')
    expect(rule).toContain('min-height: 0')
    expect(rule).toContain('overflow-y: auto')
  })

  it('头 / 脚常驻：都有与面板同色的 1px 分隔线（滚动时读得到标题与动作）', () => {
    expect(body('.modal-head')).toContain('border-bottom: 1px solid var(--rule)')
    expect(body('.modal.modal-lg .modal-foot')).toContain('border-top: 1px solid var(--rule)')
    expect(decl('.modal-head h3', 'font-size')).toBe('var(--fs-500)')
    // 与抽屉标题同档（两种浮层版式的标题是同一层级）
    expect(decl('.drawer-head h3', 'font-size')).toBe('var(--fs-500)')
  })

  it('确认框口径不回归：`.modal` 仍是 420px 的窄版、正文仍 `pre-line`、动画仍是模态淡入', () => {
    const rule = body('.modal')
    expect(rule).toContain('width: min(420px, calc(100vw - var(--s-6)))')
    expect(rule).toContain('animation: prism-modal-in var(--t-mid) var(--ease)')
    expect(body('.modal-body')).toContain('white-space: pre-line')
    // 遮罩仍是浮层栈那一套（Esc / 圈闭在 `.modal-mask` 的组件侧）
    expect(body('.modal-mask')).toContain('animation: prism-scrim-in var(--t-fast) var(--ease)')
  })

  it('不新增颜色：`.modal-lg` / `.modal-head` / `.modal-content` 里没有裸色值', () => {
    for (const sel of ['.modal.modal-lg', '.modal-head', '.modal-content']) {
      const rule = body(sel)
      expect(rule, sel).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(rule, sel).not.toMatch(/\brgba?\(/)
    }
  })
})

describe('v10 F2 正文区（`.role-body`）：Markdown 正文 + 与信息区的实色分割', () => {
  it('正文区与信息区之间是实色 hairline + 间距档（不是虚线引线，也不是纯留白）', () => {
    const rule = body('.role-body')
    expect(rule).toContain('border-top: 1px solid var(--rule)')
    expect(rule).toContain('margin-top: var(--s-5)')
    expect(rule).toContain('padding-top: var(--s-4)')
  })

  it('正文用**正文档度量的既有类**（`.md-body` 由渲染器自带、`.md-read` 是阅读档），不另起一套', () => {
    // 样式侧的证据：`.md-body` 不是栅格（A4 的坑），`.md-read` 才是阅读度量
    const md = body('.md-read')
    expect(md).toContain('max-width: 66ch')
    expect(md).toContain('font-family: var(--font-read)')
    expect(md).toContain('font-size: var(--fs-read)')
    // `.role-body` 自己**不**写字号：正文的字号归 `.md-read`，避免两处口径打架
    expect(body('.role-body')).not.toContain('font-size')
  })

  it('正文区不再是折叠带（无 `> summary` 规则）——「md 要渲染」的正文不该默认藏着', () => {
    expect(BARE).not.toMatch(/\n\.role-body > summary/)
  })
})
