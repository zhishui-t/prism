/**
 * F4 调用链查询：查询区**四模式**骨架 + 结构化结果渲染。
 *
 * 为什么单开一个文件：查询区从「一个自由文本框 + graphify 原样输出」变成
 * 「模式（谁调用它 / 它调用谁 / A→B 调用链 / 改动影响谁）+ 关系类型 + 结果列表」，
 * 而结果面板由图谱页主区另外摆放（`CodeGraph.tsx`，与查询卡不同 DOM 父节点 ——
 * F8 前那个「Studio 分栏」已随 iframe 一起退役），
 * 故这里把「状态 + 两个渲染件」收在一处，`CodeGraph.tsx` 只做摆放。
 *
 * 契约：`design-v8.md §2 F4`（含审核修订 #3/#10）与
 * `apps/web/src/api.ts` 的 `GraphRelations` / `GraphPath` / `GraphAffected`。
 *
 * 三条口径写死在这里（改设计时同步改这里）：
 * - **寻址一律用 id**：`other` 是节点 id，`other_label` 只作渲染；点对端符号追问时
 *   查询框回填 label、请求传 id（label 不唯一：本仓 2340 节点仅 2063 个唯一 label）。
 * - **多义不是错误**：服务端回 `total:0, items:[], candidates:[…]`（200），
 *   这里渲染候选清单让用户二次寻址。
 * - **file:line 是文本不是链接**：控制台没有源码查看器，不做假链接。
 *
 * 视觉：只用既有类（`.seg` / `.list-row` / `.tag` / `.rel-link` / `.act-bar` / `.mono`）
 * 与 `styles.css` 里本文件新增的 `graph-rel-*` 布局类，**不新增颜色与字号档**。
 *
 * 2026-09-17（v10 F5）：结果区加**调用链图**（零依赖 SVG，`./CallChainGraph.tsx`）与
 * **时序图导出**（`POST /api/arch/render` 的 `mode=from-graph` 分支，契约见 `api.ts` 的
 * `ARCH_RENDER_ENDPOINT` / `ARCH_RENDER_MODE_FROM_GRAPH`）。
 * 落点取舍：`relations` / `path` 两档图与**精确行清单并存**（图答「形状」，清单答「到底有哪些」，
 * 清单不截断且有 kind + file:line）；`affected` 一档**只有图**——它的「图」本身就是分组列表，
 * 再加一份同义清单就是同一份数据的两次呈现。纯函数（形状判据 / 布局 / 分组 / 导出寻址 /
 * 错误码映射）全在 `./graph-logic.ts`，`formatLocation` 亦随之迁走。
 *
 * 2026-09-17（v10 F9ui）：加 `pickSymbol` —— 层级探索里点「文件内符号」也走这一处查询状态。
 * 它**不复用** `drill`：`drill` 按当前模式分派，而探索态下用户可能正停在 path/affected 档，
 * 那时 `drill` 直接 return（点了没反应）；也不能先 `setMode` 再 `drill`（同 tick 闭包里的
 * `mode` 还是旧值）。故它直接落到 relations 执行体并把 chip 拨回「谁调用它」。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  api,
  type GraphAffected,
  type GraphPath,
  type GraphRelationCandidate,
  type GraphRelationDir,
  type GraphRelations,
} from '../api.ts'
import { useT, type DictKey } from '../i18n.ts'
import { CallChainGraph, SequenceExport } from './CallChainGraph.tsx'
import { formatLocation, sequenceTarget } from './graph-logic.ts'

/* 方向字形（纯装饰，集中定义避免散落在模板串里被当成内容读）：
   `←` = 入边（对端 → 当前节点，即「谁调用它」）；`→` = 出边（当前节点 → 对端）。 */
const ARROW_IN = '\u2190'
const ARROW_OUT = '\u2192'

export type GraphQueryMode = 'in' | 'out' | 'path' | 'affected'

/** 两个 relations 模式（`dir=in|out`）——与 path/affected 的分界，也是 `dir` 的类型来源。 */
function isRelationsMode(mode: GraphQueryMode): mode is GraphRelationDir {
  return mode === 'in' || mode === 'out'
}

interface ModeDef {
  id: GraphQueryMode
  labelKey: DictKey
}

/** 四模式（顺序即 chips 顺序；与 task-brief-v8 F4 的四问一一对应）。 */
export const GRAPH_MODES: readonly ModeDef[] = [
  { id: 'in', labelKey: 'graph.mode.in' },
  { id: 'out', labelKey: 'graph.mode.out' },
  { id: 'path', labelKey: 'graph.mode.path' },
  { id: 'affected', labelKey: 'graph.mode.affected' },
]

