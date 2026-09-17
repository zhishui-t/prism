// @vitest-environment happy-dom
/**
 * v12 F3（W-4）团队详情 **pane → 居中弹窗**（SPEC-2.4 的第三处同 token 口径）。
 *
 * 四条口径（design-v12 F3 / spec-v12 SPEC-2.4）：
 *  1. **无选中 = 纯列表**：右栏（`.md-detail`）与「选择提示」Pane 一并消失，列表走单列（`.md.solo`）；
 *  2. **选中（hash 深链 `#/teams/<id>`）= 打开弹窗**：容器是 `<Modal size="lg">` ⇒
 *     `.modal-mask > .modal.modal-lg`（宽度 = 与角色/技能同一条 CSS 变量 `--modal-w`）；
 *  3. **关闭弹窗 = `onSelect('')`**（hash 是选中唯一真相，开关与它双向同步）；
 *  4. **叠加语义不变**：详情弹窗开着时点「编辑」开出表单抽屉，一次 Esc 只关**栈顶**那一层
 *     （浮层栈的既有契约；overlay-esc/traptab/stack 三个测试文件锁的是机制本身）。
 *
 * 渲染路径同 `teams-hierarchy.test.ts`（happy-dom + 裸 `react-dom/client` + `react.act`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition, TeamDefinition } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const data = vi.hoisted(() => ({ teams: [] as unknown[], roles: [] as unknown[] }))

vi.mock('../src/api-team.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api-team.ts')>()),
  teamApi: {
    teams: () => Promise.resolve({ teams: data.teams, teamsDir: '/tmp/prism-teams' }),
    team: (id: string) => Promise.resolve(data.teams.find((t) => (t as TeamDefinition).team_id === id)),
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { TeamsPage } from '../src/pages/teams/TeamsPage.tsx'

const ID = 'core-dev'

function team(id: string): TeamDefinition {
  return {
    team_id: id,
    name: '核心开发组',
    description: '从需求到交付的端到端编排。',
    default: false,
    members: [{ role: 'dev-1', count: 1 }],
    skills: [],
    knowledge: { layers: [] },
    deposit: {
      enabled: false,
      default_layer: 'project',
      default_type: 'other',
      priority: 'medium',
      require_note: false,
    },
    arbitration: [],
    workflow: [],
  }
}

let container: HTMLDivElement
let root: Root

async function render(sel: string, onSelect?: (id: string) => void): Promise<void> {
  await act(async () => {
    root.render(createElement(TeamsPage, { sel, onSelect }))
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

/** 在 `window` 上派发 Esc（浮层监听注册在 window 上，与真实按键同路）。 */
async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  setLang('zh')
  data.teams = [team(ID)]
  data.roles = [{ name: 'dev-1' } as RoleDefinition]
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

describe('SPEC-2.4 团队详情 = 居中弹窗（`.modal-lg`，与角色/技能同档）', () => {
  it('无选中 → 纯列表：没有 `.md-detail` 右栏、没有弹窗，列表走 `.md.solo` 单列', async () => {
    await render('')

    expect(one('.md.solo')).not.toBeNull()
    expect(one('.md-detail')).toBeNull()
    expect(one('.modal')).toBeNull()
    // 列表本体在场（不是「整页空掉」被误当通过）
    expect(all('.md-list .md-row').length).toBe(1)
  })

  it('深链选中 → `.modal-mask > .modal.modal-lg`，且详情不再走抽屉 / 右栏', async () => {
    await render(ID)

    const mask = one('.modal-mask')
    expect(mask).not.toBeNull()
    // 居中的唯一来源是 `.modal-mask` 的 flex 居中；面板是它的直接子节点
    expect(detailModal()?.parentElement).toBe(mask)
    expect(one('.md-detail')).toBeNull()
    expect(all('.drawer').length).toBe(0)
  })

  it('无障碍：`role="dialog"` + `aria-modal` + `aria-label`（面板头是 team_id 文本）', async () => {
    await render(ID)

    const modal = detailModal()!
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    expect(modal.getAttribute('aria-label')).toBe(ID)
    expect(modal.querySelector('.modal-head h3')?.textContent).toBe(ID)
  })
})

describe('SPEC-2.4 关闭弹窗 = `onSelect(\'\')`（开关与 hash 双向同步）', () => {
  it('头部关闭钮 → 回清选中', async () => {
    const calls: string[] = []
    await render(ID, (id) => calls.push(id))

    await click(button(t('common.close')))

    expect(calls).toEqual([''])
  })

  it('Esc（栈顶）→ 回清选中', async () => {
    const calls: string[] = []
    await render(ID, (id) => calls.push(id))

    await pressEscape()

    expect(calls).toEqual([''])
  })

  it('换选中：同一个弹窗跟着换内容（不是叠出第二层）', async () => {
    data.teams = [team(ID), team('ops')]
    await render(ID)
    const first = detailModal()

    await render('ops')

    expect(all('.modal.modal-lg').length).toBe(1)
    expect(detailModal()).toBe(first)
    expect(detailModal()?.getAttribute('aria-label')).toBe('ops')
  })
})

describe('浮层叠加：详情弹窗在下、表单抽屉在上，Esc 只关最顶层', () => {
  it('点详情「编辑」→ 抽屉压住弹窗；一次 Esc 关抽屉（弹窗不动），再按才清选中', async () => {
    const calls: string[] = []
    await render(ID, (id) => calls.push(id))

    await click(button(t('common.edit')))
    expect(all('.drawer').length).toBe(1)
    expect(detailModal()).not.toBeNull()

    await pressEscape()

    // 栈顶是抽屉 ⇒ 只关抽屉；详情弹窗与选中都不动（这正是 M1 修的那条）
    expect(all('.drawer').length).toBe(0)
    expect(detailModal()).not.toBeNull()
    expect(calls).toEqual([])

    await pressEscape()

    // 抽屉已关，弹窗升为栈顶 ⇒ 这次才清选中
    expect(calls).toEqual([''])
  })
})
