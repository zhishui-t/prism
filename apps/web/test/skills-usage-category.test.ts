// @vitest-environment happy-dom
/**
 * F7-1 **web 侧接线**的 DOM 契约（服务端已修，移交 web 的两行）。
 *
 * 背景：技能列表的 rows 是两路拼接——`GET /api/skills`（**只列内置**技能，读 `category`）
 * 与 `GET /api/skills/usage`（**全量**，含宿主已装的外部技能）。F7-1 之前 usage 路不带
 * `category`，于是**外部技能**（只出现在 usage 路）无论服务端映射里有没有分类，都落进
 * 「未分类」组。服务端现在已按与 `/api/skills` 完全一致的口径逐条合并 `category`
 * （映射里没有该技能 → 不加键），web 侧补两行消费它：
 *   ① `SkillUsage` 接口补 `category?: string`；
 *   ② usage 循环内 `row.category ??= item.category`。
 *
 * 本文件锁三件事（都是**行为**，不是像素）：
 *  1. **外部技能带 category ⇒ 进对应分组**，不在「未分类」组；
 *  2. **外部技能无该键 ⇒ 落「未分类」组**（服务端「不加键」的形态原样传递，不伪造成空串它组）；
 *  3. **`??=` 的顺序契约**：内置路先写的 `category` 不被 usage 路覆盖——两路给了**冲突的
 *     分类名**时，仍以 `/api/skills` 内置路的为准（改 `??=` 为 `=` 该断言即红）。
 *
 * 渲染路径与 `skills-groups-dom.test.ts` 一致：happy-dom + 裸 `react-dom/client` + `react.act`，
 * 不引 @testing-library；本目录 include 只收 `.test.ts`，故不用 JSX。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * `/api/skills`：**只有内置技能**（真实服务端行为）——`alpha-builtin` 分类 `ui`。
 */
const BUILTIN = [
  { name: 'alpha-builtin', description: '内置技能，分类 ui', builtin: true, category: 'ui' },
]

/**
 * `/api/skills/usage`：**全量**（内置 + 外部）。三条各承担一条断言：
 * - `alpha-builtin`：内置路已写 `ui`，这里故意给**冲突**的分类名 `conflict` ⇒ 证 `??=` 不覆盖；
 * - `ext-cat`：外部技能 + `category: 'ui'` ⇒ 必须进 `ui` 组（F7-1 的核心）；
 * - `ext-plain`：外部技能 + **无 `category` 键** ⇒ 必须落未分类组。
 */
const USAGE = [
  { name: 'alpha-builtin', builtin: true, installed: true, roles: [], teams: [], category: 'conflict' },
  { name: 'ext-cat', builtin: false, installed: true, roles: ['r1'], teams: [], category: 'ui' },
  { name: 'ext-plain', builtin: false, installed: false, roles: [], teams: [] },
]

vi.mock('../src/api-team.ts', () => ({
  teamApi: {
    skills: () => Promise.resolve({ skills: BUILTIN, skills_dir: '/tmp/prism-skills' }),
    skillUsage: () => Promise.resolve(USAGE),
    // 以下为模块被整体替身时的占位（本文件只渲染列表，不触发详情/有效集）
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
    roles: () => Promise.resolve({ roles: [], rolesDir: '/tmp/prism-roles' }),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { SkillsPage } from '../src/pages/Skills.tsx'

let container: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(SkillsPage, {}))
  })
}

function heads(): HTMLElement[] {
  return [...container.querySelectorAll('.skill-group-head')] as HTMLElement[]
}

function labels(): string[] {
  return heads().map((h) => h.querySelector('.count-label')?.textContent ?? '')
}

/** 组头所在的组容器。 */
function groupOf(head: Element): Element {
  const group = head.closest('.skill-group')
  if (group === null) throw new Error('组头不在 .skill-group 内')
  return group
}

/** 按组名取组容器（组名 = 分类名原文；未分类组用字典文案）。 */
function group(label: string): Element {
  const head = heads().find((h) => h.querySelector('.count-label')?.textContent === label)
  if (head === undefined) throw new Error(`没有名为 ${label} 的组`)
  return groupOf(head)
}

/** 组内行名（文档序）。 */
function rowNames(el: Element): string[] {
  return [...el.querySelectorAll('.md-row .t')].map((n) => n.textContent ?? '')
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

describe('F7-1 外部技能分类：usage 路的 category 被消费', () => {
  it('外部技能（usage 路来、带 category）进对应分组，不在「未分类」组', async () => {
    await render()
    expect(labels()).toEqual(['ui', t('skills.uncategorized')])
    expect(rowNames(group('ui'))).toEqual(['alpha-builtin', 'ext-cat'])
    expect(rowNames(group(t('skills.uncategorized')))).toEqual(['ext-plain'])
    // 反向断言：外部带分类的技能**不在**未分类组（改之前它恰在这里）
    expect(rowNames(group(t('skills.uncategorized')))).not.toContain('ext-cat')
  })

  it('外部技能无 `category` 键 ⇒ 落「未分类」组（服务端「不加键」原样传递）', async () => {
    await render()
    expect(rowNames(group(t('skills.uncategorized')))).toEqual(['ext-plain'])
    // 缺键的条目**不生成**额外分组，也不被并进 ui 组：只有两个组头，ui 组计数仍为 2
    expect(labels()).toHaveLength(2)
    const uiHead = heads().find((h) => h.querySelector('.count-label')?.textContent === 'ui')!
    expect(uiHead.querySelector('.count-num')?.textContent).toBe('2')
  })

  it('`??=` 顺序契约：内置路先写的 category 不被 usage 路覆盖（冲突分类名时以内置为准）', async () => {
    await render()
    // usage 路对内置技能给了 'conflict'，若用了 `=` 会多出 conflict 组、alpha-builtin 会挪窝
    expect(labels()).not.toContain('conflict')
    expect(labels()).toEqual(['ui', t('skills.uncategorized')])
    expect(rowNames(group('ui'))).toContain('alpha-builtin')
  })
})
