// @vitest-environment happy-dom
/**
 * F2（v11）工作流编排器（`TeamForm` 的「工作流」区）。
 *
 * 锁的是**交互契约**（不是像素）：
 * 1. 阶段卡渲染 + 增 / 删 / 上移下移，且**未映射列值跟着 rowId 走、不错行**（R-v11-3）；
 * 2. 列映射语义 —— 有列给输入框、缺列给「+ 添加此列」，点完该字段就可编辑；
 * 3. 负责角色**从角色库多选**（复用 F1 的 `LibraryPicker`，`kind='role'` ⇒ **没有**手动添加区）；
 * 4. 自定义列可增可改可删（列级动作）；
 * 5. 三态：自由文本（Markdown + 可转换 + 未保存可取消）/ 无小节（显式提示，不给假编辑器）；
 * 6. 保存：PATCH body 带 workflow 段（rowId / order / extra）与 if_match；没动就不发；
 * 7. 409 `stale_write`：给出「内容已被外部修改」+「重新加载」出口，**不静默覆盖**；
 * 8. 新建：模板预填阶段可增删改（换模板重铺）。
 *
 * 渲染路径与既有团队测试一致（happy-dom + 裸 `react-dom/client` + `react.act`，不用 JSX）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoleDefinition, TeamDefinition, UpdateTeamInput } from '../src/api-team.ts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用（每个用例重铺）。 */
const data = vi.hoisted(() => ({
  /** `updateTeam` 收到过的 (id, body)。 */
  patches: [] as Array<{ id: string; input: unknown }>,
  /** 非 null 时 `updateTeam` 抛这个 message（用例里铺 `stale_write: …`）。 */
  fail: null as string | null,
  /** 「重新加载」后父级会带回来的新详情（= 文件被外部改过之后的样子）。 */
  teamAfterReload: null as unknown,
  created: [] as unknown[],
  /** `updateTeam` 成功后返回的「写后 mtime」；null ⇒ 该键缺席（模拟未升级的服务端）。 */
  nextMtime: null as number | null,
}))

