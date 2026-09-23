/**
 * v10 F9ui 层级探索视图：顶层社区卡片 → 下钻目录 → 下钻文件 → 文件内符号（只读出口）。
 *
 * 分工与 F5 同款：**规则在 `./explore-logic.ts`（node 可直测）、取数在本文件**。
 * 状态挂页面层（`useExplore`），因为「探索态/查询态」是同一个主区的两副面孔，
 * 切换视图不该把已经取回的层丢掉——缓存与路径都活在页面层，切回来是瞬时的。
 *
 * 四条口径（改设计时同步改这里）：
 * 1. **按需请求**：只有探索视图**可见时**才发请求（`active`），且每层每 parent 只发一次
 *    （组件内 `Map` 缓存，键含项目名）。不预渲染符号层——它由 file 卡片的「查此节点」触发。
 * 2. **三层是独立投影，不是包含树**（F9-1）：同一文件可能出现在多个社区下，
 *    `dir` 层的计数是**全图口径**。故面包屑只表达探索路径，卡片上**不渲染** `community`
 *    字段（渲染出来就等于在说「这个目录属于这个社区」），并常驻一条口径说明。
 * 3. **只有 file 卡片能「查此节点」**：`dir`/`community` 的 id 是合成 id
 *    （`dir:<路径>` / `community:<n>`），拿去四模式查询必然 404；`symbol` 层的 id 才是真实
 *    图谱节点 id。`onPickSymbol` 收到的是**真实 id**，切到查询态发四模式查询。
 * 4. **截断的真分页（v17 B-7）**：单层超 500 条时服务端给不透明 `next_cursor`，用
 *    `?cursor=` 取次页；本文件把新页**并进已取回的层**（`mergeRollupPage`），跨页边随
 *    次页补齐。图重建（游标内嵌的图版本键变）→ 服务端 409 `stale_cursor`：那时**丢弃本层
 *    已取回的页、回第一页重查**（`more` 的 409 分支），绝不把它当普通错误报给用户。
 *
 * 零新增颜色 / 零 inline 样式：全部走 `styles.css` 的 `.explore-*` / `.crumb*` 一族
 * （复用 `.list-row` / `.tool-btn` / `.seg` / `.mono` / `.small` / `.muted` 既有件）。
 */

import { useEffect, useRef, useState } from 'react'

import { api, type RollupLevel, type RollupNode, type RollupResult } from '../api.ts'
import { State } from '../components/State.tsx'
import { useT, type DictKey } from '../i18n.ts'
import type { NodePick } from './CallChainGraph.tsx'
import {
  EXPLORE_PAGE,
  EXPLORE_ROOT,
  cacheKey,
  currentCrumb,
  drillTarget,
  edgeTotals,
  isStaleCursorError,
  maxEdgeWeight,
  mergeRollupPage,
  moreAvailable,
  pageOf,
  popTo,
  pushCrumb,
  type Crumb,
} from './explore-logic.ts'

/* 方向字形（纯装饰，与 `GraphQuery.tsx` 的 ARROW_* 同源口径）：
   `→` = 从本组发出（它调用别处）；`←` = 指向本组（别处调用它）。 */
const ARROW_OUT = '\u2192'
const ARROW_IN = '\u2190'

/** 层 → 显示名（`symbol` 也在此，虽然它不在网格层里）。 */
const KIND_KEYS: Record<RollupLevel, DictKey> = {
  community: 'graph.explore.kind.community',
  dir: 'graph.explore.kind.dir',
  file: 'graph.explore.kind.file',
  symbol: 'graph.explore.kind.symbol',
}

/** 打开的符号列表（file 的出口）。 */
interface SymbolTarget {
  project: string
  /** `file:<路径>`（合成 id，服务端按同一编码反解） */
  parent: string
  /** 文件路径（人可读，来自 file 卡片的 label） */
  label: string
}

