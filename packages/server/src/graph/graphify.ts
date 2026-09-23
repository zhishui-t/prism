import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismError, repoRoot } from '@prism/core'
import type { CodeGraph } from '@prism/agents'

/** 建图默认超时（design.md §4：300s）。 */
export const DEFAULT_GRAPHIFY_TIMEOUT_MS = 300_000

/**
 * 建图时**必须排除**的目录（v9 F1 防自污染）：Prism 自己的项目内产物目录
 * `<projectRoot>/.prism/`（arch 产物所在）——graphify 的 `_SKIP_DIRS` 不认它。
 */
export const PRISM_EXCLUDED_SCAN_DIR = '.prism'

export interface GraphifyCommand {
  /** 可执行体：python / node / .cmd+.exe 绝对路径 */
  command: string
  /** 前置参数（如 python 的 ['-m','graphify']） */
  prefixArgs: string[]
  /** 是否经 shell 执行（.cmd 必须，绕开 Windows spawn EINVAL） */
  shell: boolean
  /** 附加环境变量（vendored 模式注入 PYTHONPATH） */
  env?: NodeJS.ProcessEnv
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

/**
 * 依次在 PATH 目录里查候选可执行文件，返回**首个存在且可执行**者的名字
 * （返回名字而非绝对路径：交给 spawn 再解析一次，避免把 PATH 顺序/符号链接固化进 argv）。
 */
function findExecutableOnPath(names: string[], env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d !== '')
  for (const name of names) {
    for (const dir of dirs) {
      try {
        accessSync(join(dir, name), fsConstants.X_OK)
        return name
      } catch {
        // 不存在或不可执行 → 试下一个候选
      }
    }
  }
  return null
}

/**
 * Python 解释器名（**跨平台**，2026-09-12 双平台支持）：
 * 1. `PRISM_PYTHON` 显式覆盖（CI、venv、特殊发行版）；
 * 2. Windows：`python` 优先——官方安装器与 Microsoft Store 版注册的都是它，`python3` 通常**不存在**；
 * 3. POSIX（macOS / Linux）：`python3` 优先——系统自带与包管理器装的大多只提供 `python3`，
 *    裸 `python` 在新版 macOS 上已被移除，在部分发行版上还可能指向 Python 2；
 * 4. 都探不到 → 返回平台惯例名，让 spawn 抛 ENOENT 并由调用方映射成 graphify_missing。
 *
 * 早先这里写死 `command: 'python'`，结果 vendored graphify 在 macOS/Linux 上直接起不来。
 */
export function resolvePythonCommand(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PRISM_PYTHON?.trim()
  if (override !== undefined && override !== '') return override
  return (
    findExecutableOnPath(isWindows ? ['python', 'python3'] : ['python3', 'python'], env) ??
    (isWindows ? 'python' : 'python3')
  )
}

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
 * 仓库内 graphify 子模块目录（`3rd/graphify`，Python 包，PYTHONPATH 直跑免安装）。
 *
 * 发行根经 `repoRoot` **向上查找**（含 `3rd/` 或 `packages/` 的目录）——不能写死相对
 * 层级：开发态是 `packages/server/dist/graph/`（4 层到根），打包物化后是
 * `node_modules/@prism/server/dist/graph/`（**5 层**），写死会解析到 `node_modules/3rd`。
 */
export function vendoredGraphifyDir(): string {
  const root = repoRoot(import.meta.url, 8) ?? fileURLToPath(new URL('../../../../', import.meta.url))
  return join(root, '3rd', 'graphify')
}

/** 读取 vendored 子工程版本（pyproject.toml 的 version；读不到 → null）。 */
export async function vendoredGraphifyVersion(): Promise<string | null> {
  try {
    const raw = await readFile(join(vendoredGraphifyDir(), 'pyproject.toml'), 'utf-8')
    const match = raw.match(/^version\s*=\s*["']([^"']+)["']/m)
    return match !== null ? match[1]! : null
  } catch {
    return null
  }
}

/**
 * 解析 graphify 可执行入口（design.md §4；2026-09-12 起 Windows / macOS / Linux 同级支持）：
 * 1. `GRAPHIFY_BIN` 环境变量优先（.py 经 python；.js/.mjs/.cjs 经 node；.cmd/.bat shell 执行）；
 * 2. 仓库内 `3rd/graphify`（submodule，经 `<python> -m graphify` + PYTHONPATH 免安装调用；
 *    依赖需先 `pnpm run 3rd:build` 安装；设 `PRISM_SKIP_VENDORED=1` 跳过本分支供测试隔离）；
 * 3. 否则在 PATH 上找 `graphify.cmd`/`graphify.exe`/`graphify`（Windows）或 `graphify`（POSIX）；
 * 4. 找不到 → PrismError('graphify_missing')。
 *
 * Python 解释器名**不写死**：Windows 用 `python`、POSIX 用 `python3`，见 `resolvePythonCommand`。
 */
