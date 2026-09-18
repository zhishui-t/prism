/**
 * Markdown 渲染器（K8）：把 `markdown.ts` 解析出的**块数组**组为 React 元素树。
 *
 * ⚠ 关键取舍：**绝不** `dangerouslySetInnerHTML`——所有文本走 React 子节点，
 * 由 React 自动转义，因此内联 HTML 天然按纯文本显示，无需 sanitizer（K8）。
 *
 * 样式挂 class 而不内联，具体规则后续批次在 `styles.css` 补：
 * 正文 `var(--fs-read)/var(--lh-read)/var(--font-read)`、代码块等宽+横向滚动、
 * 表格细线 `var(--rule)` + 数字列 `tabular-nums`、引用块左 3px `var(--buckram)` 竖线。
 */

import type { ReactNode } from 'react'

import { parseMarkdown, type Block, type Inline, type ListItem } from '../markdown.ts'

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

/**
 * W-1：块的源区间 → `data-src-*` 属性。**只消费、不推算**——`srcStart/srcEnd` 由
 * `markdown.ts` 在解析时算好（原始 src 的 UTF-16 偏移）；二者缺省时不注入任何属性，
 * 手写 `Block` 的旧调用方行为不变。W-3 的滚动定位读这两个属性。
 */
interface SrcAttrs {
  'data-src-start'?: number
  'data-src-end'?: number
}

function srcAttrs(block: Block): SrcAttrs {
  return block.srcStart !== undefined && block.srcEnd !== undefined
    ? { 'data-src-start': block.srcStart, 'data-src-end': block.srcEnd }
    : {}
}

/** 纯数字单元格（含千分位/小数/百分号）→ 走 tabular-nums 对齐。 */
function isNumericCell(nodes: Inline[]): boolean {
  const text = nodes.map((n) => ('text' in n ? n.text : '')).join('').trim()
  return /\d/.test(text) && /^[+-]?[\d.,\s%]*$/.test(text)
}

function InlineRuns({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((node, idx) => {
    switch (node.type) {
      case 'text':
        return <span key={idx}>{node.text}</span>
      case 'code':
        return (
          <code key={idx} className="md-code">
            {node.text}
          </code>
        )
      case 'strong':
        return <strong key={idx}>{node.text}</strong>
      case 'em':
        return <em key={idx}>{node.text}</em>
      case 'del':
        // GFM 删除线（F9 病因 7）：`<del>` 自带 UA 删除线，不另配样式。
        return <del key={idx}>{node.text}</del>
      case 'link':
        return isExternal(node.href) ? (
          <a key={idx} className="md-link" href={node.href} target="_blank" rel="noopener noreferrer">
            {node.text}
          </a>
        ) : (
          <a key={idx} className="md-link" href={node.href}>
            {node.text}
          </a>
        )
      case 'image':
        // 图片降级为「图片引用」文本行：alt + 路径（组件层可加复制路径按钮）。
        return (
          <span key={idx} className="md-image">
            <span className="md-image-alt">{node.alt === '' ? 'image' : node.alt}</span>
            <code className="md-code">{node.url}</code>
          </span>
        )
    }
  })
}

function ListNodes({
  items,
  ordered,
  attrs,
}: {
  items: ListItem[]
  ordered: boolean
  /** 只有**顶层**列表（一个块）带源区间；嵌套子列表不单独计区间（W-1）。 */
  attrs?: SrcAttrs
}): ReactNode {
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag className={ordered ? 'md-ol' : 'md-ul'} {...attrs}>
      {items.map((item, idx) => (
        <li key={idx} className={item.plain === true ? 'md-li md-li-plain' : 'md-li'}>
          <InlineRuns nodes={item.content} />
          {item.children !== undefined && item.children.length > 0 ? (
            <ListNodes items={item.children} ordered={item.children[0].ordered} />
          ) : null}
        </li>
      ))}
    </Tag>
  )
}

function BlockNode({ block }: { block: Block }): ReactNode {
  switch (block.type) {
    case 'heading': {
      const content = <InlineRuns nodes={block.content} />
      // h5/h6 无对应字号阶梯：按「段落加粗」处理（K8）。
      if (block.level >= 5) {
        return (
          <p className="md-p md-h-plain" {...srcAttrs(block)}>
            {content}
          </p>
        )
      }
      const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3' | 'h4'
      return (
        <Tag className={`md-h${block.level}`} {...srcAttrs(block)}>
          {content}
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p className="md-p" {...srcAttrs(block)}>
          <InlineRuns nodes={block.content} />
        </p>
      )
    case 'code':
      return (
        <pre className="md-pre" {...srcAttrs(block)}>
          {block.lang !== '' ? <span className="md-lang">{block.lang}</span> : null}
          <code className="md-code-block">{block.code}</code>
        </pre>
      )
    case 'list':
      return <ListNodes items={block.items} ordered={block.ordered} attrs={srcAttrs(block)} />
    case 'quote':
      return (
        <blockquote className="md-quote" {...srcAttrs(block)}>
          {block.blocks.map((inner, idx) => (
            <BlockNode key={idx} block={inner} />
          ))}
        </blockquote>
      )
    case 'hr':
      return <hr className="md-hr" {...srcAttrs(block)} />
    case 'table':
      return (
        <div className="md-table-wrap" {...srcAttrs(block)}>
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((cell, idx) => (
                  <th key={idx} className={`md-th${isNumericCell(cell) ? ' md-num' : ''}`} data-align={block.align[idx] ?? undefined}>
                    <InlineRuns nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={`md-td${isNumericCell(cell) ? ' md-num' : ''}`} data-align={block.align[c] ?? undefined}>
                      <InlineRuns nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** 渲染块数组（供已解析/复用的场景）。 */
export function MarkdownBlocks({ blocks }: { blocks: Block[] }): ReactNode {
  return (
    // A4：容器类名原为 `.md`，与 styles.css 的「主从栅格」`.md`（书页/技能列表用的两列布局）撞名，
    // 导致每次渲染 Markdown 都被切成 minmax(220px,300px) + 1fr 两列。改名 `.md-body`（无栅格规则）。
    <div className="md-body">
      {blocks.map((block, idx) => (
        <BlockNode key={idx} block={block} />
      ))}
    </div>
  )
}

/** 渲染 Markdown 源码：解析 → 元素树。 */
export function Markdown({ src }: { src: string }): ReactNode {
  return <MarkdownBlocks blocks={parseMarkdown(src).blocks} />
}
