/**
 * 四页共用的界面零件。
 *
 * 存在的理由：重构前知识库/图谱/项目/角色/团队/技能各写各的表头与详情位置——
 * 列表形态、状态语言、空态全不一样，用户说「不知道有什么、也没重点」。
 * 这里把「页头 / 统计 / 列表行 / 详情分栏 / 抽屉 / 状态标签 / 命令块 / 空态」
 * 收成一处，四页只填数据。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'

import { useT } from '../i18n.ts'
import { useOverlayLayer } from './overlay-stack.ts'

/** 把一段长描述压成「一句话」：取首个句末标点之前，超长再截。 */
export function firstSentence(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const cut = flat.search(/[。！？；]|\.\s|;\s/)
  const head = cut === -1 ? flat : flat.slice(0, cut + 1)
  return head.length > max ? `${head.slice(0, max).trimEnd()}…` : head
}

/**
 * 剥掉强强调标记（F8-1：角色「核心第一原则」块渲染字面 `**`）。
 *
 * 背景：原则块是**纯文本**强调块——强调由 `--sheet-2` 底 + 左侧 `--buckram` 引线表达
 * （`--fs-300`，**没有粗体语义**），渲染走 `firstSentence` 截断而**不是** `parseInline`；
 * 源文本里的 `**…**` 只是作者的写作习惯。而抽取在**首个句号**处截断，于是
 * `**方向未定不动手，抛光不改方向。** 每个视觉决定…` 只剩前导 `**`、闭合的 `**` 被截掉
 * ⇒ 8 张角色卡里 7 张显示裸 `**`。
 *
 * 裁决（问句：不成对的 `**` 回退原样输出，还是清理？）——**清理**，且**成对也剥**：
 * 1. `markdown.ts#parseInline` 对不成对标记的容错是「退回字面文本」——那是**给 markdown 正文**
 *    的口径；本块是纯文本，字面输出**正是本缺陷本身**，不能拿它当挡箭牌；
 * 2. 本块没有粗体语义：留着标记既不是渲染也不是原文，而是**半截标记**；「成对保留、不成对剥」
 *    还会在同一块里造出两种口径（同一段文本因截断与否表现不同）；
 * 3. ⇒ 标记一律不进这块文本：成对 / 不成对同待遇，删掉 `**`、留下里面的字。
 *
 * 实现上只吃**两个及以上连续**的星号（`***` 这类粗斜体也算标记，一并吃掉），**单个 `*` 不动**
 * ——同一个字符在纯文本里可能是乘号 / 通配 / 脚注符，且它不是本缺陷的形态。
 * 其余标记（`_` / 反引号 / 链接）不在本批范围，本函数只做这一件事。
 */
export function stripStrongMarkers(text: string): string {
  return text.replace(/\*{2,}/g, '')
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

/**
 * 状态标签（统一 ok / warn / err / info 四档，颜色与文案分家）。
 *
 * B9：§2.2 明文「状态徽标不再用同色 tag：`ok`/`info` 的区分靠**文字**，只有 `warn`/`err`
 * 才上色」——故 `ok` 与 `info` 同走中性 `.tag`（`.tag.ok` 的绿字绿边删除），`kind` 仍保留
 * 以表达调用点的意图；`warn`/`err` 继续上色。
 */
export function StatusTag({ kind = 'info', children, title }: { kind?: 'ok' | 'warn' | 'err' | 'info'; children: ReactNode; title?: string }) {
  const cls = kind === 'warn' ? 'tag warn' : kind === 'err' ? 'tag err' : 'tag'
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  )
}

/** 复制的共享逻辑：成功置 `copied`，1.6s 后复位（失败静默，不打断）。 */
function useCopyFeedback(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return {
    copied,
    copy: () => {
      void navigator.clipboard?.writeText(text).then(
        () => setCopied(true),
        () => setCopied(false),
      )
    },
  }
}

/** 复制按钮（`tool-btn`）：一键复制 + 1.6s「已复制」反馈（C5：源码视图工具条用）。 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT()
  const { copied, copy } = useCopyFeedback(text)
  return (
    <button type="button" className="tool-btn" onClick={copy}>
      {copied ? t('common.copied') : (label ?? t('common.copy'))}
    </button>
  )
}

/** 命令块：等宽展示 + 一键复制（复制失败静默，不打断）。 */
export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const t = useT()
  const { copied, copy } = useCopyFeedback(command)
  return (
    <div className="cmd-row">
      <code className="cmd">{command}</code>
      <button type="button" onClick={copy}>
        {copied ? t('common.copied') : (label ?? t('common.copy'))}
      </button>
    </div>
  )
}

/** 空态块：一句结论 + 一句出路 + 可选命令。 */
export function EmptyBlock({ title, desc, command }: { title: string; desc?: string; command?: string }) {
  return (
    <div className="empty" style={{ textAlign: 'left' }}>
      <div style={{ fontWeight: 600, marginBottom: 'var(--s-1)' }}>{title}</div>
      {desc !== undefined && <div className="small muted">{desc}</div>}
      {command !== undefined && (
        <div style={{ marginTop: 'var(--s-2)' }}>
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
 * 右侧抽屉：Esc 关闭、点遮罩关闭、打开时锁 body 滚动、焦点圈闭。
 * 用于「点行看详情」与「新建 / 编辑表单」——原先把详情堆在表格下方，点完还得往下找。
 *
 * Esc 只在**本抽屉是浮层栈顶**时才关（M1）：叠开的确认模态未关时按 Esc 不掀抽屉；
 * 打开时焦点入抽屉、Tab 在里面回绕、关闭还原（MINOR-10）。两件都收在
 * `./overlay-stack.ts`（浮层栈 + Tab 圈闭的唯一实现处），本组件只负责滚动锁与结构。
 */
export function Drawer({
  title,
  onClose,
  children,
  footer,
  width,
  maxVw = 96,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  /**
   * 宽度上限（视口宽百分比）。默认 96 保持既有口径（`width: Npx` + `max-width: 96vw`，
   * 等价于原先的 `min(Npx, 96vw)`）。R-v8-1：角色**详情**抽屉改 `min(680px, 72vw)`
   * ——`72vw` 这个上限原先表达不出来，故加此参数（宽度口径仍只有这一处，调用点不拼 CSS）。
   * `width` 未给时不渲染 inline style，落回 `.drawer` 的 CSS 默认宽度。
   *
   * 为何不直接写 `width: min(Npx, Mvw)`：两个声明（`width` + `max-width`）在语义上完全等价，
   * 但 `min()` 在 happy-dom 的 inline style 里会被整条丢掉（实测 `style` 属性为 null），
   * 拆开后宽度契约才在 DOM 测试里可断言。
   */
  maxVw?: number
}) {
  const t = useT()
  const box = useRef<HTMLElement>(null)
  useOverlayLayer({ container: box, onClose })

  useEffect(() => {
    // 滚动锁：v7 §2.7 锚点 9 之后**滚动容器是页面区 `.page`（body 不再滚）**，
    // 故两处都要锁，否则抽屉打开时底下的列表仍能滚（锚点改动带来的必然跟随项）。
    // 挂载级：Esc/焦点那套已挪进 `useOverlayLayer`，此处只做锁，不随 `onClose` 重跑。
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
      className="drawer-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <aside
        ref={box}
        tabIndex={-1}
        className="drawer"
        style={width !== undefined ? { width: `${width}px`, maxWidth: `${maxVw}vw` } : undefined}
      >
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
