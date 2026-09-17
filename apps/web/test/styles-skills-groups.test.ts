/**
 * F7（技能分类分组 + 详情居中）的**样式契约**：文本级存在性 + 值锁。
 *
 * 与 `skills-groups-dom.test.ts`（happy-dom，管 DOM 结构）成对：这边管「规则写下来了没有、值对不对」。
 * 分开的理由是技术性的——happy-dom 环境里 `import.meta.url` 是 http URL，`fileURLToPath` 会抛，
 * 读不了 `styles.css`；且 happy-dom 不解析外部样式表，`getComputedStyle` 探针只会得到恒绿的空断言
 * （同 `styles-markdown-typography.test.ts` 头注）。
 *
 * 本文件锁四件事：
 *  1. **组头**——`.skill-group-head` 是 flex 的可点行（cursor 与 hover 底是它「能点」的信号），
 *     左 3px 透明边与 `.md-row` 同宽（组名与行名左对齐）；
 *  2. **chev 复用既有类**——`.toc-chev` 仍是**一条规则**覆盖两个挂载点（`.book-toc` / `.skill-group`），
 *     取值不复制（两个挂载点漂一处就红），展开态仍 `rotate(90deg)` + `--t-mid`；
 *  3. **详情居中**——`.skill-detail` 用 `.md-read` 的既有 66ch 口径 + `margin: 0 auto`；居中的单位是
 *     **详情整体**（`.md-read` 正文段自己**没有** margin），且它是 `.md-detail` 的**内层**包裹
 *     （滚动容器与左列表宽度都不动 = F3 契约不破）；
 *  4. **长串不撑破列宽**——列内 `min-width: 0` + `overflow-wrap: anywhere` 兜底；
 *     命令块 `.cmd` 保持自己的横滚（`white-space: nowrap` + `overflow-x: auto`）不折行；
 *  5. **v10 F4 层级**（本批）——组头字号升一档（`--fs-300`）、组内技能行缩进一档
 *     （`calc(var(--s-2) + var(--s-3))`）：两条都只动字号 / 内边距，取值全在既有 token 阶梯内。
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

describe('F7 组头：可点行（同知识库目录树的行口径）', () => {
  it('`.skill-group-head` 是 flex 行，左 3px 透明边与 `.md-row` 同宽（组名对齐行名）', () => {
    const rule = body('.skill-group-head')
    expect(rule).toContain('display: flex')
    expect(rule).toContain('border-left: 3px solid transparent')
    expect(decl('.md-row', 'border-left')).toBe('3px solid transparent')
    // 「能点」的视觉信号：指针 + hover 底（`.md-row:hover` 同款底）
    expect(decl('.skill-group-head', 'cursor')).toBe('pointer')
    expect(body('.skill-group-head:hover')).toContain('background: var(--sheet-2)')
  })

  it('组头不新增颜色 / 字号档（层级与状态都走既有 token）', () => {
    const rule = body('.skill-group-head')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rule).not.toMatch(/\brgba?\(/)
    expect(rule).not.toMatch(/font-size/)
  })

  it('chev 复用既有类：`.toc-chev` **只有一条规则体**覆盖两个挂载点（不复制取值）', () => {
    expect(BARE).toContain('\n.book-toc .toc-chev, .skill-group .toc-chev {')
    expect(BARE).toContain('\n.book-toc .toc-chev.open, .skill-group .toc-chev.open {')
    // 回归红线：`.skill-group .toc-chev` **不得**自己再成一条规则（那就是第二套口径）
    expect(BARE).not.toContain('\n.skill-group .toc-chev {')
    expect(decl('.book-toc .toc-chev, .skill-group .toc-chev', 'transition')).toBe(
      'transform var(--t-mid) var(--ease)',
    )
    expect(body('.book-toc .toc-chev.open, .skill-group .toc-chev.open')).toContain('transform: rotate(90deg)')
  })
})

describe('v10 F4 组头字号升一档 + 组内技能行缩进一档', () => {
  it('组头字号 `--fs-200` → `--fs-300`（仍在 `--fs` 阶梯内，不新增字号档）', () => {
    expect(decl('.skill-group-head .count-line.section', 'font-size')).toBe('var(--fs-300)')
    // 一档之差是相对**组内行名**说的：行名仍是 `--fs-200`（`.md-row .t`），两边不是并排同号
    expect(decl('.md-row .t', 'font-size')).toBe('var(--fs-200)')
  })

  it('组头其余声明不复制：`bare` 变体的弹性引线仍由 `.count-line.section.bare` 承担', () => {
    // 组头那条只覆盖字号——否则「组名 + 引线 + 计数」会在两处各写一份
    const rule = body('.skill-group-head .count-line.section')
    expect(rule).not.toContain('flex')
    expect(rule).not.toContain('margin')
    expect(decl('.count-line.section.bare', 'flex')).toBe('1')
  })

  it('组内缩进一档：`calc(var(--s-2) + var(--s-3))`（token 组合，不写死像素）', () => {
    // W-5：挂载点从 `.md-row`（行列表）换成 `.skill-grid`（卡片网格），**值一字未改**
    expect(decl('.skill-group .skill-grid', 'padding-left')).toBe('calc(var(--s-2) + var(--s-3))')
    // 只加在组内：裸 `.md-row`（知识库等页共用）的口径一字未动
    expect(decl('.md-row', 'padding')).toBe('var(--s-2) var(--s-2)')
    // 组头自身左内边距不动 ⇒ 组名与组内内容之间正好差一档（--s-3）
    expect(decl('.skill-group-head', 'padding')).toBe('var(--s-1) var(--s-2)')
  })

  it('缩进不靠颜色表达（组内卡片仍复用 `.role-card` 的既有字色）', () => {
    const rule = body('.skill-group .skill-grid')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rule).not.toMatch(/\brgba?\(/)
    expect(rule).not.toMatch(/color/)
  })
})

describe('F7 详情居中：居中的单位是详情整体', () => {
  it('`.skill-detail` 放宽为 min(75rem, 100%) + `margin: 0 auto`（2026-09-17 用户反馈：66ch 在宽屏只剩中间一小条）', () => {
    expect(decl('.skill-detail', 'max-width')).toBe('min(75rem, 100%)')
    expect(decl('.skill-detail', 'margin')).toBe('0 auto')
    // 「同口径」是可验证的：技能/角色详情取同一个值；知识库阅读度量 `.md-read` 仍保持 66ch（长文阅读页）
    expect(decl('.skill-detail', 'max-width')).toBe(decl('.role-detail', 'max-width'))
    expect(decl('.md-read', 'max-width')).toBe('66ch')
  })

  it('正文段自己**没有**居中（居中是详情整体，不是正文段——否则命令块与 scope 会左贴）', () => {
    expect(body('.md-read')).not.toMatch(/(^|;|\s)margin/)
  })

  it('W-5：滚动的换成弹窗的内容区（`.modal-content`），居中列仍是它的**内层**包裹', () => {
    const content = body('.modal-content')
    expect(content).toContain('overflow-y: auto')
    expect(content).toContain('min-height: 0')
    // 详情内的横向滚动容器只滚 X 轴，不与这里的 Y 轴嵌套成双滚动条
    expect(body('.md-source')).toContain('overflow-x: auto')
    // `.md-detail` 规则按「不删覆盖」保留（通用详情栏定义，当前无挂载点）
    expect(body('.md-detail')).toContain('overflow-y: auto')
  })

  it('不影响左列表宽度（`.md` 网格与 `.md-list` 的滚动口径一字未动）', () => {
    const md = body('.md')
    expect(md).toContain('grid-template-columns: minmax(220px, 300px) minmax(0, 1fr)')
    expect(md).not.toMatch(/height:\s*calc\(/)
    expect(body('.md-list')).toContain('overflow-y: auto')
  })
})

describe('v12 F4（W-5）组内卡片网格：与角色页**共用一条**网格定义', () => {
  it('`.role-grid` 与 `.skill-grid` 是同一条规则（两个挂载点、取值不复制）', () => {
    // 组选择器写法：只加选择器不复制取值 ⇒ 两页的网格永远不会漂
    expect(BARE).toContain('\n.role-grid, .skill-grid {')
    expect(decl('.role-grid, .skill-grid', 'display')).toBe('grid')
    expect(decl('.role-grid, .skill-grid', 'grid-template-columns')).toBe(
      'repeat(auto-fill, minmax(300px, 1fr))',
    )
    expect(decl('.role-grid, .skill-grid', 'gap')).toBe('var(--s-3)')
    // 回归红线：`.skill-grid` **不得**自己再成一条规则（那就是第二套网格口径）
    expect(BARE).not.toContain('\n.skill-grid {')
  })

  it('网格只用既有 token：间距取 `--s-3`，无颜色 / 无字号 / 无写死像素', () => {
    const rule = body('.role-grid, .skill-grid')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rule).not.toMatch(/\brgba?\(/)
    expect(rule).not.toMatch(/color\s*:/)
    expect(rule).not.toMatch(/font-size/)
    // 唯一的字面量是 `300px` 的列宽下限（与角色页同一取值，非本批新增）
    expect(rule.replace(/repeat\(auto-fill, minmax\(300px, 1fr\)\)/, '')).not.toMatch(/\d+px/)
  })

  it('卡片版式仍是既有 `.role-card` 一套（`<NavRow variant="card">`，不新造卡片类）', () => {
    // 竖排卡片只有一处定义（交互契约 `.nav-row` + 版式 `.role-card`），本批零新增
    expect(decl('.role-card', 'border-radius')).toBe('var(--r-2)')
    expect(decl('.role-card', 'border')).toBe('1px solid var(--rule)')
    expect(decl('.role-card', 'padding')).toBe('var(--s-4)')
    // 卡片内容复用的是既有共用品（无 `.role-card` 前缀的两条在右上「卡面/详情同构」一段锁着）
    expect(decl('.role-card .role-name', 'font-size')).toBe('var(--fs-500)')
    expect(body('.role-card .role-dot')).toContain('border-radius: 50%')
  })
})

describe('F7 折行长串不撑破居中列', () => {
  it('列内 `min-width: 0` + `overflow-wrap: anywhere`（无空格可断时的兜底断点）', () => {
    expect(decl('.skill-detail', 'min-width')).toBe('0')
    expect(decl('.skill-detail', 'overflow-wrap')).toBe('anywhere')
  })

  it('命令块保持自己的横滚（不折行、也不把列撑宽）', () => {
    const cmd = body('.cmd')
    expect(cmd).toContain('overflow-x: auto')
    expect(cmd).toContain('white-space: nowrap')
    expect(cmd).toContain('min-width: 12.5rem')
  })
})

describe('v12 F4（W-6）分类管理：组头动作区 + 就地表单', () => {
  it('组头一行 = 切换（吃满剩余宽度）+ 动作（不压缩）；切换节点自身的既有口径一字未动', () => {
    expect(decl('.skill-group-bar', 'display')).toBe('flex')
    // 切换节点靠外层 flex 行吃满 ⇒ 引线仍能撑到动作区左缘；`min-width: 0` 让长组名先让位
    expect(decl('.skill-group-bar .skill-group-head', 'flex')).toBe('1')
    expect(decl('.skill-group-bar .skill-group-head', 'min-width')).toBe('0')
    expect(decl('.skill-group-actions', 'flex-shrink')).toBe('0')
    // 既有那几条（可点行的视觉信号）不动
    expect(decl('.skill-group-head', 'padding')).toBe('var(--s-1) var(--s-2)')
    expect(decl('.skill-group-head', 'cursor')).toBe('pointer')
    expect(decl('.skill-group-head', 'border-left')).toBe('3px solid transparent')
    // 回归红线：动作按钮复用 `.tool-btn`，不得自成一套按钮样式
    expect(BARE).not.toContain('\n.skill-group-actions button {')
  })

  it('新建 / 改名**共用一条**就地表单排版（两处挂载点不各写一套）', () => {
    expect(decl('.skill-cat-form', 'display')).toBe('flex')
    expect(decl('.skill-cat-form .skill-cat-input', 'min-width')).toBe('12.5rem')
    expect(decl('.skill-cat-form .skill-cat-input', 'flex')).toBe('0 1 320px')
    // 改名表单不另立规则（它只是同一套表单的第二处挂载点）
    expect(BARE).not.toContain('\n.skill-group-rename {')
  })

  it('空分类组的空态吃满网格整行；不新增颜色 / 字号', () => {
    expect(decl('.skill-group-empty', 'grid-column')).toBe('1 / -1')
    expect(decl('.skill-group-empty', 'margin')).toBe('0')
    const rule = body('.skill-group-empty')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rule).not.toMatch(/\brgba?\(/)
    expect(rule).not.toMatch(/color/)
    expect(rule).not.toMatch(/font-size/)
  })
})

describe('v12 F4（W-7）拖拽归类：拖起态 + 落点高亮都用既有 token', () => {
  it('拖起态只降透明度（`opacity`，不是颜色）', () => {
    expect(decl('.role-card.dragging', 'opacity')).toBe('0.5')
    const rule = body('.role-card.dragging')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rule).not.toMatch(/\brgba?\(/)
    expect(rule).not.toMatch(/color/)
  })

  it('落点高亮 = `--buckram` 的虚线外框（与选中引线同一语义色，不新造颜色）', () => {
    expect(decl('.skill-group.drop-target', 'outline')).toBe('1px dashed var(--buckram)')
    expect(decl('.skill-group.drop-target', 'outline-offset')).toBe('-1px')
    const rule = body('.skill-group.drop-target')
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rule).not.toMatch(/\brgba?\(/)
  })

  it('键盘下拉只补宽度（控件外观走全站表单基类，不新造控件样式）', () => {
    expect(decl('.skill-cat-select', 'min-width')).toBe('12.5rem')
    // 与既有过滤框同一取值（同档宽度，不新增第三条宽度口径）
    expect(decl('.role-filter', 'min-width')).toBe('12.5rem')
  })

  it('reduced-motion：文件末尾通配块**覆盖到**新加的拖拽类（`*` 通配 ⇒ 任何过渡/动画都归零）', () => {
    // 本批未给拖拽类写过渡；断言通配块仍在且是 `*` 全选（不是逐类列举——列举会漏新类）
    const at = BARE.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(at).toBeGreaterThan(-1)
    const block = BARE.slice(at)
    expect(block).toContain('*::before')
    expect(block).toContain('*::after')
    expect(block).toContain('transition-duration: 0.01ms !important')
    expect(block).toContain('animation-duration: 0.01ms !important')
  })
})
