/**
 * 浮层栈（M1）+ Tab 圈闭（MINOR-10）：`Drawer` 与 `ConfirmModal` 的唯一共用实现。
 *
 * **M1**：两处此前各自在 `window` 上挂 `keydown` 只判 `Escape`，无栈概念——叠开时
 * （详情抽屉上压删除确认模态，如 `Roles.tsx`）一次 Esc 两层同关，用户被弹回列表。
 * 这里立一个**模块级栈**：每层浮层入栈拿令牌，只有**栈顶**令牌 `isTop()` 为真；
 * 非栈顶者对 Esc 直接忽略（**不** stopPropagation 吞事件，只决定自己关不关）
 * → 「模态叠在抽屉上按 Esc 只关模态，再按才关抽屉」。
 *
 * **MINOR-10**（brief R3 括号里承诺的焦点圈闭）：打开时焦点入容器，`Tab`/`Shift+Tab`
 * 在容器内首尾回绕，关闭时还原到打开前的 `document.activeElement`（嵌套时自然逐层回退：
 * 模态关 → 回抽屉，抽屉关 → 回触发它的按钮）。用循环而非 `inert`：后者要动全站节点。
 *
 * **v10 F2**：滚动锁也收进本文件（`useScrollLock`）——居中 `Modal` 是第三种浮层版式，
 * 之前 `Drawer` / `ConfirmModal` 各写一份的滚动锁若再复制一遍就是第三处镜像。
 */

import { useEffect, useRef, type RefObject } from 'react'

/** 浮层令牌：`isTop()` 只在仍是栈顶时为真；`release()` 幂等，且**只**摘自己那一层。 */
export interface OverlayToken {
  isTop: () => boolean
  release: () => void
}

/**
 * 栈里只放令牌 id（`Symbol`）：组件重渲染不产生新令牌，只有 effect 重跑才会。
 * 故注册 effect 必须是**挂载级**（依赖为空）——否则父级换掉 `onClose` 的箭头函数引用
 * 就会让下层浮层「重新入栈」跑到上层之上，Esc 关错层。`useOverlayLayer` 已把这条固定住。
 *
 * `release()` 用「自己的 id + 一次性标志」而非 `pop()`：中间层先卸（或 StrictMode
 * 双挂载的 cleanup 后到）都不会误摘别人的层，重复调用也无副作用。
 */
const stack: symbol[] = []

export function acquireOverlay(): OverlayToken {
  const id = Symbol('overlay')
  stack.push(id)
  let held = true
  return {
    isTop: () => held && stack[stack.length - 1] === id,
    release: () => {
      if (!held) return
      held = false
      const at = stack.indexOf(id)
      if (at !== -1) stack.splice(at, 1)
    },
  }
}

/** 容器内可聚焦元素（DOM 顺序）。禁用/`tabindex="-1"` 不算——它们不进 Tab 序列。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (container === null) return []
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
}

/**
 * `Tab` / `Shift+Tab` 在容器内首尾回绕。焦点已在容器外（逃逸或未被接管）时拉回容器内。
 * 非 Tab 键与空容器不动手——空容器强行 preventDefault 会把人锁死在一个无处可去的浮层里。
 */
export function trapTab(event: KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || container === null) return
  const items = focusableWithin(container)
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  // 容器**自身**持焦（`tabIndex={-1}` 的兜底落点，`useOverlayLayer` 挂载时可能停在它上面）
  // 不算「在内」：`contains()` 含元素自身，若把它当 inside，Tab 的默认行为会把焦点送进
  // DOM 序里容器之后的元素——圈闭第一次 Tab 就漏（复检 MINOR-③）。视作不在内 →
  // Tab 落 first、Shift+Tab 落 last。
  const inside = active !== null && active !== container && container.contains(active)
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault()
      last.focus()
    }
  } else if (!inside || active === last) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * 一层浮层的完整接线：入栈 + Esc（仅栈顶）+ Tab 圈闭 + 焦点捕获/还原。
 * `container` 须挂 `tabIndex={-1}`，否则「首个优先元素不可聚焦」时无处安放焦点。
 */
