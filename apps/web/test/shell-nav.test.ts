// @vitest-environment happy-dom
/**
 * v19 应用骨架：左侧栏信息架构 + 当前页高亮 + 顶栏面包屑。
 *
 * 为什么单独测 `Shell`：六个页面各自有大量 DOM 测试，但没有一个覆盖「导航长什么样」。
 * 这里把页面组件整体替身掉，只验证骨架本身（分组 / 链接 / aria-current / 面包屑），
 * 避免为一条导航断言去加载六页的真实数据请求。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../src/api.ts', () => ({
  api: { health: () => Promise.resolve({ ok: true, value: {} }) },
}))
vi.mock('../src/pages/Knowledge.tsx', () => ({ KnowledgePage: () => null }))
vi.mock('../src/pages/CodeGraph.tsx', () => ({ CodeGraphPage: () => null }))
vi.mock('../src/pages/Projects.tsx', () => ({ ProjectsPage: () => null }))
vi.mock('../src/pages/Roles.tsx', () => ({ RolesPage: () => null }))
vi.mock('../src/pages/Skills.tsx', () => ({ SkillsPage: () => null }))
vi.mock('../src/pages/teams/TeamsPage.tsx', () => ({ TeamsPage: () => null }))

import { setLang } from '../src/i18n.ts'
import { Shell } from '../src/Shell.tsx'

let container: HTMLDivElement
let root: Root

async function render(hash: string): Promise<void> {
  window.location.hash = hash
  await act(async () => {
    root.render(createElement(Shell))
  })
  // ConnStatus 的 health 探针在 effect 里 resolve，再给一拍
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  setLang('zh')
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
  window.location.hash = ''
})

describe('v19 侧栏：三组、六个一级页、当前页高亮', () => {
  it('六个导航项按三组排布（知识与图谱 / 工作区 / 组织）', async () => {
    await render('#/knowledge')
    const groups = [...container.querySelectorAll('.nav-block-label')].map((n) => n.textContent)
    expect(groups).toEqual(['知识与图谱', '工作区', '组织'])
    const links = [...container.querySelectorAll<HTMLAnchorElement>('.sidebar .nav-item')]
    expect(links.map((a) => a.textContent)).toEqual(['知识库', '代码图谱', '项目台账', '角色', '团队', '技能'])
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#/knowledge',
      '#/graph',
      '#/projects',
      '#/roles',
      '#/teams',
      '#/skills',
    ])
  })

  it('当前页只有一项高亮，并用 `aria-current="page"` 表达', async () => {
    await render('#/teams')
    const active = [...container.querySelectorAll<HTMLAnchorElement>('.nav-item.active')]
    expect(active).toHaveLength(1)
    expect(active[0]?.textContent).toBe('团队')
    expect(active[0]?.getAttribute('aria-current')).toBe('page')
    expect(container.querySelectorAll('.nav-item[aria-current="page"]')).toHaveLength(1)
  })

  it('顶栏面包屑跟随路由：根 + 当前页 + 深链实体', async () => {
    await render('#/roles/dev')
    const crumb = container.querySelector('.crumb')?.textContent ?? ''
    expect(crumb).toContain('Prism')
    expect(crumb).toContain('角色')
    expect(crumb).toContain('dev')
    expect(container.querySelector('.crumb-current')?.textContent).toBe('角色')
    expect(container.querySelector('.crumb-sel')?.textContent).toBe('dev')
  })

  it('主题 / 语言开关在侧栏底部，且都有可访问名', async () => {
    await render('#/knowledge')
    const themeBtn = container.querySelector<HTMLButtonElement>('.sidebar-foot .icon-btn')
    expect(themeBtn).not.toBeNull()
    expect(themeBtn?.getAttribute('aria-label')).toBeTruthy()
    const langBtn = [...container.querySelectorAll<HTMLButtonElement>('.sidebar-foot .icon-btn')].find(
      (b) => b.textContent === 'EN',
    )
    expect(langBtn?.getAttribute('aria-label')).toBeTruthy()
  })

  it('顶栏有「复制链接」按钮（深链分享入口）', async () => {
    await render('#/roles/dev')
    const btn = container.querySelector<HTMLButtonElement>('.topbar-tools .icon-btn')
    expect(btn).not.toBeNull()
    expect(btn?.getAttribute('aria-label')).toBe('复制链接')
  })

  it('全局 `/` 聚焦当前页第一个搜索框；在输入框里或浮层打开时不抢键', async () => {
    await render('#/roles')
    const search = document.createElement('input')
    search.setAttribute('data-search-input', '')
    container.appendChild(search)
    document.body.focus()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    expect(document.activeElement).toBe(search)

    // 已经在输入框里：`/` 是字面字符，不该被拦截（事件从输入框冒泡到 window）
    const other = document.createElement('input')
    container.appendChild(other)
    other.focus()
    other.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    expect(document.activeElement).toBe(other)

    // 浮层打开：不把焦点抢到背后的页面搜索框
    const mask = document.createElement('div')
    mask.className = 'modal-mask'
    container.appendChild(mask)
    other.blur()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))
    expect(document.activeElement).not.toBe(search)
  })
})