export interface ExploreController {
  /** 当前网格层（`community` / `dir` / `file`） */
  level: RollupLevel
  crumbs: readonly Crumb[]
  result: RollupResult | undefined
  loading: boolean
  /** `code: message` 原文（api.ts 的信封契约） */
  error: string
  /** 已显示的卡片数（客户端分页；点「更多」每次 +`EXPLORE_PAGE`） */
  shown: number
  /** 正在取下一页（「更多」期间禁用按钮，避免重复请求） */
  moreBusy: boolean
  symbols: SymbolTarget | undefined
  symbolsResult: RollupResult | undefined
  symbolsLoading: boolean
  symbolsError: string
  /** 点卡片：`community`/`dir` 下钻一层，`file` 打开符号列表 */
  drill: (node: RollupNode) => void
  closeSymbols: () => void
  /** 面包屑回退到第 `index` 段 */
  goTo: (index: number) => void
  more: () => void
  retry: () => void
}

/**
 * 探索状态与取数。挂在页面层（`CodeGraph.tsx`），`GraphExplore` 只做渲染。
 *
 * `active` = 探索视图当前是否可见：**唯一**的发请求闸门（切到查询态不会在后台拉数据）。
 * 路径与缓存都用**派生**方式绑项目名（`nav.project !== project` ⇒ 回到根；
 * 缓存键带项目名），故换项目不需要 reset effect——有 effect 反而会先拿旧项目的路径
 * 发一笔请求（effect 都在同一批渲染后跑，`setPath` 改不动本轮的闭包）。
 */
