#!/usr/bin/env node
/**
 * OCR 工具 Node 薄壳（ESM）：解析参数 → spawn Python 主体 `ocr_main.py`。
 *
 *   node 3rd/ocr/ocr_tool.mjs <input> [--models <dir>] [--json] [--fake]
 *                             [--table|--no-table] [--layout|--no-layout]
 *
 * 产物口径：stdout 原样透传 Python 的 Markdown / JSON（stdio: 'inherit'），
 * 诊断走 stderr，退出码透传（process.exitCode = status）。`--models` 缺省取
 * **本文件同目录**的 `models/`——用 import.meta.url 定位，**不写死仓库相对层级**，
 * 这样 3rd/ocr 整体搬移（开发态 / node_modules 物化后多一层）仍成立。
 *
 * v17 B-A1：表格 / 版面两个开关**只做透传**（`--table/--no-table/--layout/--no-layout`），
 * 缺省交给 Python（两者都开）；本薄壳不判断模型在不在——那是 ocr_main.py 的事
 * （缺件即静默跳过，回到无 table/layout 的旧输出）。
 *
 * ⚠ 解释器解析**刻意镜像** `scripts/python.mjs` 与
 *   `packages/server/src/graph/graphify.ts`（M6 三件套）：
 *   `scripts/python.mjs` 是发行代码的规范源（scripts/ 不进发行包、TS 侧无法导入，
 *   镜像不可免）。**改一处必须同步另两处**，并同步 `doc/requirements/cross-platform.md`
 *   §3「唯一真相源」的 Python 行与 AGENTS.md 陷阱表。
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const PY_MAIN = join(SCRIPT_DIR, 'ocr_main.py')
const DEFAULT_MODELS_DIR = join(SCRIPT_DIR, 'models')

// ---------------------------------------------------------------------------
// 解释器解析（镜像 scripts/python.mjs::resolvePython —— 见文件头 M6 说明）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const USAGE = `用法: node 3rd/ocr/ocr_tool.mjs <input> [--models <dir>] [--json] [--fake]
                                 [--table|--no-table] [--layout|--no-layout]

  <input>          待识别的图片或 PDF 路径
  --models <dir>   ONNX 模型目录（默认：本脚本同目录 models/）
  --json           以 JSON 输出（默认 Markdown）
  --fake           mock 推理层（不加载真实引擎/模型，供无依赖环境自测）
  --table          / --no-table    启用/关闭表格还原（默认开；模型未装则静默跳过）
  --layout         / --no-layout   启用/关闭版面分析（默认开；模型未装则静默跳过）
`

function printUsage(stream) {
  stream.write(USAGE)
}

/**
 * 解析 argv（不含 node/脚本本身）。返回 { input, models, json, fake, table, layout }
 * 或 { help: true } 或 { error: <文案> }。
 *
 * `table` / `layout` 缺省 `undefined`（**不透传 flag**，由 Python 决定默认开）；
 * 显式 `--table`/`--no-table` 才置 true/false（v17 B-A1）。
 */
function parseArgs(argv) {
  const opts = {
    input: null,
    models: DEFAULT_MODELS_DIR,
    json: false,
    fake: false,
    table: undefined,
    layout: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--json') {
      opts.json = true
    } else if (arg === '--fake') {
      opts.fake = true
    } else if (arg === '--table') {
      opts.table = true
    } else if (arg === '--no-table') {
      opts.table = false
    } else if (arg === '--layout') {
      opts.layout = true
    } else if (arg === '--no-layout') {
      opts.layout = false
    } else if (arg === '--models' || arg.startsWith('--models=')) {
      const value = arg === '--models' ? argv[(i += 1)] : arg.slice('--models='.length)
      if (value === undefined || value === '') return { error: '--models 需要一个目录参数' }
      opts.models = value
    } else if (arg.startsWith('-')) {
      return { error: `未知参数：${arg}` }
    } else if (opts.input === null) {
      opts.input = arg
    } else {
      return { error: `多余的参数：${arg}（只接受一个输入文件）` }
    }
  }
  if (opts.input === null) return { error: '缺少输入文件参数' }
  return opts
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    printUsage(process.stderr)
    return 2
  }

  const parsed = parseArgs(argv)
  if (parsed.help === true) {
    printUsage(process.stdout)
    return 0
  }
  if (parsed.error !== undefined) {
    process.stderr.write(`[ocr] ${parsed.error}\n`)
    printUsage(process.stderr)
    return 2
  }

  const python = resolvePython()
  const pyArgs = [
    PY_MAIN,
    resolve(parsed.input),
    '--models',
    resolve(parsed.models),
  ]
  if (parsed.json) pyArgs.push('--json')
  if (parsed.fake) pyArgs.push('--fake')
  // v17 B-A1：只透传显式给出的开关（undefined = 交给 Python 缺省）
  if (parsed.table === true) pyArgs.push('--table')
  if (parsed.table === false) pyArgs.push('--no-table')
  if (parsed.layout === true) pyArgs.push('--layout')
  if (parsed.layout === false) pyArgs.push('--no-layout')

  const result = spawnSync(python, pyArgs, {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.error !== undefined && result.error !== null) {
    process.stderr.write(
      `[ocr] 无法启动解释器「${python}」（${result.error.message}）——` +
        `请安装 Python 3，或用 PRISM_PYTHON 指定解释器路径\n`,
    )
    return 1
  }
  return result.status ?? 1
}

// 仅在被当作命令调用时执行（被 import 时保持纯函数可用——测试直接导入 resolvePython，
// 且 vitest 的 argv 若被当作输入会误 spawn 解释器）。与 scripts/python.mjs 同一守卫写法。
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
