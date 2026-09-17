/**
 * 可点行 / 可点卡片的唯一零件（B6）。
 *
 * 此前「点一行看详情」在 6 页有 4 套实现：`<a class=md-row>`、`<button>` 改 hash、
 * `<a class=role-card>`、`<div onClick>`（后者已在 B-2a 改成 `<a>`）。
 * 差异不在样式而在**行为**：`<button>` 那套中键不可用、不能复制/新开深链，
 * 文件头却写着「Shell 不再透传实体回调」——注释与实现自相矛盾（B16）。
 * 这里统一为 `<a href>`：键盘可达、可中键、可复制深链，与 §3.3 一致。
 *
 * `onClick` 只承载**导航之外的副作用**（如点行时清掉上一次的写操作提示条），
 * 不代替 href；`variant` 是版式修饰（`row` 横向列表行 / `card` 竖排卡片），
 * 交互契约（`.nav-row`：无下划线、颜色继承、hover、选中）只在基类声明一次。
 *
 * v12 F4（W-7）**附加四个可选拖拽/版式口**（默认值使既有消费方零改动）：
 * `draggable` / `onDragStart` / `onDragEnd` / `className`。技能卡要当拖拽源（SPEC-4.6），
 * 但拖拽属性只能落在**卡本体**这个 `<a>` 上（外面套一层 div 会破坏 `.role-grid` 的网格项
 * 语义），故把原生 DnD 三件透传进来；`className` 供「正在被拖」的附加类（`.dragging`）。
 * 卡片版式与拖拽视觉都仍由这里的类名驱动，**不新造第二个可点零件**。
 */
import type { DragEvent, ReactNode } from 'react'

export function NavRow({
  href,
  variant = 'row',
  selected = false,
  onClick,
  draggable = false,
  onDragStart,
  onDragEnd,
  className,
  children,
}: {
  href: string
  variant?: 'row' | 'card'
  /** 选中态：视觉走 `.sel`，无障碍语义走 `aria-current`（高亮的唯一真相仍是 hash）。 */
  selected?: boolean
  onClick?: () => void
  /** 原生 HTML5 拖拽源（默认关：既有行/卡不受影响）。 */
  draggable?: boolean
  onDragStart?: (event: DragEvent<HTMLAnchorElement>) => void
  onDragEnd?: () => void
  /** 附加类（如拖拽中的 `.dragging`）；基类与版式类仍由本组件决定。 */
  className?: string
  children: ReactNode
}) {
  const cls = `nav-row ${variant === 'card' ? 'role-card' : 'md-row'}${selected ? ' sel' : ''}${
    className !== undefined && className !== '' ? ` ${className}` : ''
  }`
  return (
    <a
      href={href}
      className={cls}
      aria-current={selected ? 'true' : undefined}
      draggable={draggable ? true : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick !== undefined ? () => onClick() : undefined}
    >
      {children}
    </a>
  )
}
