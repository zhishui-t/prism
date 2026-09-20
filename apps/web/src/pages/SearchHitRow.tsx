import { useId, useState, type ReactNode } from 'react'

import type { SearchHitSegment, SearchResult } from '../api.ts'
import { useT } from '../i18n.ts'

/**
 * 检索结果行（design-brief-v7-a K7）：**标题主行** + 副行「层 › 归属 › 书 › 模块 › 来源」
 * + `excerpt`。主行不做高亮（K7 明确排除：自写高亮会引入截断/转义复杂度）。
 *
 * D-1（major）修复：此前标题与来源同处一个 `flex-direction: row` 的 `.toc-hit-main`，
 * 标题被 flex 收缩压成 `width: 0`（视觉不可见、行内留 ~97px 空腔）。现在**标题独占
 * 块级主行**（`.toc-hit-main` 不再 flex），来源移到副行右端——两者不再是同一 flex row
 * 的平级项，标题不可能再被压成 0。形状本身由 `apps/web/test/knowledge-search-hit.test.ts`
 * 按 DOM 结构锁定（happy-dom 无布局引擎，不断言计算宽度）。
 *
 * A2：行本身是 `<a href>`（键盘可达 / 可中键 / 可复制深链），不是 `onClick` 的 div；
 * `onOpen` 仍需回调，因为右栏读的是页面**本地** `selectedId`（纯 href 不会换页）。
 *
 * v13 W-2（SPEC-4.2）：命中条目可展开**命中段列表**（`entry.hits`，wire snake_case）。
 * - 展开件放在 `<a>` **之外**（嵌套 `<button>` 非法）：返回的是 **Fragment**，展开件是行的
 *   兄弟节点；`hits` 缺省/为空时**只返回那个 `<a>`**，DOM 与旧行为逐字一致（向后兼容）。
 * - 展开按钮直接复用既有 `.toc-chip`（与「限当前层/限当前书」同一零件语言），不另造一套按钮
 *   样式；展开/收起是**瞬时**的（控制台从简，段列表 ≤4 行，不做高度动画）。
 * - v15 W-1（R-6）：按钮补齐 `aria-expanded` + `aria-controls`（后者指向展开区 `<ul>` 的
 *   `useId` id；仅在展开时给出——收起时 `<ul>` 不在 DOM，指向空 id 是无效引用）。
 * - 高亮走「切 run 数组组 React 节点 + 命中词包 `<mark>`」——**绝不** `dangerouslySetInnerHTML`。
 * - 查询词从调用方传入（页面检索态），大小写不敏感、简单包含；空串不高亮。
 *
 * v13 W-3（SPEC-4.3）：段行可**点击定位**——调用方给 `onLocateSegment` 时每段包一层
 * `<button>`（触发「选中条目 + 滚动到该段」），不给时保持纯文本行（本组件不依赖定位能力）。
 * ⚠ `hits_truncated` 是**响应级**（`SearchResponse.hits_truncated`，非条目级）——
 * 本组件**不再**读它，截断提示由 `Knowledge.tsx` 在结果区顶部呈现一次。
 *
 * 「层」「模块」的显示名由调用方算好传进来（`Knowledge.tsx` 的 `layerLabel` /
 * `modLabel` 走 i18n 字典）——本组件不复制那份映射，避免两处漂移。
 */
export interface SearchHitRowProps {
  entry: SearchResult
  /** 行链接目标（可复制 / 可中键打开）。 */
  href: string
  /** 是否当前选中条目（高亮态）。 */
  active?: boolean
  /** 左键点击（页面本地选中，不阻止 `href` 的默认行为）。 */
  onOpen: () => void
  /** 层的显示名（字典化，如「项目」/「专家」）。 */
  layerText: string
  /** 模块的显示名（空模块经字典映射为「未归类」）。 */
  moduleText: string
  /** 当前检索词（命中段高亮用；缺省 = 不高亮）。 */
  query?: string
  /** 点击某命中段 → 定位到该段（缺省 = 段行不可点，保持纯展示）。 */
  onLocateSegment?: (seg: SearchHitSegment) => void
}

