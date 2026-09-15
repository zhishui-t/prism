/**
 * 统一确认模态（B5）：破坏性动作的唯一确认零件。
 *
 * 此前 4 处破坏性确认是 3 套行为：遮罩关闭两种写法（`onMouseDown`+target / `onClick`）、
 * **三处模态全无 Esc**、危险色只有知识页一处自绘（其余是普通 `tool-btn`），
 * 而 Drawer 早就有「Esc + 遮罩 + 滚动锁」这套契约。这里把契约收成一处：
 * - Esc 关闭；遮罩 `onMouseDown` + `target === currentTarget` 判定（按下在模态内、
 *   松手落在遮罩不误关）——与 `Drawer` 同源；
 * - 打开时锁 `body` 与页面区 `.page` 滚动（v7 之后滚动容器是 `.page`，body 不再滚，两处都要锁）；
 * - 焦点落确认钮（禁用时落模态本身）；Tab 在模态内回绕，关闭还原焦点；
 * - `danger` 时确认钮走 `.btn-danger`（`--err` 底 + `--on-buckram` 文字，
 *   两主题实测 5.46 / 7.84，达 AA）。
 *
 * Esc 只在**本模态是浮层栈顶**时才取消（M1）：模态叠在抽屉上时按 Esc 只关模态，
 * 再按才关抽屉。浮层栈与 Tab 圈闭见 `./overlay-stack.ts`。
 */
import { useEffect, useRef, type ReactNode } from 'react'

import { useT } from '../i18n.ts'
import { useOverlayLayer } from './overlay-stack.ts'

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = true,
  busy = false,
  confirmDisabled = false,
  error,
  onConfirm,
  onCancel,
}: {
  /** 可省略：正文已含实体名时不重复写标题（如知识条目软删）。省略时无障碍名回落 `common.confirm`。 */
  title?: string
  body: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** 提交中：确认钮禁用 + 标签换 `common.deleting`。 */
  busy?: boolean
  /** 前置条件未满足（如目标目录未知）时只禁用确认钮。 */
  confirmDisabled?: boolean
  /** 失败反馈就地渲染在按钮上方（模态未关时不落到背后的列表）。 */
  error?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useOverlayLayer({ container: box, onClose: onCancel, initialFocus: confirmRef })

  useEffect(() => {
    // 滚动锁：挂载级，不随 `onCancel` 重跑（Esc/焦点那套已挪进 `useOverlayLayer`）。
    const prev = document.body.style.overflow
    const page = document.querySelector<HTMLElement>('.page')
    const prevPage = page?.style.overflow ?? ''
    document.body.style.overflow = 'hidden'
    if (page !== null && page !== undefined) page.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
      if (page !== null && page !== undefined) page.style.overflow = prevPage
    }
  }, [])

  return (
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? t('common.confirm')}
      >
        {title !== undefined && <h3>{title}</h3>}
        <div className="modal-body">{body}</div>
        {error !== undefined && error !== '' && <div className="error">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="tool-btn" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? 'btn-danger' : undefined}
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? t('common.deleting') : (confirmLabel ?? t('common.confirmDelete'))}
          </button>
        </div>
      </div>
    </div>
  )
}