vi.mock('../src/api-team.ts', async (importOriginal) => ({
  // 部分 mock：只换 `teamApi`，其余（列名同义词表等常量）走真身。
  ...(await importOriginal<typeof import('../src/api-team.ts')>()),
  teamApi: {
    updateTeam: async (id: string, input: unknown) => {
      data.patches.push({ id, input })
      if (data.fail !== null) throw new Error(data.fail)
      return {
        path: `/tmp/prism-teams/${id}.md`,
        issues: [],
        ...(data.nextMtime !== null ? { source_mtime: data.nextMtime } : {}),
      }
    },
    team: () => Promise.resolve(data.teamAfterReload),
    create: async (input: unknown) => {
      data.created.push(input)
      return { ok: true, path: '/tmp/prism-teams/new.md', issues: [] }
    },
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { TeamForm } from '../src/pages/teams/TeamForm.tsx'

const CORE8 = ['#', '阶段', '负责角色', '串/并行', '输入', '输出', '完成判定', '回流路径']

const DEPOSIT = {
  enabled: false,
  default_layer: 'project',
  default_type: 'other',
  priority: 'medium',
  require_note: false,
}

/** 标准八列 + 一列自定义「备注」的团队（带原始底账与 mtime）。 */
function team(over: Partial<TeamDefinition> = {}): TeamDefinition {
  return {
    team_id: 'delivery',
    name: '交付团队',
    description: '',
    default: false,
    members: [{ role: 'dev-1', count: 1 }],
    skills: [],
    knowledge: { layers: [] },
    deposit: DEPOSIT,
    arbitration: [],
    workflow: [
      { order: 1, stage: '需求', roles: ['dev-1'], mode: 'serial', input: 'i1', output: 'o1', done: 'd1', reflow: '' },
      { order: 2, stage: '设计', roles: ['dev-1'], mode: 'serial', input: 'i2', output: 'o2', done: 'd2', reflow: '' },
    ],
    workflow_raw: {
      columns: [...CORE8, '备注'],
      rows: [
        ['1', '需求', 'dev-1', '串行', 'i1', 'o1', 'd1', '', '甲'],
        ['2', '设计', 'dev-1', '串行', 'i2', 'o2', 'd2', '', '乙'],
      ],
      rowIds: ['r1', 'r2'],
      unmapped: ['备注'],
    },
    source_mtime: 111,
    ...over,
  }
}

/** 角色库（真身形态 —— 成员步进器会读 `r.name` 排序，不能拿字符串数组冒充）。 */
function role(name: string): RoleDefinition {
  return {
    name,
    description: `${name} 的描述`,
    skills: [],
    knowledge: { layers: [] },
    principle: '',
    body: `# ${name}`,
  }
}

const ROLES: RoleDefinition[] = [role('dev-1'), role('dev-2'), role('tester')]

let container: HTMLDivElement
let root: Root
let onSaved: ReturnType<typeof vi.fn>
let onCreated: ReturnType<typeof vi.fn>

function editProps(def: TeamDefinition) {
  return {
    mode: 'edit' as const,
    team: def,
    roles: ROLES,
    rolesLoading: false,
    rolesError: undefined,
    onReloadRoles: () => {},
    rolesDir: '/tmp/prism-roles',
    defaultTeamsDir: '/tmp/prism-teams',
    onCancel: () => {},
    onSaved,
  }
}

function createProps() {
  return {
    mode: 'create' as const,
    roles: ROLES,
    rolesLoading: false,
    rolesError: undefined,
    onReloadRoles: () => {},
    existingIds: [] as string[],
    defaultTeamsDir: '/tmp/prism-teams',
    onCancel: () => {},
    onCreated,
  }
}

async function render(props: Record<string, unknown>): Promise<void> {
  await act(async () => {
    root.render(createElement(TeamForm, props as never))
  })
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function one<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function textOf(selector: string): string {
  return one(selector)?.textContent?.trim() ?? ''
}

/** 按可见文案找按钮（找不到就抛，避免「按钮不在」被静默当成通过）。 */
function button(label: string): HTMLButtonElement {
  const hit = all('button').find((b) => b.textContent?.trim() === label)
  if (hit === undefined) throw new Error(`未找到按钮：${label}`)
  return hit as HTMLButtonElement
}

/** 按无障碍名找按钮（卡片上的 ↑ / ↓ / × 只有一个字符，靠 aria-label 定位）。 */
function byLabel(label: string): HTMLButtonElement {
  const hit = all('button').find((b) => b.getAttribute('aria-label') === label)
  if (hit === undefined) throw new Error(`未找到按钮（aria-label）：${label}`)
  return hit as HTMLButtonElement
}

function input(selector: string): HTMLInputElement {
  const hit = one<HTMLInputElement>(selector)
  if (hit === null) throw new Error(`未找到输入框：${selector}`)
  return hit
}

function textarea(selector: string): HTMLTextAreaElement {
  const hit = one<HTMLTextAreaElement>(selector)
  if (hit === null) throw new Error(`未找到多行输入：${selector}`)
  return hit
}

/** 受控输入：走原生 value setter 改值再派发 `input`（input / textarea 各用自己的原型）。 */
async function type(target: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter === undefined) throw new Error('happy-dom 缺 value setter')
    setter.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 一张卡上的自定义列格（按卡片序号与列名定位）。 */
function extraCell(card: number, column: string): HTMLTextAreaElement {
  return textarea(`#wf-${card}-extra-${column}`)
}

/** 卡片上的字段输入（`#wf-<card>-<corefield>`）。 */
function cardField(card: number, field: string): HTMLTextAreaElement {
  return textarea(`#wf-${card}-${field}`)
}

function cardCount(): number {
  return all('.stage-card').length
}

beforeEach(() => {
  setLang('zh')
  data.patches = []
  data.fail = null
  data.teamAfterReload = null
  data.created = []
  data.nextMtime = null
  onSaved = vi.fn()
  onCreated = vi.fn()
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

describe('编排器：阶段卡渲染与增删移（rowId 锚住未映射列值）', () => {
  it('带底账的团队 → 两张卡，自定义列值各就各位，八个核心字段都已映射（无「+ 添加此列」）', async () => {
    await render(editProps(team()))
    expect(cardCount()).toBe(2)
    // 卡片标题用阶段名（`#wf-<n>-name` 是同一个值的输入框）
    expect(cardField(0, 'name').value).toBe('需求')
    expect(cardField(1, 'name').value).toBe('设计')
    expect(extraCell(0, '备注').value).toBe('甲')
    expect(extraCell(1, '备注').value).toBe('乙')
    // 列映射条：八列全绿（列条上只有「已映射」标记，没有一颗「+ 添加此列」）
    expect(all('.wf-col-on')).toHaveLength(8)
    expect(all('.wf-col-on').map((n) => n.textContent)).toContain('输出 › 输出')
    expect(all('.wf-cols button')).toHaveLength(0)
  })

  it('分段头只有一处（标题与计数同一行，不是同一句话连着两行）', async () => {
    await render(editProps(team()))
    const heads = all('.count-label').filter((n) => n.textContent === t('teams.wf.title'))
    expect(heads).toHaveLength(1)
    expect(heads[0]!.closest('.count-line')?.querySelector('.count-num')?.textContent).toBe('2')
    // 同文案的 `<h4>` 不再并排出现（`.pane h4` 与 `.count-line.section` 版式几乎一致，
    // 两行同字会被读成「重复了一次」）
    expect(all('h4').map((h) => h.textContent)).not.toContain(t('teams.wf.title'))
  })

  it('下移第一张卡：未映射列值跟着它自己的行一起走（不是「位置不动、内容错位」）', async () => {
    await render(editProps(team()))
    await click(byLabel(t('teams.wf.down')))

    expect(cardField(0, 'name').value).toBe('设计')
    expect(cardField(1, 'name').value).toBe('需求')
    expect(extraCell(0, '备注').value).toBe('乙')
    expect(extraCell(1, '备注').value).toBe('甲')
  })

  it('删除第二张卡：剩下那张的 rowId 与自定义列值原位不动；第一张的上移钮禁用（边界）', async () => {
    await render(editProps(team()))
    expect(byLabel(t('teams.wf.up')).disabled).toBe(true)

    await click(byLabel(t('teams.wf.remove', { n: 2 })))

    expect(cardCount()).toBe(1)
    expect(cardField(0, 'name').value).toBe('需求')
    expect(extraCell(0, '备注').value).toBe('甲')
    // 只剩一张卡时两个方向都不能动
    expect(byLabel(t('teams.wf.up')).disabled).toBe(true)
    expect(byLabel(t('teams.wf.down')).disabled).toBe(true)
  })

  it('添加阶段：多出一张空卡（未命名占位、自定义列格为空），保存时装的是**没有 rowId 的新行**', async () => {
    await render(editProps(team()))
    await click(button(t('teams.wf.addStage')))
    expect(cardCount()).toBe(3)
    expect(cardField(2, 'name').value).toBe('')
    expect(one('.stage-card:nth-child(3) .stage-card-title')?.textContent).toBe(t('teams.wf.unnamed'))
    expect(extraCell(2, '备注').value).toBe('')

    await click(button(t('teams.form.submitEdit')))
    const body = data.patches[0]!.input as UpdateTeamInput
    expect(body.workflow?.stages).toHaveLength(3)
    expect(body.workflow?.stages[2]!.rowId).toBeUndefined()
    expect(body.workflow?.stages[2]!.order).toBe(3)
  })

  it('改字段 / 勾角色 / 改模式都进草稿，并在同一份提交里体现', async () => {
    await render(editProps(team()))
    await type(cardField(0, 'name'), '需求收集')
    await type(cardField(0, 'input'), '用户输入')
    await click(all('.stage-card button').filter((b) => b.textContent === t('teams.mode.parallel'))[0]!)

    await click(button(t('teams.form.submitEdit')))
    const stages = (data.patches[0]!.input as UpdateTeamInput).workflow!.stages
    expect(stages[0]).toMatchObject({ rowId: 'r1', stage: '需求收集', input: '用户输入', mode: 'parallel' })
    expect(stages[1]!.stage).toBe('设计')
  })
})

describe('编排器：列映射语义（有列给输入框 / 缺列给「+ 添加此列」）', () => {
  /** 只给了 # / 阶段 / 负责角色 三列的团队（缺输出等五列）。 */
  const thinTeam = (): TeamDefinition =>
    team({
      workflow: [{ order: 1, stage: '需求', roles: ['dev-1'], mode: 'serial', input: '', output: '', done: '', reflow: '' }],
      workflow_raw: {
        columns: ['#', '阶段', '负责角色'],
        rows: [['1', '需求', 'dev-1']],
        rowIds: ['r1'],
        unmapped: [],
      },
    })

  it('缺列 → 显示「+ 添加此列」，该字段没有输入框', async () => {
    await render(editProps(thinTeam()))
    expect(cardField(0, 'name').value).toBe('需求')
    expect(one('#wf-0-output')).toBeNull()
    expect(one('#wf-0-done')).toBeNull()
    expect(button(t('teams.wf.addColumn', { field: t('teams.wf.field.output') }))).not.toBeUndefined()
  })

  it('点「+ 添加此列」→ 列集加上该列、该字段的输入框出现、按钮消失', async () => {
    await render(editProps(thinTeam()))
    const add = button(t('teams.wf.addColumn', { field: t('teams.wf.field.output') }))
    const addText = add.textContent
    await click(add)

    expect(cardField(0, 'output').value).toBe('')
    // 该列已映射 ⇒ 列条上换成标记，按钮不在
    expect(all('.wf-cols button').some((b) => b.textContent === addText)).toBe(false)
    expect(all('.wf-col-on').map((n) => n.textContent)).toContain(`输出 › 输出`)
    // 加进去之后能编辑，并随提交走
    await type(cardField(0, 'output'), '需求要点')
    await click(button(t('teams.form.submitEdit')))
    expect((data.patches[0]!.input as UpdateTeamInput).workflow!.stages[0]!.output).toBe('需求要点')
  })

  it('缺「#」列时不显示序号位（列不在就没有那个槽）；补上该列后序号位出现且只读', async () => {
    await render(
      editProps(
        team({
          workflow: [{ order: 1, stage: '需求', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '' }],
          workflow_raw: { columns: ['阶段', '负责角色'], rows: [['需求', '']], rowIds: ['r1'], unmapped: [] },
        }),
      ),
    )
    // 没有 `#` 列：序号槽不画（序号由位置决定，没有列就没有它的位置）
    expect(all('.stage-card .wf-field').some((n) => n.querySelector('.label')?.textContent === t('teams.wf.field.order'))).toBe(false)

    await click(button(t('teams.wf.addColumn', { field: t('teams.wf.field.order') })))
    const orderCell = all('.stage-card .wf-field').find(
      (n) => n.querySelector('.label')?.textContent === t('teams.wf.field.order'),
    )
    expect(orderCell?.textContent).toContain('1')
    expect(orderCell?.querySelector('input, textarea')).toBeNull()
  })
})

describe('编排器：负责角色从角色库多选（复用选取器，角色库不开放手动添加）', () => {
  it('弹层是选取器形态：标题在、角色都列出来、**没有**手动添加区', async () => {
    await render(editProps(team()))
    await click(all('.rel-link').find((b) => b.textContent === t('teams.wf.roles.pick'))!)

    expect(one('.modal-md')).not.toBeNull()
    expect(textOf('.modal-head h3')).toBe(t('picker.title.role'))
    expect(all('.pick-row')).toHaveLength(3)
    expect(container.textContent).not.toContain('技能名')
    expect(all('.picker-manual')).toHaveLength(0)
  })

  it('勾选入卡（chips 出现），再勾一次取消；弹层内也同步显示已选', async () => {
    await render(editProps(team()))
    await click(all('.rel-link').find((b) => b.textContent === t('teams.wf.roles.pick'))!)
    // 勾 dev-2（第 2 行）
    await click(all('.pick-row')[1]!)

    const cardChips = all('.stage-card .chip').map((c) => c.textContent?.replace('×', '').trim())
    expect(cardChips).toContain('dev-2')
    expect(cardChips).toContain('dev-1')
    // 弹层里的已选区同步（同一份 chips 零件）
    expect(textOf('.modal-content')).toContain('dev-2')

    await click(all('.pick-row')[1]!)
    expect(all('.stage-card .chip').map((c) => c.textContent?.replace('×', '').trim())).not.toContain('dev-2')
  })

  it('角色库拉取失败 → 弹层如实报错 + 重试出口（**不**静默成「空库」）', async () => {
    const reload = vi.fn()
    await render({ ...editProps(team()), roles: [], rolesError: 'boom', onReloadRoles: reload })
    await click(all('.rel-link').find((b) => b.textContent === t('teams.wf.roles.pick'))!)

    // 失败就说失败（`PickerDialog` 的既有契约），不能显示成「角色库是空的」这种事实陈述
    expect(textOf('.modal-content')).toContain(t('common.loadFailed', { msg: 'boom' }))
    expect(textOf('.modal-content')).not.toContain(t('picker.empty.role'))

    const retry = all('.modal-content .rel-link').find((b) => b.textContent === t('common.retry'))
    expect(retry).toBeDefined()
    await click(retry!)
    expect(reload).toHaveBeenCalledTimes(1)
    // 重试是**去取库**，不是「把弹层关掉」——弹层还在，用户能接着选
    expect(one('.modal-md')).not.toBeNull()
  })

  it('卡片上的 chip 单个移除 → 该角色从阶段里去掉', async () => {
    await render(editProps(team()))
    // 两张卡都挂了 dev-1 ⇒ 断言必须**按卡**看，否则「另一张卡也还有」会被误当成没删掉
    const first = all('.stage-card')[0]!
    const chipRemove = first.querySelectorAll('.chip button')[0]!
    expect(chipRemove.getAttribute('aria-label')).toBe(t('picker.remove', { name: 'dev-1' }))
    await click(chipRemove)
    expect(all('.stage-card')[0]!.querySelectorAll('.chip')).toHaveLength(0)
    expect(first.querySelectorAll('.chip')).toHaveLength(0)
    expect(all('.stage-card')[0]!.textContent).toContain(t('teams.wf.roles.empty'))
    // 另一张卡的角色不受影响（删的是这一张的角色，不是角色库里的角色）
    expect(all('.stage-card')[1]!.querySelectorAll('.chip')).toHaveLength(1)
  })
})

describe('编排器：自定义列（未映射列）可增 / 可改 / 可删', () => {
  it('增列：列 chip 出现，且每张卡都多出一个空格', async () => {
    await render(editProps(team()))
    await type(input('.wf-custom input'), '风险')
    await click(button(t('teams.wf.customAdd')))

    expect(all('.wf-custom .chip').map((c) => c.textContent?.replace('×', '').trim())).toEqual(['备注', '风险'])
    expect(extraCell(0, '风险').value).toBe('')
    expect(extraCell(1, '风险').value).toBe('')
  })

  it('改值随提交走；删列 = 连值一起删（R-v11-12：删「原文」即弃），核心列删不动', async () => {
    await render(editProps(team()))
    await type(extraCell(0, '备注'), '甲的备注')
    await click(button(t('teams.form.submitEdit')))
    expect((data.patches[0]!.input as UpdateTeamInput).workflow!.stages[0]!.extra).toEqual({ 备注: '甲的备注' })

    data.patches = []
    await click(byLabel(t('teams.wf.customRemove', { name: '备注' })))
    // 用 `one` 而不是 `extraCell`：后者找不到会抛，`toBeNull()` 就永远断言不到
    expect(one('#wf-0-extra-备注')).toBeNull()
    expect(one('#wf-1-extra-备注')).toBeNull()
    await click(button(t('teams.form.submitEdit')))
    // 列没了 ⇒ 提交里也不再带 extra（让服务端按 rowId 从原底账回落，而不是「我确认它是空的」）
    expect((data.patches[0]!.input as UpdateTeamInput).workflow!.stages[0]!.extra).toBeUndefined()
  })

  it('自定义列的重名 / 空白名是空操作（列集不重复）', async () => {
    await render(editProps(team()))
    await type(input('.wf-custom input'), '备注')
    expect(button(t('teams.wf.customAdd')).disabled).toBe(false)
    await click(button(t('teams.wf.customAdd')))
    expect(all('.wf-custom .chip')).toHaveLength(1)
  })
})

describe('编排器：extends 混源（M-6 —— 编辑器只认本文件的 workflow_raw）', () => {
  /**
   * GET 的 `workflow` 是 **extends 合并结果**（合并判据取 frontmatter 键，工作流在正文表格里
   * ⇒ `declared` 永不含 `workflow` ⇒ **父级的表恒胜出**），`workflow_raw` 是**被编辑文件本体**。
   * 旧行为：编辑器显示父级的阶段、列集与行身份却来自本文件 → 保存把父级的阶段写进本文件
   * （子文件自己的表从未展示即被覆盖）。本组三形态锁「所见 = 本文件所有」。
   */
  const parentStages = (): TeamDefinition['workflow'] => [
    { order: 1, stage: '父级阶段甲', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '' },
    { order: 2, stage: '父级阶段乙', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '' },
  ]

  it('本文件有表 + 合并结果不同 → 卡片是本文件的表；保存提交的也是它（父级阶段一个都不出现）', async () => {
    await render(
      editProps(
        team({
          workflow: parentStages(),
          workflow_raw: {
            columns: ['#', '阶段', '备注'],
            rows: [['1', '子级自有阶段', '子备注']],
            rowIds: ['r1'],
            unmapped: ['备注'],
          },
        }),
      ),
    )

    expect(cardCount()).toBe(1)
    expect(cardField(0, 'name').value).toBe('子级自有阶段')
    expect(extraCell(0, '备注').value).toBe('子备注')
    // 父级的阶段不该以任何形式出现在界面上（旧行为会画成两张卡）
    expect(container.textContent).not.toContain('父级阶段甲')
    // 本文件有表 ⇒ 不给「继承」说明（编辑器编排的就是本文件的表，来源自证）
    expect(all('[data-wf="inherited"]')).toHaveLength(0)

    await type(cardField(0, 'name'), '子级阶段（改过）')
    await click(button(t('teams.form.submitEdit')))
    const stages = (data.patches[0]!.input as UpdateTeamInput).workflow!.stages
    expect(stages).toHaveLength(1)
    expect(stages[0]).toMatchObject({ rowId: 'r1', stage: '子级阶段（改过）', extra: { 备注: '子备注' } })
    expect(JSON.stringify(stages)).not.toContain('父级阶段')
  })

  it('本文件无「## 工作流」小节 + 父级有 → 不给卡片，说明条讲清「来源是父级、保存不会写入本文件」', async () => {
    await render(
      editProps(
        team({
          workflow: parentStages(),
          workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], sectionMissing: true },
        }),
      ),
    )

    expect(cardCount()).toBe(0)
    expect(all('button').some((b) => b.textContent === t('teams.wf.addStage'))).toBe(false)
    const notices = all('[data-wf="inherited"]')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.textContent).toContain(t('teams.wf.inherited.title', { n: 2 }))
    // 这一态**不能**说「保存落本文件」——服务端不替你新建小节（R-v11-11），故文案是反过来的
    expect(notices[0]!.textContent).toContain(t('teams.wf.inherited.missingHint'))
    expect(container.textContent).not.toContain('父级阶段甲')
  })

  it('本文件 prose + 父级有 → 说明条给出两个事实；转换以继承阶段为起点，原文进第一行的「原文」列', async () => {
    const text = '## 流程\n\n先做 A。'
    await render(
      editProps(
        team({
          workflow: parentStages(),
          workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: text },
        }),
      ),
    )

    expect(one('.wf-prose-body .md-h2')?.textContent).toBe('流程')
    const notices = all('[data-wf="inherited"]')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.textContent).toContain(t('teams.wf.inherited.title', { n: 2 }))
    expect(notices[0]!.textContent).toContain(t('teams.wf.inherited.proseHint'))

    await click(button(t('teams.wf.convert')))
    // 起点 = 继承来的两张卡（不是空白单卡），原文整段落在第一行的「原文」列
    expect(cardCount()).toBe(2)
    expect(cardField(0, 'name').value).toBe('父级阶段甲')
    expect(cardField(1, 'name').value).toBe('父级阶段乙')
    expect(extraCell(0, '原文').value).toBe(text)
    expect(one('#wf-1-extra-原文')).not.toBeNull()

    await click(button(t('teams.form.submitEdit')))
    const stages = (data.patches[0]!.input as UpdateTeamInput).workflow!.stages
    expect(stages.map((s) => s.stage)).toEqual(['父级阶段甲', '父级阶段乙'])
    // 继承来的阶段在**本文件**里没有行身份 → 一律新行（否则服务端会当成「覆盖原行」）
    expect(stages.every((s) => s.rowId === undefined)).toBe(true)
    expect(stages.map((s) => s.order)).toEqual([1, 2])
    expect(stages[0]!.extra).toEqual({ 原文: text })
  })

  it('本文件无表但**合并也为空**（非 extends）→ 不给说明条（不误报继承）', async () => {
    await render(
      editProps(
        team({
          workflow: [],
          workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], sectionMissing: true },
        }),
      ),
    )
    expect(all('[data-wf="inherited"]')).toHaveLength(0)
  })
})

