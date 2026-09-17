// @vitest-environment happy-dom
/**
 * v12 F3（W-4）**展示面纯 id**：团队 `name` 字段在 UI 零展示（SPEC-3.1）。
 *
 * 四条口径（design-v12 F3 / spec-v12 SPEC-3.1）：
 *  1. **列表**：行主标题只有 `team_id`（此前是「name + muted team_id」两截）；
 *  2. **详情**：弹窗里（面板头 / 描述 / 工作流 / 名册 / 深挖折叠 / 删除确认）不含 `name`；
 *  3. **搜索**：按 `team_id` / `description` 匹配——`name` 已不可见，就不再是搜索键
 *     （「搜得到却看不见那条为什么命中」＝假命中）；
 *  4. **确认弹窗文案**：删团队用的仍是 `id`（标题 / 正文 / 手打闸门标签），不冒 name。
 *
 * ⚠ 本文件测的是**展示面**：`TeamForm` 的 name 输入与 `nameRequired` 校验**不在**去 name 的范围
 * （SPEC-3.2「数据面零改动」——表单里 name 仍必填、仍往返）；表单断言在
 * `teams-workflow-orchestrator.test.ts` / `teams-page-drawer.test.ts`，此处不重复也不削弱。
 *
 * 渲染路径同 `teams-hierarchy.test.ts`：happy-dom + 裸 `react-dom/client` + `react.act`，
 * 不引 @testing-library（根 vitest 的 include 只收 `.test.ts`，故不用 JSX）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition, TeamDefinition } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用（每个用例重铺）。 */
const data = vi.hoisted(() => ({ teams: [] as unknown[], roles: [] as unknown[] }))

vi.mock('../src/api-team.ts', async (importOriginal) => ({
  // 部分 mock（同 `teams-hierarchy.test.ts`）：只换 `teamApi`，常量走真身。
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

/** name ≠ id 是本文件全部断言的前提（相等的话「不含 name」会退化成恒真）。 */
const ID = 'core-dev'
const NAME = '核心开发组'

function team(id: string, name: string, description = ''): TeamDefinition {
  return {
    team_id: id,
    name,
    description,
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

async function render(sel: string): Promise<void> {
  await act(async () => {
    root.render(createElement(TeamsPage, { sel }))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
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
async function fill(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 HTMLInputElement#value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** 搜索框（列表里唯一的输入框——`md-list` 顶部那颗）。 */
function filterBox(): HTMLInputElement {
  const hit = one<HTMLInputElement>('.md-list input')
  if (hit === null) throw new Error('未找到筛选输入框')
  return hit
}

beforeEach(() => {
  setLang('zh')
  data.teams = [team(ID, NAME, '从需求到交付的端到端编排。'), team('ops', '运维值班组', '线上值守。')]
  data.roles = [{ name: 'dev-1' } as RoleDefinition]
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

describe('SPEC-3.1 列表：行主标题只有 team_id，name 零展示', () => {
  it('两行都只显示 id（前置自证：name≠id，且 name 在整页文本里零命中）', async () => {
    // 前置：夹具确实 name≠id，否则下面的「不含 name」是恒真断言
    expect(NAME).not.toBe(ID)

    await render('')

    const titles = all('.md-list .md-row .t').map((n) => n.textContent)
    expect(titles).toEqual([ID, 'ops'])
    expect(container.textContent).not.toContain(NAME)
  })
})

describe('SPEC-3.1 详情弹窗：面板 / 工作流 / 名册 / 深挖折叠都不含 name', () => {
  it('选中深链 → 弹窗整块文本不含 name，标题是 team_id', async () => {
    await render(ID)

    const modal = one('.modal.modal-lg')
    expect(modal).not.toBeNull()
    expect(modal!.querySelector('.modal-head h3')?.textContent).toBe(ID)
    expect(modal!.textContent).not.toContain(NAME)
    // 面板头的旧「名字 + muted team_id」两截已删（身份只在弹窗标题那一处）
    expect(one('.modal-content .swap-in > .pane > .pane-head h3')).toBeNull()
  })
})

describe('SPEC-3.1 搜索：按 id 命中；name 不再是搜索键（description 仍可搜）', () => {
  it('按 team_id 片段能搜中', async () => {
    await render('')
    await fill(filterBox(), 'core')
    expect(all('.md-list .md-row .t').map((n) => n.textContent)).toEqual([ID])
  })

  it('按 name 片段搜不到（用户看不见 name，就不该被它命中）', async () => {
    await render('')
    await fill(filterBox(), '核心')
    expect(all('.md-list .md-row').length).toBe(0)
    // 收口自证：确实走了「无结果」那条路，而不是列表压根没渲染
    expect(all('.md-list .small.muted').map((n) => n.textContent)).toContain(t('common.empty'))
  })

  it('description 仍是搜索键（去掉的只有 name）', async () => {
    await render('')
    await fill(filterBox(), '值守')
    expect(all('.md-list .md-row .t').map((n) => n.textContent)).toEqual(['ops'])
  })
})

describe('SPEC-3.1 删除确认弹窗：文案只用 team_id', () => {
  it('标题 / 正文 / 手打闸门标签都含 id、不含 name', async () => {
    await render(ID)

    await click(button(t('common.delete')))

    // 确认弹窗是窄版 `.modal`（详情弹窗是 `.modal-lg`），两者靠类分流
    const confirm = all('.modal').find((m) => !m.classList.contains('modal-lg'))
    expect(confirm, '删除确认弹窗没开').toBeDefined()
    const text = confirm!.textContent ?? ''
    expect(text).toContain(ID)
    expect(text).not.toContain(NAME)
    expect(confirm!.querySelector('h3')?.textContent).toBe(t('teams.delete.title', { id: ID }))
  })
})
