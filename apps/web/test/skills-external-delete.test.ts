// @vitest-environment happy-dom
/**
 * v10 F3ui 技能详情工具条：**外部技能删除**（`DELETE /api/skills/external/:name`）。
 *
 * 契约（design-v10 F3 / `api-team.ts#SkillUsage.external_removable`）：
 * 破坏性动作是**二选一**——usage 行 `external_removable === true`（宿主目录里人写、无 Prism
 * 标记的目录）显「删除」（整目录进回收站），否则显既有的「卸载」（只清 Prism 产物）。
 * 字段**缺失与 `false` 同档**：保持现状（内置 / Prism 产物零变更）。
 *
 * 本文件锁四件事：
 *  1. **显隐分支**：`true` 显「删除」不显「卸载」；缺键 / `false` 显「卸载」不显「删除」；
 *  2. **确认流**：确认文案注明进回收站 + 3 天可恢复；确认 → 调 API → 列表刷新 + 页级 toast；
 *  3. **失败码映射**（人话，不猜服务端文案）：409 `id_conflict` → 指路「卸载」；
 *     404 `not_found` → 不可删；其余码原文透出；
 *  4. **不假禁用**：删除口无 body，`skills_dir` 读不回来时「卸载」要禁用，但「删除」不受影响。
 *
 * 渲染路径与 `skills-install-pending.test.ts` 一致：happy-dom + 裸 `react-dom/client` +
 * `react.act`（根 vitest.config.ts 的 include 只收 `.test.ts`，故不用 JSX，走 `createElement`）。
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 受控假数据 + 可控失败：`vi.mock` 工厂被提升，故经 `vi.hoisted` 共享可变引用。 */
const data = vi.hoisted(() => ({
  skillsDir: '/tmp/prism-skills',
  usage: [] as Array<Record<string, unknown>>,
  /** 删除端点的调用序（收口自证：请求真发出去了）。 */
  deleteCalls: [] as string[],
  /** usage 路的拉取次数（收口自证：删除成功后列表真刷新了）。 */
  usageCalls: 0,
  /** 删除端点行为：`null` = 成功；否则以该 message 拒绝（模拟 `code: message` 信封）。 */
  failMessage: null as string | null,
  trashId: 'trash-7',
}))

vi.mock('../src/api-team.ts', () => ({
  teamApi: {
    skills: () =>
      Promise.resolve({
        skills: [{ name: 'builtin-a', description: '内置技能', builtin: true }],
        skills_dir: data.skillsDir,
      }),
    skillUsage: () => {
      data.usageCalls += 1
      return Promise.resolve(data.usage)
    },
    skill: (name: string) =>
      Promise.resolve({
        name,
        description: `${name} 的说明`,
        builtin: false,
        installed: true,
        path: `/tmp/prism-skills/${name}`,
        roles: [],
        teams: [],
        content: '# body\n',
      }),
    skillDeleteExternal: (name: string) => {
      data.deleteCalls.push(name)
      if (data.failMessage !== null) return Promise.reject(new Error(data.failMessage))
      return Promise.resolve({ skills_dir: data.skillsDir, removed: [name], trash_id: data.trashId })
    },
    skillInstall: () => Promise.resolve({ skills_dir: data.skillsDir, written: [], skipped: [] }),
    skillUninstall: () => Promise.resolve({ skills_dir: data.skillsDir, removed: [], kept: [] }),
    // 模块被整体替身时下面几个也必须给出（否则详情切「有效集」或渲染即崩）
    roles: () => Promise.resolve({ roles: [], rolesDir: '/tmp/prism-roles' }),
    teams: () => Promise.resolve({ teams: [], teamsDir: '/tmp/prism-teams' }),
    effectiveSkills: (role: string) => Promise.resolve({ role, skills: [], warnings: [] }),
  },
}))

import { setLang, t } from '../src/i18n.ts'
import { SkillsPage } from '../src/pages/Skills.tsx'

