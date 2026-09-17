/**
 * 库内选取器（F1，v11）：**库内勾选 + 手动添加**两区 + 已选 chips。
 *
 * 三处同构使用——角色表单的 `skills`（技能库）、`knowledge.books`（知识书目）与 **F2 编排器的
 * 阶段负责角色**（角色库，`kind='role'`）。「库」由调用方给成 `PickerGroup[]`，本组件不认识
 * 技能 / 书目 / 角色的数据结构，只管：
 * 1. **分组展示**（组名空串 = 不画组头 ⇒ 书目 / 角色天然平铺，不硬造分类）；
 * 2. **多选**（复选行；选中态 = 左 3px `--buckram` 引线，与 `.md-row` / `.list-row` 同宽）；
 * 3. **搜索过滤**（组内过滤，命中组名即整组保留）；
 * 4. **手动添加**（库外名字直接入列——这是「角色定义先行」场景的保留出口；**角色库不开放**，
 *    见 `COPY` 的注释）；
 * 5. **chips 单个移除**（`SelectedChips`，弹层内与表单字段位共用同一个零件）。
 *
 * 口径三条（都有注释落点）：
 * - **弹层复用既有机制**：外壳是 `components/ui.tsx` 的 `<Modal size="md">`（Esc 只在栈顶时关、
 *   点遮罩关、Tab 圈闭、滚动锁、关闭还原焦点），故本文件**不碰** `overlay-stack.ts`，
 *   也不新造一套遮罩 / 面板 CSS；
 * - **文案走静态键映射**（`COPY`，禁动态拼 key）；本组件是**通用**零件，故键落在
 *   `picker.*` 命名空间而不是 `roles.*` / `teams.*`；
 * - **「未装」是库给的判据**：`isMissing(name)` 由调用方给（技能 = 不在库内 / 宿主未装；
 *   书目与角色没有这一档 ⇒ 不传，chips 恒不点灯）。本组件不按名字猜状态。
 *
 * 两处**刻意**与技能页不同（不是漏做）：
 * 1. 组头**不可折叠**：技能页的折叠服务「上百条时按需收窄」，而弹层自带搜索框（收窄入口更直接），
 *    再叠一层折叠只会多一个状态机；组名 + 计数这一套视觉语言照旧复用。
 * 2. 「未装」灯**不区分**「库内勾选到一条未装的」与「手动添加的库外名字」——两者在
 *    `available: false` 这个既有口径下是同一件事（都是「宿主装不出来」），多造一档
 *    「手动项」标记等于给同一个事实两个说法。
 */

import { useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { useT, type DictKey } from '../i18n.ts'
import { CountLine } from './CountLine.tsx'
import { Modal } from './ui.tsx'

/** 库内一行：`name` 必有；两个徽章位按需给（不给就不渲染，不是渲染成空）。 */
export interface PickerItem {
  name: string
  /** 来源（技能）：`true` 内置 / `false` 外部。书目不传。 */
  builtin?: boolean
  /** 宿主是否已装（技能）：`false` 走 lamp + 「未装」。书目不传（没有这一档）。 */
  installed?: boolean
}

/** 一个展示分组。`label === ''` ⇒ **不画组头**（平铺），用于没有分类的库（书目）。 */
export interface PickerGroup {
  label: string
  items: PickerItem[]
}

export type PickerKind = 'skill' | 'book' | 'role'

/**
 * 文案表：`kind` → 静态字典键（**不**在渲染里拼 `picker.x.${kind}`——§6.2 禁动态拼 key，
 * `dead-keys.mjs` 也只认字面量引用）。键名直接写字面量，故守卫能追到每一个。
 *
 * `manual` **缺席 = 这个库没有「手动添加」这件事**（v11 F2 的负责角色多选）：角色名必须来自
 * 角色库（阶段引用的角色还要过 members 校验），让用户手打一个库外名字只会造出坏阶段。
 * 用「`kind` 决定有没有」而不是再加一个 `allowManual` 开关：两个来源表达同一件事就会漂移
 * （`kind='role'` + `allowManual` 为真是个无法解释的组合）。
 */
/** 一个 `kind` 的文案（`manual` 缺席 = 该库没有「手动添加」区，见上）。 */
interface PickerCopy {
  title: DictKey
  search: DictKey
  empty: DictKey
  manual?: { label: DictKey; placeholder: DictKey; hint: DictKey }
}

const COPY: Record<PickerKind, PickerCopy> = {
  skill: {
    title: 'picker.title.skill',
    search: 'picker.search.skill',
    empty: 'picker.empty.skill',
    manual: {
      label: 'picker.manual.skill',
      placeholder: 'picker.manualPlaceholder.skill',
      hint: 'picker.manualHint.skill',
    },
  },
  book: {
    title: 'picker.title.book',
    search: 'picker.search.book',
    empty: 'picker.empty.book',
    manual: {
      label: 'picker.manual.book',
      placeholder: 'picker.manualPlaceholder.book',
      hint: 'picker.manualHint.book',
    },
  },
  role: {
    title: 'picker.title.role',
    search: 'picker.search.role',
    empty: 'picker.empty.role',
  },
}

/**
 * 已选项 chips：每个 chip 右端一个 `×` **单个移除**（不提供「清空」——那是另一个动作，
 * 且全清可以直接逐个点，误触代价小）。
 *
 * `isMissing` 命中时走 `.chip.missing`：8px `--warn` lamp + 「未装」文字（与 `scope-lamp`
 * 同一颗色点、同一句话），对应服务端既有的 `available: false` 语义。**「移除」钮的无障碍名
 * 带名字**（视觉只有一个 `×`，读屏要能说明移的是哪一个）。
 */
export function SelectedChips({
  names,
  isMissing,
  onRemove,
}: {
  names: readonly string[]
  /** 该名字是否按「未装」呈现；省略 = 恒不点灯（书目等没有 available 语义的库）。 */
  isMissing?: ((name: string) => boolean) | undefined
  onRemove: (name: string) => void
}) {
  const t = useT()
  if (names.length === 0) return null
  return (
    <div className="chips">
      {names.map((name) => {
        const missing = isMissing?.(name) === true
        return (
          <span key={name} className={`chip${missing ? ' missing' : ''}`}>
            <span className="mono">{name}</span>
            {missing && (
              <>
                <span className="scope-lamp" />
                <span className="chip-note">{t('common.notInstalled')}</span>
              </>
            )}
            <button type="button" aria-label={t('picker.remove', { name })} onClick={() => onRemove(name)}>
              ×
            </button>
          </span>
        )
      })}
    </div>
  )
}

/**
 * 选取器弹层。**受控**：选中集与库数据都由调用方持有（本组件不自己取数、不自己存白名单）——
 * 表单一侧才是白名单的真相，弹层只是它的一个视图。
 */
export function PickerDialog({
  kind,
  groups,
  selected,
  loading,
  error,
  isMissing,
  onRetry,
  onToggle,
  onRemove,
  onManualAdd,
  onClose,
}: {
  kind: PickerKind
  /** 库（已分组；单组且 `label === ''` 即平铺）。 */
  groups: PickerGroup[]
  /** 当前已选（顺序 = chips 顺序）。 */
  selected: readonly string[]
  loading: boolean
  /** 取库失败的原因（`undefined` = 成功）。失败给重试出口，不静默成「空库」。 */
  error: string | undefined
  isMissing?: ((name: string) => boolean) | undefined
  onRetry: () => void
  onToggle: (name: string) => void
  onRemove: (name: string) => void
  /** 只在 `kind` 带「手动添加」区时会被调用（`role` 没有该区，见 `COPY`）。 */
  onManualAdd?: (name: string) => void
  onClose: () => void
}) {
  const t = useT()
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState('')
  const copy = COPY[kind]
  const chosen = useMemo(() => new Set(selected), [selected])

  const q = filter.trim().toLowerCase()
  /**
   * 过滤在**组内**做（命中的组名 ⇒ 整组保留）：
   * 组是分类的分区，故「先滤后分」与「先分后滤再丢空组」等价，组序不变。
   */
  const visible = useMemo(
    () =>
      groups
        .map((g) => ({
          label: g.label,
          items: g.items.filter(
            (it) => q === '' || it.name.toLowerCase().includes(q) || g.label.toLowerCase().includes(q),
          ),
        }))
        .filter((g) => g.items.length > 0),
    [groups, q],
  )
  const total = visible.reduce((n, g) => n + g.items.length, 0)
  const all = groups.reduce((n, g) => n + g.items.length, 0)

  /** 手动添加：空白名不入列；已有同名**幂等**（`appendToList` 去重，chips 不会出现两个）。 */
  const addManual = () => {
    const name = manual.trim()
    if (name === '') return
    onManualAdd?.(name)
    setManual('')
  }
  const onManualKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    addManual()
  }

  return (
    <Modal
      size="md"
      title={t(copy.title)}
      onClose={onClose}
      footer={
        <button type="button" className="tool-btn" onClick={onClose}>
          {t('picker.done')}
        </button>
      }
    >
      <div className="picker-body">
        <input
          value={filter}
          placeholder={t(copy.search)}
          aria-label={t(copy.search)}
          onChange={(e) => setFilter(e.target.value)}
        />

        {/* 区一：库内勾选。计数是**过滤后**的（与技能页组头计数同口径：报的是眼前这批）。 */}
        <CountLine size="section" label={t('picker.library')} count={total} />
        {loading ? (
          <div className="empty">{t('common.loading')}</div>
        ) : error !== undefined ? (
          <div className="error" role="alert">
            {t('common.loadFailed', { msg: error })}{' '}
            <button type="button" className="rel-link" onClick={onRetry}>
              {t('common.retry')}
            </button>
          </div>
        ) : all === 0 ? (
          // 「库是空的」与「过滤后无命中」是两种处境（前者没得选、后者换个词），故两档文案
          <div className="empty">{t(copy.empty)}</div>
        ) : total === 0 ? (
          <div className="pane">
            <p className="muted small">{t('picker.filterNone')}</p>
          </div>
        ) : (
          <div className="pick-list">
            {visible.map((g) => (
              <div key={g.label} className="pick-group">
                {/* 组名空串 ⇒ 不画组头（书目平铺；不硬造一个假分类） */}
                {g.label !== '' && <CountLine size="section" bare label={g.label} count={g.items.length} />}
                <div>
                  {g.items.map((it) => {
                    const on = chosen.has(it.name)
                    return (
                      <label key={it.name} className={`pick-row${on ? ' on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => onToggle(it.name)} />
                        <span className="pick-name mono">{it.name}</span>
                        {it.builtin !== undefined && (
                          <span className="src">{it.builtin ? t('common.builtin') : t('common.external')}</span>
                        )}
                        {it.installed !== undefined && (
                          <span className="host">
                            {it.installed ? t('common.installed') : t('common.notInstalled')}
                            {!it.installed && <span className="scope-lamp" />}
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 区二：手动添加。库外的名字从这里进白名单（角色定义先行场景）。
            `kind` 没有这一区（角色）时整段不渲染——**不是**渲染成空壳。 */}
        {copy.manual !== undefined && (
          <div className="picker-manual">
            <div className="small muted">{t(copy.manual.label)}</div>
            <div className="row">
              <input
                value={manual}
                placeholder={t(copy.manual.placeholder)}
                aria-label={t(copy.manual.label)}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={onManualKey}
              />
              <button type="button" className="tool-btn" disabled={manual.trim() === ''} onClick={addManual}>
                {t('picker.add')}
              </button>
            </div>
            <div className="small muted">{t(copy.manual.hint)}</div>
          </div>
        )}

        {/* 已选：弹层盖住了表单，故同一份 chips 在弹层里也常驻（`SelectedChips` 只此一处实现）。 */}
        {selected.length > 0 && (
          <div>
            <div className="small muted">{t('picker.selected', { n: selected.length })}</div>
            <SelectedChips names={selected} isMissing={isMissing} onRemove={onRemove} />
          </div>
        )}
      </div>
    </Modal>
  )
}
