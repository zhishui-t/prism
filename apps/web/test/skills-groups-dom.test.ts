// @vitest-environment happy-dom
/**
 * F7 技能分类分组的 **DOM 契约**（design-v8 §3 F7 / 层级稿 §3.5）。
 *
 * 锁五件事（结构，不是像素）：
 *  1. **组头**：`CountLine size="section"`（组名 + 计数）+ `.toc-chev`，且是展开切换
 *     （`role="button"` + `tabIndex` + `aria-expanded`，与知识库目录树 `.toc-mod` 同口径）；
 *  2. **数据源**：组名/计数来自 `GET /api/skills` 合并的 `category`——同一分类合成一组，
 *     组名是分类名原文（R-v8-5：不做「列表 + 独立映射表」二次拼接）；
 *  3. **默认全展开**：三组都 `aria-expanded="true"` + `.collapse.open`，行都在 DOM 里；
 *  4. **点组头折叠 / 展开**：只切 `aria-expanded` 与 `.open` 类，**收起不卸载**（同一节点）；
 *  5. **未分类组在末尾** + 组头带 `lamp`（`--warn` 既有状态色），其余组无 lamp。
 *
 * 另锁两条：过滤只让命中组出现（不留空组头）；详情侧是**整体**居中列
 * （`.md-detail > .skill-detail`，命令块 / scope / 折叠三层都在同一列内）。
 *
 * ⚠ happy-dom **不解析外部样式表**，故「66ch 居中 / chev 旋转 / 不新增颜色」这类**纯 CSS 事实**
 * 在同批的 `styles-skills-groups.test.ts`（node 环境、读文件断言）。本文件只管 DOM 结构。
 *
 * 渲染路径与 `skills-hierarchy.test.ts` 一致：happy-dom + 裸 `react-dom/client` + `react.act`，
 * 不引 @testing-library；本目录 include 只收 `.test.ts`，故不用 JSX。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 5 条技能覆盖三种组：
 * - `docs` → tech-doc（1 条）；
 * - `ui` → frontend-dev / frontend-design（2 条，**入参顺序与字典序相反** ⇒ 组内排序生效才可证）；
 * - 未分类 → zeta（服务端**不加 `category` 键**）+ alpha（空串 = 清除后的等价形态），
 *   **入参同样逆序**。
 */
const SKILLS = [
  { name: 'frontend-dev', description: 'ui 组：入参在前、字典序在后', builtin: true, category: 'ui' },
  { name: 'tech-doc', description: 'docs 组唯一一条', builtin: true, category: 'docs' },
  { name: 'zeta', description: '无分类（服务端不加键），入参在前', builtin: true },
  { name: 'frontend-design', description: 'ui 组：入参在后、字典序在前', builtin: true, category: 'ui' },
  { name: 'alpha', description: '空分类（清除后的等价形态），入参在后', builtin: true, category: '' },
]

