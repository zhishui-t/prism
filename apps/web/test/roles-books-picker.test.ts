// @vitest-environment happy-dom
/**
 * F1（v11）角色表单 · **知识书目（books）选取器**的 DOM 契约。
 *
 * 与 `roles-skills-picker.test.ts` **同构**（同一个 `PickerDialog` 零件），本文件锁的是
 * 「同构里**刻意不同**的那几处」：
 *  1. **平铺不分组**：书目没有分类 ⇒ 单组 + 空组名 ⇒ **一个组头都不画**（不硬造分类）；
 *  2. **跨层同名去重**：`GET /api/kb/tree` 的 `book` 在 global / project / role 三层可能同名
 *     （角色的 books 绑定只有**名字**、没有层），故按名字去重——同名两行是错的；
 *  3. **不点「未装」灯**：书目没有 `available` 这一档 ⇒ chips 不带 `.chip.missing`
 *     （不把「不知道」渲染成一种状态）；
 *  4. **懒加载**：chips 不需要书目（没有宿主态要判），故书目树**只在弹层打开时**才拉
 *     ——这条是行为契约，用调用计数钉住；
 *  5. **提交**：`knowledge.books` = 表单里那一条（含顺序），且**同时**保留 skills（B1 不回归）。
 *
 * 渲染路径与 `roles-skills-picker.test.ts` 完全一致（happy-dom + 裸 `react-dom/client` +
 * `react.act`，不引 @testing-library；include 只收 `.test.ts`，故不用 JSX）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition, RoleWriteInput } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const data = vi.hoisted(() => ({
  roles: [] as unknown[],
  saved: [] as unknown[],
  /** `api.kbTree` 被调次数（懒加载契约的自证：不开书目弹层就不该拉）。 */
  kbTreeCalls: 0,
}))

/**
 * 书目树：`prism` 在 project 与 global 两层**同名**（去重前 2 行）、`delivery-playbook`
 * 在 role 层（带 owner）。角色的 books 绑定只有名字 ⇒ 期望 2 行。
 */
const TREE = [
  { layer: 'project', book: 'prism', modules: [], total: 3 },
  { layer: 'global', book: 'prism', modules: [], total: 1 },
  { layer: 'role', owner: 'dev-1', book: 'delivery-playbook', modules: [], total: 2 },
]