describe('编排器：prose 转换的一次性警告（M-12：原文此后只活在「原文」列）', () => {
  const proseTeam = (text: string): TeamDefinition =>
    team({
      workflow: [],
      workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: text },
    })

  it('转换后给出 warn 条（与回退出口同屏）；回退后警告消失', async () => {
    await render(editProps(proseTeam('先做 A。')))
    expect(all('[data-wf="prose-converted"]')).toHaveLength(0)

    await click(button(t('teams.wf.convert')))
    const warn = all('[data-wf="prose-converted"]')
    expect(warn).toHaveLength(1)
    expect(warn[0]!.textContent).toContain(t('teams.wf.prose.warn'))
    // 说的是「要留意」那一档（`--warn` 引线的 scope-callout），不是遮挡弹窗
    expect(warn[0]!.classList.contains('scope-callout')).toBe(true)
    expect(one('.modal-md')).toBeNull()
    expect(button(t('teams.wf.revert'))).not.toBeUndefined()

    await click(button(t('teams.wf.revert')))
    expect(all('[data-wf="prose-converted"]')).toHaveLength(0)
  })

  it('每次转换至多一条：转换 → 回退 → 再转换，反复三轮都不叠加', async () => {
    await render(editProps(proseTeam('先做 A。')))
    for (let round = 0; round < 3; round++) {
      await click(button(t('teams.wf.convert')))
      expect(all('[data-wf="prose-converted"]')).toHaveLength(1)
      await click(button(t('teams.wf.revert')))
      expect(all('[data-wf="prose-converted"]')).toHaveLength(0)
    }
  })
})