export async function resolveGraphifyCommand(env: NodeJS.ProcessEnv = process.env): Promise<GraphifyCommand> {
  const override = normalizeExecPath(env.GRAPHIFY_BIN?.trim() ?? '')
  if (override !== '') {
    if (/\.py$/i.test(override)) {
      return { command: resolvePythonCommand(env), prefixArgs: [override], shell: false }
    }
    if (/\.(mjs|cjs|js)$/i.test(override)) {
      return { command: process.execPath, prefixArgs: [override], shell: false }
    }
    if (/\.(cmd|bat)$/i.test(override)) {
      return { command: override, prefixArgs: [], shell: true }
    }
    return { command: override, prefixArgs: [], shell: false }
  }

  // 仓库内 vendored Python 子工程优先于 PATH（版本可控、可审计、免安装）
  const vendored = vendoredGraphifyDir()
  if (env.PRISM_SKIP_VENDORED !== '1' && (await assertFile(join(vendored, 'pyproject.toml')))) {
    return {
      command: resolvePythonCommand(env),
      prefixArgs: ['-m', 'graphify'],
      shell: false,
      // PYTHONPATH 指向子工程根：graphify 包从源码目录直接导入，不污染 site-packages
      env: { PYTHONPATH: vendored },
    }
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
    `找不到 graphify：仓库内子模块缺失（${vendored}），PATH 上也没有 graphify；可先 pnpm run 3rd:build（安装 Python 依赖），或设置 GRAPHIFY_BIN 覆盖`,
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
  const resolved = await resolveGraphifyCommand({ ...process.env, ...options.env })
  const timeoutMs = options.timeoutMs ?? DEFAULT_GRAPHIFY_TIMEOUT_MS
  // 环境覆盖必须继承完整父环境（Windows 子进程缺 SystemRoot/PATH 会启动异常）；
  // vendored 模式再叠加 resolved.env（PYTHONPATH 注入）
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, ...resolved.env }
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

/**
 * 建图两步（Python 版 graphify，code-graph.md：零 token、零 LLM）：
 * ① `graphify <root> --code-only` 全量提取（tree-sitter AST → graphify-out/graph.json + manifest.json）；
 * ② `graphify cluster-only <root> --no-label` 聚类 + GRAPH_REPORT.md + graph.html（跳过 LLM 社区命名）。
 * 产物落 `<root>/graphify-out/`（graph.json / manifest.json / graph.html / GRAPH_REPORT.md）。
 *
 * **`--code-only` 是红线 R2 的护栏**（裁决 D1）：裸路径就是 `graphify extract <root>`
 * （cli.py:4725-4731）。不加它时，只要扫描树内有 doc/paper/image，`needs_llm` 即为真
 * （cli.py:3642）：无 LLM key → 直接 exit 1（Prism 侧表现为 `graphify_failed`）；
 * 环境里恰好有 key → **真的调 LLM 抽文档语义**。`--code-only` 跳过整个语义层
 * （cli.py:3550-3563）。故全量固定钉死该 flag，**不提供「含文档」开关**；
 * 需要文档语义的宿主请自行跑 graphify，Prism 不做。
 *
 * **`--exclude .prism` 是防自污染**（v9 F1 / v9.1 B-3）：arch 产物落
 * `<projectRoot>/.prism/arch/<type>/`（`arch-placement.ts`），而 graphify 的
 * `_SKIP_DIRS`（`3rd/graphify/graphify/detect.py:827-851`）**只有** `graphify-out`/`.graphify`，
 * **不含 `.prism`** —— 不排除的话 `.ir.json`/`.meta.json` 会进代码扫描面，图越建越脏。
 * `--exclude` 只有 `extract`（默认路径）接受，且会被持久化进 `<graphify-out>/.graphify_build.json`
 * （cli.py:3384-3392），后续 `graphify update` **复用同一 exclude 集**——故只需钉在全量步。
 * 其余子命令（`update`/`cluster-only`/`query`/`export`）**不得**带它：`update` 只认
 * `--force`/`--no-cluster`，其他 `-` 开头参数一律 exit 2（cli.py:2400-2414）。
 */
export function buildGraphArgs(projectRoot: string, mode: 'full' | 'incremental' = 'full'): string[][] {
  // 增量（code-graph.md §3.2）：已有图谱时只重提取变化文件（graphify update，零 LLM），
  // 再聚类。首次建图仍走全量。
  // `update` **只接受** --force/--no-cluster，其他 `-` 开头参数一律 exit 2（cli.py:2400-2414），
  // 且它本就只重建代码（cli.py:2438）——故增量路径**不加** `--code-only`（也不加 `--exclude`，
  // 它复用全量步持久化下来的 exclude 集）。
  if (mode === 'incremental') {
    return [
      ['update', projectRoot],
      ['cluster-only', projectRoot, '--no-label'],
    ]
  }
  return [
    [projectRoot, '--code-only', '--exclude', PRISM_EXCLUDED_SCAN_DIR],
    ['cluster-only', projectRoot, '--no-label'],
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

// ===== 查询命令封装（Python 版 graphify 的 query/explain/affected/god-nodes） =====
// 注：`path` **不在**此列——v17 C-8 起改由 `graphPathChain` 服务端读图 BFS（见下文
// 「调用链路径」节），不再起子进程。

/** 图谱查询选项（graph 路径缺省用 <root>/graphify-out/graph.json）。 */
export interface GraphQueryOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/** 解析默认 graph.json 路径（Python 版产物目录）。 */
export function defaultGraphPath(root: string): string {
  return join(root, 'graphify-out', 'graph.json')
}

/** 执行一次查询命令并返回原始 stdout（文本或 JSON 字符串）。 */
async function runGraphQuery(
  args: string[],
  options: GraphQueryOptions,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runGraphify(args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  })
  /**
   * 行尾**单点归一**（F4-1，2026-09-16 黑盒）：Windows 下 Python CLI 的 stdout 是 **CRLF**，
   * 而 JS 的 `.` 不匹配 `\r`——本文件里带 `$` 锚的行解析正则（query 的 `^NODE …$`、
   * affected 的 `^- …$`、explain 的连接行）**一律**在没有 `m` 标志时锚到输入末尾，
   * 于是每条命中行都差一个 `\r` 而失配 → 结构化字段恒空（`nodes:[]`），
   * 只有不带 `$` 的 `Depth:` 能解析（黑盒现象即「raw 有命中行、nodes 恒空」）。
   * 单元 fixture 若用 `\n` join 则看不出来，故按真实 CLI 形态用 `\r\n` 钉死（见 graphify.test.ts）。
   *
   * 只此一处归一，下游 graphQuery/graphExplain/graphAffected 全部受益——
   * **不要**在各解析点各自剥 `\r`。`raw` 回显随之变成 LF（调试用字段，跨平台稳定，可接受）。
   * （`graphPath` 子命令的解析行 v17 C-8 已随该封装一并删除；`graphPathChain` 读 JSON，不经此归一。）
   */
  const normalize = (text: string): string => text.replace(/\r\n/g, '\n')
  // Python 版会在 stderr 打 skill 版本告警，不视为错误
  return { stdout: normalize(result.stdout), stderr: normalize(result.stderr) }
}

/** BFS/DFS 遍历查询（`graphify query "<q>" --graph <path>`）。 */
export async function graphQuery(
  root: string,
  question: string,
  options: GraphQueryOptions & { dfs?: boolean; budget?: number } = {},
): Promise<{ raw: string; nodes: Array<{ label: string; source?: string; loc?: string; community?: string }>; edges: string[] }> {
  const args = ['query', question, '--graph', defaultGraphPath(root)]
  if (options.dfs === true) args.push('--dfs')
  if (options.budget !== undefined) args.push('--budget', String(options.budget))
  const { stdout } = await runGraphQuery(args, options)
  const nodes: Array<{ label: string; source?: string; loc?: string; community?: string }> = []
  const edges: string[] = []
  for (const line of stdout.split('\n')) {
    const nodeMatch = line.match(/^NODE (.+?)(?: \[(.+)\])?$/)
    if (nodeMatch !== null) {
      const meta = nodeMatch[2] ?? ''
      const src = meta.match(/src=([^\s]+)/)?.[1]
      const loc = meta.match(/loc=([^\s]+)/)?.[1]
      const community = meta.match(/community=([^\]]+?)(?:\s|$)/)?.[1]
      nodes.push({
        label: nodeMatch[1]!.trim(),
        ...(src !== undefined ? { source: src } : {}),
        ...(loc !== undefined ? { loc } : {}),
        ...(community !== undefined ? { community } : {}),
      })
      continue
    }
    if (line.startsWith('EDGE ')) edges.push(line.slice(5).trim())
  }
  return { raw: stdout, nodes, edges }
}

/** 节点解释（`graphify explain "X" --graph <path>`）。 */
export async function graphExplain(
  root: string,
  node: string,
  options: GraphQueryOptions = {},
): Promise<{
  raw: string
  id: string | null
  source: string | null
  type: string | null
  community: string | null
  degree: number | null
  connections: Array<{ direction: 'in' | 'out'; label: string; relation: string; location: string | null }>
}> {
  const { stdout } = await runGraphQuery(['explain', node, '--graph', defaultGraphPath(root)], options)
  const field = (name: string): string | null => {
    const m = stdout.match(new RegExp(`^\\s*${name}:\\s+(.+)$`, 'm'))
    return m !== null ? m[1]!.trim() : null
  }
  const degreeRaw = field('Degree')
  const connections: Array<{ direction: 'in' | 'out'; label: string; relation: string; location: string | null }> = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(-->|<--)\s+(.+?)\s+\[([^\]]+)\]\s+\[[^\]]*\]\s*(.*)$/)
    if (m === null) continue
    connections.push({
      direction: m[1] === '-->' ? 'out' : 'in',
      label: m[2]!.trim(),
      relation: m[3]!,
      location: m[4]!.trim() === '' ? null : m[4]!.trim(),
    })
  }
  return {
    raw: stdout,
    id: field('ID'),
    source: field('Source'),
    type: field('Type'),
    community: field('Community'),
    degree: degreeRaw !== null && /^\d+$/.test(degreeRaw) ? Number(degreeRaw) : null,
    connections,
  }
}

