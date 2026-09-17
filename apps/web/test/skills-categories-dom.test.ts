// @vitest-environment happy-dom
/**
 * v12 F4（W-6）技能页**分类管理 + 组序**的 DOM 契约。
 *
 * 六条口径（design-v12 F4「API / 空分类的数据源 / 分类排序」+ spec-v12 SPEC-4.4、4.5、4.10）：
 *  1. **空分类成组**：清单里 0 条技能的分类照常出组头 + 计数 0 + 组内空态文案（SPEC-4.4）；
 *  2. **新建**：列表顶部就地表单 → `skillCategoryAdd({name})`；重名 409 就地报错、空名**不发请求**；
 *  3. **改名**：组头「改名」→ 就地输入（预填旧名）→ `skillCategoryRename({from,to})`；409 目标重名 /
 *     404 源不存在就地报错；同名是 no-op（不发请求）；成功后**以刷新后的服务端数据**为准级联；
 *  4. **删除**：组头「删除」→ `ConfirmModal`（文案说明「组内技能回未分类」）→
 *     `skillCategoryRemove(name)`；失败就地报错、模态不关；
 *  5. **组排序**（SPEC-4.10）：组头 ↑↓ 改序 + 存 `localStorage`；重挂载后保持；存储里的
 *     **残留名自愈**（已删除分类的名字被剪掉）；未分类组不参与（无动作位、恒末）；
 *  6. **过滤视图不留空组头**（空分类组在过滤时收起）。
 *
 * 渲染路径同 `skills-groups-dom.test.ts`（happy-dom + 裸 `react-dom/client` + `react.act`）。
 * 后端三条 CRUD 路由在本波次并行开发，故**调用在 api 边界 mock**——组件侧零假设，
 * B-2 落地后本文件零改动即接通。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据（`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用）。 */
const data = vi.hoisted(() => ({
  /** 分类清单（组集与组序的权威来源；`docs` 默认 0 条 ⇒ 空分类组）。 */
  categories: ['ui', 'docs'] as string[],
  skills: [
    { name: 'a-ui', description: 'A', builtin: true, category: 'ui' },
    { name: 'c-none', description: 'C', builtin: true },
  ] as Array<{ name: string; description: string; builtin: boolean; category?: string }>,
  /** 下一次分类写操作的失败（`Error.message` 形态 = `` `${code}: ${message}` ``）。 */
  fail: null as string | null,
  /** 分类写操作的调用台账（`{ op, arg }`）。 */
  calls: [] as Array<{ op: string; arg: unknown }>,
}))

