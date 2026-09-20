/**
 * v10 F5 调用链图化：**零依赖 SVG 组件**（纯 `<svg>` + React，不引任何图库）。
 *
 * 形状随响应走三档（判据在 `./graph-logic.ts` 的 `chainShape`，组件把它挂成 `data-shape`）：
 * - `relations`（谁调用它 / 它调用谁）→ **中心-辐射图**：当前节点居中、关系节点环绕；
 *   箭头**朝向**编码方向（出边箭头落在对端、入边箭头落回中心），两个方向各配一色；
 * - `path`（A→B 调用链）→ **纵向链路图**：节点自上而下、段间画箭头；
 * - `affected`（改动影响谁）→ **分组列表**：该响应只有 `{label, relation, location}`，
 *   没有 id、没有图结构，画成图只会是装饰——故按 `relation` 分组列出，不硬画。
 *
 * 四条口径：
 * 1. **数据全部来自既有四模式响应**（组件零后端改动；形状适配只在本文件 + `graph-logic.ts`）；
 * 2. **可点的节点必须带 id**：只有 `relations` 的 `node` / `items[].other` 是 id（唯一寻址）。
 *    `path.chain` 与 `affected.nodes[].label` 只是 label——按 label 寻址会落到多义
 *    （本仓 2340 节点仅 2063 个唯一 label），故那些节点**只渲染、不可点**
 *    （与 `AffectedBody` 既有裁决同源），不假装能跳；
 * 3. **零新增颜色 / 零 inline 样式**：方向色、节点底色、字族字号全部走 `styles.css` 的
 *    `.chain-*` 一族（值取既有 token）；几何（viewBox 坐标）由 `graph-logic.ts` 按数据算出；
 * 4. **图中不画半条链 / 不编方向**：链超过 `CHAIN_MAX` 跳时整图不画（截断的链看起来就是
 *    终点，是假信息），`affected` 无方向字段时按 `relation` 分组——两处的理由写在
 *    `graph-logic.ts` 的对应函数头注里。
 *
 * 时序图导出（F5）：见本文件末尾的 `SequenceExport`。
 *
 * v12 F1（缩放平移）：`relations` / `path` 两档的 SVG 包在 `ZoomPane` 里（`affected` 是列表语义，
 * 不启用——SPEC-1.7）。缩放平移只改内层 `<g transform>`，viewBox 与 `preserveAspectRatio`
 * 都不动；几何与换算全在 `graph-logic.ts` 的纯函数里（组件只负责量容器、挂事件）。
 *
 * v15 W-1（容器 resize 重 fit）：`useZoom` 带 `pristine` 标志——未手动缩放时容器 resize
 * 重新适配（防抖 `REFIT_DEBOUNCE_MS`），wheel / 拖拽 / ± 缩放过则保持用户视口；判定与
 * 时长常量在 `graph-logic.ts`（`shouldRefitOnResize` / `REFIT_DEBOUNCE_MS`）。
 *
 * ✅ **端点已对账**（本批实施期间后端批同工作树落地）：导出走
 * `POST /api/arch/render` 的 `mode: 'from-graph'` 分支（请求体含 `mode` / `type: 'sequence'`），
 * 与 design-v10 设想的「新路径」不同——实况与理由见 `api.ts` 的 `ARCH_RENDER_ENDPOINT`。
 * 路径与 mode 常量只在该处，UI 的失败分支已全部兜住。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SVGProps } from 'react'

import {
  api,
  type GraphAffected,
  type GraphPath,
  type GraphRelationDir,
  type GraphRelations,
} from '../api.ts'
import { CountLine } from '../components/CountLine.tsx'
import { useT } from '../i18n.ts'
import {
  CHAIN_MAX,
  CHAIN_NODE,
  CHAIN_VIEW_W,
  RADIAL_CENTER,
  RADIAL_MAX,
  RADIAL_PEER,
  REFIT_DEBOUNCE_MS,
  ZOOM_STEP,
  annotationLine,
  annotationVisible,
  chainBoxes,
  chainShape,
  chainY,
  clipLabel,
  contentViewBox,
  fitTransform,
  formatLocation,
  groupAffected,
  panBy,
  radialBoxes,
  radialPoint,
  segmentBetweenBoxes,
  sequenceExportErrorKey,
  shouldRefitOnResize,
  transformAttr,
  userTransform,
  viewBoxAttr,
  zoomAt,
  zoomPercent,
  zoomRatio,
} from './graph-logic.ts'
import type { Rect, Size, ZoomTransform } from './graph-logic.ts'
import type { GraphQueryResult } from './GraphQuery.tsx'

/**
 * 点节点 = 以**该节点的 id** 追问（label 只作查询框回填与显示）。
 * 与 `GraphQueryController.drill(other, label)` 同签名——本组件不自己发请求，
 * 联动（模式 / dir / 关系白名单的保持）全在既有 `drill` 里。
 */
