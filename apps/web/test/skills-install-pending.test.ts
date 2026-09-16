// @vitest-environment happy-dom
/**
 * v7.1 反馈即时性（P2）：安装是**异步写操作**，点下去必须在按钮上立刻看见三件事——
 * 禁用（防双击）、`aria-busy`（读屏也知道在途）、文案换成「安装中…」。
 *
 * 缺陷面（修前）：按钮只有 `disabled={busy}`，`busy` 期间**没有任何可读的在途标记**；
 * 而写操作要落宿主技能目录、冷启动可能数秒，用户看到的只是「按钮灰了」，
 * 分不清「点了没反应」和「正在写」。
 *
 * 本文件一并锁住「不许重复提交」：在途期间再点一次，`skillInstall` 的调用次数**仍是 1**。
 *
 * 渲染路径与 `roles-delete-drawer.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`（根 vitest.config.ts 的 include 只收 `.test.ts`，故不用 JSX，走 `createElement`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据 + 可控悬挂：`install` 的 Promise 由用例手动放行（`vi.mock` 被提升，故走 `vi.hoisted`）。 */
const data = vi.hoisted(() => ({
  installCalls: [] as string[],
  /** 悬挂中：调用方 `resolve()` 之前一直 pending，用来观察在途态。 */
  release: null as null | (() => void),
  /** 该技能是否已装（详情里据此决定要不要出安装按钮）。 */
  installed: false,
}))

vi.mock('../src/api-team.ts', () => ({
  teamApi: {
    skills: () =>
      Promise.resolve({
        skills: [{ name: 'alpha', description: 'alpha 的说明', builtin: true }],
        skills_dir: '/tmp/prism-skills',
      }),
    skillUsage: () =>
      Promise.resolve([{ name: 'alpha', builtin: true, installed: false, roles: ['dev'], teams: [] }]),
    skill: (name: string) =>
      Promise.resolve({
        name,
        description: 'alpha 的说明',
        builtin: true,
        installed: data.installed,
        path: `/tmp/prism-skills/${name}`,
        roles: ['dev'],
        teams: [],
        content: '---\nname: alpha\n---\n\n正文\n',
      }),
    skillInstall: (input: { names?: string[] }) => {
      const name = input.names?.[0] ?? ''
      data.installCalls.push(name)
      return new Promise((resolve) => {
        data.release = () => resolve({ skills_dir: '/tmp/prism-skills', written: [name], skipped: [] })
      })
    },
    skillUninstall: () => Promise.resolve({ skills_dir: '/tmp/prism-skills', removed: [], kept: [] }),
    // 详情切到「有效集」时才会用到；本文件不切，但模块被整体替身时必须给出，否则渲染即崩
    roles: () => Promise.resolve({ roles: [], rolesDir: '/tmp/prism-roles' }),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { SkillsPage } from '../src/pages/Skills.tsx'

let container: HTMLDivElement
let root: Root

async function render(sel: string): Promise<void> {
  await act(async () => {
    root.render(createElement(SkillsPage, { sel }))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
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

beforeEach(() => {
  setLang('zh')
  data.installCalls = []
  data.release = null
  data.installed = false
  window.location.hash = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  // 未放行的悬挂 Promise 先收尾，避免卸载后 setState
  await act(async () => {
    data.release?.()
    root.unmount()
  })
  container.remove()
})

describe('v7.1 技能安装：在途态可见 + 不可重复提交', () => {
  it('未装技能给出安装按钮（前置：不是「压根没渲染」造成的假绿）', async () => {
    await render('alpha')
    expect(button(t('skills.install.action')).disabled).toBe(false)
  })

  it('点安装 → 立刻禁用 + `aria-busy` + 文案换「安装中…」，请求放行后复位', async () => {
    await render('alpha')
    const install = button(t('skills.install.action'))

    await click(install)

    // 收口自证：请求真发出去了（否则「按钮变了」可能是别的原因）
    expect(data.installCalls).toEqual(['alpha'])
    const inFlight = button(t('skills.install.busy'))
    expect(inFlight.disabled).toBe(true)
    expect(inFlight.getAttribute('aria-busy')).toBe('true')

    // 放行：写完了要能再点（否则一次失败就把按钮锁死）
    await act(async () => {
      data.release?.()
    })
    expect(button(t('skills.install.action')).disabled).toBe(false)
    expect(button(t('skills.install.action')).getAttribute('aria-busy')).toBe('false')
  })

  it('在途期间再点一次：不产生第二次写（防双击）', async () => {
    await render('alpha')
    await click(button(t('skills.install.action')))

    const inFlight = button(t('skills.install.busy'))
    await click(inFlight)
    expect(data.installCalls).toEqual(['alpha'])
  })
})
