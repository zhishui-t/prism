import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * 星图画布（星图隐喻的底层）：可缩放、可平移的 SVG 视口。
 *
 * 设计要点：
 * - **纯 SVG + 手写变换**，零图形库（保持 Prism 零 UI 依赖）；
 * - 滚轮以光标为锚点缩放，拖拽平移；双击复位；
 * - 提供 `world → screen` 变换给上层绘制星体；
 * - 深空背景由上层 CSS 提供，这里只管坐标系与交互。
 *
 * 2026-09-14 修正（用户反馈「全屏之后显示不全」）：原先 viewBox 写死 `0 0 1000 620`，
 * 容器比 1000:620 更宽时 `preserveAspectRatio="meet"` 只保证「装得下」，
 * 于是左右（或上下）留出空带，而星云半径本来就超出视野 → 看起来被切掉。
 * 现在用 ResizeObserver 实测容器尺寸，viewBox 与中心点都跟随容器，
 * 并把「世界内容」按容器实际宽高做一次 fit —— 普通窗口与沉浸全屏用的是同一套逻辑。
 *
 * 2026-09-14 二次修正（用户反馈「光点太大还能不能拖，节点一多看不清」）：
 * 原先**落在星体上按下时不启动平移**（为避免与星体 click 打架），可星体辉光半径是核心的
 * 2.1 倍、密集时几乎铺满画布 → 用户按哪儿都「拖不动」。现改为：
 * - **任意位置按下都能拖**，靠 3px 位移阈值区分「点击」与「拖拽」；
 * - 拖拽过（位移超阈值）就吃掉随后的 `click`，避免拖完误触发下钻/选中；
 * - 画布元素上统一 `setPointerCapture`，指针移出子元素也不丢拖动。
 */

export interface Viewport {
  /** 缩放倍率 */
  k: number
  /** 平移（世界坐标 → 屏幕的偏移，单位为世界坐标） */
  x: number
  y: number
}

export interface Size {
  w: number
  h: number
}

/** 命令式入口：给画布外的缩放按钮用（滚轮之外的显式操作）。 */
export interface StarCanvasControls {
  /** 以画布中心为锚点缩放（factor > 1 放大）。 */
  zoomBy: (factor: number) => void
  /** 复位为「适配内容」的视口。 */
  reset: () => void
}

export interface StarCanvasProps {
  /** 世界坐标系宽高（内容边界） */
  width: number
  height: number
  /** 初始视口（缺省自动适配） */
  initial?: Partial<Viewport>
  /** 渲染内容（世界坐标） */
  children: (viewport: Viewport) => React.ReactNode
  /** 视口变化回调（供上层显示缩放比例） */
  onViewportChange?: (viewport: Viewport) => void
  /** 尺寸变化回调（供上层做命中测试 / 布局） */
  onSizeChange?: (size: Size) => void
  /** 点击空白处（非星体）时回调 */
  onBackgroundClick?: () => void
  /** 承接命令式缩放/复位（可选）。 */
  controls?: React.MutableRefObject<StarCanvasControls | null>
}

const MIN_K = 0.25
const MAX_K = 8
/** 位移阈值（CSS px）：小于它算「点击」，超过它算「拖拽」。 */
const DRAG_THRESHOLD = 3

/** 兜底尺寸：首帧还没量到容器时用（避免 viewBox 为 0 导致整体不可见）。 */
const FALLBACK: Size = { w: 1000, h: 620 }

/** 适配视口：把世界内容居中铺满可视区。 */
function fitViewport(width: number, height: number, size: Size): Viewport {
  // 世界坐标以画布中心为原点；视口为 size.w × size.h（1 单位 = 1 CSS px）。
  // 取宽/高两个方向都能容纳的缩放，留 6% 边距，且不超过 1.6（小数据别过度放大）
  const pad = 0.94
  const k = Math.min(1.6, Math.max(MIN_K, Math.min((size.w / width) * pad, (size.h / height) * pad)))
  return { k, x: 0, y: 0 }
}