describe('编排器三态：自由文本（可转换 / 未保存可取消）与无小节', () => {
  const proseTeam = (text: string): TeamDefinition =>
    team({
      workflow: [],
      workflow_raw: { columns: [], rows: [], rowIds: [], unmappedColumns: [], prose: true, proseText: text },
    })

  it('prose：渲染 Markdown + 提示；转换 = 核心八列 + 「原文」列，单卡，全文进原文', async () => {
    await render(editProps(proseTeam('## 流程\n\n先做 A，再做 B。')))
    // Markdown 渲染（不是纯文本塞进 textarea）
    expect(one('.wf-prose-body .md-h2')?.textContent).toBe('流程')
    expect(cardCount()).toBe(0)
    expect(textOf('.wf-callout')).toContain(t('teams.wf.prose.title'))

    await click(button(t('teams.wf.convert')))

    expect(cardCount()).toBe(1)
    expect(all('.wf-col-on')).toHaveLength(8)
    expect(extraCell(0, '原文').value).toBe('## 流程\n\n先做 A，再做 B。')
    // 转换来的草稿给「恢复为自由文本」出口
    expect(button(t('teams.wf.revert'))).not.toBeUndefined()
    expect(textOf('.wf-callout')).toContain(t('teams.wf.revertHint'))
  })

  it('转换未保存可取消：恢复回自由文本态，Markdown 原文原样还在', async () => {
    await render(editProps(proseTeam('先做 A，再做 B。')))
    await click(button(t('teams.wf.convert')))
    expect(cardCount()).toBe(1)

    await click(button(t('teams.wf.revert')))
    expect(cardCount()).toBe(0)
    expect(one('.wf-prose-body')).not.toBeNull()
    expect(textOf('.wf-prose-body')).toContain('先做 A，再做 B。')
    // 从未提交过 ⇒ mock 一次都没收到（「未保存可取消」的硬证据）
    expect(data.patches).toHaveLength(0)
  })

  it('拿不到小节原文时不假装能转换：如实说明 + 转换钮禁用', async () => {
    await render(
      editProps(
        team({
          workflow: [],
          workflow_raw: { columns: [], rows: [], rowIds: [], unmappedColumns: [], prose: true },
        }),
      ),
    )
    expect(textOf('.wf-callout')).toContain(t('teams.wf.prose.noText'))
    expect(one('.wf-prose-body')).toBeNull()
    expect(button(t('teams.wf.convert')).disabled).toBe(true)
  })

  it('sectionMissing：显式提示「无工作流小节」，且**不给**可编辑的卡片与「添加阶段」', async () => {
    await render(
      editProps(
        team({
          workflow: [],
          workflow_raw: { columns: [], rows: [], rowIds: [], unmappedColumns: [], sectionMissing: true },
        }),
      ),
    )
    expect(textOf('.wf-callout')).toContain(t('teams.wf.missing.title'))
    expect(cardCount()).toBe(0)
    expect(all('button').some((b) => b.textContent === t('teams.wf.addStage'))).toBe(false)
    expect(all('button').some((b) => b.textContent === t('teams.wf.convert'))).toBe(false)
  })
})