/** 变更影响面（`graphify affected "X" --graph <path>`）。 */
export async function graphAffected(
  root: string,
  node: string,
  options: GraphQueryOptions & { depth?: number; relations?: string[] } = {},
): Promise<{ raw: string; depth: number | null; nodes: Array<{ label: string; relation: string; location: string | null }> }> {
  const args = ['affected', node, '--graph', defaultGraphPath(root)]
  if (options.depth !== undefined) args.push('--depth', String(options.depth))
  for (const relation of options.relations ?? []) args.push('--relation', relation)
  const { stdout } = await runGraphQuery(args, options)
  const depthMatch = stdout.match(/^Depth:\s+(\d+)/m)
  const nodes: Array<{ label: string; relation: string; location: string | null }> = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^-\s+(.+?)\s+\[([^\]]+)\]\s*(.*)$/)
    if (m === null) continue
    nodes.push({
      label: m[1]!.trim(),
      relation: m[2]!,
      location: m[3]!.trim() === '' ? null : m[3]!.trim(),
    })
  }
  return { raw: stdout, depth: depthMatch !== null ? Number(depthMatch[1]) : null, nodes }
}

/** 枢纽节点（`graphify god-nodes --graph <path> --top N --json`）。 */
export async function graphGodNodes(
  root: string,
  options: GraphQueryOptions & { top?: number } = {},
): Promise<{ raw: string; nodes: Array<{ id: string; label: string; degree: number }> }> {
  const args = ['god-nodes', '--graph', defaultGraphPath(root), '--json']
  if (options.top !== undefined) args.push('--top', String(options.top))
  const { stdout } = await runGraphQuery(args, options)
  let nodes: Array<{ id: string; label: string; degree: number }> = []
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (Array.isArray(parsed)) {
      nodes = parsed.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return []
        const r = item as Record<string, unknown>
        if (typeof r['label'] !== 'string') return []
        return [
          {
            id: typeof r['id'] === 'string' ? r['id'] : r['label'],
            label: r['label'],
            degree: typeof r['degree'] === 'number' ? r['degree'] : 0,
          },
        ]
      })
    }
  } catch {
    // JSON 解析失败 → 仅返回 raw
  }
  return { raw: stdout, nodes }
}

/** 图谱统计（读 graph.json 汇总，不调 CLI；零开销）。 */
export async function graphSummary(
  root: string,
): Promise<{ exists: boolean; nodes: number; edges: number; communities: number; path: string }> {
  const path = defaultGraphPath(root)
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
    const nodes = asArray(parsed['nodes']).length
    const edges = asArray(parsed['edges'] ?? parsed['links']).length
    const communities = new Set(
      asArray(parsed['nodes']).flatMap((n) => {
        if (typeof n !== 'object' || n === null) return []
        const c = (n as Record<string, unknown>)['community']
        return c === undefined || c === null ? [] : [String(c)]
      }),
    ).size
    return { exists: true, nodes, edges, communities, path }
  } catch {
    return { exists: false, nodes: 0, edges: 0, communities: 0, path }
  }
}

/**
 * 读 Graphify 图谱产物（`<root>/graphify-out/graph.json`）并**原样**返回。
 *
 * 读盘归 server，派生归 `@prism/agents` 的纯函数生成器——这条分工让生成器
 * 保持「零 IO、零时钟、零随机」，从而 `ir_hash` 才有意义（红线 R7）。
 *
 * 只做 JSON 解析，不做结构校验：字段缺失由生成器按各自口径降级处理
 * （Graphify 各版本字段并不齐，实测见 `graph-ir.ts` 文件头）。
 *
 * @throws PrismError `not_found` 图谱不存在；`bad_request` 产物不可解析。
 */
