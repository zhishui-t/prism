// @vitest-environment happy-dom
/**
 * 团队页层级重排回归（F8 §二 + F6 合并 + R-v8-6 / R-v8-7）。
 *
 * 锁五条**层级契约**（不是像素）：
 * 1. **工作流在第一眼且不被降级**——它是第二个 Pane、在成员表 Pane **之前**（§2.2 线框 ③ 在 ④ 之上），
 *    「阶段 N」不再单列一行（§2.4 #2），计数并入它的 Pane 头 `CountLine`；
 * 2. **第一眼条**——`.pane-head`（名 + team_id + 默认标记 + 动作位）+ `.pane-desc` 一句话 2 行、
 *    全文进 `title`；原「概览 `kv`」六行全部各有归属后整块删除（§2.4 #1–#4）；
 * 3. **F6 合并**——独立「声明技能」Pane 与其底部同源的「团队有效集」Pane 都不见了，
 *    只剩「成员技能集」一处；团队显式声明的可见性走 Pane 头 `CountLine` 的 `title`（R-v8-6）；
 * 4. **R-v8-7 分组默认态**——`global` 组在 `<details>` 里且**默认收起**（计数常驻组头）；
 *    `team` / `role` 组不套折叠容器 ⇒ 默认就是展开态；
 * 5. **深挖带**——沉淀规则 / 仲裁链在 `<details>` 内默认折叠（§2.4 #3），是全页最后一块；
 *    `rosterHint` 不再是可见行（§2.4 #6，只在 Pane 头 `CountLine` 的 `title` 里）。
 *
 * 渲染路径与 `teams-page-drawer.test.ts` / `roles-hierarchy.test.ts` 一致：happy-dom +
 * 裸 `react-dom/client` + `react.act`，不引 @testing-library；本目录 include 只收 `.test.ts`，故不用 JSX。
 *
 * ⚠ happy-dom **不解析外部样式表**，故「2 行截断 / summary 口径 / 不新增颜色」这类**纯 CSS 事实**
 * 全在同批的 `styles-team-hierarchy.test.ts`（node 环境、读文件断言）。本文件只管 DOM 结构。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition, TeamDefinition } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用。 */
const data = vi.hoisted(() => ({ teams: [] as unknown[], roles: [] as unknown[] }))