export function StarCanvas({
  width,
  height,
  initial,
  children,
  onViewportChange,
  onSizeChange,
  onBackgroundClick,
  controls,
}: StarCanvasProps) {
  const ref = useRef<SVGSVGElement | null>(null)
  const [size, setSize] = useState<Size>(FALLBACK)
  const [vp, setVp] = useState<Viewport>(() => ({ ...fitViewport(width, height, FALLBACK), ...initial }))
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean; onBody: boolean } | null>(null)
  /** 拖拽过之后要吃掉的那一次 click（否则「拖动视图」会误触发星体下钻）。 */
  const swallowClick = useRef(false)

  // 容器尺寸（含沉浸全屏切换、浏览器窗口缩放）——实测，不猜
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      setSize((prev) =>
        Math.abs(prev.w - rect.width) < 1 && Math.abs(prev.h - rect.height) < 1
          ? prev
          : { w: rect.width, h: rect.height },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    onSizeChange?.(size)
  }, [size, onSizeChange])

  // 内容尺寸或画布尺寸变化 → 重置视口（换层 / 进退出沉浸时自动适配）。
  // 依赖刻意只含尺寸：initial 由调用方通过 key 控制（每次换层重挂载）。
  const initialRef = useRef(initial)
  useEffect(() => {
    setVp({ ...fitViewport(width, height, size), ...initialRef.current })
  }, [width, height, size.w, size.h])

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
    // 落在星体上的按下**也**启动平移；点击与拖拽靠 DRAG_THRESHOLD 区分，
    // 这样光点再密也不会「按哪儿都拖不动」。
    const onBody = (e.target as Element).closest?.('.star-body') != null
    drag.current = { sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y, moved: false, onBody }
    // 空白处按下立即捕获；**星体上要等确认是拖拽再捕获**——先捕获会把随后的
    // `click` 重定向到画布元素，星体的 onClick 就再也收不到（点不动 = 无法下钻）。
    if (!onBody) ref.current?.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current
    if (d === null) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
      d.moved = true
      setDragging(true)
      // 此刻已确定是拖拽（不是点击）→ 补上捕获，拖出画布也不丢事件
      if (d.onBody) ref.current?.setPointerCapture?.(e.pointerId)
    }
    setVp({ k: vp.k, x: d.vx + dx / vp.k, y: d.vy + dy / vp.k })
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    if (ref.current?.hasPointerCapture?.(e.pointerId) === true) ref.current.releasePointerCapture(e.pointerId)
    if (d === null) return
    // 拖拽过 → 吃掉随后那一次 click（否则「拖动视图」会误触发下钻/选中）
    if (d.moved) {
      swallowClick.current = true
      return
    }
    // 未拖动且起点不在星体上 → 视为点击空白（返回上一层/关闭详情）
    if (!d.onBody) onBackgroundClick?.()
  }

  const reset = useCallback(() => {
    setVp(fitViewport(width, height, size))
  }, [width, height, size])

  /** 以画布中心为锚点缩放：世界原点恒映射到画布中心，故 x/y 不变、只改 k。 */
  const zoomBy = useCallback((factor: number) => {
    setVp((prev) => ({ k: Math.min(MAX_K, Math.max(MIN_K, prev.k * factor)), x: prev.x, y: prev.y }))
  }, [])

  useEffect(() => {
    if (controls === undefined) return
    controls.current = { zoomBy, reset }
    return () => {
      controls.current = null
    }
  }, [controls, zoomBy, reset])

  const transform = `translate(${vp.x * vp.k} ${vp.y * vp.k}) scale(${vp.k})`

  return (
    <svg
      ref={ref}
      className="star-canvas"
      viewBox={`0 0 ${size.w} ${size.h}`}
      preserveAspectRatio="xMidYMid meet"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={reset}
      onClickCapture={(e) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.stopPropagation()
        e.preventDefault()
      }}
      style={{ cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <g transform={`translate(${size.w / 2} ${size.h / 2}) ${transform}`}>{children(vp)}</g>
    </svg>
  )
}

/** 供上层把世界坐标映射到屏幕（点击命中测试用）。 */
export function worldToScreen(vp: Viewport, size: Size, x: number, y: number): { x: number; y: number } {
  return { x: size.w / 2 + (x + vp.x) * vp.k, y: size.h / 2 + (y + vp.y) * vp.k }
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