/** 契约缺省的关系白名单（design-v8 §2：「谁调用它/它调用谁」默认 `calls,invokes`）。 */
export const DEFAULT_RELATION = 'calls,invokes'

/**
 * 关系类型候选 —— **写死枚举，来源是实测数据**：
 * 本仓 `graphify-out/graph.json`（2026-09-16：2340 节点 / 7103 边）里出现过的
 * `relation` 取值，按频次降序——calls 1964 / contains 1848 / imports 1388 /
 * re_exports 876 / imports_from 535 / method 213 / references 161 /
 * indirect_call 77 / dynamic_import 36 / inherits 3 / implements 2。
 *
 * 服务端按边的 `relation` **原值精确匹配**做白名单过滤（`packages/server/src/http/routes/graph.ts`
 * 的 `parseRelationFilter`），没有「列出关系类型」的接口，故此处枚举是前端唯一真相源；
 * 别的图可能多出别的取值（如 `invokes`——本仓没有），会落进「全部关系」这一档。
 * 空串 = **不传 `relation` 参数** = 不过滤。
 */
export const RELATION_CHOICES: ReadonlyArray<{ id: string; labelKey: DictKey }> = [
  { id: DEFAULT_RELATION, labelKey: 'graph.rel.callsInvokes' },
  { id: '', labelKey: 'graph.rel.all' },
  { id: 'calls', labelKey: 'graph.rel.calls' },
  { id: 'contains', labelKey: 'graph.rel.contains' },
  { id: 'imports', labelKey: 'graph.rel.imports' },
  { id: 're_exports', labelKey: 'graph.rel.reExports' },
  { id: 'imports_from', labelKey: 'graph.rel.importsFrom' },
  { id: 'method', labelKey: 'graph.rel.method' },
  { id: 'references', labelKey: 'graph.rel.references' },
  { id: 'indirect_call', labelKey: 'graph.rel.indirectCall' },
  { id: 'dynamic_import', labelKey: 'graph.rel.dynamicImport' },
  { id: 'inherits', labelKey: 'graph.rel.inherits' },
  { id: 'implements', labelKey: 'graph.rel.implements' },
]

export type GraphQueryResult =
  | { kind: 'relations'; dir: GraphRelationDir; value: GraphRelations }
  | { kind: 'path'; value: GraphPath }
  | { kind: 'affected'; value: GraphAffected }

export interface GraphQueryController {
  project: string
  mode: GraphQueryMode
  /** 关系类型候选 id（逗号分隔白名单或空串=全部） */
  relation: string
  node: string
  /** path 模式的终点 */
  to: string
  busy: boolean
  /** `code: message` 原文（api.ts 的信封契约）已包进 i18n 文案 */
  error: string
  result: GraphQueryResult | undefined
  setMode: (mode: GraphQueryMode) => void
  setRelation: (relation: string) => void
  setNode: (node: string) => void
  setTo: (to: string) => void
  run: () => void
  /** 点对端符号追问：以 `other`（id）重查，查询框回填 label，模式与 dir 不变 */
  drill: (other: string, label: string) => void
  /** 多义候选：以该 id 重查 */
  pickCandidate: (candidate: GraphRelationCandidate) => void
  /** 层级探索来的「查此节点」：**强制切到「谁调用它」**再以该 id 查（见实现处注释） */
  pickSymbol: (id: string, label: string) => void
  clear: () => void
}

/**
 * 查询状态与动作。挂在页面层（`CodeGraph.tsx`），查询卡与结果面板各取所需。
 *
 * 换项目清空结果与错误：否则新项目下先看到上一个项目的结果（串台）。
 */

/** 落地口：`withBusy` 交给任务的「写 state」通道——序号已被作废则静默丢弃。 */
type Land = (apply: () => void) => void