vi.mock('../src/api-team.ts', async (importOriginal) => ({
  // 部分 mock（同 `teams-page-drawer.test.ts`）：只换 `teamApi`，常量走真身。
  ...(await importOriginal<typeof import('../src/api-team.ts')>()),
  teamApi: {
    teams: () => Promise.resolve({ teams: data.teams, teamsDir: '/tmp/prism-teams' }),
    team: (id: string) => Promise.resolve(data.teams.find((t) => (t as TeamDefinition).team_id === id)),
    roles: () => Promise.resolve({ roles: data.roles, rolesDir: '/tmp/prism-roles' }),
    /**
     * 三条来源各一条技能（`sources[0]` 决定分组）——**故意三条都给**，否则
     * 「global 折叠 / team+role 展开」的断言会因为组本来就不存在而假绿。
     */
    effectiveSkills: (role: string) =>
      Promise.resolve({
        role,
        skills: [
          { name: 'g-skill', available: true, sources: ['global'] },
          { name: 't-skill', available: true, sources: ['team'] },
          { name: 'r-skill', available: true, sources: ['role'] },
        ],
        warnings: [],
      }),
    create: () => Promise.resolve({ ok: true, path: '/tmp/prism-teams/new.md', issues: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { firstSentence } from '../src/components/ui.tsx'
import { TeamsPage } from '../src/pages/teams/TeamsPage.tsx'

const LONG_DESC = '从需求到交付的端到端编排。后半句属于说明，不该出现在第一眼可见的两行里。'

function team(id: string): TeamDefinition {
  return {
    team_id: id,
    name: '团队甲',
    description: LONG_DESC,
    default: true,
    members: [
      { role: 'dev-1', count: 1 },
      { role: 'dev-2', count: 2 },
    ],
    skills: ['team-declared'],
    knowledge: { layers: ['project'], books: ['prism'] },
    deposit: {
      enabled: true,
      default_layer: 'project',
      default_type: 'note',
      priority: 'medium',
      require_note: true,
    },
    arbitration: ['architect', 'reviewer'],
    workflow: [
      { order: 1, stage: '开发', roles: ['dev-1'], mode: 'scan', input: 'a', output: 'b', done: 'c', reflow: '' },
      { order: 2, stage: '交付', roles: ['dev-2'], mode: 'scan', input: 'b', output: 'c', done: 'd', reflow: '' },
    ],
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

/** 点一下（`WorkflowFlow` 的阶段卡是 `<button>`，点开才渲染明细）。 */
async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** `CountLine` 的行（按可见标签找，避免序号耦合）。 */
function countLine(label: string): Element | undefined {
  return all('.count-line').find((n) => n.querySelector('.count-label')?.textContent === label)
}

/** `.swap-in`（详情根）的直接子节点标签序列——一条断言看完整页顺序。 */
function bandOrder(): string[] {
  const root = one('.md-detail .swap-in')
  if (root === null) throw new Error('详情根 .swap-in 不在 DOM 里')
  // 取首个 class token（`pane` / `two-col` / `team-deep`…）；无 class 时退回标签名
  return [...root.children].map((c) => (c.getAttribute('class') ?? '').split(' ')[0] || c.tagName.toLowerCase())
}

/** 某个技能的 `Ref`（`kind="skill"` → `#/skills/<name>`）。 */
function skillRef(name: string): Element | null {
  return one(`.ref[href="#/skills/${name}"]`)
}

beforeEach(() => {
  setLang('zh')
  data.teams = [team('t-a')]
  data.roles = [{ name: 'dev-1' } as RoleDefinition, { name: 'dev-2' } as RoleDefinition]
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

describe('F8 §2.2 工作流在第一眼：提到概览之上，且不得降级/折叠', () => {
  it('详情三段带的顺序：第一眼 Pane → 工作流 Pane → 成员表 Pane → 两栏区 → 深挖折叠', async () => {
    await render('t-a')
    expect(bandOrder()).toEqual(['pane', 'pane', 'pane', 'two-col', 'team-deep'])
  })

  it('工作流 Pane **在成员表 Pane 之前**（此前它是第 4 块，被概览挤到下面）', async () => {
    await render('t-a')
    const panes = all('.md-detail .swap-in > .pane')
    expect(panes.length).toBe(3)
    expect(panes[1]!.querySelector('.flow-scroll'), '第二个 Pane 不是工作流').not.toBeNull()
    expect(panes[2]!.querySelector('.form-grid'), '第三个 Pane 不是成员表').not.toBeNull()
  })

  it('工作流本体不被折叠包裹（灵魂不得降级成深挖项）', async () => {
    await render('t-a')
    expect(one('.flow-scroll .workflow-flow')).not.toBeNull()
    expect(one('.flow-scroll')!.closest('details')).toBeNull()
    // 阶段卡的「点阶段看明细」折叠仍是既有 `.collapse`（F3/v7.1 契约，未被本轮改动）
    expect(one('.workflow-flow')!.closest('.collapse')).toBeNull()
  })

  it('§2.4 #2：「阶段 N」不再单列一行，计数并入工作流 Pane 头的 CountLine', async () => {
    await render('t-a')
    const line = countLine(t('teams.workflow'))
    expect(line, '工作流 Pane 头的 CountLine 不见了').toBeDefined()
    expect(line!.querySelector('.count-num')?.textContent).toBe('2')
    // 旧排法（概览 kv 的「2 阶段」）整句不再出现在详情里
    expect(one('.swap-in')!.textContent).not.toContain(t('teams.stages', { n: 2 }))
  })
})

describe('F8 §2.1 第一眼带：pane-head + 一句话描述；概览 kv 六行全部归位', () => {
  it('团队名（`.pane-head h3.mono`）+ team_id + 默认团队中性档', async () => {
    await render('t-a')
    const head = one('.md-detail .swap-in > .pane > .pane-head')!
    expect(head.querySelector('h3')?.textContent).toBe('团队甲')
    expect(head.querySelector('.mono.small.muted')?.textContent).toBe('t-a')
    const tags = [...head.querySelectorAll('.tag')]
    expect(tags.map((n) => n.textContent)).toEqual([t('teams.default')])
    // 动作位仍在（`.pane-head .spacer`），且启用/编辑/删除三颗都在
    const spacer = head.querySelector('.spacer')!
    expect(spacer).not.toBeNull()
    expect([...spacer.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      t('teams.activate'),
      t('common.edit'),
      t('common.delete'),
    ])
  })

  it('描述收成一句话（`firstSentence(desc, 60)`），全文进 `title`', async () => {
    await render('t-a')
    const desc = one('.pane-desc')!
    expect(desc.textContent).toBe(firstSentence(LONG_DESC, 60))
    expect(desc.textContent).not.toBe(LONG_DESC)
    expect(desc.getAttribute('title')).toBe(LONG_DESC)
  })

  it('§2.4 #4：`teams.overview` 标题与 kv 整块删除（名称已在 pane-head）', async () => {
    await render('t-a')
    expect(all('.md-detail h4').length).toBe(0)
    // 深挖折叠里的 `.kv` 是唯一一处（下一步单独断言其归属）
    expect(all('.pane .kv').length).toBe(0)
  })

  it('§2.4 #1：概览 kv 的「成员」串不再出现（名册已逐成员可点）', async () => {
    await render('t-a')
    const text = one('.swap-in')!.textContent ?? ''
    expect(text).not.toContain('dev-1×1, dev-2×2')
  })
})

describe('F8 §2.4 #6 / §2.1 常用带：成员表紧凑化，rosterHint 降级为 title', () => {
  it('Pane 头 = `CountLine size="section" bare` 计数 N + `rosterHint` 进 title', async () => {
    await render('t-a')
    const line = countLine(t('teams.roster'))!
    expect(line).toBeDefined()
    expect(line.classList.contains('bare')).toBe(true)
    expect(line.querySelector('.count-num')?.textContent).toBe('2')
    expect(line.getAttribute('title')).toBe(t('teams.rosterHint'))
  })

  it('rosterHint **不再是可见行**：正文里搜不到这段文案', async () => {
    await render('t-a')
    expect(one('.swap-in')!.textContent).not.toContain(t('teams.rosterHint'))
  })

  it('成员逐行可点：`.form-grid > .list-row` 内是 `Ref kind="role"` + `×N`', async () => {
    await render('t-a')
    const rows = all('.form-grid > .list-row')
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.querySelector('.ref')?.getAttribute('href'))).toEqual([
      '#/roles/dev-1',
      '#/roles/dev-2',
    ])
    expect(rows.map((r) => r.querySelector('.tag')?.textContent)).toEqual(['×1', '×2'])
  })
})

describe('F6 合并（§2.4 #5）+ R-v8-6：只剩一处「成员技能集」', () => {
  it('独立「声明技能」Pane 及其清单已消失（团队 frontmatter 的 skills 不再单独列）', async () => {
    await render('t-a')
    // 前置自证：团队**确实**声明了技能，否则本用例可能是「本来就空」的假绿
    expect(data.teams[0]).toMatchObject({ skills: ['team-declared'] })
    expect(skillRef('team-declared')).toBeNull()
    // Pane 标题里不再有「声明技能」（它现在只作 title 用）
    const paneTitles = all('.pane > h3').map((n) => n.textContent)
    expect(paneTitles).not.toContain(t('teams.declaredSkills'))
  })

  it('底部那个同源的独立「团队有效集」Pane 已删：技能集只剩一处', async () => {
    await render('t-a')
    const hits = all('.count-line').filter(
      (n) => n.querySelector('.count-label')?.textContent === t('teams.effective.title'),
    )
    expect(hits.length).toBe(1)
    // 它在 `.two-col` 右栏（知识范围 ∥ 成员技能集），不在两栏之外的第三个位置
    expect(countLine(t('teams.effective.title'))!.closest('.two-col')).not.toBeNull()
  })

  it('R-v8-6：`teams.declaredSkills` 改作技能集头 CountLine 的 `title`（「团队显式声明 N」）', async () => {
    await render('t-a')
    const line = countLine(t('teams.effective.title'))!
    expect(line.getAttribute('title')).toBe(`${t('teams.declaredSkills')} 1`)
    // 有效集计数 = 三条来源各一条（合并去重后仍 3）
    expect(line.querySelector('.count-num')?.textContent).toBe('3')
  })

  it('「由哪些成员角色带进来」的 note 逐行仍在（合并后角色归属没丢）', async () => {
    await render('t-a')
    const note = all('.two-col > .pane:last-child .scope-item .small.muted').map((n) => n.textContent)
    expect(note.length).toBe(3)
    expect(note[0]).toContain(t('teams.effective.from', { roles: 'dev-1 / dev-2' }))
  })

  it('左栏仍是知识范围（层 `.tag` + `Ref kind="book"`，不是被技能集顶掉）', async () => {
    await render('t-a')
    const cols = all('.two-col > .pane')
    expect(cols.length).toBe(2)
    expect(cols[0]!.textContent).toContain(t('teams.layer.project'))
    expect(cols[0]!.querySelector('.ref[href^="#/knowledge"]')?.textContent).toBe('prism')
    expect(one('.two-col')!.textContent).toContain(t('teams.effective.title'))
  })
})

describe('R-v8-7：按 sources 分组，global 组默认折叠（计数常驻）、team/role 默认展开', () => {
  it('global 组走 `<details>` 且**默认收起**（`open === false`）', async () => {
    await render('t-a')
    const fold = one<HTMLDetailsElement>('details.scope-group')
    expect(fold, 'global 组没有折叠容器').not.toBeNull()
    expect(fold!.open).toBe(false)
  })

  it('计数常驻：收起态下组头照样读得到 `全局已装（1）`', async () => {
    await render('t-a')
    const label = one('details.scope-group > summary')?.textContent ?? ''
    expect(label).toBe(
      t('skills.effective.groupCount', { label: t('skills.scope.global'), n: 1 }),
    )
    expect(label).toContain('1')
  })

  it('global 组的那条技能仍在 DOM 里（原生 `<details>` 只隐藏不卸载）', async () => {
    await render('t-a')
    expect(skillRef('g-skill')).not.toBeNull()
    expect(skillRef('g-skill')!.closest('details')).toBe(one('details.scope-group'))
  })

  it('team / role 组不套折叠容器 ⇒ 默认就是展开态（内容直接可见）', async () => {
    await render('t-a')
    // 只有一个折叠容器（global）；team / role 组保持既有 `<div>` + `.rsec-label` 结构
    expect(all('details.scope-group').length).toBe(1)
    for (const name of ['t-skill', 'r-skill']) {
      const ref = skillRef(name)!
      expect(ref, name).not.toBeNull()
      expect(ref.closest('details'), name).toBeNull()
    }
    // 三个组头都在（计数常驻），顺序仍 global → team → role
    expect(all('.scope-groups .rsec-label').map((n) => n.textContent)).toEqual([
      t('skills.effective.groupCount', { label: t('skills.scope.global'), n: 1 }),
      t('skills.effective.groupCount', { label: t('skills.scope.team'), n: 1 }),
      t('skills.effective.groupCount', { label: t('skills.scope.role'), n: 1 }),
    ])
  })

  it('有效集含 global 来源（= `computeEffectiveSkills` 口径，不在 UI 层收窄数据）', async () => {
    await render('t-a')
    // 三条都在 DOM（收起只是不显示，不是不渲染）——R-v8-7 明确「含 global 来源」。
    // ⚠ 必须限定在技能集那一栏：知识范围的每本书也是 `.scope-item`。
    expect(all('.two-col > .pane:last-child .scope-item').length).toBe(3)
  })
})

describe('F8 §2.3/§2.4 #3 深挖带：沉淀规则 / 仲裁链默认折叠，且是全页最后一块', () => {
  it('`<details>` 默认不展开，summary 一行常驻', async () => {
    await render('t-a')
    const fold = one<HTMLDetailsElement>('details.team-deep')
    expect(fold).not.toBeNull()
    expect(fold!.open).toBe(false)
    expect(fold!.querySelector('summary')?.textContent).toBe(t('teams.deepDive'))
  })

  it('沉淀规则与仲裁链都在折叠内（第一眼条里不再常驻这两行）', async () => {
    await render('t-a')
    const fold = one('.team-deep')!
    const text = fold.textContent ?? ''
    expect(text).toContain(t('teams.deposit'))
    expect(text).toContain(`${t('common.yes')}`)
    expect(text).toContain(t('teams.deposit.note'))
    expect(text).toContain(t('teams.arbitration'))
    expect(text).toContain('architect > reviewer')
    // 全页唯一的 `.kv` 就在这里面
    expect(all('.kv').length).toBe(1)
    expect(one('.kv')!.closest('details')).toBe(fold)
  })

  it('深挖带是最后一个直接子块（在常用带之后，不在首屏中部抢权重）', async () => {
    await render('t-a')
    expect(bandOrder().at(-1)).toBe('team-deep')
  })
})

describe('F8 §0.1 红线：启用结果条保持现状（默认一行摘要 + `.rel-link` 展开）', () => {
  it('未点启用时没有结果条；本批未给它加任何新折叠', async () => {
    await render('t-a')
    expect(one('.act-bar')).toBeNull()
    expect(one('details.act-bar')).toBeNull()
  })
})

describe('v11 F2：工作流 Pane 的三态与缺列降级（渲染码一字未改，改的是喂给它的数据）', () => {
  /** 最薄形态：只有序号 + 名称（缺 roles / mode / 三个文本列 / reflow）。 */
  const thin = (): TeamDefinition => ({
    ...team('t-a'),
    workflow: [
      { order: 1, stage: '需求', roles: [], mode: '', input: '', output: '', done: '', reflow: '' },
      { order: 2, stage: '设计', roles: [], mode: '', input: '', output: '', done: '', reflow: '' },
    ],
  })

  it('只有「序号 + 名称」也成链（箭头只出现在第二个之后）', async () => {
    data.teams = [thin()]
    await render('t-a')
    expect(all('.flow-step')).toHaveLength(2)
    expect(all('.flow-arrow')).toHaveLength(1)
    expect(all('.stage-num').map((n) => n.textContent)).toEqual(['1', '2'])
    expect(all('.stage-name').map((n) => n.textContent)).toEqual(['需求', '设计'])
  })

  it('缺 roles ⇒ 明细里画不出角色徽章（行还在，不是整块塌掉）；缺 reflow ⇒ 不画回流那一行', async () => {
    data.teams = [thin()]
    await render('t-a')
    await click(all('.flow-stage')[0]!)

    const labels = all('.flow-detail .scope-label').map((n) => n.textContent)
    expect(labels, '明细整块没展开，后面的断言会假绿').toContain(t('teams.col.owner'))
    expect(all('.flow-detail-val .ref')).toHaveLength(0)
    expect(labels).not.toContain(t('teams.col.reflow'))
  })

  it('prose（小节存在但只有自由文本）⇒ 渲染 Markdown，不画流程链', async () => {
    data.teams = [
      {
        ...team('t-a'),
        workflow: [],
        workflow_raw: {
          columns: [],
          rows: [],
          rowIds: [],
          unmapped: [],
          prose: true,
          proseText: '## 流程\n\n先做 A，再做 B。',
        },
      },
    ]
    await render('t-a')
    expect(one('.wf-prose-body .md-h2')?.textContent).toBe('流程')
    expect(one('.flow-scroll')).toBeNull()
    expect(one('.swap-in')!.textContent).toContain(t('teams.wf.prose.title'))
  })

  it('sectionMissing ⇒ 显式说明「没有这个小节」，不留空白（Pane 仍在，位次不变）', async () => {
    data.teams = [
      {
        ...team('t-a'),
        workflow: [],
        workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], sectionMissing: true },
      },
    ]
    await render('t-a')
    const panes = all('.md-detail .swap-in > .pane')
    expect(panes).toHaveLength(3)
    expect(panes[1]!.textContent).toContain(t('teams.wf.missing.title'))
    expect(one('.flow-scroll')).toBeNull()
  })

  it('没有 `workflow_raw` 的旧响应 ⇒ 走合成底账仍是「表格态」（不误判成 prose / missing）', async () => {
    // 前置自证：夹具**确实**没有 workflow_raw，否则本用例测的是另一条路
    expect((data.teams[0] as TeamDefinition).workflow_raw).toBeUndefined()
    await render('t-a')
    expect(one('.flow-scroll .workflow-flow')).not.toBeNull()
    expect(one('.wf-prose-body')).toBeNull()
    expect(one('.swap-in')!.textContent).not.toContain(t('teams.wf.missing.title'))
  })
})
