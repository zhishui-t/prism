/**
 * 主题（浅色 / 深色）：零依赖最小实现。
 *
 * 口径：
 * - 状态存 `localStorage['prism.theme']`，值只有 `'light' | 'dark'`；
 *   首次访问（无存储）**跟随系统** `prefers-color-scheme`，之后以用户选择为准。
 * - 解析结果写到 `<html data-theme>`，CSS 变量集据此切换（styles.css）。
 * - 组件用 `useTheme()` 订阅；`applyTheme()` 在 React 挂载前先跑一次，避免首帧闪白。
 */

import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'prism.theme'
const listeners = new Set<() => void>()

/** 系统偏好（SSR / 无 matchMedia 时按深色——控制台默认深色）。 */
function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function readStored(): Theme | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : null
  } catch {
    return null // 隐私模式 / 禁用存储：不阻断，回落到系统偏好
  }
}

let current: Theme = readStored() ?? systemTheme()

/** 把当前主题写到 `<html data-theme>`。 */
export function applyTheme(theme: Theme = current): void {
  document.documentElement.dataset.theme = theme
}

/** 当前主题（模块级快照）。 */
export function currentTheme(): Theme {
  return current
}

/** 切换主题并持久化。 */
export function setTheme(theme: Theme): void {
  current = theme
  applyTheme(theme)
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 存不下就只在本次会话生效——不因此打断交互
  }
  for (const listener of listeners) listener()
}

/** 在明暗之间翻转。 */
export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark')
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 订阅当前主题（跨组件共享）。 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme)
}

/** 系统偏好变化时同步（仅当用户尚未显式选择）。 */
export function watchSystemTheme(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  const query = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = (): void => {
    if (readStored() === null) setTheme(systemTheme())
  }
  query.addEventListener?.('change', onChange)
}
