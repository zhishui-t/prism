import { useState } from 'react'

import { teamApi, type RoleDefinition, type ValidationIssue } from '../api-team.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

const COLOR_MAP: Record<string, string> = {
  red: '#e05555',
  blue: '#5b8cff',
  green: '#35c46b',
  yellow: '#e0c23a',
  purple: '#a06bff',
  orange: '#e08a3a',
  pink: '#e06ba0',
  cyan: '#3ac0c4',
}

/** 角色页：角色库列表 + 详情（核心第一原则 / 边界 / 能力 / 知识绑定）。 */
export function RolesPage() {
  const roles = useAsync(() => teamApi.roles(), [])
  const [selected, setSelected] = useState<string>('')

  const detail = useAsync(
    () => (selected ? teamApi.role(selected) : Promise.resolve(undefined)),
    [selected],
  )

  return (
    <>
      <h2 className="page-title">角色</h2>
      <p className="page-desc">
        角色是决策契约：核心第一原则决定冲突时牺牲什么；能力用白名单，知识绑到层与书。
      </p>

      <div className="card">
        <h3>角色库</h3>
        <State
          loading={roles.loading}
          error={roles.error}
          empty={!roles.loading && !roles.error && (roles.data?.length ?? 0) === 0}
          emptyText="还没有角色。用 `prism role import` 从宿主 agents 目录导入。"
        >
          <table>
            <thead>
              <tr>
                <th style={{ width: 170 }}>角色</th>
                <th>描述</th>
                <th style={{ width: 160 }}>能力（Skill 白名单）</th>
                <th style={{ width: 130 }}>知识绑定</th>
                <th style={{ width: 110 }}>校验</th>
              </tr>
            </thead>
            <tbody>
              {roles.data?.map((r) => (
                <tr key={r.name}>
                  <td>
                    <button
                      className="nav-item"
                      style={{ padding: 0, color: COLOR_MAP[r.color ?? ''] ?? 'var(--accent)' }}
                      onClick={() => setSelected(r.name)}
                    >
                      {r.name}
                    </button>
                  </td>
                  <td className="small">{r.description}</td>
                  <td className="mono small muted">
                    {r.skills.length ? r.skills.join(', ') : '—'}
                  </td>
                  <td className="small muted">
                    {(r.knowledge?.layers ?? []).join('/') || '—'}
                    {r.knowledge?.books?.length ? ` (${r.knowledge.books.join(', ')})` : ''}
                  </td>
                  <td>
                    <IssueBadge issues={r.issues} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      {selected && (
        <RoleDetail
          name={selected}
          detail={detail.data}
          loading={detail.loading}
          error={detail.error}
          onClose={() => setSelected('')}
        />
      )}
    </>
  )
}

function RoleDetail({
  name,
  detail,
  loading,
  error,
  onClose,
}: {
  name: string
  detail: RoleDefinition | undefined
  loading: boolean
  error: string | undefined
  onClose: () => void
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>
          角色详情 <span className="mono small muted">{name}</span>
        </h3>
        <button onClick={onClose}>关闭</button>
      </div>
      <State loading={loading} error={error}>
        {detail && (
          <>
            <div
              style={{
                background: 'var(--panel-2)',
                borderLeft: `3px solid ${COLOR_MAP[detail.color ?? ''] ?? 'var(--accent)'}`,
                padding: '10px 14px',
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              <div className="small muted" style={{ marginBottom: 4 }}>
                核心第一原则
              </div>
              <div style={{ fontWeight: 600 }}>{detail.principle || '（缺失）'}</div>
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              {detail.model && <span className="tag">model: {detail.model}</span>}
              {detail.thoughtLevel && <span className="tag">思考: {detail.thoughtLevel}</span>}
              {detail.sourcePath && (
                <span className="tag small">来源: {detail.sourcePath}</span>
              )}
            </div>
            {(detail.issues?.length ?? 0) > 0 && (
              <div className="card" style={{ background: 'var(--panel-2)', marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>校验问题</h3>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>级别</th>
                      <th style={{ width: 170 }}>代码</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.issues?.map((issue, i) => (
                      <tr key={`${issue.code}-${i}`}>
                        <td>
                          <span className={`tag ${issue.level === 'error' ? 'err' : 'warn'}`}>
                            {issue.level}
                          </span>
                        </td>
                        <td className="mono small">{issue.code}</td>
                        <td className="small">{issue.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <pre
              className="mono"
              style={{
                whiteSpace: 'pre-wrap',
                background: 'var(--panel-2)',
                padding: 12,
                borderRadius: 8,
                margin: 0,
                maxHeight: 360,
                overflow: 'auto',
              }}
            >
              {detail.body}
            </pre>
          </>
        )}
      </State>
    </div>
  )
}

/** 校验状态徽标：无 issue → ok；有 error → err；仅 warning → warn。 */
function IssueBadge({ issues }: { issues: ValidationIssue[] | undefined }) {
  const list = issues ?? []
  if (list.length === 0) return <span className="tag ok">ok</span>
  const errors = list.filter((i) => i.level === 'error').length
  const warnings = list.length - errors
  return (
    <span className={`tag ${errors > 0 ? 'err' : 'warn'}`} title={list.map((i) => `[${i.code}] ${i.message}`).join('\n')}>
      {errors}E / {warnings}W
    </span>
  )
}
