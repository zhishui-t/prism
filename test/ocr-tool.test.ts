/**
 * OCR Node 薄壳（`3rd/ocr/ocr_tool.mjs`）测试。
 *
 * 两层：
 *   1. **纯函数**：`resolvePython()` 的解析优先级（覆盖 / PATH 探测 / 平台惯例回落），
 *      与 `packages/server/test/graphify.test.ts` 对 `resolvePythonCommand` 的断言同口径——
 *      三处镜像（见 `python-mirror-contract.test.ts`）行为必须一致。
 *   2. **CLI 契约**：spawn 真脚本，锁 stdout/stderr 与退出码（`--fake` 结构自测、
 *      参数守卫、坏解释器、真实模式的条件分支）。
 *
 * R5：一切临时产物进 `mkdtemp` 目录，测试后清理；不写仓库其他位置。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { resolvePython } from '../3rd/ocr/ocr_tool.mjs'

const isWin = process.platform === 'win32'
const OCR_DIR = fileURLToPath(new URL('../3rd/ocr/', import.meta.url))
const TOOL = fileURLToPath(new URL('../3rd/ocr/ocr_tool.mjs', import.meta.url))
const TINY = join(OCR_DIR, 'fixtures', 'fixture-3-tiny.png')

/** 真实模式的模型三件套（与 ocr_main.py 的期望文件名一致）。 */
const MODEL_NAMES = [
  'ch_PP-OCRv5_det_server.onnx',
  'ch_PP-OCRv5_rec_server.onnx',
  'ch_PP-LCNet_x1_0_textline_ori_cls_server.onnx',
]
const modelsReady = MODEL_NAMES.every((n) => existsSync(join(OCR_DIR, 'models', n)))

/** 探测本机是否真有解释器（`--fake` 路径仍需 python 跑 `ocr_main.py`）。 */
const pythonProbe = spawnSync(resolvePython(), ['--version'], { encoding: 'utf-8' })
const hasPython = pythonProbe.status === 0

function runTool(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: OCR_DIR,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

describe('resolvePython（纯函数，镜像 scripts/python.mjs）', () => {
  it('PRISM_PYTHON 显式值原样返回（优先于平台惯例）', () => {
    expect(resolvePython({ PRISM_PYTHON: '/opt/py/bin/python3.13' })).toBe('/opt/py/bin/python3.13')
  })

  it('纯空白的覆盖值不生效，回落到探测结果', () => {
    expect(resolvePython({ PATH: '', PRISM_PYTHON: '   ' })).toBe(isWin ? 'python' : 'python3')
  })

  it('PATH 为空 → 平台惯例名（Windows python / POSIX python3）', () => {
    expect(resolvePython({ PATH: '' })).toBe(isWin ? 'python' : 'python3')
  })

  it('PATH 指向临时目录内的可执行体 → 解析出该候选名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-ocr-tool-'))
    try {
      // Windows 上 PATH 里存的是 `python.exe`，故探测要补后缀；但解析结果始终是
      // **不带后缀的候选名**（`python` / `python3`）——交给 spawn 再解析一次。
      const probeFile = isWin ? 'python.exe' : 'python3'
      const file = join(dir, probeFile)
      writeFileSync(file, isWin ? '@echo off\r\n' : '#!/bin/sh\n', 'utf-8')
      if (!isWin) chmodSync(file, 0o755) // Windows 上 X_OK 等同存在性检查，无需执行位
      expect(resolvePython({ PATH: dir })).toBe(isWin ? 'python' : 'python3')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('CLI 契约 · 参数守卫（只起 node，不需要解释器）', () => {
  it('无参数 → 用法说明 + exit 2', () => {
    const r = runTool([])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('用法')
  })

  it('未知参数 → exit 2 并点名该参数', () => {
    const r = runTool([TINY, '--nope'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--nope')
  })

  it('坏解释器（PRISM_PYTHON 指向不存在者）→ exit 1 且提示 PRISM_PYTHON', () => {
    const r = runTool([TINY, '--fake'], { PRISM_PYTHON: 'prism-definitely-not-exist' })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('PRISM_PYTHON')
  })
})

describe('CLI 契约 · --fake（无模型 / 无重依赖环境自测）', () => {
  it.skipIf(!hasPython)('Markdown：含 `## 第 1 页` 与 mock 标记，exit 0', () => {
    const r = runTool([TINY, '--fake'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('## 第 1 页')
    expect(r.stdout).toContain('PRISM OCR MOCK')
  })

  it.skipIf(!hasPython)('JSON：可解析、total_pages==1、page==1，exit 0', () => {
    const r = runTool([TINY, '--fake', '--json'])
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      total_pages: number
      pages: Array<{ page: number }>
    }
    expect(parsed.total_pages).toBe(1)
    expect(parsed.pages[0]?.page).toBe(1)
  })
})

describe('CLI 契约 · 真实模式（条件分支：模型齐 → 识别；不齐 → exit 2 提示模型）', () => {
  it.skipIf(!hasPython)(
    `模型${modelsReady ? '已就绪' : '缺失'}分支`,
    () => {
      const r = runTool([TINY])
      if (modelsReady) {
        expect(r.status).toBe(0)
        expect(r.stdout).toContain('## 第 1 页')
      } else {
        expect(r.status).toBe(2)
        expect(r.stderr).toContain('模型')
      }
    },
    60_000,
  )
})
