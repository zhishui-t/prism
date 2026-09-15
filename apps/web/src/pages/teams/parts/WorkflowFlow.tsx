/**
 * 工作流渲染（T1）：**横向**单行阶段卡 + 溢出横向滚动 + `scroll-snap`；
 * 删掉与流程图重叠的阶段明细表，改「点阶段就地展开」（accordion，同一图内）。
 *
 * 横向是忠于原注释「一眼看全」（CSS 现状 `column` 与意图矛盾）；≥1440 时 9 阶段可全显。
 */

import { useState } from 'react'

import type { WorkflowStage } from '../../../api-team.ts'
import { Ref } from '../../../components/ref.tsx'
import { useT } from '../../../i18n.ts'
import { modeLabel } from '../templates.ts'

export function WorkflowFlow({ workflow }: { workflow: WorkflowStage[] }) {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  if (workflow.length === 0) return <div className="small muted">{t('common.unset')}</div>
  const active = workflow.find((s) => s.order === open)
  /* B12②：「无回流」在团队定义表里写作填充符（`packages/agents/src/team/templates.ts` 的列约定，
     服务端 `parse.ts` 原样回读）——展示层与空串一视同仁，只认「空」这一种状态；
     不把它当作 UI 的「空」标记（UI 侧空值一律走 `common.unset`，B12①）。 */
  const NO_REFLOW = '—'
  const reflow = active?.reflow.trim() ?? ''
  const showReflow = reflow !== '' && reflow !== NO_REFLOW

  return (
    <>
      <div className="flow-scroll">
        <div className="workflow-flow">
          {workflow.map((stage, i) => (
            <div key={stage.order} className="flow-step">
              {i > 0 && <span className="flow-arrow" aria-hidden="true" />}
              <button
                type="button"
                className={`flow-stage${open === stage.order ? ' open' : ''}`}
                aria-expanded={open === stage.order}
                title={t('teams.flow.expand')}
                onClick={() => setOpen(open === stage.order ? null : stage.order)}
              >
                <span className="stage-num">{stage.order}</span>
                <span className="stage-name">{stage.stage}</span>
                <span className="stage-mode">{modeLabel(t, stage.mode)}</span>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* accordion：原地展开，不再另画一张明细表 */}
      {active !== undefined && (
        <div className="flow-detail">
          <div className="flow-detail-row">
            <span className="scope-label">{t('teams.col.owner')}</span>
            <span className="scope-leader" />
            <span className="flow-detail-val">
              {active.roles.map((r) => (
                <Ref key={r} kind="role" name={r} />
              ))}
            </span>
          </div>
          <div className="flow-detail-row">
            <span className="scope-label">{t('teams.col.mode')}</span>
            <span className="scope-leader" />
            <span className="flow-detail-val">{modeLabel(t, active.mode)}</span>
          </div>
          <div className="flow-detail-row">
            <span className="scope-label">{t('teams.flow.io')}</span>
            <span className="scope-leader" />
            <span className="flow-detail-val mono small">
              {active.input} → {active.output}
            </span>
          </div>
          <div className="flow-detail-row">
            <span className="scope-label">{t('teams.col.done')}</span>
            <span className="scope-leader" />
            <span className="flow-detail-val small">{active.done}</span>
          </div>
          {showReflow && (
            <div className="flow-detail-row">
              <span className="scope-label">{t('teams.col.reflow')}</span>
              <span className="scope-leader" />
              <span className="flow-detail-val small" style={{ color: 'var(--warn)' }}>
                ↩ {reflow}
              </span>
            </div>
          )}
        </div>
      )}
    </>
  )
}
