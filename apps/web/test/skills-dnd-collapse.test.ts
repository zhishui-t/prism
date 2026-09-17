// @vitest-environment happy-dom
/**
 * v12 F4（W-7）技能页**拖拽归类 + 键盘替代 + 折叠记忆**的 DOM 契约。
 *
 * 三条口径（design-v12 F4「拖拽归类」「折叠」/ spec-v12 SPEC-4.6、4.7、4.8）：
 *  1. **拖拽（SPEC-4.6）**：技能卡是拖拽源（`draggable`），**整组**（组头 + 卡片网格）是落点；
 *     `dragover` 给组加 `.drop-target`（`dragleave` / `drop` / `dragend` 三处都摘）；`drop` 走
 *     `skillCategorize` 通道 → 刷新；**落到未分类组 = 清除**（载荷**省略 `category` 键**）；
 *     **同组放回 = 空操作**（不发请求——纯判据 `dropCategorizeCall` 返回 `null`）。
 *  2. **键盘替代（SPEC-4.7）**：详情弹窗内的分类下拉（未分类 + 清单全集）`change` → 同一条
 *     categorize 通道 → 刷新；无鼠标也能归类。
 *  3. **折叠记忆（SPEC-4.8）**：收起态存 `localStorage['skills-collapsed']`，**重挂载保持**；
 *     损坏 JSON **自愈**（回落空集 = 全展开，再切一次写回合法 JSON）；**改名时同步迁移**旧键。
 *
 * ⚠ **happy-dom 的 DragEvent 写法（复核 N-4）**：`new DragEvent(...)` **构造器不读
 * init 里的 `dataTransfer`**（实测构造后为 `undefined`），故构造完必须**手工赋属性**再 dispatch
 * （见 `dragEvent()`）。组件侧的载荷真相在 **React state**（`dragstart` 里记），`dataTransfer`
 * 只是原生 DnD 的旁路——所以 drop 事件不带 `dataTransfer` 也能被正确归类。
 *
 * 渲染路径与 `skills-groups-dom.test.ts` 一致（happy-dom + 裸 `react-dom/client` + `react.act`）。
 * 后端 categorize 通道在 **api 边界 mock**（组件侧零假设）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据（`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用）。 */