export function useGraphQuery(project: string): GraphQueryController {
  const t = useT()
  const [mode, setModeState] = useState<GraphQueryMode>('in')
  const [relation, setRelation] = useState<string>(DEFAULT_RELATION)
  const [node, setNode] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<GraphQueryResult>()

  useEffect(() => {
    setResult(undefined)
    setError('')
  }, [project])

  /**
   * 请求守卫（MIN-3）。两处串台同源——「响应落地时世界已经变了」：
   *  - 双击 Enter / 连点提交 → 两笔并发，后到者覆盖先到者；
   *  - 查询在途切模式 chip → 旧 `kind` 的响应画在新模式的 chips 下（面板按 `result.kind` 渲染）。
   * 故提交一律占一个**单调序号**（`seqRef`），落地前比对 `token !== seqRef.current` 即弃。
   * `busyRef` 是 `busy` 的同步镜像：`useState` 在同一个事件里还没重渲染，拿它做门会漏掉
   * 同 tick 的第二次提交（Enter 与按钮共用 `run()` 这一处提交口，门只此一道）。
   */
  const seqRef = useRef(0)
  const busyRef = useRef(false)

  /**
   * 作废在途查询：结果不再落地，**且立刻归还 busy**——否则「在途切模式」会把提交口锁到旧请求
   * 落地为止（守卫只挡串台，不挡正常查询）。
   */
  const invalidate = (): void => {
    seqRef.current += 1
    busyRef.current = false
    setBusy(false)
  }

  /**
   * 请求在途的三态收口：先清旧结果（避免「新查询在跑、旧结果还挂着」），失败落 `error`。
   * `land` 是**唯一落地口**——只有本次提交仍是最新（序号未被后续提交 / 切模式作废）时才写 state。
   */
  const withBusy = async (task: (land: Land) => Promise<void>): Promise<void> => {
    const token = ++seqRef.current
    const land: Land = (apply) => {
      if (token === seqRef.current) apply()
    }
    setError('')
    setResult(undefined)
    setBusy(true)
    busyRef.current = true
    try {
      await task(land)
    } catch (e) {
      land(() => setError(t('graph.queryFailed', { msg: e instanceof Error ? e.message : String(e) })))
    } finally {
      // 已被作废的请求不再归还 busy（它属于上一轮世界，交还等于替新请求收口）
      if (token === seqRef.current) {
        busyRef.current = false
        setBusy(false)
      }
    }
  }

  /** 关系白名单参数：空串 = 不传（= 全部关系，语义见 `RELATION_CHOICES`）。 */
  const relationParam = (): { relation?: string } => (relation === '' ? {} : { relation })

  const runRelations = (ref: string, dir: GraphRelationDir): Promise<void> =>
    withBusy(async (land) => {
      const value = await api.graphRelations({ project, node: ref, dir, ...relationParam() })
      land(() => setResult({ kind: 'relations', dir, value }))
    })

  /**
   * **唯一提交口**（查询钮的 `onClick` 与两个输入框的 Enter 都走这里）：在途一律忽略——
   * 不排队、不报错，也不重复起第二笔。查询钮的 `disabled` 是同一件事的视觉面（不是门本身）。
   */
  const run = (): void => {
    if (busyRef.current) return
    const ref = node.trim()
    if (ref === '') {
      setError(t('graph.queryEmpty'))
      setResult(undefined)
      return
    }
    if (mode === 'path') {
      const target = to.trim()
      if (target === '') {
        setError(t('graph.path.empty'))
        setResult(undefined)
        return
      }
      void withBusy(async (land) => {
        const value = await api.graphPath({ project, from: ref, to: target })
        land(() => setResult({ kind: 'path', value }))
      })
      return
    }
    if (mode === 'affected') {
      void withBusy(async (land) => {
        const value = await api.graphAffected({ project, node: ref })
        land(() => setResult({ kind: 'affected', value }))
      })
      return
    }
    void runRelations(ref, mode)
  }

  const drill = (other: string, label: string): void => {
    if (!isRelationsMode(mode)) return
    // 查询框联动为 label（人可读），请求仍传 id（唯一寻址）
    setNode(label !== '' ? label : other)
    void runRelations(other, mode)
  }

  const pickCandidate = (candidate: GraphRelationCandidate): void => {
    drill(candidate.id, candidate.label)
  }

  /**
   * v10 F9ui：层级探索里点「文件内符号」= 对这个**真实节点 id** 发四模式查询。
   *
   * 不复用 `drill`——它按**当前模式**分派，而用户可能是在 path/affected 档切去探索的，
   * 那时 `drill` 直接 return（点了没反应）。也不能写成「先 `setMode('in')` 再 `drill`」：
   * `setMode` 改的是 state，同一个事件闭包里读到的 `mode` 还是旧值。
   * 故这里直接落到 relations 的执行体，并同步把模式 chip 拨到「谁调用它」——
   * 查询框回填 label、请求传 id 的口径与 `drill` 完全一致。
   */
  const pickSymbol = (id: string, label: string): void => {
    setModeState('in')
    setNode(label !== '' ? label : id)
    void runRelations(id, 'in')
  }

  const setMode = (next: GraphQueryMode): void => {
    if (next === mode) return
    setModeState(next)
    // 换模式 = 换结果形状，留着上一个模式的渲染会误导；在途查询**一并作废**
    // （否则旧 kind 的响应会落在新模式的 chips 下）
    invalidate()
    setResult(undefined)
    setError('')
  }

  const clear = (): void => {
    setResult(undefined)
    setError('')
  }

  return {
    project,
    mode,
    relation,
    node,
    to,
    busy,
    error,
    result,
    setMode,
    setRelation,
    setNode,
    setTo,
    run,
    drill,
    pickCandidate,
    pickSymbol,
    clear,
  }
}

