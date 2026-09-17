// @vitest-environment happy-dom
/**
 * TeamsPage 抽屉回归（两组）：
 *
 * 1. **意图**（R-8-4）：**选中团队 ≠ 编辑意图**。
 *    缺陷：`formOpen` 布尔被「+ 新建团队」（页头）与「编辑」（详情）两个入口共用，抽屉里
 *    开哪种表单只能按「当前有没有选中」猜 → 选中某团队（`#/teams/<id>`）时点「+ 新建团队」，
 *    开出的是**编辑表单**。镜像面：编辑意图 + 详情未就绪时静默落进 create 分支。
 * 2. **关闭链路**（M3，见文件末尾）：创建成功后关抽屉切选中的三处断裂——取消钮绕过冲刷
 *    丢选中 / 陈旧 `pendingSelect` 泄漏到之后无关的关闭 / reload 在途时守卫用旧列表清选中。
 *
 * 这里不引 @testing-library：happy-dom + 裸 `react-dom/client` + `react.act` 足够，
 * 断言直接读 DOM（该应用此前零组件测试，本文件同时确立这条最小渲染路径）。
 * 根 vitest.config.ts 的 include 只收 `.test.ts`，故本文件不用 JSX，走 `createElement`。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition, TeamDefinition } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用（每个用例重铺）。 */
const data = vi.hoisted(() => ({
  teams: [] as unknown[],
  roles: [] as unknown[],
  /**
   * 非 null 时 `teams()` 返回前先 await 它——用例 C 的**时序闸门**：把 `teams.reload()`
   * 卡在途（`teams.loading === true`），而 `teams.data` 仍是**旧列表**（不含刚创建的 id）。
   */
  teamsGate: null as Promise<void> | null,
  /**
   * 置真时 `teams()` 抛错——用例 D 的**失败注入**：reload 落定但失败（error 置位、
   * `data` 停在旧列表），守卫不得拿这份旧列表清掉刚落的选中（复检 MINOR-①）。
   */
  teamsFail: false,
}))