export type NodePick = (id: string, label: string) => void

/**
 * 结果形状 → 图（F5 主体）。
 *
 * 面板里**只有 affected 由本组件独立承担**（它就是「分组列表图」）；relations / path 两档
 * 本组件只画 SVG，精确行清单仍由 `GraphQuery.tsx` 的既有渲染件承担（那里有不截断的
 * kind + file:line 与多义候选）——两者互补，不是同一份数据的两次呈现：
 * 图回答「形状」，清单回答「到底有哪些」。
 */
export function CallChainGraph({ result, onNodePick }: { result: GraphQueryResult; onNodePick: NodePick }) {
  return (
    <div className="chain-graph-wrap swap-in" data-shape={chainShape(result.kind)}>
      {body(result, onNodePick)}
    </div>
  )
}

function body(result: GraphQueryResult, onNodePick: NodePick): ReactNode {
  switch (result.kind) {
    case 'relations':
      return <RadialDiagram value={result.value} dir={result.dir} onNodePick={onNodePick} />
    case 'path':
      return <ChainDiagram value={result.value} />
    case 'affected':
      return <AffectedGroups value={result.value} />
  }
}

/* ===== 缩放平移（v12 F1 / SPEC-1.1–1.8） ===== */

/** 未测量时的容器盒（happy-dom 下 `getBoundingClientRect()` 恒为 0；真机首帧布局前也是 0）。 */
const NO_BOX: Size = { w: 0, h: 0 }

interface Zoom {
  /** SPEC-1.8：倍率 ≥ 1.5 → 节点 `<text>` 追加 `id · file:line` 第二行。 */
  annotate: boolean
  /** 内层 `<g>` 的 transform（**用户坐标**；fit 态 = `translate(0 0) scale(1)`，见 `userTransform`）。 */
  transform: string
  /** 挂到 `<svg>` 上的 props（ref / 类名 / wheel / pointer）；调用方把 viewBox / role / aria 写在它**后面**。 */
  svgProps: SVGProps<SVGSVGElement>
  /** 工具条：放大 / 缩小 / 适应窗口（SPEC-1.4/1.5）。 */
  toolbar: ReactNode
}

/**
 * 缩放平移（v12 F1）：`relations` / `path` 两档共用；`affected` 是列表语义，**不挂**（SPEC-1.7）。
 *
 * 分工：本 hook 只管「量容器、挂事件、给属性和工具条」，换算（fit / 指针锚 / clamp / 归一化）
 * 全在 `graph-logic.ts` 的纯函数里——happy-dom 量不到盒（恒 0），纯函数以显式尺寸入参才测得动。
 *
 * 状态 `view` 的单位是**元素像素**：内容点 v → 屏幕 `view.scale · v + view.tx`。
 * 初始态与「适应窗口」都取 `fitTransform(量到的盒, viewBox)`——**不是**写死的 1/0/0：
 * 那组数由「容器与内容双向比取 min + 居中」算出，窗口尺寸或内容一变就重算
 * （`userTransform` 里解释了写进 `<g>` 时为什么还要归一化一次）。
 */
