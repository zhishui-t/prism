import { useT } from '../i18n.ts'

interface StateProps {
  loading?: boolean
  error?: string
  empty?: boolean
  emptyText?: string
  /** 加载/错误/空态下不参与渲染，故可省（如 `{loading && <State loading />}` 这种守卫式用法）。 */
  children?: React.ReactNode
}

/**
 * 统一渲染三态：加载中 / 错误 / 空 / 内容。
 *
 * 文案一律走 `t()`——此前是硬编码中文，英文模式下这四页的三态永远是中文（R-4 破口）。
 * `error` 是 `request()` 抛出的原文（`code: message` 信封前缀，见 `api.ts` 的契约注释）；
 * 「错误码 → 人话」映射留待各页接线，这里只做统一包裹。
 *
 * B10：加载态改成**静态骨架条**（三条 `--sheet-2` 圆角条，**零动画**——简报 MOTION=1），
 * 此前 loading 与 empty 共用同一个虚线框、只差文案，等于没区分；也顺手消灭了页面里
 * 手写的 `…` 占位（生成感默认写法）。骨架不画文字，「加载中」只作 `role=status` 的
 * 无障碍名，避免「转圈 + 文字」这类默认组合。
 */
export function State({ loading, error, empty, emptyText, children }: StateProps) {
  const t = useT()
  if (loading) {
    return (
      <div className="skeleton" role="status" aria-label={t('common.loading')}>
        <span />
        <span />
        <span />
      </div>
    )
  }
  if (error) return <div className="error">{t('common.loadFailed', { msg: error })}</div>
  if (empty) return <div className="empty">{emptyText ?? t('common.empty')}</div>
  return <>{children}</>
}
