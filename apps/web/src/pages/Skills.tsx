import { teamApi } from '../api-team.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import type { NavTarget } from '../nav.ts'

/**
 * 技能页：Prism 自有 Skill 列表。
 * Skill 本身不分层——分层是"在哪儿被指定"的效果（全局/团队/角色）。
 *
 * 本页「使用情况」是**反向视图**（skill → 谁引用）；角色/团队详情里的「有效 Skill」是
 * **正向视图**（角色 × 团队 → 能用的 skill）。两者并存，互相链接（F-D2）。
 */
export function SkillsPage({
  onOpenEffective,
}: {
  /** 跳转到角色/团队详情的有效集（正向视图） */
  onOpenEffective?: (target: NavTarget) => void
} = {}) {
  const skills = useAsync(() => teamApi.skills(), [])
  const usage = useAsync(() => teamApi.skillUsage(), [])

  return (
    <>
      <h2 className="page-title">技能</h2>
      <p className="page-desc">
        Skill 本身不分层；在全局、团队定义、角色定义三处被指定后叠加使用。
      </p>

      <div className="card">
        <h3>Prism 自有 Skill</h3>
        <State
          loading={skills.loading}
          error={skills.error}
          empty={!skills.loading && !skills.error && (skills.data?.length ?? 0) === 0}
          emptyText="暂无内置技能"
        >
          <table>
            <thead>
              <tr>
                <th style={{ width: 200 }}>名称</th>
                <th>描述</th>
                <th style={{ width: 90 }}>来源</th>
              </tr>
            </thead>
            <tbody>
              {skills.data?.map((s) => (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td className="small">{s.description}</td>
                  <td>
                    <span className={`tag${s.builtin ? ' ok' : ''}`}>
                      {s.builtin ? '内置' : '外部'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      {/* 谁在用这个 Skill：角色白名单 ∪ 团队声明（合并视图，team-definition.md §6.3） */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>使用情况</h3>
          <span className="small muted">点角色 / 团队名 → 看它的「有效 Skill」（正向视图）</span>
        </div>
        <State
          loading={usage.loading}
          error={usage.error}
          empty={!usage.loading && !usage.error && (usage.data?.length ?? 0) === 0}
          emptyText="还没有任何 Skill 被角色或团队引用"
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Skill</th>
                  <th style={{ width: 90 }}>已装</th>
                  <th>被哪些角色引用</th>
                  <th>被哪些团队声明</th>
                </tr>
              </thead>
              <tbody>
                {usage.data?.map((u) => (
                  <tr key={u.name}>
                    <td className="mono">{u.name}</td>
                    <td>
                      <span className={`tag${u.installed ? ' ok' : ''}`}>{u.installed ? '已装' : '未装'}</span>
                    </td>
                    <td className="small muted">
                      {u.roles.length === 0
                        ? '—'
                        : u.roles.map((r, i) => (
                            <span key={r}>
                              {i > 0 && ', '}
                              <button
                                className="rel-link"
                                onClick={() => onOpenEffective?.({ page: 'roles', role: r })}
                              >
                                {r}
                              </button>
                            </span>
                          ))}
                    </td>
                    <td className="small muted">
                      {u.teams.length === 0
                        ? '—'
                        : u.teams.map((t, i) => (
                            <span key={t}>
                              {i > 0 && ', '}
                              <button
                                className="rel-link"
                                onClick={() => onOpenEffective?.({ page: 'teams', team: t })}
                              >
                                {t}
                              </button>
                            </span>
                          ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </div>
    </>
  )
}
