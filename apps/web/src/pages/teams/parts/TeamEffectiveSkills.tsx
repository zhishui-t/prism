/**
 * 团队有效集（§4.3 S8）：**团队声明 ∪ 全体成员角色有效集**（客户端合并，不改服务端契约）。
 *
 * - 成员角色去重后逐个调 `effectiveSkills(role, team)`，并发合并；
 * - 同名只出现一次，`sources` 取并集（顺序仍 global → team → role）；
 * - 额外标注「由哪些成员角色带进来」，便于回答「这条技能是谁的需要」；
 * - 成员角色 > 12 时只算前 12 个并**显式提示**（不静默截断）。
 *
 * **F8 §2.5 / R-v8-7（本组件只改展示容器与分组默认态，取数逻辑一字未动）**：
 * - 它是 F6 收窄后团队页**唯一的技能视图**（原「声明技能」栏已合并进来），落在**常用**带
 *   （成员表之后、深挖折叠之前），所以外层容器由「自己带 `margin-top` 的独立块」改为
 *   `.two-col > .pane` 的右栏（间距交给 `.pane`）；
 * - 团队**显式声明** `team.skills` 的可见性不丢：走 Pane 头 `CountLine` 的 `title`（R-v8-6）；
 * - 有效集含 `global` 来源（= `computeEffectiveSkills` 口径），但 UI 按 sources 分组且
 *   **`global` 组默认折叠**（计数常驻组头），防「全库罗列」观感回潮。
 */

import { useMemo } from 'react'

import { teamApi, type EffectiveSkill, type ValidationIssue } from '../../../api-team.ts'
import { CountLine } from '../../../components/CountLine.tsx'
import { SkillScopeList, type Scope } from '../../../components/SkillScopeList.tsx'
import { State } from '../../../components/State.tsx'
import { useAsync } from '../../../components/useAsync.ts'
import { useT } from '../../../i18n.ts'

/** 与 §4.3 S8 一致的上限：超出只算前 12 个成员角色并显式提示。 */
const MAX_MEMBERS = 12

const SOURCE_ORDER: Array<'global' | 'team' | 'role'> = ['global', 'team', 'role']

/** R-v8-7：`global`（已装但无声明者）组默认收起；`team` / `role` 组保持默认展开。 */
const FOLDED_SOURCES: readonly Scope[] = ['global']

export function TeamEffectiveSkills({
  team,
  members,
  declared,
  onOpenUsage,
}: {
  team: string
  /** 团队成员（`role` + `count`）。 */
  members: Array<{ role: string }>
  /** 团队 frontmatter 里显式声明的 `skills` 条数（只作 Pane 头的 `title`，见 R-v8-6）。 */
  declared: number
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
    <>
      {/* B7：标题后跟 `(N)` 是第 4 种计数排法，改走统一引线零件。
          容器从临时 `.row` 换成既有的 `.pane-head` 槽（同一形状，且该槽的字号/间距已有约定），
          引线撑满弹性宽度后右侧按钮自然靠右，不再需要 `justify-content: space-between`。
          R-v8-6：`title` 承接「团队显式声明 N」——原独立「声明技能」栏合并后，团队自有声明的
          可见性由这一条 `title` 表达（`teams.declaredSkills` 因此仍有消费方）。 */}
      <div className="pane-head">
        <CountLine
          size="section"
          bare
          label={t('teams.effective.title')}
          count={eff.data !== undefined ? eff.data.skills.length : undefined}
          title={`${t('teams.declaredSkills')} ${declared}`}
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
              foldedSources={FOLDED_SOURCES}
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
    </>
  )
}
