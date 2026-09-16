import { useEffect, useState } from 'react'

import { api } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { EmptyBlock, PageHead, StatusTag } from '../components/ui.tsx'
import { useT } from '../i18n.ts'
import { navigate } from '../route.ts'
import { GraphQueryCard, GraphResultPanel, useGraphQuery } from './GraphQuery.tsx'

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
 *
 * 2026-09-16（v8 F4）：查询区改成**问题导向的四模式**（谁调用它 / 它调用谁 / A→B 调用链 /
 * 改动影响谁），结果按调用关系结构化渲染（方向 + 对端符号 + file:line，点对端可追问）。
 * 原先「自由文本 → graphify 原样输出」的那条路径退役——它正是用户说的「显示一堆咋看」；
 * 状态与动作收在 `./GraphQuery.tsx`，本页只做摆放。邻域图（Studio iframe）与导出不变。
 */
export function CodeGraphPage({ sel }: { sel?: string }) {
  const t = useT()
  const projects = useAsync(() => api.graphProjects(), [])
  const [notice, setNotice] = useState<string>('')
  const [exporting, setExporting] = useState(false)

  /**
   * 选中项目 = hash 的 `sel`（§3.5：项目选择进 hash，可分享 / 可后退），
   * 只有命中台账的名字才是有效选中（脏 hash 不喂给 `graphStatus`）。
   */
  const current =
    sel !== undefined && sel !== '' && projects.data?.some((p) => p.project === sel) ? sel : ''

  /**
   * 未命中回落（design-v7 §2.5）：`sel` 为空或不在台账里 → 选第一个项目并 **`replace` 修正 hash**。
   * 必须 replace：否则「返回」会弹回同一个无效地址，形成死循环。
   */
  useEffect(() => {
    if (projects.data === undefined || projects.data.length === 0) return
    if (projects.data.some((p) => p.project === (sel ?? ''))) return
    navigate({ page: 'graph', sel: projects.data[0]!.project }, { replace: true })
  }, [projects.data, sel])

  // 换项目即清掉提示（查询结果/错误由 `useGraphQuery` 按同一个 `project` 自清）
  useEffect(() => {
    setNotice('')
  }, [current])

  const status = useAsync(() => (current ? api.graphStatus(current) : Promise.resolve(undefined)), [current])

  const project = projects.data?.find((p) => p.project === current)
  const hasGraph = status.data?.graph_exists === true
  const buildCommand = project !== undefined ? `prism graph build "${project.root}" --name ${project.project}` : ''

  /** F4 查询状态（四模式 + 结果）：查询卡与结果面板是两处 DOM，故状态挂页面层。 */
  const query = useGraphQuery(current)

  /** 导出为其他格式（obsidian/wiki/svg/graphml…）——只读变换，保留。 */
  const onExport = async (format: string) => {
    if (!current) return
    setExporting(true)
    setNotice('')
    try {
      const result = await api.graphExport(current, format)
      setNotice(
        t('graph.exported', { format, output: result.output, n: result.files.length }),
      )
    } catch (e) {
      setNotice(t('graph.exportFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setExporting(false)
    }
  }

  // Python 版 graphify 产物是 graph.html（非 npm fork 的 studio/index.html）
  const studioUrl = current ? `/studio/${encodeURIComponent(current)}/graph.html` : ''

  const noProjects = !projects.loading && !projects.error && (projects.data?.length ?? 0) === 0

  return (
    <div className="graph-page">
      {/* §3.5：项目台账是「项目」的唯一权威页（登记 / 根目录 / 扫描历史都在那里） */}
      <PageHead title={t('graph.title')} sub={t('graph.desc')}>
        <button onClick={() => navigate({ page: 'projects' })}>{t('graph.projectsLink')}</button>
      </PageHead>

      <div className="pane">
        {/* B10：项目列表加载中此前页面全空（`projects.loading` 从不参与渲染）——
            首屏至少要有「在拉」的反馈，故选择器整行让位给统一骨架。 */}
        {projects.loading ? (
          <State loading />
        ) : (
          <div className="row">
            <select
              className="grow"
              value={current}
              onChange={(e) => {
                // 项目选择写进 hash（可分享 / 可后退）；清结果交给 `[current]` 的 effect
                if (e.target.value !== '') navigate({ page: 'graph', sel: e.target.value })
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
              /* B15：原为 `<a href><button>`（交互元素嵌套，键盘/读屏行为不确定）。
                 这里锚点直接带按钮外观类 `.btn-link`（与全局 `button` 同源），语义与外观都对。 */
              <a className="btn-link" href={studioUrl} target="_blank" rel="noreferrer">
                {t('graph.openNewWindow')}
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
        )}

        {projects.error && (
          <div className="error" style={{ marginTop: 'var(--s-3)' }}>
            {projects.error}
          </div>
        )}

        {noProjects && <div style={{ marginTop: 'var(--s-3)' }}><EmptyBlock title={t('graph.noProject')} desc={t('graph.noProjectHint')} /></div>}

        {notice !== '' && (
          <div className="small muted swap-in" style={{ marginTop: 'var(--s-2)' }}>
            {notice}
          </div>
        )}

        {current !== '' && status.data !== undefined && (
          <div className="row" style={{ marginTop: 'var(--s-3)' }}>
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
        <div className="pane swap-in">
          <EmptyBlock title={t('graph.noGraph.title')} desc={t('graph.noGraph.desc')} command={buildCommand} />
        </div>
      )}

      {/* F4：查询区 = 四模式（谁调用它 / 它调用谁 / A→B 调用链 / 改动影响谁） */}
      {hasGraph && <GraphQueryCard q={query} />}

      {/*
        查询结果与图谱**左右分栏**：结果面板自己滚动，不参与纵向占位，
        避免结果一出现就把 iframe 挤出视口（DEF-02）。
      */}
      {hasGraph && (
        <div className="pane graph-studio-card">
          <h3>{t('graph.studio')}</h3>
          <div className="studio-split">
            <div className="iframe-wrap">
              <iframe
                title={`studio-${current}`}
                src={studioUrl}
                sandbox="allow-scripts allow-same-origin allow-popups"
              />
            </div>
            {/* F4：结果面板（结构化调用关系；无结果时不出面板，Studio 保持全宽） */}
            <GraphResultPanel q={query} />
          </div>
          <div className="small muted studio-note">{t('graph.studioNote')}</div>
        </div>
      )}
    </div>
  )
}