export async function readCodeGraph(root: string): Promise<CodeGraph> {
  const path = defaultGraphPath(root)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new PrismError('not_found', `图谱不存在: ${path}（先建图: prism graph build）`, { path })
  }
  try {
    return JSON.parse(raw) as CodeGraph
  } catch (error) {
    throw new PrismError('bad_request', `图谱产物不可解析: ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * 图谱产物**进程内缓存**（v10 F9 性能轨）。
 *
 * 缓存的边界刻意压到最小：**只包住 read+parse**，不缓存任何派生结果（rollup 分组每次都算）。
 * 失效键 = `path + mtimeMs + size`——**不用时间 TTL**：时间窗内的陈旧读就是「双真相源」
 * （R7 文件为真相）；mtime/size 是文件系统的既成事实，重新建图/换产物天然换 key。
 *
 * 命中时返回**同一个已解析对象**（调用方不得 mutate；本仓消费方都只读）。
 * `readCodeGraph` 本身保持「每请求 readFile+JSON.parse」不变（F5 等既有调用方零影响）。
 *
 * 为什么值得加：下钻一层就是一次请求（前端按 parent 逐层拉），单层 3.66MB 的 read+parse
 * 实测 ≈24ms，连续下钻会反复付出解析成本；有它之后只有首次付。
 */
const graphDocumentCache = new Map<string, { key: string; graph: CodeGraph }>()

/**
 * 同 `readCodeGraph`，但带上述失效键缓存。错误映射完全复用 `readCodeGraph`
 * （`not_found` 图谱不存在 / `bad_request` 产物不可解析），避免第二套文案。
 */
export async function readCodeGraphCached(root: string): Promise<CodeGraph> {
  return (await readCodeGraphCachedVersioned(root)).graph
}

/**
 * 同 `readCodeGraphCached`，但**一并返回版本键** `mtimeMs:size`（= 缓存的失效键）。
 *
 * 单开这一支的理由（v17 B-7）：rollup 分页要把图版本键写进 `next_cursor` 载荷——图一重建
 * （mtime/size 变）旧游标即失效（路由比对后回 409）。让调用方**复用同一次 stat**、
 * 也复用同一个键格式，避免第二处 `mtimeMs:size` 拼装漂移。
 */
export async function readCodeGraphCachedVersioned(
  root: string,
): Promise<{ graph: CodeGraph; version: string }> {
  const path = defaultGraphPath(root)
  let key: string
  try {
    const info = await stat(path)
    key = `${info.mtimeMs}:${info.size}`
  } catch {
    // 产物缺失/不可 stat：清掉可能存在的陈旧条目，让 readCodeGraph 抛标准错误
    graphDocumentCache.delete(path)
    // readCodeGraph 对缺失产物必抛，`version` 只是为类型齐全；调用方拿不到它
    return { graph: await readCodeGraph(root), version: '' }
  }
  const hit = graphDocumentCache.get(path)
  if (hit !== undefined && hit.key === key) return { graph: hit.graph, version: key }
  const graph = await readCodeGraph(root)
  graphDocumentCache.set(path, { key, graph })
  return { graph, version: key }
}

// ===== 调用链关系查询（v8 F4：直读 graph.json 内存过滤，零子进程） =====

/** 关系方向：`out` = 查询节点作为**发出方**（它调用谁）；`in` = **指向**查询节点（谁调用它）。 */
export type GraphRelationDir = 'in' | 'out'

/** items 缺省上限（hub 节点入边可上千；`total` 恒为过滤后全量计数，不受本值截断）。 */
export const DEFAULT_GRAPH_RELATION_LIMIT = 200

/** 一条关系（对端符号 + 调用发出侧 file:line；design-v8 §2 F4）。 */
export interface GraphRelationItem {
  /** 对端节点 id（**寻址一律用 id**——label 不唯一：本仓 2340 节点仅 2063 个唯一 label） */
  other: string
  /** 对端节点 label（渲染用；对端节点缺失 → 空串） */
  other_label: string
  /** 边上的 relation 原值（calls / imports_from / …） */
  kind: string
  /** 调用发出侧文件（相对项目根）；定位不到 → 空串 */
  file: string
  /** 调用发出侧行号（纯数字字符串，剥 `L` 前缀）；定位不到 → 空串 */
  line: string
}

/** 符号名多义命中时的候选（UI 让用户挑）。 */
export interface GraphNodeCandidate {
  id: string
  label: string
}

export interface GraphRelationsResult {
  /**
   * 命中节点 id；**多义时为查询原串**（无节点可回显，由 UI 用 candidates 二次寻址）。
   * 渲染/追问一律以本字段与 `other`（都是 id）为准。
   */
  node: string
  dir: GraphRelationDir
  /** 过滤后全量边数（不受 `limit` 截断） */
  total: number
  limit: number
  items: GraphRelationItem[]
  /** **仅**多义命中时出现；此时 `node`=原串、`total`=0、`items`=[] */
  candidates?: GraphNodeCandidate[]
}

export interface GraphRelationsQuery {
  /** graph.json 节点 id，或符号名（按 `norm_label` 精确 → 唯一前缀解析） */
  node: string
  dir: GraphRelationDir
  /** relation 白名单（精确匹配边的 `relation` 原值）；缺省/空 = 不过滤 */
  relations?: string[]
  /** items 上限；`total` 恒为全量计数 */
  limit: number
}

/**
 * 调用链关系查询（v8 F4）——**直读** `<root>/graphify-out/graph.json` 内存过滤，
 * **不起 graphify 子进程**（同 `graphSummary` 先例；本仓 2340 节点 / 7103 边，毫秒级）。
 *
 * file:line 取**边上的调用发出侧**（`source_file` / `source_location`，形如 `"L52"`）：
 * `dir=out` 即查询节点的调用处、`dir=in` 即调用方的调用处。边缺 location 时降级用
 * **查询节点自身**的 location（file 同取该节点的 `source_file`，二者始终同源），都缺则留空串。
 *
 * @throws PrismError `graph_not_found` 产物缺失（既有先例）；`bad_request` 产物不可解析；
 *                    `not_found` 节点解析 0 命中。
 */
export async function graphRelations(
  root: string,
  query: GraphRelationsQuery,
): Promise<GraphRelationsResult> {
  const document = await readGraphDocument(root)
  const nodes = readGraphNodes(document)
  const edges = readGraphEdges(document)

  const resolved = resolveGraphNode(nodes, query.node)
  if (resolved.kind === 'ambiguous') {
    return {
      node: query.node,
      dir: query.dir,
      total: 0,
      limit: query.limit,
      items: [],
      candidates: resolved.candidates,
    }
  }
  if (resolved.kind === 'missing') {
    throw new PrismError('not_found', `图谱中没有节点: ${query.node}（可先在 /api/graph/query 里找符号名）`)
  }

  const target = resolved.node
  const selfKey = query.dir === 'out' ? 'source' : 'target'
  const peerKey = query.dir === 'out' ? 'target' : 'source'
  const labelById = new Map(nodes.map((n) => [n.id, n.label]))
  const allowed =
    query.relations !== undefined && query.relations.length > 0 ? new Set(query.relations) : null

  const items: GraphRelationItem[] = []
  for (const edge of edges) {
    if (asText(edge[selfKey]) !== target.id) continue
    const kind = asText(edge['relation'])
    if (allowed !== null && !allowed.has(kind)) continue
    const other = asText(edge[peerKey])
    const location = relationLocation(edge, target)
    items.push({
      other,
      other_label: labelById.get(other) ?? '',
      kind,
      file: location.file,
      line: location.line,
    })
  }
  items.sort(compareRelationItems)
  return {
    node: target.id,
    dir: query.dir,
    total: items.length,
    limit: query.limit,
    items: items.slice(0, query.limit),
  }
}

/** 读 graph.json（缺失 → graph_not_found；不可解析/非对象 → bad_request）。 */
async function readGraphDocument(root: string): Promise<Record<string, unknown>> {
  const path = defaultGraphPath(root)
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    throw new PrismError('graph_not_found', `图谱不存在: ${path}（请先建图）`, { path })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new PrismError('bad_request', `图谱产物不可解析: ${path}`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PrismError('bad_request', `图谱产物结构不可识别: ${path}`, { path })
  }
  return parsed as Record<string, unknown>
}

/** 节点记录（容忍字段缺失/异形；无 id 的条目丢弃）。 */
interface GraphNodeRecord {
  id: string
  label: string
  norm_label: string
  source_file: string
  source_location: string
}

function readGraphNodes(document: Record<string, unknown>): GraphNodeRecord[] {
  const nodes: GraphNodeRecord[] = []
  for (const item of asRecords(document['nodes'])) {
    const id = asText(item['id'])
    if (id === '') continue
    nodes.push({
      id,
      label: asText(item['label']),
      norm_label: asText(item['norm_label']),
      source_file: asText(item['source_file']),
      source_location: asText(item['source_location']),
    })
  }
  return nodes
}

/**
 * 边：Python graphify（networkx node_link_data）实测写在 **`links`**（本仓 7103 条边），
 * 旧版/合并产物可能写 `edges`——两处都认（同 `graphSummary` 口径）。
 *
 * 取**非空**的那一边：两键并存且 `edges` 为空数组时，简单 `??` 会静默返回空结果
 * （「产物有边、接口报 0 条」这类静默降级最难查）。
 */
function readGraphEdges(document: Record<string, unknown>): Array<Record<string, unknown>> {
  const edges = asRecords(document['edges'])
  return edges.length > 0 ? edges : asRecords(document['links'])
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item),
  )
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

type GraphNodeResolution =
  | { kind: 'found'; node: GraphNodeRecord }
  | { kind: 'ambiguous'; candidates: GraphNodeCandidate[] }
  | { kind: 'missing' }

/**
 * 节点解析（契约顺序，逐级降级）：
 * ① 精确 `id` 命中即用（**区分大小写**——id 是寻址主键）；
 * ② 否则 `norm_label` 精确匹配（查询串先 `toLowerCase()` 归一：实测 `norm_label ≡ label.toLowerCase()`）；
 * ③ 仍未命中 → `norm_label` **前缀**匹配；
 * ④ 命中恰好 1 个 → 用它；⑤ ≥2 个 → 多义（候选交 UI 挑）；⑥ 0 个 → 无此节点。
 * ②③ 都可能多义（本仓 2340 节点仅 2063 个唯一 label；按归一化名寻址时，2056 个唯一
 * `norm_label` 里有 164 个对应多个节点）。
 */
function resolveGraphNode(nodes: GraphNodeRecord[], query: string): GraphNodeResolution {
  const exactId = nodes.find((n) => n.id === query)
  if (exactId !== undefined) {
    return { kind: 'found', node: exactId }
  }
  const needle = query.toLowerCase()
  const exact = nodes.filter((n) => n.norm_label === needle)
  if (exact.length > 0) {
    return singleResolution(exact)
  }
  return singleResolution(nodes.filter((n) => n.norm_label !== '' && n.norm_label.startsWith(needle)))
}

function singleResolution(matches: GraphNodeRecord[]): GraphNodeResolution {
  if (matches.length === 0) return { kind: 'missing' }
  if (matches.length === 1) return { kind: 'found', node: matches[0]! }
  return {
    kind: 'ambiguous',
    candidates: matches
      .map((n) => ({ id: n.id, label: n.label }))
      .sort((a, b) => (a.label !== b.label ? (a.label < b.label ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

/** 调用点 file:line：**边 → 查询节点 → 都缺留空串**（file 与 line 始终同源，不拼两家）。 */
function relationLocation(
  edge: Record<string, unknown>,
  node: GraphNodeRecord,
): { file: string; line: string } {
  const edgeLine = stripLinePrefix(asText(edge['source_location']))
  if (edgeLine !== '') {
    return { file: asText(edge['source_file']), line: edgeLine }
  }
  const nodeLine = stripLinePrefix(node.source_location)
  if (nodeLine !== '') {
    return { file: node.source_file, line: nodeLine }
  }
  return { file: '', line: '' }
}

/** `"L52"` → `"52"`（剥前缀得纯数字串）；已是纯数字原样；其它形态原样返回（不猜）。 */
function stripLinePrefix(raw: string): string {
  const match = /^[Ll]?(\d+)$/.exec(raw)
  return match !== null ? match[1]! : raw
}

/** items 稳定排序 `(file, line, other)`——保证幂等响应。 */
function compareRelationItems(a: GraphRelationItem, b: GraphRelationItem): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  const byLine = compareLine(a.line, b.line)
  if (byLine !== 0) return byLine
  return a.other < b.other ? -1 : a.other > b.other ? 1 : 0
}

/** 行号按**数值**比较（L9 排在 L52 前；空行号居首），非数字形态回落字典序。 */
function compareLine(a: string, b: string): number {
  if (a === b) return 0
  if (a === '') return -1
  if (b === '') return 1
  const left = Number(a)
  const right = Number(b)
  if (Number.isInteger(left) && Number.isInteger(right)) return left - right
  return a < b ? -1 : 1
}

// ===== 调用链路径（v17 C-8：服务端读图 + BFS 自求路径） =====

/**
 * 路径链上的一跳节点。
 *
 * `file`/`line` 取的是该节点**发出**的那条边的调用点（`relations` 的 `dir=out` 同口径：
 * 边上的 `source_file` + `source_location`，形如 `"L52"`）——即「它在哪里调起了下一跳」。
 * 于是**末位**节点（链尾）的 file/line 恒为空串：链尾没有下一跳可标。
 */
export interface GraphPathChainHop {
  /** 节点 id（前端导出时序图直接用：`symbols: chain.map((h) => h.id)`） */
  id: string
  /** 节点 label（渲染用；节点无 label → 回落 id） */
  label: string
  /** 调用发出侧文件（项目相对、正斜杠）；链尾/多义跳 → 空串 */
  file: string
  /** 调用发出侧行号（纯数字串，剥 `L` 前缀）；链尾/多义跳 → 空串 */
  line: string
  /** 该跳的**符号**在图内没有唯一节点对应（起/终点入参多义）→ true；此时 file/line 必为空串 */
  ambiguous?: boolean
}

export interface GraphPathChainResult {
  /**
   * 链路的**文本渲染**（服务端自求；**不再是** graphify 子进程原文）。
   * 人类可读输出（CLI 非 `--json`）用它；形态刻意贴近原来的 graphify 输出
   * （`Shortest path (N hops):` + `A --calls--> B`）。
   */
  raw: string
  /** 跳数 = `chain.length - 1`；无解/无节点 → null */
  hops: number | null
  chain: GraphPathChainHop[]
  found: boolean
}

/**
 * 两节点间**有向**最短路径（v17 C-8 / SPEC-C8.1）。
 *
 * 为什么不再调 `graphify path` 子进程：它的输出**只有 label 链**（`graphify.ts` 旧实现），
 * 而下游（时序图导出 / 前端链路图）**按节点 id 寻址**（本仓冻结裁决 F5-2 禁止 label 顶替
 * 寻址；本仓 2340 节点仅 2063 个唯一 label，159 个 label 值跨文件重名）——label 反推必错。故改为：**服务端直读
 * `<root>/graphify-out/graph.json` → 在内存里自己 BFS**（带 mtime+size 失效键的进程内缓存，
 * 只缓存 read+parse，与 rollup 同先例），每跳 file:line 从 BFS 用到的**边数据**取。
 *
 * 入参语义（`from`/`to` 既可是节点 id 也可是符号名）：
 * ① 精确 `id` 命中优先；② 其次 `norm_label` 精确（唯一 → 用；多义 → **多源 BFS**）；
 * ③ 再退唯一前缀（与 `/api/graph/relations` 共用同一个 `resolveGraphNode`，不另造一套）。
 * 多义端点**不猜**：以全部候选为 BFS 源/靶，取**首个可达**的候选落链（图内节点序 →
 * 邻居 id 序，全程确定），并把该端点标 `ambiguous: true`（file/line 置空，前端灰显）。
 *
 * 无解 / 端点在图内不存在 / 起终点落到同一节点 → `found: false` + `chain: []`
 * （**不抛错**：调用方查一个不存在的符号只是「没路径」，不是服务端故障）。
 *
 * 方向口径：**有向**（沿 `source → target`），与 graphify CLI 的默认（不加 `--undirected`）
 * 一致。边的端点是 `source`/`target`、调用点是 `source_file`/`source_location`（本仓
 * 7103 边实测；graphify 内部才用的 `_src`/`_tgt` 标记本仓产物里 0 条）。
 */
export async function graphPathChain(
  root: string,
  from: string,
  to: string,
): Promise<GraphPathChainResult> {
  const document = await readGraphDocumentCached(root)
  const nodes = readGraphNodes(document)
  const edges = readGraphEdges(document)

  const empty = (raw: string): GraphPathChainResult => ({ raw, hops: null, chain: [], found: false })

  const source = resolveGraphNode(nodes, from)
  if (source.kind === 'missing') return empty(`No node matching '${from}' found.`)
  const target = resolveGraphNode(nodes, to)
  if (target.kind === 'missing') return empty(`No node matching '${to}' found.`)

  // 有向邻接 + 同向首条边（BFS 只关心「这条边在」，file:line/relation 取首条即可）
  const adjacency = new Map<string, string[]>()
  const edgeOf = new Map<string, Record<string, unknown>>()
  for (const edge of edges) {
    const edgeSource = asText(edge['source'])
    const edgeTarget = asText(edge['target'])
    if (edgeSource === '' || edgeTarget === '') continue
    const list = adjacency.get(edgeSource) ?? []
    list.push(edgeTarget)
    adjacency.set(edgeSource, list)
    const key = pairKey(edgeSource, edgeTarget)
    if (!edgeOf.has(key)) edgeOf.set(key, edge)
  }
  // 邻居**排序**：同长度的多条路径之间必须有唯一的确定解（否则同一张图两次查询可能给出不同链）
  for (const [key, list] of adjacency) {
    adjacency.set(key, [...new Set(list)].sort())
  }

  const sources = endpointIds(nodes, source)
  const targets = new Set(endpointIds(nodes, target))

  // 多源 BFS：源按**图内节点序**入队（「图内首个唯一匹配」的落地），邻居按 id 序展开
  const previous = new Map<string, string>()
  const seen = new Set<string>(sources)
  const queue = [...sources]
  let end: string | null = null
  while (queue.length > 0) {
    const current = queue.shift()!
    if (targets.has(current)) {
      end = current
      break
    }
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      previous.set(next, current)
      queue.push(next)
    }
  }

  if (end === null) {
    return empty(`No path found between '${from}' and '${to}'.`)
  }
  const ids: string[] = [end]
  while (previous.has(ids[0]!)) {
    ids.unshift(previous.get(ids[0]!)!)
  }
  if (ids.length < 2) {
    // 起终点落到同一节点（含 from===to）：0 跳不是调用链，宁缺毋滥
    return empty(
      `'${from}' 与 '${to}' 解析到同一节点 ${ids[0]}，无法构造调用链（请用更具体的符号或节点 id）。`,
    )
  }

  const labelById = new Map(nodes.map((node) => [node.id, node.label]))
  const ambiguousEnds = new Set<number>([0, ids.length - 1].filter((index) =>
    (index === 0 ? source : target).kind === 'ambiguous',
  ))

  const chain: GraphPathChainHop[] = ids.map((id, index) => {
    const ambiguous = ambiguousEnds.has(index)
    // file/line = 该节点**发出**的那条边（链尾没有下一跳 → 空串）；多义跳**不带** file:line
    const next = index + 1 < ids.length ? edgeOf.get(pairKey(id, ids[index + 1]!)) : undefined
    const location = ambiguous || next === undefined ? { file: '', line: '' } : locationOfEdge(next)
    return {
      id,
      label: labelById.get(id)?.trim() || id,
      file: location.file,
      line: location.line,
      ...(ambiguous ? { ambiguous: true } : {}),
    }
  })

  const segments = ids.map((id, index) => {
    const label = chain[index]!.label
    if (index === 0) return label
    const edge = edgeOf.get(pairKey(ids[index - 1]!, id))
    const relation = edge !== undefined ? asText(edge['relation']) || 'related' : 'related'
    return `--${relation}--> ${label}`
  })

  return {
    raw: `Shortest path (${chain.length - 1} hops):\n  ${segments.join(' ')}`,
    hops: chain.length - 1,
    chain,
    found: true,
  }
}

/** 端点解析结果 → **图内节点序**的候选 id 列表（单义 = 1 个）。 */
function endpointIds(
  nodes: GraphNodeRecord[],
  resolution: GraphNodeResolution,
): string[] {
  if (resolution.kind === 'found') return [resolution.node.id]
  if (resolution.kind === 'ambiguous') {
    const ids = new Set(resolution.candidates.map((candidate) => candidate.id))
    return nodes.filter((node) => ids.has(node.id)).map((node) => node.id)
  }
  return []
}

/** 边索引键（`\u0000` 分隔：节点 id 里不会出现该字符，避免拼接歧义）。 */
function pairKey(source: string, target: string): string {
  return `${source}\u0000${target}`
}

/** 边的调用点 file:line（`source_location` 剥 `L` 前缀；**不**回落节点——链路里边的位置才是这一跳的位置）。 */
function locationOfEdge(edge: Record<string, unknown>): { file: string; line: string } {
  return {
    file: asText(edge['source_file']).replace(/\\/g, '/'),
    line: stripLinePrefix(asText(edge['source_location'])),
  }
}

/**
 * `readGraphDocument` 的**缓存版**：走 `readCodeGraphCached` 的 `path + mtimeMs + size`
 * 失效键（rollup 先例——只缓存 read+parse，不缓存派生结果；图重建天然换 key）。
 */
async function readGraphDocumentCached(root: string): Promise<Record<string, unknown>> {
  const graph = await readCodeGraphCached(root)
  return graph as unknown as Record<string, unknown>
}

// ===== 导出命令封装（graphify export <format>） =====
/** graphify 支持的导出格式（Python 版 export 子命令）。 */
export const GRAPHIFY_EXPORT_FORMATS = [
  'obsidian',
  'wiki',
  'svg',
  'graphml',
  'neo4j',
  'falkordb',
  'callflow-html',
] as const

export type GraphifyExportFormat = (typeof GRAPHIFY_EXPORT_FORMATS)[number]

export const EXPORT_FORMAT_LABELS: Record<GraphifyExportFormat, string> = {
  obsidian: 'Obsidian 仓库（笔记 + Canvas）',
  wiki: 'Wiki Markdown 文章',
  svg: 'SVG 矢量图',
  graphml: 'GraphML（Gephi/yEd）',
  neo4j: 'Neo4j Cypher',
  falkordb: 'FalkorDB Cypher',
  'callflow-html': '调用流 HTML（Mermaid）',
}

export interface GraphExportResult {
  format: GraphifyExportFormat
  /** 产物路径（目录或文件） */
  output: string
  /** 产物文件清单（目录型格式） */
  files: string[]
  raw: string
}

/**
 * 导出图谱为其他格式（`graphify export <format> --graph <path>`）。
 * obsidian → `<root>/graphify-out/obsidian/`（笔记 + graph.canvas）；
 * svg/graphml → `<root>/graphify-out/graph.<ext>`；wiki → `<root>/graphify-out/wiki/`。
 */
export async function graphExport(
  root: string,
  format: GraphifyExportFormat,
  options: GraphQueryOptions = {},
): Promise<GraphExportResult> {
  if (!GRAPHIFY_EXPORT_FORMATS.includes(format)) {
    throw new PrismError('bad_request', `不支持的导出格式: ${format}`, {
      allowed: GRAPHIFY_EXPORT_FORMATS,
    })
  }
  const graphPath = defaultGraphPath(root)
  const outDir = join(root, 'graphify-out')
  const args = ['export', format, '--graph', graphPath]
  if (format === 'obsidian') args.push('--dir', join(outDir, 'obsidian'))

  const { stdout } = await runGraphQuery(args, options)

  // 产物定位：目录型（obsidian/wiki）与文件型（svg/graphml/neo4j/falkordb）分开处理
  const dirFormats: GraphifyExportFormat[] = ['obsidian', 'wiki']
  let output: string
  let files: string[] = []
  if (dirFormats.includes(format)) {
    output = join(outDir, format)
    try {
      const { readdir } = await import('node:fs/promises')
      files = (await readdir(output)).sort()
    } catch {
      files = []
    }
  } else if (format === 'svg') {
    output = join(outDir, 'graph.svg')
    files = ['graph.svg']
  } else if (format === 'graphml') {
    output = join(outDir, 'graph.graphml')
    files = ['graph.graphml']
  } else {
    // neo4j / falkordb / callflow-html：Cypher 或 HTML，路径由 CLI 决定
    output = outDir
    const match = stdout.match(/(?:written|saved|Cypher|HTML)[^\n]*?([A-Za-z]:[\\/][^\s]+)/)
    files = match !== null ? [match[1]!] : []
  }
  return { format, output, files, raw: stdout }
}

// ===== 外部 graph.json 的渲染/导出（知识图谱借 Graphify，D9） =====

export interface RenderExternalGraphResult {
  /** 渲染出的自包含 HTML */
  htmlPath: string
  /** 聚类后回写的 graph.json（含 community） */
  graphPath: string
  raw: string
}

/**
 * 对**外部生成的** graph.json 做聚类 + 渲染 + 报告：
 *   `graphify cluster-only <workdir> --graph <graphJson> --no-label`
 *
 * 用途（D9）：Prism 零 LLM 抽出的知识边表转成 Graphify 格式后，借它的社区发现与渲染。
 * 产物落 `<workdir>/graphify-out/`（graph.html / GRAPH_REPORT.md / graph.json）。
 */
export async function renderExternalGraph(
  workDir: string,
  graphJsonPath: string,
  options: GraphQueryOptions = {},
): Promise<RenderExternalGraphResult> {
  const { stdout } = await runGraphQuery(
    ['cluster-only', workDir, '--graph', graphJsonPath, '--no-label'],
    options,
  )
  const outDir = join(workDir, 'graphify-out')
  return {
    htmlPath: join(outDir, 'graph.html'),
    graphPath: join(outDir, 'graph.json'),
    raw: stdout,
  }
}

/**
 * 导出**外部生成的** graph.json（`graphify export <format> --graph <file>`）。
 * 与 `graphExport` 的区别：不假设 graph 在 `<root>/graphify-out/`，产物落 `<outDir>/`。
 */
export async function exportExternalGraph(
  graphJsonPath: string,
  format: GraphifyExportFormat,
  outDir: string,
  options: GraphQueryOptions = {},
): Promise<GraphExportResult> {
  if (!GRAPHIFY_EXPORT_FORMATS.includes(format)) {
    throw new PrismError('bad_request', `不支持的导出格式: ${format}`, {
      allowed: GRAPHIFY_EXPORT_FORMATS,
    })
  }
  const args = ['export', format, '--graph', graphJsonPath]
  if (format === 'obsidian') args.push('--dir', join(outDir, 'obsidian'))

  const { stdout } = await runGraphQuery(args, options)

  let output: string
  let files: string[] = []
  if (format === 'obsidian' || format === 'wiki') {
    output = join(outDir, format)
    try {
      const { readdir } = await import('node:fs/promises')
      files = (await readdir(output)).sort()
    } catch {
      files = []
    }
  } else if (format === 'svg') {
    output = join(outDir, 'graph.svg')
    files = ['graph.svg']
  } else if (format === 'graphml') {
    output = join(outDir, 'graph.graphml')
    files = ['graph.graphml']
  } else {
    output = outDir
    const match = stdout.match(/(?:written|saved|Cypher|HTML)[^\n]*?([A-Za-z]:[\\/][^\s]+)/)
    files = match !== null ? [match[1]!] : []
  }
  return { format, output, files, raw: stdout }
}

// ===== 多项目图谱合并（v5 F-C2；Python 版 `graphify merge-graphs`） =====

/**
 * 合并命令参数：`graphify merge-graphs <g1> <g2> [...] --out <outPath>`。
 *
 * **`--out` 必须显式传**：省略时 graphify 默认写 `<cwd>/graphify-out/merged-graph.json`
 * （cli.py:2607），会污染某个项目根（裁决 D2 明令禁止）。
 * 输入 <2：graphify 自己也会 exit 1（cli.py:2616-2621），这里提前给出 `bad_request`，
 * 免得把参数错误伪装成 `graphify_failed`。
 */
export function mergeGraphArgs(graphPaths: string[], outPath: string): string[] {
  if (graphPaths.length < 2) {
    throw new PrismError('bad_request', `合并至少需要 2 个项目图谱，收到 ${graphPaths.length} 个`, {
      graphPaths,
    })
  }
  return ['merge-graphs', ...graphPaths, '--out', outPath]
}

export interface MergeGraphsResult {
  /** 合并产出的 graph.json 绝对路径（此时尚未聚类，无 community 字段） */
  graphPath: string
  /** graphify 打印的汇总节点数（解析不到 → null，不猜） */
  nodes: number | null
  /** graphify 打印的汇总边数（解析不到 → null） */
  edges: number | null
  raw: string
}

/**
 * 执行合并，产出合并后的 graph.json（**只合并**，不渲染）。
 * 渲染（cluster-only → graph.html）见 `renderExternalGraph` / `mergeProjectGraphs`。
 *
 * 实测（2026-09-11，vendored graphify）：`graphify merge-graphs A/graph.json B/graph.json --out M/merged-graph.json`
 * 打印 `Merged 2 graphs -> 4 nodes, 2 edges`；**节点 id 会带 repo 前缀**（cli.py:2686-2712），
 * 故合并图上按原名 `explain/path` 可能查不到，需用带前缀的 id。
 */
export async function mergeGraphs(
  graphPaths: string[],
  outPath: string,
  options: GraphQueryOptions = {},
): Promise<MergeGraphsResult> {
  // 参数校验先于任何 IO：<2 输入直接 bad_request，不启动子进程
  const args = mergeGraphArgs(graphPaths, outPath)
  const { stdout } = await runGraphQuery(args, options)
  const summary = stdout.match(/Merged\s+\d+\s+graphs?\s*->\s*(\d+)\s+nodes?,\s*(\d+)\s+edges?/i)
  return {
    graphPath: outPath,
    nodes: summary !== null ? Number(summary[1]) : null,
    edges: summary !== null ? Number(summary[2]) : null,
    raw: stdout,
  }
}
