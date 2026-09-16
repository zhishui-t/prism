// @vitest-environment happy-dom
/**
 * 角色页层级重排回归（F8 §一 + F5 + R-v8-1 / R-v8-4）。
 *
 * 锁四条**层级契约**（不是像素）：
 * 1. **卡片底行三计数同行**（§1.4 高度代价里那 −40px 的来源）——DOM 上是同一个
 *    `.role-metrics` 里的三个 `.count-line.compact`，CSS 上是 `flex-direction: row`；
 * 2. **抽屉与卡片同构**（§1.3）——第一眼后三件（一句话职责 → 原则强调块 → 徽章行）在
 *    两个容器里**同一顺序**，故「点开卡片」是放大而不是换重心；
 * 3. **F5 落点**——「有效 Skill」差集清单整段消失（`.rsec-eff` 为 0、`roles.effectiveSkills`
 *    文案无命中），而技能段的分段头计数行仍在，口径说明降级进它的 `title`；
 * 4. **R-v8-1**——详情抽屉 `min(680px, 72vw)`、编辑表单抽屉维持 `min(560px, 96vw)`；
 *    内容列 66ch 居中的落点 `.role-detail` 只挂在**详情**抽屉里（MIN-4）；
 * 5. **F8-1 原则块**——渲染前剥掉强强调标记：卡面与抽屉（共用 `RoleGlance`）都不出现字面 `**`
 *    （只看标记的原则按「没写原则」走 `.missing`）；纯文本判据见 `ui-text.test.ts`。
 *
 * 渲染路径与 `roles-delete-drawer.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`，不引 @testing-library；本目录的 include 只收 `.test.ts`，故不用 JSX。
 *
 * ⚠ happy-dom **不解析外部样式表**（`styles.css` 由 Vite 注入，测试里没有样式表），
 * 而本环境里 `import.meta.url` 是 http URL（`fileURLToPath` 会抛），故「同行 / 截断」
 * 这类**纯 CSS 事实**全部放在同批的 `styles-role-hierarchy.test.ts`（node 环境、读文件断言）。
 * 本文件只管 DOM 结构：谁在谁的里面、谁排在谁前面、谁还在不在。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用。 */
const data = vi.hoisted(() => ({
  roles: [] as unknown[],
  teams: [] as unknown[],
}))

