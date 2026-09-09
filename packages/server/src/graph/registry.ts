import { createHash } from 'node:crypto'
import { rename, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PrismError, SingleWriterQueue } from '@prism/core'

/** 项目注册表条目（design.md §4 GET /api/graph/projects）。 */
export interface ProjectInfo {
  project: string
  root: string
  built_at: string | null
  /**
   * 失效标记：注册项 root 下已无 `graphify-out/graph.json`（产物被清理或尚未建完）。
   * 语义：**保留条目并标 stale:true**（不删除、不隐藏——用户能看到并重新 build），
   * studio/query 等消费方在产物缺失时各自返回 404/graph_not_found。
   */
  stale: boolean
  /** 登记时间（`prism project add` 或首次 build）。 */
  registered_at?: string
  /** 上次知识扫描时间（`prism kb sync`）。 */
  last_scan_at?: string
  /** 上次扫描发现的知识源数量（用于「有没有新东西」的快速判断）。 */
  scanned_sources?: number
}

/** 注册表落盘结构（v1 无扩展字段；读时容忍缺失，写时保留已有值）。 */
interface RegistryEntry {
  root: string
  built_at: string | null
  registered_at?: string
  last_scan_at?: string
  scanned_sources?: number
}

interface RegistryFile {
  version: 1
  projects: Record<string, RegistryEntry>
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
        ...(info.registered_at !== undefined ? { registered_at: info.registered_at } : {}),
        ...(info.last_scan_at !== undefined ? { last_scan_at: info.last_scan_at } : {}),
        ...(info.scanned_sources !== undefined ? { scanned_sources: info.scanned_sources } : {}),
      })
    }
    return projects.sort((a, b) => a.project.localeCompare(b.project))
  }

  /** 取项目；不存在 → not_found。 */
  async get(project: string): Promise<ProjectInfo> {
    const data = await this.#read()
    const info = data.projects[project]
    if (info === undefined) {
      throw new PrismError('not_found', `未注册的项目: ${project}（可经 prism project add 或 prism graph build 登记）`)
    }
    return {
      project,
      root: info.root,
      built_at: info.built_at,
      stale: !(await graphExists(info.root)),
      ...(info.registered_at !== undefined ? { registered_at: info.registered_at } : {}),
      ...(info.last_scan_at !== undefined ? { last_scan_at: info.last_scan_at } : {}),
      ...(info.scanned_sources !== undefined ? { scanned_sources: info.scanned_sources } : {}),
    }
  }

  /**
   * 登记或更新项目（原子写；同项目并发注册为后写胜出）。
   * - 首次登记写 `registered_at`；已存在的条目保留其 registered_at。
   * - `builtAt` 省略（undefined）时**保留已有值**——`project add` 重新登记不该清掉建图记录；
   *   显式传 `null` 才会清空。
   */
  async register(project: string, root: string, builtAt?: string | null): Promise<ProjectInfo> {
    let registeredAt: string | undefined
    let effectiveBuiltAt: string | null = null
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      const prev = data.projects[project]
      registeredAt = prev?.registered_at ?? new Date().toISOString()
      effectiveBuiltAt = builtAt === undefined ? (prev?.built_at ?? null) : builtAt
      data.projects[project] = {
        ...prev,
        root,
        built_at: effectiveBuiltAt,
        registered_at: registeredAt,
      }
      await this.#save(data)
    })
    return {
      project,
      root,
      built_at: effectiveBuiltAt,
      stale: !(await graphExists(root)),
      ...(registeredAt !== undefined ? { registered_at: registeredAt } : {}),
    }
  }

  /** 从注册表移除项目（不删磁盘文件）。返回是否确实移除了。 */
  async remove(project: string): Promise<boolean> {
    let removed = false
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      if (data.projects[project] !== undefined) {
        delete data.projects[project]
        removed = true
        await this.#save(data)
      }
    })
    return removed
  }

  /** 记录一次知识扫描（`prism kb sync`）。 */
  async markScanned(project: string, scannedSources: number): Promise<void> {
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      const info = data.projects[project]
      if (info !== undefined) {
        info.last_scan_at = new Date().toISOString()
        info.scanned_sources = scannedSources
        await this.#save(data)
      }
    })
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
  return await isFile(join(root, 'graphify-out', 'graph.json'))
}

async function isFile(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises')
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

// ===== 陈旧检测（纯文件哈希：Prism 不读 git——提交/更新是宿主的事） =====

export interface GraphStatusDetail {
  project: string
  root: string
  graph_exists: boolean
  built_at: string | null
  changed_files: number
  total_files: number
  stale: boolean
  note?: string
}

/**
 * 陈旧检测（尽力而为）：读 `graphify-out/manifest.json`（Graphify 产物）。
 * 实测结构为「顶层 文件路径 → { mtime, hash }」映射（兼容 files/hashes 包裹形态）。
 * 比对策略：有 mtime 用 mtime；hash 为 64/40 位十六进制时用 SHA-256/SHA-1；
 * 无法识别的哈希算法跳过该文件并在 note 说明。
 * **不读 git**（用户裁决 2026-09-10）：Prism 只判断文件内容是否变化，
 * 提交/更新由宿主完成，宿主做完任务后自行触发重新建图/扫描。
 */
export async function inspectGraphStatus(project: string, root: string, builtAt: string | null): Promise<GraphStatusDetail> {
  const graphPath = join(root, 'graphify-out', 'graph.json')
  const manifestPath = join(root, 'graphify-out', 'manifest.json')
  const graphExistsFlag = await isFile(graphPath)

  const detail: GraphStatusDetail = {
    project,
    root,
    graph_exists: graphExistsFlag,
    built_at: builtAt,
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

  const [changed, skipped] = await countChanged(root, entries)
  detail.total_files = entries.length
  detail.changed_files = changed
  detail.stale = changed > 0
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
        // hash 兼容多命名：npm 版 `hash`；Python 版 `ast_hash`/`semantic_hash`（32 位 MD5）
        hash:
          typeof item.hash === 'string' ? item.hash
          : typeof item.ast_hash === 'string' ? item.ast_hash
          : typeof item.semantic_hash === 'string' ? item.semantic_hash
          : undefined,
        mtime: typeof item.mtime === 'number' ? item.mtime : undefined,
      })
    }
  }
  return entries.length > 0 ? entries : null
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
        // mtime 比对（秒级容忍）。单位归一：Python 版 manifest 记秒、Node stat 为毫秒——
        // 2026 纪元值毫秒在 1.7e12 量级，小于 1e11 视为秒制 ×1000
        const recorded = entry.mtime < 1e11 ? entry.mtime * 1000 : entry.mtime
        if (Math.abs(fileStat.mtimeMs - recorded) > 1000) {
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
        (hash.length === 40 && createHash('sha1').update(content).digest('hex') === hash) ||
        (hash.length === 32 && createHash('md5').update(content).digest('hex') === hash)
      if (!matches) {
        changed++
      }
    } catch {
      changed++ // 文件被删/不可读 → 视为变更
    }
  }
  return [changed, skipped]
}
