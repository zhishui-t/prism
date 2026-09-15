/**
 * 团队详情（8b：T3 启用结果就地 / T6 知识范围与声明技能 / T2 删除需输入 team_id / S8 团队有效集合并）。
 *
 * 组合顺序：头部动作 → **启用结果条（就地）** → 概览 kv → 工作流（横向 + 点阶段展开）
 * → 知识范围 ∥ 声明技能 → 名册 → 团队有效集；硬删走统一确认模态（B5，不再是内联危险区）。
 * 角色/技能/书一律走 `<Ref>`（Shell 不认识实体）。
 */

import { useEffect, useState } from 'react'

import { teamApi, type TeamActivation, type TeamDefinition } from '../../api-team.ts'
import { ConfirmModal } from '../../components/ConfirmModal.tsx'
import { CountLine } from '../../components/CountLine.tsx'
import { Ref } from '../../components/ref.tsx'
import { State } from '../../components/State.tsx'
import { Pane, StatusTag } from '../../components/ui.tsx'
import { useT, type DictKey } from '../../i18n.ts'
import { describeFailure } from './errors.ts'
import { TeamEffectiveSkills } from './parts/TeamEffectiveSkills.tsx'
import { WorkflowFlow } from './parts/WorkflowFlow.tsx'

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
}: {
  id: string
  detail: TeamDefinition | undefined
  loading: boolean
  error: string | undefined
  teamsDir: string | undefined
  onOpenUsage?: () => void
  onEdit: () => void
  onDeleted: (text: string) => void
}) {
  const t = useT()
  /** 装配状态：只有点过「启用团队」才有——避免把「未装配」误读成「坏了」。 */
  const [activation, setActivation] = useState<TeamActivation | null>(null)
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

  const installed = activation?.members.filter((m) => m.installed).length ?? 0
  const warns = activation?.members.filter((m) => !m.installed || m.dispatch !== 'native') ?? []

  return (
    <>
      <Pane
        head={
          <div className="pane-head">
            <h3 className="mono">{detail?.name ?? id}</h3>
            <span className="mono small muted">{id}</span>
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
          {detail !== undefined && (
            <>
              <h4>{t('teams.overview')}</h4>
              <dl className="kv">
                <dt>{t('common.name')}</dt>
                <dd>{detail.name !== '' ? detail.name : t('common.unset')}</dd>
                {detail.description !== '' && (
                  <>
                    <dt>{t('common.description')}</dt>
                    <dd>{detail.description}</dd>
                  </>
                )}
                <dt>{t('teams.col.members')}</dt>
                <dd className="mono">{detail.members.map((m) => `${m.role}×${m.count}`).join(', ') || t('common.unset')}</dd>
                <dt>{t('teams.col.stages')}</dt>
                <dd className="mono">{t('teams.stages', { n: detail.workflow.length })}</dd>
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
            </>
          )}
        </State>
      </Pane>

      {detail !== undefined && (
        <Pane head={<div className="pane-head"><h3>{t('teams.workflow')}</h3></div>}>
          <WorkflowFlow workflow={detail.workflow} />
        </Pane>
      )}

      {/* T6：知识范围 ∥ 声明技能（两个可点区块；知识是 teams 唯一能一次推给多成员的实体） */}
      {detail !== undefined && (
        <div className="two-col">
          <Pane title={t('teams.knowledge')}>
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
          <Pane title={t('teams.declaredSkills')}>
            {detail.skills.length === 0 ? (
              <div className="small muted">{t('teams.declaredSkills.empty')}</div>
            ) : (
              <div className="scope-body">
                {detail.skills.map((s) => (
                  <span key={s} className="scope-item">
                    <Ref kind="skill" name={s} />
                  </span>
                ))}
              </div>
            )}
          </Pane>
        </div>
      )}

      {detail !== undefined && (
        /* B7：名册条数走统一引线零件（原为 `Pane title="标题 · N"`，是第 3 种计数排法）。
           放进 `.pane-head` 与紧邻的工作流面板同槽（该槽的字号由 CSS 对齐）。 */
        <Pane
          head={
            <div className="pane-head">
              <CountLine size="section" bare label={t('teams.roster')} count={detail.members.length} />
            </div>
          }
        >
          <div className="small muted" style={{ marginBottom: 'var(--s-2)' }}>
            {t('teams.rosterHint')}
          </div>
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

      {/* S8：团队有效集 = 团队声明 ∪ 全体成员角色有效集（客户端合并，≤12 成员角色） */}
      {detail !== undefined && (
        <Pane>
          <TeamEffectiveSkills team={id} members={detail.members} onOpenUsage={onOpenUsage} />
        </Pane>
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
