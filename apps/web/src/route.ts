/**
 * hash 深链（本仓无路由库，也不引入）。
 *
 * 形态：`#/<page>[/<sel>][?k=v&k2=v2]`。
 * - `#/roles/dev-1`、`#/teams/core-dev`、`#/skills/prism`、`#/knowledge`；
 * - v7 新增 **query 段**：`#/knowledge/prism?q=检索&layer=global&book=handbook`
 *   （供 knowledge 的单框双语义 `?q/?layer/?owner/?book`，以及 teams/skills 的 Ref 落点）；
 * - 刷新 / 分享链接 / 浏览器前进后退都保留位置；
 * - 未选实体时只到页（`#/roles`，可带 query：`#/teams?sel=core-dev`）；
 * - 空 hash 或未知路径 → 知识库首页；**已删页面（如 `#/tasks`）走同一条兜底**——
 *   它不在 `PAGES` 里，`PAGES.find` 未命中即回落 `DEFAULT_PAGE`，无需额外回落代码。
 *
 * **解析顺序（v7 契约）**：先按 `?` 切出 query 段，**再**按 `/` 切路径段——
 * 反过来会把 `?q=a/b` 里的 `/` 当成实体分隔符，实体名被切碎。
 */

import { useSyncExternalStore } from 'react'

import type { PageKey } from './nav.ts'

export interface Route {
  page: PageKey
  /** 选中实体（角色名 / 团队 id / 技能名）；无 = 未选 */
  sel?: string
  /**
   * query 段（`?k=v`）。**无参 = undefined**（不是空对象）——
   * 既有构造点 `{ page }` / `{ page, sel }` 因此零改动。
   * 取值统一走 {@link queryOf}，写值走 {@link withQuery}。
   */
  query?: Readonly<Record<string, string>>
}

const PAGES: readonly PageKey[] = ['knowledge', 'graph', 'projects', 'roles', 'teams', 'skills']
const DEFAULT_PAGE: PageKey = 'knowledge'
/**
 * 支持「页/实体」两段的页面。
 * `graph` 的实体是**项目名**（`#/graph/<project>`，§3.5）——未命中时页内回落第一个项目
 * 并 `replace` 修正 hash（design-v7 §2.5，不进历史）。
 */
const WITH_SEL: readonly PageKey[] = ['knowledge', 'roles', 'teams', 'skills', 'graph']

/**
 * 宽松解码：畸形 `%` 序列（`100%`、`%E4`、`%zz`）原样透传，**不抛**。
 *
 * hash 是用户可编辑输入（`?q=` 更是可分享链接，K5 鼓励手输/粘贴），而
 * {@link currentRoute} 是 `useSyncExternalStore` 的 getSnapshot —— 裸
 * `decodeURIComponent` 抛 `URIError` 会掀掉整棵 React 树（全仓无 ErrorBoundary）。
 * 只吞 `URIError`（解码失败），其余异常照常上抛。
 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 解析 query 段：空串 / 全空键 → undefined。值可缺省（`?q` → `q: ''`）。 */
function parseQuery(raw: string): Record<string, string> | undefined {
  if (raw === '') return undefined
  const out: Record<string, string> = {}
  for (const part of raw.split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    if (key === '') continue
    out[safeDecode(key)] = eq === -1 ? '' : safeDecode(part.slice(eq + 1))
  }
  return Object.keys(out).length === 0 ? undefined : out
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').trim()
  if (raw === '') return { page: DEFAULT_PAGE }
  // 先切 `?`（query 段）再切 `/`（路径段）——见文件头「解析顺序」契约。
  const qIndex = raw.indexOf('?')
  const pathPart = qIndex === -1 ? raw : raw.slice(0, qIndex)
  const query = parseQuery(qIndex === -1 ? '' : raw.slice(qIndex + 1))
  const [head, ...rest] = pathPart.split('/')
  const page = PAGES.find((p) => p === head)
  if (page === undefined) return { page: DEFAULT_PAGE }
  const attachQuery = (r: Route): Route => (query === undefined ? r : { ...r, query })
  const sel = rest.join('/').trim()
  if (sel === '' || !WITH_SEL.includes(page)) return attachQuery({ page })
  return attachQuery({ page, sel: safeDecode(sel) })
}

/**
 * 读 query（**永不 undefined**，便于 `queryOf(route)['q']` 直取）。
 * 返回副本：调用方改它不会污染缓存里的路由对象。
 */
export function queryOf(route: Route): Record<string, string> {
  return route.query === undefined ? {} : { ...route.query }
}

/**
 * 写 query：返回**新** Route（不改入参）。
 * `undefined` 或 `''` 的值 = 删除该键；结果为空则不带 `query` 字段（回到 `{ page }` 形态）。
 */
export function withQuery(route: Route, patch: Record<string, string | undefined>): Route {
  const next = queryOf(route)
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete next[key]
    else next[key] = value
  }
  const base: Route =
    route.sel !== undefined && route.sel !== '' ? { page: route.page, sel: route.sel } : { page: route.page }
  return Object.keys(next).length === 0 ? base : { ...base, query: next }
}

/** 生成 hash（`#/roles/dev-1?tab=kb`）。 */
export function hrefOf(route: Route): string {
  const path =
    route.sel !== undefined && route.sel !== ''
      ? `#/${route.page}/${encodeURIComponent(route.sel)}`
      : `#/${route.page}`
  const parts = Object.entries(route.query ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return parts.length === 0 ? path : `${path}?${parts.join('&')}`
}

/**
 * 快照缓存 —— **必须**做到「同一 hash 返回同一对象引用」。
 *
 * `useSyncExternalStore` 用 `Object.is` 比较快照：若每次返回新解析出的对象，
 * 它会在每次渲染后都判定「快照变了」→ 触发重渲染 → 再次判定变化 → **无限循环**
 * （React 抛 Minified error #185，整页空白）。所以按 hash 串缓存解析结果。
 *
 * ⚠ v7 加了 query 段后本机制**不变**：缓存键仍是**完整 hash 串**（含 `?...`），
 * 所以 query 变化同样走「换键 → 重新解析」这条路径，不会退化成陈旧快照。
 */
let cachedHash: string | null = null
let cachedRoute: Route = { page: DEFAULT_PAGE }
const SSR_ROUTE: Route = { page: DEFAULT_PAGE }

export function currentRoute(): Route {
  if (typeof window === 'undefined') return SSR_ROUTE
  const hash = window.location.hash
  if (hash !== cachedHash) {
    cachedHash = hash
    cachedRoute = parseHash(hash)
  }
  return cachedRoute
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener)
  return () => window.removeEventListener('hashchange', listener)
}

/** 读当前路由并订阅变化。 */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, currentRoute, () => SSR_ROUTE)
}

/**
 * 导航到某路由。
 * `replace` 用于「补默认选中」这类不该进历史的动作（如首次自动选中第一个项目）。
 */
export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const next = hrefOf(route)
  if (window.location.hash === next) return
  if (opts.replace === true) {
    window.history.replaceState(null, '', next)
    // replaceState 不触发 hashchange，手动广播一次
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    return
  }
  window.location.hash = next
}

export { DEFAULT_PAGE }
