#!/usr/bin/env node
/**
 * 3rd 三方件可用性自检（原 `package.json` 的 `3rd:check` 是一串 `&&` 拼的 shell 命令）。
 *
 * 换成脚本的**原因**：那串命令里既有裸 `python`（macOS 上不存在）、又有跨壳层语义不同的
 * 引号嵌套——Windows `cmd` 与 POSIX `sh` 对引号的处理不一致，写在一行里只能照顾一侧。
 * 逻辑搬进 Node 后按 argv 数组传参，两个平台都是同一条路径。
 *
 * 检查项（每项独立报告，**不因一项失败就中止**——首次克隆时子模块往往还没初始化，
 * 一次跑完能看到全貌比「第一个错误就退出」有用）：
 *   1. archify  —— `3rd/archify` 的 CLI 可执行（Node 自包含，免构建）
 *   2. graphify —— `3rd/graphify` 的 Python 包可导入 + 运行依赖齐备
 *   3. anydoc   —— 平台预编译二进制是否就位（`scripts/setup-anydoc.mjs --check`）
 *
 * 退出码：全过 0；任意一项失败 1。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolvePython } from './python.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PYTHON = resolvePython()

/** 逐项结果（用于最后的汇总）。 */
const results = []

function report(name, ok, detail) {
  results.push({ name, ok })
  process.stdout.write(`${ok ? '✓' : '✗'} ${name.padEnd(9)} ${detail}\n`)
}

/** 跑一条命令，返回 {ok, output}（输出合并 stderr，便于把真实报错带出来）。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    ...options,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return { ok: result.status === 0, output }
}

/** 报错摘要：优先挑含「缺失/未找到/错误」的关键行，否则退回首行。 */
function summary(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  const key = lines.find((l) => /缺失|未找到|错误|失败|Error|error/.test(l)) ?? lines[0] ?? ''
  return key.length > 200 ? `${key.slice(0, 200)}…` : key
}

/** 子模块是否已初始化：目录存在**且**有该仓库的标志文件（空目录或只剩 .git 视为未初始化）。 */
function submoduleReady(dir, marker) {
  return existsSync(join(ROOT, '3rd', dir, marker))
}

function checkArchify() {
  const entry = join('3rd', 'archify', 'archify', 'bin', 'archify.mjs')
  if (!existsSync(join(ROOT, entry))) {
    report('archify', false, `子模块缺失（${entry}）——先跑 pnpm run 3rd:init`)
    return
  }
  const { ok, output } = run(process.execPath, [entry, '--help'])
  report('archify', ok, ok ? 'CLI 可执行' : summary(output))
}

function checkGraphify() {
  if (!submoduleReady('graphify', 'pyproject.toml')) {
    report('graphify', false, '子模块缺失（3rd/graphify/pyproject.toml 不在）——先跑 pnpm run 3rd:init')
    return
  }
  const importer = 'import sys; sys.path.insert(0, "3rd/graphify"); import graphify; print("graphify ok")'
  const imported = run(PYTHON, ['-c', importer])
  if (!imported.ok) {
    report('graphify', false, `导入失败（解释器 ${PYTHON}）：${summary(imported.output)}`)
    return
  }
  const deps = run(PYTHON, ['-c', 'import tree_sitter, networkx, rapidfuzz; print("deps ok")'])
  report(
    'graphify',
    deps.ok,
    deps.ok ? `包可导入，依赖齐备（解释器 ${PYTHON}）` : `依赖缺失：${summary(deps.output)}——先跑 pnpm run 3rd:build`,
  )
}

function checkAnydoc() {
  const { ok, output } = run(process.execPath, [join('scripts', 'setup-anydoc.mjs'), '--check'])
  report('anydoc', ok, ok ? '平台预编译二进制就位' : summary(output))
}

process.stdout.write(`3rd 自检（${process.platform}/${process.arch}，Python: ${PYTHON}）\n`)
checkArchify()
checkGraphify()
checkAnydoc()

const failed = results.filter((r) => !r.ok)
process.stdout.write(`\n${results.length - failed.length}/${results.length} 项通过\n`)
if (failed.length > 0) {
  process.stdout.write(`未通过: ${failed.map((r) => r.name).join('、')}\n`)
  process.exitCode = 1
}
