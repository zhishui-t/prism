/**
 * 四页共用的界面零件。
 *
 * 存在的理由：重构前知识库/图谱/项目/角色/团队/技能各写各的表头与详情位置——
 * 列表形态、状态语言、空态全不一样，用户说「不知道有什么、也没重点」。
 * 这里把「页头 / 统计 / 列表行 / 详情分栏 / 抽屉 / 状态标签 / 命令块 / 空态」
 * 收成一处，四页只填数据。
 */

import { useEffect, useState, type ReactNode } from 'react'

import { useT } from '../i18n.ts'

/** 把一段长描述压成「一句话」：取首个句末标点之前，超长再截。 */
export function firstSentence(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const cut = flat.search(/[。！？；]|\.\s|;\s/)
  const head = cut === -1 ? flat : flat.slice(0, cut + 1)
  return head.length > max ? `${head.slice(0, max).trimEnd()}…` : head
}

export function PageHead({
  title,
  sub,
  children,
}: {
  title: string
  sub?: string
  children?: ReactNode
}) {
  return (
    <div className="page-head">
      <div>
        <h2>{title}</h2>
        {sub !== undefined && sub !== '' && <p className="page-sub">{sub}</p>}
      </div>
      {children !== undefined && <div className="page-actions">{children}</div>}
    </div>
  )
}

/** 统计小块（数值 + 标签）。 */
export function StatCards({ items }: { items: Array<{ label: string; value: number | string; tone?: 'ok' | 'warn' | 'err' | 'muted' }> }) {
  if (items.length === 0) return null
  const color = (tone?: string): string =>
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'err' ? 'var(--err)' : 'inherit'
  return (
    <div className="stat-cards">
      {items.map((item) => (
        <div className="lib-stat" key={item.label}>
          <div className="n" style={{ color: color(item.tone) }}>
            {item.value}
          </div>
          <div className="l">{item.label}</div>
        </div>
      ))}
    </div>
  )
}

/** 状态标签（统一 ok / warn / err / info 四档，颜色与文案分家）。 */
export function StatusTag({ kind = 'info', children, title }: { kind?: 'ok' | 'warn' | 'err' | 'info'; children: ReactNode; title?: string }) {
  const cls = kind === 'ok' ? 'tag ok' : kind === 'warn' ? 'tag warn' : kind === 'err' ? 'tag err' : 'tag'
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  )
}

/** 命令块：等宽展示 + 一键复制（复制失败静默，不打断）。 */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <div className="cmd-row">
      <code className="cmd">{command}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }}
      >
        {copied ? t('common.copied') : (label ?? t('common.copy'))}
      </button>
    </div>
  )
}

/** 空态块：一句结论 + 一句出路 + 可选命令。 */
export function EmptyBlock({ title, desc, command }: { title: string; desc?: string; command?: string }) {
  return (
    <div className="empty" style={{ textAlign: 'left' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      {desc !== undefined && <div className="small muted">{desc}</div>}
      {command !== undefined && (
        <div style={{ marginTop: 10 }}>
          <CopyCommand command={command} />
        </div>
      )}
    </div>
  )
}

/** 详情分栏（内容块）。 */
export function Pane({ title, children, head }: { title?: string; children: ReactNode; head?: ReactNode }) {
  return (
    <div className="pane">
      {head ?? (title !== undefined ? <h3>{title}</h3> : null)}
      {children}
    </div>
  )
}

/**
 * 右侧抽屉：Esc 关闭、点遮罩关闭、打开时锁 body 滚动。
 * 用于「点行看详情」与「新建 / 编辑表单」——原先把详情堆在表格下方，点完还得往下找。
 */
export function Drawer({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const t = useT()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div
      className="drawer-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <aside className="drawer" style={width !== undefined ? { width: `min(${width}px, 96vw)` } : undefined}>
        <div className="drawer-head">
          <h3>{title}</h3>
          <span className="spacer">
            <button type="button" onClick={onClose}>
              {t('common.close')}
            </button>
          </span>
        </div>
        <div className="drawer-body">{children}</div>
        {footer !== undefined && <div className="drawer-foot">{footer}</div>}
      </aside>
    </div>
  )
}