function useZoom(vb: Rect): Zoom {
  const t = useT()
  const ref = useRef<SVGSVGElement | null>(null)
  const [box, setBox] = useState<Size>(NO_BOX)
  const [view, setView] = useState<ZoomTransform>(() => fitTransform(NO_BOX, vb))
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /**
   * v15 W-1（SPEC-5.1/5.2，S-8）：用户是否**从未**手动改变视口。
   *
   * `true` ⇒ 容器 resize 时重新适配（初始态跟随窗口尺寸，SPEC-5.1）；
   * `false` ⇒ resize 不打扰（用户手动定下的视口是对 resize 的明确选择，SPEC-5.2）。
   * **清**它恰好三处：wheel / 拖拽平移 / ± 按钮；**重置回 true** 两处：`refit`（适应窗口
   * 按钮）与内容切换（下面的 vbKey effect）。用 ref 而非 state：ResizeObserver 回调要读
   * **当下**值，而它不该触发重渲染、更不该进订阅依赖。
   */
  const pristine = useRef(true)

  /** 元素自身那条 meet 映射：「适应窗口」的答案就是它，归一化 `<g transform>` 也拿它当基准。 */
  const fit = fitTransform(box, vb)
  /** 内容换了（viewBox 变）就得重新适应窗口——旧图的缩放平移不该带到新图上。 */
  const vbKey = viewBoxAttr(vb)

  /** 量当前元素盒；量不到（未布局 / happy-dom）→ `NO_BOX`，下游纯函数给单位映射兜底。 */
  const measure = (): Size => {
    const rect = ref.current?.getBoundingClientRect()
    return rect === undefined ? NO_BOX : { w: rect.width, h: rect.height }
  }

  /**
   * 适应窗口（SPEC-1.4 / v15 W-1）：**当下**重新量一遍再算 fit——窗口尺寸变了也按现在的算；
   * 同时回到「未手动缩放」态（此后 resize 又该跟随容器，SPEC-5.2 的重置入口之一）。
   */
  const refit = (): void => {
    pristine.current = true
    const next = measure()
    setBox(next)
    setView(fitTransform(next, vb))
  }

  useLayoutEffect(() => {
    /* v15 W-1：内容换了就回到「未手动缩放」态——旧图的缩放平移不该带到新图上，此后容器
       resize 也该重新适配（SPEC-5.2 的另一个重置入口）。`refit` 自己会重置 pristine，
       量盒与算 fit 与旧实现逐字一致。 */
    refit()
    // ⚠ 依赖只写 vbKey：`vb` 每次渲染都是新对象，进依赖会每次渲染重跑
  }, [vbKey])

  /**
   * v15 W-1（SPEC-5.1–5.3）：容器尺寸变化 → **仅 pristine 时**重算 fit；防抖 `REFIT_DEBOUNCE_MS`
   * 内多次触发合并为一次（拖窗口边缘会连发几十次 resize）。
   *
   * ⚠ **能力探测**（不是平台判断——红线）：环境不给 `ResizeObserver` 就干脆不挂，缩放平移的
   * 其余功能照常。注：happy-dom 的 `ResizeObserver` 是**空实现**（`observe()` 不做事、回调永不
   * 触发），故 DOM 层测试要么注入假观察器、要么根本不触发；换算与「是否 refit」的决策都在
   * `graph-logic.ts` 的纯函数里，这里只接线。
   *
   * ⚠ 依赖只写 vbKey：`refit` 读的 `measure()` 取当下盒、`vb` 与 vbKey 一一对应，故该闭包
   * 在两次 vbKey 之间恒为最新；若把 box.w/h 也列进依赖，会变成「观察 → refit → 重建观察器
   * → 新观察器又投递初始尺寸」的自激循环。容器在空态/有图之间切换时 vbKey 必然改变，
   * 覆盖了「元素后出现」的挂载时机。
   */
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    if (typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (!shouldRefitOnResize(pristine.current)) return
        refit()
      }, REFIT_DEBOUNCE_MS)
    })
    ro.observe(el)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      ro.disconnect()
    }
  }, [vbKey])

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    /* ⚠ **原生** `addEventListener` + `{ passive: false }`：React 合成 `onWheel` 是 passive 的，
       `preventDefault()` 在里面不生效（SPEC-1.2 明确要「页面不滚」）。倍率 1.1× / ÷1.1 与指针锚
       都在纯函数里；这里只把指针位置换算成元素盒坐标。 */
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      // v15 W-1：滚轮缩放 = 手动改变视口 ⇒ 清 pristine（此后 resize 不再自动拉回 fit）
      pristine.current = false
      const rect = el.getBoundingClientRect()
      setView((cur) =>
        zoomAt(
          cur,
          e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          fit,
        ),
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [vbKey, box.w, box.h])

  /** 按钮缩放以**容器中心**为锚：只有滚轮才有指针位置（键盘用户也拿得到可预期的一步）。 */
  const step = (factor: number): void => {
    // v15 W-1：± 也是手动改变视口 ⇒ 清 pristine（漏了它，点过按钮后 resize 会把视口拉回 fit）
    pristine.current = false
    setView((cur) => zoomAt(cur, factor, { x: box.w / 2, y: box.h / 2 }, fit))
  }

  const endDrag = (): void => {
    drag.current = null
    setDragging(false)
  }

  const pct = zoomPercent(view, fit)

  return {
    annotate: annotationVisible(zoomRatio(view, fit)),
    transform: transformAttr(userTransform(view, fit)),
    toolbar: (
      /* SPEC-1.5：± 走原生 `<button>`（可聚焦，Enter / Space 天然可触发）；百分比只读 */
      <div className="chain-zoom" role="group" aria-label={t('graph.zoom.label')}>
        <button type="button" className="tool-btn" onClick={() => step(1 / ZOOM_STEP)}>
          {t('graph.zoom.out')}
        </button>
        <button type="button" className="tool-btn" onClick={() => step(ZOOM_STEP)}>
          {t('graph.zoom.in')}
        </button>
        <button type="button" className="tool-btn" onClick={refit}>
          {t('graph.zoom.fit')}
        </button>
        <span className="small muted chain-zoom-pct" title={t('graph.zoom.current', { pct })}>
          {pct}%
        </span>
      </div>
    ),
    svgProps: {
      ref,
      className: dragging ? 'chain-graph dragging' : 'chain-graph',
      /* 拖拽平移（SPEC-1.3，pointer 事件：按下 → 移动 → 抬起）。`touch-action: none` 写在
         styles.css 上（触控不被浏览器抢去滚页面）；页面滚动不受影响——这里不碰 document。 */
      onPointerDown: (e) => {
        if (e.button !== 0) return
        // 从可点节点上起手不算拖拽：那是「以该 id 追问」的点击目标
        if ((e.target as Element).closest?.('[role="button"]') != null) return
        drag.current = { x: e.clientX, y: e.clientY }
        setDragging(true)
        try {
          ref.current?.setPointerCapture(e.pointerId)
        } catch {
          /* 指针捕获不是所有环境都给（happy-dom、非活跃指针）：退化成容器内跟手，功能不减 */
        }
      },
      onPointerMove: (e) => {
        const from = drag.current
        if (from === null) return
        const dx = e.clientX - from.x
        const dy = e.clientY - from.y
        from.x = e.clientX
        from.y = e.clientY
        // v15 W-1：**真正发生平移**才算手动改视口（原地按下-抬起不清 pristine）
        if (dx !== 0 || dy !== 0) pristine.current = false
        setView((cur) => panBy(cur, dx, dy))
      },
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  }
}

