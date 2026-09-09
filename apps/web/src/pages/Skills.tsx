import { teamApi } from '../api-team.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

/**
 * 技能页：Prism 自有 Skill 列表。
 * Skill 本身不分层——分层是"在哪儿被指定"的效果（全局/团队/角色）。
 */
export function SkillsPage() {
  const skills = useAsync(() => teamApi.skills(), [])

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
    </>
  )
}
