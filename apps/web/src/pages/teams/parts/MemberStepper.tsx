/**
 * 成员步进器（合并新建 / 编辑两处重复实现，T5）。
 *
 * 两份表单的成员行只差「校验标记」一处：新建带 `E/W` 徽标（角色 issues），
 * 编辑不带 → 用可选的 `tag` 插槽统一，其余（选中态左边线、−/n/+）完全一致。
 */

import type { ReactNode } from 'react'

import type { RoleDefinition } from '../../../api-team.ts'
import { useT } from '../../../i18n.ts'

export function MemberStepper({
  name,
  count,
  disabled,
  onBump,
  max = 9,
}: {
  name: string
  count: number
  disabled: boolean
  onBump: (delta: number) => void
  /** 与服务端 `member count` 上界对齐（1–9）。 */
  max?: number
}) {
  return (
    <div className="stepper">
      <button aria-label={`- ${name}`} disabled={count <= 0 || disabled} onClick={() => onBump(-1)}>
        −
      </button>
      <span className="n">{count}</span>
      <button aria-label={`+ ${name}`} disabled={count >= max || disabled} onClick={() => onBump(1)}>
        +
      </button>
    </div>
  )
}

/** 成员行：名字 + 可选校验标记 + 步进器（选中 = 左边线 `--buckram`）。 */
export function MemberRow({
  name,
  count,
  disabled,
  onBump,
  tag,
}: {
  name: string
  count: number
  disabled: boolean
  onBump: (delta: number) => void
  tag?: ReactNode
}) {
  return (
    <div
      className={`list-row${count === 0 ? ' muted' : ''}`}
      style={{ borderLeft: `3px solid ${count > 0 ? 'var(--buckram)' : 'transparent'}` }}
    >
      <span className="mono list-main">{name}</span>
      {tag}
      <MemberStepper name={name} count={count} disabled={disabled} onBump={onBump} />
    </div>
  )
}

/**
 * 成员选择区（同样两处重复：新建/编辑的「成员」整段）。
 *
 * 统一了原先两份各自手写的「已选摘要 + 可用数 + 加载/失败/空态 + 过滤框 + 网格」，
 * 差异只留两个开关：`showIssues`（新建给 `E/W` 校验标记）与 `showEmptyState`
 * （新建在角色库为空时给重试出口；编辑候选含「定义里还在但角色库已无」的角色，不该给）。
 */
export function MemberPicker({
  candidates,
  counts,
  filter,
  loading,
  error,
  membersError,
  disabled,
  idPrefix,
  showIssues,
  showEmptyState,
  onReloadRoles,
  onFilter,
  onBump,
}: {
  /** 候选角色（编辑 = 角色库 ∪ 孤儿角色）。 */
  candidates: RoleDefinition[]
  counts: Record<string, number>
  filter: string
  loading: boolean
  /** 角色库拉取失败的原因（undefined = 成功）。 */
  error: string | undefined
  /** 成员数校验错误（来自表单）。 */
  membersError?: string | undefined
  disabled: boolean
  idPrefix: string
  showIssues: boolean
  showEmptyState: boolean
  onReloadRoles: () => void
  onFilter: (text: string) => void
  onBump: (role: string, delta: number) => void
}) {
  const t = useT()
  const selected = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => a.role.localeCompare(b.role))
  const total = selected.reduce((sum, m) => sum + m.count, 0)

  /** 已选置顶，其余按名排序；过滤纯前端 substring。 */
  const q = filter.trim().toLowerCase()
  const visible = candidates
    .filter((r) => q === '' || r.name.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => {
      const picked = (r: RoleDefinition) => ((counts[r.name] ?? 0) > 0 ? 0 : 1)
      const diff = picked(a) - picked(b)
      return diff !== 0 ? diff : a.name.localeCompare(b.name)
    })

  return (
    <>
      <h4>{t('teams.form.membersTitle')}</h4>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-2)' }}>
        <span className="small muted">
          {total > 0
            ? t('teams.form.selectedMembers', {
                n: total,
                list: selected.map((m) => `${m.role}×${m.count}`).join(', '),
              })
            : t('teams.form.noMembers')}
        </span>
        {!loading && candidates.length > 0 && (
          <span className="small muted">
            {t('teams.form.availableRoles', { n: candidates.filter((r) => (counts[r.name] ?? 0) === 0).length })}
          </span>
        )}
      </div>

      {loading ? (
        <div className="empty">{t('teams.rolesLoading')}</div>
      ) : error !== undefined ? (
        <div className="error" role="alert">
          {t('teams.rolesFailed', { msg: error })}{' '}
          <button className="rel-link" onClick={onReloadRoles}>
            {t('common.retry')}
          </button>
        </div>
      ) : showEmptyState && candidates.length === 0 ? (
        <div className="empty">
          {t('teams.rolesEmpty')}
          <div className="row" style={{ justifyContent: 'center', marginTop: 'var(--s-2)' }}>
            <button onClick={onReloadRoles}>{t('common.retry')}</button>
          </div>
        </div>
      ) : (
        <>
          {candidates.length > 8 && (
            <label className="field" htmlFor={`${idPrefix}filter`} style={{ marginBottom: 'var(--s-2)' }}>
              <input
                id={`${idPrefix}filter`}
                value={filter}
                placeholder={t('teams.rolesFilter')}
                onChange={(e) => onFilter(e.target.value)}
              />
            </label>
          )}
          <div id={`${idPrefix}members`} tabIndex={-1} className="form-grid">
            {visible.map((r) => {
              const count = counts[r.name] ?? 0
              const errs = (r.issues ?? []).filter((i) => i.level === 'error').length
              const warns = (r.issues ?? []).length - errs
              return (
                <MemberRow
                  key={r.name}
                  name={r.name}
                  count={count}
                  disabled={disabled}
                  onBump={(d) => onBump(r.name, d)}
                  tag={
                    showIssues ? (
                      <span
                        className={`tag${errs > 0 ? ' err' : warns > 0 ? ' warn' : ' ok'}`}
                        title={(r.issues ?? []).map((i) => `[${i.code}] ${i.message}`).join('\n')}
                      >
                        {errs > 0 ? `${errs}E` : warns > 0 ? `${warns}W` : 'ok'}
                      </span>
                    ) : undefined
                  }
                />
              )
            })}
          </div>
          {membersError !== undefined && (
            <span className="err-text" style={{ color: 'var(--err)', fontSize: 'var(--fs-200)' }}>
              {membersError}
            </span>
          )}
        </>
      )}
    </>
  )
}
