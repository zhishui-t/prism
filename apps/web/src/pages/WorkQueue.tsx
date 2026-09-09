import { api } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

const KIND_LABEL: Record<string, string> = {
  embed: '向量化',
  summarize: '摘要',
  classify: '分类',
  extract_entities: '实体抽取',
  diagram_ir: '图表 IR',
}

function formatAge(ms: number | null): string {
  if (ms === null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}min`
  return `${Math.round(m / 60)}h`
}

/**
 * 工作队列页：Prism 不调 LLM——需要 LLM 的工作落成待办，由宿主拉取执行。
 * 展示队列水位（待办/认领中/已完成/失败 + 最老待办年龄）与待办清单。
 */
export function WorkQueuePage() {
  const stats = useAsync(() => api.workStats(), [])
  const pending = useAsync(() => api.workPending({ limit: 50 }), [])

  const reload = (): void => {
    stats.reload()
    pending.reload()
  }

  return (
    <>
      <h2 className="page-title">工作队列</h2>
      <p className="page-desc">
        Prism <strong>不调 LLM</strong>：需要 LLM 的工作（向量化/摘要/分类/实体抽取/图表 IR）落成待办，
        由宿主 agent 主动拉取执行后回填。拉取式——Prism 不主动唤醒宿主。
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>队列水位</h3>
          <button onClick={reload}>刷新</button>
        </div>
        <State loading={stats.loading} error={stats.error}>
          {stats.data && (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
              <span className="tag">待办 {stats.data.pending}</span>
              <span className="tag">认领中 {stats.data.claimed}</span>
              <span className="tag ok">已完成 {stats.data.completed}</span>
              <span className={`tag ${stats.data.failed > 0 ? 'err' : ''}`}>失败 {stats.data.failed}</span>
              <span className="tag small">最老待办 {formatAge(stats.data.oldest_pending_age_ms)}</span>
            </div>
          )}
        </State>
      </div>

      <div className="card">
        <h3>待办清单</h3>
        <State
          loading={pending.loading}
          error={pending.error}
          empty={!pending.loading && !pending.error && (pending.data?.length ?? 0) === 0}
          emptyText="暂无待办。知识导入后若开启富化，会在此出现需要 LLM 的任务。"
        >
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>优先级</th>
                <th style={{ width: 110 }}>类型</th>
                <th style={{ width: 200 }}>ID</th>
                <th>输入</th>
                <th style={{ width: 170 }}>入队时间</th>
              </tr>
            </thead>
            <tbody>
              {pending.data?.map((w) => (
                <tr key={w.id}>
                  <td className="mono">{w.priority}</td>
                  <td className="small">{KIND_LABEL[w.kind] ?? w.kind}</td>
                  <td className="mono small">{w.id}</td>
                  <td className="mono small muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {JSON.stringify(w.payload)}
                  </td>
                  <td className="small muted">{w.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      <div className="card">
        <h3>宿主接入方式</h3>
        <p className="small muted">宿主 agent 通过 MCP 或 HTTP 拉取并回填：</p>
        <pre
          className="mono small"
          style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, margin: 0, whiteSpace: 'pre-wrap' }}
        >
{`# MCP 工具
prism_work_pending({ kind?, limit? })              → 列出待办
prism_work_claim({ id, claimed_by })               → 认领（签发 attempt token）
prism_work_complete({ id, attempt_token, result }) → 回填（校验后入库）

# HTTP 等价
GET  /api/work/pending
POST /api/work/claim      { id, claimed_by }
POST /api/work/complete   { id, attempt_token, result }
POST /api/work/reclaim    超时回收
GET  /api/work/stats`}
        </pre>
      </div>
    </>
  )
}
