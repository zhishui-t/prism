/**
 * 工作流库页（workflow-asset.md v1 库 + v2 图编辑器）。
 *
 * 选中只有一个真相：hash `#/workflows/<id>`；列表 + 过滤照 TeamsPage 骨架，详情走居中弹窗。
 * 详情两种视图共用**同一份草稿**：图视图（拖拽改序/换道/建删回流 + 右侧字段面板）与
 * 步骤表（逐字段表单）随时切换，草稿与源文件比对出脏标记；保存 PATCH 一次写回。
 *
 * 步骤表**不复用** WorkflowFlow：那套阶段卡的「负责角色」按角色库渲染 Ref，
 * 而步骤表的「承接」列合法值含编排语义词（队长/人/独立实例），按角色渲染会满屏
 * 「缺失」误报——这里按纯文本渲染，只有 frontmatter `binds` 才渲染角色 Ref。
 */

import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'

import {
  workflowApi,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowStepPatchRow,
} from '../api-workflow.ts'
import { ConfirmModal } from '../components/ConfirmModal.tsx'
import { Markdown } from '../components/Markdown.tsx'
import { NavRow } from '../components/NavRow.tsx'
import { SearchField } from '../components/SearchField.tsx'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { Modal, PageHead, StatusTag } from '../components/ui.tsx'
import { useT } from '../i18n.ts'
import { hrefOf } from '../route.ts'
import { parseReflowTarget, wfRenumberReflow } from './graph-logic.ts'
import { WorkflowGraph } from './WorkflowGraph.tsx'

/** 草稿行 = 步骤 + 行身份（原 rowId；新增行给本地 uid，保存时不带 rowId）。 */
interface DraftStep extends WorkflowStep {
  stepId: string
}

const NEW_ROW = 'new:'

const toDraft = (wf: WorkflowDefinition): DraftStep[] => {
  const rowIds = wf.steps_raw?.rowIds ?? []
  return wf.steps.map((s, i) => ({ ...s, stepId: rowIds[i] ?? `${NEW_ROW}${i}` }))
}

const sameStep = (a: WorkflowStep, b: WorkflowStep): boolean =>
  a.order === b.order &&
  a.step === b.step &&
  a.skills === b.skills &&
  a.input === b.input &&
  a.output === b.output &&
  a.done === b.done &&
  a.reflow === b.reflow &&
  a.owner.join(',') === b.owner.join(',')

const stepsEqual = (a: readonly WorkflowStep[], b: readonly WorkflowStep[]): boolean =>
  a.length === b.length && a.every((s, i) => b[i] !== undefined && sameStep(s, b[i]!))

/** 逗号 / 顿号分隔的清单（空项丢弃）。 */
const parseList = (text: string): string[] =>
  text
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter((x) => x !== '')

