import { useState } from 'react'

import { teamApi, type EffectiveSkill, type ValidationIssue } from '../api-team.ts'
import { State } from '../components/State.tsx'
import { SkillScopeList } from './SkillScopeList.tsx'
import { useAsync } from '../components/useAsync.ts'
import { useT } from '../i18n.ts'

/**
 * F-D2 Skill **有效集**（正向视图：角色 × 团队 → 能用的 skill）。
 *
 * 与 Skills 页既有「使用情况」（反向视图：skill → 谁引用）并存互补，两处互相链接。
 * 按来源分组（global → team → role），同名 skill 只出现一次但挂多枚来源标签；
 * 未装（`available === false`）高亮并给出可执行命令。
 *
 * 复用：`.row` `.tag` `.mono` `.small` `.muted` `.empty` `.error` `.list-row` `.form-grid`、
 * `State`、`useAsync`。零新 UI 库、零新视觉语言。文案一律走 `t()`（组件内不留裸中文）。
 */

export function EffectiveSkills({
  role,
  team,
  roleFixed,
  teamFixed,
  roleOptions,
  onOpenUsage,
}: {
  /** 固定角色（roleFixed）或初始选中角色 */
  role?: string
  /** 固定团队（teamFixed）或初始选中团队 */
  team?: string
  roleFixed?: boolean
  teamFixed?: boolean
  /** 角色可选项（缺省 = 全部角色库）；团队详情传成员角色 */
  roleOptions?: string[]
  /** 「查看使用情况」入口（Skills 页反向视图） */
  onOpenUsage?: () => void
}) {
  const t = useT()
  const [roleSel, setRoleSel] = useState(role ?? '')
  const [teamSel, setTeamSel] = useState(team ?? '')

  // 选择器选项：全部角色 + 全部团队（读接口，缺省给空列表即可）
  const lists = useAsync(
    () => Promise.all([teamApi.roles(), teamApi.teams()]).then(([roles, teams]) => ({
      roles: roles.roles.map((r) => r.name).sort((a, b) => a.localeCompare(b)),
      teams: teams.teams.map((t) => t.team_id).sort((a, b) => a.localeCompare(b)),
    })),
    [],
  )

  const roleChoices = roleOptions ?? lists.data?.roles ?? []
  // 选了不存在的团队（父级传入的固定值过期）→ 不发请求，直接给明确错误
  const teamMissing =
    teamSel !== '' && lists.data !== undefined && !(lists.data.teams ?? []).includes(teamSel)
  const skip = roleSel === '' || teamMissing

  const eff = useAsync(() => {
    // 契约未定义 role='' 的行为（loadEffectiveSkills 的 roleId 为必填）→ 不发请求，给明确提示
    if (skip) return Promise.resolve(undefined)
    return teamApi.effectiveSkills(roleSel, teamSel === '' ? undefined : teamSel)
  }, [roleSel, teamSel, skip])

  return (
    <div style={{ marginTop: 'var(--s-3)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          {t('skills.effective.title')}
          {eff.data !== undefined && <span className="muted"> ({eff.data.skills.length})</span>}
        </h3>
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          {onOpenUsage && (
            <button className="rel-link" onClick={onOpenUsage} title={t('skills.effective.usageHint')}>
              {t('skills.effective.viewUsage')}
            </button>
          )}
          {roleFixed ? (
            <span className="tag">
              {t('skills.effective.role')}: {role ?? ''}
            </span>
          ) : (
            <label className="field" style={{ gap: 2 }}>
              <span className="label">{t('skills.effective.role')}</span>
              <select value={roleSel} onChange={(e) => setRoleSel(e.target.value)}>
                <option value="">{t('skills.effective.anyRole')}</option>
                {roleChoices.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}
          {teamFixed ? (
            <span className="tag">
              {t('skills.effective.team')}: {team ?? ''}
            </span>
          ) : (
            <label className="field" style={{ gap: 2 }}>
              <span className="label">{t('skills.effective.team')}</span>
              <select value={teamSel} onChange={(e) => setTeamSel(e.target.value)}>
                <option value="">{t('skills.effective.anyTeam')}</option>
                {(lists.data?.teams ?? []).map((teamId) => (
                  <option key={teamId} value={teamId}>
                    {teamId}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {teamMissing ? (
        <div className="error" style={{ marginTop: 'var(--s-2)' }}>
          {t('skills.effective.teamMissing', { name: teamSel })}
        </div>
      ) : roleSel === '' ? (
        <div className="empty" style={{ marginTop: 'var(--s-2)' }}>
          {t('skills.effective.pickHint')}
          <div className="small muted" style={{ marginTop: 'var(--s-2)' }}>
            {t('skills.effective.hint')}
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 'var(--s-2)' }}>
            <State
              loading={eff.loading}
              error={
                eff.error !== undefined && eff.error.startsWith('not_found')
                  ? t('skills.effective.roleMissing', { name: roleSel })
                  : eff.error
              }
            >
              {eff.data !== undefined && (
                <EffectiveList skills={eff.data.skills} warnings={eff.data.warnings} role={roleSel} />
              )}
            </State>
          </div>
          {eff.error !== undefined && (
            <div className="row" style={{ marginTop: 'var(--s-2)' }}>
              <button onClick={eff.reload}>{t('common.retry')}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EffectiveList({
  skills,
  warnings,
  role,
}: {
  skills: EffectiveSkill[]
  warnings: ValidationIssue[]
  role: string
}) {
  const t = useT()
  if (skills.length === 0) {
    return <div className="empty">{t('skills.effective.noneFor', { role })}</div>
  }

  return (
    <>
      {/* 分组渲染统一走 SkillScopeList（skills 详情「查看有效集」与 teams 详情共用，§4.3 S1/S7） */}
      <SkillScopeList skills={skills} />

      {warnings.length > 0 && (
        <div
          className="pane"
          role="status"
          style={{ background: 'var(--sheet-2)', marginTop: 'var(--s-3)', marginBottom: 0 }}
        >
          <h3>{t('skills.effective.warnings', { n: warnings.length })}</h3>
          {warnings.map((w, i) => (
            <div key={`${w.code}-${i}`} className="row" style={{ gap: 'var(--s-2)', alignItems: 'baseline' }}>
              <span className="tag err">{w.code}</span>
              <span className="small">{w.message}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
