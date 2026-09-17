// @vitest-environment happy-dom
/**
 * F1（v11）角色表单 · **技能选取器**的 DOM 契约。
 *
 * 锁六件事（都是交互语义，不是像素）：
 *  1. **逗号文本框退役**：`skills` 字段不再是 `<input>`，而是 chips + 一个打开钮
 *     （已选技能从定义播种而来——前置自证，防止「字段是空的」造成的假绿）；
 *  2. **弹层是 `<Modal size="md">`**（`.modal-md`，走既有浮层栈）：标题 = `picker.title.skill`；
 *  3. **分类分组复用技能页口径**：组头 = 分类名原文 + 计数（未分类组走 `skills.uncategorized`
 *     且置末尾），组内按名排序；行内带**内置/已装**元信息（未装 = lamp + 「未装」）；
 *  4. **搜索过滤**：命中组名即整组保留；无命中给 `picker.filterNone`（不退化成空库文案）；
 *  5. **勾选 / 取消 / chip 单个移除 / 手动添加**四个动作都落回**同一份白名单**
 *     （表单字段位与弹层里的 chips 同步变化）；
 *  6. **「未装」灯只由库决定**：库内未装的勾选项与手动添加的库外名字都点灯
 *     （`available: false` 既有语义），库内已装项**不点灯**（证明 lamp 不是恒亮）。
 *
 * 渲染路径与 `roles-hierarchy.test.ts` 一致：happy-dom + 裸 `react-dom/client` + `react.act`，
 * 不引 @testing-library；本目录 include 只收 `.test.ts`，故不用 JSX。
 *
 * ⚠ 弹层在 DOM 里**嵌在**表单抽屉内部（`RoleForm` 的子树）——故断言一律按作用域取：
 * 表单侧走 `.field`（选取器里没有 `.field`），弹层侧走 `.modal-md`（详情模态是 `.modal-lg`，
 * 两者同在页面里，混用会取错）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition, RoleWriteInput } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用（每个用例重铺）。 */
const data = vi.hoisted(() => ({
  roles: [] as unknown[],
  /** 提交出去的 payload（按调用序）——「改动真的发出去了」的收口自证。 */
  saved: [] as unknown[],
}))

/**
 * 库：4 条内置（两个分类 + 一条未分类）+ 1 条只出现在 usage 路的**外部**技能
 * （F7-1 起外部技能的分类只可能来自 usage 路）。宿主态刻意混着：
 * `frontend-dev` 未装（勾它是「库内未装」这条路径）、其余已装。
 */
const SKILLS = [
  { name: 'frontend-design', description: 'UI 设计', builtin: true, category: 'ui' },
  { name: 'frontend-dev', description: 'UI 开发', builtin: true, category: 'ui' },
  { name: 'tech-doc', description: '写文档', builtin: true, category: 'docs' },
  { name: 'loose-skill', description: '没有分类的技能', builtin: true },
]
const USAGE = [
  { name: 'external-skill', builtin: false, installed: true, roles: [], teams: [], category: 'ops' },
  { name: 'frontend-design', builtin: true, installed: true, roles: [], teams: [] },
  { name: 'frontend-dev', builtin: true, installed: false, roles: [], teams: [] },
  { name: 'loose-skill', builtin: true, installed: true, roles: [], teams: [] },
  { name: 'tech-doc', builtin: true, installed: true, roles: [], teams: [] },
]

vi.mock('../src/api-team.ts', () => ({
  // 表单的常量来自本模块；模块被整体替身时必须一并给出（否则渲染即崩）。
  ROLE_COLOR_OPTIONS: ['red', 'blue'],
  THOUGHT_LEVELS: ['low', 'high', 'max'],
  teamApi: {
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    role: (name: string) => Promise.resolve(data.roles.find((r) => (r as RoleDefinition).name === name) ?? null),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
    skills: () => Promise.resolve({ skills: SKILLS, skills_dir: '/tmp/prism-skills' }),
    skillUsage: () => Promise.resolve(USAGE),
    updateRole: (_name: string, input: RoleWriteInput) => {
      data.saved.push(input)
      return Promise.resolve({ path: '/tmp/prism-roles/dev-1.md', overwritten: false })
    },
    createRole: (input: RoleWriteInput) => {
      data.saved.push(input)
      return Promise.resolve({ path: '/tmp/prism-roles/new.md', overwritten: false })
    },
    deleteRole: () => Promise.resolve({ removed: [] }),
  },
}))

/** 角色表单不消费 kb 书目（那是同批的书目选取器用例的事），给空树即可。 */
vi.mock('../src/api.ts', () => ({ api: { kbTree: () => Promise.resolve([]) } }))

