import { useState } from 'react'

import { api, type TaskRow } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { EmptyBlock, PageHead, Pane, StatCards, StatusTag } from '../components/ui.tsx'
import { t as tr, useT, type DictKey } from '../i18n.ts'

/**
 * 状态 → 颜色 + 界面词条。
 *
 * 2026-09-14 重构：状态原先直接吐 `COMPLETED` / `WAITING` 这种大写枚举，
 * 界面上和中文混在一起（用户反馈「大字英文」）。现在统一用 `StatusTag` + 本地化文案，
 * **枚举原名保留在 title 里**——对照日志 / CLI 输出时仍能一眼认出来。
 */
const STATUS: Record<string, { color: string; key: DictKey; tone: 'ok' | 'warn' | 'err' | 'info' }> = {
  WAITING: { color: 'var(--muted)', key: 'tasks.st.WAITING', tone: 'info' },
  BLOCKED: { color: 'var(--warn)', key: 'tasks.st.BLOCKED', tone: 'warn' },
  RUNNING: { color: 'var(--accent)', key: 'tasks.st.RUNNING', tone: 'info' },
  COMPLETED: { color: 'var(--ok)', key: 'tasks.st.COMPLETED', tone: 'ok' },
  AWAITING_FEEDBACK: { color: 'var(--warn)', key: 'tasks.st.AWAITING_FEEDBACK', tone: 'warn' },
  REVISION_RUNNING: { color: 'var(--accent)', key: 'tasks.st.REVISION_RUNNING', tone: 'info' },
  CLOSED: { color: 'var(--ok)', key: 'tasks.st.CLOSED', tone: 'ok' },
  FAILED: { color: 'var(--err)', key: 'tasks.st.FAILED', tone: 'err' },
  BANNED: { color: 'var(--err)', key: 'tasks.st.BANNED', tone: 'err' },
  LOOP_TERMINATED: { color: 'var(--err)', key: 'tasks.st.LOOP_TERMINATED', tone: 'err' },
  INTERRUPTED: { color: 'var(--warn)', key: 'tasks.st.INTERRUPTED', tone: 'warn' },
  CANCELLED: { color: 'var(--muted)', key: 'tasks.st.CANCELLED', tone: 'info' },
  SKIPPED: { color: 'var(--muted)', key: 'tasks.st.SKIPPED', tone: 'info' },
  COOLDOWN: { color: 'var(--warn)', key: 'tasks.st.COOLDOWN', tone: 'warn' },
}

/** 状态枚举 → 界面文案（未知值原样显示，不隐藏）。 */
function statusLabel(status: string): string {
  const meta = STATUS[status]
  return meta === undefined ? status : tr(meta.key)
}

function statusColor(status: string): string {
  return STATUS[status]?.color ?? 'var(--muted)'
}

/**
 * 任务中心：被动台账——执行方回报状态，Prism 只记录与可视化。
 * 依赖图用纯 SVG 渲染（最长依赖路径分层）。
 */
