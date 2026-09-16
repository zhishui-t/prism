// @vitest-environment happy-dom
/**
 * RolesPage 删除链路回归（**D-2**）—— 删除确认后，与该角色相关的浮层必须全关。
 *
 * 缺陷：详情抽屉里点「编辑」叠起表单抽屉 → 再点「删除」并在模态里确认 → 删除成功、
 * 列表与 toast 都正确刷新，但**表单抽屉留在 DOM 里**，继续显示已删角色的名称/描述
 * （`doDelete` 只做了 `navigate({page:'roles'})`，那只关详情抽屉——`form` 这份 state
 * 没人清）。实体已不存在，浮层必须一并关闭。
 *
 * ⚠ 与本页 R-6 Q1「**保存**成功不关抽屉」不冲突：Q1 管保存（实体仍在，反馈就地留在
 * 抽屉内），本文件管删除（实体已删）。两个方向各有一条用例，改动其一必惊动另一条。
 *
 * 渲染路径与 `teams-page-drawer.test.ts` / `knowledge-search-hit.test.ts` 一致：
 * happy-dom + 裸 `react-dom/client` + `react.act`，不引 @testing-library。
 * 根 vitest.config.ts 的 include 只收 `.test.ts`，故本文件不用 JSX，走 `createElement`。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用（每个用例重铺）。 */
const data = vi.hoisted(() => ({
  roles: [] as unknown[],
  /** 真被删掉的角色名，按调用序——收口自证用（防止「压根没删」造成的假绿）。 */
  deleted: [] as string[],
}))

vi.mock('../src/api-team.ts', () => ({
  // 表单里两个下拉的选项来自本模块的常量，模块被整体替身时必须一并给出（否则渲染即崩）。
  ROLE_COLOR_OPTIONS: ['red', 'blue'],
  THOUGHT_LEVELS: ['low', 'high', 'max'],
  teamApi: {
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    /** 单角色深链数据源：已删 → `null`（服务端真身是 404 信封 → 调用点 `.catch(() => null)`）。 */
    role: (name: string) =>
      Promise.resolve(data.roles.find((r) => (r as RoleDefinition).name === name) ?? null),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
    updateRole: () => Promise.resolve({ path: '/tmp/prism-roles/x.md', issues: [] }),
    /** 删除 = 真从列表里摘掉（teams 式 reload 必须能读到「空一个该角色」的列表）。 */
    deleteRole: (name: string) => {
      data.deleted.push(name)
      data.roles = data.roles.filter((r) => (r as RoleDefinition).name !== name)
      return Promise.resolve({ removed: [name] })
    },
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { RolesPage } from '../src/pages/Roles.tsx'

function role(name: string): RoleDefinition {
  return {
    name,
    description: `${name} 的描述`,
    skills: [],
    knowledge: { layers: ['project'] },
    principle: '先读再写',
    body: `# ${name}`,
  }
}

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

/** 卡片目录里的角色名（列表是否真刷新的唯一可读证据）。 */
function cardNames(): string[] {
  return all('.role-grid .role-name').map((n) => n.textContent ?? '')
}

function button(label: string): HTMLButtonElement {
  const hit = all('button').find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 受控输入：走原生 value setter 改值再派发 `input`（React 的受控值跟踪才认账）。 */
async function fill(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 走通「打开编辑表单抽屉」：详情抽屉在 → 点「编辑」→ 两个抽屉叠着。 */
async function openEditForm(): Promise<void> {
  await click(button(t('common.edit')))
  // 前置：编辑表单抽屉确实开在详情抽屉之上，否则下面的断言都是空谈
  expect(all('.drawer').length).toBe(2)
  expect(el<HTMLInputElement>('.drawer input')?.value).toBe('dev-1')
}

/** 走通删除确认：点详情抽屉的「删除」→ 模态点「删除」确认。 */
async function confirmDelete(): Promise<void> {
  await click(button(t('common.delete')))
  expect(el('.modal')).not.toBeNull()
  await click(button(t('common.confirmDelete')))
}

beforeEach(() => {
  setLang('zh')
  data.roles = [role('dev-1'), role('dev-2')]
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

describe('RolesPage 删除：浮层收口（D-2）', () => {
  it('删除成功后详情抽屉与编辑表单抽屉都关闭（旧代码：表单抽屉残留显示已删角色）', async () => {
    await render('dev-1')
    expect(el('.drawer')).not.toBeNull()
    await openEditForm()

    await confirmDelete()

    // 收口自证①：删除真发出去了（否则本用例可能是「没删，所以本来就没关」的假绿）
    expect(data.deleted).toEqual(['dev-1'])
    // 现有行为不回归：hash 回落到列表页（`doDelete` 里那条 `navigate`，清掉已删实体的选中）
    expect(window.location.hash).toBe('#/roles')
    // 收口自证②：确认模态已关（模态自己那条路径不回归）
    expect(el('.modal')).toBeNull()

    // 父级（Shell）按新 hash 重渲染 → `sel` 变 undefined（hash 是唯一选中真相）。
    // 少了这一步，页面停在「未命中 pane」上，格的断言都落在不可达状态里。
    await render('')

    // 收口自证③：列表已按 reload 结果刷新（被删的那张卡片消失），删除 toast 已就地渲染
    expect(cardNames()).toEqual(['dev-2'])
    expect(el('.banner.small')?.textContent).toContain('dev-1')

    // 主断言：实体已不存在 → 相关浮层一个都不留。旧代码这里是 1（编辑表单抽屉残留，
    // 里面还挂着已删角色的名称/描述）
    expect(all('.drawer').length).toBe(0)
  })

  it('保存成功仍**不**关抽屉（R-6 Q1 不回归，防止「关闭」被扩大到保存路径）', async () => {
    await render('dev-1')
    await openEditForm()

    await fill(el<HTMLTextAreaElement>('.drawer textarea')!, '改过的描述')
    const save = button(t('common.save'))
    // 前置：目录已回填，提交钮非禁用——否则下面的断言会「因没提交」而假红
    expect(save.disabled).toBe(false)
    await click(save)

    // Q1：保存成功就地反馈，抽屉照样开着（详情 + 表单，两扇）
    expect(el('.drawer .banner[role="status"]')?.textContent).toContain('dev-1')
    expect(all('.drawer').length).toBe(2)
    expect(data.deleted).toEqual([])
  })
})
