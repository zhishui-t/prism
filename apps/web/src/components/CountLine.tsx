/**
 * 「标签 …… 计数」引线行（§2.9 的唯一计数口径，B7）。
 *
 * 此前同一个「这段有几条」有 5 种排法：Roles 抽屉自带两套引线（`.rm-*` 卡片三计数、
 * `.rsec-*` 分段头）、TeamDetail 的 `Pane title="标题 · N"`、TeamEffectiveSkills 的
 * `标题 (N)`、teams/skills 列表行内的 badge。这里收成一处：
 * - `size="compact"` 11px（卡片内三计数），`size="section"` 12px/600（分段头）；
 * - `bare` 给**已经自带间距**的容器（`.pane-head`、`.row`）用：不带自身上下留白，改为撑满弹性宽度；
 * - `count` 可省（只作分组标签）；`lamp` 是「这条要留意」的状态点（8px 圆点，§2.5 的唯一圆形例外）。
 *
 * 空间受限处（teams 列表行内的 `成员 N / 阶段 N` badge）**未并入**：引线需要横向弹性宽度，
 * 320px 侧栏的行内 badge 放不下，详见报告取舍说明。
 */
import type { ReactNode } from 'react'

export function CountLine({
  label,
  count,
  lamp = false,
  size = 'compact',
  bare = false,
}: {
  label: ReactNode
  /** 省略 = 只画「标签 + 引线」（纯分组标签）。 */
  count?: ReactNode
  lamp?: boolean
  size?: 'compact' | 'section'
  bare?: boolean
}) {
  return (
    <div className={`count-line ${size}${bare ? ' bare' : ''}`}>
      <span className="count-label">{label}</span>
      <span className="count-leader" />
      {count !== undefined && <span className="count-num">{count}</span>}
      {lamp && <span className="count-lamp" />}
    </div>
  )
}
