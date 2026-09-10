import { useEffect, useState } from 'react'

import { api } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

/**
 * 代码图谱页（独立一级页，**只读**）：
 * 能力用 Graphify 工具（vendored Python 子工程）、显示用其自带 HTML、产物落项目根 graphify-out/。
 *
 * 用户裁决（2026-09-10）：**构建/导入不在 Web 触发**——Prism 是控制面，建图与知识导入
 * 是宿主的职责（Prism Skill 指引宿主执行 CLI）。Web 只做查看、查询、状态与导出。
 */
export function CodeGraphPage() {
  const projects = useAsync(() => api.graphProjects(), [])
  const [current, setCurrent] = useState<string>('')
  const [q, setQ] = useState('')
  const [queryResult, setQueryResult] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>('')
  const [exporting, setExporting] = useState(false)

  // 首次加载后自动选中第一个项目
  useEffect(() => {
    if (!current && projects.data && projects.data.length > 0) {
      setCurrent(projects.data[0]!.project)
    }
  }, [projects.data, current])

  const status = useAsync<{ stale: boolean; detail?: string }>(
    () => (current ? api.graphStatus(current) : Promise.resolve({ stale: false })),
    [current],
  )

  const onQuery = async () => {
    if (!current || !q.trim()) return
    setBusy(true)
    try {
      const res = await api.graphQuery(current, q.trim())
      setQueryResult(JSON.stringify(res, null, 2))
    } catch (e) {
      setQueryResult(`查询失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 导出为其他格式（obsidian/wiki/svg/graphml…）——只读变换，保留。 */
  const onExport = async (format: string) => {
    if (!current) return
    setExporting(true)
    setNotice('')
    try {
      const result = await api.graphExport(current, format)
      setNotice(`已导出 ${format} → ${result.output}（${result.files.length} 个文件）`)
    } catch (e) {
      setNotice(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  // Python 版 graphify 产物是 graph.html（非 npm fork 的 studio/index.html）
  const studioUrl = current ? `/studio/${encodeURIComponent(current)}/graph.html` : ''

  return (
    <>
      <h2 className="page-title">代码图谱</h2>
      <p className="page-desc">
        由 Graphify 构建与渲染（AST 解析，代码零 token）；产物落项目根 <span className="mono">graphify-out/</span>。
        本页只读——建图由宿主执行 <span className="mono">prism graph build</span>。
      </p>

      <div className="card">
        <div className="row">
          <select
            className="grow"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              setQueryResult('')
            }}
          >
            <option value="">选择项目…</option>
            {projects.data?.map((p) => (
              <option key={p.project} value={p.project}>
                {p.project}
              </option>
            ))}
          </select>
          {current && (
            <a href={studioUrl} target="_blank" rel="noreferrer">
              <button type="button">新窗口打开图谱</button>
            </a>
          )}
          {current && (
            <select
              value=""
              disabled={exporting}
              onChange={(e) => {
                if (e.target.value !== '') void onExport(e.target.value)
              }}
              title="导出为其他格式"
            >
              <option value="">{exporting ? '导出中…' : '导出…'}</option>
              <option value="obsidian">Obsidian 仓库</option>
              <option value="svg">SVG 矢量图</option>
              <option value="graphml">GraphML</option>
              <option value="wiki">Wiki Markdown</option>
              <option value="neo4j">Neo4j Cypher</option>
              <option value="falkordb">FalkorDB Cypher</option>
              <option value="callflow-html">调用流 HTML</option>
            </select>
          )}
        </div>

        {projects.loading && <div className="empty" style={{ marginTop: 12 }}>加载项目…</div>}
        {projects.error && (
          <div className="error" style={{ marginTop: 12 }}>
            加载项目失败：{projects.error}
          </div>
        )}
        {!projects.loading && !projects.error && (projects.data?.length ?? 0) === 0 && (
          <div className="empty" style={{ marginTop: 12 }}>
            还没有已建图的项目。由宿主执行 <span className="mono">prism graph build &lt;项目路径&gt; --name &lt;项目名&gt;</span> 建图。
          </div>
        )}

        {notice && (
          <div className="small" style={{ marginTop: 10, color: 'var(--muted)' }}>
            {notice}
          </div>
        )}
        {current && status.data && (
          <div className="row" style={{ marginTop: 10 }}>
            <span className={`tag${status.data.stale ? ' warn' : ' ok'}`}>
              {status.data.stale ? '图谱可能已陈旧' : '图谱最新'}
            </span>
            {status.data.detail && <span className="small muted">{status.data.detail}</span>}
          </div>
        )}
      </div>

      <div className="card">
        <h3>图谱查询</h3>
        <div className="row">
          <input
            className="grow"
            placeholder="例如：who calls validateToken?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onQuery()
            }}
          />
          <button onClick={onQuery} disabled={!current || busy || !q.trim()}>
            查询
          </button>
        </div>
        {queryResult && (
          <pre
            className="mono"
            style={{
              whiteSpace: 'pre-wrap',
              background: 'var(--panel-2)',
              padding: 12,
              borderRadius: 8,
              marginTop: 12,
              maxHeight: 300,
              overflow: 'auto',
            }}
          >
            {queryResult}
          </pre>
        )}
      </div>

      <div className="card">
        <h3>Ontology Studio</h3>
        <State
          loading={projects.loading}
          error={projects.error}
          empty={!current}
          emptyText="先选择项目"
        >
          {current && (
            <div className="iframe-wrap">
              <iframe title={`studio-${current}`} src={studioUrl} sandbox="allow-scripts allow-same-origin allow-popups" />
            </div>
          )}
        </State>
        <div className="small muted" style={{ marginTop: 8 }}>
          渲染由 Graphify Studio 提供（Prism 不重画图谱）。
        </div>
      </div>
    </>
  )
}
