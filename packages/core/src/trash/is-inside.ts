import { resolve, sep } from 'node:path'

/**
 * 判断 `target` 是否落在 `root` 之内（含 `root` 自身）。
 *
 * 用途是**目录穿越防护**：两侧先 `resolve()` 把 `.`/`..` 折叠掉再比前缀，
 * 因此 `isInside('/a/b', '/a/b/../c')` 为 false（真·越界），
 * `isInside('/a/b', '/a/b/c')` 为 true。
 *
 * 刻意**不在这里再判一次平台**：`resolve()` 已按当前平台归一化分隔符与盘符，
 * 前缀拼接用 `path.sep` 即可（AGENTS.md §3.4「平台差异只在唯一真相源判定」）。
 * Windows 大小写不敏感场景下，前缀大小写不一致会得到 false —— 方向是
 * **拒绝而非放行**（fail-safe），且本仓两侧路径都由同一 root 拼出，实际不会触发。
 */
export function isInside(root: string, target: string): boolean {
  const base = resolve(root)
  const candidate = resolve(target)
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return candidate === base || candidate.startsWith(prefix)
}
