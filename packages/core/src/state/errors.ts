/** Prism 通用业务错误：携带稳定错误码与结构化详情，供 API 层映射为响应信封。 */
export class PrismError extends Error {
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(code: string, message?: string, details?: Record<string, unknown>) {
    super(message ?? code)
    this.name = 'PrismError'
    this.code = code
    this.details = details
  }
}

/** 类型守卫：判断任意错误是否为 PrismError。 */
export function isPrismError(error: unknown): error is PrismError {
  return error instanceof PrismError
}
