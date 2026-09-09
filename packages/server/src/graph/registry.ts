import { createHash } from 'node:crypto'
import { rename, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import { PrismError, SingleWriterQueue } from '@prism/core'

/** 项目注册表条目（design.md §4 GET /api/graph/projects）。 */
export interface ProjectInfo {
  project: string
  root: string
  built_at: string | null
  /**
   * 失效标记：注册项 root 下已无 `.graphify/graph.json`（产物被清理或尚未建完）。
   * 语义：**保留条目并标 stale:true**（不删除、不隐藏——用户能看到并重新 build），
   * studio/query 等消费方在产物缺失时各自返回 404/graph_not_found。
   */
  stale: boolean
}

interface RegistryFile {
  version: 1
  projects: Record<string, { root: string; built_at: string | null }>
}

const EMPTY_REGISTRY: RegistryFile = { version: 1, projects: {} }

/**
 * 图谱项目注册表：`<PRISM_HOME>/graph/projects.json`（跨进程持久化，返工单 B3）。
 *
 * - **每次访问都重读磁盘**（不再有进程内缓存闩）：CLI 进程 A 建图注册后，serve 进程 B
 *   的下一次请求即可读到，与建图/起服顺序无关。
 * - **原子写**：tmp 文件 + rename 覆盖（进程内再经 SingleWriterQueue 串行）；
 *   跨进程并发为「整文件原子替换、后写胜出」，读方永远看不到半截 JSON。
 * - project 名 → 项目根路径（绝不接受任意路径直接 serve，防穿越；design.md §4）。
 */
export class ProjectRegistry {
  readonly #file: string
  readonly #writeQueue = new SingleWriterQueue()

  constructor(home: string) {
    this.#file = join(home, 'graph', 'projects.json')
  }

  async list(): Promise<ProjectInfo[]> {
    const data = await this.#read()
    const projects: ProjectInfo[] = []
    for (const [project, info] of Object.entries(data.projects)) {
      projects.push({
        project,
        root: info.root,
        built_at: info.built_at,
        stale: !(await graphExists(info.root)),
      })
    }
    return projects.sort((a, b) => a.project.localeCompare(b.project))
  }

  /** 取项目；不存在 → not_found。 */
  async get(project: string): Promise<ProjectInfo> {
    const data = await this.#read()
    const info = data.projects[project]
    if (info === undefined) {
      throw new PrismError('not_found', `未注册的图谱项目: ${project}（可经 POST /api/graph/build 或 prism graph build 注册）`)
    }
    return { project, root: info.root, built_at: info.built_at, stale: !(await graphExists(info.root)) }
  }

  /** 注册或更新项目（原子写；同项目并发注册为后写胜出）。 */
  async register(project: string, root: string, builtAt: string | null = null): Promise<ProjectInfo> {
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      data.projects[project] = { root, built_at: builtAt }
      await this.#save(data)
    })
    return { project, root, built_at: builtAt, stale: !(await graphExists(root)) }
  }

  async markBuilt(project: string, builtAt: string): Promise<void> {
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      const info = data.projects[project]
      if (info !== undefined) {
        info.built_at = builtAt
        await this.#save(data)
      }
    })
  }

  /** 从磁盘读取（文件缺失/损坏 → 空注册表，不抛）。 */
  async #read(): Promise<RegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf-8')) as RegistryFile
      if (parsed !== null && typeof parsed === 'object' && parsed.projects !== null && typeof parsed.projects === 'object') {
        return { version: 1, projects: parsed.projects }
      }
    } catch {
      // 无文件或损坏 → 空注册表
    }
    return { ...EMPTY_REGISTRY, projects: {} }
  }

  /** 原子写：tmp + rename（Windows 上 rename 覆盖已有文件；瞬时锁重试）。 */
  async #save(data: RegistryFile): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(tmp, this.#file)
        return
      } catch (error) {
        lastError = error
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
      }
    }
    throw lastError
  }
}

/** 项目根下是否有图谱产物。 */
export async function graphExists(root: string): Promise<boolean> {
  return await isFile(join(root, '.graphify', 'graph.json'))
}

