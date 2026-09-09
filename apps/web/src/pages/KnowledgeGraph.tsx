import { useEffect, useMemo, useState } from 'react'

import { api, type KbGraphEdge, type KbGraphNode, type KbGraphView } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

const RELATION_COLOR: Record<string, string> = {
  references: '#5b8cff',
  overrides: '#e08a3a',
  supersedes: '#e05555',
  related: '#35c46b',
}

const RELATION_LABEL: Record<string, string> = {
  references: '双链',
  overrides: '覆盖',
  supersedes: '取代',
  related: '关联',
}

const TYPE_COLOR: Record<string, string> = {
  rule: '#e05555',
  doc: '#5b8cff',
  guide: '#35c46b',
  pitfall: '#e0c23a',
  pattern: '#a06bff',
  diagram: '#3ac0c4',
  summary: '#e06ba0',
  other: '#8b93a7',
}

const WIDTH = 900
const HEIGHT = 560
const RADIUS = 210
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 }

/**
 * 知识图谱页：单一边表（双链 references / 层间覆盖 overrides / 版次 supersedes）的多视图。
 * 零依赖确定性布局（环形分层，无随机性）；点击节点下钻邻域，可查两节点最短路径。
 */
export function KnowledgeGraphPage() {
  const [root, setRoot] = useState<string>('')
  const [depth, setDepth] = useState(2)
  const [relationFilter, setRelationFilter] = useState<string>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [pathResult, setPathResult] = useState<string>('')
  const [pathError, setPathError] = useState<string>('')

  const view = useAsync<KbGraphView>(
    () => api.kbGraph({ ...(root ? { id: root } : {}), depth, ...(relationFilter ? { relations: relationFilter } : {}), limit: 200 }),
    [root, depth, relationFilter],
  )

  // 数据变化后若根节点消失，回退到概览
  useEffect(() => {
    if (root && view.data && !view.data.nodes.some((n) => n.id === root)) {
      setRoot('')
    }
  }, [view.data, root])

  const layout = useMemo(() => buildLayout(view.data, root), [view.data, root])

  const onFindPath = async () => {
    setPathError('')
    setPathResult('')
    if (!from.trim() || !to.trim()) {
      setPathError('请填写起点与终点 id')
      return
    }
    try {
      const path = await api.kbPath(from.trim(), to.trim(), relationFilter || undefined)
      setPathResult(path.nodes.join(' → '))
    } catch (e) {
      setPathError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <h2 className="page-title">知识图谱</h2>
      <p className="page-desc">
        全库只有一张关系边表，书级/模块级图谱都是它的过滤视图。边来自正文双链 <code>[[id]]</code> 与
        <code>overrides</code> 声明，确定性抽取、零 LLM。
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <label className="small muted">
              跳数{' '}
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                {[1, 2, 3].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="small muted">
              关系{' '}
              <select value={relationFilter} onChange={(e) => setRelationFilter(e.target.value)}>
                <option value="">全部</option>
                {Object.keys(RELATION_LABEL).map((r) => (
                  <option key={r} value={r}>
                    {RELATION_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            {root && <span className="tag">中心: {root}</span>}
            {view.data?.truncated && <span className="tag warn">已截断</span>}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button onClick={() => setRoot('')} disabled={!root}>
              返回概览
            </button>
            <button onClick={view.reload}>刷新</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>
          图视图
          {view.data && (
            <span className="mono small muted" style={{ marginLeft: 8 }}>
              {view.data.nodes.length} 节点 / {view.data.edges.length} 边
            </span>
          )}
        </h3>
        <State
          loading={view.loading}
          error={view.error}
          empty={!view.loading && !view.error && (view.data?.edges.length ?? 0) === 0}
          emptyText="还没有关系边。在条目正文里写 [[另一个条目的id]] 即可建立双链，或沉淀时声明 overrides。"
        >
          {layout && (
            <>
              <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                style={{ width: '100%', height: 'auto', background: 'var(--panel-2)', borderRadius: 8 }}
                role="img"
                aria-label="知识图谱视图"
              >
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b93a7" />
                  </marker>
                </defs>
                {layout.edges.map((e, i) => {
                  const fromNode = layout.pos.get(e.from_id)
                  const toNode = layout.pos.get(e.to_id)
                  if (!fromNode || !toNode) return null
                  return (
                    <line
                      key={`${e.from_id}-${e.to_id}-${e.relation}-${i}`}
                      x1={fromNode.x}
                      y1={fromNode.y}
                      x2={toNode.x}
                      y2={toNode.y}
                      stroke={RELATION_COLOR[e.relation] ?? '#8b93a7'}
                      strokeWidth={1.6}
                      strokeOpacity={0.7}
                      markerEnd="url(#arrow)"
                    />
                  )
                })}
                {layout.nodes.map((n) => {
                  const p = layout.pos.get(n.id)!
                  const r = 8 + Math.min(n.in_degree + n.out_degree, 6) * 1.6
                  return (
                    <g
                      key={n.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setRoot(n.id)}
                    >
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={r}
                        fill={TYPE_COLOR[n.type] ?? '#8b93a7'}
                        stroke={n.id === root ? '#fff' : 'transparent'}
                        strokeWidth={2}
                      />
                      <text
                        x={p.x}
                        y={p.y - r - 6}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--text)"
                      >
                        {n.title.length > 14 ? `${n.title.slice(0, 14)}…` : n.title}
                      </text>
                    </g>
                  )
                })}
              </svg>
              <div className="row small muted" style={{ marginTop: 8, flexWrap: 'wrap', gap: 12 }}>
                {Object.entries(RELATION_LABEL).map(([key, label]) => (
                  <span key={key}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: RELATION_COLOR[key],
                        marginRight: 4,
                      }}
                    />
                    {label}
                  </span>
                ))}
              </div>
            </>
          )}
        </State>
      </div>

      <div className="card">
        <h3>路径查询</h3>
        <p className="small muted">两节点间最短路径（无向 BFS，尊重上方关系过滤）。</p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="起点 id" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input placeholder="终点 id" value={to} onChange={(e) => setTo(e.target.value)} />
          <button onClick={onFindPath}>查路径</button>
        </div>
        {pathResult && (
          <div className="mono" style={{ marginTop: 10 }}>
            {pathResult}
          </div>
        )}
        {pathError && (
          <div className="error" style={{ marginTop: 10 }}>
            {pathError}
          </div>
        )}
      </div>

      <div className="card">
        <h3>节点明细</h3>
        <State loading={view.loading} error={view.error}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 200 }}>节点</th>
                <th style={{ width: 70 }}>类型</th>
                <th style={{ width: 140 }}>归属</th>
                <th style={{ width: 70 }}>入度</th>
                <th style={{ width: 70 }}>出度</th>
                <th>标题</th>
              </tr>
            </thead>
            <tbody>
              {view.data?.nodes.map((n) => (
                <tr key={n.id}>
                  <td>
                    <button className="nav-item" style={{ padding: 0 }} onClick={() => setRoot(n.id)}>
                      {n.id}
                    </button>
                  </td>
                  <td className="small">{n.type}</td>
                  <td className="small muted">
                    {n.layer}
                    {n.owner ? `/${n.owner}` : ''}/{n.book}
                  </td>
                  <td className="mono">{n.in_degree}</td>
                  <td className="mono">{n.out_degree}</td>
                  <td className="small">{n.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>
    </>
  )
}

interface Layout {
  nodes: KbGraphNode[]
  edges: KbGraphEdge[]
  pos: Map<string, { x: number; y: number }>
}

/**
 * 确定性环形布局：有根时根居中、其余按 BFS 层级同心环分布；
 * 无根时按度降序均匀分布在一圈。无随机数 → 每次渲染位置稳定、可测试。
 */
function buildLayout(view: KbGraphView | undefined, root: string): Layout | null {
  if (!view || view.nodes.length === 0) return null
  const pos = new Map<string, { x: number; y: number }>()

  if (root && view.nodes.some((n) => n.id === root)) {
    const adj = new Map<string, string[]>()
    for (const e of view.edges) {
      if (!adj.has(e.from_id)) adj.set(e.from_id, [])
      if (!adj.has(e.to_id)) adj.set(e.to_id, [])
      adj.get(e.from_id)!.push(e.to_id)
      adj.get(e.to_id)!.push(e.from_id)
    }
    const level = new Map<string, number>([[root, 0]])
    let frontier = [root]
    while (frontier.length > 0) {
      const next: string[] = []
      for (const cur of frontier) {
        for (const nb of adj.get(cur) ?? []) {
          if (!level.has(nb)) {
            level.set(nb, (level.get(cur) ?? 0) + 1)
            next.push(nb)
          }
        }
      }
      frontier = next
    }
    pos.set(root, CENTER)
    const byLevel = new Map<number, string[]>()
    for (const n of view.nodes) {
      if (n.id === root) continue
      const lv = level.get(n.id) ?? 1
      if (!byLevel.has(lv)) byLevel.set(lv, [])
      byLevel.get(lv)!.push(n.id)
    }
    const maxLevel = Math.max(1, ...[...byLevel.keys()])
    for (const [lv, ids] of byLevel) {
      const r = (RADIUS * lv) / maxLevel
      ids.forEach((id, i) => {
        const angle = (2 * Math.PI * i) / ids.length - Math.PI / 2
        pos.set(id, { x: CENTER.x + r * Math.cos(angle), y: CENTER.y + r * Math.sin(angle) })
      })
    }
  } else {
    const sorted = [...view.nodes].sort(
      (a, b) => b.in_degree + b.out_degree - (a.in_degree + a.out_degree) || a.id.localeCompare(b.id),
    )
    sorted.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / sorted.length - Math.PI / 2
      pos.set(n.id, { x: CENTER.x + RADIUS * Math.cos(angle), y: CENTER.y + RADIUS * Math.sin(angle) })
    })
  }
  return { nodes: view.nodes, edges: view.edges, pos }
}
