import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PrismError } from '@prism/core'

/** 建图默认超时（design.md §4：300s）。 */
export const DEFAULT_GRAPHIFY_TIMEOUT_MS = 300_000

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
 * 源码 `packages/server/src/graph/graphify.ts` 与产物 `packages/server/dist/graph/graphify.js`
 * 到仓库根都是 4 层，故统一 `../../../../3rd/...`。
 */
export function vendoredGraphifyDir(): string {
  return fileURLToPath(new URL('../../../../3rd/graphify', import.meta.url))
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
 * 解析 graphify 可执行入口（design.md §4 Windows 约束）：
 * 1. `GRAPHIFY_BIN` 环境变量优先（.py 经 python；.js/.mjs/.cjs 经 node；.cmd/.bat shell 执行）；
 * 2. 仓库内 `3rd/graphify`（submodule，经 `python -m graphify` + PYTHONPATH 免安装调用；
 *    依赖需先 `pnpm run 3rd:build` 安装；设 `PRISM_SKIP_VENDORED=1` 跳过本分支供测试隔离）；
 * 3. 否则在 PATH 上找 `graphify.cmd`/`graphify.exe`/`graphify`（Windows）；
 * 4. 找不到 → PrismError('graphify_missing')。
 */
export async function resolveGraphifyCommand(env: NodeJS.ProcessEnv = process.env): Promise<GraphifyCommand> {
  const override = normalizeExecPath(env.GRAPHIFY_BIN?.trim() ?? '')
  if (override !== '') {
    if (/\.py$/i.test(override)) {
      return { command: 'python', prefixArgs: [override], shell: false }
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
      command: 'python',
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
 * ① `graphify <root>` 全量提取（tree-sitter AST → graphify-out/graph.json + manifest.json）；
 * ② `graphify cluster-only <root> --no-label` 聚类 + GRAPH_REPORT.md + graph.html（跳过 LLM 社区命名）。
 * 产物落 `<root>/graphify-out/`。
 */
export function buildGraphArgs(projectRoot: string, mode: 'full' | 'incremental' = 'full'): string[][] {
  // 增量（code-graph.md §3.2）：已有图谱时只重提取变化文件（graphify update，零 LLM），
  // 再聚类。首次建图仍走全量。
  if (mode === 'incremental') {
    return [
      ['update', projectRoot],
      ['cluster-only', projectRoot, '--no-label'],
    ]
  }
  return [
    [projectRoot],
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

// ===== 查询命令封装（Python 版 graphify 的 query/path/explain/affected/god-nodes） =====

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
  // Python 版会在 stderr 打 skill 版本告警，不视为错误
  return { stdout: result.stdout, stderr: result.stderr }
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

/** 最短路径（`graphify path "A" "B" --graph <path>`）。 */
export async function graphPath(
  root: string,
  from: string,
  to: string,
  options: GraphQueryOptions = {},
): Promise<{ raw: string; hops: number | null; chain: string[]; found: boolean }> {
  const { stdout } = await runGraphQuery(['path', from, to, '--graph', defaultGraphPath(root)], options)
  const found = !/^No (node matching|path)/i.test(stdout.trim())
  const hopsMatch = stdout.match(/\((\d+) hops?\)/)
  const chainLine = stdout.split('\n').find((l) => l.includes('-->'))
  const chain =
    chainLine === undefined
      ? []
      : chainLine
          .replace(/^\s*/, '')
          .split(/--[^-]*-->/)
          .map((s) => s.trim())
          .filter((s) => s !== '')
  return {
    raw: stdout,
    hops: hopsMatch !== null ? Number(hopsMatch[1]) : null,
    chain,
    found,
  }
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
