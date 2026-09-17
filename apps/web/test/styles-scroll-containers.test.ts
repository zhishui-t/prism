/**
 * F3 长列表页双栏独立滚动契约：**文本级**存在性 + 值锁。
 *
 * 口径（task-brief-v8 F3 / design-v8 §6.3）：知识库页 / 技能页 / 团队页的左右两栏
 * **各自在视口内独立滚动**，整页不再长滚。
 *
 * 用「读文件 + 断言规则文本」而不是 `getComputedStyle`，理由同
 * `styles-markdown-typography.test.ts`：happy-dom 不解析外部样式表（`styles.css` 由
 * Vite 注入，测试里根本没有样式表），计算样式探针会得到恒绿的空断言。
 *
 * 本文件锁三件事：
 *  1. **高度链**——`.layout` → `.main` → `.page` → `.page-fill` → 主从区，每一环都得在；
 *  2. **列表栏自己 overflow-y**——知识库是 `.book-sidebar` / `.book-content`，
 *     技能页与团队页是 `.md-list`（两页的详情自 W-4/W-5 起都迁入弹窗，主从网格只剩单列）；
 *  3. **不回退**——`.book-layout` 的 `min-height: 100%`、`.md` 的 `height: calc(…)`
 *     是 F3 前的「整页长滚」成因，必须保持缺席（这两条是回归红线）。
 *
 * 另：横滚容器（代码块 / 表格 / 源码 / 流程条）只许滚 X 轴——同时声明 `overflow-y`
 * 会在右详情里叠出第二条竖向滚动条（嵌套双滚动条）。
 *
 * 环境：默认 node（不写环境 pragma，同 styles-markdown-typography.test.ts 的头注）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const CSS = read('../src/styles.css')

/** 去注释：注释里写着「原来是 X、现在改 Y」之类的说明，不剥掉会被下面的断言误伤。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 某条规则的规则体（选择器按字面匹配，须与 styles.css 里写法逐字一致；从**行首**起匹配）。 */
function body(selector: string): string {
  const at = BARE.indexOf(`\n${selector} {`)
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1)
  const open = BARE.indexOf('{', at)
  return BARE.slice(open + 1, BARE.indexOf('}', open))
}

describe('F3 高度链（视口 → 页 → 页内容区）', () => {
  it('根：`.layout` 是满视口网格，`.main` 只分配高度、自身不滚', () => {
    expect(body('.layout')).toContain('height: 100vh')
    const main = body('.main')
    expect(main).toContain('min-height: 0')
    expect(main).toContain('min-width: 0')
    // `.main` 不滚：滚动交给 `.page`（页面区）或页内的两栏
    expect(main).toContain('overflow: hidden')
  })

  it('`.page` 是 border-box 的 `height: 100%`（内容盒 = 视口 − 顶栏 − 页内边距）', () => {
    const page = body('.page')
    expect(page).toContain('height: 100%')
    expect(page).toContain('min-height: 0')
    // 保留竖向滚动作**小视口的兜底出口**：F3 之后主从区是弹性子项（`flex: 1 1 auto`
    // + `min-height: 0`），不会被内容顶高，故这条实际不会触发。
    expect(page).toContain('overflow-y: auto')
  })

  it('`.page-fill` 是列向弹性盒，吃满 `.page` 的内容盒（不需要 `100vh − …` 人工减法）', () => {
    const fill = body('.page-fill')
    expect(fill).toContain('display: flex')
    expect(fill).toContain('flex-direction: column')
    // 两者都在场：`height: 100%` 取高度，`min-height: 0` 允许被小视口压扁
    expect(fill).toContain('height: 100%')
    expect(fill).toContain('min-height: 0')

    // 注释里解释过「不用减法」；这里反向锁死：不得出现 vh 减法
    expect(fill).not.toMatch(/height:\s*calc\([^)]*vh/)
  })

  it('页头 / 作用域头 / 提示条按内容占高，不吃主从区的滚动高度', () => {
    const at = BARE.indexOf('.page-fill > .page-head')
    expect(at, 'styles.css 里找不到 .page-fill 的页头组规则').toBeGreaterThan(-1)
    const group = BARE.slice(at, BARE.indexOf('}', at))
    for (const sel of ['.page-fill > .page-head', '.page-fill > .scope-head', '.page-fill > .banner']) {
      expect(group, sel).toContain(sel)
    }
    expect(group).toContain('flex: 0 0 auto')
  })
})

describe('F3 知识库页两栏（书架：目录树 / 书页）', () => {
  it('`.book-layout` 是 `.page-fill` 的剩余高度子项（不是 `min-height: 100%`）', () => {
    const layout = body('.book-layout')
    expect(layout).toContain('flex: 1 1 auto')
    expect(layout).toContain('min-height: 0')
    // 回归红线：`min-height: 100%` 会把高出视口的那部分高度推给 `.page` 去滚 = 整页长滚
    expect(layout).not.toContain('min-height: 100%')
  })

  it('侧栏（目录树）与书页**各自**竖向滚动', () => {
    expect(body('.book-sidebar')).toContain('overflow-y: auto')
    expect(body('.book-content')).toContain('overflow-y: auto')
  })

  it('侧栏宽度固定且不参与收缩（两栏不会互相挤扁）', () => {
    const side = body('.book-sidebar')
    expect(side).toContain('flex-shrink: 0')
    // 书页是吃剩余宽度的那个
    expect(body('.book-content')).toContain('flex: 1')
  })
})