import { setLang, t } from '../src/i18n.ts'
import { RolesPage } from '../src/pages/Roles.tsx'

function role(name: string): RoleDefinition {
  return {
    name,
    description: `${name} 的描述`,
    skills: ['tech-doc'],
    knowledge: { layers: ['project'], books: ['prism'] },
    principle: '先读再写',
    body: `# ${name}`,
  }
}

let container: HTMLDivElement
let root: Root

async function render(sel: string): Promise<void> {
  await act(async () => {
    root.render(createElement(RolesPage, { sel }))
  })
}

function all(selector: string, scope: ParentNode = container): Element[] {
  return [...scope.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string, scope: ParentNode = container): T | null {
  return scope.querySelector<T>(selector)
}

async function click(target: Element | null): Promise<void> {
  if (target === null) throw new Error('click 的目标不存在')
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 受控输入：走原生 value setter 改值再派发 `input`（React 的受控值跟踪才认账）。 */
async function fill(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const hit = all('button', scope).find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

/** 表单里的一个字段（`.field` 的第一个 `span` 是它的标签）——选取器弹层里没有 `.field`。 */
function field(label: string): Element {
  const hit = all('.field').find((f) =>
    [...f.children].some((c) => c.tagName === 'SPAN' && c.textContent === label),
  )
  if (hit === undefined) throw new Error(`未找到字段：${label}`)
  return hit
}

interface ChipInfo {
  name: string
  /** 未装（`.chip.missing` 的 lamp + 「未装」文字） */
  missing: boolean
  note: string
}

function chips(scope: Element): ChipInfo[] {
  return all('.chip', scope).map((c) => ({
    name: c.querySelector('.mono')?.textContent ?? '',
    missing: c.classList.contains('missing'),
    note: c.querySelector('.chip-note')?.textContent ?? '',
  }))
}

/** 打开编辑表单（详情模态 → 「编辑」）。 */
async function openForm(): Promise<void> {
  await click(button(t('common.edit')))
  const drawer = one('.drawer')
  expect(drawer, '编辑表单抽屉没打开').not.toBeNull()
}

/** 打开技能选取器弹层（`.modal-md`；详情模态是 `.modal-lg`，两者不混）。 */
async function openPicker(): Promise<Element> {
  await click(button(t('picker.open.skill')))
  const dialog = one('.modal-md')
  if (dialog === null) throw new Error('技能选取器弹层没打开')
  return dialog
}

function dialog(): HTMLElement {
  const hit = one<HTMLElement>('.modal-md')
  if (hit === null) throw new Error('技能选取器弹层不在')
  return hit
}

/** 库内行名（文档序）。 */
function pickNames(): string[] {
  return all('.modal-md .pick-row .pick-name').map((n) => n.textContent ?? '')
}

function pickRow(name: string): Element {
  const hit = all('.modal-md .pick-row').find((r) => r.querySelector('.pick-name')?.textContent === name)
  if (hit === undefined) throw new Error(`未找到库内行：${name}`)
  return hit
}

/** 库内行名 + 是否选中（`.on` 与 checkbox 必须一致）。 */
function pickState(name: string): { on: boolean; checked: boolean } {
  const row = pickRow(name)
  return { on: row.classList.contains('on'), checked: row.querySelector<HTMLInputElement>('input')?.checked === true }
}

/** 组头（文档序）：组名 + 计数。 */
function groupHeads(): Array<{ label: string; count: string }> {
  return all('.modal-md .pick-group').map((g) => ({
    label: g.querySelector('.count-label')?.textContent ?? '',
    count: g.querySelector('.count-num')?.textContent ?? '',
  }))
}

function searchBox(): HTMLInputElement {
  const hit = one<HTMLInputElement>('.modal-md .picker-body > input')
  if (hit === null) throw new Error('选取器的搜索框不在')
  return hit
}

function manualBox(): HTMLInputElement {
  const hit = one<HTMLInputElement>('.modal-md .picker-manual input')
  if (hit === null) throw new Error('手动添加输入框不在')
  return hit
}

/** 弹层里「已选」那一段的 chips（弹层盖着表单，不这样做就看不到自己勾了什么）。 */
function dialogChips(): ChipInfo[] {
  return chips(dialog())
}

/** 表单字段位（`.field`）里的 chips。 */
function formChips(label: string): ChipInfo[] {
  return chips(field(label))
}

beforeEach(() => {
  setLang('zh')
  data.roles = [role('dev-1')]
  data.saved = []
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

describe('F1 字段形态：逗号文本框退役，换成 chips + 打开钮', () => {
  it('已选技能渲染为 chips（从定义播种），字段里**没有**输入框', async () => {
    await render('dev-1')
    await openForm()
    const box = field(t('roles.form.skills'))
    // 前置自证：定义里确有技能（否则「没有 input 也没有 chip」也是过的）
    expect(data.roles).toEqual([expect.objectContaining({ skills: ['tech-doc'] })])
    expect(chips(box).map((c) => c.name)).toEqual(['tech-doc'])
    expect(box.querySelector('input'), 'skills 字段不该再有输入框').toBeNull()
    // 打开钮可点（`button()` 找不到就抛，故这一条同时是「按钮在这个字段里」的证据）
    expect(button(t('picker.open.skill'), box).disabled).toBe(false)
  })

  it('知识层字段仍是逗号输入框（F1 只换 skills / books，不顺手改别的字段）', async () => {
    await render('dev-1')
    await openForm()
    expect(field(t('roles.form.layers')).querySelector('input')).not.toBeNull()
  })
})

describe('F1 弹层：库内勾选（分类分组 + 内置/已装）', () => {
  it('打开的是 `.modal-md` 选取器（标题走 `picker.title.skill`），详情模态 `.modal-lg` 不受影响', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(one('.modal-md .modal-head h3')?.textContent).toBe(t('picker.title.skill'))
    // 详情模态仍在（表单叠在它之上），两者靠尺寸档分流
    expect(one('.modal-lg')).not.toBeNull()
  })

  it('组头 = 分类名原文 + 计数，未分类组置末尾（复用技能页的 `groupSkills`）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(groupHeads()).toEqual([
      { label: 'docs', count: '1' },
      { label: 'ops', count: '1' },
      { label: 'ui', count: '2' },
      { label: t('skills.uncategorized'), count: '1' },
    ])
  })

  it('全库行都在 DOM 里：5 行，组序与组内行序都来自 `groupSkills`（不是入参顺序）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(pickNames()).toEqual([
      'tech-doc', // docs
      'external-skill', // ops
      'frontend-design', // ui（入参是 design 在前，故这条不是「碰巧」）
      'frontend-dev',
      'loose-skill', // 未分类
    ])
  })

  it('行内元信息：内置 / 外部 + 已装 / 未装（未装才 lamp）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    const dev = pickRow('frontend-dev')
    expect(dev.querySelector('.src')?.textContent).toBe(t('common.builtin'))
    expect(dev.querySelector('.host')?.textContent).toBe(t('common.notInstalled'))
    expect(dev.querySelector('.host .scope-lamp')).not.toBeNull()

    const design = pickRow('frontend-design')
    expect(design.querySelector('.host')?.textContent).toBe(t('common.installed'))
    expect(design.querySelector('.host .scope-lamp')).toBeNull()

    const external = pickRow('external-skill')
    expect(external.querySelector('.src')?.textContent).toBe(t('common.external'))
  })

  it('已选在弹层里也常驻（弹层盖着表单）：计数 + chips 与定义一致', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(dialog().textContent).toContain(t('picker.selected', { n: 1 }))
    expect(dialogChips().map((c) => c.name)).toEqual(['tech-doc'])
    expect(pickState('tech-doc')).toEqual({ on: true, checked: true })
  })
})

