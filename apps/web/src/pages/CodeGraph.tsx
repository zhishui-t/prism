import { useEffect, useState } from 'react'

import { api } from '../api.ts'
import { useAsync } from '../components/useAsync.ts'
import { EmptyBlock, PageHead, StatusTag } from '../components/ui.tsx'
import { useT } from '../i18n.ts'

/**
 * 代码图谱页（独立一级页，**只读**）：
 * 能力用 Graphify 工具（vendored Python 子工程）、显示用其自带 HTML、产物落项目根 graphify-out/。
 *
 * 用户裁决（2026-09-10）：**构建/导入不在 Web 触发**——Prism 是控制面，建图与知识导入
 * 是宿主的职责（Prism Skill 指引宿主执行 CLI）。Web 只做查看、查询、状态与导出。
 *
 * 2026-09-14 修：未建图的项目此前会：
 *   1) 被标成「图谱可能已陈旧」（判定依据用错了 `stale`）；
 *   2) 在 Studio 面板里**直接渲染 404 信封原文** `{"ok":false,...}`（用户说的「一串 false」）。
 * 现在按 `graph_exists` 分支：没有图谱就只给空态 + 建图命令，不渲染 iframe、不给导出入口。
 */
export function CodeGraphPage() {
  const t = useT()
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

  const status = useAsync(() => (current ? api.graphStatus(current) : Promise.resolve(undefined)), [current])

  const project = projects.data?.find((p) => p.project === current)
  const hasGraph = status.data?.graph_exists === true
  const buildCommand = project !== undefined ? `prism graph build "${project.root}" --name ${project.project}` : ''

  const onQuery = async () => {
    if (!current || !q.trim()) return
    setBusy(true)
    try {
      const res = await api.graphQuery(current, q.trim())
      setQueryResult(JSON.stringify(res, null, 2))
    } catch (e) {
      setQueryResult(`${t('graph.queryFailed')}：${e instanceof Error ? e.message : String(e)}`)
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
      setNotice(`${t('graph.exported')} ${format} → ${result.output}（${result.files.length} files）`)
    } catch (e) {
      setNotice(`${t('graph.exportFailed')}：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

  // Python 版 graphify 产物是 graph.html（非 npm fork 的 studio/index.html）
  const studioUrl = current ? `/studio/${encodeURIComponent(current)}/graph.html` : ''

  const noProjects = !projects.loading && !projects.error && (projects.data?.length ?? 0) === 0

  return (
    <>
      <PageHead title={t('graph.title')} sub={t('graph.desc')} />

      <div className="card">
        <div className="row">
          <select
            className="grow"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              setQueryResult('')
              setNotice('')
            }}
          >
            <option value="">{t('graph.selectProject')}</option>
            {projects.data?.map((p) => (
              <option key={p.project} value={p.project}>
                {p.project}
              </option>
            ))}
          </select>
          {hasGraph && (
            <a href={studioUrl} target="_blank" rel="noreferrer">
              <button type="button">{t('graph.openNewWindow')}</button>
            </a>
          )}
          {hasGraph && (
            <select
              value=""
              disabled={exporting}
              onChange={(e) => {
                if (e.target.value !== '') void onExport(e.target.value)
              }}
              title={t('graph.export')}
            >
              <option value="">{exporting ? t('graph.exporting') : t('graph.export')}</option>
              <option value="obsidian">Obsidian</option>
              <option value="svg">SVG</option>
              <option value="graphml">GraphML</option>
              <option value="wiki">Wiki Markdown</option>
              <option value="neo4j">Neo4j Cypher</option>
              <option value="falkordb">FalkorDB Cypher</option>
              <option value="callflow-html">Callflow HTML</option>
            </select>
          )}
        </div>

        {projects.error && (
          <div className="error" style={{ marginTop: 12 }}>
            {projects.error}
          </div>
        )}

        {noProjects && <div style={{ marginTop: 12 }}><EmptyBlock title={t('graph.noProject')} desc={t('graph.noProjectHint')} /></div>}

        {notice !== '' && (
          <div className="small muted" style={{ marginTop: 10 }}>
            {notice}
          </div>
        )}

        {current !== '' && status.data !== undefined && (
          <div className="row" style={{ marginTop: 12 }}>
            <StatusTag kind={hasGraph ? (status.data.stale ? 'warn' : 'ok') : 'info'}>
              {hasGraph
                ? status.data.stale
                  ? t('graph.status.stale')
                  : t('graph.status.fresh')
                : t('graph.status.absent')}
            </StatusTag>
            {hasGraph && status.data.stale && (
              <span className="small muted">
                {t('graph.staleHint', { changed: status.data.changed_files, total: status.data.total_files })}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 没有图谱：只给空态与建图命令，绝不渲染 iframe（否则会把 404 信封原文画出来） */}
      {current !== '' && status.data !== undefined && !hasGraph && (
        <div className="card">
          <EmptyBlock title={t('graph.noGraph.title')} desc={t('graph.noGraph.desc')} command={buildCommand} />
        </div>
      )}

      {hasGraph && (
        <div className="card">
          <h3>{t('graph.query')}</h3>
          <div className="row">
            <input
              className="grow"
              placeholder={t('graph.queryPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onQuery()
              }}
            />
            <button onClick={onQuery} disabled={!current || busy || !q.trim()}>
              {t('graph.query')}
            </button>
          </div>
          {queryResult !== '' && (
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
      )}

      {hasGraph && (
        <div className="card">
          <h3>{t('graph.studio')}</h3>
          <div className="iframe-wrap">
            <iframe
              title={`studio-${current}`}
              src={studioUrl}
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            {t('graph.studioNote')}
          </div>
        </div>
      )}
    </>
  )
}