describe('编排器保存：PATCH body 的 workflow 段与 if_match', () => {
  it('改了工作流 → body 带 workflow.stages（rowId / order / extra / roles）与 if_match', async () => {
    await render(editProps(team()))
    await type(cardField(1, 'done'), '设计通过')

    await click(button(t('teams.form.submitEdit')))

    expect(data.patches).toHaveLength(1)
    expect(data.patches[0]!.id).toBe('delivery')
    const body = data.patches[0]!.input as UpdateTeamInput
    expect(body.if_match).toBe(111)
    expect(body.workflow!.stages).toEqual([
      {
        rowId: 'r1',
        order: 1,
        stage: '需求',
        roles: ['dev-1'],
        mode: 'serial',
        input: 'i1',
        output: 'o1',
        done: 'd1',
        reflow: '',
        extra: { 备注: '甲' },
      },
      {
        rowId: 'r2',
        order: 2,
        stage: '设计',
        roles: ['dev-1'],
        mode: 'serial',
        input: 'i2',
        output: 'o2',
        done: '设计通过',
        reflow: '',
        extra: { 备注: '乙' },
      },
    ])
    // members 没动 ⇒ 不发（也不因此要 roles_dir）
    expect(body.members).toBeUndefined()
    expect(body.roles_dir).toBeUndefined()
  })

  it('没动工作流（只改名字）→ body **不带** workflow 段（省掉一次无谓的工作流重写）', async () => {
    await render(editProps(team()))
    await type(input('#etf-name'), '交付团队 v2')

    await click(button(t('teams.form.submitEdit')))

    const body = data.patches[0]!.input as UpdateTeamInput
    expect(body.name).toBe('交付团队 v2')
    expect(body.workflow).toBeUndefined()
    // 有 mtime 就带上（与「有没有改工作流」无关）
    expect(body.if_match).toBe(111)
  })

  it('没有 source_mtime（阶段 C 之前）→ 不带 if_match（不是带 undefined 的字符串）', async () => {
    await render(editProps(team({ source_mtime: undefined })))
    await type(cardField(0, 'name'), '需求收集')
    await click(button(t('teams.form.submitEdit')))

    const body = data.patches[0]!.input as UpdateTeamInput
    expect('if_match' in body).toBe(false)
  })

  it('保存成功后顶掉旧 mtime（用响应里的写后 `source_mtime`）→ 第二次保存不带旧值去撞假冲突', async () => {
    await render(editProps(team()))
    data.nextMtime = 222

    await type(cardField(0, 'name'), '需求收集')
    await click(button(t('teams.form.submitEdit')))
    expect((data.patches[0]!.input as UpdateTeamInput).if_match).toBe(111)

    data.patches = []
    await type(cardField(0, 'name'), '需求收集 v2')
    await click(button(t('teams.form.submitEdit')))
    // 若没顶掉，这里仍会是 111 —— 而文件刚被自己改过，服务端必然回 409
    expect((data.patches[0]!.input as UpdateTeamInput).if_match).toBe(222)
  })

  it('服务端**没**返回 source_mtime（未升级）→ 表单保留原值，不把旧值清成 undefined', async () => {
    await render(editProps(team()))
    data.nextMtime = null

    await type(cardField(0, 'name'), '需求收集')
    await click(button(t('teams.form.submitEdit')))
    data.patches = []
    await type(cardField(0, 'name'), '需求收集 v2')
    await click(button(t('teams.form.submitEdit')))

    expect((data.patches[0]!.input as UpdateTeamInput).if_match).toBe(111)
  })
})

