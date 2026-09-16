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
 */
import type { ReactNode } from 'react'

export function NavRow({
  href,
  variant = 'row',
  selected = false,
  onClick,
  children,
}: {
  href: string
  variant?: 'row' | 'card'
  /** 选中态：视觉走 `.sel`，无障碍语义走 `aria-current`（高亮的唯一真相仍是 hash）。 */
  selected?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  const cls = `nav-row ${variant === 'card' ? 'role-card' : 'md-row'}${selected ? ' sel' : ''}`
  return (
    <a
      href={href}
      className={cls}
      aria-current={selected ? 'true' : undefined}
      onClick={onClick !== undefined ? () => onClick() : undefined}
    >
      {children}
    </a>
  )
}