describe('F3 技能页 / 团队页列表栏（主从网格的单列形态）', () => {
  it('`.md` 是两列栅格 + `stretch`：两栏由同一行轨道定高 ⇒ 天然等高、对齐视口', () => {
    const md = body('.md')
    expect(md).toContain('display: grid')
    expect(md).toContain('minmax(220px, 300px)')
    expect(md).toContain('align-items: stretch')
    expect(md).toContain('flex: 1 1 auto')
    expect(md).toContain('min-height: 0')
    // 回归红线：F3 前是固定高 `calc(100% − var(--s-7))`（按页头预留 48px 的减法），
    // 技能页多一条 `.scope-head`、团队页多提示条 ⇒ 逐页各算一个值必然失准
    expect(md).not.toMatch(/height:\s*calc\(/)
  })

  it('W-4/W-5：`.md.solo` 单列铺满——技能页与团队页详情迁入弹窗后只剩列表（高度链由 `.md` 基类继承）', () => {
    // 只改列定义，不动基类的 flex / min-height / stretch（两页仍靠它们吃满 `.page-fill`）
    expect(body('.md.solo')).toContain('grid-template-columns: minmax(0, 1fr)')
  })

  it('左列表 `overflow-y: auto` 且不超出本行高（`max-height: 100%`）', () => {
    const list = body('.md-list')
    expect(list).toContain('overflow-y: auto')
    expect(list).toContain('max-height: 100%')
  })

  it('右详情栏规则仍在（`.md-detail`，当前无挂载点：技能页 W-5 / 团队页 W-4 均已迁入弹窗）', () => {
    const detail = body('.md-detail')
    expect(detail).toContain('overflow-y: auto')
    expect(detail).toContain('min-height: 0')
    expect(detail).toContain('min-width: 0')
  })

  it('两栏滚动是**并列**的：左右各一个竖向滚动容器，不是右详情里再套一个', () => {
    // `.md` 自身不滚（滚的是两个子项）
    expect(body('.md')).not.toMatch(/overflow(-y)?\s*:\s*(auto|scroll)/)
  })
})

describe('F3 无嵌套双滚动条（横滚容器只许滚 X 轴）', () => {
  const HSCROLL = ['.md-read .md-pre', '.md-read .md-table-wrap', '.md-source', '.flow-scroll', '.table-scroll']

  it.each(HSCROLL)('%s 只声明 `overflow-x: auto`，不声明竖向滚动', (sel) => {
    const re = new RegExp(`${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`)
    const m = re.exec(BARE)
    expect(m, `styles.css 里找不到规则 ${sel} { … }`).not.toBeNull()
    expect(m![1], sel).toContain('overflow-x: auto')
    expect(m![1], sel).not.toMatch(/overflow-y\s*:\s*(auto|scroll)/)
  })
})

describe('F3 三页接线（源码级存在性：容器被真的挂上了）', () => {
  const PAGES: ReadonlyArray<[string, string, readonly string[]]> = [
    ['知识库', '../src/pages/Knowledge.tsx', ['page-fill', 'book-layout', 'book-sidebar', 'book-content']],
    ['技能', '../src/pages/Skills.tsx', ['page-fill', 'md-list', 'md solo']],
    /* W-4：团队详情迁入弹窗 ⇒ 团队页不再是「列表 ∥ 详情」两栏，只剩单列列表（`.md.solo`）。 */
    ['团队', '../src/pages/teams/TeamsPage.tsx', ['page-fill', 'md-list', 'md solo']],
  ]

  it.each(PAGES)('%s 页挂了 `.page-fill` 与两栏容器', (_label, rel, classes) => {
    const src = read(rel)
    for (const cls of classes) {
      expect(src, `${rel} 缺 className="${cls}"`).toContain(`className="${cls}"`)
    }
  })

  /** 每页的两栏容器（`.page-fill` 必须包着它——空态 / 加载态也走同一套高度链）。 */
  const COLUMN: ReadonlyArray<[string, string, string]> = [
    ['知识库', '../src/pages/Knowledge.tsx', 'book-layout'],
    ['技能', '../src/pages/Skills.tsx', 'md-list'],
    ['团队', '../src/pages/teams/TeamsPage.tsx', 'md-list'],
  ]

  it.each(COLUMN)('%s 页 `.page-fill` 是两栏容器的外层', (_label, rel, col) => {
    const src = read(rel)
    const fill = src.indexOf('className="page-fill"')
    const inner = src.indexOf(`className="${col}"`)
    expect(fill, `${rel} 找不到 .page-fill`).toBeGreaterThan(-1)
    expect(inner, `${rel} 找不到 .${col}`).toBeGreaterThan(-1)
    // 包裹关系：`.page-fill` 先出现（外层），两栏容器在其后（内层）
    expect(fill).toBeLessThan(inner)
  })
})
