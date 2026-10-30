/**
 * 团队详情（8b：T3 启用结果就地 / T6 知识范围 / T2 删除需输入 team_id / S8 团队有效集合并）。
 *
 * **F8 §2 层级重排后的组合顺序**（三档：第一眼 → 常用 → 深挖，见 v8-hierarchy-sketch §0.1）：
 *
 * 1. 第一眼带：`.pane-head`（**默认标记 + 动作位/`.spacer`**——身份 team_id 由外层 `<Modal>` 的
 *    标题承担，团队 `name` 自 v12 F3 起 **UI 零展示**）→ 启用结果条（就地）
 *    → 描述 `firstSentence(desc, 60)` 2 行（全文进 `title`）；
 * 2. 第一眼带：**工作流**（`WorkflowFlow`，灵魂，必须落在概览之上）——阶段计数并入它的 Pane 头；
 * 3. 常用带：成员表（`.form-grid` + `.list-row` 紧凑网格，`rosterHint` 降级为 Pane 头 `title`）
 *    → `.two-col`：左「知识范围」∥ 右「**成员技能集**」（F6：原「声明技能」栏与底部「团队有效集」
 *    同源，合并成一处，见 §2.5）；
 * 4. 深挖带：沉淀规则 / 仲裁链进 `<details>`（默认折叠，summary 口径同 `.role-body`）。
 *
 * 原「概览 `kv`」六行至此全部各有归属（§2.4 #1–#4）：名称→外层 `<Modal>` 标题（v12 F3 起为
 * team_id，团队 `name` 零展示）、描述→第一眼条、
 * 成员串→名册（逐成员可点）、阶段数→工作流 Pane 头计数、沉淀/仲裁→深挖折叠 —— 故 kv 整块删除。
 * 硬删走统一确认模态（B5，不再是内联危险区）。角色/技能/书一律走 `<Ref>`（Shell 不认识实体）。
 *
 * **v12 F3（W-4）**：本组件由「页内右栏 pane」迁入居中 `<Modal size="lg">`（父级 `TeamsPage` 给
 * 容器）；组件自身只交出「身份重复展示」这一处——`name` 与 team_id 行删除，其余结构与动作一字未动。
 */

import { useEffect, useState } from 'react'

import { api } from '../../api.ts'
import { adaptWorkflowParse, teamApi, type TeamActivation, type TeamDefinition } from '../../api-team.ts'
import { ConfirmModal } from '../../components/ConfirmModal.tsx'
import { CountLine } from '../../components/CountLine.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { Ref } from '../../components/ref.tsx'
import { State } from '../../components/State.tsx'
import { useAsync } from '../../components/useAsync.ts'
import { Pane, StatusTag, firstSentence } from '../../components/ui.tsx'
import { useT, type DictKey } from '../../i18n.ts'
import { describeFailure } from './errors.ts'
import { TeamEffectiveSkills } from './parts/TeamEffectiveSkills.tsx'
import { TeamRuntimePane } from './parts/TeamRuntimePane.tsx'
import { WorkflowFlow } from './parts/WorkflowFlow.tsx'
import { toFlowStages, workflowStateOf, draftFromParse, workflowInput, type WorkflowDraft } from './workflow-model.ts'
import type { WfGraphNode } from '../graph-logic.ts'
import { WorkflowGraph } from '../WorkflowGraph.tsx'

/** 层 → 字典键（静态映射，避免模板串拼 key）。 */
const LAYER_LABEL: Record<string, DictKey> = {
  global: 'teams.layer.global',
  project: 'teams.layer.project',
  role: 'teams.layer.role',
}

