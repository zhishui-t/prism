/**
 * 工作流阶段编排器（v11 F2 / design-v11 §3）。
 *
 * 「所见即所存」：卡片顺序 = 写回的 `order`；卡片上的输入框 = 文件里**确实有那一列**的
 * 核心字段；右边那张流程预览与保存后详情页看到的是同一份数据（同一个 `WorkflowFlow`）。
 *
 * 三条刻意的形态决定（都有理由，不是漏做）：
 *
 * 1. **「+ 添加此列」集中在列条上，不逐卡重复**。它是**列级**动作（一次把列加进列集，
 *    所有卡同时多出那个输入框），不是某张卡的动作。逐卡放一份会变成「阶段数 × 缺列数」
 *    个一模一样的按钮，且点哪一个效果完全相同——那是把列级动作伪装成行级动作。
 * 2. **`#` 序号不给输入框**，只显示卡片位置。它由位置决定，允许编辑而保存时又按位置重编
 *    就等于给用户一个假开关（文件里若本来有 `#` 列，仍可经列条保留/新增该列）。
 * 3. **`missing`（文件里没有 `## 工作流` 小节）不给可编辑的卡片**。服务端在缺小节时不写回
 *    （R-v11-11：报 `workflow_section_missing`）——画一套能改却存不下去的卡片才是骗人。
 *    这里只如实说明，并指向「怎么让小节能出现」。
 *
 * 自由文本态（`prose`）的转换按钮是**本地模型变换**：只把草稿改成「核心八列 + `原文`」的
 * 表格，**不生成 markdown**（序列化是服务端单点，R-v11-9）；且**未保存可取消**（原文一直
 * 在草稿的 `proseText` 里，从未落盘）。转换后给**一次性提示条**（M-12）：原文此后只活在
 * `原文` 列里、保存后仍可从该列找回、未保存可回退——每次转换至多一条（由 `fromProse` 派生，
 * 不叠加），**可手动关掉**（关了本会话不再弹；回退后再转换 = 新的一次，重新给）。
 *
 * **继承态（M-6）**：本文件没有工作流表格（`prose` / `missing`）而生效的工作流继承自父级时，
 * 卡片区/自由文本区之前给一条说明条，把「来源是父级」与「保存落本文件」两件事都说清
 * （两态措辞不同：`missing` 态保存**不**会写入工作流，因为服务端不替你新建小节）。
 */

import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { RoleDefinition, WorkflowCoreField } from '../../../api-team.ts'
import { CountLine } from '../../../components/CountLine.tsx'
import { PickerDialog, SelectedChips } from '../../../components/LibraryPicker.tsx'
import { Markdown } from '../../../components/Markdown.tsx'
import { useT, type DictKey } from '../../../i18n.ts'
import type { TFunc } from '../errors.ts'
import {
  addCard,
  addCustomColumn,
  addFieldColumn,
  columnFor,
  flowStages,
  moveCard,
  removeCard,
  removeColumn,
  setCardField,
  setCardMode,
  setExtra,
  toProseDraft,
  toTableDraft,
  toggleRole,
  unmappedColumns,
  type EditableField,
  type WorkflowDraft,
} from '../workflow-model.ts'
import { WorkflowFlow } from './WorkflowFlow.tsx'

/** 核心字段的展示名（静态映射，禁拼 key）。 */
const FIELD_LABEL: Record<WorkflowCoreField, DictKey> = {
  order: 'teams.wf.field.order',
  name: 'teams.wf.field.name',
  roles: 'teams.col.owner',
  mode: 'teams.col.mode',
  input: 'teams.wf.field.input',
  output: 'teams.wf.field.output',
  done: 'teams.col.done',
  reflow: 'teams.col.reflow',
}

/**
 * 卡片里按此顺序摆的文本字段。
 * `order` 只读（= 卡片位置）、`roles` 是多选、`mode` 是两档开关 —— 三者单独处理。
 */
const TEXT_FIELDS: readonly { field: WorkflowCoreField; key: EditableField; label: DictKey; rows: number }[] = [
  { field: 'name', key: 'stage', label: 'teams.wf.field.name', rows: 1 },
  { field: 'input', key: 'input', label: 'teams.wf.field.input', rows: 2 },
  { field: 'output', key: 'output', label: 'teams.wf.field.output', rows: 2 },
  { field: 'done', key: 'done', label: 'teams.col.done', rows: 2 },
  { field: 'reflow', key: 'reflow', label: 'teams.col.reflow', rows: 2 },
]