async function isFile(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

// ===== 陈旧检测（code-graph.md §7：manifest 哈希 + git HEAD） =====

export interface GraphStatusDetail {
  project: string
  root: string
  graph_exists: boolean
  built_at: string | null
  head: { current: string | null; built: string | null }
  changed_files: number
  total_files: number
  stale: boolean
  note?: string
}

/**
 * 陈旧检测（尽力而为）：读 `.graphify/manifest.json`（Graphify 产物）。
 * 实测结构为「顶层 文件路径 → { mtime, hash }」映射（兼容 files/hashes 包裹形态）。
 * 比对策略：有 mtime 用 mtime；hash 为 64/40 位十六进制时用 SHA-256/SHA-1；
 * 无法识别的哈希算法跳过该文件并在 note 说明。git HEAD 取当前 HEAD 对比。
 */
export async function inspectGraphStatus(project: string, root: string, builtAt: string | null): Promise<GraphStatusDetail> {
  const graphPath = join(root, '.graphify', 'graph.json')
  const manifestPath = join(root, '.graphify', 'manifest.json')
  const graphExistsFlag = await isFile(graphPath)

  const detail: GraphStatusDetail = {
    project,
    root,
    graph_exists: graphExistsFlag,
    built_at: builtAt,
    head: { current: null, built: null },
    changed_files: 0,
    total_files: 0,
    stale: !graphExistsFlag,
  }
  if (!graphExistsFlag) {
    detail.note = '图谱不存在（尚未建图或产物被清理）'
    return detail
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
  } catch {
    detail.note = 'manifest.json 缺失或不可解析，跳过哈希对比'
    return detail
  }

  const entries = extractManifestEntries(manifest)
  if (entries === null) {
    detail.note = 'manifest.json 结构不可识别，跳过哈希对比'
    return detail
  }

  const builtHead = extractString(manifest, ['git_head', 'head', 'gitHead', 'commit'])
  const [currentHead, [changed, skipped]] = await Promise.all([gitHead(root), countChanged(root, entries)])
  detail.head = { current: currentHead, built: builtHead }
  detail.total_files = entries.length
  detail.changed_files = changed
  detail.stale = changed > 0 || (builtHead !== null && currentHead !== null && builtHead !== currentHead)
  if (skipped > 0) {
    detail.note = `${skipped} 个文件哈希算法不可识别，未参与比对`
  }
  return detail
}

interface ManifestEntry {
  path: string
  hash?: string
  mtime?: number
}

/** 兼容两种形态：顶层 文件→条目 映射，或 { files | hashes | entries } 包裹。 */
function extractManifestEntries(manifest: unknown): ManifestEntry[] | null {
  if (manifest === null || typeof manifest !== 'object') {
    return null
  }
  const record = manifest as Record<string, unknown>
  let raw: Record<string, unknown> = record
  const wrapper = record.files ?? record.hashes ?? record.entries
  if (wrapper !== null && typeof wrapper === 'object' && !Array.isArray(wrapper)) {
    raw = wrapper as Record<string, unknown>
  }
  const entries: ManifestEntry[] = []
  for (const [path, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      entries.push({ path, hash: value })
    } else if (value !== null && typeof value === 'object') {
      const item = value as Record<string, unknown>
      entries.push({
        path,
        hash: typeof item.hash === 'string' ? item.hash : undefined,
        mtime: typeof item.mtime === 'number' ? item.mtime : undefined,
      })
    }
  }
  return entries.length > 0 ? entries : null
}

function extractString(manifest: unknown, keys: string[]): string | null {
  if (manifest === null || typeof manifest !== 'object') {
    return null
  }
  const record = manifest as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') {
      return value
    }
  }
  return null
}

async function countChanged(root: string, entries: ManifestEntry[]): Promise<[changed: number, skipped: number]> {
  const { stat } = await import('node:fs/promises')
  let changed = 0
  let skipped = 0
  for (const entry of entries) {
    // manifest 里的路径可能是绝对路径（graphify 实测如此），也可能是相对项目根
    const abs = /^([a-zA-Z]:)?[\\/]/.test(entry.path) ? entry.path.replace(/\//g, '\\') : join(root, entry.path)
    try {
      const [content, fileStat] = await Promise.all([readFile(abs), stat(abs)])
      if (entry.mtime !== undefined) {
        // mtime 比对（graphify 实测提供；秒级容忍）
        if (Math.abs(fileStat.mtimeMs - entry.mtime) > 1000) {
          changed++
        }
        continue
      }
      const hash = entry.hash?.toLowerCase()
      if (hash === undefined) {
        skipped++
        continue
      }
      const matches =
        (hash.length === 64 && createHash('sha256').update(content).digest('hex') === hash) ||
        (hash.length === 40 && createHash('sha1').update(content).digest('hex') === hash)
      if (!matches) {
        changed++
      }
    } catch {
      changed++ // 文件被删/不可读 → 视为变更
    }
  }
  return [changed, skipped]
}

/** 当前 git HEAD（失败返回 null，不致命；git.exe 无需 shell）。 */
export function gitHead(root: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', 'HEAD'], { cwd: root })
    let out = ''
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      const head = out.trim()
      resolve(code === 0 && /^[0-9a-f]{7,40}$/i.test(head) ? head : null)
    })
  })
}