export function TeamDetail({
  id,
  detail,
  loading,
  error,
  teamsDir,
  onOpenUsage,
  onEdit,
  onDeleted,
  onRefresh,
  closeGuard,
}: {
  id: string
  detail: TeamDefinition | undefined
  loading: boolean
  error: string | undefined
  teamsDir: string | undefined
  onOpenUsage?: () => void
  onEdit: () => void
  onDeleted: (text: string) => void
  /** 图编辑保存成功后刷新详情（含 workflow_raw/source_mtime）。 */
  onRefresh?: () => void
  /** 弹窗关闭守卫（图编辑有未保存改动时先确认再关——与工作流单元页同一契约）。 */
  closeGuard?: { current: (() => boolean) | null }
}) {
  const t = useT()
  /** 装配状态：只有点过「启用团队」才有——避免把「未装配」误读成「坏了」。 */
  const [activation, setActivation] = useState<TeamActivation | null>(null)
  /** 工作流 Pane 的视图（图 | 卡片）。图视图可编辑（v3：拖阶段/换承接/回流边 → PATCH）。 */
  const [wfView, setWfView] = useState<'cards' | 'graph'>('graph')
  /** 图编辑草稿（WorkflowDraft——与表单编辑器同一数据模型，保存走 workflowInput 单点）。 */
  const [wfEditing, setWfEditing] = useState(false)
  const [wfDraft, setWfDraft] = useState<WorkflowDraft | null>(null)
  const [wfSaving, setWfSaving] = useState(false)
  const [wfSaveError, setWfSaveError] = useState('')
  const [wfSavedAt, setWfSavedAt] = useState(0)
  /** 关闭守卫的确认弹窗。 */
  const [wfDiscard, setWfDiscard] = useState(false)
  const [activating, setActivating] = useState(false)
  const [actError, setActError] = useState('')
  /** 启用结果条默认收成一行摘要（T3：一屏内可见，展开才看清单）。 */
  const [showAct, setShowAct] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [delError, setDelError] = useState('')
  /** `null` = 跟随父级给的默认目录；用户动过就固化为自己的值。 */
  const [dirOverride, setDirOverride] = useState<string | null>(null)
  /** 已注册项目名（运行时看板的项目选择器；空 = 还没注册任何项目）。 */
  const projects = useAsync<string[]>(
    () =>
      api
        .graphProjects()
        .then((list) => list.map((p) => p.project))
        .catch(() => []),
    [],
  )

  const dirValue = dirOverride ?? teamsDir ?? ''
  const effectiveDir = dirValue.trim()

  useEffect(() => {
    setConfirming(false)
    setConfirmText('')
    setDelError('')
    setActivation(null)
    setActError('')
    setShowAct(false)
  }, [id])

  const onActivate = async () => {
    setActivating(true)
    setActError('')
    setActivation(null)
    try {
      setActivation(await teamApi.activate(id))
    } catch (e) {
      setActError(e instanceof Error ? e.message : String(e))
    } finally {
      setActivating(false)
    }
  }

  const onDelete = async () => {
    if (effectiveDir === '') {
      setDelError(t('teams.v.dirRequired'))
      return
    }
    setDeleting(true)
    setDelError('')
    try {
      const result = await teamApi.deleteTeam(id, effectiveDir)
      onDeleted(t('teams.deleted', { id, n: result.removed.length }))
    } catch (e) {
      setDelError(describeFailure(t, e instanceof Error ? e.message : String(e), id))
    } finally {
      setDeleting(false)
    }
  }

  /** 图编辑脏判定：与初始载荷逐字节比（workflowInput 是唯一提交形态）。 */
  const wfDirty =
    wfEditing && wfDraft !== null && detail !== undefined
      ? JSON.stringify(workflowInput(wfDraft)) !== JSON.stringify(workflowInput(draftFromParse(adaptWorkflowParse(detail))))
      : false

  // 弹窗关闭守卫：脏草稿先确认（Esc/遮罩/关闭钮同一条路——与工作流单元页同契约）
  useEffect(() => {
    if (closeGuard === undefined) return
    closeGuard.current = wfDirty
      ? () => {
          setWfDiscard(true)
          return false
        }
      : null
    return () => {
      closeGuard.current = null
    }
  }, [wfDirty, closeGuard])

  /** 图编辑：从详情建草稿（表格式才可编——prose/missing 走表单编辑器）。 */
  const wfStartEdit = (): void => {
    if (detail === undefined) return
    setWfDraft(draftFromParse(adaptWorkflowParse(detail)))
    setWfEditing(true)
    setWfSaveError('')
    setWfSavedAt(0)
  }

  const wfCancel = (): void => {
    setWfEditing(false)
    setWfDraft(null)
    setWfSaveError('')
  }

  /** 图上改序/换承接/回流 → 写回草稿卡片（rowId/mode/输入输出等随 data 原样保留）。 */
  const wfGraphChange = (next: WfGraphNode[]): void => {
    setWfDraft((cur) => {
      if (cur === null) return cur
      const cards = next.map((n) => {
        const card = (n.data ?? {}) as Partial<WorkflowDraft['cards'][number]>
        return {
          ...(card as object),
          ...(card.rowId !== undefined ? { rowId: card.rowId } : {}),
          stage: n.label,
          roles: [...n.owner],
          reflow: n.reflow,
        } as WorkflowDraft['cards'][number]
      })
      return { ...cur, cards }
    })
  }

  const wfSave = async (): Promise<void> => {
    if (wfDraft === null || teamsDir === undefined || teamsDir === '') return
    setWfSaving(true)
    setWfSaveError('')
    try {
      await teamApi.updateTeam(id, {
        workflow: workflowInput(wfDraft),
        ...(detail?.source_mtime !== undefined ? { if_match: detail.source_mtime } : {}),
        teams_dir: teamsDir,
      })
      setWfSavedAt(Date.now())
      setWfEditing(false)
      setWfDraft(null)
      onRefresh?.()
    } catch (e) {
      setWfSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      setWfSaving(false)
    }
  }

  const installed = activation?.members.filter((m) => m.installed).length ?? 0
  const warns = activation?.members.filter((m) => !m.installed || m.dispatch !== 'native') ?? []

  return (
    <>
      <Pane
        head={
          /* v12 F3：身份（team_id）已由外层 `<Modal>` 的标题承担——这里不再重复一遍。
             团队 `name` 字段自本轮起**零展示**（展示面一律 team_id，SPEC-3.1）。 */
          <div className="pane-head">
            {detail?.default === true && <StatusTag kind="ok">{t('teams.default')}</StatusTag>}
            <span className="spacer">
              {detail !== undefined && (
                <>
                  <button className="primary" onClick={() => void onActivate()} disabled={activating}>
                    {activating ? t('teams.activating') : t('teams.activate')}
                  </button>
                  <button onClick={onEdit}>{t('common.edit')}</button>
                </>
              )}
              <button
                onClick={() => {
                  setConfirming((prev) => !prev)
                  setDelError('')
                }}
                disabled={deleting}
              >
                {t('common.delete')}
              </button>
            </span>
          </div>
        }
      >
        {/* T3：启用结果/失败**就地**落在动作正下方，先给一行结论，展开才看清单 */}
        {actError !== '' && (
          <div className="act-bar err" role="alert">
            {t('teams.activateFailed', { msg: actError })}
          </div>
        )}
        {activation !== null && (
          <div className="act-bar" role="status">
            <div className="act-bar-head">
              <span className="small">
                {t('teams.act.written', { installed, total: activation.members.length })}
              </span>
              <span className="scope-leader" />
              {warns.length > 0 && (
                <span className="small" style={{ color: 'var(--warn)' }}>
                  {t('teams.act.warns', { n: warns.length })}
                </span>
              )}
              <button className="rel-link" onClick={() => setShowAct((v) => !v)}>
                {showAct ? t('common.hideDetails') : t('common.showDetails')}
              </button>
            </div>
            <div className="small muted">{t('teams.act.memberHint')}</div>
            {activation.graph_status != null && (
              <div className="small muted">
                {t('teams.act.graph', { project: activation.graph_status.project })}
              </div>
            )}
            {activation.graph_build !== undefined && (
              <div className="small muted">{t('teams.act.build', { id: activation.graph_build.job_id })}</div>
            )}
            {showAct && (
              <table style={{ marginTop: 'var(--s-2)' }}>
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>{t('teams.col.owner')}</th>
                    <th style={{ width: 70 }}>{t('teams.col.qty')}</th>
                    <th style={{ width: 90 }}>{t('teams.col.assembled')}</th>
                    <th style={{ width: 110 }}>{t('teams.col.dispatch')}</th>
                    <th>{t('common.details')}</th>
                  </tr>
                </thead>
                <tbody>
                  {activation.members.map((m) => (
                    <tr key={m.role}>
                      <td className="mono">{m.role}</td>
                      <td className="mono">{m.count}</td>
                      <td>
                        <StatusTag kind={m.installed ? 'ok' : 'warn'}>
                          {m.installed ? t('common.yes') : t('common.no')}
                        </StatusTag>
                      </td>
                      <td>
                        <StatusTag kind={m.dispatch === 'native' ? 'ok' : 'warn'}>{m.dispatch}</StatusTag>
                      </td>
                      <td className="small muted">{m.hint ?? t('common.unset')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <State loading={loading} error={error}>
          {/* F8 §2.1 第一眼②：干什么（description）——一句话 2 行、全文进 `title`。
              原「概览 `kv`」六行见文件头注：各自归位后 kv 整块删除（§2.4 #1–#4）。 */}
          {detail !== undefined && detail.description !== '' && (
            <p className="pane-desc" title={detail.description}>
              {firstSentence(detail.description, 60)}
            </p>
          )}
        </State>
      </Pane>

      {/* F8 §2.1/§2.2：**工作流提到概览之上**——它是团队的灵魂，保持第一眼，不得降级/折叠。
          §2.4 #2：「阶段 N」不再单列一行，计数并入本 Pane 头的 `CountLine`（与名册同槽）。

          v11 F2 三态（design-v11 §3）：`WorkflowFlow` 的渲染代码**不动**，改的是喂给它的数据。
          - `prose`（小节存在但只有自由文本）：渲染 Markdown + 说明「结构化后可编排」；
          - `sectionMissing`（文件里没有这个小节）：显式说明，**不留空白**；
          - 其余：`toFlowStages` 兜缺省（order 非法按位置、mode 空按 serial、缺 roles/reflow 留空）
            ⇒ 缺 roles 画不出徽章、缺 reflow 不画回流线、只有序号+名称也照样成链。 */}
      {detail !== undefined &&
        (() => {
          const parse = adaptWorkflowParse(detail)
          const state = workflowStateOf(parse)
          return (
            <Pane
              head={
                <div className="pane-head">
                  <CountLine size="section" bare label={t('teams.workflow')} count={detail.workflow.length} />
                  {wfEditing && wfDirty && <StatusTag kind="warn">{t('workflows.graph.dirty')}</StatusTag>}
                  <span className="flex-1" />
                  {wfView === 'graph' && workflowStateOf(adaptWorkflowParse(detail)) === 'table' ? (
                    wfEditing ? (
                      <>
                        <button type="button" className="tool-btn" onClick={wfCancel} disabled={wfSaving}>
                          {t('common.cancel')}
                        </button>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => void wfSave()}
                          disabled={wfSaving || !wfDirty || wfSaving}
                        >
                          {t('common.save')}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="tool-btn" onClick={wfStartEdit} disabled={wfSaving}>
                        {t('workflows.graph.edit')}
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    className="rel-link"
                    onClick={() => setWfView(wfView === 'cards' ? 'graph' : 'cards')}
                    title={t('workflows.viewGraph')}
                  >
                    {wfView === 'cards' ? t('workflows.viewGraph') : t('workflows.viewTable')}
                  </button>
                </div>
              }
            >
              {/* 数据质量可见化：工作流表的行级问题（列数不符截断 / 序号回退）曾静默吞掉
                  整个「设计审核」阶段——这里把 issues 里 workflow_* 的问题摆出来。 */}
              {(detail.issues ?? []).some((i) => i.code.startsWith('workflow_')) && (
                <details className="team-deep">
                  <summary>{t('teams.wf.issuesDetail')}</summary>
                  <div className="small">
                    {(detail.issues ?? [])
                      .filter((i) => i.code.startsWith('workflow_'))
                      .map((i, k) => (
                        <div key={k} className="runtime-gap lv-warning">
                          <span className={`issue-level ${i.level === 'error' ? 'error' : 'warning'}`}>
                            {i.level === 'error' ? t('roles.level.error') : t('roles.level.warning')}
                          </span>
                          <span>{i.message}</span>
                        </div>
                      ))}
                  </div>
                </details>
              )}
              {state === 'prose' ? (
                <>
                  <div className="small muted">{t('teams.wf.prose.title')}</div>
                  {parse.proseText !== undefined && parse.proseText !== '' ? (
                    <div className="wf-prose-body">
                      <Markdown src={parse.proseText} />
                    </div>
                  ) : (
                    // 没拿到小节原文（服务端未下发该键 / 响应来自旧版本）：如实说「看不到」，
                    // 不拿空串当正文渲染
                    <div className="small muted">{t('teams.wf.prose.noText')}</div>
                  )}
                </>
              ) : state === 'missing' ? (
                <div className="small muted">{t('teams.wf.missing.title')}</div>
              ) : wfView === 'graph' ? (
                <>
                  {(wfSaveError !== '' || (wfSavedAt > 0 && !wfEditing)) && (
                    <div className={wfSaveError !== '' ? 'banner' : 'banner'}>
                      <StatusTag kind={wfSaveError !== '' ? 'err' : 'ok'}>
                        {wfSaveError !== '' ? t('status.failed') : t('common.save')}
                      </StatusTag>
                      <span className="small">{wfSaveError !== '' ? wfSaveError : t('workflows.graph.saved')}</span>
                    </div>
                  )}
                  <WorkflowGraph
                    nodes={
                      wfEditing && wfDraft !== null
                        ? wfDraft.cards.map((c, i) => ({
                            order: i + 1,
                            label: c.stage,
                            owner: [...c.roles],
                            reflow: c.reflow,
                            data: c,
                          }))
                        : toFlowStages(detail.workflow).map((s) => ({
                            order: s.order,
                            label: s.stage,
                            owner: s.roles,
                            reflow: s.reflow,
                          }))
                    }
                    editable={wfEditing}
                    onChange={wfEditing ? wfGraphChange : undefined}
                  />
                </>
              ) : (
                <WorkflowFlow workflow={toFlowStages(detail.workflow)} />
              )}
            </Pane>
          )
        })()}

      {/* 运行时看板（只读）：把项目 `.agent-team/` 黑板读成「现在该派谁」——
          任务四态 / 可派发集 / 会话登记 / 门禁 / 缺口。放在工作流之后：工作流是「应该怎么跑」，
          这里才是「实际跑到哪了」。 */}
      <TeamRuntimePane teamId={id} projects={projects.data ?? []} />

      {/* F8 §2.1 常用带①：成员表（紧凑网格：`Ref kind="role"` + `×N` 的 `StatusTag`）。
          §2.4 #6：`teams.rosterHint` 由常驻说明行降级为 Pane 头 `CountLine` 的 `title`。 */}
      {detail !== undefined && (
        <Pane
          head={
            <div className="pane-head">
              <CountLine
                size="section"
                bare
                label={t('teams.roster')}
                count={detail.members.length}
                title={t('teams.rosterHint')}
              />
            </div>
          }
        >
          <div className="form-grid">
            {detail.members.map((m) => (
              <div key={m.role} className="list-row">
                <Ref kind="role" name={m.role} />
                <StatusTag kind="info">×{m.count}</StatusTag>
              </div>
            ))}
          </div>
        </Pane>
      )}

      {/* F8 §2.5 两栏区：左 = 知识范围（层 `.tag` + `Ref kind="book"`），
          右 = **成员技能集**（F6 收窄后的唯一技能视图——原「声明技能」栏的位置被它接管）。 */}
      {detail !== undefined && (
        <div className="two-col">
          <Pane
            head={
              <div className="pane-head">
                <CountLine
                  size="section"
                  bare
                  label={t('teams.knowledge')}
                  count={detail.knowledge.layers.length + (detail.knowledge.books ?? []).length}
                />
              </div>
            }
          >
            {detail.knowledge.layers.length === 0 && (detail.knowledge.books ?? []).length === 0 ? (
              <div className="small muted">{t('teams.knowledge.empty')}</div>
            ) : (
              <div className="scope-groups">
                {detail.knowledge.layers.length > 0 && (
                  <div className="scope-body">
                    {detail.knowledge.layers.map((l) => (
                      <span key={l} className="tag">
                        {LAYER_LABEL[l] !== undefined ? t(LAYER_LABEL[l]) : l}
                      </span>
                    ))}
                  </div>
                )}
                {(detail.knowledge.books ?? []).map((b) => (
                  <div key={b} className="scope-item">
                    <Ref kind="book" name={b} />
                  </div>
                ))}
              </div>
            )}
          </Pane>
          {/* F6 合并（§2.4 #5）：原独立「声明技能」Pane（团队 frontmatter 的 `team.skills`）与
              原底部独立「团队有效集」Pane **同源**（成员角色有效集并集），此处只画一次。
              团队显式声明的可见性不丢：走 Pane 头 `CountLine` 的 `title`（R-v8-6）。 */}
          <Pane>
            <TeamEffectiveSkills
              team={id}
              members={detail.members}
              declared={detail.skills.length}
              onOpenUsage={onOpenUsage}
            />
          </Pane>
        </div>
      )}

      {/* F8 §2.1 深挖带（§2.4 #3）：沉淀规则 / 仲裁链默认折叠，summary 口径沿用 `.role-body`
          （`--fs-200` + `--mute`）。`DepositRules` 是**表单**零件（只被 `TeamForm` 消费），
          不在此折叠容器内，其内部交互不受影响。 */}
      {detail !== undefined && (
        <details className="team-deep">
          <summary>{t('teams.deepDive')}</summary>
          <dl className="kv">
            <dt>{t('teams.deposit')}</dt>
            <dd>
              <StatusTag kind={detail.deposit.enabled ? 'ok' : 'info'}>
                {detail.deposit.enabled ? t('common.yes') : t('common.no')}
              </StatusTag>
              {detail.deposit.enabled && (
                <span className="small muted" style={{ marginLeft: 'var(--s-2)' }}>
                  {detail.deposit.default_layer} › {detail.deposit.default_type} › {detail.deposit.priority}
                  {detail.deposit.require_note ? ` › ${t('teams.deposit.note')}` : ''}
                </span>
              )}
            </dd>
            {detail.arbitration.length > 0 && (
              <>
                <dt>{t('teams.arbitration')}</dt>
                <dd className="mono small">{detail.arbitration.join(' > ')}</dd>
              </>
            )}
          </dl>
        </details>
      )}

      {/* 图编辑脏草稿被关闭弹窗拦下 → 丢弃确认（与工作流单元页同一条守卫契约） */}
      {wfDiscard && (
        <ConfirmModal
          title={t('common.discardTitle')}
          body={t('common.discardBody')}
          confirmLabel={t('common.discard')}
          cancelLabel={t('common.keepEditing')}
          onCancel={() => setWfDiscard(false)}
          onConfirm={() => {
            setWfDiscard(false)
            if (closeGuard !== undefined) closeGuard.current = null
            wfCancel()
          }}
        />
      )}

      {/* T2：硬删确认走统一模态（B5：Esc / 遮罩 / 滚动锁 / 焦点 / `--err` 危险色全站一套）。
          语义判定：这一块由头部「删除」触发、只有「取消 / 确认删除」两个出口 + 一道手打 team_id 闸门
          —— 是**删除确认**而非「就地警告区」，故按 B5「4 处调用点全部替换」换 `<ConfirmModal>`。
          目录输入（服务端要求显式给出）与闸门留在正文里；闸门未过只禁用确认钮（`confirmDisabled`）。 */}
      {confirming && (
        <ConfirmModal
          title={t('teams.delete.title', { id })}
          busy={deleting}
          confirmDisabled={effectiveDir === '' || confirmText.trim() !== id}
          error={delError}
          onConfirm={() => void onDelete()}
          onCancel={() => setConfirming(false)}
          body={
            <>
              <p className="muted">
                <strong>{t('common.irreversible')}</strong>
                {t('teams.deleteWarning', { id })}
              </p>
              <label className="field" htmlFor="td-dir">
                <span className="label">{t('teams.dir')}</span>
                <input
                  id="td-dir"
                  value={dirValue}
                  placeholder={teamsDir ?? ''}
                  disabled={deleting}
                  onChange={(e) => setDirOverride(e.target.value)}
                />
                {teamsDir === undefined && <span className="small muted">{t('teams.dirManual')}</span>}
              </label>
              {/* T2：硬删 → 必须手打 team_id 才放行（防误点） */}
              <label className="field" htmlFor="td-confirm" style={{ marginTop: 'var(--s-2)' }}>
                <span className="label">{t('teams.delete.confirmLabel', { id })}</span>
                <input
                  id="td-confirm"
                  value={confirmText}
                  placeholder={id}
                  disabled={deleting}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
              </label>
            </>
          }
        />
      )}
    </>
  )
}
