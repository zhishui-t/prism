import { useEffect, useMemo, useState } from 'react'

import { api, type ArchDiagram, type CatalogEntry, type KbGraphEdge, type KbGraphNode, type KbGraphView, type SearchResult } from '../api.ts'
import { StarCanvas, seededRandom, useStarfield, type Viewport } from '../components/StarCanvas.tsx'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

/**
 * 知识库 = 图书馆（星图隐喻）
 *
 * **尺度无关（用户裁决 2026-09-08）**：远处看，书柜/书/模块/条目都是同样的光点；
 * 点开就放大一层，露出内部。**层级由数据决定，代码不预设深度**。
 *
 * 实现：不再硬编码「一级/二级/三级」，而是一个有序的 **scope 路径**
 * （`layer → owner → book → module → 条目`）。每个节点点开 = 路径延长一段，
 * 直到没有更细的分组为止。项目规模不同，自然呈现不同深度：
 *   - 简单项目：书 → 条目（两级）
 *   - 微服务项目：项目(书柜) → 服务(书) → 章节 → 条目（多级）
 *
 * 视觉语言：深空背景 + 星点 + 辉光；所有层级的节点都是星体，表现一致。
 */

const WORLD_W = 1200
const WORLD_H = 700

/** 条目类型 → 颜色（与知识图谱页保持同一语义）。 */
const TYPE_COLOR: Record<string, string> = {
  rule: '#ff6b6b',
  doc: '#5b8cff',
  guide: '#35c46b',
  pitfall: '#e0c23a',
  pattern: '#a06bff',
  diagram: '#3ac0c4',
  summary: '#e06ba0',
  other: '#8b93a7',
}

const TYPE_LABEL: Record<string, string> = {
  rule: '规则',
  doc: '文档',
  guide: '指南',
  pitfall: '坑',
  pattern: '模式',
  diagram: '图表',
  summary: '摘要',
  other: '其他',
}

const LAYER_LABEL: Record<string, string> = { global: '全局', project: '项目', role: '专家' }

/**
 * 作用域路径：当前所在的位置。空数组 = 最外层（全部）。
 * 每一段是「按哪个维度分组的哪个值」，顺序固定为 layer → owner → book → module。
 */
type ScopeSegment = { dim: ScopeDim; value: string; label: string }
type ScopeDim = 'layer' | 'owner' | 'book' | 'module'
type Scope = ScopeSegment[]

/** 维度顺序（决定下钻路径）。 */
const DIM_ORDER: ScopeDim[] = ['layer', 'owner', 'book', 'module']

/** 某条目录条目在给定维度上的值。 */
function valueOf(entry: CatalogEntry, dim: ScopeDim): string {
  switch (dim) {
    case 'layer':
      return entry.layer
    case 'owner':
      return entry.owner ?? ''
    case 'book':
      return entry.book
    case 'module':
      return entry.module
  }
}

/** 维度的展示名（面包屑用）。 */
function dimLabel(dim: ScopeDim, value: string): string {
  if (dim === 'layer') return LAYER_LABEL[value] ?? value
  if (dim === 'module') return value === '' ? '待归类' : value
  return value
}

/** 条目是否落在当前 scope 内。 */
function inScope(entry: CatalogEntry, scope: Scope): boolean {
  return scope.every((seg) => valueOf(entry, seg.dim) === seg.value)
}

/** 从 scope 推导「还剩哪些维度」——即下级可以按什么分组。 */
function remainingDims(scope: Scope): ScopeDim[] {
  const used = new Set(scope.map((s) => s.dim))
  return DIM_ORDER.filter((d) => !used.has(d))
}

