// @vitest-environment happy-dom
/**
 * 技能页层级重排回归（F8 §三 · 砍单 6 条）。
 *
 * 锁六条**层级契约**（不是像素）：
 * 1. **列表卡片**（§3.1 第一眼，W-5 起是卡片网格）：名 → 摘要 → 徽章行，且摘要吃 **32 字**上限（§3.4 #5：
 *    原来的 76 字 + 2 行 clamp 收成 1 行；clamp 的值由同批 `styles-skills-hierarchy.test.ts` 锁）；
 * 2. **详情第一眼**（§3.4 #6）：`h4` 段头**整页为零**——描述直接作为正文（`.skill-desc`，不截断），
 *    全文落在这里（列表那 32 字只是入口）；
 * 3. **常用带**（§3.4 #2）：未装技能的安装命令在 `.scope-callout` 内且**不在折叠里**；
 *    引用计数并入 scope 段 `CountLine`，不再是「宿主」段下的一行独立文本；
 * 4. **深挖带**（§3.4 #1/#4）：`<details class="skill-deep">` 默认收起，安装路径与
 *    render｜源码档位（`.seg`）都在折叠**内**。返回键说明（页头）：tab 列表非本批；
 * 5. **页头**（§3.4 #3）：「内置 / 外部」计数列删除，只剩「已装/未装」与「被角色/团队引用」两列；
 * 6. **`.seg` 挪位置的**行为契约**：折叠开合不重置档位（`mode` 仍是 `SkillBody` 的同一个 useState）；
 * 7. **F9-3 详情头描述**：frontmatter 块标量标记（`>-`）已被渲染前剥离——剥完为空走既有空态，
 *    不出现内容为 `>-` 的伪描述（纯判据见 `skills-logic.test.ts`）。
 *
 * 渲染路径与 `skills-install-pending.test.ts` / `teams-hierarchy.test.ts` 一致：happy-dom +
 * 裸 `react-dom/client` + `react.act`，不引 @testing-library；本目录 include 只收 `.test.ts`，故不用 JSX。
 *
 * ⚠ happy-dom **不解析外部样式表**，故「1 行截断 / summary 口径 / 不新增颜色」这类**纯 CSS 事实**
 * 在同批的 `styles-skills-hierarchy.test.ts`（node 环境、读文件断言）。本文件只管 DOM 结构。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillDetail } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * 首句**无句末标点**且长于 76 字 ⇒ `firstSentence(_, 32)` 与 `firstSentence(_, 76)`
 * 结果必然不同——这样「摘要吃到 32 字上限」才是被证明的，而不是「文本本来就短」（假绿）。
 */
const data = vi.hoisted(() => {
  const longDesc =
    '这是用来验证列表行摘要截断的第一句话它故意写得很长而且没有句末标点所以必须靠三十二字上限来收口' +
    '后面还有一大段本不该出现在列表行里的文字它把整段描述推到七十六个字以上好让两个上限可区分'
  /** 用例可改：详情里的「已装」态（安装按钮 / 卸载按钮 / 未装 callout 的开关）。 */
  return {
    longDesc,
    installed: false,
    /** F9-3 用例可改：覆盖**详情**头 description（`null` = 用 `longDesc`）。 */
    detailDesc: null as string | null,
  }
})

const PATH = '/tmp/prism-skills/alpha/SKILL.md'

/** 详情正文里可辨识的片段：用来断言它只在折叠里出现一次。 */
const CONTENT = '# alpha\n\n正文片段-仅在折叠内\n'

function detail(name: string): SkillDetail {
  if (name !== 'alpha') {
    return {
      name,
      description: '第二个技能的一句话。',
      builtin: true,
      installed: true,
      path: '/tmp/prism-skills/beta/SKILL.md',
      roles: [],
      teams: [],
      content: '# beta\n',
    }
  }
  return {
    name,
    description: data.detailDesc ?? data.longDesc,
    builtin: true,
    installed: data.installed,
    path: PATH,
    roles: ['dev'],
    teams: ['t-a'],
    content: CONTENT,
  }
}