vi.mock('../src/api-team.ts', () => ({
  teamApi: {
    skills: () => Promise.resolve({ skills: SKILLS, skills_dir: '/tmp/prism-skills' }),
    // 全部已装、无引用方：列表行保持最简（本文件断言的是分组结构，不是行内徽标）
    skillUsage: () =>
      Promise.resolve(
        SKILLS.map((s) => ({ name: s.name, builtin: true, installed: true, roles: [], teams: [] })),
      ),
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

async function render(sel?: string): Promise<void> {
  await act(async () => {
    root.render(createElement(SkillsPage, { sel }))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

/** 组头（文档序）。 */
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

/** 某个组头所在的组容器。 */
function groupOf(head: Element): Element {
  const group = head.closest('.skill-group')
  if (group === null) throw new Error('组头不在 .skill-group 内')
  return group
}

/** 组内行名（文档序）。 */
function rowNames(group: Element): string[] {
  return [...group.querySelectorAll('.md-row .t')].map((n) => n.textContent ?? '')
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
})

describe('F7 组头：组名 + 计数（数据源 = `/api/skills` 合并的 category）', () => {
  it('同名分类合成一组、组名是分类名原文；未分类组走新键 `skills.uncategorized`', async () => {
    await render()
    expect(labels()).toEqual(['docs', 'ui', t('skills.uncategorized')])
    expect(counts()).toEqual(['1', '2', '2'])
  })

  it('组头是展开切换：`role="button"` + `tabIndex=0` + `aria-expanded`（同目录树 `.toc-mod` 口径）', async () => {
    await render()
    const head = heads()[0]!
    expect(head.getAttribute('role')).toBe('button')
    expect(head.getAttribute('tabindex')).toBe('0')
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(head.querySelector('.toc-chev')?.textContent).toBe('▸')
  })

  it('组内按技能名排序（入参顺序与字典序相反，故这不是「碰巧」）', async () => {
    await render()
    const ui = heads().find((h) => h.querySelector('.count-label')?.textContent === 'ui')!
    // 入参是 frontend-dev → frontend-design，字典序是 design → dev
    expect(rowNames(groupOf(ui))).toEqual(['frontend-design', 'frontend-dev'])
  })
})

describe('F7 未分类组：置末尾 + 组头 lamp', () => {
  it('未分类组在最后，且只有它带 lamp', async () => {
    await render()
    const last = heads().at(-1)!
    expect(last.querySelector('.count-label')?.textContent).toBe(t('skills.uncategorized'))
    expect(last.querySelector('.count-lamp')).not.toBeNull()
    expect(heads().slice(0, -1).every((h) => h.querySelector('.count-lamp') === null)).toBe(true)
  })

  it('未分类组内也按技能名排序（缺键与空串两条都收进来）', async () => {
    await render()
    expect(rowNames(groupOf(heads().at(-1)!))).toEqual(['alpha', 'zeta'])
  })

  it('**全未分类**（过滤到只剩未分类行）⇒ 单一「未分类」组，照常渲染且 lamp 常亮', async () => {
    await render()
    await fill(one<HTMLInputElement>('.role-filter')!, 'zeta')
    expect(labels()).toEqual([t('skills.uncategorized')])
    expect(counts()).toEqual(['1'])
    expect(heads()[0]!.querySelector('.count-lamp')).not.toBeNull()
    expect(rowNames(groupOf(heads()[0]!))).toEqual(['zeta'])
  })
})

describe('F7 默认全展开 / 点组头折叠展开', () => {
  it('默认三组全展开：`aria-expanded=true` + `.collapse.open`，5 行都在 DOM 里', async () => {
    await render()
    expect(heads().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'true'])
    expect(all('.skill-group > .collapse').map((c) => c.classList.contains('open'))).toEqual([
      true,
      true,
      true,
    ])
    expect(all('.md-list .md-row').length).toBe(5)
  })

  it('点组头 → 收起：`aria-expanded=false` + `.open` 从 chev 与容器同时摘掉，**行不卸载**', async () => {
    await render()
    const head = heads().find((h) => h.querySelector('.count-label')?.textContent === 'ui')!
    const group = groupOf(head)
    const chev = head.querySelector('.toc-chev')!
    const row = group.querySelector('.md-row')
    expect(row).not.toBeNull()

    await click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(chev.classList.contains('open')).toBe(false)
    expect(groupOf(head).querySelector('.collapse')?.classList.contains('open')).toBe(false)
    // 收起不卸载（`.collapse` 的高度过渡要求内容常驻 DOM）
    expect(groupOf(head).querySelector('.md-row')).toBe(row)

    await click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(chev.classList.contains('open')).toBe(true)
    expect(groupOf(head).querySelector('.collapse')?.classList.contains('open')).toBe(true)
  })

  it('键盘契约：Enter / Space 等价点击（组头不是原生 button）', async () => {
    await render()
    const head = heads()[0]!
    for (const key of ['Enter', ' ']) {
      await act(async () => {
        head.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    // 两次切换 ⇒ 回到展开态（能证明两次都被认了，而不是「压根没响应」）
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(groupOf(head).querySelector('.collapse')?.classList.contains('open')).toBe(true)
  })

  it('过滤只让命中组出现（不留空组头），组头计数即命中数', async () => {
    await render()
    await fill(one<HTMLInputElement>('.role-filter')!, 'frontend')
    expect(labels()).toEqual(['ui'])
    expect(counts()).toEqual(['2'])
    expect(all('.md-list .md-row').length).toBe(2)
  })
})

describe('F7 详情居中：居中的单位是详情整体（不是正文段）', () => {
  it('`.md-detail` 的内层包裹带 `skill-detail`，且三层都在这一列内', async () => {
    await render('frontend-dev')
    const col = one('.md-detail > .swap-in.skill-detail')
    expect(col).not.toBeNull()
    // 第一眼（描述）/ 常用（scope 计数与三行）/ 深挖（折叠）三层同列
    expect(col!.querySelector('.skill-desc')).not.toBeNull()
    expect(col!.querySelector('.scope-rows')).not.toBeNull()
    expect(col!.querySelector('.skill-deep')).not.toBeNull()
    // 滚动容器仍是 `.md-detail` 本身（居中是内层包裹，不动滚动容器）
    expect(one('.md-detail .skill-detail .md-detail')).toBeNull()
    // 分组只在列表侧：详情侧没有分组概念
    expect(one('.md-detail .skill-group')).toBeNull()
  })

  it('折行长串的行内兜底仍在（安装路径 `break-all`，长串不撑破居中列）', async () => {
    await render('frontend-dev')
    const path = [...all('.skill-deep .mono')].find((n) => n.textContent?.endsWith('SKILL.md')) as HTMLElement
    expect(path.style.wordBreak).toBe('break-all')
  })
})