/**
 * 命中词高亮：把文本切成 run 数组，命中词包 `<mark>`（其余保持文本节点，React 自动转义）。
 * 大小写不敏感、非重叠、简单包含；空词直接返回原文本。
 */
function highlight(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (needle === '') return text
  const haystack = text.toLowerCase()
  const low = needle.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let at = haystack.indexOf(low, from)
  while (at !== -1) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark key={at} className="toc-hit-mark">
        {text.slice(at, at + low.length)}
      </mark>,
    )
    from = at + low.length
    at = haystack.indexOf(low, from)
  }
  if (parts.length === 0) return text
  if (from < text.length) parts.push(text.slice(from))
  return parts
}

export function SearchHitRow({
  entry,
  href,
  active = false,
  onOpen,
  layerText,
  moduleText,
  query = '',
  onLocateSegment,
}: SearchHitRowProps) {
  const t = useT()
  const segsId = useId()
  const [open, setOpen] = useState(false)
  const segments = entry.hits ?? []

  const row = (
    <a
      href={href}
      className={`toc-item toc-hit${active ? ' active' : ''}`}
      onClick={onOpen}
    >
      {/* 标题主行：独占一行、块级；除标题外不放任何元素（D-1） */}
      <div className="toc-hit-main">
        <span className="toc-title">{entry.title}</span>
      </div>
      {/* 副行：层 › 归属 › 书 › 模块，命中来源右对齐收尾 */}
      <div className="toc-hit-sub">
        {layerText}
        <span className="toc-sep">›</span>
        {entry.owner !== undefined && entry.owner !== '' && (
          <>
            {entry.owner}
            <span className="toc-sep">›</span>
          </>
        )}
        {entry.book}
        <span className="toc-sep">›</span>
        {moduleText}
        <span className="toc-source">{entry.source}</span>
      </div>
      {entry.excerpt !== '' && <div className="toc-hit-excerpt">{entry.excerpt}</div>}
    </a>
  )

  // hits 缺省/空：DOM 与旧版逐字一致（不引入展开件、不留任何新节点）。
  if (segments.length === 0) return row

  return (
    <>
      {row}
      {/* 展开切换在 `<a>` 之外（嵌套交互元素非法）；`<button>` 原生键盘可达。
          视觉复用既有 `.toc-chip`（与「限当前层/限当前书」同一零件语言），不再重复声明一遍。
          v15 W-1（R-6）：`aria-expanded` 之外补 `aria-controls` 指向展开区 `<ul>` 的 id；
          `aria-controls` **仅在展开时**给出——收起时那个 `<ul>` 根本不在 DOM 里（v13 契约：
          收起不留新节点），指向不存在的 id 是无效引用。 */}
      <button
        type="button"
        className="toc-chip toc-hit-seg-toggle"
        aria-expanded={open}
        aria-controls={open ? segsId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {open
          ? t('knowledge.hits.collapse', { n: segments.length })
          : t('knowledge.hits.expand', { n: segments.length })}
      </button>
      {open && (
        <ul className="toc-hit-segs" id={segsId}>
          {segments.map((seg, idx) => {
            // 两个子块用 `<span>` 而非 `<div>`：可定位分支要把它们放进 `<button>`，
            // 而 `<button>` 的内容模型只允许 phrasing content（`<div>` 非法）。块级观感由
            // 样式侧的 `display: block` 提供，与原来逐像素一致。
            const content = (
              <>
                <span className="toc-hit-seg-path">{seg.heading_path}</span>
                <span className="toc-hit-seg-excerpt">{highlight(seg.excerpt, query)}</span>
              </>
            )
            return (
              <li key={idx} className="toc-hit-seg">
                {/* W-3：可定位时每段是一个原生 `<button>`（键盘可达）；不可定位时保持纯文本行。 */}
                {onLocateSegment === undefined ? (
                  content
                ) : (
                  <button
                    type="button"
                    className="toc-hit-seg-go"
                    onClick={() => onLocateSegment(seg)}
                  >
                    {content}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
