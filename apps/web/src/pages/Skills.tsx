import { useMemo, useState } from 'react'

import { teamApi, type SkillDetail, type SkillUsage, type PrismSkill } from '../api-team.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { PageHead, Pane, StatusTag, firstSentence } from '../components/ui.tsx'
import { useT } from '../i18n.ts'

/**
 * 技能页：Prism 自有 Skill 清单 + 被谁引用 + 点行看详情。
 *
 * 重构前是两张割裂的表：上面只列**内置** 1 个技能，下面「使用情况」列**已装**的另外 5 个——
 * 同一页看不到完整清单，也不能点开看 SKILL.md 正文。现在合并成一张主从列表：
 * 列表 = 内置 ∪ 已装 ∪ 被引用（按名字去重），详情 = `/api/skills/:name`。
 *
 * Skill 本身不分层——分层是「在哪儿被指定」的效果（全局/团队/角色）。
 */
interface SkillRow {
  name: string
  summary: string
  builtin: boolean
  installed: boolean
  roles: string[]
  teams: string[]
}

export function SkillsPage({
  sel,
  onSelect,
  onOpenRole,
  onOpenTeam,
}: {
  sel?: string
  onSelect?: (name: string) => void
  /** 跳角色详情（反向视图 → 正向视图） */
  onOpenRole?: (name: string) => void
  /** 跳团队详情 */
  onOpenTeam?: (id: string) => void
} = {}) {
  const t = useT()
  const skills = useAsync(() => teamApi.skills(), [])
  const usage = useAsync(() => teamApi.skillUsage(), [])
  const [filter, setFilter] = useState('')

  const detail = useAsync(
    () => (sel !== undefined && sel !== '' ? teamApi.skill(sel) : Promise.resolve(undefined)),
    [sel],
  )

  const rows = useMemo<SkillRow[]>(() => {
    const map = new Map<string, SkillRow>()
    const ensure = (name: string): SkillRow => {
      let row = map.get(name)
      if (row === undefined) {
        row = { name, summary: '', builtin: false, installed: false, roles: [], teams: [] }
        map.set(name, row)
      }
      return row
    }
    for (const skill of (skills.data ?? []) as PrismSkill[]) {
      const row = ensure(skill.name)
      row.builtin = true
      row.summary = skill.description
    }
    for (const item of (usage.data ?? []) as SkillUsage[]) {
      const row = ensure(item.name)
      row.builtin = row.builtin || item.builtin
      row.installed = item.installed
      row.roles = item.roles
      row.teams = item.teams
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [skills.data, usage.data])

  const keyword = filter.trim().toLowerCase()
  const shown =
    keyword === ''
      ? rows
      : rows.filter(
          (r) => r.name.toLowerCase().includes(keyword) || r.summary.toLowerCase().includes(keyword),
        )

  const loading = skills.loading || usage.loading
  const error = skills.error ?? usage.error

  return (
    <>
      <PageHead title={t('skills.title')} sub={t('skills.desc')} />

      <State loading={loading} error={error} empty={!loading && !error && rows.length === 0} emptyText={t('skills.empty')}>
        <div className="md">
          <div className="md-list">
            <div style={{ padding: '4px 4px 8px' }}>
              <input
                className="grow"
                style={{ width: '100%' }}
                placeholder={t('skills.filterPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {shown.length === 0 && <div className="small muted" style={{ padding: '8px 10px' }}>{t('common.empty')}</div>}
            {shown.map((row) => (
              <button
                key={row.name}
                className={`md-row${sel === row.name ? ' sel' : ''}`}
                onClick={() => onSelect?.(row.name)}
              >
                <span className="t">{row.name}</span>
                {row.summary !== '' && <span className="s">{firstSentence(row.summary, 76)}</span>}
                <span className="tags">
                  <StatusTag kind={row.builtin ? 'info' : 'info'}>{row.builtin ? t('common.builtin') : t('common.external')}</StatusTag>
                  <StatusTag kind={row.installed ? 'ok' : 'warn'}>
                    {row.installed ? t('common.installed') : t('common.notInstalled')}
                  </StatusTag>
                  {(row.roles.length > 0 || row.teams.length > 0) && (
                    <StatusTag kind="info">
                      {row.roles.length + row.teams.length} refs
                    </StatusTag>
                  )}
                </span>
              </button>
            ))}
          </div>

          <div className="md-detail">
            {sel === undefined || sel === '' ? (
              <Pane>
                <div className="small muted">{t('skills.selectHint')}</div>
              </Pane>
            ) : (
              <SkillDetailPane
                detail={detail.data}
                loading={detail.loading}
                error={detail.error}
                onOpenRole={onOpenRole}
                onOpenTeam={onOpenTeam}
              />
            )}
          </div>
        </div>
      </State>
    </>
  )
}

function SkillDetailPane({
  detail,
  loading,
  error,
  onOpenRole,
  onOpenTeam,
}: {
  detail: SkillDetail | undefined
  loading: boolean
  error: string | undefined
  onOpenRole?: (name: string) => void
  onOpenTeam?: (id: string) => void
}) {
  const t = useT()
  return (
    <Pane
      head={
        <div className="pane-head">
          <h3 className="mono">{detail?.name ?? '…'}</h3>
          {detail !== undefined && (
            <>
              <StatusTag kind="info">{detail.builtin ? t('common.builtin') : t('common.external')}</StatusTag>
              <StatusTag kind={detail.installed ? 'ok' : 'warn'}>
                {detail.installed ? t('common.installed') : t('common.notInstalled')}
              </StatusTag>
            </>
          )}
        </div>
      }
    >
      <State loading={loading} error={error}>
        {detail !== undefined && (
          <>
            <h4>{t('skills.detail.about')}</h4>
            <div className="small">{detail.description !== '' ? detail.description : '—'}</div>

            <h4>{t('skills.detail.path')}</h4>
            <div className="mono small" style={{ wordBreak: 'break-all' }}>
              {detail.path}
            </div>
            {!detail.installed && (
              <div className="small muted" style={{ marginTop: 6 }}>
                {t('skills.detail.notInstalledHint')}
              </div>
            )}

            <h4>{t('skills.usage')}</h4>
            <dl className="kv">
              <dt>{t('skills.refRoles')}</dt>
              <dd>
                {detail.roles.length === 0 ? (
                  '—'
                ) : (
                  <span className="chips">
                    {detail.roles.map((name) => (
                      <button key={name} className="rel-link" onClick={() => onOpenRole?.(name)}>
                        {name}
                      </button>
                    ))}
                  </span>
                )}
              </dd>
              <dt>{t('skills.refTeams')}</dt>
              <dd>
                {detail.teams.length === 0 ? (
                  '—'
                ) : (
                  <span className="chips">
                    {detail.teams.map((id) => (
                      <button key={id} className="rel-link" onClick={() => onOpenTeam?.(id)}>
                        {id}
                      </button>
                    ))}
                  </span>
                )}
              </dd>
            </dl>

            <h4>SKILL.md</h4>
            {detail.content === '' ? (
              <div className="small muted">{t('skills.detail.bodyUnavailable')}</div>
            ) : (
              <pre className="entry-body">{detail.content}</pre>
            )}
          </>
        )}
      </State>
    </Pane>
  )
}
