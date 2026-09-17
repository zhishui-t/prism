// @vitest-environment happy-dom
/**
 * v12 F4（W-5）技能页**卡片网格 + 详情弹窗**的 DOM 契约。
 *
 * 四条口径（design-v12 F4「布局」/ spec-v12 SPEC-4.1、4.2，弹窗宽度回溯 SPEC-2.4）：
 *  1. **卡片网格**：组内是 `NavRow variant="card"`（`.nav-row.role-card`）铺在 `.skill-grid`
 *     网格里——与角色页**同一套卡片 token / 同一条网格定义**（样式值由
 *     `styles-skills-groups.test.ts` 锁）；卡片四件 = 名（`.role-name.mono`）/ 摘要
 *     （`.role-desc`）/ 徽章行（`.role-tags`）/ 分类色点（`.role-dot`，**未分类不出色点**）；
 *  2. **色点是既有颜色 token 的确定性映射**：同一个分类的两张卡拿到**同一个** inline 值，
 *     且值落在 `var(--role-*)`（不新增 hex / 变量）——映射本身由 `skills-logic.test.ts` 直测；
 *  3. **点击卡片 = 改 hash**（`<a href="#/skills/<name>">`：中键 / 复制深链都通）；
 *     深链选中 ⇒ 详情整块进 `<Modal size="lg">`（`.modal-mask > .modal.modal-lg`）；
 *  4. **关闭弹窗 = 回列表**（`navigate({ page: 'skills' })` ⇒ hash 落 `#/skills`）；
 *     装卸 / 删除的 `ConfirmModal` 叠在详情弹窗之上，一次 Esc 只关**栈顶**。
 *
 * 渲染路径同 `skills-hierarchy.test.ts`（happy-dom + 裸 `react-dom/client` + `react.act`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 够长的一句话：列表摘要必然被 `firstSentence(_, 32)` 截断（前置自证用）。 */
const LONG_DESC =
  '这是用来验证列表卡片摘要截断的一句话它故意写得很长而且没有句末标点所以必须靠三十二字上限来收口'

/**
 * 三条技能覆盖三种分组形态：
 * - `ui` 两条 ⇒ 证「同一分类 = 同一个色点」（确定性映射的 DOM 证据）；
 * - `docs` 一条；
 * - 无 `category` 键一条 ⇒ 未分类组，**不出色点**。
 */
const SKILLS = [
  { name: 'frontend-dev', description: LONG_DESC, builtin: true, category: 'ui' },
  { name: 'frontend-design', description: '设计系统与视觉规范。', builtin: true, category: 'ui' },
  { name: 'tech-doc', description: '写文档。', builtin: true, category: 'docs' },
  { name: 'zeta', description: '没有分类的技能。', builtin: true },
]

/** 受控假数据（`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用）。 */
const data = vi.hoisted(() => ({
  /** usage 路（**全量**）：默认全部已装、无引用方；用例可改。 */
  usage: [] as Array<Record<string, unknown>>,
  /** 详情接口（`GET /api/skills/:name`）的已装态：`.scope-callout`（未装才出）的开关。 */
  detailInstalled: true,
  deleteCalls: [] as string[],
}))

function defaultUsage(): Array<Record<string, unknown>> {
  return SKILLS.map((s) => ({ name: s.name, builtin: true, installed: true, roles: [], teams: [] }))
}

