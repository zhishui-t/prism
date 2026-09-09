interface StateProps {
  loading?: boolean
  error?: string
  empty?: boolean
  emptyText?: string
  children: React.ReactNode
}

/** 统一渲染三态：加载中 / 错误 / 空 / 内容。 */
export function State({ loading, error, empty, emptyText, children }: StateProps) {
  if (loading) return <div className="empty">加载中…</div>
  if (error) return <div className="error">请求失败：{error}</div>
  if (empty) return <div className="empty">{emptyText ?? '暂无数据'}</div>
  return <>{children}</>
}
