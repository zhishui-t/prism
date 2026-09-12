#!/usr/bin/env node
/**
 * 跨平台 Python 解释器解析（npm scripts 与安装脚本共用）。
 *
 * 为什么需要它：**没有**两个平台通用的解释器名——
 *   - Windows：官方安装器与 Microsoft Store 版注册的是 `python`，`python3` 通常不存在；
 *   - macOS / Linux：系统与包管理器装的大多只提供 `python3`（新版 macOS 已移除裸 `python`，
 *     个别发行版的 `python` 还可能指向 Python 2）。
 * 早先 `package.json` 的 `3rd:build` / `3rd:check` 直接写裸 `python`，于是 macOS 侧一律失败。
 *
 * 用法（作为命令）：参数原样透传给解释器，退出码透传。
 *   node scripts/python.mjs -m pip install -q "tree-sitter>=0.23.0,<0.26"
 *   node scripts/python.mjs -c "print('hi')"
 *
 * 用法（作为模块）：
 *   import { resolvePython } from './python.mjs'
 *
 * 覆盖：环境变量 `PRISM_PYTHON`（CI / venv / 特殊发行版）。
 *
 * ⚠ 与 `packages/server/src/graph/graphify.ts` 的 `resolvePythonCommand` **同口径**：
 *   两处是刻意的镜像（scripts/ 不进发行包，无法被 TS 侧导入）。改一处必须同步另一处。
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_WINDOWS = process.platform === 'win32'

/** 查找候选时是否补 `.exe` 后缀（Windows 上 PATH 存的是 `python.exe`）。 */
const SUFFIXES = IS_WINDOWS ? ['.exe', ''] : ['']

/** 各平台的**优先顺序**：Windows 认 `python`，POSIX 认 `python3`。 */
const ORDER = IS_WINDOWS ? ['python', 'python3'] : ['python3', 'python']

/**
 * 解析 Python 解释器名（非绝对路径——交给 spawn 再解析一次，避免固化 PATH 顺序）。
 * 探不到任何可执行体时返回平台惯例名，让调用方拿到 ENOENT 并自行给出可读的报错。
 */
export function resolvePython(env = process.env) {
  const override = (env.PRISM_PYTHON ?? '').trim()
  if (override !== '') return override

  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d !== '')
  for (const name of ORDER) {
    for (const suffix of SUFFIXES) {
      for (const dir of dirs) {
        try {
          accessSync(join(dir, `${name}${suffix}`), constants.X_OK)
          return name
        } catch {
          // 不存在或不可执行 → 试下一个
        }
      }
    }
  }
  return IS_WINDOWS ? 'python' : 'python3'
}

function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    process.stdout.write(`[python] 解析结果: ${resolvePython()}\n`)
    process.stdout.write('用法: node scripts/python.mjs <python 参数…>\n')
    return 0
  }
  const python = resolvePython()
  const result = spawnSync(python, args, { stdio: 'inherit' })
  if (result.error !== undefined && result.error !== null) {
    process.stderr.write(
      `[python] 无法启动解释器「${python}」（${result.error.message}）——` +
        `请安装 Python 3，或用 PRISM_PYTHON 指定解释器路径\n`,
    )
    return 1
  }
  return result.status ?? 1
}

// 仅在被当作命令调用时执行（被 import 时保持纯函数可用）
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