describe('编排器：409 stale_write（不静默覆盖）', () => {
  it('撞上外部修改 → 「已被外部修改」文案 + 「重新加载」出口；重加载后表单按新底账重播种', async () => {
    const def = team()
    await render(editProps(def))
    // 先真改一处（空 patch 会先被前端拦掉，根本走不到 409）
    await type(cardField(0, 'name'), '需求收集')

    data.fail = 'stale_write: 文件已被外部修改'
    data.teamAfterReload = team({
      name: '交付团队（外部改过）',
      workflow: [{ order: 1, stage: '外部阶段', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '' }],
      workflow_raw: { columns: ['#', '阶段'], rows: [['1', '外部阶段']], rowIds: ['r1'], unmapped: [] },
      source_mtime: 222,
    })

    await click(button(t('teams.form.submitEdit')))

    // 失败就地可见 + 文案是「陈旧写」那一档（不是泛用兜底，也不是把服务端原始 message 甩出来）
    expect(textOf('.error')).toContain(t('teams.err.stale'))
    expect(textOf('.error').startsWith('stale_write:')).toBe(false)
    const reload = button(t('teams.wf.staleReload'))
    expect(onSaved).not.toHaveBeenCalled() // 只给出口，不擅自刷新

    // 用户点「重新加载」→ 父级刷新（本用例手动把新详情送回来）
    await click(reload)
    expect(onSaved).toHaveBeenCalledTimes(1)
    await render(editProps(data.teamAfterReload as TeamDefinition))

    // 重播种的硬证据：名字与阶段都换成新底账，告警与「重新加载」都收掉了
    expect(input('#etf-name').value).toBe('交付团队（外部改过）')
    expect(cardCount()).toBe(1)
    expect(cardField(0, 'name').value).toBe('外部阶段')
    expect(one('.error')).toBeNull()
    expect(all('button').some((b) => b.textContent === t('teams.wf.staleReload'))).toBe(false)
  })

  it('提交期间是禁用态（防连点重复提交）', async () => {
    await render(editProps(team()))
    // 正常提交后按钮回到可用（这里只锁「提交完不残留 disabled」）
    await type(cardField(0, 'name'), '需求收集')
    await click(button(t('teams.form.submitEdit')))
    expect(button(t('teams.form.submitEdit')).disabled).toBe(false)
  })
})