const data = vi.hoisted(() => ({
  /** 分类清单（组集与组序的权威来源；`docs` 与 `ui` 各 1 条，未分类 1 条）。 */
  categories: ['ui', 'docs'] as string[],
  skills: [
    { name: 'a-ui', description: 'A', builtin: true, category: 'ui' },
    { name: 'b-docs', description: 'B', builtin: true, category: 'docs' },
    { name: 'c-none', description: 'C', builtin: true },
  ] as Array<{ name: string; description: string; builtin: boolean; category?: string }>,
  /** 写操作调用台账。 */
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
    /**
     * categorize 通道的服务端等价物：`category` 缺省 = 清除（与
     * `SkillCategoryStore.categorize` 的「省略 / null / 空串」同档）。
     */
    skillCategorize: (input: { names: string[]; category?: string }) => {
      data.calls.push({ op: 'categorize', arg: input })
      const name = input.names[0] ?? ''
      data.skills = data.skills.map((s) =>
        s.name === name
          ? input.category === undefined
            ? { name: s.name, description: s.description, builtin: s.builtin }
            : { ...s, category: input.category }
          : s,
      )
      return Promise.resolve({
        category: input.category ?? null,
        updated: input.category === undefined ? [] : input.names,
        cleared: input.category === undefined ? input.names : [],
        categories: data.categories,
        mapping: {},
      })
    },
    skillCategoryRename: (input: { from: string; to: string }) => {
      data.calls.push({ op: 'rename', arg: input })
      data.categories = data.categories.map((c) => (c === input.from ? input.to : c))
      data.skills = data.skills.map((s) => (s.category === input.from ? { ...s, category: input.to } : s))
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
import { COLLAPSED_STORAGE_KEY } from '../src/pages/skills-logic.ts'
import { SkillsPage } from '../src/pages/Skills.tsx'

let container: HTMLDivElement
let root: Root

async function render(sel?: string): Promise<void> {
  await act(async () => {
    root.render(createElement(SkillsPage, { sel }))
  })
}

/** 空 act：把上一步 fire-and-forget 的 async 写操作（categorize）的微任务链抽干。 */
async function flush(): Promise<void> {
  await act(async () => {})
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

function labels(): string[] {
  return heads().map((h) => h.querySelector('.count-label')?.textContent ?? '')
}

function groupOf(label: string): HTMLElement {
  const head = heads().find((h) => h.querySelector('.count-label')?.textContent === label)
  if (head === undefined) throw new Error(`没有名为 ${label} 的组`)
  const group = head.closest('.skill-group')
  if (group === null) throw new Error('组头不在 .skill-group 内')
  return group as HTMLElement
}

/** 组内卡片名（文档序；色点 span 无文本）。 */
function rowNames(group: Element): string[] {
  return [...group.querySelectorAll('.role-card .role-name')].map((n) => n.textContent ?? '')
}

/** 按卡片名取卡片（名 = `.role-name` 的文本）。 */
function cardOf(name: string): HTMLElement {
  const hit = all('.md-list .role-card').find((c) => c.querySelector('.role-name')?.textContent === name)
  if (hit === undefined) throw new Error(`没有名为 ${name} 的卡片`)
  return hit as HTMLElement
}

/** 组头动作按钮（按可见文字或 `aria-label` 取，同 `skills-categories-dom.test.ts`）。 */
function groupButton(label: string, action: string): HTMLButtonElement {
  const hit = [...groupOf(label).querySelectorAll('.skill-group-actions button')].find(
    (b) => b.textContent?.trim() === action || b.getAttribute('aria-label') === action,
  )
  if (hit === undefined) throw new Error(`组「${label}」内没有动作按钮：${action}`)
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

/** 受控下拉：同样走原生 setter + `change`（React 对 select 也装了 value tracker）。 */
async function selectOption(target: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    if (setter !== undefined) setter.call(target, value)
    else target.value = value
    target.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function submit(form: Element): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

/**
 * 构造并派发 DnD 事件（复核 N-4 的写法）：happy-dom 的 `DragEvent` 构造器**不读**
 * `init.dataTransfer`（实测构造后为 `undefined`），故构造完**手工赋属性**。
 */
function dragEvent(type: string): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: () => {}, getData: () => '', effectAllowed: '', dropEffect: '' },
    configurable: true,
  })
  return event
}

async function drag(target: Element, type: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(dragEvent(type))
  })
}

function storedCollapsed(): string[] {
  return JSON.parse(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? '[]') as string[]
}

/** 整页重挂载（验证「重进页面保持」：新 root 只靠 localStorage 复原折叠态）。 */
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

/** 从 `a-ui`（ui 组）拖到目标组并落下。 */
async function dragTo(from: string, targetLabel: string): Promise<void> {
  await drag(cardOf(from), 'dragstart')
  await drag(groupOf(targetLabel), 'dragover')
  await drag(groupOf(targetLabel), 'drop')
  await flush()
}

beforeEach(() => {
  window.localStorage.clear()
  setLang('zh')
  data.categories = ['ui', 'docs']
  data.skills = [
    { name: 'a-ui', description: 'A', builtin: true, category: 'ui' },
    { name: 'b-docs', description: 'B', builtin: true, category: 'docs' },
    { name: 'c-none', description: 'C', builtin: true },
  ]
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

describe('SPEC-4.6 拖拽：拖起态 + 落点高亮与清理', () => {
  it('技能卡是拖拽源（`draggable="true"`）；组头不是（切换节点不可拖）', async () => {
    await render()
    expect(cardOf('a-ui').getAttribute('draggable')).toBe('true')
    expect(heads()[0]!.getAttribute('draggable')).toBeNull()
  })

  it('拖起的那张卡加 `.dragging`；`dragend` 摘掉（拖拽态不残留）', async () => {
    await render()
    expect(cardOf('a-ui').classList.contains('dragging')).toBe(false)

    await drag(cardOf('a-ui'), 'dragstart')
    expect(cardOf('a-ui').classList.contains('dragging')).toBe(true)
    // 只有被拖的那张有该类
    expect(all('.dragging').length).toBe(1)

    await drag(cardOf('a-ui'), 'dragend')
    expect(all('.dragging').length).toBe(0)
  })

  it('`dragover` 只高亮目标组（`.drop-target` 一处）；`dragleave` 摘干净', async () => {
    await render()
    await drag(cardOf('a-ui'), 'dragstart')

    await drag(groupOf('docs'), 'dragover')
    expect(groupOf('docs').classList.contains('drop-target')).toBe(true)
    expect(all('.drop-target').length).toBe(1)

    await drag(groupOf('docs'), 'dragleave')
    expect(all('.drop-target').length).toBe(0)
  })

  it('**没在拖技能卡时不接管**（宿主拖文件等不产生高亮 / 不会误 drop）', async () => {
    await render()
    // 没有 dragstart ⇒ `drag === null`：dragover 不高亮
    await drag(groupOf('docs'), 'dragover')
    expect(all('.drop-target').length).toBe(0)
  })
})

describe('SPEC-4.6 拖拽归类：drop → categorize 通道 → 刷新', () => {
  it('拖到已命名组：调 `skillCategorize({names, category})`，卡片移到该组、高亮摘掉', async () => {
    await render()
    expect(rowNames(groupOf('ui'))).toEqual(['a-ui'])

    await dragTo('a-ui', 'docs')

    expect(data.calls).toEqual([{ op: 'categorize', arg: { names: ['a-ui'], category: 'docs' } }])
    expect(rowNames(groupOf('docs'))).toEqual(['a-ui', 'b-docs'])
    expect(rowNames(groupOf('ui'))).toEqual([]) // ui 变成空分类组，照常成组
    expect(all('.drop-target').length).toBe(0)
  })

  it('拖到**未分类**组 = 清除：载荷**省略 `category` 键**（服务端的清除档）', async () => {
    await render()

    await dragTo('a-ui', t('skills.uncategorized'))

    const call = data.calls[0]!
    expect(call.op).toBe('categorize')
    expect(call.arg).toEqual({ names: ['a-ui'] })
    // 关键：不是 `{ category: '' }`，而是**没有该键**
    expect('category' in (call.arg as Record<string, unknown>)).toBe(false)
    expect(rowNames(groupOf(t('skills.uncategorized')))).toEqual(['a-ui', 'c-none'])
  })

  it('**同组放回 = 空操作**：不发请求、高亮照常摘掉', async () => {
    await render()
    await drag(cardOf('a-ui'), 'dragstart')
    await drag(groupOf('ui'), 'dragover')
    expect(groupOf('ui').classList.contains('drop-target')).toBe(true)

    await drag(groupOf('ui'), 'drop')
    await flush()

    expect(data.calls).toEqual([])
    expect(all('.drop-target').length).toBe(0)
    expect(rowNames(groupOf('ui'))).toEqual(['a-ui'])
  })

  it('分类组内**空白区**也是落点：空分类组（docs 先腾空）可承接落下的卡片', async () => {
    await render()
    // 先把 b-docs 清出 docs 组 ⇒ docs 变空分类组（只剩空态文案，没有卡片）
    await dragTo('b-docs', t('skills.uncategorized'))
    expect(rowNames(groupOf('docs'))).toEqual([])

    await dragTo('a-ui', 'docs')

    expect(rowNames(groupOf('docs'))).toEqual(['a-ui'])
    expect(data.calls.at(-1)).toEqual({ op: 'categorize', arg: { names: ['a-ui'], category: 'docs' } })
  })

  it('过滤态：未命中的分类组不渲染 ⇒ 不可能成为落点（列表面板只剩命中组）', async () => {
    await render()
    await fill(one<HTMLInputElement>('.role-filter')!, 'b-docs')

    expect(labels()).toEqual(['docs'])
    // 被过滤隐藏的组不在 DOM 里，自然没有 `.skill-group` / `.drop-target` 可落
    expect(all('.skill-group').length).toBe(1)
    expect(all('.drop-target').length).toBe(0)
  })
})

describe('SPEC-4.7 键盘替代：详情弹窗内的分类下拉', () => {
  it('下拉在场：选项 = 未分类 + 清单全集；受控值 = 该技能的生效分类', async () => {
    await render('a-ui')

    const select = one<HTMLSelectElement>('#skill-category-select')!
    expect(select).not.toBeNull()
    expect([...select.options].map((o) => o.value)).toEqual(['', 'ui', 'docs'])
    expect([...select.options].map((o) => o.textContent)).toEqual(['', 'ui', 'docs'].map((v) =>
      v === '' ? t('skills.uncategorized') : v,
    ))
    expect(select.value).toBe('ui')
  })

  it('change → categorize → 刷新；就地 `feedback` 报结果（无鼠标可归类）', async () => {
    await render('a-ui')

    await selectOption(one<HTMLSelectElement>('#skill-category-select')!, 'docs')
    await flush()

    expect(data.calls).toEqual([{ op: 'categorize', arg: { names: ['a-ui'], category: 'docs' } }])
    // 列表侧已刷新（卡片落到 docs）
    expect(rowNames(groupOf('docs'))).toEqual(['a-ui', 'b-docs'])
    // 反馈贴在详情里（页级提示条被浮层盖住）
    expect(one('.modal-lg .banner')?.textContent).toBe(t('skills.drag.moved', { name: 'a-ui', category: 'docs' }))
  })

  it('选「未分类」⇒ 清除档（载荷省略 `category`）', async () => {
    await render('a-ui')

    await selectOption(one<HTMLSelectElement>('#skill-category-select')!, '')
    await flush()

    const call = data.calls[0]!
    expect(call.arg).toEqual({ names: ['a-ui'] })
    expect('category' in (call.arg as Record<string, unknown>)).toBe(false)
    expect(one('.modal-lg .banner')?.textContent).toBe(t('skills.drag.cleared', { name: 'a-ui' }))
  })
})

describe('SPEC-4.8 折叠记忆：localStorage + 重挂载保持 + 损坏自愈 + 改名迁移', () => {
  it('点组头收起 ⇒ 写 `skills-collapsed`；**重挂载**后仍收起', async () => {
    await render()
    await click(groupOf('ui').querySelector('.skill-group-head')!)

    expect(groupOf('ui').querySelector('.skill-group-head')?.getAttribute('aria-expanded')).toBe('false')
    expect(storedCollapsed()).toEqual(['ui'])

    await remount()

    expect(groupOf('ui').querySelector('.skill-group-head')?.getAttribute('aria-expanded')).toBe('false')
    expect(groupOf('docs').querySelector('.skill-group-head')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('损坏 JSON **自愈**：渲染不抛、回落全展开；再切一次写回合法 JSON', async () => {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, '{ not json')

    await render()
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true'])

    await click(groupOf('docs').querySelector('.skill-group-head')!)
    expect(storedCollapsed()).toEqual(['docs'])
  })

  it('非数组 / 含非字符串项的存储值同样自愈（丢弃不可识别项）', async () => {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify({ ui: true }))
    await render()
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true'])
  })

  it('分类**改名时折叠键同步迁移**（旧名收起态搬到新名，不留残留键）', async () => {
    await render()
    await click(groupOf('ui').querySelector('.skill-group-head')!)
    expect(storedCollapsed()).toEqual(['ui'])

    await click(groupButton('ui', t('skills.category.rename')))
    await fill(one<HTMLInputElement>('.skill-group-rename .skill-cat-input')!, 'ui2')
    await submit(one('.skill-group-rename')!)
    await flush()

    expect(data.calls).toEqual([{ op: 'rename', arg: { from: 'ui', to: 'ui2' } }])
    expect(storedCollapsed()).toEqual(['ui2'])
    // 迁移后新名组仍处于收起态（迁移的是「收起」这件事，不是把组展开）
    expect(groupOf('ui2').querySelector('.skill-group-head')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('未分类组也可折叠并记住（键 = 哨兵空串）', async () => {
    await render()
    await click(groupOf(t('skills.uncategorized')).querySelector('.skill-group-head')!)

    expect(storedCollapsed()).toEqual([''])
    await remount()
    expect(groupOf(t('skills.uncategorized')).querySelector('.skill-group-head')?.getAttribute('aria-expanded')).toBe(
      'false',
    )
  })
})