vi.mock('../src/api-team.ts', () => ({
  teamApi: {
    skills: () => Promise.resolve({ skills: data.skills, skills_dir: '/tmp/prism-skills' }),
    skillUsage: () =>
      Promise.resolve(
        data.skills.map((s) => ({
          name: s.name,
          builtin: true,
          installed: true,
          roles: [],
          teams: [],
          ...(typeof s.category === 'string' ? { category: s.category } : {}),
        })),
      ),
    skillCategories: () => Promise.resolve({ categories: data.categories, mapping: {} }),
    skillCategoryAdd: (input: { name: string }) => {
      data.calls.push({ op: 'add', arg: input })
      if (data.fail !== null) return Promise.reject(new Error(data.fail))
      data.categories = [...data.categories, input.name]
      return Promise.resolve({ categories: data.categories, mapping: {} })
    },
    skillCategoryRename: (input: { from: string; to: string }) => {
      data.calls.push({ op: 'rename', arg: input })
      if (data.fail !== null) return Promise.reject(new Error(data.fail))
      data.categories = data.categories.map((c) => (c === input.from ? input.to : c))
      // 服务端 `mapping` 级联的等价物：组内技能的展示分类跟着改名（web 侧只看刷新后的结果）
      data.skills = data.skills.map((s) => (s.category === input.from ? { ...s, category: input.to } : s))
      return Promise.resolve({ categories: data.categories, mapping: {} })
    },
    skillCategoryRemove: (name: string) => {
      data.calls.push({ op: 'remove', arg: name })
      if (data.fail !== null) return Promise.reject(new Error(data.fail))
      data.categories = data.categories.filter((c) => c !== name)
      data.skills = data.skills.map((s) => (s.category === name ? { ...s, category: undefined } : s))
      return Promise.resolve({ categories: data.categories, mapping: {} })
    },
    skill: (name: string) =>
      Promise.resolve({
        name,
        description: `${name} 的说明`,
        builtin: true,
        installed: true,
        path: `/tmp/prism-skills/${name}/SKILL.md`,
        roles: [],
        teams: [],
        content: `# ${name}\n`,
      }),
    skillInstall: () => Promise.resolve({ skills_dir: '/tmp/prism-skills', written: [], skipped: [] }),
    skillUninstall: () => Promise.resolve({ skills_dir: '/tmp/prism-skills', removed: [], kept: [] }),
    // 详情切「有效集」时才会用到；本文件不切，但模块被整体替身时必须给出，否则渲染即崩
    roles: () => Promise.resolve({ roles: [], rolesDir: '/tmp/prism-roles' }),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { GROUP_ORDER_STORAGE_KEY } from '../src/pages/skills-logic.ts'
import { SkillsPage } from '../src/pages/Skills.tsx'

let container: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(SkillsPage, {}))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function heads(): HTMLElement[] {
  return all('.skill-group-head') as HTMLElement[]
}

/** 组头标签（组名 = 分类名原文；未分类组走字典）。 */
function labels(): string[] {
  return heads().map((h) => h.querySelector('.count-label')?.textContent ?? '')
}

/** 组头计数（文档序）。 */
function counts(): string[] {
  return heads().map((h) => h.querySelector('.count-num')?.textContent ?? '')
}

function groupOf(label: string): Element {
  const head = heads().find((h) => h.querySelector('.count-label')?.textContent === label)
  if (head === undefined) throw new Error(`没有名为 ${label} 的组`)
  const group = head.closest('.skill-group')
  if (group === null) throw new Error('组头不在 .skill-group 内')
  return group
}

/** 组内卡片名（文档序；分类色点 span 无文本）。 */
function rowNames(group: Element): string[] {
  return [...group.querySelectorAll('.role-card .role-name')].map((n) => n.textContent ?? '')
}

/**
 * 组头动作按钮：按**可见文字**取；`↑`/`↓` 的字面是箭头、语义文字在 `aria-label` / `title` 上，
 * 故两者都认（`t('skills.category.moveUp')` 对箭头钮走 `aria-label`）。
 */
function groupButton(label: string, action: string): HTMLButtonElement {
  const hit = [...groupOf(label).querySelectorAll('.skill-group-actions button')].find(
    (b) => b.textContent?.trim() === action || b.getAttribute('aria-label') === action,
  )
  if (hit === undefined) throw new Error(`组「${label}」内没有动作按钮：${action}`)
  return hit as HTMLButtonElement
}

/** 全文档按标签取按钮（可选范围）。 */
function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const hit = [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

async function click(target: Element): Promise<void> {
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

/** 提交表单（原生 `submit` 事件；React 的 `onSubmit` 才被触发）。 */
async function submit(form: Element): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/** 确认框（窄版 `.modal`，无 `-lg`；详情弹窗本文件不开）。 */
function confirmModal(): Element | null {
  return all('.modal').find((m) => !m.classList.contains('modal-lg')) ?? null
}

function storedOrder(): string[] {
  return JSON.parse(window.localStorage.getItem(GROUP_ORDER_STORAGE_KEY) ?? '[]') as string[]
}

/** 整页重挂载（验证「刷新后保持」：新 root 只靠 localStorage 复原组序）。 */
async function remount(): Promise<void> {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await render()
}

beforeEach(() => {
  window.localStorage.clear()
  setLang('zh')
  data.categories = ['ui', 'docs']
  data.skills = [
    { name: 'a-ui', description: 'A', builtin: true, category: 'ui' },
    { name: 'c-none', description: 'C', builtin: true },
  ]
  data.fail = null
  data.calls = []
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

describe('SPEC-4.4 空分类成组：组头 + 计数 0 + 组内空态', () => {
  it('清单里的空分类照常出组头，计数 0、组内一句空态（不是空白网格）', async () => {
    await render()

    expect(labels()).toEqual(['ui', 'docs', t('skills.uncategorized')])
    expect(counts()).toEqual(['1', '0', '1'])

    const docs = groupOf('docs')
    expect(docs.querySelector('.skill-group-empty')?.textContent).toBe(t('skills.category.empty'))
    expect(rowNames(docs)).toEqual([])
    // 空组照常可折叠（组头没被空态吃掉）
    expect(docs.querySelector('.skill-group-head')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('未分类组**恒在末尾**且没有管理动作位（不可改名 / 不可删 / 不参与排序）', async () => {
    await render()

    const uncat = groupOf(t('skills.uncategorized'))
    expect(uncat.querySelectorAll('.skill-group-actions').length).toBe(0)
    // 已命名组各有一个动作区（ui / docs 两组）
    expect(all('.skill-group-actions').length).toBe(2)
  })
})

describe('SPEC-4.10 组排序：↑↓ 改序 + localStorage 记忆 + 残留自愈', () => {
  it('点 ↓ 后组序变化，并写进 localStorage', async () => {
    await render()
    expect(labels()).toEqual(['ui', 'docs', t('skills.uncategorized')])

    await click(groupButton('ui', t('skills.category.moveDown')))

    expect(labels()).toEqual(['docs', 'ui', t('skills.uncategorized')])
    expect(storedOrder()).toEqual(['docs', 'ui'])
  })

  it('**刷新后保持**：整页重挂载仍按存储的组序渲染', async () => {
    await render()
    await click(groupButton('ui', t('skills.category.moveDown')))
    expect(labels()).toEqual(['docs', 'ui', t('skills.uncategorized')])

    await remount()

    expect(labels()).toEqual(['docs', 'ui', t('skills.uncategorized')])
  })

  it('两端禁用：首组不能上移、末组不能下移（未分类不在可排序集合里）', async () => {
    await render()

    expect(groupButton('ui', t('skills.category.moveUp')).disabled).toBe(true)
    expect(groupButton('docs', t('skills.category.moveDown')).disabled).toBe(true)
    // 非两端的不禁
    expect(groupButton('ui', t('skills.category.moveDown')).disabled).toBe(false)
  })

  it('**残留键自愈**：存储里的已删除分类名被剪掉（渲染不受影响，存储被归一化写回）', async () => {
    window.localStorage.setItem(GROUP_ORDER_STORAGE_KEY, JSON.stringify(['ghost', 'docs', 'ui']))

    await render()

    // 顺序仍按存储里**有效**的部分（docs 在 ui 前），ghost 不影响任何分组
    expect(labels()).toEqual(['docs', 'ui', t('skills.uncategorized')])
    expect(storedOrder()).toEqual(['docs', 'ui'])
  })

  it('新分类缺省排**已命名组末尾**（存储里有旧序时，新名跟在后面而不是插到最前）', async () => {
    window.localStorage.setItem(GROUP_ORDER_STORAGE_KEY, JSON.stringify(['docs', 'ui']))

    await render()
    await click(button(t('skills.category.add')))
    await fill(one<HTMLInputElement>('.skill-cat-manage .skill-cat-input')!, 'fresh')
    await submit(one('.skill-cat-manage form')!)

    expect(labels()).toEqual(['docs', 'ui', 'fresh', t('skills.uncategorized')])
  })
})

describe('SPEC-4.4 新建分类：就地表单 → POST → 刷新', () => {
  it('入口 → 输入 → 创建：调用 `skillCategoryAdd({name})`，刷新后新组出现并给页级提示', async () => {
    await render()

    await click(button(t('skills.category.add')))
    expect(one('.skill-cat-manage form')).not.toBeNull()
    await fill(one<HTMLInputElement>('.skill-cat-manage .skill-cat-input')!, 'fresh')
    await submit(one('.skill-cat-manage form')!)

    expect(data.calls).toEqual([{ op: 'add', arg: { name: 'fresh' } }])
    expect(labels()).toEqual(['ui', 'docs', 'fresh', t('skills.uncategorized')])
    expect(one('.banner[role="status"]')?.textContent).toBe(t('skills.category.addDone', { name: 'fresh' }))
    // 提交成功后表单收口（回到入口按钮）
    expect(one('.skill-cat-manage form')).toBeNull()
  })

  it('名字 trim 后为空 ⇒ **不发请求**，就地报 `err.empty`', async () => {
    await render()
    await click(button(t('skills.category.add')))

    await fill(one<HTMLInputElement>('.skill-cat-manage .skill-cat-input')!, '   ')
    await submit(one('.skill-cat-manage form')!)

    expect(data.calls).toEqual([])
    expect(one('.skill-cat-manage .err-text')?.textContent).toBe(t('skills.category.err.empty'))
  })

  it('409 重名 ⇒ 就地报 `err.exists`，表单不关（可改名重试）', async () => {
    data.fail = 'id_conflict: category already exists'
    await render()
    await click(button(t('skills.category.add')))
    await fill(one<HTMLInputElement>('.skill-cat-manage .skill-cat-input')!, 'ui')
    await submit(one('.skill-cat-manage form')!)

    expect(data.calls).toEqual([{ op: 'add', arg: { name: 'ui' } }])
    expect(one('.skill-cat-manage .err-text')?.textContent).toBe(t('skills.category.err.exists'))
    expect(one('.skill-cat-manage form')).not.toBeNull()
  })
})

describe('SPEC-4.5 改名：就地输入 → PATCH（`from` 走路径段、`to` 走 body）', () => {
  it('预填旧名；成功后以**刷新后的服务端数据**为准（组名与组内技能一起级联）', async () => {
    await render()

    await click(groupButton('ui', t('skills.category.rename')))
    const input = one<HTMLInputElement>('.skill-group-rename .skill-cat-input')!
    expect(input.value).toBe('ui')
    await fill(input, 'ui2')
    await submit(one('.skill-group-rename')!)

    expect(data.calls).toEqual([{ op: 'rename', arg: { from: 'ui', to: 'ui2' } }])
    // 组名改了，且组内技能跟着走（数据来自刷新后的 GET，不是本地臆测）；
    // 位置不变 ⇒ ui2 仍在 docs 之前（服务端 `renameCategory` 原位保序）
    expect(labels()).toEqual(['ui2', 'docs', t('skills.uncategorized')])
    expect(rowNames(groupOf('ui2'))).toEqual(['a-ui'])
    expect(one('.banner[role="status"]')?.textContent).toBe(t('skills.category.renameDone', { from: 'ui', to: 'ui2' }))
  })

  it('409 目标重名 ⇒ 就地报 `err.targetExists`（与新建的「已存在」是两条不同出路）', async () => {
    data.fail = 'id_conflict: target exists'
    await render()

    await click(groupButton('ui', t('skills.category.rename')))
    await fill(one<HTMLInputElement>('.skill-group-rename .skill-cat-input')!, 'docs')
    await submit(one('.skill-group-rename')!)

    expect(one('.skill-group-rename .err-text')?.textContent).toBe(t('skills.category.err.targetExists'))
    expect(one('.skill-group-rename')).not.toBeNull()
  })

  it('404 源不存在 ⇒ 就地报 `err.missing`', async () => {
    data.fail = 'not_found: category not found'
    await render()

    await click(groupButton('ui', t('skills.category.rename')))
    await fill(one<HTMLInputElement>('.skill-group-rename .skill-cat-input')!, 'ui2')
    await submit(one('.skill-group-rename')!)

    expect(one('.skill-group-rename .err-text')?.textContent).toBe(t('skills.category.err.missing'))
  })

  it('同名 ⇒ no-op：**不发请求**、表单直接收口', async () => {
    await render()

    await click(groupButton('ui', t('skills.category.rename')))
    await submit(one('.skill-group-rename')!)

    expect(data.calls).toEqual([])
    expect(one('.skill-group-rename')).toBeNull()
    expect(labels()).toEqual(['ui', 'docs', t('skills.uncategorized')])
  })

  it('空新名 ⇒ 不发请求，就地报 `err.empty`', async () => {
    await render()

    await click(groupButton('ui', t('skills.category.rename')))
    await fill(one<HTMLInputElement>('.skill-group-rename .skill-cat-input')!, '  ')
    await submit(one('.skill-group-rename')!)

    expect(data.calls).toEqual([])
    expect(one('.skill-group-rename .err-text')?.textContent).toBe(t('skills.category.err.empty'))
  })
})

describe('SPEC-4.5 删除：确认弹窗（组内技能回未分类）→ DELETE → 刷新', () => {
  it('点删除 → 确认框带分类名与「回未分类」文案；确认后组消失、技能落未分类', async () => {
    await render()

    await click(groupButton('ui', t('skills.category.remove')))
    const modal = confirmModal()
    expect(modal).not.toBeNull()
    expect(modal!.querySelector('h3')?.textContent).toBe(t('skills.category.removeTitle', { name: 'ui' }))
    expect(modal!.textContent).toContain(t('skills.category.removeBody'))

    await click(button(t('common.confirmDelete'), modal!))

    expect(data.calls).toEqual([{ op: 'remove', arg: 'ui' }])
    expect(labels()).toEqual(['docs', t('skills.uncategorized')])
    // 组内技能回未分类（服务端清 mapping 的等价物；技能本身还在）
    expect(rowNames(groupOf(t('skills.uncategorized')))).toEqual(['a-ui', 'c-none'])
    expect(one('.banner[role="status"]')?.textContent).toBe(t('skills.category.removeDone', { name: 'ui' }))
    expect(confirmModal()).toBeNull()
  })

  it('取消不调 API（分类不动）', async () => {
    await render()

    await click(groupButton('ui', t('skills.category.remove')))
    await click(button(t('common.cancel'), confirmModal()!))

    expect(data.calls).toEqual([])
    expect(confirmModal()).toBeNull()
    expect(labels()).toEqual(['ui', 'docs', t('skills.uncategorized')])
  })

  it('404 源不存在 ⇒ 确认框就地报错且不关（人还在破坏性动作的确认面上）', async () => {
    data.fail = 'not_found: category not found'
    await render()

    await click(groupButton('ui', t('skills.category.remove')))
    await click(button(t('common.confirmDelete'), confirmModal()!))

    expect(confirmModal()).not.toBeNull()
    expect(confirmModal()!.querySelector('.error')?.textContent).toBe(t('skills.category.err.missing'))
    expect(labels()).toEqual(['ui', 'docs', t('skills.uncategorized')])
  })
})

describe('过滤视图：空分类组连组头一起收起（与「某组空了不留空壳」同口径）', () => {
  it('过滤到只剩 ui 组时，空的 docs 组不渲染', async () => {
    await render()
    expect(labels()).toEqual(['ui', 'docs', t('skills.uncategorized')])

    await fill(one<HTMLInputElement>('.role-filter')!, 'a-ui')

    expect(labels()).toEqual(['ui'])
    expect(counts()).toEqual(['1'])
  })
})