vi.mock('../src/api-team.ts', async (importOriginal) => ({
  // 部分 mock：只换 `teamApi`，其余（v11 F2 起页面还会 import 列名同义词表等常量）保持真身。
  // 全量替换会让「页面 import 了某个新常量」变成一条与本用例无关的假红。
  ...(await importOriginal<typeof import('../src/api-team.ts')>()),
  teamApi: {
    teams: async () => {
      const gate = data.teamsGate
      if (gate !== null) await gate
      if (data.teamsFail) throw new Error('teams_dir_unreadable: 模拟列表重载失败')
      return { teams: data.teams, teamsDir: '/tmp/prism-teams' }
    },
    team: (id: string) =>
      Promise.resolve(data.teams.find((team) => (team as TeamDefinition).team_id === id)),
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    /**
     * 创建只回执「成功 + 落盘路径」，**不把新团队塞进 `data.teams`**：列表是否含新 id
     * 由各用例自己控——用例 C 要的正是「reload 后列表仍旧不含新 id」。
     */
    create: () => Promise.resolve({ ok: true, path: '/tmp/prism-teams/new.md', issues: [] }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { TeamsPage } from '../src/pages/teams/TeamsPage.tsx'

function team(id: string, name: string): TeamDefinition {
  return {
    team_id: id,
    name,
    description: '',
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

/** 以给定深链选中态渲染（同一 root 重复调用 = 仅换 props，组件内部 state 保持不变）。 */
async function render(sel: string, onSelect?: (id: string) => void): Promise<void> {
  await act(async () => {
    root.render(createElement(TeamsPage, { sel, onSelect }))
  })
}

function el<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function button(label: string): HTMLButtonElement {
  const hit = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit
}

function input(selector: string): HTMLInputElement {
  const hit = el<HTMLInputElement>(selector)
  if (hit === null) throw new Error(`未找到输入框：${selector}`)
  return hit
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

/** Esc 关抽屉：走 Drawer → useOverlayLayer → onClose 这条真实路径。 */
async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

/** 受控 Promise：用例里显式放行，不靠 sleep / 时序猜测。 */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * 走通创建：点「+ 新建团队」→ 填 ID / 名称 → 提交。
 * 成功后触发 `onCreated`（⇒ `pendingSelect` 置位 + `teams.reload()`），抽屉**不关**（R-6 Q1）。
 */
async function createTeam(id: string): Promise<void> {
  await click(button(t('teams.new')))
  await fill(input('#ntf-teamId'), id)
  await fill(input('#ntf-name'), `团队${id}`)
  const submit = button(t('teams.form.submitNew'))
  // 前置：角色/目录/成员都就绪，提交钮非禁用——否则下面的断言会「因没提交」而假红
  expect(submit.disabled).toBe(false)
  await click(submit)
  // 收口自证：成功文案（含 id）已就地渲染 ⇒ `onCreated` 必然已触发（`pendingSelect` 已置位）。
  // 缺了这条，用例可能「因为压根没创建成功」而假绿。
  expect(el('.drawer .banner[role="status"]')?.textContent).toContain(id)
}

beforeEach(() => {
  setLang('zh')
  data.teams = [team('t-a', '团队甲'), team('t-b', '团队乙')]
  data.roles = [{ name: 'dev-1' } as RoleDefinition, { name: 'tester' } as RoleDefinition]
  data.teamsGate = null
  data.teamsFail = false
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

describe('TeamsPage 抽屉意图（create / edit 分状态）', () => {
  it('未点任何入口 → 不开抽屉', async () => {
    await render('t-a')
    expect(el('.drawer')).toBeNull()
  })

  it('选中团队时点「+ 新建团队」→ 开的是**空的新建表单**，不是编辑表单（R-8-4 主回归）', async () => {
    await render('t-a')
    // 前置：详情确实已就绪（「编辑」按钮只在 detail 到手后才渲染），否则本用例断言不成立
    expect(button(t('common.edit'))).not.toBeUndefined()

    await click(button(t('teams.new')))

    // 标题按**意图**给（此前按 selected → 会显示「编辑团队 › t-a」）
    expect(el('.drawer-head h3')?.textContent).toBe(t('teams.form.new'))
    // create 形态：新建独有的「团队 ID」字段在（`ntf-` 前缀 = create，见 TeamForm 的 idPrefix）
    const idInput = el<HTMLInputElement>('#ntf-teamId')
    expect(idInput).not.toBeNull()
    // 空表单：不因「恰好选中了 t-a」而预填任何东西
    expect(idInput?.value).toBe('')
    expect(el<HTMLInputElement>('#ntf-name')?.value).toBe('')
    // edit 形态的标识不在（`etf-` 前缀 = edit）
    expect(el('#etf-name')).toBeNull()
    expect(el('#etf-description')).toBeNull()
  })

  it('详情点「编辑」→ 仍是编辑表单（反向不回归），并回填该团队', async () => {
    await render('t-a')

    await click(button(t('common.edit')))

    expect(el('.drawer-head h3')?.textContent).toBe(`${t('teams.form.edit')} › t-a`)
    expect(el<HTMLInputElement>('#etf-name')?.value).toBe('团队甲')
    expect(el('#ntf-teamId')).toBeNull()
  })

  it('编辑意图 + 详情回落未就绪（选中被清空）→ 显式加载占位，绝不静默换成 create 表单', async () => {
    await render('t-a')
    await click(button(t('common.edit')))
    expect(el('#etf-name')).not.toBeNull()

    // 抽屉开着时选中被清空（hash 回到 `#/teams`，如浏览器后退）→ `detail.data` 回落 undefined
    await render('')

    expect(el('#etf-name')).toBeNull()
    expect(el('#ntf-teamId')).toBeNull()
    expect(el('.drawer .skeleton[role="status"]')?.getAttribute('aria-label')).toBe(t('common.loading'))
  })
})

/**
 * M3：创建成功 → 关闭抽屉 → 切选中，这条链路此前有三处断裂（检视探针实测）：
 *
 * ① 创建成功后点**表单内**「取消」（TeamForm 自带取消钮 → `onCancel`）→ 旧的
 *    `onCancel={() => setFormIntent(null)}` 绕过 `pendingSelect` 冲刷 → **丢选中**；
 * ② 同一绕过路径留下的**陈旧 `pendingSelect`**：之后任何一次无关关闭（如 Esc）会突然
 *    跳到上次创建的 id；
 * ③ 创建成功 Esc 关闭（冲刷正常）后 `teams.reload()` 未落定 → 守卫 effect 用**旧列表**
 *    （不含新 id）把刚落的选中立刻清掉——守卫不查 `teams.loading`。
 *
 * 修法：收敛单一 `closeForm()`（冲刷在其中，消费即清）+ 守卫加 `!teams.loading`。
 */
describe('TeamsPage 表单关闭：单一 closeForm + 守卫竞态（M3）', () => {
  it('A 创建成功后点表单内「取消」→ 选中仍落到新 id（旧代码绕过冲刷 → 丢选中）', async () => {
    const calls: string[] = []
    await render('', (id) => calls.push(id))

    await createTeam('t-new')
    // 前置：创建成功抽屉仍在（R-6 Q1），「取消」是 TeamForm 自带那颗
    expect(el('.drawer')).not.toBeNull()
    expect(button(t('common.cancel')).disabled).toBe(false)

    await click(button(t('common.cancel')))

    expect(calls).toEqual(['t-new'])
    expect(el('.drawer')).toBeNull()
  })

  it('B 陈旧 pendingSelect 不得泄漏到之后无关的关闭（旧代码：取消不冲刷 → 下次 Esc 回放上次创建 id）', async () => {
    const calls: string[] = []
    await render('', (id) => calls.push(id))

    // 两次「创建 → 取消」：修复后每次关闭都就地冲刷并清空 pendingSelect
    await createTeam('t-1')
    await click(button(t('common.cancel')))
    await createTeam('t-2')
    await click(button(t('common.cancel')))

    // 再与上一次**无关**地开一次抽屉并 Esc 关：不得再回放任何旧 id
    await click(button(t('teams.new')))
    await pressEscape()

    // 旧代码：两次取消都没冲刷 ⇒ 这里只会看到 Esc 时回放的最后一个 id（`['t-2']`）
    expect(calls).toEqual(['t-1', 't-2'])
  })

  it('C 竞态：reload 在途时守卫不得用旧列表清掉刚落的选中（旧代码无 loading 条件）', async () => {
    const calls: string[] = []
    const onSelect = (id: string): void => {
      calls.push(id)
    }
    await render('', onSelect)

    // 闸门：此后（含 onCreated 触发的）每次 `teams()` 都卡在途 → loading=true 而 data 仍旧
    const gate = defer()
    data.teamsGate = gate.promise

    await createTeam('t-new')
    // 用 **Esc** 关（`Drawer.onClose` 这条**新旧都会冲刷**的路径）——把本用例的失败点
    // 精确隔离到「守卫竞态」上，不与断裂①（取消不冲刷）混在一起
    await pressEscape()
    expect(calls).toEqual(['t-new'])

    // 父级把 hash 落到新 id（选中回传）→ 守卫 effect 重跑；此时 reload 在途、列表仍是旧两条
    await render('t-new', onSelect)

    // 旧代码：无 loading 条件 → 立刻用旧列表清掉刚落的选中 ⇒ `['t-new', '']` 红
    expect(calls).toEqual(['t-new'])

    // 放行 reload：列表**仍不含** t-new（真·已不存在）→ 数据落定后守卫才该清
    await act(async () => {
      data.teamsGate = null
      gate.resolve()
    })
    expect(calls[0]).toBe('t-new')
    expect(calls[calls.length - 1]).toBe('')
  })

  it('D reload 失败：守卫不得用旧列表清掉刚落的选中（复检 MINOR-①，旧代码无 error 条件）', async () => {
    const calls: string[] = []
    const onSelect = (id: string): void => {
      calls.push(id)
    }
    await render('', onSelect)

    // 与用例 C 同一条时序：创建 → 选中落 t-new（此时列表不含它）→ 关抽屉
    const gate = defer()
    data.teamsGate = gate.promise

    await createTeam('t-new')
    await pressEscape()
    expect(calls).toEqual(['t-new'])
    await render('t-new', onSelect)

    // 放行 reload 但**注入失败**：error 置位、data 停在旧列表（不含 t-new）。
    // 旧代码：`!loading && data!==undefined && !list.contains` 全真 → 误清 ⇒ `['t-new','']` 红。
    // 修后：`teams.error === undefined` 不成立 → 不清。
    await act(async () => {
      data.teamsGate = null
      data.teamsFail = true
      gate.resolve()
    })
    // 收口自证：页面确实进了失败态（错误横幅含注入的错误文本）——防止「没失败所以没清」的假绿
    expect(el('.error')?.textContent).toContain('teams_dir_unreadable')
    expect(calls).toEqual(['t-new'])
  })
})