export function WorkflowsPage({ sel, onSelect }: { sel?: string; onSelect?: (id: string) => void } = {}) {
  const t = useT()
  const workflows = useAsync(() => workflowApi.list(), [])
  const [filter, setFilter] = useState('')
  /** 详情弹窗的关闭守卫（编辑中有未保存改动时由详情体接管：先确认再关）。 */
  const closeGuard = useRef<(() => boolean) | null>(null)

  const selected = sel ?? ''
  const detail = useAsync(
    () => (selected !== '' ? workflowApi.detail(selected) : Promise.resolve(undefined)),
    [selected],
  )

  const list = workflows.data?.workflows ?? []

  // 深链失效（列表刷新后 id 不在）→ 收起详情；reload 在途/失败时不动（与 TeamsPage 同口径）
  useEffect(() => {
    if (
      !workflows.loading &&
      workflows.error === undefined &&
      selected !== '' &&
      workflows.data !== undefined &&
      !list.some((x) => x.workflow === selected)
    ) {
      onSelect?.('')
    }
  }, [workflows.data, workflows.loading, workflows.error, selected, list, onSelect])

  const keyword = filter.trim().toLowerCase()
  const shown =
    keyword === ''
      ? list
      : list.filter(
          (x) =>
            x.workflow.toLowerCase().includes(keyword) ||
            x.name.toLowerCase().includes(keyword) ||
            x.binds.some((b) => b.toLowerCase().includes(keyword)),
        )

  const issueTag = (wf: WorkflowDefinition) => {
    const errors = (wf.issues ?? []).filter((i) => i.level === 'error').length
    const warnings = (wf.issues ?? []).length - errors
    if (errors > 0) return <StatusTag kind="err">{t('workflows.issueErrors', { n: errors })}</StatusTag>
    if (warnings > 0) return <StatusTag kind="info">{t('workflows.issueWarnings', { n: warnings })}</StatusTag>
    return <StatusTag kind="ok">{t('workflows.issueClean')}</StatusTag>
  }

  return (
    <div className="page-fill">
      <PageHead title={t('workflows.title')} sub={t('workflows.desc')} />

      <div className="team-toolbar">
        <SearchField value={filter} onChange={setFilter} placeholder={t('workflows.filterPlaceholder')} />
        <span className="small muted team-total">{t('workflows.total', { n: shown.length })}</span>
      </div>

      <State
        loading={workflows.loading}
        error={workflows.error}
        empty={!workflows.loading && !workflows.error && list.length === 0}
        emptyText={t('workflows.empty', { dir: workflows.data?.workflowsDir ?? '' })}
      >
        <div className="md solo">
          <div className="md-list">
            {shown.length === 0 && (
              <div className="small muted" style={{ padding: 'var(--s-2)' }}>
                {t('common.empty')}
              </div>
            )}
            <div className="team-grid">
              {shown.map((wf) => (
                <NavRow
                  key={wf.workflow}
                  href={hrefOf({ page: 'workflows', sel: wf.workflow })}
                  selected={selected === wf.workflow}
                  className="team-row"
                >
                  <div className="team-row-head">
                    <span className="t mono">{wf.workflow}</span>
                    <StatusTag kind={wf.level === 'team' ? 'info' : 'ok'}>
                      {wf.level === 'team' ? t('workflows.levelTeam') : t('workflows.levelRole')}
                    </StatusTag>
                  </div>
                  {wf.name !== '' && <span className="s">{wf.name}</span>}
                  <span className="tags">
                    <StatusTag kind="info">{t('workflows.stepsCount', { n: wf.steps.length })}</StatusTag>
                    {issueTag(wf)}
                  </span>
                </NavRow>
              ))}
            </div>
          </div>
        </div>
      </State>

      {/* 详情弹窗在 `<State>` 之外：保存后列表 reload 不能把弹窗树卸载重建
          （否则成功提示与草稿态一起丢——列表的 loading 与详情无关）。 */}
      {selected !== '' && (
        <Modal
          size="xl"
          title={<span className="mono">{selected}</span>}
          ariaLabel={selected}
          onClose={() => {
            if (closeGuard.current !== null && !closeGuard.current()) return
            onSelect?.('')
          }}
        >
          <div className="swap-in" key={selected}>
            <WorkflowDetailBody
              key={selected}
              id={selected}
              detail={detail.data}
              loading={detail.loading}
              error={detail.error}
              onRetry={detail.reload}
              onSaved={() => {
                detail.reload()
                workflows.reload()
              }}
              onRequestClose={() => onSelect?.('')}
              closeGuard={closeGuard}
              workflowsDir={workflows.data?.workflowsDir ?? ''}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}

function WorkflowDetailBody({
  id,
  detail,
  loading,
  error,
  onRetry,
  onSaved,
  onRequestClose,
  closeGuard,
  workflowsDir,
}: {
  id: string
  detail: WorkflowDefinition | undefined
  loading: boolean
  error: string | undefined
  onRetry: () => void
  onSaved: () => void
  onRequestClose: () => void
  closeGuard: MutableRefObject<(() => boolean) | null>
  workflowsDir: string
}) {
  const t = useT()
  const [view, setView] = useState<'table' | 'graph'>('graph')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<DraftStep[]>([])
  /** 选中步骤的行身份（图视图右侧字段面板；用 stepId 而非下标——拖拽重排后不会指错行）。 */
  const [activeId, setActiveId] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedAt, setSavedAt] = useState(0)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const dirty = editing && detail !== undefined && !stepsEqual(draft, detail.steps)

  // 弹窗关闭守卫：脏草稿先确认（Esc / 遮罩 / 右上角关闭都走这里）
  useEffect(() => {
    closeGuard.current = dirty
      ? () => {
          setConfirmDiscard(true)
          return false
        }
      : null
    return () => {
      closeGuard.current = null
    }
  }, [dirty, closeGuard])

  if (error !== undefined) {
    return (
      <div className="banner lamp">
        <span className="small">{t('workflows.detailFailed', { msg: error })}</span>
        <button className="rel-link" onClick={onRetry}>
          {t('common.retry')}
        </button>
      </div>
    )
  }
  if (loading || detail === undefined) return <State loading />
  const wf = detail
  const errors = (wf.issues ?? []).filter((i) => i.level === 'error')

  /** 改序后统一重编号 + 回流号重写（图与步骤表两条路径同源）。 */
  const reorder = (next: DraftStep[]): DraftStep[] => {
    const renumbered = next.map((s, i) => ({ ...s, order: i + 1 }))
    const map = new Map<number, number>()
    next.forEach((s, i) => map.set(s.order, i + 1))
    const refl = wfRenumberReflow(renumbered, map)
    return renumbered.map((s, i) => ({ ...s, reflow: refl[i]! }))
  }

  const startEdit = (): void => {
    const next = toDraft(wf)
    setDraft(next)
    setActiveId(next[0]?.stepId ?? '')
    setEditing(true)
    setSaveError('')
    setSavedAt(0)
  }

  const cancelEdit = (): void => {
    setDraft([])
    setEditing(false)
    setSaveError('')
  }

  const patchStep = (index: number, patch: Partial<WorkflowStep>): void => {
    setDraft((cur) => cur.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const removeStep = (index: number): void => {
    setDraft((cur) => {
      if (cur.length <= 1) return cur
      const next = reorder(cur.filter((_, i) => i !== index))
      setActiveId((id) => (next.some((s) => s.stepId === id) ? id : (next[Math.min(index, next.length - 1)]?.stepId ?? '')))
      return next
    })
  }

  const moveStep = (index: number, delta: number): void => {
    setDraft((cur) => {
      const to = index + delta
      if (to < 0 || to >= cur.length) return cur
      const next = [...cur]
      const a = next[index]!
      next[index] = next[to]!
      next[to] = a
      return reorder(next)
    })
    setActiveId(draft[index]?.stepId ?? '')
  }

  const addStep = (after: number | null): void => {
    const at = after === null ? draft.length : after + 1
    const fresh: DraftStep = {
      stepId: `${NEW_ROW}${Date.now()}`,
      order: at + 1,
      step: t('workflows.graph.newStepName', { n: at + 1 }),
      owner: [],
      skills: '',
      input: '',
      output: '',
      done: '',
      reflow: '—',
    }
    setDraft((cur) => reorder([...cur.slice(0, at), fresh, ...cur.slice(at)]))
    setActiveId(fresh.stepId)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError('')
    try {
      const rows: WorkflowStepPatchRow[] = draft.map((s, i) => ({
        ...(s.stepId.startsWith(NEW_ROW) ? {} : { rowId: s.stepId }),
        order: i + 1,
        step: s.step,
        owner: s.owner,
        skills: s.skills,
        input: s.input,
        output: s.output,
        done: s.done,
        reflow: s.reflow,
      }))
      await workflowApi.update(id, {
        steps: rows,
        ...(wf.source_mtime !== undefined ? { if_match: wf.source_mtime } : {}),
        workflows_dir: workflowsDir,
      })
      setSavedAt(Date.now())
      setEditing(false)
      setDraft([])
      onSaved()
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  /** 图上线序变更 → 重建草稿（data 携带原步骤对象，stepId 原样带回）。 */
  const applyGraphChange = (
    next: Array<{ order: number; label: string; owner: string[]; reflow: string; data?: unknown }>,
  ): void => {
    setDraft(
      next.map((n, i) => {
        const src = (n.data ?? {}) as Partial<DraftStep>
        return {
          stepId: src.stepId ?? `${NEW_ROW}${i}`,
          order: i + 1,
          step: n.label,
          owner: n.owner,
          skills: src.skills ?? '',
          input: src.input ?? '',
          output: src.output ?? '',
          done: src.done ?? '',
          reflow: n.reflow,
        }
      }),
    )
  }

  const movedOrders = new Set<number>()
  if (editing) {
    draft.forEach((s, i) => {
      const b = wf.steps[i]
      if (b === undefined || !sameStep(s, b)) movedOrders.add(s.order)
    })
  }

  const active = editing ? draft.findIndex((s) => s.stepId === activeId) : -1
  const shownSteps: WorkflowStep[] = editing ? draft : wf.steps

  return (
    <div className="wf-detail">
      <div className="flow-detail">
        <div className="flow-detail-row">
          <span className="scope-label">{t('workflows.name')}</span>
          <span className="scope-leader" />
          <span className="flow-detail-val">{wf.name}</span>
        </div>
        <div className="flow-detail-row">
          <span className="scope-label">{t('workflows.level')}</span>
          <span className="scope-leader" />
          <span className="flow-detail-val">
            {wf.level === 'team' ? t('workflows.levelTeam') : t('workflows.levelRole')}
          </span>
        </div>
        <div className="flow-detail-row">
          <span className="scope-label">{t('workflows.binds')}</span>
          <span className="scope-leader" />
          <span className="flow-detail-val">
            {wf.binds.length === 0 ? (
              <span className="muted">{t('common.unset')}</span>
            ) : (
              wf.binds.map((b) => (
                <a key={b} className="ref" href={`#/roles/${encodeURIComponent(b)}`}>
                  {b}
                </a>
              ))
            )}
          </span>
        </div>
        <div className="flow-detail-row">
          <span className="scope-label">{t('workflows.skills')}</span>
          <span className="scope-leader" />
          <span className="flow-detail-val mono small">
            {wf.skills.length === 0 ? t('common.unset') : wf.skills.join(', ')}
          </span>
        </div>
        {wf.sourcePath !== undefined && (
          <div className="flow-detail-row">
            <span className="scope-label">{t('workflows.source')}</span>
            <span className="scope-leader" />
            <span className="flow-detail-val mono small">{wf.sourcePath}</span>
          </div>
        )}
      </div>

      {errors.length > 0 && (
        <div className="banner">
          <StatusTag kind="err">{t('workflows.issueErrors', { n: errors.length })}</StatusTag>
          <div className="small">
            {(wf.issues ?? []).map((issue, i) => (
              <div key={i}>
                {issue.level === 'error' ? 'ERROR' : 'WARN'} [{issue.code}] {issue.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 工具栏：视图切换 + 编辑动作（脏标记 / 新增步骤 / 取消 / 保存） */}
      <div className="wf-toolbar">
        <div className="seg" role="group" aria-label={t('workflows.stepsTitle')}>
          <button
            type="button"
            className={view === 'graph' ? 'on' : undefined}
            aria-pressed={view === 'graph'}
            onClick={() => setView('graph')}
          >
            {t('workflows.viewGraph')}
          </button>
          <button
            type="button"
            className={view === 'table' ? 'on' : undefined}
            aria-pressed={view === 'table'}
            onClick={() => setView('table')}
          >
            {t('workflows.viewTable')}
          </button>
        </div>
        {editing && dirty && <StatusTag kind="warn">{t('workflows.graph.dirty')}</StatusTag>}
        <span className="flex-1" />
        {editing ? (
          <>
            <button type="button" className="tool-btn" onClick={() => addStep(null)}>
              {t('workflows.graph.addStep')}
            </button>
            <button type="button" className="tool-btn" onClick={cancelEdit} disabled={saving}>
              {t('common.cancel')}
            </button>
            <button type="button" className="primary" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? t('roles.form.saving') : t('common.save')}
            </button>
          </>
        ) : (
          <button type="button" className="tool-btn" onClick={startEdit}>
            {t('workflows.graph.edit')}
          </button>
        )}
      </div>

      {saveError !== '' && (
        <div className="banner">
          <StatusTag kind="err">{t('status.failed')}</StatusTag>
          <span className="small">{saveError}</span>
        </div>
      )}
      {savedAt > 0 && !editing && saveError === '' && (
        <div className="banner">
          <StatusTag kind="ok">{t('common.save')}</StatusTag>
          <span className="small">{t('workflows.graph.saved')}</span>
        </div>
      )}

      {view === 'graph' ? (
        <div className={editing ? 'wf-edit-split' : undefined}>
          <WorkflowGraph
            nodes={shownSteps.map((s) => ({
              order: s.order,
              label: s.step,
              owner: s.owner,
              reflow: s.reflow,
              data: s,
            }))}
            editable={editing}
            selected={active >= 0 ? draft[active]?.order : undefined}
            onSelect={
              editing
                ? (order) => {
                    const hit = draft.find((s) => s.order === order)
                    if (hit !== undefined) setActiveId(hit.stepId)
                  }
                : undefined
            }
            onChange={editing ? applyGraphChange : undefined}
            movedOrders={editing ? movedOrders : undefined}
          />
          {editing && draft[active] !== undefined && (
            <aside className="wf-inspector" aria-label={t('workflows.graph.editStep')}>
              <div className="wf-inspector-head">
                <span className="small muted">{t('workflows.graph.editStep')}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="tool-btn"
                  onClick={() => moveStep(active, -1)}
                  disabled={active === 0}
                  title={t('workflows.graph.moveUp')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  onClick={() => moveStep(active, 1)}
                  disabled={active >= draft.length - 1}
                  title={t('workflows.graph.moveDown')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="tool-btn"
                  onClick={() => addStep(active)}
                  title={t('workflows.graph.addStep')}
                >
                  +
                </button>
                <button
                  type="button"
                  className="tool-btn danger-ghost"
                  onClick={() => removeStep(active)}
                  disabled={draft.length <= 1}
                  title={t('workflows.graph.deleteStep')}
                >
                  ×
                </button>
              </div>
              <StepFieldset
                key={draft[active]!.stepId}
                step={draft[active]!}
                index={active}
                draft={draft}
                onPatch={(patch) => patchStep(active, patch)}
              />
            </aside>
          )}
        </div>
      ) : null}

      {view === 'table' &&
        (editing ? (
          <div className="wf-steps">
            {draft.map((step, i) => (
              <div key={step.stepId} className="wf-step-edit">
                <div className="wf-step-edit-head">
                  <span className="stage-num">{i + 1}</span>
                  <span className="stage-name">{step.step !== '' ? step.step : t('workflows.graph.untitled')}</span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={() => moveStep(i, -1)}
                    disabled={i === 0}
                    title={t('workflows.graph.moveUp')}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={() => moveStep(i, 1)}
                    disabled={i >= draft.length - 1}
                    title={t('workflows.graph.moveDown')}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="tool-btn danger-ghost"
                    onClick={() => removeStep(i)}
                    disabled={draft.length <= 1}
                    title={t('workflows.graph.deleteStep')}
                  >
                    {t('common.delete')}
                  </button>
                </div>
                <StepFieldset step={step} index={i} draft={draft} onPatch={(patch) => patchStep(i, patch)} />
              </div>
            ))}
          </div>
        ) : (
          <div className="wf-steps">
            {wf.steps.map((step) => (
              <div key={step.order} className="wf-step">
                <div className="wf-step-head">
                  <span className="stage-num">{step.order}</span>
                  <span className="stage-name">{step.step}</span>
                  <span className="small muted">{step.owner.join(' + ')}</span>
                  {step.skills !== '' && <span className="small mono">{step.skills}</span>}
                </div>
                <div className="flow-detail">
                  <div className="flow-detail-row">
                    <span className="scope-label">{t('workflows.io')}</span>
                    <span className="scope-leader" />
                    <span className="flow-detail-val mono small">
                      {step.input} → {step.output}
                    </span>
                  </div>
                  <div className="flow-detail-row">
                    <span className="scope-label">{t('workflows.done')}</span>
                    <span className="scope-leader" />
                    <span className="flow-detail-val small">{step.done}</span>
                  </div>
                  {step.reflow !== '' && step.reflow !== '—' && (
                    <div className="flow-detail-row">
                      <span className="scope-label">{t('workflows.reflow')}</span>
                      <span className="scope-leader" />
                      <span className="flow-detail-val small wf-reflow-text">↩ {step.reflow}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

      <h4>{t('workflows.bodyTitle')}</h4>
      <Markdown src={wf.body} />

      {!editing && (
        <div className="banner lamp">
          <span className="scope-lamp" />
          <span className="small">{t('workflows.editHint')}</span>
        </div>
      )}

      {confirmDiscard && (
        <ConfirmModal
          title={t('common.discardTitle')}
          body={t('common.discardBody')}
          confirmLabel={t('common.discard')}
          cancelLabel={t('common.keepEditing')}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false)
            closeGuard.current = null
            onRequestClose()
          }}
        />
      )}
    </div>
  )
}

/** 步骤字段组（图视图右侧面板与步骤表编辑态共用）。 */
function StepFieldset({
  step,
  index,
  draft,
  onPatch,
}: {
  step: DraftStep
  index: number
  draft: DraftStep[]
  onPatch: (patch: Partial<WorkflowStep>) => void
}) {
  const t = useT()
  // 承接是文本输入（逗号分隔），本地保留原文——否则「输入逗号被吃掉」的光标跳变很难用
  const [ownerText, setOwnerText] = useState(step.owner.join(', '))

  const target = parseReflowTarget(step.reflow)

  return (
    <div className="wf-fields">
      <label className="field">
        <span>{t('workflows.graph.stepName')}</span>
        <input value={step.step} onChange={(e) => onPatch({ step: e.target.value })} />
      </label>
      <label className="field">
        <span>{t('workflows.graph.ownerLabel')}</span>
        <input
          value={ownerText}
          onChange={(e) => {
            setOwnerText(e.target.value)
            onPatch({ owner: parseList(e.target.value) })
          }}
          onBlur={() => {
            const next = step.owner.join(', ')
            if (ownerText !== next) setOwnerText(next)
          }}
        />
      </label>
      <label className="field">
        <span>{t('workflows.graph.skillsLabel')}</span>
        <input value={step.skills} onChange={(e) => onPatch({ skills: e.target.value })} />
      </label>
      <div className="wf-fields-grid">
        <label className="field">
          <span>{t('workflows.graph.inputLabel')}</span>
          <textarea rows={2} value={step.input} onChange={(e) => onPatch({ input: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('workflows.graph.outputLabel')}</span>
          <textarea rows={2} value={step.output} onChange={(e) => onPatch({ output: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>{t('workflows.graph.doneLabel')}</span>
        <textarea rows={2} value={step.done} onChange={(e) => onPatch({ done: e.target.value })} />
      </label>
      <label className="field">
        <span>{t('workflows.graph.reflowLabel')}</span>
        <select
          value={target !== null ? String(target) : ''}
          onChange={(e) => {
            const v = e.target.value
            onPatch({ reflow: v === '' ? '—' : `\u56de ${v}` /* 回 */ })
          }}
        >
          <option value="">{t('workflows.graph.reflowNone')}</option>
          {draft.slice(0, index).map((s) => (
            <option key={s.stepId} value={String(s.order)}>
              {`\u56de ${s.order}` /* 回 */}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('workflows.graph.reflowText')}</span>
        <input value={step.reflow} onChange={(e) => onPatch({ reflow: e.target.value })} />
      </label>
    </div>
  )
}
