import type { SearchResult } from '../api.ts'

/**
 * 检索结果行（design-brief-v7-a K7）：**标题主行** + 副行「层 › 归属 › 书 › 模块 › 来源」
 * + `excerpt`。不做高亮（K7 明确排除：自写高亮会引入截断/转义复杂度）。
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
}

export function SearchHitRow({
  entry,
  href,
  active = false,
  onOpen,
  layerText,
  moduleText,
}: SearchHitRowProps) {
  return (
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
}
