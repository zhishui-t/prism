/**
 * 页面级搜索 / 过滤输入的唯一零件。
 *
 * 交互口径（v19）：
 * - 左侧放大镜、右侧「/」快捷键提示（空值时）/ 清空按钮（有值时）；
 * - `Escape` 清空并失焦；`onClear` 给调用方做模式退出（如知识库的全文检索态）；
 * - `data-search-input` 供 Shell 的全局 `/` 快捷键定位——每页第一个即可。
 *
 * 为什么收成一个组件：角色 / 团队 / 技能 / 知识库四处此前各写一份 `label + Icon + input`，
 * 清空按钮和快捷键提示会各漂一套。搜索框的 DOM 仍保留调用方给的 `className`（如 `.role-filter`），
 * 既有测试的输入框选择器不受影响。
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import { useT } from '../i18n.ts'
import { Icon } from './Icon.tsx'

export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className = 'role-filter',
  onKeyDown,
  onClear,
  autoFocus = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  ariaLabel?: string
  /** 输入框自身的类（默认 `.role-filter`，与既有宽度口径一致）。 */
  className?: string
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  /** 清空 / Esc 之后调用；用于退出「检索结果」这类由输入驱动的模式。 */
  onClear?: () => void
  autoFocus?: boolean
}) {
  const t = useT()
  const clear = () => {
    onChange('')
    onClear?.()
  }

  return (
    <label className="filter-field">
      <Icon name="search" size={15} />
      <input
        type="text"
        className={className}
        data-search-input=""
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (e.key === 'Escape') {
            e.preventDefault()
            clear()
            e.currentTarget.blur()
          }
        }}
      />
      {value === '' ? (
        <kbd className="search-kbd" aria-hidden="true">
          /
        </kbd>
      ) : (
        <button type="button" className="search-clear" aria-label={t('common.clear')} title={t('common.clear')} onClick={clear}>
          <Icon name="close" size={12} />
        </button>
      )}
    </label>
  )
}
