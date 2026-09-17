// @vitest-environment happy-dom
/**
 * v10 F2 角色详情：**抽屉 → 居中模态** + 正文 Markdown 渲染 + 信息区/正文区分割。
 *
 * 三条口径（design-v10「标准轨规格要点」F2 / 任务书 F2）：
 *  1. 详情是**居中模态**（`.modal-mask > .modal.modal-lg`），浮层语义仍复用 overlay-stack
 *     （Esc 仅栈顶关、Tab 圈闭、滚动锁）——本文件锁「详情不再是抽屉」与 Esc 的栈行为；
 *  2. 定义正文走 **Markdown 渲染器**（`.role-body .md-body.md-read`，与技能详情同一条路径），
 *     不再是 `<pre>` 原文；
 *  3. 信息区与正文区之间是**明显分割**（`.role-body` 的实色 hairline，值锁在
 *     `styles-role-modal.test.ts`；这里锁「正文区在信息区之后」的结构）。
 *
 * 渲染路径与 `roles-delete-drawer.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`，不引 @testing-library（根 vitest 的 include 只收 `.test.ts`，故不用 JSX）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用（每个用例重铺）。 */
const data = vi.hoisted(() => ({
  roles: [] as unknown[],
  deleted: [] as string[],
}))

vi.mock('../src/api-team.ts', () => ({
  // 表单里两个下拉的选项来自本模块的常量，模块被整体替身时必须一并给出（否则渲染即崩）
  ROLE_COLOR_OPTIONS: ['red', 'blue'],
  THOUGHT_LEVELS: ['low', 'high', 'max'],
  teamApi: {
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    role: (name: string) =>
      Promise.resolve(data.roles.find((r) => (r as RoleDefinition).name === name) ?? null),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
    updateRole: () => Promise.resolve({ path: '/tmp/prism-roles/x.md', issues: [] }),
    deleteRole: (name: string) => {
      data.deleted.push(name)
      data.roles = data.roles.filter((r) => (r as RoleDefinition).name !== name)
      return Promise.resolve({ removed: [name] })
    },
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { RolesPage } from '../src/pages/Roles.tsx'

/**
 * 两条角色覆盖本文件的两类正文：
 * - `dev-1` 有**多块 Markdown 正文**（heading / list / 强调 / 行内 code）；
 * - `dev-2` 正文为空串（走空态文案，不是渲染一个空容器）。
 * `role.body` 是 frontmatter 之后的正文（不含 description），故正文里刻意不放 frontmatter。
 */
function role(name: string, body: string): RoleDefinition {
  return {
    name,
    description: `${name} 的描述`,
    skills: [],
    knowledge: { layers: ['project'] },
    principle: '先读再写',
    body,
  }
}

const BODY = [
  '## 决策契约',
  '',
  '- 先定边界再谈实现',
  '- 冲突时牺牲速度',
  '',
  '原则：**方向未定不动手**，用 `prism role show` 复核。',
].join('\n')

let container: HTMLDivElement
let root: Root

/** 以给定深链选中态渲染（同一 root 重复调用 = 仅换 props，组件内部 state 保持不变）。 */
async function render(sel: string): Promise<void> {
  await act(async () => {
    root.render(createElement(RolesPage, { sel }))
  })
}

function el<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function button(label: string): HTMLButtonElement {
  const hit = all('button').find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

/** 详情模态（带 `-lg` 的那一个：确认框走 `.modal` 窄版，两者靠这个类分流）。 */
function detailModal(): Element | null {
  return el('.modal.modal-lg')
}

/** 确认模态（窄版 `.modal`）。 */
function confirmModal(): Element | null {
  return all('.modal').find((m) => !m.classList.contains('modal-lg')) ?? null
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
  data.roles = [role('dev-1', BODY), role('dev-2', '')]
  data.deleted = []
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

describe('v10 F2 详情 = 居中模态（不再是抽屉）', () => {
  it('详情渲染在 `.modal-mask > .modal.modal-lg`，且整页没有详情抽屉', async () => {
    await render('dev-1')

    const mask = el('.modal-mask')
    expect(mask).not.toBeNull()
    // 居中的唯一来源是 `.modal-mask` 的 flex 居中；面板是它的直接子节点
    expect(detailModal()?.parentElement).toBe(mask)
    // 详情不再走抽屉（编辑表单仍会另开一扇，那时才有 `.drawer`）
    expect(all('.drawer').length).toBe(0)
  })

  it('无障碍：`role="dialog"` + `aria-modal` + `aria-label`（标题是「色点 + 名字」的节点形态，读屏取不到）', async () => {
    await render('dev-1')

    const modal = detailModal()!
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    expect(modal.getAttribute('aria-label')).toBe('dev-1')
    expect(modal.querySelector('.modal-head h3')?.textContent).toContain('dev-1')
  })

  it('换选中：同一个模态跟着换内容（不是叠出第二层浮层）', async () => {
    await render('dev-1')
    const first = detailModal()

    await render('dev-2')

    expect(container.querySelectorAll('.modal.modal-lg').length).toBe(1)
    expect(detailModal()).toBe(first) // 同一个 DOM 节点（props 换、面板不重建）
    expect(detailModal()?.getAttribute('aria-label')).toBe('dev-2')
  })

  it('Esc 关详情：hash 回列表（hash 是选中唯一真相，R8）', async () => {
    await render('dev-1')

    await pressEscape()

    expect(window.location.hash).toBe('#/roles')
  })

  it('浮层栈：删除确认叠在详情模态上时，一次 Esc 只关确认（详情不动）', async () => {
    await render('dev-1')
    await click(button(t('common.delete')))
    expect(detailModal()).not.toBeNull()
    expect(confirmModal()).not.toBeNull()

    await pressEscape()

    expect(confirmModal()).toBeNull()
    expect(detailModal()).not.toBeNull()
    expect(window.location.hash).toBe('')
  })
})

describe('v10 F2 正文：Markdown 渲染（与技能详情同一渲染器）', () => {
  it('正文渲染出块级元素（heading / 列表 / 行内 code），不再是 `<pre>` 原文', async () => {
    await render('dev-1')

    const body = el('.role-body .md-body.md-read')
    expect(body).not.toBeNull()
    expect(body!.querySelector('h2.md-h2')?.textContent).toBe('决策契约')
    expect([...body!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '先定边界再谈实现',
      '冲突时牺牲速度',
    ])
    // 行内 code 与强调同样走渲染器
    expect(body!.querySelector('code.md-code')?.textContent).toBe('prism role show')
    expect(body!.querySelector('strong')?.textContent).toBe('方向未定不动手')
    // 旧实现是 `<pre>{role.body}</pre>`：正文区里不许再有裸 `<pre>`
    expect(el('.role-body pre')).toBeNull()
  })

  it('正文区分段头 + 描述全文都在（§1.5 #6 的信息没减）', async () => {
    await render('dev-1')

    expect(el('.role-body-head')?.textContent).toBe(t('roles.definitionBody'))
    expect(el('.role-body-desc')?.textContent).toBe('dev-1 的描述')
  })

  it('正文为空串 → 走空态文案，不渲染空的 Markdown 容器', async () => {
    await render('dev-2')

    expect(el('.role-body .md-body')).toBeNull()
    expect(el('.role-body')?.textContent).toContain(t('roles.bodyEmpty'))
  })
})

describe('v10 F2 分割：正文区排在信息区之后（值锁在 styles-role-modal）', () => {
  it('信息区（职责 / 原则 / 徽章 / 分段）在前，`.role-body` 是最后一节', async () => {
    await render('dev-1')

    const detail = el('.role-detail')!
    const kids = [...detail.children]
    // 第一眼带的零件（与卡面同构）确实在
    expect(detail.querySelector('.role-desc')).not.toBeNull()
    expect(detail.querySelector('.role-principle')).not.toBeNull()
    expect(detail.querySelector('.role-tags')).not.toBeNull()
    // 正文区是**最后**一节 ⇒ hairline 分隔的正是「信息区 ↓ 正文区」
    expect(kids.at(-1)).toBe(el('.role-body'))
    expect(kids.indexOf(detail.querySelector('.role-principle')!)).toBeLessThan(kids.indexOf(el('.role-body')!))
  })
})

describe('v10 F1 删除入口（详情内唯一一处）', () => {
  it('详情脚只有一个删除按钮（不新增第二处入口），且文案与 v9 回收站口径一致', async () => {
    await render('dev-1')

    const deletes = all('button').filter((b) => b.textContent?.trim() === t('common.delete'))
    expect(deletes.length).toBe(1)
    expect(el('.modal-foot')?.contains(deletes[0]!)).toBe(true)

    await click(deletes[0]!)

    // 确认文案：进回收站 + 3 天可恢复（不再是「硬删 / 不可撤销」）
    const body = confirmModal()?.querySelector('.modal-body')?.textContent ?? ''
    expect(body).toContain('回收站')
    expect(body).toContain('3 天')
    expect(confirmModal()?.querySelector('h3')?.textContent).toContain('dev-1')
  })

  it('确认 → 调既有删除 API → 列表刷新 + toast；详情模态收口（实体已不在）', async () => {
    await render('dev-1')
    await click(button(t('common.delete')))
    await click(button(t('common.confirmDelete')))

    // 收口自证：删除真发出去了
    expect(data.deleted).toEqual(['dev-1'])
    expect(window.location.hash).toBe('#/roles')

    // 父级（Shell）按新 hash 重渲染 → sel 变 undefined
    await render('')

    expect(el('.modal')).toBeNull()
    expect([...all('.role-grid .role-name')].map((n) => n.textContent)).toEqual(['dev-2'])
    expect(el('.banner.small')?.textContent).toContain('dev-1')
    // toast 文案同样对齐回收站口径
    expect(el('.banner.small')?.textContent).toContain('回收站')
  })
})