/**
 * M-6 提示条：本文件**没有**工作流表格、而生效的工作流**继承自父级**（extends 合并）时的说明。
 *
 * `hint` 按态给（prose / missing），因为两态里「保存」的含义相反：prose 态能存进本文件
 * （转换后写回本体），missing 态存不进去（服务端不替你新建小节，R-v11-11）——
 * **不能一句通用文案糊过去**，否则总有一态在撒谎。
 *
 * `data-wf="inherited"` 只是测试钩子（无样式）：同一个团队表单里可能还有别的 `.wf-callout`，
 * 靠类名数不出来「这一条在不在」。
 */
function inheritedNotice(t: TFunc, count: number, hint: DictKey) {
  return (
    <div className="wf-callout" data-wf="inherited">
      <div>{t('teams.wf.inherited.title', { n: count })}</div>
      <div className="small muted">{t(hint)}</div>
    </div>
  )
}

export function WorkflowEditor({
  draft,
  roles,
  rolesLoading,
  rolesError,
  onReloadRoles,
  disabled,
  onChange,
}: {
  draft: WorkflowDraft
  /** 负责角色的候选（角色库 ∪ 定义里出现但角色库已无的孤儿角色）。 */
  roles: RoleDefinition[]
  rolesLoading: boolean
  /** 角色库拉取失败的原因（`undefined` = 成功）。 */
  rolesError: string | undefined
  onReloadRoles: () => void
  disabled: boolean
  onChange: (next: WorkflowDraft) => void
}) {
  const t = useT()
  /** 角色多选的弹层绑在哪张卡上（`null` = 关）。 */
  const [picker, setPicker] = useState<number | null>(null)
  const [newColumn, setNewColumn] = useState('')
  /**
   * 转换提示条「本编辑会话内关掉」的标记（T3 / M-12）：只影响**提示**，不影响 `fromProse`
   * 派生的「恢复为自由文本」出口（回退按钮始终在）。回退时复位——再转换是新的一次，
   * 该提示重新给，不算重复轰炸。
   */
  const [proseNoticeHidden, setProseNoticeHidden] = useState(false)

  if (draft.state === 'missing') {
    return (
      <>
        <h4>{t('teams.wf.title')}</h4>
        <div className="wf-callout">
          <div>{t('teams.wf.missing.title')}</div>
          <div className="small muted">{t('teams.wf.missing.hint')}</div>
        </div>
        {draft.inherited.length > 0 && inheritedNotice(t, draft.inherited.length, 'teams.wf.inherited.missingHint')}
      </>
    )
  }

  if (draft.state === 'prose') {
    return (
      <>
        <h4>{t('teams.wf.title')}</h4>
        <div className="wf-callout">
          <div>{t('teams.wf.prose.title')}</div>
          {draft.proseText === '' ? (
            <div className="small muted">{t('teams.wf.prose.noText')}</div>
          ) : (
            <div className="wf-prose-body">
              <Markdown src={draft.proseText} />
            </div>
          )}
          <div className="small muted">{t('teams.wf.prose.hint')}</div>
          <div className="row">
            <button
              type="button"
              className="tool-btn"
              /* 没有原文就没法转换（**不拿空串当原文**充数） */
              disabled={disabled || draft.proseText === ''}
              onClick={() => onChange(toTableDraft(draft))}
            >
              {t('teams.wf.convert')}
            </button>
          </div>
        </div>
        {/* 继承说明放在自由文本块**之后**：先如实呈现本文件的内容，再说「生效的那份来自父级」 */}
        {draft.inherited.length > 0 && inheritedNotice(t, draft.inherited.length, 'teams.wf.inherited.proseHint')}
      </>
    )
  }

  const custom = unmappedColumns(draft.columns)
  const addColumn = () => {
    const next = addCustomColumn(draft, newColumn)
    if (next !== draft) {
      onChange(next)
      setNewColumn('')
    }
  }
  const onColumnKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    addColumn()
  }

  return (
    <>
      {/* 分段头 = `CountLine section`（同 Roles / Skills 的分段头口径：标签 + 引线 + 计数）。
          此前这里同时给了 `<h4>` 与同文案的 `CountLine`，渲染出来是同一句话连着两行
          （`.pane h4` 与 `.count-line.section` 的版式本来就几乎一致），故只留带计数的那条。 */}
      <CountLine size="section" label={t('teams.wf.title')} count={draft.cards.length} />
      <div className="small muted">{t('teams.wf.hint')}</div>

      {draft.issues.length > 0 && <div className="small muted">{t('teams.wf.issues', { n: draft.issues.length })}</div>}

      {/* 列映射条：每列一个状态 + 缺列时的「+ 添加此列」（列级动作，集中一处，见文件头注 1） */}
      <div className="wf-cols">
        {(Object.keys(FIELD_LABEL) as WorkflowCoreField[]).map((field) => {
          const column = columnFor(draft.columns, field)
          return column === undefined ? (
            <button
              key={field}
              type="button"
              className="tool-btn"
              disabled={disabled}
              title={t('teams.wf.addColumnHint', { field: t(FIELD_LABEL[field]) })}
              onClick={() => onChange(addFieldColumn(draft, field))}
            >
              {t('teams.wf.addColumn', { field: t(FIELD_LABEL[field]) })}
            </button>
          ) : (
            <span key={field} className="wf-col-on mono" title={t(FIELD_LABEL[field])}>
              {t(FIELD_LABEL[field])} › {column}
            </span>
          )
        })}
      </div>

      {draft.fromProse && (
        <>
          {/* M-12 + T3：转换的**一次性提示条**——每次转换至多一条（由 `fromProse` 派生 ⇒ 不可能
              叠加），且可手动关掉（本会话不再弹）。用 `--warn` 引线的 `.scope-callout` 而非说明
              档的 `.wf-callout`：这里说的是「要留意」——原文此后只活在「原文」列里。
              关掉它不影响下面的回退出口：提示与出口是两件事。 */}
          {!proseNoticeHidden && (
            <div className="scope-callout" role="status" data-wf="prose-converted">
              <div>{t('teams.wf.prose.warn')}</div>
              <div className="row" style={{ marginTop: 'var(--s-1)' }}>
                <button type="button" className="tool-btn" onClick={() => setProseNoticeHidden(true)}>
                  {t('teams.wf.prose.noticeDismiss')}
                </button>
              </div>
            </div>
          )}
          <div className="wf-callout">
            <div className="small muted">{t('teams.wf.revertHint')}</div>
            <div className="row">
              <button
                type="button"
                className="tool-btn"
                disabled={disabled}
                onClick={() => {
                  // 回退 = 放弃本次转换；下次再转换是**新的一次**，提示条重新给
                  setProseNoticeHidden(false)
                  onChange(toProseDraft(draft))
                }}
              >
                {t('teams.wf.revert')}
              </button>
            </div>
          </div>
        </>
      )}

      {draft.cards.length === 0 ? (
        <div className="empty">{t('teams.wf.empty')}</div>
      ) : (
        <div className="stage-cards">
          {draft.cards.map((card, index) => (
            <article key={card.rowId ?? `new-${index}`} className="stage-card">
              <header className="stage-card-head">
                <span className="stage-num">{index + 1}</span>
                <span className="stage-card-title">{card.stage.trim() === '' ? t('teams.wf.unnamed') : card.stage}</span>
                <span className="spacer">
                  <button
                    type="button"
                    aria-label={t('teams.wf.up')}
                    disabled={disabled || index === 0}
                    onClick={() => onChange(moveCard(draft, index, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={t('teams.wf.down')}
                    disabled={disabled || index === draft.cards.length - 1}
                    onClick={() => onChange(moveCard(draft, index, 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={t('teams.wf.remove', { n: index + 1 })}
                    title={t('teams.wf.removeHint')}
                    disabled={disabled}
                    onClick={() => onChange(removeCard(draft, index))}
                  >
                    ×
                  </button>
                </span>
              </header>

              <div className="form-grid">
                {/* `#` 序号：只读（见文件头注 2）——值就是卡片位置 */}
                {columnFor(draft.columns, 'order') !== undefined && (
                  <div className="wf-field">
                    <span className="label">{t('teams.wf.field.order')}</span>
                    <span className="mono" title={t('teams.wf.orderDerived')}>
                      {index + 1}
                    </span>
                  </div>
                )}

                {/* 负责角色：多选（复用 F1 的选取器，`kind='role'` 不带手动添加区） */}
                {columnFor(draft.columns, 'roles') !== undefined && (
                  <div className="wf-field">
                    <span className="label">{t('teams.col.owner')}</span>
                    {card.roles.length === 0 ? (
                      <span className="small muted">{t('teams.wf.roles.empty')}</span>
                    ) : (
                      <SelectedChips
                        names={card.roles}
                        onRemove={(name) => onChange(toggleRole(draft, index, name))}
                      />
                    )}
                    <button type="button" className="rel-link" disabled={disabled} onClick={() => setPicker(index)}>
                      {t('teams.wf.roles.pick')}
                    </button>
                  </div>
                )}

                {/* 串·并行：两档按钮（服务端只认这两档） */}
                {columnFor(draft.columns, 'mode') !== undefined && (
                  <div className="wf-field">
                    <span className="label">{t('teams.col.mode')}</span>
                    <div className="row">
                      {(['serial', 'parallel'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          className={card.mode === mode ? 'primary' : ''}
                          aria-pressed={card.mode === mode}
                          disabled={disabled}
                          onClick={() => onChange(setCardMode(draft, index, mode))}
                        >
                          {t(mode === 'serial' ? 'teams.mode.serial' : 'teams.mode.parallel')}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {TEXT_FIELDS.map(({ field, key, label, rows }) =>
                  columnFor(draft.columns, field) === undefined ? null : (
                    <label key={field} className="wf-field" htmlFor={`wf-${index}-${field}`}>
                      <span className="label">{t(label)}</span>
                      <textarea
                        id={`wf-${index}-${field}`}
                        rows={rows}
                        value={card[key]}
                        disabled={disabled}
                        onChange={(e) => onChange(setCardField(draft, index, key, e.target.value))}
                      />
                    </label>
                  ),
                )}
              </div>

              {/* 未映射列：逐格自由编辑（列本身的新增/删除在下面的列条上） */}
              {custom.length > 0 && (
                <div className="form-grid">
                  {custom.map((column) => (
                    <label key={column} className="wf-field" htmlFor={`wf-${index}-extra-${column}`}>
                      <span className="label mono">{column}</span>
                      <textarea
                        id={`wf-${index}-extra-${column}`}
                        rows={2}
                        value={card.extra[column] ?? ''}
                        disabled={disabled}
                        onChange={(e) => onChange(setExtra(draft, index, column, e.target.value))}
                      />
                    </label>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <div className="row" style={{ marginTop: 'var(--s-2)' }}>
        <button type="button" onClick={() => onChange(addCard(draft))} disabled={disabled}>
          {t('teams.wf.addStage')}
        </button>
      </div>

      {/* 自定义列（未映射列）：列的增删 + 已有列的删除出口 */}
      <div className="wf-custom">
        <div className="small muted">{t('teams.wf.customTitle')}</div>
        {custom.length > 0 && (
          <div className="chips">
            {custom.map((column) => (
              <span key={column} className="chip">
                <span className="mono">{column}</span>
                <button
                  type="button"
                  aria-label={t('teams.wf.customRemove', { name: column })}
                  disabled={disabled}
                  onClick={() => onChange(removeColumn(draft, column))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="small muted">{t('teams.wf.customHint')}</div>
        <div className="row">
          <input
            value={newColumn}
            placeholder={t('teams.wf.customPlaceholder')}
            aria-label={t('teams.wf.customAdd')}
            disabled={disabled}
            onChange={(e) => setNewColumn(e.target.value)}
            onKeyDown={onColumnKey}
          />
          <button type="button" className="tool-btn" disabled={disabled || newColumn.trim() === ''} onClick={addColumn}>
            {t('teams.wf.customAdd')}
          </button>
        </div>
      </div>

      {/* 预览：与详情页同一个渲染件 ⇒ 所见即所存 */}
      <div className="wf-preview">
        <div className="small muted">{t('teams.wf.preview')}</div>
        <WorkflowFlow workflow={flowStages(draft)} />
      </div>

      {picker !== null && draft.cards[picker] !== undefined && (
        <PickerDialog
          kind="role"
          groups={[{ label: '', items: roles.map((role) => ({ name: role.name })) }]}
          selected={draft.cards[picker]!.roles}
          loading={rolesLoading}
          /* 角色库拉取失败**如实透传**（`PickerDialog` 的既有契约：失败给重试出口，
             不静默成「空库」）。此前这里恒传 `undefined` + 一个「关掉弹层」的假重试，
             于是拉取失败会显示成「角色库是空的」——把一次网络失败谎报成事实。 */
          error={rolesError}
          onRetry={onReloadRoles}
          onToggle={(name) => onChange(toggleRole(draft, picker, name))}
          onRemove={(name) => onChange(toggleRole(draft, picker, name))}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )
}