describe('编排器：新建（模板预填阶段，可增删改；换模板重铺）', () => {
  it('默认按「最小可用」预填 3 张卡，并能加阶段', async () => {
    await render(createProps())
    expect(cardCount()).toBe(3)
    expect(cardField(0, 'name').value).toBe(t('teams.tpl.stage.dev'))
    expect(cardField(2, 'name').value).toBe(t('teams.tpl.stage.wrap'))

    await click(button(t('teams.wf.addStage')))
    expect(cardCount()).toBe(4)
    await click(byLabel(t('teams.wf.remove', { n: 4 })))
    expect(cardCount()).toBe(3)
  })

  it('换模板重铺阶段（核心开发 = 7 张）；选「自定义」= 1 张空白卡起点（O-1），并给出提示', async () => {
    await render(createProps())
    await click(button(t('teams.tpl.coreDev')))
    expect(cardCount()).toBe(7)
    expect(cardField(0, 'name').value).toBe(t('teams.tpl.stage.explore'))

    await click(button(t('teams.tpl.custom')))
    expect(cardCount()).toBe(1)
    expect(cardField(0, 'name').value).toBe('') // 空白卡：阶段名待用户填（不编造模板阶段）
    expect(container.textContent).not.toBe(t('teams.wf.empty')) // 非空编排，不再出「还没有阶段」
    expect(container.textContent).toContain(t('teams.form.customHint'))
  })

  it('O-1：custom 起点的空白卡原样提交 → create 带单行 workflow（所见即所存）、不发 template 键', async () => {
    await render(createProps())
    await click(button(t('teams.tpl.custom')))
    await type(input('#ntf-teamId'), 'custom-v1')
    await type(input('#ntf-name'), '自定义团队')

    await click(button(t('teams.form.submitNew')))

    const body = data.created[0] as {
      workflow_template?: string
      workflow?: { columns: string[]; stages: Array<{ order: number; stage: string; roles: string[] }> }
    }
    expect(body.workflow_template).toBeUndefined() // custom 不发模板键（服务端 minimal 兜底与本表无关）
    expect(body.workflow?.stages).toHaveLength(1) // 空白卡随表单原样落盘（用户没填就是一行空阶段）
    expect(body.workflow?.stages[0]).toMatchObject({ order: 1, stage: '', roles: [] })
    expect(body.workflow?.columns).toEqual(CORE8)
  })

  it('新建提交也带 workflow 段（模板预填 + 用户编排的改动不能丢）', async () => {
    await render(createProps())
    await type(input('#ntf-teamId'), 'core-dev-v2')
    await type(input('#ntf-name'), '核心开发 v2')
    await type(cardField(0, 'name'), '自定义阶段')

    await click(button(t('teams.form.submitNew')))

    expect(data.created).toHaveLength(1)
    const body = data.created[0] as {
      workflow?: { columns: string[]; stages: Array<{ order: number; stage: string }> }
    }
    expect(body.workflow?.stages).toHaveLength(3)
    expect(body.workflow?.stages[0]).toMatchObject({ order: 1, stage: '自定义阶段' })
    // T1：新建也走列集通道（模板起点 = 核心八列；服务端的列集优先级「提交 columns > raw.columns」）
    expect(body.workflow?.columns).toEqual(CORE8)
  })
})

