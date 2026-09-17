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
 * ✅ **端点已对账**（本批实施期间后端批同工作树落地）：导出走
 * `POST /api/arch/render` 的 `mode: 'from-graph'` 分支（请求体含 `mode` / `type: 'sequence'`），
 * 与 design-v10 设想的「新路径」不同——实况与理由见 `api.ts` 的 `ARCH_RENDER_ENDPOINT`。
 * 路径与 mode 常量只在该处，UI 的失败分支已全部兜住。
 */

import { useEffect, useState, type ReactNode } from 'react'

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
  RADIAL_VIEW,
  chainShape,
  chainViewH,
  chainY,
  clipLabel,
  formatLocation,
  groupAffected,
  radialPoint,
  segmentBetweenBoxes,
  sequenceExportErrorKey,
} from './graph-logic.ts'
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
  if (value.candidates !== undefined && value.candidates.length > 0) return null
  const peers = value.items.slice(0, RADIAL_MAX)
  if (peers.length === 0) return null

  const dirKey = dir === 'in' ? 'graph.mode.in' : 'graph.mode.out'
  const centerId = value.node

  return (
    <>
      <svg
        className="chain-graph"
        viewBox={`0 0 ${RADIAL_VIEW.w} ${RADIAL_VIEW.h}`}
        role="img"
        aria-label={t('graph.viz.radialAria', { dir: t(dirKey), n: peers.length })}
      >
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

        <g className="chain-node center">
          <title>{t('graph.viz.centerAria', { id: centerId })}</title>
          <rect
            x={RADIAL_CENTER.x - RADIAL_CENTER.w / 2}
            y={RADIAL_CENTER.y - RADIAL_CENTER.h / 2}
            width={RADIAL_CENTER.w}
            height={RADIAL_CENTER.h}
            rx="3"
          />
          <text x={RADIAL_CENTER.x} y={RADIAL_CENTER.y}>
            {clipLabel(centerId, 26)}
          </text>
        </g>

        {peers.map((item, index) => {
          const point = radialPoint(index, peers.length)
          const label = item.other_label !== '' ? item.other_label : item.other
          const detail = [item.kind, formatLocation(item.file, item.line)].filter((s) => s !== '').join(' · ')
          /* 悬停全文 = `标签 · id · kind · file:line`：标签在框里是被**截断**的，
             故全文必须留在这里（id 也在这里，寻址主键看得见）；链上的 `<title>` 同此口径。 */
          const full = [label, item.other, detail].filter((s) => s !== '').join(' · ')
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
                x={point.x - RADIAL_PEER.w / 2}
                y={point.y - RADIAL_PEER.h / 2}
                width={RADIAL_PEER.w}
                height={RADIAL_PEER.h}
                rx="3"
              />
              <text x={point.x} y={point.y}>
                {clipLabel(label, 16)}
              </text>
            </g>
          )
        })}
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
  // 没找到路径 / 链没解析出来：都不画图（两种情形各有既有文案，在 `PathBody` 里）
  if (!value.found || value.chain.length === 0) return null
  // 太长不画：截断的链看起来就是「到这就断了」（口径见 `graph-logic.ts` 的 `CHAIN_MAX`）
  if (value.chain.length > CHAIN_MAX) return null

  const cx = CHAIN_VIEW_W / 2
  const h = chainViewH(value.chain.length)

  return (
    <svg
      className="chain-graph"
      viewBox={`0 0 ${CHAIN_VIEW_W} ${h}`}
      role="img"
      aria-label={t('graph.viz.chainAria', { n: value.chain.length })}
    >
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

      {value.chain.map((hop, index) => (
        <g className="chain-node" key={`node|${hop}|${index}`}>
          {/* 链上节点**不可点**：`chain` 是 graphify 输出切出来的符号串，没有 id（口径见头注 2） */}
          <title>{hop}</title>
          <rect
            x={cx - CHAIN_NODE.w / 2}
            y={chainY(index) - CHAIN_NODE.h / 2}
            width={CHAIN_NODE.w}
            height={CHAIN_NODE.h}
            rx="3"
          />
          <text x={cx} y={chainY(index)}>
            {clipLabel(hop, 30)}
          </text>
        </g>
      ))}
    </svg>
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
