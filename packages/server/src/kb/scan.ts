/**
 * 项目知识扫描器（A3，design-knowledge-model-v1 §4）。
 *
 * 职责边界（红线）：
 * - **只读项目文件**——不写项目目录、不读 git、不判断提交；
 * - **零 LLM**——格式转换是机械的（anydoc），语义抽取交给工作队列；
 * - **引用型只索引**——项目文件是真相，Prism 不复制、不做版次。
 *
 * 扫描流程：
 *   遍历目录 → 过滤扩展名/忽略目录 → 逐个转 Markdown → 算源哈希 →
 *   kb.index()（created/updated/unchanged）→ 可选入队富化任务。
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'

import { isSupported, type KnowledgeService } from '@prism/knowledge'

/** 默认忽略的目录名（构建产物、依赖、版本控制内部等）。 */
export const DEFAULT_IGNORE_DIRS = [
  '.git',
  '.prism',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'graphify-out',
  '.cache',
  '.idea',
  '.vscode',
  'vendor',
] as const

export interface ScanOptions {
  /** 项目根目录（绝对路径） */
  root: string
  /** 知识归属：项目层必填 owner */
  layer?: string
  owner?: string
  /** 书/模块的默认归属（文档相对路径会拼进模块） */
  book?: string
  module?: string
  /** 额外忽略的目录名 */
  ignoreDirs?: string[]
  /** 单文件大小上限（字节），默认 8MB——超大文件跳过（可能是二进制资源） */
  maxFileBytes?: number
  /** 最多扫描文件数（护栏），默认 2000 */
  maxFiles?: number
}

export interface ScannedFile {
  /** 项目内相对路径（POSIX 分隔符） */
  rel: string
  abs: string
  /** 源哈希（原件字节的 sha256） */
  source_hash: string
  /** 转换状态 */
  status: 'indexed' | 'unchanged' | 'skipped'
  /** 索引结果（status=indexed 时） */
  action?: 'created' | 'updated'
  /** 跳过原因 */
  reason?: string
  /** 推断的模块（相对路径的目录部分） */
  module?: string
  bytes: number
}

export interface ScanReport {
  root: string
  /** 发现的可处理文件数 */
  discovered: number
  /** 新建索引数 */
  created: number
  /** 更新（源变了）数 */
  updated: number
  /** 未变跳过数 */
  unchanged: number
  /** 跳过（不支持/过大/转换失败）数 */
  skipped: number
  files: ScannedFile[]
  /** 截断标记（超过 maxFiles） */
  truncated: boolean
  /** 入队的工作任务 id（--enqueue 时） */
  enqueued: string[]
}

/**
 * 把相对路径的目录部分转成模块名。
 * Prism 的 module 是**单段名**（禁止路径分隔符），所以多层目录压平成 `a-b-c`。
 */
export function moduleFromRel(rel: string): string {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  return dir.replace(/[/\\]/g, '-').replace(/[.]/g, '_')
}

/** 从 Markdown 提取标题（首个 `# ` 行），失败回落文件名。 */
export function extractTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) {
      const title = trimmed.slice(2).trim()
      if (title !== '') return title
    }
  }
  return fallback
}

/** 由相对路径生成稳定的条目 id（同文件重复扫描得到同 id）。 */
export function idFromRel(rel: string): string {
  const stem = rel.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '-')
  return `IDX-${stem}`.slice(0, 120)
}

/**
 * 扫描项目目录并建「引用型」索引。
 *
 * @param kb 知识服务（需实现 index）
 * @param options 扫描参数
 */
export async function scanProject(kb: KnowledgeService, options: ScanOptions): Promise<ScanReport> {
  if (kb.index === undefined) {
    throw new Error('知识服务未实现 index()——无法建引用型索引')
  }
  const root = options.root
  const ignore = new Set<string>([...DEFAULT_IGNORE_DIRS, ...(options.ignoreDirs ?? [])])
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
  const maxFiles = options.maxFiles ?? 2000
  const layer = options.layer ?? 'project'
  const book = options.book ?? basename(root)

  const report: ScanReport = {
    root,
    discovered: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    files: [],
    truncated: false,
    enqueued: [],
  }

  const candidates: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (candidates.length >= maxFiles) {
      report.truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (candidates.length >= maxFiles) {
        report.truncated = true
        return
      }
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue
        await walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      if (!isSupported(entry.name)) continue
      candidates.push(abs)
    }
  }
  await walk(root)
  report.discovered = candidates.length

  for (const abs of candidates) {
    const rel = relative(root, abs).split(sep).join('/')
    let bytes: Buffer
    let info
    try {
      info = await stat(abs)
      if (info.size > maxFileBytes) {
        report.skipped++
        report.files.push({ rel, abs, source_hash: '', status: 'skipped', reason: `文件过大（${info.size} 字节）`, bytes: info.size })
        continue
      }
      bytes = await readFile(abs)
    } catch (error) {
      report.skipped++
      report.files.push({ rel, abs, source_hash: '', status: 'skipped', reason: `读取失败: ${String(error)}`, bytes: 0 })
      continue
    }

    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    const { toMarkdown } = await import('@prism/knowledge')
    const converted = await toMarkdown(bytes, abs)
    if (converted.status !== 'text' && converted.status !== 'converted') {
      report.skipped++
      report.files.push({
        rel,
        abs,
        source_hash: sourceHash,
        status: 'skipped',
        reason: converted.reason ?? converted.status,
        bytes: info.size,
      })
      continue
    }

    const title = extractTitle(converted.markdown, basename(rel, extname(rel)))
    const module = options.module !== undefined && options.module !== '' ? options.module : moduleFromRel(rel)
    try {
      const result = await kb.index({
        id: idFromRel(rel),
        title,
        type: 'doc',
        layer: layer as 'global' | 'project' | 'role',
        ...(options.owner !== undefined ? { owner: options.owner } : {}),
        book,
        module,
        path: abs,
        source_hash: sourceHash,
        content: converted.markdown,
      })
      if (result.action === 'created') report.created++
      else if (result.action === 'updated') report.updated++
      else report.unchanged++
      report.files.push({
        rel,
        abs,
        source_hash: sourceHash,
        status: result.action === 'unchanged' ? 'unchanged' : 'indexed',
        action: result.action === 'unchanged' ? undefined : result.action,
        module,
        bytes: info.size,
      })
    } catch (error) {
      report.skipped++
      report.files.push({
        rel,
        abs,
        source_hash: sourceHash,
        status: 'skipped',
        reason: `索引失败: ${error instanceof Error ? error.message : String(error)}`,
        bytes: info.size,
      })
    }
  }

  return report
}