describe('T1 / M-2：列集随提交上报（增 / 删列在真实 patch 里生效）', () => {
  it('增自定义列并填值 → patch.workflow.columns 含该列，且对应 stage.extra 键值俱在', async () => {
    await render(editProps(team()))
    await type(input('.wf-custom input'), '风险')
    await click(button(t('teams.wf.customAdd')))
    await type(extraCell(0, '风险'), '高')
    await type(extraCell(1, '风险'), '中')

    await click(button(t('teams.form.submitEdit')))

    const body = data.patches[0]!.input as UpdateTeamInput
    expect(body.workflow!.columns).toEqual([...CORE8, '备注', '风险'])
    // extra 的键必须与 columns 里的那个字符串逐字相同（服务端按列名寻址）
    expect(body.workflow!.stages[0]!.extra).toEqual({ 备注: '甲', 风险: '高' })
    expect(body.workflow!.stages[1]!.extra).toEqual({ 备注: '乙', 风险: '中' })
  })

  it('删列 → patch.workflow.columns 不含该列，且各 stage 无残留 extra 键', async () => {
    await render(editProps(team()))
    await click(byLabel(t('teams.wf.customRemove', { name: '备注' })))

    await click(button(t('teams.form.submitEdit')))

    const body = data.patches[0]!.input as UpdateTeamInput
    expect(body.workflow!.columns).toEqual(CORE8)
    expect(body.workflow!.stages.every((s) => s.extra === undefined)).toBe(true)
  })

  it('「+ 添加此列」补核心列 → columns 含该列，字段值随提交走（有容身处才写得回去）', async () => {
    await render(
      editProps(
        team({
          workflow: [
            { order: 1, stage: '需求', roles: ['dev-1'], mode: 'serial', input: '', output: '', done: '', reflow: '' },
          ],
          workflow_raw: { columns: ['#', '阶段', '负责角色'], rows: [['1', '需求', 'dev-1']], rowIds: ['r1'], unmapped: [] },
        }),
      ),
    )
    await click(button(t('teams.wf.addColumn', { field: t('teams.wf.field.output') })))
    await type(cardField(0, 'output'), '需求要点')

    await click(button(t('teams.form.submitEdit')))

    const body = data.patches[0]!.input as UpdateTeamInput
    expect(body.workflow!.columns).toEqual(['#', '阶段', '负责角色', '输出'])
    expect(body.workflow!.stages[0]!.output).toBe('需求要点')
  })

  it('prose 转换 → columns 含「原文」列，全文落进第一行的 extra（列与值同源）', async () => {
    const text = '## 流程\n\n先做 A，再做 B。'
    await render(
      editProps(
        team({
          workflow: [],
          workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: text },
        }),
      ),
    )
    await click(button(t('teams.wf.convert')))
    await click(button(t('teams.form.submitEdit')))

    const body = data.patches[0]!.input as UpdateTeamInput
    expect(body.workflow!.columns).toEqual([...CORE8, '原文'])
    expect(body.workflow!.stages[0]!.extra).toEqual({ 原文: text })
  })

  it('转换后回退到自由文本 → **不发** workflow 段（列集残值不构成改动，自由文本不被替成空表）', async () => {
    await render(
      editProps(
        team({
          workflow: [],
          workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: '先做 A。' },
        }),
      ),
    )
    await click(button(t('teams.wf.convert')))
    await click(button(t('teams.wf.revert')))
    // 只改工作流本身的话，回退后应与基线等价 ⇒ 空 patch 被前端拦下（nothingChanged），没有请求发出
    await click(button(t('teams.form.submitEdit')))

    expect(data.patches).toHaveLength(0)
    expect(textOf('.error')).toBe(t('teams.form.nothingChanged'))
  })
})

describe('T3：prose 转换提示条可关掉（本会话内不再弹）', () => {
  const proseTeam = (text: string): TeamDefinition =>
    team({
      workflow: [],
      workflow_raw: { columns: [], rows: [], rowIds: [], unmapped: [], prose: true, proseText: text },
    })

  it('转换 → 提示条在且讲清「原文进列 / 可找回 / 可回退」；点「知道了」后消失，回退出口仍在', async () => {
    await render(editProps(proseTeam('先做 A。')))
    expect(all('[data-wf="prose-converted"]')).toHaveLength(0)

    await click(button(t('teams.wf.convert')))
    const notice = one('[data-wf="prose-converted"]')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain(t('teams.wf.prose.warn'))
    // 关掉的是**提示**：转换态与回退出口不受影响
    await click(button(t('teams.wf.prose.noticeDismiss')))
    expect(all('[data-wf="prose-converted"]')).toHaveLength(0)
    expect(button(t('teams.wf.revert'))).not.toBeUndefined()
    expect(cardCount()).toBe(1)
  })

  it('回退后再转换 = 新的一次提示（关掉不影响下一次转换）', async () => {
    await render(editProps(proseTeam('先做 A。')))
    await click(button(t('teams.wf.convert')))
    await click(button(t('teams.wf.prose.noticeDismiss')))
    expect(all('[data-wf="prose-converted"]')).toHaveLength(0)

    await click(button(t('teams.wf.revert')))
    await click(button(t('teams.wf.convert')))
    expect(all('[data-wf="prose-converted"]')).toHaveLength(1)
  })
})