vi.mock('../src/api-team.ts', () => ({
  teamApi: {
    skills: () => Promise.resolve({ skills: SKILLS, skills_dir: '/tmp/prism-skills' }),
    skillUsage: () => Promise.resolve(data.usage),
    // W-6：组集与组序来自分类清单（两个已命名分类 + 未分类 ⇒ 仍是 3 组）
    skillCategories: () => Promise.resolve({ categories: ['ui', 'docs'], mapping: {} }),
    skill: (name: string) =>
      Promise.resolve({
        name,
        description: `${name} 的说明。`,
        builtin: true,
        installed: data.detailInstalled,
        path: `/tmp/prism-skills/${name}/SKILL.md`,
        roles: [],
        teams: [],
        content: `# ${name}\n`,
      }),
    skillInstall: () => Promise.resolve({ skills_dir: '/tmp/prism-skills', written: [], skipped: [] }),
    skillUninstall: () => Promise.resolve({ skills_dir: '/tmp/prism-skills', removed: [], kept: [] }),
    skillDeleteExternal: (name: string) => {
      data.deleteCalls.push(name)
      return Promise.resolve({ skills_dir: '/tmp/prism-skills', removed: [name], trash_id: 'trash-1' })
    },
    // 详情切「有效集」时才会用到；本文件不切，但模块被整体替身时必须给出，否则渲染即崩
    roles: () => Promise.resolve({ roles: [], rolesDir: '/tmp/prism-roles' }),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { SkillsPage } from '../src/pages/Skills.tsx'

let container: HTMLDivElement
let root: Root

async function render(sel?: string): Promise<void> {
  await act(async () => {
    root.render(createElement(SkillsPage, { sel }))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

/** 详情弹窗（带 `-lg` 的那个；确认框走窄版 `.modal`，两者靠这个类分流）。 */
function detailModal(): Element | null {
  return one('.modal.modal-lg')
}

/** 确认框（无尺寸档的窄版 `.modal`，W-5 起与详情弹窗同时在场的唯一分流判据）。 */
function confirmModal(): Element | null {
  return all('.modal').find((m) => !m.classList.contains('modal-lg')) ?? null
}

/** 按卡片名取卡片（名 = `.role-name` 的文本；色点 span 无文本）。 */
function cardOf(name: string): Element | undefined {
  return all('.md-list .role-card').find(
    (c) => c.querySelector('.role-name')?.textContent === name,
  )
}

function button(label: string): HTMLButtonElement {
  const hit = all('button').find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

/**
 * 详情弹窗**内**的按钮。W-6 起列表侧的分类组头也有「删除」动作（`skills.category.remove`，
 * 与详情工具条的 `skills.delete.action` 同字面），故详情工具条必须按弹窗范围取，
 * 不能按全文档首命中——否则取到的是某个组的删除钮。
 */
function modalButton(label: string): HTMLButtonElement {
  const modal = detailModal()
  if (modal === null) throw new Error('详情弹窗未打开')
  const hit = [...modal.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`详情弹窗内未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 在 `window` 上派发 Esc（浮层监听注册在 window 上，与真实按键同路）。 */
async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  setLang('zh')
  data.usage = defaultUsage()
  data.detailInstalled = true
  data.deleteCalls = []
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

describe('SPEC-4.1 卡片网格：四件内容 + 与角色页同构的卡片零件', () => {
  it('组内是卡片网格：4 条技能 = 4 张 `NavRow variant="card"`（不再是 `.md-row` 行列表）', async () => {
    await render()

    expect(all('.md-list .role-card').length).toBe(4)
    // 回归红线：技能列表不再是横向行列表
    expect(all('.md-list .md-row').length).toBe(0)
    // 网格容器每组建一个（3 组：docs / ui / 未分类）
    expect(all('.md-list .skill-grid').length).toBe(3)
  })

  it('卡片四件在场：名（`.role-name.mono`）/ 摘要（`.role-desc`）/ 徽章（`.role-tags`）/ 色点', async () => {
    await render()

    const card = cardOf('frontend-dev')!
    expect(card).toBeDefined()
    expect(card.classList.contains('role-card')).toBe(true)
    expect(card.querySelector('.role-name.mono')?.textContent).toBe('frontend-dev')
    // 摘要吃既有 1 行截断口径（`.role-desc`），全文进 `title`
    const desc = card.querySelector('.role-desc')!
    expect(desc.textContent?.endsWith('…')).toBe(true)
    expect(desc.getAttribute('title')).toBe(LONG_DESC)
    // 来源 / 宿主两枚中性徽章（已装 ⇒ 无 lamp）
    expect([...card.querySelectorAll('.role-tags > *')].map((n) => n.textContent)).toEqual([
      t('common.builtin'),
      t('common.installed'),
    ])
  })

  it('分类色点：同一分类的两张卡拿到**同一个**既有 `--role-*` 值；未分类组不出色点', async () => {
    await render()

    const dot = (name: string): string | null =>
      cardOf(name)?.querySelector('.role-dot')?.getAttribute('style') ?? null

    // 前置自证：色点确实渲染了（否则下面「相等」可能是「都是 null」的假绿）
    expect(dot('frontend-dev')).not.toBeNull()
    // 确定性：按**分类名**取色 ⇒ 同组两张卡同值
    expect(dot('frontend-design')).toBe(dot('frontend-dev'))
    // 不同分类不保证不同色，但取值必须落在既有 token 上（不新增 hex / 变量）
    expect(dot('frontend-dev')).toContain('var(--role-')
    expect(dot('tech-doc')).toContain('var(--role-')
    // 无分类 ⇒ 完全不渲染色点
    expect(cardOf('zeta')!.querySelector('.role-dot')).toBeNull()
  })

  it('卡片是 `<a href="#/skills/<name>">`：中键 / 复制深链都通（可点契约走 `.nav-row`）', async () => {
    await render()

    const card = cardOf('frontend-dev')!
    expect(card.tagName.toLowerCase()).toBe('a')
    expect(card.classList.contains('nav-row')).toBe(true)
    expect(card.getAttribute('href')).toBe('#/skills/frontend-dev')
  })

  it('点击卡片 → hash 落到该技能（选中唯一真相仍是 hash，深链由 Shell 回灌）', async () => {
    await render()

    await click(cardOf('tech-doc')!)

    expect(window.location.hash).toBe('#/skills/tech-doc')
  })
})

describe('SPEC-4.2 / SPEC-2.4 详情弹窗：`.modal-lg`（宽度 = 既有 `--modal-w`）', () => {
  it('无选中 → 纯列表：没有 `.md-detail` 右栏、没有弹窗，列表走 `.md.solo` 单列', async () => {
    await render()

    expect(one('.md.solo')).not.toBeNull()
    expect(one('.md-detail')).toBeNull()
    expect(one('.modal')).toBeNull()
    // 列表本体在场（不是「整页空掉」被误当通过）
    expect(all('.md-list .role-card').length).toBe(4)
  })

  it('深链选中 → 详情整块进 `.modal-mask > .modal.modal-lg`，右栏与选择提示都不在', async () => {
    await render('frontend-dev')

    const mask = one('.modal-mask')
    expect(mask).not.toBeNull()
    // 居中的唯一来源是 `.modal-mask` 的 flex 居中；面板是它的直接子节点
    expect(detailModal()?.parentElement).toBe(mask)
    expect(one('.md-detail')).toBeNull()
    // 详情内容（既有 `SkillBody` 全量）在弹窗内容区里
    expect(detailModal()!.querySelector('.modal-content .skill-desc')).not.toBeNull()
    expect(detailModal()!.querySelector('.modal-content .skill-deep')).not.toBeNull()
  })

  it('无障碍：`role="dialog"` + `aria-modal` + `aria-label`（面板头是技能名）', async () => {
    await render('frontend-dev')

    const modal = detailModal()!
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    expect(modal.getAttribute('aria-label')).toBe('frontend-dev')
    expect(modal.querySelector('.modal-head h3')?.textContent).toBe('frontend-dev')
  })

  it('外部可删技能：工具条的破坏性动作「删除」随详情一起迁入弹窗', async () => {
    data.usage = [
      { name: 'frontend-dev', builtin: false, installed: true, roles: [], teams: [], external_removable: true },
      ...defaultUsage().filter((r) => r.name !== 'frontend-dev'),
    ]
    await render('frontend-dev')

    const toolbar = modalButton(t('skills.delete.action'))
    expect(detailModal()!.contains(toolbar)).toBe(true)
  })

  it('未装技能：精确命令块与安装按钮随详情一起迁入弹窗', async () => {
    data.detailInstalled = false
    data.usage = [
      { name: 'tech-doc', builtin: true, installed: false, roles: [], teams: [] },
      ...defaultUsage().filter((r) => r.name !== 'tech-doc'),
    ]
    await render('tech-doc')

    const callout = detailModal()!.querySelector('.scope-callout')!
    expect(callout.querySelector('.cmd-row .cmd')?.textContent).toBe('prism skill install tech-doc')
    expect(detailModal()!.contains(button(t('skills.install.action')))).toBe(true)
  })
})

describe('关闭弹窗 = 回列表；装卸 / 删除的确认框叠在其上，Esc 只关栈顶', () => {
  it('头部关闭钮 → hash 落 `#/skills`（列表）', async () => {
    await render('frontend-dev')

    await click(button(t('common.close')))

    expect(window.location.hash).toBe('#/skills')
  })

  it('Esc（栈顶 = 详情弹窗）→ 回列表', async () => {
    await render('frontend-dev')

    await pressEscape()

    expect(window.location.hash).toBe('#/skills')
  })

  it('叠加：删除确认框压住详情弹窗，一次 Esc 只关确认框、详情不动，再按才回列表', async () => {
    data.usage = [
      { name: 'frontend-dev', builtin: false, installed: true, roles: [], teams: [], external_removable: true },
      ...defaultUsage().filter((r) => r.name !== 'frontend-dev'),
    ]
    await render('frontend-dev')

    await click(modalButton(t('skills.delete.action')))
    expect(confirmModal()).not.toBeNull()
    expect(detailModal()).not.toBeNull()

    await pressEscape()

    // 栈顶是确认框 ⇒ 只关它；详情弹窗与选中（hash）都不动
    expect(confirmModal()).toBeNull()
    expect(detailModal()).not.toBeNull()
    expect(window.location.hash).toBe('')

    await pressEscape()

    // 确认框已关，详情弹窗升为栈顶 ⇒ 这次才回列表
    expect(window.location.hash).toBe('#/skills')
  })
})