export function useOverlayLayer({
  container,
  onClose,
  initialFocus,
}: {
  /** 浮层容器：Tab 圈闭边界与焦点兜底落点。 */
  container: RefObject<HTMLElement>
  onClose: () => void
  /** 打开时优先聚焦的元素（如模态的确认钮）；省略则落容器本身。 */
  initialFocus?: RefObject<HTMLElement>
}): void {
  // 最新 onClose 走 ref，让注册 effect 得以保持挂载级（理由见 `stack` 处的注记）。
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])

  /**
   * 「打开前的焦点」**每个实例只捕获一次**：StrictMode 会把挂载 effect 跑两遍（中间夹一次
   * cleanup，而 cleanup 会还焦），若每次重跑都重新捕获，第二次捕到的是上一次 cleanup 刚
   * 还原出来的**别人**，逐层还焦就会错位到已卸载的节点上、静默失败。
   */
  const restore = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const token = acquireOverlay()
    if (restore.current === null) {
      const active = document.activeElement
      restore.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!token.isTop()) return
      if (e.key === 'Escape') {
        close.current()
        return
      }
      trapTab(e, container.current)
    }
    window.addEventListener('keydown', onKey)

    const box = container.current
    const preferred = initialFocus?.current ?? null
    preferred?.focus({ preventScroll: true })
    // 优先元素不可聚焦（如确认钮被 `busy`/`confirmDisabled` 禁用）时退回容器本身，
    // 保证焦点无论如何都落在浮层内——否则 Tab 圈闭要等第一次 Tab 才把人拉回来。
    if (document.activeElement !== preferred) box?.focus({ preventScroll: true })

    return () => {
      token.release()
      window.removeEventListener('keydown', onKey)
      const target = restore.current
      if (target !== null && target.isConnected) target.focus({ preventScroll: true })
    }
  }, [container, initialFocus])
}

/**
 * 浮层挂载期的滚动锁（v10 F2 起三处共用：`Drawer` / `ConfirmModal` / `Modal`）。
 *
 * v7 §2.7 锚点 9 之后**滚动容器是页面区 `.page`（body 不再滚）**，故两处都要锁，
 * 否则浮层打开时底下的列表仍能滚（锚点改动带来的必然跟随项）。
 *
 * ⚠ 必须是**挂载级** effect（依赖为空）：Esc/焦点那套在 `useOverlayLayer` 里已按挂载级注册，
 * 这里若跟着 `onClose` 的箭头函数引用重跑，锁会在重渲染时先解后加——中间的窗口期能滚。
 *
 * **多层叠开靠模块级计数（v10 派修 P1-1）**：早期实现是「每层各自快照、卸载时无条件回写」，
 * 而 React 删除期 effect 清理是**先挂的先清**，于是两类坏态真实发生：
 *  1. 同 commit 全卸（`Modal` + `ConfirmModal` 一起消失，F1/F2 常规路径）——外层先回写 `''`、
 *     内层再把自己挂载时看到的 `'hidden'` 回写 ⇒ `body`/`.page` **停在 `hidden`**，整站不可滚；
 *  2. 先卸外层（内层还在）——外层无条件回写 `''` ⇒ 锁静默丢失，浮层底下的列表又能滚。
 * 现在**只有第一层锁时快照**（快照是「第一层打开前」的值，不是中间态的 `hidden`），
 * **最后一层解锁时才回写**：中途卸载只减计数、不动 DOM；清理顺序与谁先谁后无关。
 * 回归见 `apps/web/test/overlay-scroll-lock.test.ts`（含两条坏态）。
 */
let lockCount = 0
/** 第一个持锁者看到的 `body` / `.page` 的 inline `overflow`（最后一个解锁者回写）。 */
let lockedBodyOverflow = ''
let lockedPage: HTMLElement | null = null
let lockedPageOverflow = ''

export function useScrollLock(): void {
  useEffect(() => {
    if (lockCount === 0) {
      lockedBodyOverflow = document.body.style.overflow
      lockedPage = document.querySelector<HTMLElement>('.page')
      lockedPageOverflow = lockedPage?.style.overflow ?? ''
      document.body.style.overflow = 'hidden'
      if (lockedPage !== null) lockedPage.style.overflow = 'hidden'
    }
    lockCount += 1
    return () => {
      lockCount -= 1
      if (lockCount > 0) return
      document.body.style.overflow = lockedBodyOverflow
      if (lockedPage !== null) lockedPage.style.overflow = lockedPageOverflow
      lockedPage = null
    }
  }, [])
}
