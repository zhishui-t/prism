/**
 * Archify 封装（knowledge-base.md §4.4 / D10）——**子进程调用**，与 Graphify 同一模式。
 *
 * Archify 是 vendored 自包含 CLI（`3rd/archify/bin/archify.mjs`，MIT v2.16.0），
 * 负责 JSON-IR → 自包含 HTML 的渲染与校验。Prism **不重写渲染器**，只做：
 *   - 解析 CLI 入口（仓库内子工程优先 → 环境变量覆盖）
 *   - 参数钉死与错误映射（与 runGraphify 同口径）
 *   - 输出路径守卫（只允许写 Prism 指定目录）
 *
 * 五类图（D11）：architecture / sequence / lifecycle / dataflow / workflow。
 */

import { constants as fsConstants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismError } from '@prism/core'

/** 五类图（archify schema 的 diagram_type 枚举）。 */
export const ARCHIFY_DIAGRAM_TYPES = [
  'architecture',
  'sequence',
  'lifecycle',
  'dataflow',
  'workflow',
] as const

export type ArchifyDiagramType = (typeof ARCHIFY_DIAGRAM_TYPES)[number]

export const ARCHIFY_TYPE_LABELS: Record<ArchifyDiagramType, string> = {
  architecture: '架构图',
  sequence: '时序图',
  lifecycle: '生命周期图',
  dataflow: '数据流图',
  workflow: '工作流图',
}

/** 默认超时（渲染是纯计算，比建图快得多）。 */
export const DEFAULT_ARCHIFY_TIMEOUT_MS = 120_000

export interface ArchifyCommand {
  command: string
  prefixArgs: string[]
  shell: boolean
}

export interface ArchifyRunOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ArchifyRunResult {
  code: number
  stdout: string
  stderr: string
  command: ArchifyCommand
}

/** validate 结果（`--json` 输出的规范化形态）。 */
export interface ArchifyValidation {
  ok: boolean
  type: ArchifyDiagramType
  /** 诊断条目（schema/layout 等） */
  problems: Array<{ code: string; severity: string; message: string; fix?: string }>
  /** 原始 JSON（便于上层透传/落库） */
  raw: unknown
}

const isWindows = process.platform === 'win32'

async function assertFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizeExecPath(path: string): string {
  let out = path
  while (out.startsWith('\\\\?\\')) out = out.slice(4)
  return out
}

/**
 * 仓库内 vendored archify 入口。
 * 源码位置 `packages/server/src/graph/archify.ts` 与产物 `packages/server/dist/graph/archify.js`
 * 到仓库根都是 4 层（…/graph → src|dist → server → packages → 根），故统一用 `../../../../3rd/...`。
 */
export function vendoredArchifyEntry(): string {
  return fileURLToPath(new URL('../../../../3rd/archify/bin/archify.mjs', import.meta.url))
}

/**
 * 解析 archify 入口：
 * 1. `ARCHIFY_BIN` 环境变量（显式覆盖；测试注入假实现）；
 * 2. 仓库内 `3rd/archify/bin/archify.mjs`（vendored 子工程，默认路径）；
 * 3. 都不可用 → PrismError('archify_missing')，附 `pnpm run 3rd:build` 提示。
 */
export async function resolveArchifyCommand(env: NodeJS.ProcessEnv = process.env): Promise<ArchifyCommand> {
  const override = normalizeExecPath(env.ARCHIFY_BIN?.trim() ?? '')
  if (override !== '') {
    if (/\.(mjs|cjs|js)$/i.test(override)) {
      return { command: process.execPath, prefixArgs: [override], shell: false }
    }
    if (/\.(cmd|bat)$/i.test(override)) {
      return { command: override, prefixArgs: [], shell: true }
    }
    return { command: override, prefixArgs: [], shell: false }
  }
  const vendored = vendoredArchifyEntry()
  if (await assertFile(vendored)) {
    return { command: process.execPath, prefixArgs: [vendored], shell: false }
  }
  throw new PrismError(
    'archify_missing',
    `找不到 archify 子工程（${vendored}）；确认 3rd/archify 已引入，或设置 ARCHIFY_BIN 指向其 bin/archify.mjs`,
  )
}

/** 参数校验：diagram_type 必须合法。 */
function assertDiagramType(type: string): asserts type is ArchifyDiagramType {
  if (!ARCHIFY_DIAGRAM_TYPES.includes(type as ArchifyDiagramType)) {
    throw new PrismError('bad_request', `非法图类型: ${type}`, {
      allowed: ARCHIFY_DIAGRAM_TYPES,
    })
  }
}

/**
 * 执行 archify CLI（参数经 spawn 数组传递，不经 shell 拼接——除 Windows .cmd 场景）。
 * 错误映射：超时 → archify_timeout；非零退出 → archify_failed（附 stderr）。
 */
export async function runArchify(
  args: string[],
  options: ArchifyRunOptions = {},
): Promise<ArchifyRunResult> {
  const command = await resolveArchifyCommand(options.env)
  const timeoutMs = options.timeoutMs ?? DEFAULT_ARCHIFY_TIMEOUT_MS

  return await new Promise<ArchifyRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: command.shell,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      rejectPromise(
        new PrismError('archify_timeout', `archify 超时（${timeoutMs}ms）: ${args.join(' ')}`, {
          args,
          timeoutMs,
        }),
      )
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(
        new PrismError('archify_failed', `archify 无法启动（${command.command}）：${error.message}`, {
          args,
        }),
      )
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr, command })
    })
  })
}

