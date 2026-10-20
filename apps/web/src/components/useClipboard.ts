/**
 * 剪贴板复制 + 短暂回执（唯一实现）。
 *
 * 此前 `CopyButton` / `CopyCommand` 与顶栏的「复制链接」各写一份 timer + clipboard，
 * 重复复制时还要各自处理「回执是否延长」。这里收成一处：
 * - 复制成功 → `copied=true`，`resetMs` 后复位；
 * - **连续复制会重置计时**（不是从第一次起 1.6s 就熄）；
 * - 剪贴板不可用 / 拒绝 → 静默失败，不打断页面；
 * - 卸载时清 timer，避免对已卸载组件 setState。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export function useClipboard(resetMs = 1600): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const alive = useRef(true)

  const stopTimer = useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [])

  const copy = useCallback(
    (text: string) => {
      const write = navigator.clipboard?.writeText(text)
      if (write === undefined) {
        setCopied(false)
        return
      }
      void write.then(
        () => {
          if (!alive.current) return
          setCopied(true)
          stopTimer()
          timer.current = window.setTimeout(() => {
            timer.current = undefined
            setCopied(false)
          }, resetMs)
        },
        () => {
          if (!alive.current) return
          stopTimer()
          setCopied(false)
        },
      )
    },
    [resetMs, stopTimer],
  )

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      stopTimer()
    }
  }, [stopTimer])

  return { copied, copy }
}