export function useExplore(project: string, active: boolean): ExploreController {
  const [nav, setNav] = useState<{ project: string; path: readonly Crumb[] }>({
    project,
    path: [EXPLORE_ROOT],
  })
  const [symbols, setSymbols] = useState<SymbolTarget>()
  const [store, setStore] = useState<{ key: string; result: RollupResult }>()
  const [failed, setFailed] = useState<{ key: string; message: string }>()
  const [shownAt, setShownAt] = useState<{ key: string; n: number }>()
  const [moreBusy, setMoreBusy] = useState(false)
  const [gridReload, setGridReload] = useState(0)
  const [symReload, setSymReload] = useState(0)

  const cache = useRef(new Map<string, RollupResult>())
  /** 落地守卫：序号变了 = 这一笔属于上一轮世界，结果丢弃（与 `useGraphQuery` 同款）。 */
  const seq = useRef(0)

  const path = nav.project === project ? nav.path : [EXPLORE_ROOT]
  const here = currentCrumb(path)
  const key = cacheKey(project, here.level, here.parent)

  const open = symbols !== undefined && symbols.project === project ? symbols : undefined
  const symbolKey = open !== undefined ? cacheKey(project, 'symbol', open.parent) : ''

  const read = (k: string): RollupResult | undefined =>
    store?.key === k ? store.result : cache.current.get(k)

  const result = read(key)
  /**
   * 错误位按请求键比对，**且结果到手即让位**：`failed` 是单个槽，用户在失败之后退出去、
   * 再进来时会自动重取一次——若那时旧错误仍然压在上面，就会出现「数据已到、界面还在报错」
   * （`NodeGrid` 的错误分支在前）。`retry()` 之外，这条守卫是第二道。
   */
  const error = failed?.key === key && result === undefined ? failed.message : ''
  const symbolsResult = symbolKey === '' ? undefined : read(symbolKey)
  const symbolsError =
    failed?.key === symbolKey && symbolKey !== '' && symbolsResult === undefined ? failed.message : ''

  // 两个列表共用一个 `shown` 槽（同时只有一个可见，键不同即各自从头开始）
  const activeKey = open !== undefined ? symbolKey : key
  const shown = shownAt?.key === activeKey ? shownAt.n : EXPLORE_PAGE
  /** 当前可见的层（符号列表打开时是它，否则是网格层）——`more` 要据此取 `next_cursor`。 */
  const activeLayer = open !== undefined ? symbolsResult : result

  useEffect(() => {
    if (!active) return
    if (cache.current.has(key)) return
    const token = ++seq.current
    // 新一次尝试开始 → 清掉**这一层**的旧错误（其余层的错误不动）：于是重取期间显示的是
    // 骨架而不是「正在报错」，与「还没问到 / 正在问 / 问失败」三态各自可辨
    setFailed((f) => (f?.key === key ? undefined : f))
    const params: { project: string; level: RollupLevel; parent?: string } = { project, level: here.level }
    if (here.parent !== null) params.parent = here.parent
    void api.graphRollup(params).then(
      (value) => {
        if (token !== seq.current) return
        cache.current.set(key, value)
        setStore({ key, result: value })
      },
      (e: unknown) => {
        if (token !== seq.current) return
        setFailed({ key, message: e instanceof Error ? e.message : String(e) })
      },
    )
  }, [active, project, key, here.level, here.parent, gridReload])

  useEffect(() => {
    if (!active || open === undefined) return
    if (cache.current.has(symbolKey)) return
    const token = ++seq.current
    setFailed((f) => (f?.key === symbolKey ? undefined : f))
    void api.graphRollup({ project, level: 'symbol', parent: open.parent }).then(
      (value) => {
        if (token !== seq.current) return
        cache.current.set(symbolKey, value)
        setStore({ key: symbolKey, result: value })
      },
      (e: unknown) => {
        if (token !== seq.current) return
        setFailed({ key: symbolKey, message: e instanceof Error ? e.message : String(e) })
      },
    )
  }, [active, project, symbolKey, open, symReload])

  const drill = (node: RollupNode): void => {
    const next = drillTarget(here.level)
    // 已到最深：`symbol` 层的出口是切到查询态，不在这里再下钻
    if (next === null) return
    if (next === 'symbol') {
      setSymbols({ project, parent: node.id, label: node.label })
      return
    }
    setNav({ project, path: pushCrumb(path, here.level, node) })
  }

  const goTo = (index: number): void => {
    setSymbols(undefined)
    setNav({ project, path: popTo(path, index) })
  }

  /**
   * 点「更多」（v17 B-7 真分页）：
   * - 本地还有没显示的 → 纯切片（不发请求）；
   * - 本地翻完了、服务端还有下一页 → 用 `next_cursor` 取次页并**并进本层**；
   * - 收到 409 `stale_cursor`（翻页途中图被重建）→ **丢弃本层已取回的页、回第一页重查**，
   *   不把它当普通错误报给用户（重建期翻页会重复/漏项，只有重查能收敛）。
   */
  const more = (): void => {
    const layer = activeLayer
    if (layer === undefined || moreBusy) return
    const target = shown + EXPLORE_PAGE
    if (target <= layer.nodes.length || layer.next_cursor === undefined) {
      setShownAt({ key: activeKey, n: target })
      return
    }
    const token = ++seq.current
    setMoreBusy(true)
    // 本层重取期间显示骨架而不是「正在报错」（同主取数 effect 的口径）
    setFailed((f) => (f?.key === activeKey ? undefined : f))
    void api.graphRollup({ project, cursor: layer.next_cursor }).then(
      (page) => {
        // 先解锁：即便这一笔已被更新的世界取代，也不该把「更多」按钮永久卡在禁用态
        setMoreBusy(false)
        if (token !== seq.current) return
        const merged = mergeRollupPage(layer, page)
        cache.current.set(activeKey, merged)
        setStore({ key: activeKey, result: merged })
        setShownAt({ key: activeKey, n: target })
      },
      (e: unknown) => {
        setMoreBusy(false)
        if (token !== seq.current) return
        const message = e instanceof Error ? e.message : String(e)
        if (isStaleCursorError(message)) {
          // 图已重建：本层的页全部作废，清缓存 + 重置已显示数 → 回第一页重取
          cache.current.delete(activeKey)
          setStore(undefined)
          setShownAt(undefined)
          if (open !== undefined) setSymReload((n) => n + 1)
          else setGridReload((n) => n + 1)
          return
        }
        setFailed({ key: activeKey, message })
      },
    )
  }

  return {
    level: here.level,
    crumbs: path,
    result,
    // 「在拉」= 可见 + 没结果 + 没错误（缓存命中在渲染期就已拿到，不会闪一下骨架）
    loading: active && result === undefined && error === '',
    error,
    shown,
    moreBusy,
    symbols: open,
    symbolsResult,
    symbolsLoading: active && open !== undefined && symbolsResult === undefined && symbolsError === '',
    symbolsError,
    drill,
    closeSymbols: () => setSymbols(undefined),
    goTo,
    more,
    retry: () => {
      setFailed(undefined)
      if (open !== undefined) setSymReload((n) => n + 1)
      else setGridReload((n) => n + 1)
    },
  }
}