/** 解析 archify `--json` 输出（容错：非法 JSON 返回 null）。 */
function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    // CLI 可能把 JSON 混在日志后：尝试取最后一个 `{` 起的片段
    const start = trimmed.indexOf('{')
    if (start === -1) return null
    try {
      return JSON.parse(trimmed.slice(start)) as unknown
    } catch {
      return null
    }
  }
}

/** 从 archify 输出中提取诊断条目（兼容多种字段命名）。 */
function extractProblems(payload: unknown): ArchifyValidation['problems'] {
  if (typeof payload !== 'object' || payload === null) return []
  const record = payload as Record<string, unknown>
  const candidates = [record['problems'], record['diagnostics'], record['errors'], record['issues']]
  const list = candidates.find((c) => Array.isArray(c))
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const p = item as Record<string, unknown>
    const message = typeof p['message'] === 'string' ? p['message'] : ''
    if (message === '') return []
    return [
      {
        code: typeof p['code'] === 'string' ? p['code'] : 'unknown',
        severity: typeof p['severity'] === 'string' ? p['severity'] : 'error',
        message,
        ...(typeof p['fix'] === 'string' ? { fix: p['fix'] } : {}),
      },
    ]
  })
}

/**
 * 校验 IR：`archify validate <type> <file> --json`。
 * 返回规范化结果；CLI 非零退出也算「校验失败」而非抛错（调用方按 ok 判断）。
 */
export async function validateDiagram(
  type: string,
  ir: unknown,
  options: ArchifyRunOptions = {},
): Promise<ArchifyValidation> {
  assertDiagramType(type)
  const dir = await mkdtemp(join(tmpdir(), 'prism-archify-validate-'))
  const inputPath = join(dir, 'ir.json')
  try {
    await writeFile(inputPath, JSON.stringify(ir), 'utf-8')
    const result = await runArchify(['validate', type, inputPath, '--json'], options)
    const payload = parseJsonOutput(result.stdout)
    const problems = extractProblems(payload)
    const okFromJson =
      typeof payload === 'object' && payload !== null && typeof (payload as Record<string, unknown>)['ok'] === 'boolean'
        ? ((payload as Record<string, unknown>)['ok'] as boolean)
        : undefined
    return {
      ok: okFromJson ?? (result.code === 0 && problems.length === 0),
      type,
      problems,
      raw: payload ?? { code: result.code, stdout: result.stdout, stderr: result.stderr },
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface RenderResult {
  /** 产出的自包含 HTML 绝对路径 */
  htmlPath: string
  bytes: number
  /** archify 原始输出 */
  stdout: string
}

/**
 * 渲染 IR 为自包含 HTML：`archify render <type> <ir.json> <out.html>`。
 * 渲染前**先校验**（validate 不通过直接拒绝，避免产出坏图）。
 */
export async function renderDiagram(
  type: string,
  ir: unknown,
  outputHtmlPath: string,
  options: ArchifyRunOptions & { skipValidation?: boolean } = {},
): Promise<RenderResult> {
  assertDiagramType(type)
  if (options.skipValidation !== true) {
    const validation = await validateDiagram(type, ir, options)
    if (!validation.ok) {
      throw new PrismError(
        'archify_validation_failed',
        `IR 校验未通过（${type}）：${validation.problems.map((p) => p.message).join('；') || '未知原因'}`,
        { type, problems: validation.problems },
      )
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'prism-archify-render-'))
  const inputPath = join(dir, 'ir.json')
  const outPath = resolve(outputHtmlPath)
  try {
    await writeFile(inputPath, JSON.stringify(ir), 'utf-8')
    const result = await runArchify(['render', type, inputPath, outPath], options)
    if (result.code !== 0) {
      throw new PrismError(
        'archify_failed',
        `archify render 失败（退出码 ${result.code}）：${result.stderr.trim() || result.stdout.trim()}`,
        { type },
      )
    }
    const info = await access(outPath, fsConstants.F_OK).then(
      () => true,
      () => false,
    )
    if (!info) {
      throw new PrismError('archify_failed', `archify render 未产出文件: ${outPath}`, { type })
    }
    return { htmlPath: outPath, bytes: 0, stdout: result.stdout }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 取渲染产物所在目录（供调用方决定落盘位置）。 */
export function archifyOutputDir(baseDir: string, type: ArchifyDiagramType): string {
  return join(baseDir, 'archify', type)
}

/** 便捷：目录不存在时创建（渲染前调用）。 */
export async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
}

/** 供测试/上层复用：判断某路径是否在给定根内（防目录穿越）。 */
export function isInside(root: string, target: string): boolean {
  const r = resolve(root)
  const t = resolve(target)
  return t === r || t.startsWith(r.endsWith('\\') || r.endsWith('/') ? r : `${r}${isWindows ? '\\' : '/'}`)
}

/** 产物目录的父级（用于相对路径展示）。 */
export function parentDir(path: string): string {
  return dirname(path)
}
