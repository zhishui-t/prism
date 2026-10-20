/**
 * Prism server 的 HTTP 信封层（唯一实现）。
 *
 * 契约（debts D-1，不得更改）：错误必须以 `` `${code}: ${message}` `` 抛成 `Error.message`
 * ——错误码靠这个前缀承载。消费方按前缀分派（如 `startsWith('not_found')`），
 * 因此不要改成结构化 error，也不要在前缀里加别的东西。
 *
 * 优化点（v20）：
 * - **单一实现**：`api.ts` 与 `api-team.ts` 此前各抄一份 `request`，改一处必须同步另一处；
 *   现在只保留这一份，两个模块都从这里导入。
 * - **GET 在途合并**：同一路径的并发 GET 共用一个 Promise（视图挂载 / 路由切换时常见），
 *   条件满足前不发第二枪；POST / PATCH / PUT / DELETE 不合并（写操作必须逐次到达）。
 * - **headers 合并**：调用方传 headers 时不再丢掉默认的 `content-type`。
 */

export type Envelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** 同一 GET 在途请求（只活在请求期间；成功后即删，不做 TTL 缓存）。 */
const inflight = new Map<string, Promise<unknown>>()

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  // 保持 plain object（既有测试按 `{ 'content-type': … }` 形状断言），同时支持 HeadersInit 的合并。
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init?.headers !== undefined) {
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
  }

  const res = await fetch(path, { ...init, headers })
  const body = (await res.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${body.error.code}: ${body.error.message}`)
  return body.value
}

export function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    // 写请求作废在途 GET 合并：否则「写成功后 reload」可能恰好 join 写前的旧 GET，
    // 读回一份写前数据。清空只影响后续请求，已在途的 Promise 仍各自完成。
    inflight.clear()
    return send<T>(path, init)
  }

  const key = `${method} ${path}`
  const existing = inflight.get(key)
  if (existing !== undefined) return existing as Promise<T>

  const pending = send<T>(path, init)
  inflight.set(key, pending)
  const clear = () => {
    // 只在仍是同一个 Promise 时删：写请求清空后可能已有新的同 key 请求
    if (inflight.get(key) === pending) inflight.delete(key)
  }
  // 用 then 而不是 finally：finally 会派生一个可能 unhandled 的拒绝 Promise
  void pending.then(clear, clear)
  return pending
}