/* ===== 中心-辐射（relations） ===== */

function RadialDiagram({
  value,
  dir,
  onNodePick,
}: {
  value: GraphRelations
  dir: GraphRelationDir
  onNodePick: NodePick
}) {
  const t = useT()
  // 多义：还没有「命中的节点」，没有中心可画（候选清单由面板既有 UI 承担）
  const ambiguous = value.candidates !== undefined && value.candidates.length > 0
  const peers = ambiguous ? [] : value.items.slice(0, RADIAL_MAX)
  /* v12 F1：viewBox 随**节点几何包围盒**走（不再取固定的 `RADIAL_VIEW`）——固定小画布
     在宽容器里被整图等比放大（节点气泡化、空边大）正是用户感知的「比例问题」。
     框坐标与本组 box 同源，避免「画的框」与「算的盒」两处口径分叉。 */
  const boxes = radialBoxes(peers.length)
  const centerBox = boxes[0]!
  const vb = contentViewBox(boxes)
  // 检视 M-1：useZoom 须无条件调用（Rules of Hooks）——置于早退之前；空输入由
  // contentViewBox 的退化盒 + fitTransform 的单位映射兜底，早退分支不渲染任何图形。
  const zoom = useZoom(vb)
  if (ambiguous) return null
  if (peers.length === 0) return null

  const dirKey = dir === 'in' ? 'graph.mode.in' : 'graph.mode.out'
  const centerId = value.node

  return (
    <>
      {zoom.toolbar}
      <svg
        {...zoom.svgProps}
        viewBox={viewBoxAttr(vb)}
        role="img"
        aria-label={t('graph.viz.radialAria', { dir: t(dirKey), n: peers.length })}
      >
        {/* v12 F1：缩放平移只动这一层 `<g>`（viewBox 与 preserveAspectRatio 都不动，SPEC-1.1） */}
        <g className="chain-zoom-layer" transform={zoom.transform}>
          <defs>
            {/* 两个标记分开定义：`marker` 的上下文不继承被引用元素的 `currentColor`，
                故箭头各自的填充色只能由类给（值仍是 styles.css 的 token）。 */}
            <marker
              id="chain-arrow-out"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path className="chain-arrow out" d="M0,0 L8,4 L0,8 z" />
            </marker>
            <marker
              id="chain-arrow-in"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path className="chain-arrow in" d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>

          {peers.map((item, index) => {
            const point = radialPoint(index, peers.length)
            /* 箭头朝向 = 方向：出边（本节点 → 对端）从中心画到对端，箭头落对端；
               入边（对端 → 本节点）**反向画**，箭头落回中心——`orient="auto"` 只认路径
               行进方向，故方向不能靠 marker-start/end 表达，得靠端点顺序（**框也跟着换**）。
               两端各退到节点框外（`segmentBetweenBoxes`）：不退的话箭头会被节点框盖住。 */
            const outward = dir === 'out'
            const line = segmentBetweenBoxes(
              outward ? RADIAL_CENTER : point,
              outward ? RADIAL_CENTER : RADIAL_PEER,
              outward ? point : RADIAL_CENTER,
              outward ? RADIAL_PEER : RADIAL_CENTER,
            )
            return (
              <line
                key={`edge|${item.other}|${index}`}
                className={`chain-edge ${dir}`}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                markerEnd={`url(#chain-arrow-${dir})`}
              />
            )
          })}

          {/* 中心节点**没有** file/line 数据（响应里只有 id）——故不画第二行（SPEC-1.8「不猜」） */}
          <g className="chain-node center">
            <title>{t('graph.viz.centerAria', { id: centerId })}</title>
            <rect
              x={centerBox.x}
              y={centerBox.y}
              width={centerBox.w}
              height={centerBox.h}
              rx="3"
            />
            <text x={RADIAL_CENTER.x} y={RADIAL_CENTER.y}>
              {clipLabel(centerId, 26)}
            </text>
          </g>

          {peers.map((item, index) => {
            const point = radialPoint(index, peers.length)
            const box = boxes[index + 1]!
            const label = item.other_label !== '' ? item.other_label : item.other
            const detail = [item.kind, formatLocation(item.file, item.line)].filter((s) => s !== '').join(' · ')
            /* 悬停全文 = `标签 · id · kind · file:line`：标签在框里是被**截断**的，
               故全文必须留在这里（id 也在这里，寻址主键看得见）；链上的 `<title>` 同此口径。 */
            const full = [label, item.other, detail].filter((s) => s !== '').join(' · ')
            // SPEC-1.8：倍率 ≥ 1.5 才画第二行；数据里没有 file/line 就返回 null（不编造）
            const annotation = annotationLine(item.other, item.file, item.line)
            return (
              <g
                key={`node|${item.other}|${index}`}
                className="chain-node pick"
                tabIndex={0}
                role="button"
                aria-label={
                  detail === ''
                    ? t('graph.viz.pickAria', { name: label })
                    : `${t('graph.viz.pickAria', { name: label })} · ${detail}`
                }
                onClick={() => onNodePick(item.other, label)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onNodePick(item.other, label)
                  }
                }}
              >
                {/* `<title>` 与 aria-label 同源：标签被截断时全文仍可读（SVG 无 title 属性） */}
                <title>{full}</title>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx="3"
                />
                <text x={point.x} y={point.y}>
                  {clipLabel(label, 16)}
                  {/* 第二行**不截断**（不过 `clipLabel`）：R-1 要的正是「放大后看清 file:line」 */}
                  {zoom.annotate && annotation !== null && (
                    <tspan x={point.x} dy="1.15em">
                      {annotation}
                    </tspan>
                  )}
                </text>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="chain-legend">
        <span className="chain-key center">
          <span className="chain-dot" aria-hidden="true" />
          {t('graph.viz.center')}
        </span>
        <span className={`chain-key ${dir}`}>
          <span className="chain-dot" aria-hidden="true" />
          {t(dirKey)}
        </span>
      </div>
      {/* 图中只画前 N 个：说清楚，别让「少了几个」看起来像「只有这几个」 */}
      {value.total > peers.length && (
        <div className="small muted">{t('graph.viz.more', { shown: peers.length, total: value.total })}</div>
      )}
    </>
  )
}

/* ===== 纵向链路（path） ===== */

function ChainDiagram({ value }: { value: GraphPath }) {
  const t = useT()
  // 没找到路径 / 链没解析出来：都不画图（两种情形各有既有文案，在 `PathBody` 里）；
  // 太长不画：截断的链看起来就是「到这就断了」（口径见 `graph-logic.ts` 的 `CHAIN_MAX`）
  const drawable = value.found && value.chain.length > 0 && value.chain.length <= CHAIN_MAX
  /* v12 F1：viewBox 随**节点几何包围盒**走（不再取固定的 `CHAIN_VIEW_W` × 手算高度）——
     链越长包围盒越高，宽容器下不再整图放大。 */
  const boxes = chainBoxes(drawable ? value.chain.length : 0)
  const vb = contentViewBox(boxes)
  // 检视 M-1：useZoom 须无条件调用（Rules of Hooks）——置于早退之前；空链由
  // contentViewBox 的退化盒 + fitTransform 的单位映射兜底，早退分支不渲染任何图形。
  const zoom = useZoom(vb)
  if (!drawable) return null

  const cx = CHAIN_VIEW_W / 2

  return (
    <>
      {zoom.toolbar}
      <svg
        {...zoom.svgProps}
        viewBox={viewBoxAttr(vb)}
        role="img"
        aria-label={t('graph.viz.chainAria', { n: value.chain.length })}
      >
        {/* v12 F1：缩放平移只动这一层 `<g>`（viewBox 与 preserveAspectRatio 都不动，SPEC-1.1） */}
        <g className="chain-zoom-layer" transform={zoom.transform}>
          <defs>
            <marker
              id="chain-arrow-down"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="8"
              markerHeight="8"
              orient="auto"
            >
              <path className="chain-arrow down" d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>

          {value.chain.slice(0, -1).map((hop, index) => {
            // 段端点同样退到节点框外（不退箭头会被框盖住），自上而下
            const line = segmentBetweenBoxes(
              { x: cx, y: chainY(index) },
              CHAIN_NODE,
              { x: cx, y: chainY(index + 1) },
              CHAIN_NODE,
            )
            return (
              <line
                key={`hop|${hop}|${index}`}
                className="chain-edge down"
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                markerEnd="url(#chain-arrow-down)"
              />
            )
          })}

          {/* 链上节点**没有**第二行可画：`chain` 是 graphify 切出来的符号串，无 id、无 file:line
              （SPEC-1.8「不猜」）——缩放只改比例，不凭空造标注 */}
          {value.chain.map((hop, index) => {
            const box = boxes[index]!
            return (
              <g className="chain-node" key={`node|${hop}|${index}`}>
                {/* 链上节点**不可点**：`chain` 是 graphify 输出切出来的符号串，没有 id（口径见头注 2） */}
                <title>{hop}</title>
                <rect x={box.x} y={box.y} width={box.w} height={box.h} rx="3" />
                <text x={cx} y={chainY(index)}>
                  {clipLabel(hop, 30)}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </>
  )
}

/* ===== 分组列表（affected） ===== */

function AffectedGroups({ value }: { value: GraphAffected }) {
  const t = useT()
  if (value.nodes.length === 0) {
    return <div className="small muted">{t('graph.affected.none')}</div>
  }
  return (
    <div className="chain-groups">
      {groupAffected(value.nodes).map((group) => (
        <div className="chain-group" key={group.relation === '' ? '(none)' : group.relation}>
          <CountLine
            size="section"
            label={group.relation === '' ? t('graph.affected.other') : group.relation}
            count={group.items.length}
          />
          {group.items.map((node, index) => (
            <div className="list-row graph-rel-row" key={`${node.label}|${node.relation}|${index}`}>
              {/* 不可点：`affected` 只回 label（没有 id），拿 label 当寻址主键会查错节点 */}
              <span className="mono graph-rel-peer">{node.label}</span>
              {node.relation !== '' && <span className="tag">{node.relation}</span>}
              {node.location !== null && node.location !== '' && (
                <span className="mono small muted graph-rel-loc">{node.location}</span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/* ===== 导出时序图（F5） ===== */

/**
 * 「导出时序图」按钮：**按需触发 + 点击后禁用至响应**（archify 子进程渲染，秒级）。
 *
 * 成功 → `window.open(preview)` 新标签打开（`noopener`：新页拿不到本页的 `window.opener`）。
 * 失败 → 留在按钮下方（`.act-bar.err`）：`bad_request` 的两条「边」类抛错 + `project_root_missing`
 * 映成人话（见 `graph-logic.ts` 的 `sequenceExportErrorKey`），其余码**原文透出**（不吞错）。
 * 拿不到寻址 id（`address === undefined`）时按钮禁用并在 `title` 里说明原因——
 * 不拿 label 顶替（那是 F5-2 明确禁止的「按名寻根」）。
 *
 * 端点：`POST /api/arch/render` 的 `mode: 'from-graph'` 分支（常量与对账结论见
 * `api.ts` 的 `ARCH_RENDER_ENDPOINT`）。
 */
export function SequenceExport({ project, address }: { project: string; address: string | undefined }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 换结果 / 换项目即清错误：上一条的报错画在新结果下面会误导
  useEffect(() => {
    setError('')
  }, [address, project])

  const run = async (): Promise<void> => {
    if (address === undefined || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.archRenderFromGraph({ project, node: address })
      window.open(result.preview, '_blank', 'noopener')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const key = sequenceExportErrorKey(msg)
      setError(key !== null ? t(key) : t('graph.seq.failed', { msg }))
    } finally {
      setBusy(false)
    }
  }

  const noId = address === undefined

  return (
    <div className="graph-seq-bar">
      <div className="row">
        <button
          className="tool-btn"
          onClick={() => void run()}
          disabled={noId || busy}
          aria-busy={busy}
          title={noId ? t('graph.seq.noId') : undefined}
        >
          {busy ? t('graph.seq.busy') : t('graph.seq.action')}
        </button>
        <span className="small muted">{t('graph.seq.note')}</span>
      </div>
      {error !== '' && (
        <div className="act-bar err" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