/** 层级探索视图（主区的「探索」态）。 */
export function GraphExplore({ c, onPickSymbol }: { c: ExploreController; onPickSymbol: NodePick }) {
  const t = useT()
  return (
    <div className="explore-wrap swap-in">
      {/* 面包屑只表达**探索路径**（三层是独立投影，不是包含树） */}
      <nav className="crumb" aria-label={t('graph.explore.crumbAria')}>
        {c.crumbs.map((crumb, index) => {
          const last = index === c.crumbs.length - 1
          const label = crumb.label === '' ? t('graph.explore.root') : crumb.label
          return (
            <span className="crumb-cell" key={`${crumb.level}|${crumb.parent ?? ''}|${index}`}>
              {index > 0 && (
                <span className="crumb-sep" aria-hidden="true">
                  {'\u203a'}
                </span>
              )}
              {last ? (
                <span className="crumb-here" aria-current="page">
                  {label}
                </span>
              ) : (
                <button type="button" className="crumb-back" onClick={() => c.goTo(index)}>
                  {label}
                </button>
              )}
            </span>
          )
        })}
      </nav>
      <div className="small muted explore-note">{t('graph.explore.note')}</div>

      {c.symbols !== undefined ? (
        <SymbolList c={c} onPickSymbol={onPickSymbol} />
      ) : (
        <NodeGrid c={c} />
      )}
    </div>
  )
}

