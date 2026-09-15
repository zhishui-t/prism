/**
 * 团队有效集（§4.3 S8）：**团队声明 ∪ 全体成员角色有效集**（客户端合并，不改服务端契约）。
 *
 * - 成员角色去重后逐个调 `effectiveSkills(role, team)`，并发合并；
 * - 同名只出现一次，`sources` 取并集（顺序仍 global → team → role）；
 * - 额外标注「由哪些成员角色带进来」，便于回答「这条技能是谁的需要」；
 * - 成员角色 > 12 时只算前 12 个并**显式提示**（不静默截断）。
 */

import { useMemo } from 'react'

import { teamApi, type EffectiveSkill, type ValidationIssue } from '../../../api-team.ts'
import { CountLine } from '../../../components/CountLine.tsx'
import { SkillScopeList } from '../../../components/SkillScopeList.tsx'
import { State } from '../../../components/State.tsx'
import { useAsync } from '../../../components/useAsync.ts'
import { useT } from '../../../i18n.ts'

/** 与 §4.3 S8 一致的上限：超出只算前 12 个成员角色并显式提示。 */
const MAX_MEMBERS = 12

const SOURCE_ORDER: Array<'global' | 'team' | 'role'> = ['global', 'team', 'role']

export function TeamEffectiveSkills({
  team,
  members,
  onOpenUsage,
}: {
  team: string
  /** 团队成员（`role` + `count`）。 */
  members: Array<{ role: string }>
  onOpenUsage?: () => void
}) {
  const t = useT()
  const roles = useMemo(() => [...new Set(members.map((m) => m.role))].sort((a, b) => a.localeCompare(b)), [members])
  const counted = roles.slice(0, MAX_MEMBERS)
  const truncated = roles.length - counted.length

  const eff = useAsync(
    () =>
      Promise.all(counted.map((r) => teamApi.effectiveSkills(r, team).catch(() => undefined))).then((sets) => {
        /** name → { available, sources, byRoles } */
        const merged = new Map<string, { available: boolean; sources: Set<string>; byRoles: Set<string> }>()
        const warnings: ValidationIssue[] = []
        for (let i = 0; i < counted.length; i++) {
          const set = sets[i]
          if (set === undefined) continue
          warnings.push(...set.warnings)
          for (const s of set.skills) {
            const cur = merged.get(s.name) ?? { available: false, sources: new Set<string>(), byRoles: new Set<string>() }
            cur.available = cur.available || s.available
            for (const src of s.sources) cur.sources.add(src)
            cur.byRoles.add(counted[i])
            merged.set(s.name, cur)
          }
        }
        const skills: EffectiveSkill[] = [...merged.entries()]
          .map(([name, v]) => ({
            name,
            available: v.available,
            sources: SOURCE_ORDER.filter((s) => v.sources.has(s)),
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
        const byRole = new Map<string, string[]>()
        for (const [name, v] of merged) for (const r of v.byRoles) byRole.set(r, [...(byRole.get(r) ?? []), name])
        return { skills, warnings, byRole }
      }),
    [team, counted.join(',')],
  )

  return (
    <div style={{ marginTop: 'var(--s-3)' }}>
      {/* B7：标题后跟 `(N)` 是第 4 种计数排法，改走统一引线零件。
          容器从临时 `.row` 换成既有的 `.pane-head` 槽（同一形状，且该槽的字号/间距已有约定），
          引线撑满弹性宽度后右侧按钮自然靠右，不再需要 `justify-content: space-between`。 */}
      <div className="pane-head">
        <CountLine
          size="section"
          bare
          label={t('teams.effective.title')}
          count={eff.data !== undefined ? eff.data.skills.length : undefined}
        />
        {onOpenUsage !== undefined && (
          <button className="rel-link" onClick={onOpenUsage} title={t('skills.effective.usageHint')}>
            {t('skills.effective.viewUsage')}
          </button>
        )}
      </div>
      <div className="small muted" style={{ marginBottom: 'var(--s-2)' }}>
        {t('teams.effective.hint', { n: counted.length })}
      </div>
      {truncated > 0 && (
        <div className="small" style={{ color: 'var(--warn)', marginBottom: 'var(--s-2)' }}>
          {t('teams.effective.truncated', { n: truncated, max: MAX_MEMBERS })}
        </div>
      )}

      {/* C9：「没有成员」是**空态**，此前塞进 `error` 通道会渲染成「请求失败：没有成员…」。 */}
      <State
        loading={eff.loading}
        empty={counted.length === 0}
        emptyText={t('teams.effective.noMembers')}
      >
        {eff.data !== undefined && (
          <>
            <SkillScopeList
              skills={eff.data.skills}
              note={(sk) => {
                // 逐行标注「由哪些成员角色带进来」（合并后 sources 只剩层级，角色归属需另算）
                const by = counted.filter((r) => (eff.data?.byRole.get(r) ?? []).includes(sk.name))
                if (by.length === 0) return null
                return <span className="small muted">{t('teams.effective.from', { roles: by.join(' / ') })}</span>
              }}
            />
            {eff.data.warnings.length > 0 && (
              <div className="scope-callout" role="status">
                <div className="small muted">{t('skills.effective.warnings', { n: eff.data.warnings.length })}</div>
                {eff.data.warnings.map((w, i) => (
                  <div key={`${w.code}-${i}`} className="small">
                    <span className="tag">{w.code}</span> {w.message}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </State>
    </div>
  )
}