describe('F1 搜索过滤', () => {
  it('按技能名过滤：只剩命中组，组头计数即命中数', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await fill(searchBox(), 'tech')
    expect(groupHeads()).toEqual([{ label: 'docs', count: '1' }])
    expect(pickNames()).toEqual(['tech-doc'])
  })

  it('命中**组名**即整组保留（用分类收窄，不是只匹配行名）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await fill(searchBox(), 'ui')
    expect(groupHeads()).toEqual([{ label: 'ui', count: '2' }])
    expect(pickNames()).toEqual(['frontend-design', 'frontend-dev'])
  })

  it('无命中给「没有匹配项」，**不**退化成「库是空的」（两种处境两句话）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await fill(searchBox(), 'zzz-nothing')
    expect(groupHeads()).toEqual([])
    expect(dialog().textContent).toContain(t('picker.filterNone'))
    expect(dialog().textContent).not.toContain(t('picker.empty.skill'))
  })
})

describe('F1 勾选 / 取消 / chip 单个移除', () => {
  it('勾选库内技能 → 表单与弹层的 chips 同步 +1，行变选中态', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    // 点行（`<label>` 裹着复选框，整行可点）即可切换
    await click(pickRow('frontend-design'))
    expect(pickState('frontend-design')).toEqual({ on: true, checked: true })
    expect(formChips(t('roles.form.skills')).map((c) => c.name)).toEqual(['tech-doc', 'frontend-design'])
    expect(dialogChips().map((c) => c.name)).toEqual(['tech-doc', 'frontend-design'])
    expect(dialog().textContent).toContain(t('picker.selected', { n: 2 }))
  })

  it('再勾一次 = 取消：行回未选中，两处 chips 回到 1', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await click(pickRow('frontend-design'))
    await click(pickRow('frontend-design'))
    expect(pickState('frontend-design')).toEqual({ on: false, checked: false })
    expect(formChips(t('roles.form.skills')).map((c) => c.name)).toEqual(['tech-doc'])
    expect(dialogChips().map((c) => c.name)).toEqual(['tech-doc'])
  })

  it('chip 上的 `×` **单个**移除：只摘那一个（其余与顺序不变），库内行同步取消', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await click(pickRow('frontend-design'))
    const box = field(t('roles.form.skills'))
    // 前置自证：此时有两个 chip，移除后还剩一个——否则「少了一个」可能是「本来就只有一个」
    expect(formChips(t('roles.form.skills')).map((c) => c.name)).toEqual(['tech-doc', 'frontend-design'])
    await click(box.querySelectorAll('.chip button')[0]!)
    expect(formChips(t('roles.form.skills')).map((c) => c.name)).toEqual(['frontend-design'])
    expect(pickState('tech-doc')).toEqual({ on: false, checked: false })
    // 「移除」钮的无障碍名带名字（视觉只有一个 `×`）
    expect(box.querySelector('.chip button')?.getAttribute('aria-label')).toBe(
      t('picker.remove', { name: 'frontend-design' }),
    )
  })
})

