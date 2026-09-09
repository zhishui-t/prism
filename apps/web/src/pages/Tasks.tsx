import { useState } from 'react'

import { api, type TaskRow } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

const STATUS_COLORS: Record<string, string> = {
  WAITING: 'var(--muted)',
  BLOCKED: 'var(--warn)',
  RUNNING: 'var(--accent)',
  COMPLETED: 'var(--ok)',
  AWAITING_FEEDBACK: 'var(--warn)',
  REVISION_RUNNING: 'var(--accent)',
  CLOSED: 'var(--ok)',
  FAILED: 'var(--err)',
  BANNED: 'var(--err)',
  LOOP_TERMINATED: 'var(--err)',
  INTERRUPTED: 'var(--warn)',
  CANCELLED: 'var(--muted)',
  SKIPPED: 'var(--muted)',
  COOLDOWN: 'var(--warn)',
}

/**
 * 任务中心：被动台账——执行方回报状态，Prism 只记录与可视化。
 * 依赖图用纯 SVG 渲染（最长依赖路径分层）。
 */
export function TasksPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const tasks = useAsync(() => api.tasks({ status: statusFilter || undefined }), [statusFilter])
  const stats = useAsync(() => api.taskStats(), [])

  return (
    <>
      <h2 className="page-title">任务中心</h2>
      <p className="page-desc">
        被动台账：任务与依赖由执行方回报，Prism 只记录、可视化、审计。
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>台账概览</h3>
          <button
            onClick={() => {
              tasks.reload()
              stats.reload()
            }}
          >
            刷新
          </button>
        </div>
        <State loading={stats.loading} error={stats.error}>
          {stats.data && (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
              <span className="tag">任务 {stats.data.total}</span>
              <span className="tag">DAG {stats.data.dags}</span>
              {Object.entries(stats.data.by_status)
                .sort()
                .map(([status, count]) => (
                  <span
                    key={status}
                    className="tag small"
                    style={{ color: STATUS_COLORS[status] ?? 'var(--muted)' }}
                  >
                    {status} {count}
                  </span>
                ))}
            </div>
          )}
        </State>
      </div>

      <div className="card">
        <div className="row">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">全部状态</option>
            {Object.keys(STATUS_COLORS).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="small muted">
            共 {tasks.data?.length ?? 0} 条
          </span>
        </div>
      </div>

      <State
        loading={tasks.loading}
        error={tasks.error}
        empty={!tasks.loading && !tasks.error && (tasks.data?.length ?? 0) === 0}
        emptyText="暂无任务台账记录（执行方经 prism_task_report 回报后出现）"
      >
        <div className="card">
          <h3>任务列表</h3>
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>任务 ID</th>
                <th>描述</th>
                <th style={{ width: 130 }}>状态</th>
                <th style={{ width: 110 }}>执行者</th>
                <th style={{ width: 150 }}>依赖</th>
              </tr>
            </thead>
            <tbody>
              {tasks.data?.map((t) => (
                <tr key={t.id}>
                  <td className="mono small">{t.id}</td>
                  <td>{t.description}</td>
                  <td>
                    <span
                      className="tag"
                      style={{ color: STATUS_COLORS[t.status] ?? 'var(--muted)' }}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="mono small muted">{t.assigned_agent ?? '—'}</td>
                  <td className="mono small muted">
                    {t.dependencies.length ? t.dependencies.join(', ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {tasks.data && tasks.data.length > 0 && (
          <div className="card">
            <h3>依赖图</h3>
            <DagChart tasks={tasks.data} />
          </div>
        )}
      </State>
    </>
  )
}

/** 最长依赖路径分层 + 贝塞尔边的极简 DAG 渲染。 */
function DagChart({ tasks }: { tasks: TaskRow[] }) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const level = new Map<string, number>()

  const depth = (id: string, seen: Set<string> = new Set()): number => {
    if (level.has(id)) return level.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const t = byId.get(id)
    const deps = t?.dependencies.filter((d) => byId.has(d)) ?? []
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((x) => depth(x, seen))) + 1
    level.set(id, d)
    return d
  }
  for (const t of tasks) depth(t.id)

  const maxLevel = Math.max(0, ...level.values())
  const cols = Array.from({ length: maxLevel + 1 }, (_, i) =>
    tasks.filter((t) => level.get(t.id) === i),
  )

  const NODE_W = 150
  const NODE_H = 40
  const GAP_X = 70
  const GAP_Y = 16
  const PAD = 20
  const maxRows = Math.max(1, ...cols.map((c) => c.length))
  const width = PAD * 2 + (maxLevel + 1) * NODE_W + maxLevel * GAP_X
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y

  const pos = new Map<string, { x: number; y: number }>()
  cols.forEach((col, ci) => {
    col.forEach((t, ri) => {
      pos.set(t.id, {
        x: PAD + ci * (NODE_W + GAP_X),
        y: PAD + ri * (NODE_H + GAP_Y) + (maxRows - col.length) * ((NODE_H + GAP_Y) / 2),
      })
    })
  })

  return (
    <svg className="dag-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="任务依赖图">
      <defs>
        <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
        </marker>
      </defs>
      {tasks.flatMap((t) =>
        t.dependencies
          .filter((d) => pos.has(d) && pos.has(t.id))
          .map((d) => {
            const a = pos.get(d)!
            const b = pos.get(t.id)!
            const x1 = a.x + NODE_W
            const y1 = a.y + NODE_H / 2
            const x2 = b.x - 4
            const y2 = b.y + NODE_H / 2
            const mx = (x1 + x2) / 2
            return (
              <path
                key={`${d}->${t.id}`}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--muted)"
                strokeWidth={1.5}
                markerEnd="url(#dag-arrow)"
              />
            )
          }),
      )}
      {tasks.map((t) => {
        const p = pos.get(t.id)!
        return (
          <g key={t.id}>
            <rect
              x={p.x}
              y={p.y}
              width={NODE_W}
              height={NODE_H}
              rx={7}
              fill="var(--panel)"
              stroke={STATUS_COLORS[t.status] ?? 'var(--border)'}
              strokeWidth={1.5}
            />
            <text
              x={p.x + 10}
              y={p.y + 17}
              fill="var(--text)"
              fontSize={11.5}
              fontFamily="var(--mono)"
            >
              {t.id.length > 18 ? `${t.id.slice(0, 17)}…` : t.id}
            </text>
            <text x={p.x + 10} y={p.y + 31} fill={STATUS_COLORS[t.status] ?? 'var(--muted)'} fontSize={10.5}>
              {t.status}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
