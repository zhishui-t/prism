/**
 * 沉淀规则区（合并新建 / 编辑两处重复实现，T5）。
 *
 * 两处只差 `id` 前缀（`ntf-` / `etf-`）与「新建要就地显示 `defaultLayer` 校验错误」，
 * 用 `idPrefix` + 可选 `error` 统一；枚举与文案全部来自 templates.ts / i18n。
 */

import { useT } from '../../../i18n.ts'
import { DEPOSIT_LAYER_KEYS, DEPOSIT_PRIORITIES, DEPOSIT_TYPES } from '../templates.ts'

export interface DepositValues {
  depositEnabled: boolean
  defaultLayer: string
  defaultType: string
  priority: string
  requireNote: boolean
}

export function DepositRules({
  v,
  idPrefix,
  disabled,
  error,
  onChange,
}: {
  v: DepositValues
  /** 表单内唯一 id 前缀（`ntf-` | `etf-`），避免同页两个表单 id 相撞。 */
  idPrefix: string
  disabled: boolean
  /** 新建表单的 `defaultLayer` 校验错误（编辑表单不就地校验此项）。 */
  error?: string
  onChange: (patch: Partial<DepositValues>) => void
}) {
  const t = useT()
  return (
    <>
      <h4>{t('teams.deposit')}</h4>
      <label className="row" style={{ gap: 'var(--s-2)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={v.depositEnabled}
          disabled={disabled}
          onChange={(e) => onChange({ depositEnabled: e.target.checked })}
        />
        <span>{t('teams.deposit.enable')}</span>
      </label>
      {v.depositEnabled && (
        <div className="form-grid" style={{ marginTop: 'var(--s-2)' }}>
          <label className="field" htmlFor={`${idPrefix}defaultLayer`}>
            <span className="label">{t('teams.deposit.layer')}</span>
            <select
              id={`${idPrefix}defaultLayer`}
              value={v.defaultLayer}
              disabled={disabled}
              onChange={(e) => onChange({ defaultLayer: e.target.value })}
            >
              {DEPOSIT_LAYER_KEYS.map((l) => (
                <option key={l.value} value={l.value}>
                  {t(l.label)}
                </option>
              ))}
            </select>
            {error !== undefined && <span className="err-text">{error}</span>}
          </label>
          <label className="field" htmlFor={`${idPrefix}defaultType`}>
            <span className="label">{t('teams.deposit.type')}</span>
            <select
              id={`${idPrefix}defaultType`}
              value={v.defaultType}
              disabled={disabled}
              onChange={(e) => onChange({ defaultType: e.target.value })}
            >
              {DEPOSIT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor={`${idPrefix}priority`}>
            <span className="label">{t('teams.deposit.priority')}</span>
            <select
              id={`${idPrefix}priority`}
              value={v.priority}
              disabled={disabled}
              onChange={(e) => onChange({ priority: e.target.value })}
            >
              {DEPOSIT_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 'var(--s-2)', alignSelf: 'end', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={v.requireNote}
              disabled={disabled}
              onChange={(e) => onChange({ requireNote: e.target.checked })}
            />
            <span className="small">{t('teams.deposit.requireNote')}</span>
          </label>
        </div>
      )}
    </>
  )
}