/** 造一条 usage 行：`externalRemovable === undefined` 时**不加键**（服务端「不下发」的形态）。 */
function usageRow(name: string, externalRemovable?: boolean): Record<string, unknown> {
  const row: Record<string, unknown> = { name, builtin: false, installed: true, roles: [], teams: [] }
  if (externalRemovable !== undefined) row.external_removable = externalRemovable
  return row
}

let container: HTMLDivElement
let root: Root

async function render(sel: string): Promise<void> {
  await act(async () => {
    root.render(createElement(SkillsPage, { sel }))
  })
}

function el<T extends Element>(selector: string): T | null {
  return container.querySelector<T>(selector)
}

function all(selector: string): Element[] {
  return [...container.querySelectorAll(selector)]
}

function buttonOrNull(label: string): HTMLButtonElement | null {
  return (all('button').find((b) => b.textContent?.trim() === label) as HTMLButtonElement) ?? null
}

function button(label: string): HTMLButtonElement {
  const hit = buttonOrNull(label)
  if (hit === null) throw new Error(`未找到按钮：${label}`)
  return hit
}

/** 确认框（`ConfirmModal`，`.modal` 窄版）。 */
function confirmModal(): Element | null {
  return el('.modal')
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

beforeEach(() => {
  setLang('zh')
  data.skillsDir = '/tmp/prism-skills'
  data.usage = []
  data.deleteCalls = []
  data.usageCalls = 0
  data.failMessage = null
  data.trashId = 'trash-7'
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

describe('v10 F3ui 显隐分支：`external_removable` 决定「删除」还是「卸载」', () => {
  it('`external_removable === true` → 显「删除」，不显「卸载」', async () => {
    data.usage = [usageRow('ext-a', true)]
    await render('ext-a')

    expect(buttonOrNull(t('skills.delete.action'))).not.toBeNull()
    expect(buttonOrNull(t('skills.uninstall.action'))).toBeNull()
  })

  it('字段**缺失** → 走现状显「卸载」，不显「删除」', async () => {
    data.usage = [usageRow('ext-b')]
    await render('ext-b')

    expect(buttonOrNull(t('skills.delete.action'))).toBeNull()
    expect(buttonOrNull(t('skills.uninstall.action'))).not.toBeNull()
  })

  it('`external_removable === false` 与缺失**同一档** → 显「卸载」', async () => {
    data.usage = [usageRow('ext-c', false)]
    await render('ext-c')

    expect(buttonOrNull(t('skills.delete.action'))).toBeNull()
    expect(buttonOrNull(t('skills.uninstall.action'))).not.toBeNull()
  })

  it('内置技能（usage 行无该键）不受影响：仍是「卸载」', async () => {
    // 内置技能也在 usage 路里（builtin: true），且服务端不会给它 `external_removable`
    data.usage = [{ name: 'builtin-a', builtin: true, installed: true, roles: [], teams: [] }]
    await render('builtin-a')

    expect(buttonOrNull(t('skills.delete.action'))).toBeNull()
    expect(buttonOrNull(t('skills.uninstall.action'))).not.toBeNull()
  })
})

describe('v10 F3ui 确认流：确认 → API → 列表刷新 + toast', () => {
  it('确认文案注明进回收站 + 3 天可恢复（不是硬删）', async () => {
    data.usage = [usageRow('ext-a', true)]
    await render('ext-a')

    await click(button(t('skills.delete.action')))

    expect(confirmModal()).not.toBeNull()
    const body = confirmModal()!.querySelector('.modal-body')?.textContent ?? ''
    expect(body).toContain('回收站')
    expect(body).toContain('3 天')
    expect(confirmModal()!.querySelector('h3')?.textContent).toContain('ext-a')
  })

  it('确认 → 调 `DELETE /api/skills/external/:name` → 列表刷新 + 页级 toast（含 trash_id）', async () => {
    data.usage = [usageRow('ext-a', true)]
    await render('ext-a')
    const callsBefore = data.usageCalls

    await click(button(t('skills.delete.action')))
    await click(button(t('common.confirmDelete')))

    // 收口自证①：请求真发出去了（含技能名）
    expect(data.deleteCalls).toEqual(['ext-a'])
    // 收口自证②：列表真刷新了（usage 路被重新拉取）
    expect(data.usageCalls).toBeGreaterThan(callsBefore)
    // 收口自证③：确认框已关
    expect(confirmModal()).toBeNull()
    // 页级 toast：含技能名 + 回收站单元 id（可恢复的唯一凭据）
    const banner = el('.banner.small[role="status"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('ext-a')
    expect(banner!.textContent).toContain('trash-7')
    expect(banner!.textContent).toContain('回收站')
  })

  it('删的正是当前选中项 → 收口回列表（实体已不存在，不停在 404 上）', async () => {
    data.usage = [usageRow('ext-a', true)]
    await render('ext-a')

    await click(button(t('skills.delete.action')))
    await click(button(t('common.confirmDelete')))

    expect(window.location.hash).toBe('#/skills')
  })

  it('取消确认 → 不调 API、不留 toast', async () => {
    data.usage = [usageRow('ext-a', true)]
    await render('ext-a')

    await click(button(t('skills.delete.action')))
    await click(button(t('common.cancel')))

    expect(data.deleteCalls).toEqual([])
    expect(confirmModal()).toBeNull()
    expect(el('.banner.small[role="status"]')).toBeNull()
  })
})

describe('v10 F3ui 失败码映射：人话且指路，不猜服务端文案', () => {
  it('409 `id_conflict`（SKILL.md 带 Prism 标记）→ 指路「改用卸载」', async () => {
    data.usage = [usageRow('ext-a', true)]
    data.failMessage = 'id_conflict: skill already exists with prism marker'
    await render('ext-a')

    await click(button(t('skills.delete.action')))
    await click(button(t('common.confirmDelete')))

    // 失败时确认框不关（否则错误落在遮罩后面＝看不到）
    expect(confirmModal()).not.toBeNull()
    const err = confirmModal()!.querySelector('.error')?.textContent ?? ''
    expect(err).toBe(t('skills.delete.conflict'))
    expect(err).toContain('卸载')
  })

  it('404 `not_found`（目录不存在 / 没有 SKILL.md）→ 明说不可删', async () => {
    data.usage = [usageRow('ext-a', true)]
    data.failMessage = 'not_found: no SKILL.md at target'
    await render('ext-a')

    await click(button(t('skills.delete.action')))
    await click(button(t('common.confirmDelete')))

    expect(confirmModal()!.querySelector('.error')?.textContent).toBe(t('skills.delete.notFound'))
  })

  it('未知码（如 `bad_request`）→ 原文透出，不硬塞进上面两档', async () => {
    data.usage = [usageRow('ext-a', true)]
    data.failMessage = 'bad_request: invalid name'
    await render('ext-a')

    await click(button(t('skills.delete.action')))
    await click(button(t('common.confirmDelete')))

    const err = confirmModal()!.querySelector('.error')?.textContent ?? ''
    expect(err).toContain('bad_request')
    expect(err).not.toBe(t('skills.delete.conflict'))
    expect(err).not.toBe(t('skills.delete.notFound'))
  })
})

describe('v10 F3ui 边界：外部删除不受 `skills_dir` 读回值牵制（无 body 口）', () => {
  it('`skills_dir` 读不回来：详情给出 `dirMissing` 警示，但「删除」**仍可点**（不假禁用）', async () => {
    data.skillsDir = ''
    data.usage = [usageRow('ext-a', true)]
    await render('ext-a')

    // 前置：目录缺失的警示确实在（否则「不假禁用」的断言可能落在别的状态上）
    expect(el('.banner.small')?.textContent).toContain(t('skills.dirMissing'))
    expect(button(t('skills.delete.action')).disabled).toBe(false)
  })

  it('同一状态下「卸载」被禁用（它要往 body 里带 `skills_dir`，这条口径不变）', async () => {
    data.skillsDir = ''
    data.usage = [usageRow('ext-b')]
    await render('ext-b')

    expect(button(t('skills.uninstall.action')).disabled).toBe(true)
  })
})