function NodeGrid({ c }: { c: ExploreController }) {
  const t = useT()
  if (c.loading) return <State loading />
  if (c.error !== '') return <FailedBlock message={t('graph.explore.failed', { msg: c.error })} onRetry={c.retry} />
  const result = c.result
  if (result === undefined) return null
  if (result.nodes.length === 0) return <div className="small muted">{t('graph.explore.empty')}</div>

  const totals = edgeTotals(result.edges)
  const max = maxEdgeWeight(result.edges)
  const visible = pageOf(result.nodes, c.shown)
  // `file` 层的下一层是 `symbol` = 「查此节点」（只读出口），其余层是「再下钻一层」
  const opens = drillTarget(result.level) === 'symbol'

  return (
    <>
      <div className="explore-grid">
        {visible.map((node) => {
          const total = totals.get(node.id)
          const strong = total !== undefined && total.in + total.out > 0
          return (
            <button
              key={node.id}
              type="button"
              className="explore-card"
              aria-label={t('graph.explore.cardAria', {
                level: t(KIND_KEYS[node.kind]),
                label: node.label,
                n: node.symbol_count,
              })}
              onClick={() => c.drill(node)}
            >
              <span className="explore-kind">{t(KIND_KEYS[node.kind])}</span>
              <span className="mono explore-label">{node.label}</span>
              <span className="small muted">{t('graph.explore.symbols', { n: node.symbol_count })}</span>
              {opens && <span className="explore-open">{t('graph.explore.open')}</span>}
              {strong && (
                <span
                  className="small muted explore-weight"
                  title={t('graph.explore.weightHint', { out: total.out, in: total.in, max })}
                >
                  {/* 只写非零的那一侧：`→3 ←0` 的 `←0` 是噪音，方向感由字形给 */}
                  {[total.out > 0 ? `${ARROW_OUT}${total.out}` : '', total.in > 0 ? `${ARROW_IN}${total.in}` : '']
                    .filter((part) => part !== '')
                    .join(' ')}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <MoreRow
        c={c}
        loaded={result.nodes.length}
        layerTotal={result.total}
        truncated={result.truncated}
        nextCursor={result.next_cursor}
      />
    </>
  )
}

function SymbolList({ c, onPickSymbol }: { c: ExploreController; onPickSymbol: NodePick }) {
  const t = useT()
  const open = c.symbols
  if (open === undefined) return null
  const shown = c.symbolsResult === undefined ? [] : pageOf(c.symbolsResult.nodes, c.shown)

  return (
    <div className="explore-symbols">
      <div className="pane-head">
        <h3>{t('graph.explore.symbolsTitle', { file: open.label })}</h3>
        <span className="spacer">
          <button type="button" className="tool-btn" onClick={c.closeSymbols}>
            {t('graph.explore.back')}
          </button>
        </span>
      </div>
      {c.symbolsLoading ? (
        <State loading />
      ) : c.symbolsError !== '' ? (
        <FailedBlock message={t('graph.explore.failed', { msg: c.symbolsError })} onRetry={c.retry} />
      ) : (
        <>
          {shown.map((node) => (
            /* 点符号 = 切到查询态对它发四模式查询（这里给的是**真实图谱节点 id**） */
            <button
              key={node.id}
              type="button"
              className="list-row explore-symbol"
              onClick={() => onPickSymbol(node.id, node.label)}
            >
              <span className="mono explore-label">{node.label}</span>
              <span className="mono small muted explore-symbol-id">{node.id}</span>
            </button>
          ))}
          {c.symbolsResult !== undefined && (
            <MoreRow
              c={c}
              loaded={c.symbolsResult.nodes.length}
              layerTotal={c.symbolsResult.total}
              truncated={c.symbolsResult.truncated}
              nextCursor={c.symbolsResult.next_cursor}
            />
          )}
        </>
      )}
    </div>
  )
}

/**
 * 分页行 + 截断说明（v17 B-7）。
 *
 * 「更多」现在**可能发请求**：本地还有没显示的（`shown < loaded`）就先切片；本地翻完了、
 * 服务端还有下一页（`nextCursor`）才用游标取次页（判定在 `moreAvailable`）。两者都没有即
 * 不渲染按钮。按钮在取页期间 `disabled`（`c.moreBusy`）。
 *
 * `loaded`（服务端已取回并被并进本层的条数）与 `layerTotal`（本层全量条数）在未截断时
 * 相等；截断说明要同时说清「共多少」与「已加载多少」。
 */
function MoreRow({
  c,
  loaded,
  layerTotal,
  truncated,
  nextCursor,
}: {
  c: ExploreController
  loaded: number
  layerTotal: number
  truncated: boolean
  nextCursor: string | undefined
}) {
  const t = useT()
  return (
    <>
      {moreAvailable(loaded, c.shown, nextCursor) && (
        <div className="explore-more">
          <button type="button" className="tool-btn" onClick={c.more} disabled={c.moreBusy}>
            {t('graph.explore.more', { shown: c.shown, total: layerTotal })}
          </button>
        </div>
      )}
      {truncated && (
        <div className="small muted explore-truncated">
          {t('graph.explore.truncated', { total: layerTotal, loaded })}
        </div>
      )}
    </>
  )
}

function FailedBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT()
  return (
    <div className="act-bar err" role="alert">
      <span>{message}</span>
      <span className="row">
        <button type="button" className="tool-btn" onClick={onRetry}>
          {t('common.retry')}
        </button>
      </span>
    </div>
  )
}