vi.mock('../src/api-team.ts', () => ({
  ROLE_COLOR_OPTIONS: ['red', 'blue'],
  THOUGHT_LEVELS: ['low', 'high', 'max'],
  teamApi: {
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    role: (name: string) => Promise.resolve(data.roles.find((r) => (r as RoleDefinition).name === name) ?? null),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
    skills: () => Promise.resolve({ skills: [], skills_dir: '/tmp/prism-skills' }),
    skillUsage: () => Promise.resolve([]),
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

vi.mock('../src/api.ts', () => ({
  api: {
    kbTree: () => {
      data.kbTreeCalls += 1
      return Promise.resolve(TREE)
    },
  },
}))

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

function field(label: string): Element {
  const hit = all('.field').find((f) =>
    [...f.children].some((c) => c.tagName === 'SPAN' && c.textContent === label),
  )
  if (hit === undefined) throw new Error(`未找到字段：${label}`)
  return hit
}

function chipNames(scope: Element): string[] {
  return all('.chip', scope).map((c) => c.querySelector('.mono')?.textContent ?? '')
}

async function openForm(): Promise<void> {
  await click(button(t('common.edit')))
  expect(one('.drawer'), '编辑表单抽屉没打开').not.toBeNull()
}

async function openPicker(): Promise<Element> {
  await click(button(t('picker.open.book')))
  const dialog = one('.modal-md')
  if (dialog === null) throw new Error('书目选取器弹层没打开')
  return dialog
}

function dialog(): HTMLElement {
  const hit = one<HTMLElement>('.modal-md')
  if (hit === null) throw new Error('书目选取器弹层不在')
  return hit
}

function pickNames(): string[] {
  return all('.modal-md .pick-row .pick-name').map((n) => n.textContent ?? '')
}

function pickRow(name: string): Element {
  const hit = all('.modal-md .pick-row').find((r) => r.querySelector('.pick-name')?.textContent === name)
  if (hit === undefined) throw new Error(`未找到书目行：${name}`)
  return hit
}

const bookChips = (): string[] => chipNames(field(t('roles.form.books')))

beforeEach(() => {
  setLang('zh')
  data.roles = [role('dev-1')]
  data.saved = []
  data.kbTreeCalls = 0
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

describe('F1 books 字段：与 skills 同构（chips + 打开钮，没有输入框）', () => {
  it('已绑定书目渲染为 chips（从定义播种），字段里没有输入框', async () => {
    await render('dev-1')
    await openForm()
    const box = field(t('roles.form.books'))
    expect(data.roles).toEqual([expect.objectContaining({ knowledge: expect.objectContaining({ books: ['prism'] }) })])
    expect(bookChips()).toEqual(['prism'])
    expect(box.querySelector('input'), 'books 字段不该有输入框（选取器接管）').toBeNull()
  })

  it('**懒加载**：表单打开时不拉书目树，打开书目弹层才拉（chips 不需要书目）', async () => {
    await render('dev-1')
    await openForm()
    expect(data.kbTreeCalls, '表单打开就拉了书目树（chips 用不到它）').toBe(0)
    await openPicker()
    expect(data.kbTreeCalls).toBe(1)
  })
})

describe('F1 书目弹层：平铺不分组 + 跨层同名去重', () => {
  it('**一个组头都不画**（单组 + 空组名 = 平铺；书目没有分类，不硬造）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(all('.modal-md .pick-group')).toHaveLength(1)
    expect(all('.modal-md .pick-group .count-label')).toHaveLength(0)
    // 区段头仍在（「库内勾选」+ 计数）——平铺的是组头，不是整段
    expect(dialog().querySelector('.picker-body > .count-line .count-label')?.textContent).toBe(t('picker.library'))
  })

  it('跨层同名书只出现一次，且按名字排序（`prism` 两层 → 1 行）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(pickNames()).toEqual(['delivery-playbook', 'prism'])
  })

  it('行内**不画**内置/已装徽章（书目没有来源与宿主态，不伪造）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    expect(all('.modal-md .pick-row .src')).toHaveLength(0)
    expect(all('.modal-md .pick-row .host')).toHaveLength(0)
  })
})

describe('F1 书目：勾选 / 手动添加 / 移除（与 skills 同一套动作）', () => {
  it('勾选库内书目 → chip 追加在末尾（保持选取顺序）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await click(pickRow('delivery-playbook'))
    expect(bookChips()).toEqual(['prism', 'delivery-playbook'])
  })

  it('手动添加库外书目 → 入列；书目**不点**「未装」灯（没有 available 这一档）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await fill(one<HTMLInputElement>('.modal-md .picker-manual input')!, 'future-book')
    await click(button(t('picker.add'), dialog()))
    expect(bookChips()).toEqual(['prism', 'future-book'])
    // ⚠ 必须限定在 **books 字段内**：本用例的 skills 库是空的，`tech-doc` 那个 chip 是点灯的
    //（那正好是「灯由库决定」的正向证据），全局 `.chip.missing` 断言会取到它。
    expect(all('.chip.missing', field(t('roles.form.books')))).toHaveLength(0)
    expect(pickNames()).not.toContain('future-book')
  })

  it('chip 单个移除：摘掉 `prism`，其余顺序不变', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await click(pickRow('delivery-playbook'))
    const box = field(t('roles.form.books'))
    expect(bookChips()).toEqual(['prism', 'delivery-playbook'])
    await click(box.querySelectorAll('.chip button')[0]!)
    expect(bookChips()).toEqual(['delivery-playbook'])
  })
})

describe('F1 书目提交：`knowledge.books` 就是表单里那一条', () => {
  it('勾选 + 手动添加 + 关闭弹层后保存 → books 含顺序、skills 不受牵连（B1 不回归）', async () => {
    await render('dev-1')
    await openForm()
    await openPicker()
    await click(pickRow('delivery-playbook'))
    await fill(one<HTMLInputElement>('.modal-md .picker-manual input')!, 'future-book')
    await click(button(t('picker.add'), dialog()))
    await click(button(t('picker.done'), dialog()))
    expect(one('.modal-md')).toBeNull()

    const save = button(t('common.save'), one('.drawer')!)
    expect(save.disabled).toBe(false)
    await click(save)

    expect(data.saved).toHaveLength(1)
    const input = data.saved[0] as RoleWriteInput
    expect(input.knowledge?.books).toEqual(['prism', 'delivery-playbook', 'future-book'])
    expect(input.skills).toEqual(['tech-doc'])
    expect(input.knowledge?.layers).toEqual(['project'])
  })
})
