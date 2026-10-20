/**
 * 图标：内联 SVG，零依赖。
 *
 * 口径：
 * - 统一 24×24 viewBox、1.7 描边、圆头圆角；尺寸由 `size` 控制（导航 18 / 按钮 16 / 空态 22）。
 * - 图标是装饰，默认 `aria-hidden`；需要独立语义时传 `title`（变成 `role="img"`）。
 * - 不引图标库、不写 emoji：所有图形都在这里定义，页面只按名字取。
 */

import type { ReactNode } from 'react'

export type IconName =
  | 'book'
  | 'graph'
  | 'folder'
  | 'user'
  | 'users'
  | 'sparkles'
  | 'sun'
  | 'moon'
  | 'search'
  | 'plus'
  | 'refresh'
  | 'chevron'
  | 'close'
  | 'external'
  | 'layers'
  | 'command'
  | 'alert'
  | 'inbox'
  | 'arrow-right'
  | 'check'
  | 'database'
  | 'link'

const PATHS: Record<IconName, ReactNode> = {
  book: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M8 7h8M8 11h6" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <path d="M8.1 7.3 10.8 16M15.9 7.3 13.2 16M8.4 6h7.2" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3l2 2h7A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
      <path d="M3.5 9.5h17" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.1" />
      <path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0" />
      <path d="M15.6 5.4a3.1 3.1 0 0 1 0 5.9M17.5 14.2a6.2 6.2 0 0 1 3.7 5.3" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7z" />
      <path d="M18.5 15.5 19.4 18l2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </>
  ),
  moon: <path d="M20.2 14.2A8.5 8.5 0 0 1 9.8 3.8 8.5 8.5 0 1 0 20.2 14.2z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-.8 4.5" />
      <path d="M20 4v7h-7" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </>
  ),
  command: (
    <>
      <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3.5 21 19.5H3z" />
      <path d="M12 9v4.5M12 17h.01" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 5h16l1.5 9.5A2.5 2.5 0 0 1 19 17H5a2.5 2.5 0 0 1-2.5-2.5z" />
      <path d="M3 14h5l1.5 2h5L16 14h5" />
    </>
  ),
  'arrow-right': <path d="M4 12h15M13 6l6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.1 0l2.1-2.1a5 5 0 0 0-7.1-7.1L11 5" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2.1 2.1a5 5 0 0 0 7.1 7.1L13 19" />
    </>
  ),
}

export function Icon({
  name,
  size = 18,
  className,
  title,
}: {
  name: IconName
  size?: number
  className?: string
  /** 需要独立语义时传；省略 = 纯装饰（aria-hidden）。 */
  title?: string
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
      focusable="false"
    >
      {title !== undefined && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  )
}

/** 品牌标记：折射的三角棱镜。 */
export function PrismMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 3.2 21 19.4H3L12 3.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.1 14.1h7.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="m12 14.1 5.9 5.3M12 14.1l-5.9 5.3" stroke="currentColor" strokeWidth="1.15" opacity="0.65" strokeLinecap="round" />
    </svg>
  )
}