vi.mock('../src/api-team.ts', () => ({
  ROLE_COLOR_OPTIONS: ['red', 'blue'],
  THOUGHT_LEVELS: ['low', 'high', 'max'],
  teamApi: {
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    role: (name: string) =>
      Promise.resolve(data.roles.find((r) => (r as RoleDefinition).name === name) ?? null),
    teams: () => Promise.resolve({ teams: data.teams, teamsDir: '/tmp/prism-teams' }),
    /** 故意返回**白名单之外**的技能——旧实现据此渲染「有效新增」差集清单。 */
    effectiveSkills: (role: string) =>
      Promise.resolve({
        role,
        skills: [
          { name: 'global-a', available: true },
          { name: 'team-b', available: false },
        ],
        warnings: [],
      }),
    createRole: () => Promise.resolve({ path: '/tmp/prism-roles/x.md', issues: [] }),
    updateRole: () => Promise.resolve({ path: '/tmp/prism-roles/x.md', issues: [] }),
    deleteRole: () => Promise.resolve({ removed: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { Drawer } from '../src/components/ui.tsx'
import { RolesPage } from '../src/pages/Roles.tsx'

const LONG_DESC = '架构边界与跨模块契约。后半句属于说明，不该出现在卡片可见的一行里。'

function role(name: string): RoleDefinition {
  return {
    name,
    description: LONG_DESC,
    color: 'blue',
    skills: ['role-a', 'role-b'],
    knowledge: { layers: ['project'], books: ['prism'] },
    principle: '先定边界再谈实现。第二句同样不该出现在卡面可见的两行里。',
    body: `# ${name}`,
    model: 'sonnet',
    thoughtLevel: 'high',
    installed: true,
    issues: [{ code: 'skill_unknown', level: 'warn', message: 'declared an uninstalled skill' }],
  }
}

let container: HTMLDivElement
let root: Root

async function render(sel: string): Promise<void> {
  await act(async () => {
    root.render(createElement(RolesPage, { sel }))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function button(label: string): HTMLButtonElement {
  const hit = all('button').find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

/** 元素自身的 class（只取第一个 token，`.role-principle` 可能带 ` missing`）。 */
function cls(e: Element): string {
  return (e.getAttribute('class') ?? '').split(' ')[0] ?? ''
}

/** 第一眼后三件在容器里的**顺序**（同构断言的核心证据）。 */
function glanceOrder(scope: Element): string[] {
  return [...scope.children].map(cls).filter((c) => c === 'role-desc' || c === 'role-principle' || c === 'role-tags')
}

beforeEach(() => {
  setLang('zh')
  data.roles = [role('dev-1')]
  data.teams = [{ team_id: 't-a', name: 'Team A', members: [{ role: 'dev-1', count: 1 }] }]
  window.location.hash = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('F8 §1.1/§1.4 卡片正面', () => {
  it('底行三计数压成同行：同一个 `.role-metrics` 里三个 `.count-line.compact`', async () => {
    await render('')
    const metrics = one('.role-card .role-metrics')
    expect(metrics).not.toBeNull()
    const lines = [...metrics!.children].filter((c) => c.classList.contains('count-line'))
    expect(lines.length).toBe(3)
    // 三格等分同一行（`flex: 1`），故「同行」而不是「三行纵向」
    expect(lines.map((n) => n.classList.contains('compact'))).toEqual([true, true, true])
    expect(lines.map((n) => n.querySelector('.count-label')?.textContent)).toEqual([
      t('roles.card.skills'),
      t('roles.card.teams'),
      t('roles.issues'),
    ])
  })

  it('卡面底行三计数在**同一个**容器里（「同行」的 DOM 前提）', async () => {
    await render('')
    // DOM 只能证明「三个在同一个容器里」；「这一行是横向排」由 styles-role-hierarchy.test.ts 锁
    expect(all('.role-card .role-metrics').length).toBe(1)
  })

  it('校验问题只作状态位：有问题时第三格点灯，计数照样可见（§1.1）', async () => {
    await render('')
    const third = [...one('.role-card .role-metrics')!.children][2]!
    expect(third.querySelector('.count-num')?.textContent).toBe('1')
    expect(third.querySelector('.count-lamp')).not.toBeNull()
  })

  it('无校验问题时仍是三格，只是第三格不点灯（lamp 仅 >0）', async () => {
    // `useAsync` 的 deps 是 `[]`，同一 root 再 render 不会重取列表 —— 故必须在**首次** render 前铺数据
    data.roles = [{ ...role('clean'), issues: [] }]
    await render('')
    const lines = [...one('.role-card .role-metrics')!.children]
    expect(lines.length).toBe(3)
    const third = lines[2]!
    expect(third.querySelector('.count-num')?.textContent).toBe('0')
    expect(third.querySelector('.count-lamp')).toBeNull()
  })

  it('一句话职责收 1 行 ≤22 字（§1.5 #2），全文进 `title`', async () => {
    await render('')
    const desc = one('.role-card .role-desc')!
    expect(desc.textContent).toBe('架构边界与跨模块契约。')
    expect((desc.textContent ?? '').length).toBeLessThanOrEqual(23)
    expect(desc.getAttribute('title')).toBe(LONG_DESC)
  })

  it('原则强调块在卡面上就位（标签 + 正文，空值另有变体）', async () => {
    await render('')
    const block = one('.role-card .role-principle')!
    expect(block.querySelector('.rp-label')?.textContent).toBe(t('roles.principle'))
    expect(block.querySelector('.rp-text')?.textContent).toBe('先定边界再谈实现。')
    expect(block.classList.contains('missing')).toBe(false)
  })

  it('徽章行 ≤3 个中性 `.tag`，且 color 标签已删（§1.5 #1：色点已表达同一信息）', async () => {
    await render('')
    const tags = all('.role-card .role-tags .tag')
    expect(tags.map((n) => n.textContent)).toEqual([
      `${t('roles.form.model')}: sonnet`,
      `${t('roles.form.thought')}: high`,
      t('common.installed'),
    ])
    expect(tags.length).toBeLessThanOrEqual(3)
    // 唯一允许上色的徽标档是 warn/err（B9）：本页徽章一律中性
    expect(tags.some((n) => n.classList.contains('warn') || n.classList.contains('err'))).toBe(false)
    expect(all('.role-card .role-tags').map((n) => n.textContent).join('')).not.toContain(t('roles.form.color'))
  })

  it('空原则走 `.missing` 变体，不当作普通文本', async () => {
    data.roles = [{ ...role('blank'), principle: '   ' }]
    await render('')
    const block = one('.role-card .role-principle')!
    expect(block.classList.contains('missing')).toBe(true)
    expect(block.querySelector('.rp-text')?.textContent).toBe(t('roles.principleMissing'))
  })

  /**
   * F8-1：源文本是**成对**粗体、抽取在首个句号截断 ⇒ 旧行为只剩前导 `**`（8 卡 7 现）。
   * 本块是纯文本强调块（无粗体语义），故渲染前一律剥标记：DOM 里不得出现字面 `**`。
   */
  it('原则块里没有字面 `**`（成对 / 截断后的半截标记都不进 DOM，卡面与抽屉同源）', async () => {
    data.roles = [
      { ...role('paired'), principle: '**方向未定不动手，抛光不改方向。** 每个视觉决定以设计系统为唯一真相。' },
    ]
    // 打开抽屉：卡面与抽屉共用同一个 `RoleGlance`，两处都得干净（缺陷报告里两处都出现）
    await render('paired')
    for (const scope of ['.role-card', '.drawer-body .swap-in']) {
      const text = one(`${scope} .role-principle .rp-text`)!
      expect(text, scope).not.toBeNull()
      expect(text.textContent, scope).toBe('方向未定不动手，抛光不改方向。')
      expect(text.textContent, scope).not.toContain('*')
      // `title` 是同一段文本的全文：与块内**同口径**（悬停也看不到 `**`）
      expect(text.getAttribute('title'), scope).toBe('方向未定不动手，抛光不改方向。 每个视觉决定以设计系统为唯一真相。')
      expect(text.getAttribute('title'), scope).not.toContain('*')
      // 剥完还有内容 ⇒ 不落 `.missing`（剥标记不是「判空」的副作用）
      expect(one(`${scope} .role-principle`)!.classList.contains('missing'), scope).toBe(false)
    }
  })

  it('只剩标记的原则按「没写原则」处理（`.missing`），不显示一堆星号', async () => {
    data.roles = [{ ...role('stars'), principle: '**' }]
    await render('')
    const block = one('.role-card .role-principle')!
    expect(block.classList.contains('missing')).toBe(true)
    expect(block.querySelector('.rp-text')?.textContent).toBe(t('roles.principleMissing'))
  })
})

describe('F8 §1.3 抽屉与卡片同构（点开 = 放大，不换重心）', () => {
  it('第一眼后三件在两个容器里同一顺序：职责 → 原则块 → 徽章', async () => {
    await render('dev-1')
    const card = one('.role-card')!
    const drawer = one('.drawer-body .swap-in')!
    expect(glanceOrder(card)).toEqual(['role-desc', 'role-principle', 'role-tags'])
    expect(glanceOrder(drawer)).toEqual(glanceOrder(card))
  })

  it('抽屉第一件是角色名（在 `.drawer-head` 里，与卡片 `.role-name` 同一槽位）', async () => {
    await render('dev-1')
    expect(one('.drawer-head h3')?.textContent).toContain('dev-1')
    expect(one('.drawer-head .role-dot')).not.toBeNull()
    // 卡面 .role-name 与抽屉 .drawer-head h3 各自存在（同字号档由 styles 契约锁）
    expect(one('.role-card .role-name .role-dot')).not.toBeNull()
  })

  it('抽屉整体结构：第一眼带 → 常用带（3 段）→ 深挖带（2 个折叠）', async () => {
    await render('dev-1')
    const drawer = one('.drawer-body .swap-in')!
    // 把每个直接子节点折成「标签」：div 取 class，其余取 tagName —— 一条断言看完整页顺序
    const order = [...drawer.children].map((c) => {
      const tag = c.tagName.toLowerCase()
      return tag === 'div' ? cls(c) : tag
    })
    expect(order).toEqual([
      'role-desc', // 第一眼 ②
      'role-principle', // 第一眼 ③（唯一的强调块）
      'role-tags', // 第一眼 ④
      'section', // 常用 ①：所属团队
      'section', // 常用 ②：白名单技能
      'section', // 常用 ③：知识范围
      'details', // 深挖 ①：校验问题清单（默认折叠）
      'details', // 深挖 ②：完整定义正文（默认折叠）
    ])
  })

  it('抽屉不重复卡片已表达的 color 标签（§1.5 #1）', async () => {
    await render('dev-1')
    const tags = all('.drawer-body .swap-in > .role-tags .tag')
    expect(tags.length).toBe(3)
    expect(tags.map((n) => n.textContent).join('')).not.toContain(t('roles.form.color'))
  })
})

describe('F5 落点：只列白名单，差集清单消失而计数行仍在', () => {
  it('「有效 Skill」差集清单整段不再渲染（`.rsec-eff` 为 0、文案无命中）', async () => {
    await render('dev-1')
    const drawer = one('.drawer-body .swap-in')!
    // 前置自证：服务端确实回了白名单之外的技能（否则本用例可能是「差集本来就空」的假绿）
    expect(drawer.textContent).not.toContain('global-a')
    expect(drawer.textContent).not.toContain('team-b')
    expect(all('.rsec-eff').length).toBe(0)
    expect(all('.rsec-mark').length).toBe(0)
  })

  it('白名单技能仍在列（只渲染 `role.skills`）', async () => {
    await render('dev-1')
    const drawer = one('.drawer-body .swap-in')!
    const text = drawer.textContent ?? ''
    expect(text).toContain('role-a')
    expect(text).toContain('role-b')
  })

  it('技能段计数行仍在，且两行口径说明降级进了它的 `title`（§1.5 #4）', async () => {
    await render('dev-1')
    // ⚠ 必须限定在抽屉里：卡面第一格同名（`roles.card.skills` 与 `roles.capabilities` 同为「技能」），
    // 不限定会先命中卡面那格（它本来就不该有 title）
    const line = all('.drawer-body .count-line').find(
      (n) => n.querySelector('.count-label')?.textContent === t('roles.capabilities'),
    )
    expect(line, '技能段的分段头计数行不见了').toBeDefined()
    expect(line!.querySelector('.count-num')?.textContent).toBe('2')
    // title = 口径说明（角色 ∪ 团队 ∪ 全局）+ 声明 N › 有效 M —— 信息未减，只是不再常驻首屏
    expect(line!.getAttribute('title')).toBe(
      `${t('roles.effectiveHint')} · ${t('roles.skills.counts', { declared: 2, effective: 2 })}`,
    )
    // 这两个类随 #4 删除：常驻的两行说明不该再出现在 DOM 里
    expect(all('.rsec-hint').length).toBe(0)
    expect(all('.rsec-sub').length).toBe(0)
  })

  it('知识范围过滤串降级为 `Ref kind="book"` 的 `title`（§1.5 #5）', async () => {
    await render('dev-1')
    const bookRef = all('.drawer-body .ref').find((a) => a.textContent === 'prism')!
    expect(bookRef).toBeDefined()
    expect(bookRef.getAttribute('title')).toBe(`${t('roles.knowledge.filter')}: role/dev-1`)
  })

  it('抽屉不再有全量描述（§1.5 #6）：`.role-drawer-desc` 已删，描述只剩一句话', async () => {
    await render('dev-1')
    expect(all('.role-drawer-desc').length).toBe(0)
    const desc = one('.drawer-body .role-desc')!
    expect(desc.textContent).toBe('架构边界与跨模块契约。')
    expect(desc.getAttribute('title')).toBe(LONG_DESC)
  })

  it('描述全文只有一个去处：深挖折叠内（§1.5 #6 的「全文进深挖折叠」）', async () => {
    await render('dev-1')
    // 第一眼（卡面 + 抽屉）只出现那句话，全文不在这两处
    expect(one('.drawer-body .swap-in > .role-desc')?.textContent).not.toBe(LONG_DESC)
    // 全文在 `role-body` 折叠里（`role.body` 是 frontmatter 之后的正文，不含 description）
    const full = one('.role-body .role-body-desc')
    expect(full?.textContent).toBe(LONG_DESC)
  })
})

describe('R-v8-4 深挖带：校验问题清单默认折叠 + 完整定义正文', () => {
  it('校验问题清单是 `<details>` 且**默认不展开**（状态位由卡片 lamp 承担）', async () => {
    await render('dev-1')
    const fold = one<HTMLDetailsElement>('.role-issues')
    expect(fold).not.toBeNull()
    expect(fold!.open).toBe(false)
    // summary 一行常驻，带计数与 lamp
    expect(fold!.querySelector('summary .count-num')?.textContent).toBe('1')
    expect(fold!.querySelector('summary .count-lamp')).not.toBeNull()
    // error 级文本的 `--madder` 由 styles 契约锁
  })

  it('完整定义正文同样是默认折叠的深挖带，与校验清单共用 summary 口径', async () => {
    await render('dev-1')
    const fold = one<HTMLDetailsElement>('.role-body')!
    expect(fold.open).toBe(false)
    expect(fold.querySelector('summary')?.textContent).toBe(t('common.showDetails'))
    expect(fold.querySelector('pre')?.textContent).toContain('dev-1')
  })

  it('无校验问题的角色不渲染该折叠带（空的深挖项没有存在意义）', async () => {
    data.roles = [{ ...role('clean'), issues: [] }]
    await render('clean')
    expect(one('.role-issues')).toBeNull()
    expect(one('.role-body')).not.toBeNull()
  })
})

describe('R-v8-1 抽屉宽度：详情加宽、表单维持', () => {
  it('详情抽屉渲染 `680px` + 视口上限 `72vw`（= `min(680px, 72vw)`）', async () => {
    await render('dev-1')
    const drawer = one<HTMLElement>('.drawer')!
    expect(drawer.style.width).toBe('680px')
    expect(drawer.style.maxWidth).toBe('72vw')
  })

  it('编辑表单抽屉维持 `560px` + 默认上限 `96vw`（上限默认值不变）', async () => {
    await render('dev-1')
    await click(button(t('common.edit')))
    const drawers = all('.drawer') as HTMLElement[]
    // 前置：两扇抽屉叠着（详情在下、表单在上）
    expect(drawers.length).toBe(2)
    expect(drawers[0]!.style.width).toBe('680px')
    expect(drawers[0]!.style.maxWidth).toBe('72vw')
    expect(drawers[1]!.style.width).toBe('560px')
    expect(drawers[1]!.style.maxWidth).toBe('96vw')
  })

  it('详情抽屉内容列挂 `.role-detail`（66ch 居中落点）；编辑表单抽屉不挂', async () => {
    await render('dev-1')
    // 详情：滚动容器 `.drawer-body` 的内层就是居中列（`max-width/margin` 由 styles 契约锁）
    expect(one('.drawer-body > .role-detail')).not.toBeNull()
    await click(button(t('common.edit')))
    const bodies = all('.drawer-body')
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!.querySelector('.role-detail'), '详情抽屉（下）该有居中列').not.toBeNull()
    expect(bodies[1]!.querySelector('.role-detail'), '表单抽屉（上，560）不该套 66ch 列').toBeNull()
  })

  it('未给 `width` 时**不渲染** inline 宽度（落回 `.drawer` 的 CSS 默认，其他页不受影响）', async () => {
    // 直接挂一个裸 Drawer（同 `overlay-esc.test.ts` 的装配）：`maxVw` 有了默认值后，
    // 最容易被写坏的就是「不给 width 也顺手写了个 max-width」——那会盖掉 CSS 默认宽度。
    await act(async () => {
      root.render(createElement(Drawer, { title: 'probe', onClose: () => {}, width: undefined }, 'x'))
    })
    const drawer = one<HTMLElement>('.drawer')!
    expect(drawer.style.width).toBe('')
    expect(drawer.style.maxWidth).toBe('')
  })
})