export function TasksPage() {
  const t = useT()
  const [statusFilter, setStatusFilter] = useState('')
  const tasks = useAsync(() => api.tasks({ status: statusFilter || undefined }), [statusFilter])
  const stats = useAsync(() => api.taskStats(), [])

  return (
    <>
      <PageHead title={t('tasks.title')} sub={t('tasks.desc')}>
        <button
          onClick={() => {
            tasks.reload()
            stats.reload()
          }}
        >
          {t('common.refresh')}
        </button>
      </PageHead>

      <Pane title={t('tasks.ledger')}>
        <State loading={stats.loading} error={stats.error}>
          {stats.data && (
            <>
              <StatCards
                items={[
                  { label: t('tasks.total'), value: stats.data.total },
                  { label: t('tasks.dag'), value: stats.data.dags },
                ]}
              />
              <div className="chips" style={{ marginTop: 10 }}>
                {Object.entries(stats.data.by_status)
                  .sort()
                  .map(([status, count]) => (
                    <StatusTag
                      key={status}
                      kind={STATUS[status]?.tone ?? 'info'}
                      title={status}
                    >
                      {statusLabel(status)} {count}
                    </StatusTag>
                  ))}
              </div>
            </>
          )}
        </State>
      </Pane>

      <Pane>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t('tasks.filterPlaceholder')}</option>
              {Object.keys(STATUS).map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
            <span className="small muted">{t('tasks.count', { n: tasks.data?.length ?? 0 })}</span>
          </div>
          <h3 style={{ margin: 0 }}>{t('tasks.list')}</h3>
        </div>

        <State
          loading={tasks.loading}
          error={tasks.error}
          empty={!tasks.loading && !tasks.error && (tasks.data?.length ?? 0) === 0}
          emptyText={`${t('tasks.empty')} ${t('tasks.emptyHint')}`}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 150 }}>{t('tasks.col.id')}</th>
                  <th>{t('tasks.col.desc')}</th>
                  <th style={{ width: 130 }}>{t('tasks.col.status')}</th>
                  <th style={{ width: 110 }}>{t('tasks.col.executor')}</th>
                  <th style={{ width: 150 }}>{t('tasks.col.deps')}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.data?.map((task) => (
                  <tr key={task.id}>
                    <td className="mono small">{task.id}</td>
                    <td>{task.description}</td>
                    <td>
                      <StatusTag kind={STATUS[task.status]?.tone ?? 'info'} title={task.status}>
                        {statusLabel(task.status)}
                      </StatusTag>
                    </td>
                    <td className="mono small muted">{task.assigned_agent ?? t('tasks.executorNone')}</td>
                    <td className="mono small muted">
                      {task.dependencies.length ? task.dependencies.join(', ') : t('tasks.executorNone')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </Pane>

      {tasks.data && tasks.data.length > 0 && (
        <Pane title={t('tasks.dag.title')}>
          {tasks.data.every((task) => task.dependencies.length === 0) ? (
            <EmptyBlock title={t('tasks.dagEmpty')} />
          ) : (
            <DagChart tasks={tasks.data} />
          )}
        </Pane>
      )}
    </>
  )
}

/** 最长依赖路径分层 + 贝塞尔边的极简 DAG 渲染。 */
function DagChart({ tasks }: { tasks: TaskRow[] }) {
  const t = useT()
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const level = new Map<string, number>()

  const depth = (id: string, seen: Set<string> = new Set()): number => {
    if (level.has(id)) return level.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const task = byId.get(id)
    const deps = task?.dependencies.filter((d) => byId.has(d)) ?? []
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((x) => depth(x, seen))) + 1
    level.set(id, d)
    return d
  }
  for (const task of tasks) depth(task.id)

  const maxLevel = Math.max(0, ...level.values())
  const cols = Array.from({ length: maxLevel + 1 }, (_, i) =>
    tasks.filter((task) => level.get(task.id) === i),
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
    col.forEach((task, ri) => {
      pos.set(task.id, {
        x: PAD + ci * (NODE_W + GAP_X),
        y: PAD + ri * (NODE_H + GAP_Y) + (maxRows - col.length) * ((NODE_H + GAP_Y) / 2),
      })
    })
  })

  return (
    <svg className="dag-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('tasks.dag.title')}>
      <defs>
        <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
        </marker>
      </defs>
      {tasks.flatMap((task) =>
        task.dependencies
          .filter((d) => pos.has(d) && pos.has(task.id))
          .map((d) => {
            const a = pos.get(d)!
            const b = pos.get(task.id)!
            const x1 = a.x + NODE_W
            const y1 = a.y + NODE_H / 2
            const x2 = b.x - 4
            const y2 = b.y + NODE_H / 2
            const mx = (x1 + x2) / 2
            return (
              <path
                key={`${d}->${task.id}`}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--muted)"
                strokeWidth={1.5}
                markerEnd="url(#dag-arrow)"
              />
            )
          }),
      )}
      {tasks.map((task) => {
        const p = pos.get(task.id)!
        return (
          <g key={task.id}>
            <rect
              x={p.x}
              y={p.y}
              width={NODE_W}
              height={NODE_H}
              rx={7}
              fill="var(--panel)"
              stroke={statusColor(task.status)}
              strokeWidth={1.5}
            />
            <text
              x={p.x + 10}
              y={p.y + 17}
              fill="var(--text)"
              fontSize={11.5}
              fontFamily="var(--mono)"
            >
              {task.id.length > 18 ? `${task.id.slice(0, 17)}…` : task.id}
            </text>
            <text x={p.x + 10} y={p.y + 31} fill={statusColor(task.status)} fontSize={10.5}>
              {statusLabel(task.status)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