export function KnowledgePage() {
  // scope 路径（空 = 顶层）。下钻 = 追加一段；返回 = 截断。
  const [scope, setScope] = useState<Scope>([])
  const [selectedId, setSelectedId] = useState<string>('')

  const catalog = useAsync(() => api.kbCatalog({ limit: 1000 }), [])
  const stats = useAsync(() => api.kbStats(), [])
  // 全图边表（条目图谱画关系线用；catalog 本身不带边）
  const graph = useAsync(() => api.kbGraph({ limit: 500 }), [])

  return (
    <div className="library">
      <header className="library-head">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 className="page-title" style={{ marginBottom: 2 }}>
              知识库
            </h2>
            <div className="small muted">
              每个光点都可以点开——近处是书，再近是模块与条目。滚轮缩放，拖拽平移，双击空白返回上一层。
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            {stats.data && (
              <>
                <Stat label="条目" value={stats.data.entries} />
                <Stat label="书" value={stats.data.books} />
                {Object.entries(stats.data.layers)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => (
                    <Stat key={k} label={LAYER_LABEL[k] ?? k} value={v} />
                  ))}
              </>
            )}
          </div>
        </div>

        <Breadcrumb scope={scope} onNavigate={setScope} />
        <SearchBox
          onPick={(entry) => {
            // 命中后直接跳到该条目所在的书/模块，并选中它
            const next: Scope = [
              { dim: 'layer', value: entry.layer, label: LAYER_LABEL[entry.layer] ?? entry.layer },
              ...(entry.owner !== undefined && entry.owner !== ''
                ? [{ dim: 'owner' as const, value: entry.owner, label: entry.owner }]
                : []),
              { dim: 'book', value: entry.book, label: entry.book },
              {
                dim: 'module',
                value: entry.module,
                label: entry.module === '' ? '待归类' : entry.module,
              },
            ]
            setScope(next)
            setSelectedId(entry.id)
          }}
        />
      </header>

      <State loading={catalog.loading} error={catalog.error}>
        {catalog.data && (
          <GalaxyView
            entries={catalog.data}
            allEdges={graph.data?.edges ?? []}
            scope={scope}
            onScopeChange={setScope}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </State>

      {/* 下钻到书/模块后：该层级的知识图谱 + 关联架构图（图谱归属到书内，不再是一级页） */}
      {scope.length > 0 && (
        <ScopePanel scope={scope} entries={catalog.data ?? []} />
      )}

      {/* 层间冲突（B2）：有才显示，避免空面板占位 */}
      <ConflictPanel onSelect={setSelectedId} />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="lib-stat">
      <div className="n">{value}</div>
      <div className="l">{label}</div>
    </div>
  )
}

/** 面包屑 = scope 路径。点任意一段回到那一层；「全部」回到顶层。 */
function Breadcrumb({ scope, onNavigate }: { scope: Scope; onNavigate: (s: Scope) => void }) {
  return (
    <nav className="crumbs">
      <button className={`crumb${scope.length === 0 ? ' active' : ''}`} onClick={() => onNavigate([])}>
        ◎ 全部
      </button>
      {scope.map((seg, i) => (
        <span key={`${seg.dim}:${seg.value}`} className="row" style={{ gap: 0 }}>
          <span className="crumb-sep">›</span>
          <button
            className={`crumb${i === scope.length - 1 ? ' active' : ''}`}
            onClick={() => onNavigate(scope.slice(0, i + 1))}
          >
            {dimLabel(seg.dim, seg.value)}
          </button>
        </span>
      ))}
    </nav>
  )
}

/**
 * 层间冲突面板（B2）：同名跨层且未声明 overrides 的条目对。
 * 只提示不阻断；可逐条标记已处理。
 */
function ConflictPanel({ onSelect }: { onSelect: (id: string) => void }) {
  const conflicts = useAsync(() => api.kbConflicts(), [])
  const [busy, setBusy] = useState('')
  const [hidden, setHidden] = useState(false)

  const list = conflicts.data ?? []
  if (hidden || list.length === 0) return null

  const resolve = async (id: string) => {
    setBusy(id)
    try {
      await api.kbResolveConflict(id)
      conflicts.reload()
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          层间冲突 <span className="small muted">（{list.length}）</span>
        </h3>
        <button onClick={() => setHidden(true)}>收起</button>
      </div>
      <div className="small muted" style={{ margin: '6px 0 10px' }}>
        同名条目跨层共存且高层未声明 <span className="mono">overrides</span>。
        Prism 只记录不阻断——如需以高层为准，请在高层条目里显式声明覆盖，然后标记已处理。
      </div>
      <table>
        <thead>
          <tr>
            <th style={{ width: 130 }}>高层条目</th>
            <th style={{ width: 130 }}>低层条目</th>
            <th style={{ width: 90 }}>类型</th>
            <th style={{ width: 150 }}>发现时间</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.id}>
              <td>
                <button className="rel-link mono small" onClick={() => onSelect(c.high_id)}>
                  {c.high_id}
                </button>
              </td>
              <td>
                <button className="rel-link mono small" onClick={() => onSelect(c.low_id)}>
                  {c.low_id}
                </button>
              </td>
              <td className="small muted">{c.kind}</td>
              <td className="small muted">{c.detected_at.replace('T', ' ').slice(0, 19)}</td>
              <td>
                <button onClick={() => void resolve(c.id)} disabled={busy === c.id}>
                  {busy === c.id ? '处理中…' : '标记已处理'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 检索框（C2）：命中后直接定位到条目的书/模块（跳转 + 选中）。
 * 用「防抖 + 显式回车」避免每次击键都打服务端；无命中给出明确提示（不静默）。
 */
function SearchBox({ onPick }: { onPick: (entry: SearchResult) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(false)

  const run = async () => {
    const query = q.trim()
    if (query === '') {
      setResults(null)
      return
    }
    setLoading(true)
    try {
      setResults(await api.kbSearch({ q: query, limit: 8 }))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8 }}>
        <input
          type="search"
          placeholder="检索知识（回车）…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
          style={{ flex: 1, maxWidth: 420 }}
        />
        <button onClick={() => void run()} disabled={loading}>
          {loading ? '检索中…' : '检索'}
        </button>
        {results !== null && (
          <button
            onClick={() => {
              setQ('')
              setResults(null)
            }}
          >
            清除
          </button>
        )}
      </div>
      {results !== null && (
        <div style={{ marginTop: 8 }}>
          {results.length === 0 ? (
            <div className="small muted">知识库没有匹配「{q}」的条目</div>
          ) : (
            <ul className="rel-list">
              {results.map((r) => (
                <li key={`${r.id}@${r.version}`} className="small">
                  <button className="rel-link" onClick={() => onPick(r)} title={r.source}>
                    {r.title}
                  </button>{' '}
                  <span className="mono muted small">{r.source}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** 各级共用同一套星体渲染（数据由 scope 决定，渲染逻辑完全一致）。 */
function GalaxyView({
  entries,
  allEdges,
  scope,
  onScopeChange,
  selectedId,
  onSelect,
}: {
  entries: CatalogEntry[]
  allEdges: KbGraphEdge[]
  scope: Scope
  onScopeChange: (s: Scope) => void
  selectedId: string
  onSelect: (id: string) => void
}) {
  // 按 scope 切出当前要展示的星体集合
  const { bodies, edges, backTarget, hub } = useMemo(
    () => buildBodies(entries, allEdges, scope),
    [entries, allEdges, scope],
  )
  const stars = useStarfield(220, WORLD_W, WORLD_H)
  const [vp, setVp] = useState<Viewport>({ k: 1, x: 0, y: 0 })

  return (
    <div className="star-wrap">
      <div className="star-hint mono small">
        缩放 {Math.round(vp.k * 100)}% · {bodies.length} 个光点
        {backTarget !== null && <span> · 双击空白返回上一层</span>}
      </div>
      <StarCanvas
        width={WORLD_W}
        height={WORLD_H}
        onViewportChange={setVp}
        onBackgroundClick={() => {
          if (backTarget !== null) onScopeChange(backTarget)
          else onSelect('')
        }}
      >
        {() => (
          <>
            {/* 深空星点 */}
            <g opacity={0.9}>
              {stars.map((s, i) => (
                <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#fff" opacity={s.o} />
              ))}
            </g>

            {/* 顶层：图书馆本体星云；下钻后：当前位置作为中心星云 */}
            {scope.length === 0 && <LibraryNebula />}
            {hub !== null && <HubNebula hub={hub} />}

            {/* 关系边（仅条目层有） */}
            {edges.map((e) => {
              const a = bodies.find((b) => b.id === e.from_id)
              const b = bodies.find((b) => b.id === e.to_id)
              if (a === undefined || b === undefined) return null
              return (
                <line
                  key={`${e.from_id}-${e.to_id}-${e.relation}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#5b8cff"
                  strokeWidth={1.4}
                  strokeOpacity={0.45}
                />
              )
            })}

            {/* 星体（所有层级表现一致） */}
            {bodies.map((body) => (
              <StarBody
                key={body.id}
                body={body}
                selected={selectedId === body.id}
                onClick={() => {
                  if (body.drill !== undefined) onScopeChange(body.drill)
                  else onSelect(body.id === selectedId ? '' : body.id)
                }}
              />
            ))}
          </>
        )}
      </StarCanvas>

      {selectedId !== '' && <EntryPanel id={selectedId} onClose={() => onSelect('')} onSelect={onSelect} />}
    </div>
  )
}

interface Body {
  id: string
  label: string
  sublabel?: string
  x: number
  y: number
  r: number
  color: string
  count: number
  /** 点击后下钻的 scope（叶子节点没有） */
  drill?: Scope
}

/**
 * 图书馆本体：一团巨大的星云（走进图书馆的第一眼）。
 * 中心辉光 + 多层半透明环 + 旋臂点尘，各「书」的星系在其内部环绕。
 * 纯装饰、不拦截事件（pointer-events: none）。
 */
function LibraryNebula() {
  const dust = useMemo(() => {
    const rand = seededRandom(77123)
    return Array.from({ length: 160 }, () => {
      const angle = rand() * Math.PI * 2
      // 旋臂形态：半径越小越密
      const radius = Math.pow(rand(), 0.62) * 520
      const jitter = (rand() - 0.5) * 90
      return {
        x: Math.cos(angle) * radius + jitter,
        y: Math.sin(angle) * radius * 0.62 + jitter * 0.5,
        r: 0.5 + rand() * 1.6,
        o: 0.12 + rand() * 0.5,
      }
    })
  }, [])
  return (
    <g style={{ pointerEvents: 'none' }}>
      <defs>
        <radialGradient id="lib-core">
          <stop offset="0%" stopColor="#8fb3ff" stopOpacity={0.34} />
          <stop offset="35%" stopColor="#5b8cff" stopOpacity={0.16} />
          <stop offset="70%" stopColor="#3a2a7a" stopOpacity={0.09} />
          <stop offset="100%" stopColor="#0a0c11" stopOpacity={0} />
        </radialGradient>
        <radialGradient id="lib-halo">
          <stop offset="0%" stopColor="#a06bff" stopOpacity={0.2} />
          <stop offset="60%" stopColor="#5b8cff" stopOpacity={0.07} />
          <stop offset="100%" stopColor="#0a0c11" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* 外晕 */}
      <ellipse cx={0} cy={0} rx={640} ry={430} fill="url(#lib-halo)" />
      {/* 核心 */}
      <ellipse cx={0} cy={0} rx={430} ry={290} fill="url(#lib-core)" />
      {/* 内层环（星云层次感） */}
      <ellipse cx={0} cy={0} rx={300} ry={200} fill="#5b8cff" opacity={0.05} />
      <ellipse cx={0} cy={0} rx={180} ry={120} fill="#8fb3ff" opacity={0.07} />
      {/* 旋臂点尘 */}
      {dust.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#cfe0ff" opacity={d.o} />
      ))}
      {/* 星云中心不写字（用户要求不显示「图书馆」）；书数量见左上角提示条 */}
    </g>
  )
}

/**
 * 把目录条目折叠成当前层级的星系。
 * 位置用**确定性环形布局**（无随机，每次渲染稳定）。
 */
/** 当前层级的中心（书 / 模块）：画成星云中心，下级围绕它环绕。 */
interface Hub {
  label: string
  sublabel: string
  /** 该中心包含的条目数 */
  count: number
}

/**
 * 递归分组：把当前 scope 内的条目，按**下一个可用维度**折叠成星体。
 *
 * 关键设计（尺度无关）：不硬编码深度。规则只有一条——
 * 若 scope 内还存在「取值多于一个」的维度，就按它分组（每个值一个星体，点开继续深入）；
 * 否则这些条目本身就是叶子（直接显示为条目星体）。
 *
 * 单值维度自动跳过：某维度只有一个取值时，分组只会产生一个星体，
 * 再点进去还是自己——所以直接跳过，避免「点了个寂寞」。
 */
function buildBodies(
  entries: CatalogEntry[],
  allEdges: KbGraphEdge[],
  scope: Scope,
): { bodies: Body[]; edges: KbGraphEdge[]; backTarget: Scope | null; hub: Hub | null } {
  const backTarget: Scope | null = scope.length === 0 ? null : scope.slice(0, -1)
  const scoped = entries.filter((e) => inScope(e, scope))
  const current = scope[scope.length - 1]

  // 找下一个「有区分度」的维度：候选维度中，取值多于一个的第一个
  const candidates = remainingDims(scope)
  let splitDim: ScopeDim | null = null
  for (const dim of candidates) {
    const values = new Set(scoped.map((e) => valueOf(e, dim)))
    if (values.size > 1) {
      splitDim = dim
      break
    }
  }

  // 叶子层：没有可再分的维度 → 每个条目一个星体（带关系边）
  if (splitDim === null) {
    const ids = new Set(scoped.map((e) => e.id))
    const bodies = ringLayout(
      [...scoped]
        .sort((a, b) => b.in_degree + b.out_degree - (a.in_degree + a.out_degree) || a.id.localeCompare(b.id))
        .map((e) => ({
          id: e.id,
          label: e.title,
          sublabel: `${TYPE_LABEL[e.type] ?? e.type} · 入${e.in_degree}/出${e.out_degree}`,
          count: 1,
          color: TYPE_COLOR[e.type] ?? '#8b93a7',
        })),
      Math.max(3, scoped.length),
    )
    const edges = allEdges.filter((e) => ids.has(e.from_id) && ids.has(e.to_id))
    return { bodies, edges, backTarget, hub: hubOf(current, scoped.length) }
  }

  // 分组层：按 splitDim 折叠
  const groups = new Map<string, { count: number }>()
  for (const e of scoped) {
    const key = valueOf(e, splitDim)
    const g = groups.get(key)
    if (g === undefined) groups.set(key, { count: 1 })
    else g.count++
  }
  const list = [...groups.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
  const bodies = ringLayout(
    list.map(([value, g], i) => ({
      id: `${scope.map((s) => s.value).join('/')}/${value}`,
      label: dimLabel(splitDim!, value),
      sublabel: `${g.count} 条`,
      count: g.count,
      color: paletteAt(i),
      drill: [...scope, { dim: splitDim!, value, label: dimLabel(splitDim!, value) }],
    })),
    Math.max(3, list.length),
  )
  return { bodies, edges: [], backTarget, hub: hubOf(current, scoped.length) }
}

/** 当前位置的中心星云信息（顶层没有中心）。 */
function hubOf(current: ScopeSegment | undefined, count: number): Hub | null {
  if (current === undefined) return null
  return { label: current.label, sublabel: `${count} 条`, count }
}

/**
 * 标签折行：最多两行完整显示。
 * 中文按字符数切，英文优先在空格/连字符处断；仍放不下才截断加省略号。
 */
function wrapLabel(label: string, maxChars = 14): string[] {
  if (label.length <= maxChars) return [label]
  // 优先找空格或连字符
  const breakAt = (from: number): number => {
    for (let i = Math.min(from + maxChars, label.length); i > from; i--) {
      const c = label[i - 1]
      if (c === ' ' || c === '-' || c === '_' || c === '/') return i
    }
    return Math.min(from + maxChars, label.length)
  }
  const first = label.slice(0, breakAt(0)).trimEnd()
  const rest = label.slice(first.length).trimStart()
  if (rest.length <= maxChars) return [first, rest]
  return [first, `${rest.slice(0, maxChars - 1)}…`]
}

/** 当前层级中心星云：把「书 / 模块」画成中心，下级在内部环绕（保留层级感）。 */
function HubNebula({ hub }: { hub: Hub }) {
  const dust = useMemo(() => {
    const rand = seededRandom(9911)
    return Array.from({ length: 90 }, () => {
      const angle = rand() * Math.PI * 2
      const radius = Math.pow(rand(), 0.6) * 340
      return {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * 0.68,
        r: 0.5 + rand() * 1.4,
        o: 0.1 + rand() * 0.42,
      }
    })
  }, [])
  return (
    <g style={{ pointerEvents: 'none' }}>
      <defs>
        <radialGradient id="hub-core">
          <stop offset="0%" stopColor="#8fb3ff" stopOpacity={0.26} />
          <stop offset="45%" stopColor="#5b8cff" stopOpacity={0.12} />
          <stop offset="100%" stopColor="#0a0c11" stopOpacity={0} />
        </radialGradient>
      </defs>
      <ellipse cx={0} cy={0} rx={430} ry={290} fill="url(#hub-core)" />
      <ellipse cx={0} cy={0} rx={240} ry={162} fill="#5b8cff" opacity={0.055} />
      {dust.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#cfe0ff" opacity={d.o} />
      ))}
      {/* 中心标识：书/模块名放在星云顶部，避开内部星体（曾经挤在正中会被星体压住） */}
      <text x={0} y={-WORLD_H / 2 + 62} textAnchor="middle" fontSize={17} fill="#dbe6ff" opacity={0.94}>
        {hub.label}
      </text>
      <text x={0} y={-WORLD_H / 2 + 82} textAnchor="middle" fontSize={11} fill="#8b93a7" opacity={0.9}>
        {hub.sublabel}
      </text>
      <line
        x1={-60}
        y1={-WORLD_H / 2 + 94}
        x2={60}
        y2={-WORLD_H / 2 + 94}
        stroke="#5b8cff"
        strokeOpacity={0.35}
        strokeWidth={1}
      />
    </g>
  )
}

/** 星系色板（按排序后位置分配，保证同层不撞色且稳定）。 */
const BOOK_PALETTE = ['#5b8cff', '#35c46b', '#e0c23a', '#a06bff', '#3ac0c4', '#e06ba0', '#ff6b6b', '#e08a3a', '#7c8cff', '#4fd1c5']
function paletteAt(index: number): string {
  return BOOK_PALETTE[index % BOOK_PALETTE.length]!
}

/**
 * 确定性环形布局：按数量分环，**自适应铺满视野**（避免小数据时挤在中心一小团）。
 * - 单环（n ≤ 8）：等角分布，半径按数量微调；
 * - 多环（n > 8）：内外两环错开，外环半径随数量增大。
 * 星系半径随 count 开方增长（条目越多越亮越大），并保证标签有空间。
 */
function ringLayout(
  items: Array<{ id: string; label: string; sublabel?: string; count: number; color: string; drill?: Scope }>,
  _slots: number,
): Body[] {
  const n = items.length
  if (n === 0) return []
  // 可用半径：世界的一半再留出标签边距
  const maxR = Math.min(WORLD_W, WORLD_H) / 2 - 110
  const bodies: Body[] = []
  const starR = (count: number): number => 18 + Math.min(38, Math.sqrt(count) * 12)

  if (n === 1) {
    bodies.push(bodyOf(items[0]!, 0, 0, starR(items[0]!.count)))
    return bodies
  }

  if (n <= 8) {
    // 环绕半径：收在中心星云内（星云 rx=430），且避开中心文字区域
    const radius = maxR * 0.66
    if (n === 2) {
      // 两个星系水平并排，间距取可用半径的 0.78（再远会超出星云视觉范围）
      bodies.push(bodyOf(items[0]!, -radius * 0.78, 0, starR(items[0]!.count)))
      bodies.push(bodyOf(items[1]!, radius * 0.78, 0, starR(items[1]!.count)))
      return bodies
    }
    // 单环：起始角 -90°（顶部）顺时针；椭圆压扁贴合星云形状
    const squash = n === 3 ? 0.9 : 0.76
    items.forEach((it, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2
      bodies.push(
        bodyOf(it, Math.cos(angle) * radius, Math.sin(angle) * radius * squash, starR(it.count)),
      )
    })
    return bodies
  }

  // 多环：内环 ceil(n/3)，其余外环
  const innerCount = Math.ceil(n / 3)
  const outer = items.slice(innerCount)
  items.slice(0, innerCount).forEach((it, i) => {
    const angle = (2 * Math.PI * i) / innerCount - Math.PI / 2
    const radius = maxR * 0.42
    bodies.push(bodyOf(it, Math.cos(angle) * radius, Math.sin(angle) * radius, starR(it.count)))
  })
  outer.forEach((it, i) => {
    const angle = (2 * Math.PI * i) / Math.max(1, outer.length) - Math.PI / 2 + Math.PI / Math.max(1, outer.length) / 2
    const radius = maxR * 0.92
    bodies.push(bodyOf(it, Math.cos(angle) * radius, Math.sin(angle) * radius, starR(it.count)))
  })
  return bodies
}

/** 组装一个星系。 */
function bodyOf(
  it: { id: string; label: string; sublabel?: string; count: number; color: string; drill?: Scope },
  x: number,
  y: number,
  r: number,
): Body {
  return {
    id: it.id,
    label: it.label,
    ...(it.sublabel !== undefined ? { sublabel: it.sublabel } : {}),
    x,
    y,
    r,
    color: it.color,
    count: it.count,
    ...(it.drill !== undefined ? { drill: it.drill } : {}),
  }
}

/** 星系：辉光 + 核心 + 标签。 */
function StarBody({ body, selected, onClick }: { body: Body; selected: boolean; onClick: () => void }) {
  return (
    <g
      className="star-body"
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {/* 辉光 */}
      <circle cx={body.x} cy={body.y} r={body.r * 2.1} fill={body.color} opacity={selected ? 0.28 : 0.14} />
      <circle cx={body.x} cy={body.y} r={body.r * 1.35} fill={body.color} opacity={0.22} />
      {/* 核心 */}
      <circle
        cx={body.x}
        cy={body.y}
        r={body.r}
        fill={body.color}
        stroke={selected ? '#fff' : 'transparent'}
        strokeWidth={2}
      />
      {/* 标签：放在辉光之外（否则被光晕糊住），最多两行完整显示，字号随长度自适应 */}
      {wrapLabel(body.label).map((line, li) => (
        <text
          key={li}
          x={body.x}
          y={body.y + body.r * 1.55 + 16 + li * 16}
          textAnchor="middle"
          fontSize={body.label.length > 14 ? 12 : 13.5}
          fill="#eef1f7"
          stroke="#0a0c11"
          strokeWidth={3.5}
          paintOrder="stroke"
          style={{ pointerEvents: 'none' }}
        >
          {line}
        </text>
      ))}
      {body.sublabel !== undefined && (
        <text
          x={body.x}
          y={body.y + body.r * 1.55 + 16 + wrapLabel(body.label).length * 16}
          textAnchor="middle"
          fontSize={10.5}
          fill="#9aa3b5"
          stroke="#0a0c11"
          strokeWidth={3}
          paintOrder="stroke"
          style={{ pointerEvents: 'none' }}
        >
          {body.sublabel}
        </text>
      )}
    </g>
  )
}

/** 关系去重：无向边在邻域查询里会双向出现，按 (方向, 对端, 关系) 折叠。 */
function dedupeRelations(
  edges: KbGraphEdge[],
  selfId: string,
): Array<{ dir: '→' | '←'; other: string; relation: string }> {
  const seen = new Set<string>()
  const out: Array<{ dir: '→' | '←'; other: string; relation: string }> = []
  for (const e of edges) {
    if (e.from_id !== selfId && e.to_id !== selfId) continue
    const dir: '→' | '←' = e.from_id === selfId ? '→' : '←'
    const other = e.from_id === selfId ? e.to_id : e.from_id
    const key = `${dir}|${other}|${e.relation}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ dir, other, relation: e.relation })
  }
  return out
}

/**
 * 当前位置的详情：知识图谱 + 关联架构图。
 *
 * 用户裁决（2026-09-10）：知识图谱、架构图谱**属于书内部**，不再是一级菜单。
 * 按当前 scope 过滤图谱与产物（scope 里有什么维度就传什么维度）。
 */
function ScopePanel({
  scope,
  entries,
}: {
  scope: Scope
  entries: CatalogEntry[]
}) {
  const [tab, setTab] = useState<'graph' | 'arch' | 'entries'>('graph')
  const [preview, setPreview] = useState<ArchDiagram | undefined>(undefined)
  // 架构图面板的子标签：预览 | IR | 元数据（knowledge-base.md §384）
  const [archTab, setArchTab] = useState<'preview' | 'ir' | 'meta'>('preview')

  const scopeLabel = scope.map((s) => s.label).join(' / ')
  // scope → 服务端过滤参数（只传 scope 里出现过的维度）
  const scopeParams = useMemo(() => {
    const out: { layer?: string; owner?: string; book?: string; module?: string } = {}
    for (const seg of scope) {
      if (seg.dim === 'layer') out.layer = seg.value
      else if (seg.dim === 'owner') out.owner = seg.value
      else if (seg.dim === 'book') out.book = seg.value
      else out.module = seg.value
    }
    return out
  }, [scope])
  const scopeKey = scope.map((s) => `${s.dim}:${s.value}`).join('|')

  // 该层级的知识图谱（服务端按 scope 过滤）
  const view = useAsync(
    () => api.kbGraph({ ...scopeParams, depth: 2, limit: 200 }),
    [scopeKey],
  )

  // 该层级的条目（diagram 类型用于「架构图」标签）
  const scoped = entries.filter((e) => inScope(e, scope))
  const diagrams = scoped.filter((e) => e.type === 'diagram')
  // 产物按当前作用域过滤（book/module 有则传）
  const archAssets = useAsync(
    () =>
      api.archDiagrams({
        ...(scopeParams.book !== undefined ? { book: scopeParams.book } : {}),
        ...(scopeParams.module !== undefined ? { module: scopeParams.module } : {}),
      }),
    [scopeKey],
  )
  // 自动选中最新产物，免去用户多点一次
  useEffect(() => {
    if (preview === undefined && archAssets.data !== undefined && archAssets.data.length > 0) {
      setPreview(archAssets.data[0])
    }
  }, [archAssets.data, preview])

  const previewUrl =
    preview === undefined
      ? ''
      : `/api/arch/preview/${preview.type}/${encodeURIComponent(preview.name)}`

  return (
    <div className="card scope-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          当前位置 <span className="mono small muted">{scopeLabel}</span>
        </h3>
        <div className="row" style={{ gap: 6 }}>
          <button className={tab === 'graph' ? 'primary' : ''} onClick={() => setTab('graph')}>
            知识图谱
          </button>
          <button className={tab === 'arch' ? 'primary' : ''} onClick={() => setTab('arch')}>
            架构图
          </button>
          <button className={tab === 'entries' ? 'primary' : ''} onClick={() => setTab('entries')}>
            条目（{scoped.length}）
          </button>
        </div>
      </div>

      {tab === 'graph' && (
        <div style={{ marginTop: 12 }}>
          <State loading={view.loading} error={view.error}>
            {view.data && <MiniGraph view={view.data} />}
          </State>
        </div>
      )}

      {tab === 'arch' && (
        <div style={{ marginTop: 12 }}>
          {/* 该层级的 diagram 条目：点击即选中对应产物 */}
          <div className="small muted" style={{ marginBottom: 6 }}>
            diagram 条目（{diagrams.length}）
          </div>
          {diagrams.length === 0 ? (
            <div className="empty">
              当前位置还没有 <span className="mono">type: diagram</span> 条目。
              <div className="small muted" style={{ marginTop: 6 }}>
                用{' '}
                <span className="mono">
                  prism arch render &lt;type&gt; &lt;ir.json&gt;
                  {scopeParams.book !== undefined ? ` --book ${scopeParams.book}` : ''}
                  {scopeParams.module !== undefined ? ` --module ${scopeParams.module}` : ''}
                </span>{' '}
                渲染后，产物会自动归到这里。
              </div>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>条目</th>
                  <th>标题</th>
                  <th style={{ width: 100 }}>标签</th>
                </tr>
              </thead>
              <tbody>
                {diagrams.map((d) => (
                  <tr key={d.id}>
                    <td className="mono small">{d.id}</td>
                    <td>{d.title}</td>
                    <td className="small muted">{d.tags.slice(0, 2).join(' ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* 已渲染产物（Archify）：按当前书/模块过滤 */}
          <div className="small muted" style={{ margin: '14px 0 6px' }}>
            已渲染产物（Archify）· 归属本书 {archAssets.data?.length ?? 0} 个
          </div>
          <State loading={archAssets.loading} error={archAssets.error}>
            {(archAssets.data?.length ?? 0) === 0 ? (
              <div className="small muted">
                （这里还没有渲染产物。加 <span className="mono">--book {scopeParams.book ?? '<书>'}</span> 渲染即可归到此处）
              </div>
            ) : (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {archAssets.data?.map((d) => (
                  <button
                    key={`${d.type}/${d.name}`}
                    className={preview !== undefined && preview.type === d.type && preview.name === d.name ? 'primary' : ''}
                    onClick={() => {
                      setPreview(d)
                      setArchTab('preview')
                    }}
                    title={d.title ?? d.name}
                  >
                    {TYPE_LABEL_DIAGRAM[d.type] ?? d.type} · {d.title ?? d.name}
                  </button>
                ))}
              </div>
            )}
          </State>

          {preview !== undefined && (
            <div style={{ marginTop: 12 }}>
              {/* 子标签：预览 | IR | 元数据（knowledge-base.md §384） */}
              <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                {(['preview', 'ir', 'meta'] as const).map((t) => (
                  <button key={t} className={archTab === t ? 'primary' : ''} onClick={() => setArchTab(t)}>
                    {t === 'preview' ? '预览' : t === 'ir' ? 'IR' : '元数据'}
                  </button>
                ))}
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="small"
                  style={{ marginLeft: 'auto', alignSelf: 'center' }}
                >
                  新窗口打开 ↗
                </a>
              </div>

              {archTab === 'preview' && (
                <div className="iframe-wrap">
                  <iframe title={`架构图 ${preview.name}`} src={previewUrl} />
                </div>
              )}
              {archTab === 'ir' && <ArchIrView type={preview.type} name={preview.name} mode="ir" />}
              {archTab === 'meta' && <ArchIrView type={preview.type} name={preview.name} mode="meta" />}
            </div>
          )}
        </div>
      )}

      {tab === 'entries' && (
        <div style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>条目</th>
                <th>标题</th>
                <th style={{ width: 90 }}>类型</th>
                <th style={{ width: 150 }}>模块</th>
              </tr>
            </thead>
            <tbody>
              {scoped.map((e) => (
                <tr key={e.id}>
                  <td className="mono small">{e.id}</td>
                  <td>{e.title}</td>
                  <td>
                    <span className="tag" style={{ color: TYPE_COLOR[e.type] }}>
                      {TYPE_LABEL[e.type] ?? e.type}
                    </span>
                  </td>
                  <td className="small muted">{e.module === '' ? '_inbox' : e.module}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** 五类图的界面标签（产物按钮用）。 */
const TYPE_LABEL_DIAGRAM: Record<string, string> = {
  architecture: '架构图',
  sequence: '时序图',
  lifecycle: '生命周期图',
  dataflow: '数据流图',
  workflow: '工作流图',
}

/** 产物的 IR 源 / 元数据视图（IR 是源、HTML 是派生，两者都在这里可查）。 */
function ArchIrView({ type, name, mode }: { type: string; name: string; mode: 'ir' | 'meta' }) {
  const data = useAsync(() => api.archIr(type, name), [type, name])
  return (
    <State loading={data.loading} error={data.error}>
      {data.data && mode === 'ir' ? (
        data.data.ir === null ? (
          <div className="empty small">该产物没有 IR 源文件（可能是早期渲染的）</div>
        ) : (
          <pre className="entry-body mono small" style={{ maxHeight: 480, overflow: 'auto' }}>
            {JSON.stringify(data.data.ir, null, 2)}
          </pre>
        )
      ) : null}
      {data.data && mode === 'meta' ? (
        data.data.meta === null ? (
          <div className="empty small">该产物没有元数据（早期渲染的产物没有 sidecar）</div>
        ) : (
          <table>
            <tbody>
              {[
                ['类型', TYPE_LABEL_DIAGRAM[data.data.meta.type] ?? data.data.meta.type],
                ['文件', data.data.meta.name],
                ['标题', data.data.meta.title ?? '—'],
                ['归属', data.data.meta.book ?? '（未归属）'],
                ['模块', data.data.meta.module ?? '—'],
                ['Archify 版本', data.data.meta.archify_version],
                ['IR 哈希', data.data.meta.ir_hash],
                ['渲染时间', data.data.meta.created_at.replace('T', ' ').slice(0, 19)],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td className="small muted" style={{ width: 120 }}>
                    {k}
                  </td>
                  <td className="mono small">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </State>
  )
}

/** 书/模块内的紧凑图谱：SVG 力导向近似（环形 + 连线），不占满屏。 */
function MiniGraph({ view }: { view: KbGraphView }) {
  if (view.nodes.length === 0) {
    return <div className="empty">该范围内还没有关系边（条目可能都是孤立的）</div>
  }
  const W = 640
  const H = 320
  const cx = W / 2
  const cy = H / 2
  const R = Math.min(W, H) / 2 - 46
  const pos = new Map<string, { x: number; y: number }>()
  view.nodes.forEach((n) => {
    if (n.id === view.root) {
      pos.set(n.id, { x: cx, y: cy })
      return
    }
    const others = view.nodes.filter((x) => x.id !== view.root)
    const idx = others.findIndex((x) => x.id === n.id)
    const angle = (2 * Math.PI * idx) / Math.max(1, others.length) - Math.PI / 2
    pos.set(n.id, { x: cx + Math.cos(angle) * R, y: cy + Math.sin(angle) * R })
  })
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mini-graph" role="img" aria-label="范围内知识图谱">
      <defs>
        <marker id="mini-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
        </marker>
      </defs>
      {view.edges.map((e) => {
        const a = pos.get(e.from_id)
        const b = pos.get(e.to_id)
        if (a === undefined || b === undefined) return null
        return (
          <line
            key={`${e.from_id}-${e.to_id}-${e.relation}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="var(--muted)"
            strokeWidth={1.3}
            strokeOpacity={0.5}
            markerEnd="url(#mini-arrow)"
          />
        )
      })}
      {view.nodes.map((n) => {
        const p = pos.get(n.id)!
        const r = 9 + Math.min(n.in_degree + n.out_degree, 6) * 1.6
        return (
          <g key={n.id}>
            <circle cx={p.x} cy={p.y} r={r} fill={TYPE_COLOR[n.type] ?? '#8b93a7'} />
            <text x={p.x} y={p.y + r + 13} textAnchor="middle" fontSize={11} fill="var(--text)">
              {n.title.length > 12 ? `${n.title.slice(0, 12)}…` : n.title}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 条目详情面板：正文 + 版本历史（F-B4）+ 元数据 + 关系（含双链邻居）。 */
function EntryPanel({ id, onClose, onSelect }: { id: string; onClose: () => void; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<'body' | 'versions'>('body')
  /** undefined = 最新版（与既有行为一致）；有值 = 查看该历史版次。 */
  const [version, setVersion] = useState<number | undefined>(undefined)
  const entry = useAsync(() => api.kbGet(id, version), [id, version])
  const versions = useAsync(() => api.kbVersions(id), [id])
  const neighbors = useAsync(() => api.kbGraph({ id, depth: 1 }), [id])
  const [removing, setRemoving] = useState(false)
  const [note, setNote] = useState('')

  // 换条目时回到「正文 + 最新版」：面板不保留上一条目的视图状态
  useEffect(() => {
    setTab('body')
    setVersion(undefined)
    setNote('')
  }, [id])

  /** 版次降序（服务端已降序，这里再保证一次，空数组不报错）。 */
  const list = useMemo(
    () => [...(versions.data ?? [])].sort((a, b) => b.version - a.version),
    [versions.data],
  )
  const latest = list.find((v) => v.is_latest)?.version
  /** 正在看历史版（版次表未加载完时保守判定为历史版 → 不提供软删）。 */
  const viewingHistory = version !== undefined && (latest === undefined || version !== latest)

  /** 软删（可恢复）：二次确认，避免误点。历史版不提供软删。 */
  const doRemove = async () => {
    if (!window.confirm(`软删条目「${entry.data?.title ?? id}」？

条目将标记为 deprecated（保留可恢复），不再出现在检索与图谱中。`)) {
      return
    }
    setRemoving(true)
    try {
      const result = await api.kbRemove(id)
      setNote(`已软删（被 ${result.references} 条边引用）；关闭面板后从视图消失`)
    } catch (error) {
      setNote(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setRemoving(false)
    }
  }

  /** 点版本 → 回正文看该版次（用户点版本的目的就是看内容）。 */
  const openVersion = (v: number) => {
    setVersion(v)
    setTab('body')
  }

  return (
    <aside className="entry-panel">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong>条目详情</strong>
        <div className="row" style={{ gap: 6 }}>
          {entry.data !== undefined && entry.data.status === 'active' && !viewingHistory && (
            <button onClick={() => void doRemove()} disabled={removing} title="软删（可恢复）">
              {removing ? '删除中…' : '软删'}
            </button>
          )}
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
      {note !== '' && (
        <div className="small" style={{ marginBottom: 8, color: 'var(--warn, #e0c23a)' }}>
          {note}
        </div>
      )}

      {/* 标签栏（沿用 ScopePanel 的 tab 约定：选中 = button.primary） */}
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <button className={tab === 'body' ? 'primary' : ''} aria-pressed={tab === 'body'} onClick={() => setTab('body')}>
          正文
        </button>
        <button
          className={tab === 'versions' ? 'primary' : ''}
          aria-pressed={tab === 'versions'}
          onClick={() => setTab('versions')}
        >
          {/* 未加载前不显示数字，避免闪一个假数字 */}
          {versions.data !== undefined ? `版本 (${list.length})` : '版本'}
        </button>
      </div>

      {tab === 'body' && (
        <>
          {entry.data !== undefined && entry.error !== undefined && (
            <div className="error" role="alert" style={{ marginBottom: 8 }}>
              {version !== undefined ? `切换到 v${version} 失败：${entry.error}` : `请求失败：${entry.error}`}{' '}
              <button className="rel-link" onClick={entry.reload}>
                重试
              </button>
            </div>
          )}
          {entry.data !== undefined && entry.loading && (
            <div className="small muted" style={{ marginBottom: 6 }}>
              加载中…
            </div>
          )}
          {entry.data === undefined ? (
            <State loading={entry.loading} error={entry.error}>{null}</State>
          ) : (
            <div aria-live="polite">
              <div className="mono small muted">
                {id}@v{entry.data.version}
                {viewingHistory && (
                  <>
                    {' '}
                    <span className="tag">历史版本</span>
                  </>
                )}
              </div>
              <h3 style={{ margin: '4px 0 10px', fontSize: 16 }}>{entry.data.title}</h3>
              <div className="row" style={{ gap: 6, marginBottom: 10 }}>
                <span className="tag" style={{ color: TYPE_COLOR[entry.data.type] }}>
                  {TYPE_LABEL[entry.data.type] ?? entry.data.type}
                </span>
                <span className="tag">{LAYER_LABEL[entry.data.layer] ?? entry.data.layer}</span>
                <span className="tag">{entry.data.book}</span>
                {entry.data.module !== '' && <span className="tag">{entry.data.module}</span>}
                <span className={`tag${entry.data.risk === 'high' ? ' err' : entry.data.risk === 'medium' ? ' warn' : ''}`}>
                  risk {entry.data.risk}
                </span>
              </div>
              <pre className="entry-body">{entry.data.content}</pre>

              {neighbors.data && neighbors.data.edges.length > 0 && (
                <>
                  <div className="small muted" style={{ margin: '12px 0 6px' }}>
                    关系（{neighbors.data.edges.length}）
                  </div>
                  <ul className="rel-list">
                    {dedupeRelations(neighbors.data.edges, id).map((r) => (
                      <li key={`${r.dir}-${r.other}-${r.relation}`} className="small">
                        <span className="mono muted">{r.dir} {r.relation}</span>{' '}
                        <button
                          className="rel-link"
                          onClick={() => onSelect(r.other)}
                          title="查看该条目"
                        >
                          {r.other}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {entry.data.tags.length > 0 && (
                <div className="row" style={{ gap: 4, marginTop: 10 }}>
                  {entry.data.tags.map((t) => (
                    <span key={t} className="tag small">#{t}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'versions' && (
        <>
          <State loading={versions.loading} error={versions.error}>
            {list.length === 0 ? (
              <div className="empty">没找到该条目的版本记录。条目可能已从库中移除。</div>
            ) : list.length === 1 ? (
              <div className="empty">
                此条目只有 1 个版本（当前 v{list[0].version}）。
                <div className="small muted" style={{ marginTop: 6 }}>
                  有新版本时这里会出现历史。
                </div>
              </div>
            ) : (
              <div>
                {list.map((v) => (
                  <button
                    key={v.version}
                    className={`list-row${v.is_latest ? '' : ' muted'}`}
                    style={{ borderLeft: `3px solid ${v.is_latest ? 'var(--accent)' : 'transparent'}` }}
                    onClick={() => openVersion(v.version)}
                    title={`查看 v${v.version} 正文`}
                  >
                    <span className="mono" style={{ minWidth: 34 }}>
                      v{v.version}
                    </span>
                    {v.is_latest && <span className="tag ok">当前</span>}
                    <span className={`tag${STATUS_TAG[v.status] ?? ''}`}>{v.status}</span>
                    {entry.data !== undefined && entry.data.version === v.version && (
                      <span className="tag">查看中</span>
                    )}
                    <span className="list-main small muted" style={{ textAlign: 'right' }}>
                      {fmtTime(v.updated_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="small muted" style={{ marginTop: 10 }}>
              版本来自条目文件；索引流水请用 <span className="mono">prism kb scan-history</span>
            </div>
          </State>
          {versions.error !== undefined && (
            <div className="row" style={{ marginTop: 8 }}>
              <button onClick={versions.reload}>重试</button>
            </div>
          )}
        </>
      )}
    </aside>
  )
}

/** 版次状态 → 标签变体（未知值不隐藏，原文显示）。 */
const STATUS_TAG: Record<string, string> = {
  active: ' ok',
  deprecated: ' err',
  superseded: ' warn',
}

/** ISO 时间 → `YYYY-MM-DD HH:mm`（解析失败原样返回，不隐藏）。 */
function fmtTime(iso: string): string {
  if (iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export type { KbGraphNode }
