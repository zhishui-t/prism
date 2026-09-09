import { useState } from 'react'

import { teamApi, type TeamActivation } from '../api-team.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

/** 团队页：团队列表 + 工作流 + 沉淀规则 + 启用（装配状态）。 */
export function TeamsPage() {
  const teams = useAsync(() => teamApi.teams(), [])
  const [selected, setSelected] = useState<string>('')
  const [activation, setActivation] = useState<TeamActivation | null>(null)
  const [activating, setActivating] = useState(false)
  const [actError, setActError] = useState<string>('')

  const detail = useAsync(
    () => (selected ? teamApi.team(selected) : Promise.resolve(undefined)),
    [selected],
  )

  const onActivate = async () => {
    if (!selected) return
    setActivating(true)
    setActError('')
    setActivation(null)
    try {
      setActivation(await teamApi.activate(selected))
    } catch (e) {
      setActError(e instanceof Error ? e.message : String(e))
    } finally {
      setActivating(false)
    }
  }

  return (
    <>
      <h2 className="page-title">团队</h2>
      <p className="page-desc">
        团队 = 成员引用角色库 + 固定工作流 + 沉淀规则 + 优先级。Prism 只定义与校验，不执行调度。
      </p>

      <div className="card">
        <h3>团队列表</h3>
        <State
          loading={teams.loading}
          error={teams.error}
          empty={!teams.loading && !teams.error && (teams.data?.length ?? 0) === 0}
          emptyText="还没有团队定义。在 <PRISM_HOME>/teams/ 下放 <team-id>.md。"
        >
          <table>
            <thead>
              <tr>
                <th style={{ width: 180 }}>团队</th>
                <th>描述</th>
                <th style={{ width: 200 }}>成员</th>
                <th style={{ width: 80 }}>工作流</th>
              </tr>
            </thead>
            <tbody>
              {teams.data?.map((t) => (
                <tr key={t.team_id}>
                  <td>
                    <button
                      className="nav-item"
                      style={{ padding: 0, color: 'var(--accent)' }}
                      onClick={() => {
                        setSelected(t.team_id)
                        setActivation(null)
                        setActError('')
                      }}
                    >
                      {t.name}
                    </button>
                    <div className="mono small muted">{t.team_id}</div>
                  </td>
                  <td className="small">{t.description}</td>
                  <td className="mono small muted">
                    {t.members.map((m) => `${m.role}×${m.count}`).join(', ')}
                  </td>
                  <td className="mono small">{t.workflow.length} 阶段</td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      {selected && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>
              团队详情 <span className="mono small muted">{selected}</span>
            </h3>
            <div className="row">
              <button className="primary" onClick={onActivate} disabled={activating}>
                {activating ? '启用中…' : '启用团队'}
              </button>
              <button
                onClick={() => {
                  setSelected('')
                  setActivation(null)
                }}
              >
                关闭
              </button>
            </div>
          </div>

          <State loading={detail.loading} error={detail.error}>
            {detail.data && (
              <>
                <div className="row" style={{ marginBottom: 12 }}>
                  {detail.data.default && <span className="tag ok">默认团队</span>}
                  <span className="tag">沉淀: {detail.data.deposit.enabled ? '开' : '关'}</span>
                  <span className="tag">默认层: {detail.data.deposit.default_layer}</span>
                  <span className="tag">优先级: {detail.data.deposit.priority}</span>
                  {detail.data.arbitration.length > 0 && (
                    <span className="tag">仲裁: {detail.data.arbitration.join(' > ')}</span>
                  )}
                </div>

                <h3 style={{ marginTop: 14 }}>工作流</h3>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>#</th>
                      <th style={{ width: 120 }}>阶段</th>
                      <th style={{ width: 130 }}>负责角色</th>
                      <th style={{ width: 70 }}>串/并行</th>
                      <th>完成判定</th>
                      <th style={{ width: 160 }}>回流路径</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.workflow.map((s) => (
                      <tr key={s.order}>
                        <td className="mono">{s.order}</td>
                        <td>{s.stage}</td>
                        <td className="mono small">{s.roles.join(' + ')}</td>
                        <td className="small muted">{s.mode}</td>
                        <td className="small">{s.done}</td>
                        <td className="small muted">{s.reflow || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </State>

          {actError && (
            <div className="error" style={{ marginTop: 12 }}>
              启用失败：{actError}
            </div>
          )}

          {activation && (
            <>
              <h3 style={{ marginTop: 16 }}>装配状态</h3>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 180 }}>角色</th>
                    <th style={{ width: 70 }}>数量</th>
                    <th style={{ width: 100 }}>已装配</th>
                    <th style={{ width: 110 }}>派发路径</th>
                    <th>提示</th>
                  </tr>
                </thead>
                <tbody>
                  {activation.members.map((m) => (
                    <tr key={m.role}>
                      <td className="mono">{m.role}</td>
                      <td className="mono">{m.count}</td>
                      <td>
                        <span className={`tag${m.installed ? ' ok' : ' warn'}`}>
                          {m.installed ? '是' : '否'}
                        </span>
                      </td>
                      <td>
                        <span className={`tag${m.dispatch === 'native' ? ' ok' : ' warn'}`}>
                          {m.dispatch}
                        </span>
                      </td>
                      <td className="small muted">{m.hint ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </>
  )
}
