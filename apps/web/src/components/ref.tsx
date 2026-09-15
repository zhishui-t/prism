/**
 * 统一互链组件（design-brief-v7-a.md §3.3 Q21）。
 *
 * 规则：
 * - **内部自己算 href**（`hrefOf`），页面不再通过 `onOpen*` 回调透传到 Shell
 *   ——Shell 从此不认识任何实体（页级导航除外）；
 * - 一律渲染 `<a href="#/...">`（中键 / 右键 / 复制链接 / 无 JS 都成立），
 *   不用 `onClick` 的 div；
 * - 名字为空 / 实体已不存在 → **不可点 + mute + title**，不抛错也不跳空页；
 * - 不使用「名字 + →」后缀（那是生成感默认）。
 */

import { hrefOf, type Route } from '../route.ts'
import { useT } from '../i18n.ts'

export type RefKind = 'role' | 'team' | 'skill' | 'project' | 'book'

export interface RefProps {
  kind: RefKind
  name: string | undefined
  /** `book` 用：条目所属层（`global|project|role`）。 */
  layer?: string
  /** `book` 用：层归属（角色名 / 项目名）。 */
  owner?: string
  title?: string
}

/**
 * 落点映射（§3.3 表 + R5）：
 * role → `#/roles/<name>`；team → `#/teams/<id>`；skill → `#/skills/<name>`；
 * project → `#/projects`；book → `#/knowledge?layer=..&owner=..&book=..`。
 * `name` 为空 → `null`（调用方渲染降级态）。
 */
export function refRoute(kind: RefKind, name: string | undefined, opts: { layer?: string; owner?: string } = {}): Route | null {
  const v = name?.trim() ?? ''
  if (v === '') return null
  switch (kind) {
    case 'role':
      return { page: 'roles', sel: v }
    case 'team':
      return { page: 'teams', sel: v }
    case 'skill':
      return { page: 'skills', sel: v }
    case 'project':
      return { page: 'projects' }
    case 'book': {
      const query: Record<string, string> = {}
      if (opts.layer !== undefined && opts.layer !== '') query.layer = opts.layer
      if (opts.owner !== undefined && opts.owner !== '') query.owner = opts.owner
      query.book = v
      return { page: 'knowledge', query }
    }
  }
}

export function Ref({ kind, name, layer, owner, title }: RefProps) {
  const t = useT()
  const route = refRoute(kind, name, { ...(layer !== undefined ? { layer } : {}), ...(owner !== undefined ? { owner } : {}) })
  if (route === null) {
    return (
      <span className="ref ref-missing" title={title ?? t('ref.missing')}>
        {name?.trim() === '' || name === undefined ? t('common.unset') : name}
      </span>
    )
  }
  return (
    <a className="ref" href={hrefOf(route)} title={title}>
      {name}
    </a>
  )
}