vi.mock('../src/api-team.ts', () => ({
  teamApi: {
    skills: () =>
      Promise.resolve({
        skills: [
          { name: 'alpha', description: data.longDesc, builtin: true },
          { name: 'beta', description: '第二个技能的一句话。', builtin: true },
        ],
        skills_dir: '/tmp/prism-skills',
      }),
    skillUsage: () =>
      Promise.resolve([
        { name: 'alpha', builtin: true, installed: false, roles: ['dev'], teams: ['t-a'] },
        { name: 'beta', builtin: true, installed: true, roles: [], teams: [] },
      ]),
    skill: (name: string) => Promise.resolve(detail(name)),
    // W-6：两个技能都没有分类 ⇒ 清单为空（本文件只断言层级与详情，不涉及分类组）
    skillCategories: () => Promise.resolve({ categories: [], mapping: {} }),
    skillInstall: () => Promise.resolve({ skills_dir: '/tmp/prism-skills', written: [], skipped: [] }),
    skillUninstall: () => Promise.resolve({ skills_dir: '/tmp/prism-skills', removed: [], kept: [] }),
    // 详情切到「有效集」时才会用到；本文件不切，但模块被整体替身时必须给出，否则渲染即崩
    roles: () => Promise.resolve({ roles: [], rolesDir: '/tmp/prism-roles' }),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { firstSentence } from '../src/components/ui.tsx'
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

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

/**
 * 详情的作用域（W-5：详情从 `.md-detail` 右栏迁入居中弹窗 `.modal.modal-lg`）。
 * 所有「详情里有什么 / 顺序如何」的断言都落在这个前缀里，与
 * `skills-groups-dom.test.ts` / `roles-hierarchy.test.ts` 的取法一致。
 */
const DETAIL = '.modal-lg .swap-in'

/** 详情 `Pane` 的直接子节点 class 序列——一条断言看完整段带顺序。 */
function paneBands(): string[] {
  const pane = one(`${DETAIL} > .pane`)
  if (pane === null) throw new Error('详情 Pane 不在 DOM 里')
  return [...pane.children].map((c) => (c.getAttribute('class') ?? '').split(' ')[0] || c.tagName.toLowerCase())
}

/** `CountLine` 的行（按可见标签找，避免序号耦合）。 */
function countLine(label: string): Element | undefined {
  return all('.count-line').find((n) => n.querySelector('.count-label')?.textContent === label)
}

beforeEach(() => {
  setLang('zh')
  data.installed = false
  data.detailDesc = null
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

describe('F8 §3.4 #5 列表卡片：名 → 摘要（32 字 1 行）→ 徽章行', () => {
  it('卡片的部件顺序：`.role-name`（名 + 分类色点）→ `.role-desc`（摘要）→ `.role-tags`（标记）', async () => {
    await render('alpha')
    const card = one('.md-list .role-card')!
    expect([...card.children].map((c) => (c.getAttribute('class') ?? '').split(' ')[0])).toEqual([
      'role-name',
      'role-desc',
      'role-tags',
    ])
  })

  it('摘要是 `firstSentence(desc, 32)`（不是原样的 76 字上限），全文进 `title`', async () => {
    await render('alpha')
    const s = one('.md-list .role-card .role-desc')!
    expect(s.textContent).toBe(firstSentence(data.longDesc, 32))
    // 前置自证：两个上限在本数据上结果确实不同，否则本用例证明不了 32 生效
    expect(firstSentence(data.longDesc, 32)).not.toBe(firstSentence(data.longDesc, 76))
    expect(s.textContent?.endsWith('…')).toBe(true)
    // 截断只是列表入口：全文在 `title` 里悬停可读（`.role-desc` 的 1 行 clamp 同角色页）
    expect(s.getAttribute('title')).toBe(data.longDesc)
  })

  it('S3：来源 / 宿主是卡片徽章行里的标记（未装才给 lamp），不是第二枚同色徽标', async () => {
    await render('alpha')
    const card = one('.md-list .role-card')!
    // 徽章行三件：来源（中性）/ 宿主（中性）/ 未装且有引用方（唯一的着色档 warn）
    expect([...card.querySelectorAll('.role-tags > *')].map((n) => n.textContent)).toEqual([
      t('common.builtin'),
      t('common.notInstalled'),
      t('skills.row.refWarn', { n: 1 }),
    ])
    // 未装才点 lamp（既有 `--warn` 状态色）
    expect(card.querySelector('.role-tags .tag .scope-lamp')).not.toBeNull()
    expect(card.querySelector('.role-tags .tag.warn')?.textContent).toBe(t('skills.row.refWarn', { n: 1 }))
  })
})

describe('F8 §3.4 #6 / §3.1 详情第一眼：描述即正文（段头整页为零）', () => {
  it('详情里 **没有任何** `h4` 段头（「关于」「宿主」「生效层」「安装路径」全删）', async () => {
    await render('alpha')
    expect(all(`${DETAIL} h4`).length).toBe(0)
  })

  it('描述是正文第一块，且**全文不截断**（列表那 32 字只是入口）', async () => {
    await render('alpha')
    expect(paneBands()[0]).toBe('pane-head')
    expect(paneBands()[1]).toBe('skill-desc')
    const desc = one('.skill-desc')!
    expect(desc.textContent).toBe(data.longDesc)
    expect(desc.textContent).not.toBe(firstSentence(data.longDesc, 32))
  })

  it('技能名在**弹窗头**（`h3.mono`）+ 面板头只留宿主状态 `StatusTag`（§3.1「一行 StatusTag」）', async () => {
    await render('alpha')
    // W-5：身份由弹窗头承担（同 `TeamDetail` 的迁移口径），面板头不再重复一遍技能名
    expect(one('.modal-head h3')?.textContent).toBe('alpha')
    expect(one('.modal-head h3 .mono')).not.toBeNull()
    const head = one(`${DETAIL} .pane-head`)!
    expect(head.querySelector('h3')).toBeNull()
    // 已装/未装 + 未装且有引用方（warn）——状态只在面板头这一处，正文里不再重复报一遍
    expect([...head.querySelectorAll('.tag')].map((n) => n.textContent)).toEqual([
      t('common.notInstalled'),
      t('skills.row.refWarn', { n: 1 }),
    ])
  })
})

/**
 * F9-3：详情头 description 裸 `>-`（服务端单行解析把 frontmatter 块标量头当了值）。
 * 纯判据的单测在 `skills-logic.test.ts`，这里锁**消费行为**：剥完为空走既有空态文案，
 * 不渲染一个内容为 `>-` 的伪描述；正常描述一字不改。
 */
describe('F9-3 详情头描述：块标量标记不落到 DOM', () => {
  it('`>-` 不进 `.skill-desc`：剥成空 ⇒ 走既有空态（与「服务端没给描述」同一档）', async () => {
    data.detailDesc = '>-'
    await render('alpha')
    const desc = one(`${DETAIL} .skill-desc`)!
    expect(desc).not.toBeNull()
    expect(desc.textContent).not.toContain('>-')
    expect(desc.textContent).toBe(t('common.unset'))
    // 「不渲染空描述段」：第一眼带这一格仍是可读文案，不是空串
    expect(desc.textContent?.trim()).not.toBe('')
  })

  it('普通描述**一字不改**（剥离是恒等变换，不会顺手改写正文）', async () => {
    data.detailDesc = '一句话描述。后半句不该被这层动到。'
    await render('alpha')
    expect(one(`${DETAIL} .skill-desc`)?.textContent).toBe('一句话描述。后半句不该被这层动到。')
  })
})

describe('F8 §3.1 常用带 / §3.4 #2：未装命令可见，引用计数并入 scope 段', () => {
  it('未装：安装命令在 `.scope-callout` 内且**不在**折叠里（常用带可见）', async () => {
    await render('alpha')
    const callout = one('.scope-callout')!
    expect(callout).not.toBeNull()
    expect(callout.querySelector('.cmd-row .cmd')?.textContent).toBe('prism skill install alpha')
    expect(callout.closest('details')).toBeNull()
  })

  it('§3.4 #2：引用计数不再是独立文本行，而是 scope 段 `CountLine` 的计数', async () => {
    await render('alpha')
    const refs = t('skills.counts.refs', { roles: 1, teams: 1 })
    const line = countLine(t('skills.scope'))!
    expect(line).toBeDefined()
    expect(line.querySelector('.count-num')?.textContent).toBe(refs)
    // 旧排法（`--fs-300` 的独立一行）不再存在：整个详情里持有这段文字的**有且仅有** `count-num`
    const holder = all(`${DETAIL} *`).filter((n) => n.textContent === refs)
    expect(holder.length).toBe(1)
    expect(holder[0]!.classList.contains('count-num')).toBe(true)
  })

  it('引用范围仍是三行 `ScopeLayerRows`（全局/团队/角色），在 scope 段之后', async () => {
    await render('alpha')
    expect(all('.scope-rows .scope-row').length).toBe(3)
    // v12 F4（W-7）：第一眼描述之下插了一行「分类」下拉（键盘替代，SPEC-4.7），故段带多一个
    // `.row`（在 `skill-desc` 与 `scope-callout` 之间）；其余段序一字未动。
    expect(paneBands()).toEqual([
      'pane-head',
      'skill-desc',
      'row',
      'scope-callout',
      'count-line',
      'scope-rows',
      'skill-deep',
    ])
  })

  it('已装：命令块与卸载按钮都不进折叠（卸载是安装的对位动作）', async () => {
    data.installed = true
    await render('alpha')
    expect(one('.scope-callout')).toBeNull()
    const uninstall = all(`${DETAIL} .pane > .row button`).find(
      (b) => b.textContent === t('skills.uninstall.action'),
    )!
    expect(uninstall).toBeDefined()
    expect(uninstall.closest('details')).toBeNull()
  })
})

describe('F8 §3.1 深挖带 / §3.4 #1 #4：SKILL.md 全文与路径默认折叠', () => {
  it('`<details class="skill-deep">` 默认收起，summary 走新键', async () => {
    await render('alpha')
    const fold = one<HTMLDetailsElement>('details.skill-deep')!
    expect(fold).not.toBeNull()
    expect(fold.open).toBe(false)
    expect(fold.querySelector('summary')?.textContent).toBe(t('skills.deepDive'))
  })

  it('§3.4 #1：安装路径在折叠**内**（且全详情只此一处）', async () => {
    await render('alpha')
    const inFold = all('.skill-deep .mono').find((n) => n.textContent === PATH)
    expect(inFold).toBeDefined()
    expect(all(`${DETAIL} .mono`).filter((n) => n.textContent === PATH).length).toBe(1)
  })

  it('§3.4 #4：render｜源码档位（`.seg`）随全文进折叠，折叠外没有 `.seg`', async () => {
    await render('alpha')
    const seg = one('.skill-deep .seg')!
    expect(seg).not.toBeNull()
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      t('skills.view.render'),
      t('skills.view.source'),
    ])
    expect(one(`${DETAIL} .pane > .seg`)).toBeNull()
    expect(one(`${DETAIL} .pane > .row .seg`)).toBeNull()
  })

  it('SKILL.md 正文落在折叠内（默认档 = 渲染档，内容在 DOM 里只是被收起）', async () => {
    await render('alpha')
    const fold = one('.skill-deep')!
    expect(fold.querySelector('.md-body.md-read')).not.toBeNull()
    expect(fold.querySelector('.md-source')).toBeNull() // 默认渲染档，不是源码档
  })

  it('折叠开合**不重置**档位（state 仍是 `SkillBody` 里那一个 `mode`）', async () => {
    await render('alpha')
    const fold = one<HTMLDetailsElement>('details.skill-deep')!
    const source = [...fold.querySelectorAll('.seg button')].find(
      (b) => b.textContent === t('skills.view.source'),
    )!
    await act(async () => {
      source.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(one('details.skill-deep .md-source')).not.toBeNull()
    // 收起重开（原生 details 的 toggle 不触发 React 重挂）后仍停在源码档
    await act(async () => {
      fold.open = false
      fold.dispatchEvent(new Event('toggle'))
    })
    await act(async () => {
      fold.open = true
      fold.dispatchEvent(new Event('toggle'))
    })
    expect(one('details.skill-deep .md-source')).not.toBeNull()
    expect(one('details.skill-deep .md-body.md-read')).toBeNull()
  })
})

describe('F8 §3.4 #3 页头：删「内置 / 外部」计数列', () => {
  it('只剩「已装/未装」与「被角色/团队引用」两列', async () => {
    await render('alpha')
    expect(all('.scope-counts .scope-count-col').length).toBe(2)
    const labels = all('.scope-counts .count-label').map((n) => n.textContent)
    expect(labels).toEqual([
      t('common.installed'),
      t('common.notInstalled'),
      t('skills.counts.byRole'),
      t('skills.counts.byTeam'),
    ])
    expect(labels).not.toContain(t('common.builtin'))
    expect(labels).not.toContain(t('common.external'))
  })

  it('两列计数仍如实（已装 1 / 未装 1 / 被角色引用 1 / 被团队引用 1）', async () => {
    await render('alpha')
    expect(all('.scope-counts .count-num').map((n) => n.textContent)).toEqual(['1', '1', '1', '1'])
  })
})
