import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * 星图画布（图书馆隐喻的底层）：可缩放、可平移的 SVG 视口。
 *
 * 设计要点：
 * - **纯 SVG + 手写变换**，零图形库（保持 Prism 零 UI 依赖）；
 * - 滚轮以光标为锚点缩放，拖拽平移；双击复位；
 * - 提供 `world → screen` 变换给上层绘制星体；
 * - 深空背景由上层 CSS 提供，这里只管坐标系与交互。
 */

export interface Viewport {
  /** 缩放倍率 */
  k: number
  /** 平移（世界坐标 → 屏幕的偏移，单位为世界坐标） */
  x: number
  y: number
}

export interface StarCanvasProps {
  /** 世界坐标系宽高（内容边界） */
  width: number
  height: number
  /** 初始视口（缺省自动适配） */
  initial?: Partial<Viewport>
  /** 画布高度（CSS 像素），缺省 620 */
  viewHeight?: number
  /** 渲染内容（世界坐标） */
  children: (viewport: Viewport) => React.ReactNode
  /** 视口变化回调（供上层显示缩放比例） */
  onViewportChange?: (viewport: Viewport) => void
  /** 点击空白处（非星体）时回调 */
  onBackgroundClick?: () => void
}

const MIN_K = 0.25
const MAX_K = 8

/** 适配视口：把世界内容居中铺满可视区。 */
function fitViewport(width: number, height: number, viewHeight: number): Viewport {
  // 世界坐标以画布中心为原点；视口为 1000×viewHeight。
  // 取宽/高两个方向都能容纳的缩放，留 6% 边距，且不超过 1.6（小数据别过度放大）
  const pad = 0.94
  const k = Math.min(1.6, Math.max(MIN_K, Math.min((1000 / width) * pad, (viewHeight / height) * pad)))
  return { k, x: 0, y: 0 }
}

export function StarCanvas({
  width,
  height,
  initial,
  viewHeight = 620,
  children,
  onViewportChange,
  onBackgroundClick,
}: StarCanvasProps) {
  const ref = useRef<SVGSVGElement | null>(null)
  const [vp, setVp] = useState<Viewport>(() => ({ ...fitViewport(width, height, viewHeight), ...initial }))
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean; onBody: boolean } | null>(null)

  // 内容尺寸变化 → 重置视口（换层时自动适配）。
  // 依赖刻意只含尺寸：initial 由调用方通过 key 控制（每次换层重挂载）。
  const initialRef = useRef(initial)
  useEffect(() => {
    setVp({ ...fitViewport(width, height, viewHeight), ...initialRef.current })
  }, [width, height, viewHeight])

  useEffect(() => {
    onViewportChange?.(vp)
  }, [vp, onViewportChange])

  /** 滚轮缩放：以光标为锚点。 */
  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault()
      const el = ref.current
      if (el === null) return
      const rect = el.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      // 光标对应的世界坐标（缩放前）
      const wx = (sx - rect.width / 2) / vp.k - vp.x
      const wy = (sy - rect.height / 2) / vp.k - vp.y
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      const k = Math.min(MAX_K, Math.max(MIN_K, vp.k * factor))
      // 保持光标下的世界点不动：x' = (sx - w/2)/k' - wx
      setVp({ k, x: (sx - rect.width / 2) / k - wx, y: (sy - rect.height / 2) / k - wy })
    },
    [vp],
  )

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return
    // 命中星体时不启动平移（否则星体的 click 会被 backgroundClick 抵消/触发两次）
    const onBody = (e.target as Element).closest?.('.star-body') !== null
    drag.current = { sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y, moved: false, onBody }
    if (!onBody) (e.target as Element).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current
    if (d === null || d.onBody) return
    const dx = (e.clientX - d.sx) / vp.k
    const dy = (e.clientY - d.sy) / vp.k
    if (Math.abs(e.clientX - d.sx) > 3 || Math.abs(e.clientY - d.sy) > 3) d.moved = true
    setVp({ k: vp.k, x: d.vx + dx, y: d.vy + dy })
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current
    drag.current = null
    if (d !== null && !d.onBody) (e.target as Element).releasePointerCapture?.(e.pointerId)
    // 未拖动且起点不在星体上 → 视为点击空白（返回上一层/关闭详情）
    if (d !== null && !d.moved && !d.onBody) onBackgroundClick?.()
  }

  const reset = useCallback(() => {
    setVp(fitViewport(width, height, viewHeight))
  }, [width, height, viewHeight])

  const transform = `translate(${vp.x * vp.k} ${vp.y * vp.k}) scale(${vp.k})`

  return (
    <svg
      ref={ref}
      className="star-canvas"
      viewBox={`0 0 1000 ${viewHeight}`}
      preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onDoubleClick={reset}
      style={{ cursor: drag.current !== null ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <g transform={`translate(500 ${viewHeight / 2}) ${transform}`}>{children(vp)}</g>
    </svg>
  )
}

/** 供上层把世界坐标映射到屏幕（点击命中测试用）。 */
export function worldToScreen(vp: Viewport, viewHeight: number, x: number, y: number): { x: number; y: number } {
  return { x: 500 + (x + vp.x) * vp.k, y: viewHeight / 2 + (y + vp.y) * vp.k }
}

/** 视口 Hook：给需要感知缩放的组件用。 */
export function useViewportZoom(): [Viewport, (v: Viewport) => void] {
  const [vp, setVp] = useState<Viewport>({ k: 1, x: 0, y: 0 })
  return [vp, setVp]
}

/** 确定性伪随机（星点/星云位置，避免每次渲染跳动）。 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

/** 生成深空星点（背景装饰）。 */
export function useStarfield(count: number, width: number, height: number): Array<{ x: number; y: number; r: number; o: number }> {
  return useMemo(() => {
    const rand = seededRandom(20260910)
    return Array.from({ length: count }, () => ({
      x: rand() * width,
      y: rand() * height,
      r: 0.4 + rand() * 1.4,
      o: 0.15 + rand() * 0.6,
    }))
  }, [count, width, height])
}
