import { useState } from 'react'

import { teamApi, type EffectiveSkill, type ValidationIssue } from '../api-team.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

/**
 * F-D2 Skill **有效集**（正向视图：角色 × 团队 → 能用的 skill）。
 *
 * 与 Skills 页既有「使用情况」（反向视图：skill → 谁引用）并存互补，两处互相链接。
 * 按来源分组（global → team → role），同名 skill 只出现一次但挂多枚来源标签；
 * 未装（`available === false`）高亮并给出可执行命令。
 *
 * 复用：`.card` `.row` `.tag` `.mono` `.small` `.muted` `.empty` `.error` `.list-row` `.form-grid`、
 * `State`、`useAsync`。零新 UI 库、零新视觉语言。
 */

type Source = 'global' | 'team' | 'role'

/** 来源分组顺序（与 F-D1 合并顺序一致：global → team → role）。 */
const SOURCE_ORDER: Source[] = ['global', 'team', 'role']

const SOURCE_LABEL: Record<Source, string> = {
  global: '全局已装',
  team: '团队声明',
  role: '角色声明',
}

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
  /** 「查看使用情况 →」入口（Skills 页反向视图） */
  onOpenUsage?: () => void
}) {
  const [roleSel, setRoleSel] = useState(role ?? '')
  const [teamSel, setTeamSel] = useState(team ?? '')

  // 选择器选项：全部角色 + 全部团队（读接口，缺省给空列表即可）
  const lists = useAsync(
    () => Promise.all([teamApi.roles(), teamApi.teams()]).then(([roles, teams]) => ({
      roles: roles.map((r) => r.name).sort((a, b) => a.localeCompare(b)),
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
    <div style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          有效 Skill
          {eff.data !== undefined && <span className="muted"> ({eff.data.skills.length})</span>}
        </h3>
        <div className="row" style={{ gap: 8 }}>
          {onOpenUsage && (
            <button className="rel-link" onClick={onOpenUsage} title="技能页 → 使用情况（反向视图）">
              查看使用情况 →
            </button>
          )}
          {roleFixed ? (
            <span className="tag">角色: {role ?? ''}</span>
          ) : (
            <label className="field" style={{ gap: 2 }}>
              <span className="label">角色</span>
              <select value={roleSel} onChange={(e) => setRoleSel(e.target.value)}>
                <option value="">（不指定角色）</option>
                {roleChoices.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          )}
          {teamFixed ? (
            <span className="tag">团队: {team ?? ''}</span>
          ) : (
            <label className="field" style={{ gap: 2 }}>
              <span className="label">团队</span>
              <select value={teamSel} onChange={(e) => setTeamSel(e.target.value)}>
                <option value="">（不指定团队）</option>
                {(lists.data?.teams ?? []).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      {teamMissing ? (
        <div className="error" style={{ marginTop: 10 }}>
          团队「{teamSel}」不存在。检查团队 ID，或清空团队选择。
        </div>
      ) : roleSel === '' ? (
        <div className="empty" style={{ marginTop: 10 }}>
          选择角色或团队以查看有效 Skill
          <div className="small muted" style={{ marginTop: 6 }}>
            有效集按角色计算：global ∪ 团队声明 ∪ 角色声明，同名合并、未装高亮。
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 10 }}>
            <State loading={eff.loading} error={eff.error !== undefined && eff.error.startsWith('not_found') ? `角色「${roleSel}」不存在（404）。刷新角色库后重试。` : eff.error}>
              {eff.data !== undefined && (
                <EffectiveList skills={eff.data.skills} warnings={eff.data.warnings} role={roleSel} />
              )}
            </State>
          </div>
          {eff.error !== undefined && (
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={eff.reload}>重试</button>
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
  const notInstalled = skills.filter((s) => !s.available)
  const installed = skills.length - notInstalled.length

  if (skills.length === 0) {
    return (
      <div className="empty">
        「{role}」当前没有可用 Skill。在角色定义的 <span className="mono">skills:</span> 里加一行，或在团队定义里声明。
      </div>
    )
  }

  // 分组：按来源优先级取主来源（global → team → role），多来源的行只出现一次
  const groups = SOURCE_ORDER.map((source) => ({
    source,
    items: skills.filter((s) => (s.sources[0] ?? 'global') === source),
  })).filter((g) => g.items.length > 0)

  return (
    <>
      <div className="row small muted" style={{ gap: 8, marginBottom: 8 }}>
        <span>
          已装 <span style={{ color: 'var(--text)' }}>{installed}</span> / 未装{' '}
          <span style={{ color: notInstalled.length > 0 ? 'var(--warn)' : 'var(--text)' }}>{notInstalled.length}</span>
        </span>
        {notInstalled.length === 0 && <span className="tag ok">全部已装</span>}
      </div>

      <div className="form-grid">
        {groups.map((g) => (
          <div key={g.source}>
            <div className="small muted" style={{ marginBottom: 4 }}>
              {SOURCE_LABEL[g.source]}（{g.items.length}）
            </div>
            {g.items.map((s) => (
              <div
                key={s.name}
                className="list-row"
                style={{ borderLeft: `3px solid ${s.available ? 'transparent' : 'var(--err)'}` }}
              >
                <span className="mono list-main">{s.name}</span>
                {s.sources.map((src) => (
                  <span key={src} className="tag">
                    {src}
                  </span>
                ))}
                <span className={`tag${s.available ? ' ok' : ' err'}`}>{s.available ? '已装' : '未装'}</span>
                {!s.available && (
                  <div className="small muted" style={{ width: '100%' }}>
                    宿主未装：<span className="mono">prism skill install {s.name}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div className="card" role="status" style={{ background: 'var(--panel-2)', marginTop: 12, marginBottom: 0 }}>
          <h3>⚠ {warnings.length} 条警告</h3>
          {warnings.map((w, i) => (
            <div key={`${w.code}-${i}`} className="row" style={{ gap: 6, alignItems: 'baseline' }}>
              <span className="tag err">{w.code}</span>
              <span className="small">{w.message}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
