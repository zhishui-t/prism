import { useEffect, useState } from 'react'

import { api } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { EmptyBlock, PageHead, StatusTag } from '../components/ui.tsx'
import { useT } from '../i18n.ts'
import { navigate } from '../route.ts'
import { GraphExplore, useExplore } from './GraphExplore.tsx'
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
 * 现在按 `graph_exists` 分支：没有图谱就只给空态 + 建图命令，不渲染图、不给导出入口。
 *
 * 2026-09-16（v8 F4）：查询区改成**问题导向的四模式**（谁调用它 / 它调用谁 / A→B 调用链 /
 * 改动影响谁），结果按调用关系结构化渲染（方向 + 对端符号 + file:line，点对端可追问）。
 * 原先「自由文本 → graphify 原样输出」的那条路径退役——它正是用户说的「显示一堆咋看」；
 * 状态与动作收在 `./GraphQuery.tsx`，本页只做摆放。
 *
 * 2026-09-17（v10 F8）：主区从「Studio iframe + 结果侧栏」改为**两态主区**——
 *   1. **查询**（默认）：查询卡 + 结果面板；**没结果时是初始引导**（进页面即所见，
 *      否则新用户面对一片空白）；
 *   2. **层级探索**（F9ui，`./GraphExplore.tsx`）：社区 → 目录 → 文件逐级下钻。
 *   Studio iframe **移除**，降级为项目选择行里的「打开全图」外链（新标签、noopener）——
 *   iframe 里那份是 graphify 自带的整图 HTML，与主区的可检索/可下钻视图重复占位，且
 *   它会在 happy-dom 缺席时把整页拖到网络错误态。
 *
 * **两处不动**（F9-5 约束）：
 *   - `sel` hash 语义（项目选择 / 分享 / 后退）零改变；
 *   - 两态是**组件内 state**，**不进 hash**。要深链分享探索路径，须同步改 `Shell.tsx` 的
 *     hash 透传与 `navigate({page:'graph',sel})` 的保键接线（超出本轮范围），
 *     后续按「只增不改」加 `explore=` 键——那时仍不得动现有 `sel`。
 */
export function CodeGraphPage({ sel }: { sel?: string }) {
  const t = useT()
  const projects = useAsync(() => api.graphProjects(), [])
  const [notice, setNotice] = useState<string>('')
  const [exporting, setExporting] = useState(false)
  /**
   * 主区两态（F8）。默认「查询」——深链进来也是它（`#/graph/<project>` 只带项目名，
   * 不表达视图），故刷新 / 分享链接 / 后退都落在查询态，行为与改版前一致。
   */
  const [view, setView] = useState<'query' | 'explore'>('query')

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

  /**
   * F4 查询状态（四模式 + 结果）：查询卡与结果面板是两处 DOM，故状态挂页面层。
   * F9ui 探索状态同理挂在页面层——切到查询态再切回来不该把已取回的层丢掉；
   * `active` 保证**只在探索视图可见时才发请求**（不是页面挂载就预取）。
   */
  const query = useGraphQuery(current)
  const explore = useExplore(current, hasGraph && view === 'explore')

  /** 探索里点「文件内符号」：切回查询态并对该**真实节点 id**发起查询（模式由 `pickSymbol` 定为「谁调用它」）。 */
  const pickSymbol = (id: string, label: string): void => {
    setView('query')
    query.pickSymbol(id, label)
  }

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
              /* F8：这一条就是「整图」的**唯一**入口（主区已不嵌 iframe）。
                 B15：原为 `<a href><button>`（交互元素嵌套，键盘/读屏行为不确定）。
                 这里锚点直接带按钮外观类 `.btn-link`（与全局 `button` 同源），语义与外观都对。
                 `noopener` 显式写（不能只靠 `noreferrer` 顺带——两个是不同的保证）。 */
              <a className="btn-link" href={studioUrl} target="_blank" rel="noopener noreferrer">
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

      {/* 没有图谱：只给空态与建图命令，绝不渲染图区（否则会把 404 信封原文画出来） */}
      {current !== '' && status.data !== undefined && !hasGraph && (
        <div className="pane swap-in">
          <EmptyBlock title={t('graph.noGraph.title')} desc={t('graph.noGraph.desc')} command={buildCommand} />
        </div>
      )}

      {/* F4：查询区 = 四模式（谁调用它 / 它调用谁 / A→B 调用链 / 改动影响谁） */}
      {hasGraph && <GraphQueryCard q={query} />}

      {/* F8：主区两态（查询 / 层级探索）。视图切换是**组件内 state**，不进 hash（F9-5）。 */}
      {hasGraph && (
        <div className="pane graph-main">
          <div className="row graph-view-bar">
            <div className="seg" role="group" aria-label={t('graph.view.label')}>
              <button
                type="button"
                className={view === 'query' ? 'active' : ''}
                aria-pressed={view === 'query'}
                onClick={() => setView('query')}
              >
                {t('graph.view.query')}
              </button>
              <button
                type="button"
                className={view === 'explore' ? 'active' : ''}
                aria-pressed={view === 'explore'}
                onClick={() => setView('explore')}
              >
                {t('graph.view.explore')}
              </button>
            </div>
          </div>
          {view === 'query' ? (
            query.result !== undefined ? (
              <GraphResultPanel q={query} />
            ) : query.busy ? (
              /* 在途（含从层级探索点符号过来那一笔）：骨架而不是引导——
                 引导是「还没问」，查询在跑时再摆一遍引导像是什么都没发生。 */
              <div className="graph-loading">
                <State loading />
              </div>
            ) : (
              <GraphGuide />
            )
          ) : (
            <GraphExplore c={explore} onPickSymbol={pickSymbol} />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 初始引导（F8）：没发过查询时主区的内容——静默的空白会被读成「页面坏了」。
 *
 * 讲的是**这张图能回答什么**（四模式 + 逐级探索各一句话），不重复查询卡上已有的控件文案。
 * 数据不出这里：点「层级探索」是唯一的动作（切视图由用户在上一行的分段控件做）。
 */
function GraphGuide() {
  const t = useT()
  return (
    <div className="graph-guide">
      <h3>{t('graph.guide.title')}</h3>
      <p className="small muted">{t('graph.guide.desc')}</p>
      <ul className="graph-guide-list">
        <li>{t('graph.guide.in')}</li>
        <li>{t('graph.guide.out')}</li>
        <li>{t('graph.guide.path')}</li>
        <li>{t('graph.guide.affected')}</li>
        <li>{t('graph.guide.explore')}</li>
      </ul>
    </div>
  )
}
