import { useMemo, useState } from 'react'

import { api, type CatalogEntry, type KbGraphEdge, type KbGraphNode, type KbGraphView } from '../api.ts'
import { StarCanvas, seededRandom, useStarfield, type Viewport } from '../components/StarCanvas.tsx'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

/**
 * 知识库 = 图书馆（星图隐喻）
 *
 * **统一术语（用户裁决 2026-09-10）**：表现形式叫「星系」，点开就是「书」。
 * 不再混用「星体/书星」——同一个东西只叫一个名字。
 *
 * 三级下钻：
 *   ① 图书馆：一团星云，每「书」一个星系（星系大小 = 条目数）
 *   ② 书内：每「模块」一个星系（书的地表，模块是大陆）
 *   ③ 模块内：每「条目」一个星系 + 关系连线（知识图谱）
 *   ④ 条目详情：正文 + 元数据 + 关系
 *
 * 视觉语言：深空背景 + 星点 + 辉光；层级用半径/亮度/颜色区分，不靠表格。
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

type Level =
  | { kind: 'galaxies' }
  | { kind: 'book'; layer: string; owner?: string; book: string }
  | { kind: 'module'; layer: string; owner?: string; book: string; module: string }

export function KnowledgePage() {
  const [level, setLevel] = useState<Level>({ kind: 'galaxies' })
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
              分类分层给定位，图谱联系给发现。每个星系就是一本「书」，点开进入下一层；滚轮缩放，拖拽平移，双击复位。
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

        <Breadcrumb level={level} onNavigate={setLevel} />
      </header>

      <State loading={catalog.loading} error={catalog.error}>
        {catalog.data && (
          <GalaxyView
            entries={catalog.data}
            allEdges={graph.data?.edges ?? []}
            level={level}
            onLevelChange={setLevel}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </State>

      {/* 书/模块详情：该层级的知识图谱 + 关联架构图（图谱归属到书内，不再是一级页） */}
      {level.kind !== 'galaxies' && (
        <ScopePanel level={level} entries={catalog.data ?? []} />
      )}
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

function Breadcrumb({ level, onNavigate }: { level: Level; onNavigate: (l: Level) => void }) {
  return (
    <nav className="crumbs">
      <button className={`crumb${level.kind === 'galaxies' ? ' active' : ''}`} onClick={() => onNavigate({ kind: 'galaxies' })}>
        ◎ 全部
      </button>
      {level.kind !== 'galaxies' && (
        <>
          <span className="crumb-sep">›</span>
          <button
            className={`crumb${level.kind === 'book' ? ' active' : ''}`}
            onClick={() => onNavigate({ kind: 'book', layer: level.layer, ...(level.owner !== undefined ? { owner: level.owner } : {}), book: level.book })}
          >
            {level.layer}
            {level.owner ? `/${level.owner}` : ''}/{level.book}
          </button>
        </>
      )}
      {level.kind === 'module' && (
        <>
          <span className="crumb-sep">›</span>
          <span className="crumb active">{level.module === '' ? '_inbox' : level.module}</span>
        </>
      )}
    </nav>
  )
}