describe('F1 手动添加未装技能（自由输入保留）', () => {
  it('库外名字可加入：chip 点 lamp + 「未装」，且它不是库内行', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await fill(manualBox(), 'ghost-skill')
    await click(button(t('picker.add'), dialog()))
    const added = formChips(t('roles.form.skills')).find((c) => c.name === 'ghost-skill')
    expect(added, '手动项没进白名单').toBeDefined()
    expect(added!.missing).toBe(true)
    expect(added!.note).toBe(t('common.notInstalled'))
    expect(pickNames()).not.toContain('ghost-skill')
    // 弹层里的同一份 chips 也点灯（两处是同一个零件）
    expect(dialogChips().find((c) => c.name === 'ghost-skill')?.missing).toBe(true)
  })

  it('回车等价「添加」（小输入框不该逼人去找按钮）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await fill(manualBox(), 'enter-skill')
    await act(async () => {
      manualBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(formChips(t('roles.form.skills')).map((c) => c.name)).toEqual(['tech-doc', 'enter-skill'])
  })

  it('空输入：按钮禁用、回车不入列（不留空白名单项）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(button(t('picker.add'), dialog()).disabled).toBe(true)
    await act(async () => {
      manualBox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(formChips(t('roles.form.skills')).map((c) => c.name)).toEqual(['tech-doc'])
  })

  it('重复添加同名**幂等**（不会出现两个同名 chip）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await fill(manualBox(), 'ghost-skill')
    await click(button(t('picker.add'), dialog()))
    await fill(manualBox(), 'ghost-skill')
    await click(button(t('picker.add'), dialog()))
    expect(formChips(t('roles.form.skills')).map((c) => c.name)).toEqual(['tech-doc', 'ghost-skill'])
  })

  it('「未装」灯不是恒亮：库内**已装**的勾选项不点灯（对照组）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await click(pickRow('frontend-design')) // 已装
    await click(pickRow('frontend-dev')) // 未装
    const list = formChips(t('roles.form.skills'))
    expect(list.find((c) => c.name === 'frontend-design')?.missing).toBe(false)
    expect(list.find((c) => c.name === 'frontend-dev')?.missing).toBe(true)
  })
})

describe('F1 提交：白名单真的发出去了（端到端）', () => {
  it('勾选 + 手动添加 + 移除后保存 → payload.skills 是表单里的那一条（含顺序），books 不回归', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await click(pickRow('frontend-design'))
    await fill(manualBox(), 'ghost-skill')
    await click(button(t('picker.add'), dialog()))
    // 关弹层（弹层是模态：不关就点不到抽屉里的保存钮——同时也是「完成」的出口自证）
    await click(button(t('picker.done'), dialog()))
    expect(one('.modal-md')).toBeNull()

    const save = button(t('common.save'), one('.drawer')!)
    expect(save.disabled).toBe(false)
    await click(save)

    expect(data.saved).toHaveLength(1)
    const input = data.saved[0] as RoleWriteInput
    expect(input.skills).toEqual(['tech-doc', 'frontend-design', 'ghost-skill'])
    // B1 不回归：books 不在 skills 选取器的管辖内，改技能**不该**动知识绑定
    expect(input.knowledge?.books).toEqual(['prism'])
  })
})
