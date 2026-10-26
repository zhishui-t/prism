/**
 * 工作流图组件（workflow-asset v2 图编辑器）。
 *
 * 图结构 = 泳道（横向带，承接）× 步骤序（带内蛇形折行）：前向实线箭头（顺序，
 * 模型固有）+ 回流虚线边（「回 N」规范形）。**只读模式**（团队阶段视图）：缩放/
 * 平移/点节点聚焦上下游。**编辑模式**（工作流单元）：点节点选中（右侧字段面板）、
 * 拖节点 = 改序/换泳道（拖动中显示落点虚线框）、拖节点右缘回流手柄到更早节点 =
 * 建回流边、点回流虚线 = 删。改动进未保存草稿，保存由父级回调（PATCH + if_match）。
 *
 * 坐标：内容整体包在 `<g transform={zoom.transform}>` 里（缩放/平移就是这条变换）；
 * 指针 → 内容坐标走该 `<g>` 的 `getScreenCTM()` 反解——**不要**手算 rect/scale，
 * SVG 自身的 meet 映射 + 内层变换都得算进去（曾只除 zoom.scale：拖一格飞两格）。
 *
 * 身份约定：布局/边/聚焦一律用**数组下标**（graph-logic 同口径）——order 只作
 * 展示与「回 N」解析，重复/跳号不会让节点重叠。
 *
 * 约束：SVG 内零 inline 样式、色走 token（styles.css 的 .wf-* 一族）。
 */

import { useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

import { useT } from '../i18n.ts'
import { useZoom } from './CallChainGraph.tsx'
import {
  WF_LANE_LABEL_W,
  WF_NODE_H,
  WF_NODE_W,
  WF_ROW_GAP,
  WF_ROW_LEN,
  WF_STEP_GAP,
  wfBandStartCol,
  wfCapacity,
  wfDropTarget,
  wfEdgePath,
  wfEdges,
  wfLayout,
  wfRelated,
  wfRenumberReflow,
  wfReflowPath,
  type WfGraphNode,
} from './graph-logic.ts'

export interface WorkflowGraphProps {
  nodes: WfGraphNode[]
  /** 编辑模式：可拖节点/建删回流边；只读模式仅缩放/平移/聚焦。 */
  editable?: boolean
  /** 选中的步骤序（编辑模式右侧面板联动）。 */
  selected?: number
  /** 点节点（编辑模式选中；只读模式不传，点击行为是聚焦上下游）。 */
  onSelect?: (order: number) => void
  /** 草稿变更（编辑模式）：新的节点序（已重编回流号）。 */
  onChange?: (nodes: WfGraphNode[]) => void
  /** 高亮已改动节点的序号集合（父级判定脏时传入）。 */
  movedOrders?: ReadonlySet<number>
}

interface DragState {
  kind: 'node'
  /** 拖动节点的数组下标。 */
  i: number
  /** 拖动中的偏移（内容坐标）。 */
  dx: number
  dy: number
}
interface RubberState {
  /** 源节点下标。 */
  from: number
  /** 橡皮筋终点（内容坐标）。 */
  x: number
  y: number
}
interface DropState {
  lane: string
  /** 移除拖动项前的数组插入下标。 */
  insertAt: number
}

/** `<g transform>` → 分量（仅 happy-dom 等无 CTM 环境的降级路径用）。 */
function parseGTransform(text: string): { s: number; tx: number; ty: number } {
  const s = /scale\(([-\d.]+)\)/.exec(text)
  const t = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(text)
  return { s: s === null ? 1 : Number(s[1]), tx: t === null ? 0 : Number(t[1]), ty: t === null ? 0 : Number(t[2]) }
}

export function WorkflowGraph({
  nodes,
  editable = false,
  selected,
  onSelect,
  onChange,
  movedOrders,
}: WorkflowGraphProps) {
  const t = useT()
  const layout = useMemo(() => wfLayout(nodes), [nodes])
  const edges = useMemo(() => wfEdges(nodes), [nodes])
  const vb = useMemo(
    () => ({ x: 0, y: 0, w: Math.max(360, layout.width), h: Math.max(240, layout.height) }),
    [layout],
  )
  const zoom = useZoom(vb)
  const [focus, setFocus] = useState<Set<number> | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [drop, setDrop] = useState<DropState | null>(null)
  const [rubber, setRubber] = useState<RubberState | null>(null)
  const [hint, setHint] = useState('')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const layerRef = useRef<SVGGElement | null>(null)
  /** 拖动阈值：超过 3px 才算拖动（否则是点击选中）。 */
  const dragMoved = useRef(false)
  const downAt = useRef({ x: 0, y: 0 })

  /**
   * 指针 → 内容坐标。
   *
   * 首选内层 `<g>` 的 `getScreenCTM()`：它已包含 viewBox→元素的 meet 映射、内层
   * transform（缩放/平移）与页面滚动——手算任何一项都会偏。无 CTM 的环境
   * （happy-dom）降级为「rect + viewBox meet + transform 分量」的等价算式。
   */
  const toUser = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const layer = layerRef.current
    const ctm = layer !== null && typeof layer.getScreenCTM === 'function' ? layer.getScreenCTM() : null
    if (ctm !== null && typeof DOMPoint !== 'undefined') {
      const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
      return { x: p.x, y: p.y }
    }
    const el = svgRef.current
    if (el === null) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    const fit = Math.min(rect.width / vb.w, rect.height / vb.h) || 1
    const ox = rect.left + (rect.width - vb.w * fit) / 2 - vb.x * fit
    const oy = rect.top + (rect.height - vb.h * fit) / 2 - vb.y * fit
    const view = { x: (e.clientX - ox) / fit, y: (e.clientY - oy) / fit }
    const g = parseGTransform(zoom.transform)
    return { x: (view.x - g.tx) / g.s, y: (view.y - g.ty) / g.s }
  }

  const posOf = (i: number): { x: number; y: number } => {
    const p = layout.positions.get(i) ?? { x: 0, y: 0 }
    return drag?.kind === 'node' && drag.i === i ? { x: p.x + drag.dx, y: p.y + drag.dy } : p
  }

  const onNodePointerDown = (e: ReactPointerEvent<SVGGElement>, i: number): void => {
    if (!editable || e.button !== 0) return
    e.stopPropagation()
    dragMoved.current = false
    downAt.current = { x: e.clientX, y: e.clientY }
    try {
      ;(e.currentTarget as SVGGElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* 指针捕获不是所有环境都给：退化成容器内跟手，功能不减 */
    }
    setDrag({ kind: 'node', i, dx: 0, dy: 0 })
  }
  const onNodePointerMove = (e: ReactPointerEvent<SVGGElement>): void => {
    if (drag === null) return
    if (Math.abs(e.clientX - downAt.current.x) + Math.abs(e.clientY - downAt.current.y) > 3) {
      dragMoved.current = true
    }
    const p = toUser(e)
    const origin = layout.positions.get(drag.i) ?? { x: 0, y: 0 }
    setDrag({ ...drag, dx: p.x - origin.x, dy: p.y - origin.y })
    setDrop(wfDropTarget(nodes, layout, p.x, p.y))
  }
  const onNodePointerUp = (): void => {
    if (drag === null) return
    const target = drop
    const current = nodes[drag.i]
    if (dragMoved.current && target !== null && current !== undefined && onChange !== undefined) {
      const without = nodes.filter((_, k) => k !== drag.i)
      // insertAt 是「移除前」口径：拖动项原本在它之前时，移除后目标位前移一位
      const at = target.insertAt > drag.i ? target.insertAt - 1 : target.insertAt
      const lane = target.lane
      const owner = lane === '—' ? [] : [lane, ...current.owner.slice(1).filter((o) => o !== lane)]
      const moved = { ...current, owner }
      const next = [...without.slice(0, at), moved, ...without.slice(at)]
      const renumbered = next.map((n, k) => ({ ...n, order: k + 1 }))
      const orderMap = new Map<number, number>()
      next.forEach((n, k) => orderMap.set(n.order, k + 1))
      const refl = wfRenumberReflow(renumbered, orderMap)
      onChange(renumbered.map((n, k) => ({ ...n, reflow: refl[k]! })))
    }
    setDrag(null)
    setDrop(null)
  }

  const onHandlePointerDown = (e: ReactPointerEvent<SVGCircleElement>, i: number): void => {
    if (!editable || e.button !== 0) return
    e.stopPropagation()
    dragMoved.current = false
    try {
      ;(e.currentTarget as SVGCircleElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* 同上 */
    }
    const start = toUser(e)
    setRubber({ from: i, x: start.x, y: start.y })
  }
  const onHandlePointerMove = (e: ReactPointerEvent<SVGCircleElement>): void => {
    if (rubber === null) return
    const p = toUser(e)
    setRubber({ ...rubber, x: p.x, y: p.y })
  }
  const onHandlePointerUp = (): void => {
    if (rubber === null) return
    // 命中判定：橡皮筋终点落在哪个节点框内（矩形命中）
    const hit = nodes.findIndex((_, k) => {
      const p = layout.positions.get(k) ?? { x: 0, y: 0 }
      return (
        rubber.x >= p.x && rubber.x <= p.x + WF_NODE_W && rubber.y >= p.y && rubber.y <= p.y + WF_NODE_H
      )
    })
    const targetOrder = hit >= 0 ? nodes[hit]!.order : undefined
    const sourceOrder = nodes[rubber.from]?.order
    if (hit < 0 || targetOrder === undefined || sourceOrder === undefined) {
      setHint(t('workflows.graph.dropMiss'))
    } else if (hit >= rubber.from) {
      setHint(t('workflows.graph.earlierOnly'))
    } else if (onChange !== undefined) {
      onChange(
        nodes.map((n, k) => (k === rubber.from ? { ...n, reflow: `\u56de ${targetOrder}` /* 回 */ } : n)),
      )
      setHint('')
    }
    setRubber(null)
  }

  const onEdgeClick = (from: number): void => {
    if (!editable || onChange === undefined) return
    onChange(nodes.map((n, k) => (k === from ? { ...n, reflow: '—' } : n)))
  }

  const onNodeClick = (i: number): void => {
    if (dragMoved.current) {
      dragMoved.current = false
      return
    }
    if (editable && onSelect !== undefined) {
      onSelect(nodes[i]!.order)
      return
    }
    setFocus(focus === null ? wfRelated(edges, i) : null)
  }

  /** 拖动落点的虚线占位框（插入位换算回泳道内行列）。 */
  const ghost = useMemo(() => {
    if (drag === null || drop === null) return null
    const laneIndex = layout.lanes.indexOf(drop.lane)
    if (laneIndex < 0) return null
    const members: number[] = []
    nodes.forEach((n, i) => {
      if ((n.owner[0] ?? '—') === drop.lane) members.push(i)
    })
    const before = members.filter((i) => i < drop.insertAt && i !== drag.i).length
    const count = members.length
    const capacity = wfCapacity(nodes)
    const j = Math.min(before, count)
    const row = Math.floor(j / WF_ROW_LEN)
    const m = j % WF_ROW_LEN
    const start = wfBandStartCol(count, capacity)
    const col = row % 2 === 0 ? start + m : start + WF_ROW_LEN - 1 - m
    return {
      x: WF_LANE_LABEL_W + col * (WF_NODE_W + WF_STEP_GAP),
      y: (layout.laneTops[laneIndex] ?? 0) + row * (WF_NODE_H + WF_ROW_GAP),
    }
  }, [drag, drop, nodes, layout])

  return (
    <div className="wf-graph-wrap">
      {zoom.toolbar}
      {editable && (
        <div className="small muted wf-graph-tip">{t('workflows.graph.selectHint')}</div>
      )}
      {hint !== '' && (
        <div className="banner lamp" role="status">
          <span className="scope-lamp" />
          <span className="small">{hint}</span>
        </div>
      )}
      <svg
        {...zoom.svgProps}
        ref={(el) => {
          svgRef.current = el
          const upstream = zoom.svgProps.ref
          if (typeof upstream === 'function') upstream(el)
          else if (upstream !== null && typeof upstream === 'object')
            (upstream as { current: SVGSVGElement | null }).current = el
        }}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        role="img"
        aria-label={t('workflows.graph.aria')}
      >
        <defs>
          <marker
            id="wf-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" className="wf-arrow-head" />
          </marker>
          <marker
            id="wf-arrow-reflow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" className="wf-arrow-head reflow" />
          </marker>
        </defs>
        {/* 缩放/平移的唯一落点：所有内容都在这条 transform 里 */}
        <g ref={layerRef} className="wf-zoom-layer" transform={zoom.transform}>
          {/* 泳道带（底纹 + 左缘胶囊标签垂直居中于带）：带高随折行行数 */}
          {layout.lanes.map((lane, i) => {
            const rows = layout.laneRows[i] ?? 1
            const top = layout.laneTops[i] ?? 0
            const bandH = rows * (WF_NODE_H + WF_ROW_GAP) - WF_ROW_GAP
            return (
              <g key={lane}>
                <rect
                  className={`wf-lane-bg${i % 2 === 1 ? ' alt' : ''}${drop?.lane === lane ? ' drop' : ''}`}
                  x={0}
                  y={top - WF_ROW_GAP / 2}
                  width={vb.w}
                  height={rows * (WF_NODE_H + WF_ROW_GAP)}
                  rx={10}
                />
                <rect className="wf-lane-tag" x={6} y={top + (bandH - 30) / 2} width={98} height={30} rx={15} />
                <text className="wf-lane-label" x={55} y={top + bandH / 2}>
                  {(lane.length > 8 ? `${lane.slice(0, 7)}\u2026` /* … */ : lane).replace(/\*\*/g, '')}
                  <title>{lane}</title>
                </text>
              </g>
            )
          })}
          {/* 边（先画在节点下层）：前向 = 锚点按相对位置（同行水平可反向 / 跨行垂直）；回流 = 右弧 */}
          {edges.map((e, i) => {
            const from = posOf(e.from)
            const to = posOf(e.to)
            const sameRow = Math.abs(from.y - to.y) < 1
            const toRight = to.x > from.x
            const a =
              e.kind === 'reflow'
                ? { x: from.x + WF_NODE_W, y: from.y + WF_NODE_H / 2 }
                : sameRow
                  ? { x: toRight ? from.x + WF_NODE_W : from.x, y: from.y + WF_NODE_H / 2 }
                  : { x: from.x + WF_NODE_W / 2, y: from.y + WF_NODE_H }
            const b =
              e.kind === 'reflow'
                ? { x: to.x + WF_NODE_W, y: to.y + WF_NODE_H / 2 }
                : sameRow
                  ? { x: toRight ? to.x : to.x + WF_NODE_W, y: to.y + WF_NODE_H / 2 }
                  : { x: to.x + WF_NODE_W / 2, y: to.y }
            const dimmed = focus !== null && !focus.has(e.from) && !focus.has(e.to)
            const d = e.kind === 'reflow' ? wfReflowPath(a, b) : wfEdgePath(a, b)
            const reflowLabel = e.kind === 'reflow' ? `\u56de ${nodes[e.to]!.order}` /* 回 N */ : ''
            return (
              <g key={`${e.kind}-${e.from}-${e.to}-${i}`} className={`wf-edge-g${dimmed ? ' dimmed' : ''}`}>
                <path
                  className={`wf-edge ${e.kind === 'reflow' ? 'reflow' : ''}`}
                  d={d}
                  markerEnd={`url(#${e.kind === 'reflow' ? 'wf-arrow-reflow' : 'wf-arrow'})`}
                >
                  <title>
                    {e.kind === 'reflow'
                      ? `${e.raw}\uFF08${t('workflows.graph.deleteReflow')}\uFF09` /* （） */
                      : ''}
                  </title>
                </path>
                {editable && e.kind === 'reflow' && (
                  <path
                    className="wf-edge-hit"
                    d={d}
                    onClick={() => onEdgeClick(e.from)}
                    aria-label={t('workflows.graph.deleteReflow')}
                    role="button"
                  />
                )}
                {reflowLabel !== '' && (
                  <text className="wf-reflow-tag" x={Math.max(a.x, b.x) + 44} y={(a.y + b.y) / 2}>
                    {reflowLabel}
                  </text>
                )}
              </g>
            )
          })}
          {/* 橡皮筋（建回流边） */}
          {rubber !== null && (
            <path
              className="wf-edge rubber"
              d={wfEdgePath(
                { x: posOf(rubber.from).x + WF_NODE_W, y: posOf(rubber.from).y + WF_NODE_H / 2 },
                { x: rubber.x, y: rubber.y },
                32,
              )}
            />
          )}
          {/* 拖动落点虚线框 */}
          {ghost !== null && (
            <rect
              className="wf-drop-ghost"
              x={ghost.x}
              y={ghost.y}
              width={WF_NODE_W}
              height={WF_NODE_H}
              rx={10}
            />
          )}
          {/* 节点 */}
          {nodes.map((n, i) => {
            const p = posOf(i)
            const dimmed = focus !== null && !focus.has(i)
            const moved = movedOrders?.has(n.order) === true
            const isSelected = selected !== undefined && selected === n.order
            const coOwners = n.owner.slice(1).join(' + ')
            const note = coOwners !== '' ? coOwners : n.reflow === '' || n.reflow === '—' ? '' : n.reflow
            return (
              <g
                key={`${i}-${n.order}-${n.label}`}
                transform={`translate(${p.x} ${p.y})`}
                className={`wf-node${dimmed ? ' dimmed' : ''}${moved ? ' moved' : ''}${editable ? ' draggable' : ''}${isSelected ? ' selected' : ''}${drag?.i === i ? ' dragging' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${n.order}. ${n.label}`}
                aria-pressed={editable && onSelect !== undefined ? isSelected : undefined}
                onClick={() => onNodeClick(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onNodeClick(i)
                  }
                }}
                {...(editable
                  ? {
                      onPointerDown: (e) => onNodePointerDown(e, i),
                      onPointerMove: onNodePointerMove,
                      onPointerUp: onNodePointerUp,
                      onPointerCancel: onNodePointerUp,
                    }
                  : {})}
              >
                <rect className="wf-node-box" width={WF_NODE_W} height={WF_NODE_H} rx={10} />
                <rect className="wf-node-order-bg" x={10} y={8} width={32} height={22} rx={7} />
                <text className="wf-node-order" x={26} y={19}>
                  {n.order}
                </text>
                <text className="wf-node-label" x={52} y={22}>
                  {n.label.length > 12 ? `${n.label.slice(0, 11)}\u2026` /* … */ : n.label}
                  <title>{n.label}</title>
                </text>
                {note !== '' && (
                  <text className="wf-node-sub" x={52} y={41}>
                    {note.length > 24 ? `${note.slice(0, 23)}\u2026` /* … */ : note}
                  </text>
                )}
                {editable && (
                  <circle
                    className="wf-handle"
                    cx={WF_NODE_W}
                    cy={WF_NODE_H / 2}
                    r={7}
                    onPointerDown={(e) => onHandlePointerDown(e, i)}
                    onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp}
                    onPointerCancel={onHandlePointerUp}
                  >
                    <title>{t('workflows.graph.handleTitle')}</title>
                  </circle>
                )}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
