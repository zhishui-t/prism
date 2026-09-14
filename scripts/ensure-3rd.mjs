#!/usr/bin/env node
/**
 * 构建前置：确保 3rd 子模块已初始化。
 *
 * 为什么在 build 前跑而不是只靠 postinstall：pnpm 在增量 install（"Already up to
 * date"）时可能跳过生命周期钩子——导致 clone 后第一次 `pnpm install` 就没拉子模块、
 * `pnpm build` 也静默通过（TS 编译不碰 3rd），直到**运行时**才炸。
 *
 * 幂等：已初始化则 0.1s 内通过；未初始化则自动拉取（clone 可能较慢但只需一次）。
 * 子模块缺失不影响 `pnpm build` 本身（TS 编译不碰 3rd），但会让 `prism embedding
 * install` / `prism graph build` / 文档转换在运行时失败——提前拉好避免困惑。
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 必须存在的子模块（少一个就拉全量）。 */
const REQUIRED = [
  join('3rd', 'archify', 'LICENSE'),
  join('3rd', 'graphify', 'pyproject.toml'),
  join('3rd', 'anydoc', 'Cargo.toml'),
]

const missing = REQUIRED.filter((f) => !existsSync(join(ROOT, f)))
if (missing.length === 0) {
  process.exit(0)
}

process.stdout.write(`[ensure-3rd] 子模块缺失 ${missing.length}/${REQUIRED.length}，自动拉取…\n`)
const result = spawnSync('git', ['submodule', 'update', '--init', '--recursive'], {
  cwd: ROOT,
  stdio: 'inherit',
})
if (result.status !== 0) {
  process.stderr.write(
    '[ensure-3rd] ⚠ 子模块拉取失败——构建继续（TS 编译不依赖 3rd），\n' +
      '  但运行时 graph build / 文档转换 / embedding install 会不可用。\n' +
      '  手动修复：pnpm run 3rd:init\n',
  )
  // 不阻断构建（TS 不依赖 3rd）；让调用方看到警告自行判断
}