/** 各级共用同一套星系渲染（只是数据源不同）。 */
function GalaxyView({
  entries,
  allEdges,
  level,
  onLevelChange,
  selectedId,
  onSelect,
}: {
  entries: CatalogEntry[]
  allEdges: KbGraphEdge[]
  level: Level
  onLevelChange: (l: Level) => void
  selectedId: string
  onSelect: (id: string) => void
}) {
  // 按层级切出当前要展示的星系集合
  const { bodies, edges, backTarget } = useMemo(
    () => buildBodies(entries, allEdges, level),
    [entries, allEdges, level],
  )
  const stars = useStarfield(220, WORLD_W, WORLD_H)
  const [vp, setVp] = useState<Viewport>({ k: 1, x: 0, y: 0 })

  return (
    <div className="star-wrap">
      <div className="star-hint mono small">
        缩放 {Math.round(vp.k * 100)}% ·{' '}
        {level.kind === 'galaxies'
          ? `书 ${bodies.length} 本`
          : level.kind === 'book'
            ? `模块 ${bodies.length} 个`
            : `条目 ${bodies.length} 条`}
        {level.kind !== 'galaxies' && <span> · 双击空白返回上一层</span>}
      </div>
      <StarCanvas
        width={WORLD_W}
        height={WORLD_H}
        onViewportChange={setVp}
        onBackgroundClick={() => {
          if (backTarget !== null) onLevelChange(backTarget)
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

            {/* 一级：图书馆本体 —— 一团巨大的星云，每个星系就是一本「书」 */}
            {level.kind === 'galaxies' && <LibraryNebula />}

            {/* 关系边（仅条目图谱有） */}
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

            {/* 星系 */}
            {bodies.map((body) => (
              <StarBody
                key={body.id}
                body={body}
                selected={selectedId === body.id}
                onClick={() => {
                  if (body.drill !== undefined) onLevelChange(body.drill)
                  else onSelect(body.id === selectedId ? '' : body.id)
                }}
              />
            ))}
          </>
        )}
      </StarCanvas>

      {selectedId !== '' && level.kind === 'module' && (
        <EntryPanel id={selectedId} onClose={() => onSelect('')} onSelect={onSelect} />
      )}
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
  /** 点击后下钻的目标（条目层没有下一级） */
  drill?: Level
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
function buildBodies(
  entries: CatalogEntry[],
  allEdges: KbGraphEdge[],
  level: Level,
): { bodies: Body[]; edges: KbGraphEdge[]; backTarget: Level | null } {
  if (level.kind === 'galaxies') {
    // 每「层/owner/书」一个星系（点开就是这本书）
    const groups = new Map<string, { layer: string; owner?: string; book: string; count: number; types: Set<string> }>()
    for (const e of entries) {
      const key = `${e.layer}|${e.owner ?? ''}|${e.book}`
      let g = groups.get(key)
      if (g === undefined) {
        g = { layer: e.layer, ...(e.owner !== undefined ? { owner: e.owner } : {}), book: e.book, count: 0, types: new Set() }
        groups.set(key, g)
      }
      g.count++
      g.types.add(e.type)
    }
    const list = [...groups.values()].sort((a, b) => b.count - a.count || a.book.localeCompare(b.book))
    const bodies = ringLayout(
      list.map((g, i) => ({
        id: `${g.layer}/${g.owner ?? ''}/${g.book}`,
        label: g.book,
        sublabel: `${LAYER_LABEL[g.layer] ?? g.layer}${g.owner ? ` · ${g.owner}` : ''} · ${g.count} 条`,
        count: g.count,
        color: paletteAt(i),
        drill: { kind: 'book', layer: g.layer, ...(g.owner !== undefined ? { owner: g.owner } : {}), book: g.book } as Level,
      })),
      Math.max(3, list.length),
    )
    return { bodies, edges: [], backTarget: null }
  }

  // 书视图 / 模块视图
  const inBook = entries.filter(
    (e) =>
      e.layer === level.layer &&
      (e.owner ?? '') === (level.owner ?? '') &&
      e.book === level.book,
  )
  const backTarget: Level =
    level.kind === 'module'
      ? { kind: 'book', layer: level.layer, ...(level.owner !== undefined ? { owner: level.owner } : {}), book: level.book }
      : { kind: 'galaxies' }

  if (level.kind === 'book') {
    // 模块 → 大陆
    const groups = new Map<string, { count: number; types: Set<string> }>()
    for (const e of inBook) {
      const key = e.module === '' ? '_inbox' : e.module
      let g = groups.get(key)
      if (g === undefined) {
        g = { count: 0, types: new Set() }
        groups.set(key, g)
      }
      g.count++
      g.types.add(e.type)
    }
    const list = [...groups.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    const bodies = ringLayout(
      list.map(([name, g], i) => ({
        id: `${level.book}/${name}`,
        label: name === '_inbox' ? '待归类' : name,
        sublabel: `${g.count} 条`,
        count: g.count,
        color: paletteAt(i),
        drill: { kind: 'module', layer: level.layer, ...(level.owner !== undefined ? { owner: level.owner } : {}), book: level.book, module: name === '_inbox' ? '' : name } as Level,
      })),
      Math.max(3, list.length),
    )
    return { bodies, edges: [], backTarget }
  }

  // 模块视图：条目即星系，边即关系
  const inModule = inBook.filter((e) => e.module === level.module)
  const ids = new Set(inModule.map((e) => e.id))
  const bodies = ringLayout(
    inModule
      .sort((a, b) => b.in_degree + b.out_degree - (a.in_degree + a.out_degree) || a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        label: e.title,
        sublabel: `${TYPE_LABEL[e.type] ?? e.type} · 入${e.in_degree}/出${e.out_degree}`,
        count: 1,
        color: TYPE_COLOR[e.type] ?? '#8b93a7',
      })),
    Math.max(3, inModule.length),
  )
  // 只保留两端都在本模块内的边
  const edges = allEdges.filter((e) => ids.has(e.from_id) && ids.has(e.to_id))
  return { bodies, edges, backTarget }
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
  items: Array<{ id: string; label: string; sublabel?: string; count: number; color: string; drill?: Level }>,
  _slots: number,
): Body[] {
  const n = items.length
  if (n === 0) return []
  // 可用半径：世界的一半再留出标签边距
  const maxR = Math.min(WORLD_W, WORLD_H) / 2 - 110
  const bodies: Body[] = []
  const starR = (count: number): number => 22 + Math.min(46, Math.sqrt(count) * 14)

  if (n === 1) {
    bodies.push(bodyOf(items[0]!, 0, 0, starR(items[0]!.count)))
    return bodies
  }

  if (n <= 8) {
    const radius = maxR * 0.72
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
  it: { id: string; label: string; sublabel?: string; count: number; color: string; drill?: Level },
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
      {/* 标签 */}
      <text
        x={body.x}
        y={body.y + body.r + 15}
        textAnchor="middle"
        fontSize={13}
        fill="#e6e9ef"
        style={{ pointerEvents: 'none' }}
      >
        {body.label.length > 16 ? `${body.label.slice(0, 16)}…` : body.label}
      </text>
      {body.sublabel !== undefined && (
        <text x={body.x} y={body.y + body.r + 30} textAnchor="middle" fontSize={10.5} fill="#8b93a7" style={{ pointerEvents: 'none' }}>
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
 * 书/模块详情：该层级的知识图谱 + 关联架构图。
 *
 * 用户裁决（2026-09-10）：知识图谱、架构图谱**属于书内部**，不再是一级菜单。
 * 这里按当前层级过滤图谱（book / book+module），架构图列出该层级相关的
 * `type: diagram` 条目与已渲染产物。
 */
type ScopeLevel =
  | { kind: 'book'; layer: string; owner?: string; book: string }
  | { kind: 'module'; layer: string; owner?: string; book: string; module: string }

function ScopePanel({
  level,
  entries,
}: {
  level: ScopeLevel
  entries: CatalogEntry[]
}) {
  const [tab, setTab] = useState<'graph' | 'arch' | 'entries'>('graph')
  const [preview, setPreview] = useState<string>('')

  const scopeLabel =
    level.kind === 'module'
      ? `${level.book} / ${level.module === '' ? '_inbox' : level.module}`
      : level.book

  // 该层级的知识图谱（服务端按 book/module 过滤）
  const view = useAsync(
    () =>
      api.kbGraph({
        ...(level.kind === 'module'
          ? { book: level.book, module: level.module, depth: 2 }
          : { book: level.book, depth: 2 }),
        limit: 200,
      }),
    [level.kind, level.book, level.kind === 'module' ? level.module : ''],
  )

  // 该层级的条目（diagram 类型用于「架构图」标签）
  const scoped = entries.filter(
    (e) =>
      e.layer === level.layer &&
      (e.owner ?? '') === (level.owner ?? '') &&
      e.book === level.book &&
      (level.kind === 'book' || e.module === level.module),
  )
  const diagrams = scoped.filter((e) => e.type === 'diagram')
  const archAssets = useAsync(() => api.archDiagrams(), [])

  return (
    <div className="card scope-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          {level.kind === 'module' ? '模块详情' : '书详情'}{' '}
          <span className="mono small muted">{scopeLabel}</span>
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
          {diagrams.length === 0 ? (
            <div className="empty">
              该{level.kind === 'module' ? '模块' : '书'}还没有 <span className="mono">type: diagram</span> 条目。
              <div className="small muted" style={{ marginTop: 6 }}>
                用 <span className="mono">prism arch render &lt;type&gt; &lt;ir.json&gt;</span> 渲染后，IR 与 HTML 可作为 diagram 条目落库。
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

          {/* 已渲染的 Archify 产物（可预览） */}
          <div className="small muted" style={{ margin: '14px 0 6px' }}>
            已渲染产物（Archify）
          </div>
          <State loading={archAssets.loading} error={archAssets.error}>
            {(archAssets.data?.length ?? 0) === 0 ? (
              <div className="small muted">（还没有渲染产物）</div>
            ) : (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {archAssets.data?.map((d) => (
                  <button
                    key={`${d.type}/${d.name}`}
                    className={preview === `/api/arch/preview/${d.type}/${d.name}` ? 'primary' : ''}
                    onClick={() => setPreview(`/api/arch/preview/${d.type}/${d.name}`)}
                  >
                    {d.type} · {d.name}
                  </button>
                ))}
              </div>
            )}
          </State>
          {preview !== '' && (
            <div className="iframe-wrap" style={{ marginTop: 10 }}>
              <iframe title="arch-preview" src={preview} />
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

/** 条目详情面板：正文 + 元数据 + 关系（含双链邻居）。 */
function EntryPanel({ id, onClose, onSelect }: { id: string; onClose: () => void; onSelect: (id: string) => void }) {
  const entry = useAsync(() => api.kbGet(id), [id])
  const neighbors = useAsync(() => api.kbGraph({ id, depth: 1 }), [id])

  return (
    <aside className="entry-panel">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong>条目详情</strong>
        <button onClick={onClose}>关闭</button>
      </div>
      <State loading={entry.loading} error={entry.error}>
        {entry.data && (
          <>
            <div className="mono small muted">{id}@v{entry.data.version}</div>
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
          </>
        )}
      </State>
    </aside>
  )
}

export type { KbGraphNode }