/** 查询卡：模式 chips + 关系类型 + 输入行（+ path 的终点输入）。 */
export function GraphQueryCard({ q }: { q: GraphQueryController }) {
  const t = useT()
  const relations = isRelationsMode(q.mode)
  const placeholder = q.mode === 'path' ? t('graph.path.from') : t('graph.nodeInput')

  return (
    <div className="pane graph-query-card swap-in">
      <h3>{t('graph.query')}</h3>

      <div className="row graph-query-modes">
        <span className="small muted">{t('graph.mode.label')}</span>
        <div className="seg" role="group" aria-label={t('graph.mode.label')}>
          {GRAPH_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={q.mode === m.id ? 'active' : ''}
              aria-pressed={q.mode === m.id}
              onClick={() => q.setMode(m.id)}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
        {relations && (
          <>
            <span className="small muted">{t('graph.rel.label')}</span>
            <select
              className="grow"
              value={q.relation}
              aria-label={t('graph.rel.label')}
              onChange={(e) => q.setRelation(e.target.value)}
            >
              {RELATION_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {t(choice.labelKey)}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <div className="row" style={{ marginTop: 'var(--s-2)' }}>
        <input
          className="grow"
          placeholder={placeholder}
          aria-label={placeholder}
          value={q.node}
          onChange={(e) => q.setNode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') q.run()
          }}
        />
        {q.mode === 'path' && (
          <input
            className="grow"
            placeholder={t('graph.path.to')}
            aria-label={t('graph.path.to')}
            value={q.to}
            onChange={(e) => q.setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') q.run()
            }}
          />
        )}
        <button onClick={q.run} disabled={q.project === '' || q.busy} aria-busy={q.busy}>
          {t('graph.query')}
        </button>
      </div>

      {q.busy && (
        <div className="small muted" style={{ marginTop: 'var(--s-2)' }}>
          {t('graph.querying')}
        </div>
      )}

      {/* 错误就地落在动作正下方（沿用 `.act-bar.err` 口径）：查询失败/未输入都在这里 */}
      {q.error !== '' && (
        <div className="act-bar err" role="alert" style={{ marginTop: 'var(--s-2)', marginBottom: 0 }}>
          {q.error}
        </div>
      )}
    </div>
  )
}

/**
 * 结果面板（由 `CodeGraph.tsx` 摆在图谱页主区）。
 *
 * 无结果时不渲染任何东西（返回 null），保持主区全宽——与改造前「有结果才出面板」一致。
 *
 * v10 F5：`body` 里先出**调用链图**，再出该模式专属的精确清单（口径见文件头注）。
 * 导出条（`SequenceExport`）夹在面板头与结果之间：它作用于**当前结果**，不属于结果本身。
 */
export function GraphResultPanel({ q }: { q: GraphQueryController }) {
  const t = useT()
  if (q.result === undefined) return null
  const { result } = q

  let body: ReactNode
  let head: ReactNode = null
  if (result.kind === 'relations') {
    const { value, dir } = result
    const truncated = value.items.length < value.total
    head = (
      <span className="small muted">
        {truncated
          ? t('graph.rel.showing', { shown: value.items.length, total: value.total })
          : t('graph.rel.total', { n: value.total })}
      </span>
    )
    body = (
      <>
        <CallChainGraph result={result} onNodePick={q.drill} />
        <RelationsBody value={value} dir={dir} onDrill={q.drill} onPick={q.pickCandidate} />
      </>
    )
  } else if (result.kind === 'path') {
    head = result.value.found ? (
      <span className="small muted">
        {result.value.hops !== null ? t('graph.path.hops', { n: result.value.hops }) : ''}
      </span>
    ) : null
    body = (
      <>
        <CallChainGraph result={result} onNodePick={q.drill} />
        <PathBody value={result.value} />
      </>
    )
  } else {
    head = (
      <span className="small muted">
        {t('graph.affected.count', { n: result.value.nodes.length })}
        {result.value.depth !== null ? ` · ${t('graph.affected.depth', { n: result.value.depth })}` : ''}
      </span>
    )
    // affected 只出图：它的图就是「按关系分组的受影响节点列表」，再加一份同义清单没有新信息
    body = <CallChainGraph result={result} onNodePick={q.drill} />
  }

  return (
    <div className="query-panel swap-in">
      <div className="query-panel-head">
        <span className="small muted">{t('graph.queryResult')}</span>
        {head}
        <button className="tool-btn" onClick={q.clear}>
          {t('common.close')}
        </button>
      </div>
      {/* 导出寻址载荷从当前结果里取（唯一取处）：relations → 单点 id；path → 链上 id 数组；
          拿不到就禁用并说明原因，不拿 label 顶替。v17 W-9① */}
      <SequenceExport project={q.project} target={sequenceTarget(result)} />
      <div className="query-result graph-rel-list">{body}</div>
    </div>
  )
}

function RelationsBody({
  value,
  dir,
  onDrill,
  onPick,
}: {
  value: GraphRelations
  dir: GraphRelationDir
  onDrill: (other: string, label: string) => void
  onPick: (candidate: GraphRelationCandidate) => void
}) {
  const t = useT()

  // 多义：不是错误，是「再问一次选哪个」。候选可能上百条（1 字符前缀），故容器限高滚动。
  if (value.candidates !== undefined && value.candidates.length > 0) {
    return (
      <div className="graph-cand">
        <div className="small muted">{t('graph.rel.ambiguous', { n: value.candidates.length })}</div>
        <div className="graph-cand-list">
          {value.candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="list-row"
              onClick={() => onPick(candidate)}
            >
              <span className="mono">{candidate.label}</span>
              <span className="mono small muted">{candidate.id}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="small muted graph-rel-node">
        {t('graph.rel.resolved', { id: value.node })}
      </div>
      {value.items.length === 0 ? (
        <div className="small muted">{t('graph.rel.empty')}</div>
      ) : (
        value.items.map((item, index) => {
          const location = formatLocation(item.file, item.line)
          const label = item.other_label !== '' ? item.other_label : item.other
          return (
            <div className="list-row graph-rel-row" key={`${item.other}|${item.kind}|${location}|${index}`}>
              <span
                className="graph-rel-dir"
                role="img"
                title={t(dir === 'in' ? 'graph.rel.arrowIn' : 'graph.rel.arrowOut')}
                aria-label={t(dir === 'in' ? 'graph.rel.arrowIn' : 'graph.rel.arrowOut')}
              >
                {dir === 'in' ? ARROW_IN : ARROW_OUT}
              </span>
              {/* 对端符号：点它 = 以该节点为新起点追问（传 id，回填 label）。
                  链接质感沿用既有 `.rel-link`（零新增颜色，mono 亦由它给）。 */}
              <button type="button" className="rel-link graph-rel-peer" onClick={() => onDrill(item.other, label)}>
                {label}
              </button>
              {item.kind !== '' && <span className="tag">{item.kind}</span>}
              {location !== '' && <span className="mono small muted graph-rel-loc">{location}</span>}
            </div>
          )
        })
      )}
    </>
  )
}

function PathBody({ value }: { value: GraphPath }) {
  const t = useT()
  if (!value.found) {
    return <div className="small muted">{t('graph.path.none')}</div>
  }
  // 服务端从 graphify 的 `-->` 行切链；找到了路径却切不出节点时**不谎报「没有路径」**
  if (value.chain.length === 0) {
    return <div className="small muted">{t('graph.path.unparsed')}</div>
  }
  return (
    <div className="mono graph-chain">
      {value.chain.map((hop, index) => (
        <span key={`${hop.id}|${index}`}>
          {index > 0 ? ` ${ARROW_OUT} ` : ''}
          {hop.label}
        </span>
      ))}
    </div>
  )
}

/**
 * 受影响节点列表 → **v10 F5 已并入 `./CallChainGraph.tsx` 的 `AffectedGroups`**
 * （该模式在 F5 里的呈现就是「按关系分组的列表图」）。
 *
 * 从那里继承的既有裁决：**不可点击**——`/api/graph/affected` 只回 label（没有 id），
 * 而 label 不唯一，拿它当寻址主键会查错节点。要追问请用「谁调用它/它调用谁」两档
 * （那里回的是 id）。
 */
