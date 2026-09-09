import { useState } from 'react'

import { api, type SearchResult } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

const LAYERS = [
  { value: '', label: '全部层' },
  { value: 'global', label: 'global（全局）' },
  { value: 'project', label: 'project（项目）' },
  { value: 'role', label: 'role（专家）' },
]

/** 知识库页：统计 + 结构树 + 检索。 */
export function KnowledgePage() {
  const [q, setQ] = useState('')
  const [layer, setLayer] = useState('')
  const [submitted, setSubmitted] = useState<{ q: string; layer: string } | null>(null)
  const [selected, setSelected] = useState<SearchResult | null>(null)

  const stats = useAsync(() => api.kbStats(), [])
  const tree = useAsync(() => api.kbTree(layer || undefined), [layer])
  const results = useAsync(
    () => (submitted ? api.kbSearch({ q: submitted.q, layers: submitted.layer || undefined }) : Promise.resolve([])),
    [submitted],
  )

  return (
    <>
      <h2 className="page-title">知识库</h2>
      <p className="page-desc">
        分类分层给定位、图谱联系给发现。检索默认只返回每个条目的最新版次。
      </p>

      <div className="card">
        <h3>概览</h3>
        <State loading={stats.loading} error={stats.error}>
          {stats.data && (
            <div className="stat-grid">
              <div className="stat">
                <div className="n">{stats.data.entries}</div>
                <div className="l">条目总数</div>
              </div>
              <div className="stat">
                <div className="n">{stats.data.books}</div>
                <div className="l">书</div>
              </div>
              {Object.entries(stats.data.layers).map(([k, v]) => (
                <div className="stat" key={k}>
                  <div className="n">{v}</div>
                  <div className="l">{k} 层</div>
                </div>
              ))}
            </div>
          )}
        </State>
      </div>

      <div className="card">
        <h3>检索</h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (q.trim()) setSubmitted({ q: q.trim(), layer })
          }}
        >
          <input
            className="grow"
            placeholder="输入关键词（中文两字词如「性能」也可命中）"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={layer} onChange={(e) => setLayer(e.target.value)}>
            {LAYERS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          <button className="primary" type="submit">
            搜索
          </button>
        </form>

        {submitted && (
          <div style={{ marginTop: 14 }}>
            <State
              loading={results.loading}
              error={results.error}
              empty={!results.loading && !results.error && (results.data?.length ?? 0) === 0}
              emptyText={`没有命中「${submitted.q}」的知识条目`}
            >
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 120 }}>ID</th>
                    <th>标题</th>
                    <th style={{ width: 90 }}>类型</th>
                    <th style={{ width: 200 }}>来源</th>
                    <th style={{ width: 70 }}>得分</th>
                  </tr>
                </thead>
                <tbody>
                  {results.data?.map((r) => (
                    <tr key={`${r.id}@${r.version}`}>
                      <td className="mono">
                        <button
                          className="nav-item"
                          style={{ padding: 0, color: 'var(--accent)' }}
                          onClick={() => setSelected(r)}
                        >
                          {r.id}
                        </button>
                      </td>
                      <td>{r.title}</td>
                      <td>
                        <span className="tag">{r.type}</span>
                      </td>
                      <td className="mono small muted">{r.source}</td>
                      <td className="mono small">{r.score.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </State>
          </div>
        )}
      </div>

      <div className="card">
        <h3>结构（层 → 书 → 模块）</h3>
        <State
          loading={tree.loading}
          error={tree.error}
          empty={!tree.loading && !tree.error && (tree.data?.length ?? 0) === 0}
          emptyText="知识库还是空的——用 `prism kb import` 或 MCP `prism_kb_deposit` 落库"
        >
          <table>
            <thead>
              <tr>
                <th style={{ width: 110 }}>层</th>
                <th style={{ width: 200 }}>书</th>
                <th>模块</th>
                <th style={{ width: 70 }}>条目</th>
              </tr>
            </thead>
            <tbody>
              {tree.data?.map((node) => (
                <tr key={`${node.layer}/${node.owner ?? ''}/${node.book}`}>
                  <td>
                    <span className="tag">{node.layer}</span>
                    {node.owner ? <span className="small muted"> / {node.owner}</span> : null}
                  </td>
                  <td className="mono">{node.book}</td>
                  <td className="small muted">
                    {node.modules.length
                      ? node.modules.map((m) => `${m.name || '_inbox'}(${m.count})`).join('、')
                      : '—'}
                  </td>
                  <td className="mono">{node.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      {selected && <EntryDetail result={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

function EntryDetail({ result, onClose }: { result: SearchResult; onClose: () => void }) {
  const detail = useAsync(() => api.kbGet(result.id, result.version), [result.id, result.version])
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>
          条目详情 <span className="mono small muted">{result.source}</span>
        </h3>
        <button onClick={onClose}>关闭</button>
      </div>
      <State loading={detail.loading} error={detail.error}>
        {detail.data && (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="tag">v{detail.data.version}</span>
              <span className="tag">{detail.data.type}</span>
              <span className={`tag${detail.data.status === 'active' ? ' ok' : ' warn'}`}>
                {detail.data.status}
              </span>
              <span className="tag">risk: {detail.data.risk}</span>
              {detail.data.superseded_by && (
                <span className="tag warn">已被 {detail.data.superseded_by} 取代</span>
              )}
            </div>
            <pre
              className="mono"
              style={{
                whiteSpace: 'pre-wrap',
                background: 'var(--panel-2)',
                padding: 12,
                borderRadius: 8,
                margin: 0,
                maxHeight: 340,
                overflow: 'auto',
              }}
            >
              {detail.data.content}
            </pre>
            <div className="small muted" style={{ marginTop: 8 }}>
              文件：<span className="mono">{detail.data.path}</span>
            </div>
          </>
        )}
      </State>
    </div>
  )
}
