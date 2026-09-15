/**
 * C3：时间显示的**唯一格式**。
 *
 * 此前 Projects 用 `slice(0, 19)`、Knowledge 用 `slice(0, 16)`——同一条记录在两页显示不一致。
 * 口径统一到分钟（秒是台账类界面的噪声）。
 */
export function fmtTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16)
}
