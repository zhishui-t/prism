import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismError } from '@prism/core'

/** 建图默认超时（design.md §4：300s）。 */
export const DEFAULT_GRAPHIFY_TIMEOUT_MS = 300_000

export interface GraphifyCommand {
  /** 可执行体：.cmd/.exe 绝对路径，或 `node`（配合 prefixArgs 指向 cli.js） */
  command: string
  /** 前置参数（如经 node 调 cli.js 时的脚本路径） */
  prefixArgs: string[]
  /** 是否经 shell 执行（.cmd 必须，绕开 Windows spawn EINVAL） */
  shell: boolean
}

export interface GraphifyRunOptions {
  cwd?: string
  timeoutMs?: number
  /** 环境变量覆盖（测试注入假 graphify） */
  env?: NodeJS.ProcessEnv
}

export interface GraphifyRunResult {
  code: number
  stdout: string
  stderr: string
  command: GraphifyCommand
}

const isWindows = process.platform === 'win32'
const EXECUTABLE_SUFFIXES = isWindows ? ['.cmd', '.exe', ''] : ['']

async function assertFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 归一化可执行路径：剥掉 Windows 扩展长度前缀 `\\?\`。
 * 该前缀传给子进程 argv 会破坏解析（如 node 把 `\\?\D:\x.js` 的 dirname 当作 `D:`）。
 */
function normalizeExecPath(path: string): string {
  let out = path
  while (out.startsWith('\\\\?\\')) {
    out = out.slice(4)
  }
  return out
}

/**
 * 仓库内 vendored graphify 入口（`3rd/graphify/dist/cli.js`）。
 * 源码 `packages/server/src/graph/graphify.ts` 与产物 `packages/server/dist/graph/graphify.js`
 * 到仓库根都是 4 层，故统一 `../../../../3rd/...`。
 */
export function vendoredGraphifyEntry(): string {
  return fileURLToPath(new URL('../../../../3rd/graphify/dist/cli.js', import.meta.url))
}

/**
 * 解析 graphify 可执行入口（design.md §4 Windows 约束）：
 * 1. `GRAPHIFY_BIN` 环境变量优先（.cmd/.exe 直接用；.js/.mjs/.cjs 经 node 调用）；
 * 2. 仓库内 `3rd/graphify/dist/cli.js`（vendored 子工程，需先 `pnpm run 3rd:build`）；
 *    设 `PRISM_SKIP_VENDORED=1` 可跳过此步（供测试隔离 PATH 解析分支）；
 * 3. 否则在 PATH 上找 `graphify.cmd`/`graphify.exe`/`graphify`（Windows）；
 * 4. 找不到 → PrismError('graphify_missing')。
 */
export async function resolveGraphifyCommand(env: NodeJS.ProcessEnv = process.env): Promise<GraphifyCommand> {
  const override = normalizeExecPath(env.GRAPHIFY_BIN?.trim() ?? '')
  if (override !== '') {
    if (/\.(mjs|cjs|js)$/i.test(override)) {
      return { command: process.execPath, prefixArgs: [override], shell: false }
    }
    if (/\.(cmd|bat)$/i.test(override)) {
      return { command: override, prefixArgs: [], shell: true }
    }
    return { command: override, prefixArgs: [], shell: false }
  }

  // 仓库内 vendored 子工程优先于 PATH（版本可控、可审计）
  const vendored = vendoredGraphifyEntry()
  if (env.PRISM_SKIP_VENDORED !== '1' && (await assertFile(vendored))) {
    return { command: process.execPath, prefixArgs: [vendored], shell: false }
  }

  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d !== '')
  for (const suffix of EXECUTABLE_SUFFIXES) {
    for (const dir of dirs) {
      const candidate = normalizeExecPath(join(dir, `graphify${suffix}`))
      if (await assertFile(candidate)) {
        if (/\.(cmd|bat)$/i.test(candidate)) {
          return { command: candidate, prefixArgs: [], shell: true }
        }
        return { command: candidate, prefixArgs: [], shell: false }
      }
    }
  }
  throw new PrismError(
    'graphify_missing',
    `找不到 graphify：仓库内子工程未构建（${vendored}，先执行 pnpm run 3rd:build），PATH 上也没有 graphify；可设置 GRAPHIFY_BIN 覆盖`,
  )
}

/** shell 执行时的参数加引号（空格/特殊字符）。 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) {
    return arg
  }
  return `"${arg.replace(/"/g, '""')}"`
}

/**
 * 运行 graphify 子命令并映射错误（design.md §4）：
 * spawn 失败 → graphify_missing；超时 → graphify_timeout（kill）；非零退出 → graphify_failed。
 */
export async function runGraphify(
  args: string[],
  options: GraphifyRunOptions = {},
): Promise<GraphifyRunResult> {
  // 环境覆盖必须继承完整父环境（Windows 子进程缺 SystemRoot/PATH 会启动异常）
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env }
  const resolved = await resolveGraphifyCommand(env)
  const timeoutMs = options.timeoutMs ?? DEFAULT_GRAPHIFY_TIMEOUT_MS
  const fullArgs = [...resolved.prefixArgs, ...args]

  // shell 模式（Windows .cmd）用整串命令 + 自行加引号，避开 DEP0190（args 拼接不转义）
  const child =
    resolved.shell
      ? spawn([resolved.command, ...fullArgs.map(shellQuote)].join(' '), {
          shell: true,
          cwd: options.cwd,
          env,
          windowsHide: true,
        })
      : spawn(resolved.command, fullArgs, {
          cwd: options.cwd,
          env,
          windowsHide: true,
        })

  let stdout = ''
  let stderr = ''
  let settled = false
  child.stdout?.setEncoding('utf-8')
  child.stderr?.setEncoding('utf-8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  return await new Promise<GraphifyRunResult>((resolve, reject) => {
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return
            }
            settled = true
            child.kill()
            reject(
              new PrismError('graphify_timeout', `graphify 超过 ${Math.round(timeoutMs / 1000)}s 未完成，已终止`, {
                args,
                timeoutMs,
                stdout: stdout.slice(-4000),
              }),
            )
          }, timeoutMs)
        : null

    const onSpawnError = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      reject(
        new PrismError('graphify_missing', `graphify 无法启动（${resolved.command}）：${error.message}`, {
          args,
        }),
      )
    }
    child.on('error', onSpawnError)

    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      const result: GraphifyRunResult = {
        code: code ?? -1,
        stdout,
        stderr,
        command: resolved,
      }
      if (result.code !== 0) {
        reject(
          new PrismError(
            'graphify_failed',
            `graphify 退出码 ${result.code}：${(stderr || stdout).trim().slice(-2000) || '无输出'}`,
            { args },
          ),
        )
        return
      }
      resolve(result)
    })
  })
}

/** 建图两步（design.md §4 钉死参数，禁 LLM 富化）：extract --no-description --no-label + flows build。 */
export function buildGraphArgs(projectRoot: string): string[][] {
  return [
    ['extract', projectRoot, '--out', projectRoot, '--no-description', '--no-label'],
    ['flows', 'build', '--graph', join(projectRoot, '.graphify', 'graph.json')],
  ]
}

/** 组装为经 shell 转义后的完整命令行（日志/诊断用）。 */
export function formatCommand(resolved: GraphifyCommand, args: string[]): string {
  const head = [resolved.command, ...resolved.prefixArgs]
  const parts = (resolved.shell ? head.map(shellQuote) : head).concat(
    resolved.shell ? args.map(shellQuote) : args,
  )
  return parts.join(' ')
}
