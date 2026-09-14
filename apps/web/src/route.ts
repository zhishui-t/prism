/**
 * hash 深链（本仓无路由库，也不引入）。
 *
 * 形态：`#/roles/dev-1`、`#/teams/core-dev`、`#/skills/prism`、`#/knowledge`。
 * - 刷新 / 分享链接 / 浏览器前进后退都保留位置；
 * - 未选实体时只到页（`#/roles`）；
 * - 空 hash 或未知路径 → 知识库首页。
 *
 * 与 `NavTarget` 的关系：`NavTarget` 是「页内跳转意图」（带 role/team 展开），
 * 本模块是它的 URL 表示——两者同源，Shell 用 route 驱动，页面照旧收 `nav`。
 */

import { useSyncExternalStore } from 'react'

import type { PageKey } from './nav.ts'

export interface Route {
  page: PageKey
  /** 选中实体（角色名 / 团队 id / 技能名）；无 = 未选 */
  sel?: string
}

const PAGES: readonly PageKey[] = ['knowledge', 'graph', 'projects', 'roles', 'teams', 'skills', 'tasks']
const DEFAULT_PAGE: PageKey = 'knowledge'
/** 支持「页/实体」两段的页面。 */
const WITH_SEL: readonly PageKey[] = ['knowledge', 'roles', 'teams', 'skills']

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').trim()
  if (raw === '') return { page: DEFAULT_PAGE }
  const [head, ...rest] = raw.split('/')
  const page = PAGES.find((p) => p === head)
  if (page === undefined) return { page: DEFAULT_PAGE }
  const sel = rest.join('/').trim()
  if (sel === '' || !WITH_SEL.includes(page)) return { page }
  return { page, sel: decodeURIComponent(sel) }
}

/** 生成 hash（`#/roles/dev-1`）。 */
export function hrefOf(route: Route): string {
  return route.sel !== undefined && route.sel !== ''
    ? `#/${route.page}/${encodeURIComponent(route.sel)}`
    : `#/${route.page}`
}

/**
 * 快照缓存 —— **必须**做到「同一 hash 返回同一对象引用」。
 *
 * `useSyncExternalStore` 用 `Object.is` 比较快照：若每次返回新解析出的对象，
 * 它会在每次渲染后都判定「快照变了」→ 触发重渲染 → 再次判定变化 → **无限循环**
 * （React 抛 Minified error #185，整页空白）。所以按 hash 串缓存解析结果。
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
