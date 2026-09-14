/**
 * 项目知识扫描器（A3，design-knowledge-model-v1 §4）。
 *
 * 职责边界（红线）：
 * - **只读项目文件**——不写项目目录、**不碰 `.git/`**、不跑 git 命令、不判断提交；
 * - **零 LLM**——格式转换是机械的（anydoc），语义抽取交给工作队列；
 * - **引用型只索引**——项目文件是真相，Prism 不复制、不做版次。
 *
 * 关于 `.gitignore`（2026-09-14，当晚扩到多级子目录）：扫描**逐层读目录里的
 * `.gitignore`**（根 + 各级子目录），把其中忽略的目录/文件一并跳过。这不违反上面
 * 「不读 git」——该红线约束的是**不介入版本控制**（不执行 git 命令、不读 `.git/`、
 * 不问分支与提交）；`.gitignore` 只是一个普通的文本清单，描述「哪些路径不算项目内容」，
 * 属于**扫描范围**问题。可用 `respectGitignore: false` 关掉。
 *
 * 扫描流程：
 *   遍历目录 → 过滤扩展名 / 硬编码忽略目录 / `.gitignore` 忽略 → 逐个转 Markdown →
 *   算源哈希 → kb.index()（created/updated/unchanged）→ 可选入队富化任务。
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'

import { isSupported, type KnowledgeService } from '@prism/knowledge'

import { createGitignoreMatcher, type GitignoreMatcher } from './gitignore.js'

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
  /**
   * 是否读 `.gitignore`（**根 + 各级子目录，逐层叠加**）并跳过其中忽略的路径（默认 `true`）。
   * 置 `false` 时只按 `DEFAULT_IGNORE_DIRS` + `ignoreDirs` 过滤。
   */
  respectGitignore?: boolean
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
  /** 源文件已消失、索引仍在的条目（生产级：不静默留孤儿索引） */
  missing: string[]
  /** 不可读的目录（权限/占用等），显式报告不静默 */
  unreadable: string[]
  /** 被 `.gitignore`（任意一层）忽略的目录（相对路径；**不递归展开**，拦下就不再往下走） */
  ignored_dirs: string[]
  /** 被 `.gitignore`（任意一层）忽略的文件数（只计数——目录已挡在前面，通常量很小） */
  ignored_files: number
}

/** 检测「索引里存在但源文件已不在」的引用型条目（按 book/owner 限定范围）。 */
async function findMissingSources(
  kb: KnowledgeService,
  options: { book: string; owner?: string; seenIds: Set<string> },
): Promise<string[]> {
  const missing: string[] = []
  const catalog = await kb.catalog({
    book: options.book,
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    limit: 5000,
  })
  const { access } = await import('node:fs/promises')
  for (const entry of catalog) {
    if (entry.origin !== 'indexed') continue
    if (options.seenIds.has(entry.id)) continue // 本次扫描见过 → 没丢
    if (entry.path === undefined || entry.path === '') continue
    try {
      await access(entry.path)
    } catch {
      missing.push(entry.id)
    }
  }
  return missing
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
 * dry-run 包装：`index()` 只查不写——已存在且源哈希相同 → unchanged；
 * 否则报告 created/updated 但不落库。转换仍真实执行（验证 anydoc 能否处理）。
 */
export function makeDryRunKb(real: KnowledgeService): KnowledgeService {
  // 用 Object.create 保留原型方法（class 实例的方法不在自有属性上，展开会丢）
  const wrapper = Object.create(real) as KnowledgeService
  wrapper.index = async (input) => {
    const existing = await real.get(input.id)
    if (existing !== null) {
      const prev = existing.source_hash
      return {
        id: input.id,
        action: prev === input.source_hash ? ('unchanged' as const) : ('updated' as const),
      }
    }
    return { id: input.id, action: 'created' as const }
  }
  return wrapper
}

/**
 * 读某个目录的 `.gitignore`（不存在/不可读/无规则 → `null`）。
 *
 * **逐层调用**：根目录与每一级子目录各读一次，叠加成完整的忽略语义。
 * 每层规则只作用于**该目录的后代**，且**不作用于该目录自身**——与 git 一致
 * （否则 `sub/.gitignore` 里一条 `sub/` 就能把自己整个抹掉，自相矛盾）。
 */
async function loadGitignore(dir: string): Promise<GitignoreMatcher | null> {
  try {
    const text = await readFile(join(dir, '.gitignore'), 'utf-8')
    const matcher = createGitignoreMatcher(text)
    return matcher.size > 0 ? matcher : null
  } catch {
    return null
  }
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
  // project/role 层必须有 owner；未指定时回落 book（与 CLI 的 owner 口径一致）
  const effectiveOwner = options.owner ?? (layer === 'global' ? undefined : book)

  const report: ScanReport = {
    root,
    discovered: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    files: [],
    truncated: false,
    missing: [],
    unreadable: [],
    ignored_dirs: [],
    ignored_files: 0,
  }

  const candidates: string[] = []
  const unreadable: string[] = []
  const respectGitignore = options.respectGitignore !== false
  /**
   * 已加载的 `.gitignore` 层，**从根往下**（`base` = 该层所在目录相对 root 的 POSIX 路径）。
   *
   * 判定时从浅到深依次问，**只有深层「命中」才覆盖浅层的结论**——深层本层没有相关
   * 规则（`match` 返回 `undefined`）时必须保持浅层的判定，否则子目录里一条不相干的
   * 规则会把父级的忽略悄悄取消掉。
   */
  const layers: Array<{ base: string; matcher: GitignoreMatcher }> = []

  /** 多层叠加判定；`rel` 是相对 root 的 POSIX 路径。 */
  const isIgnored = (rel: string, isDir: boolean): boolean => {
    let ignored = false
    for (const layer of layers) {
      let sub: string
      if (layer.base === '') {
        sub = rel
      } else if (rel.startsWith(`${layer.base}/`)) {
        // 只作用于本目录的**后代**：`sub/.gitignore` 管不到 `sub` 自己
        sub = rel.slice(layer.base.length + 1)
      } else {
        continue
      }
      const verdict = layer.matcher.match(sub, isDir)
      if (verdict !== undefined) ignored = verdict
    }
    return ignored
  }

  const walk = async (dir: string, base: string): Promise<void> => {
    // 本目录的 `.gitignore` 先入栈再遍历：它管的是**本目录的内容**，不含本目录自身
    let pushed = false
    if (respectGitignore) {
      const matcher = await loadGitignore(dir)
      if (matcher !== null) {
        layers.push({ base, matcher })
        pushed = true
      }
    }
    try {
      if (candidates.length >= maxFiles) {
        report.truncated = true
        return
      }
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        // 不可读目录显式记录（QA 遗留 4：静默跳过会让用户以为扫全了）
        unreadable.push(`${dir}（${error instanceof Error ? error.message : String(error)}）`)
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
          const rel = relative(root, abs).split(sep).join('/')
          if (isIgnored(rel, true)) {
            report.ignored_dirs.push(rel)
            continue
          }
          await walk(abs, rel)
          continue
        }
        if (!entry.isFile()) continue
        // 先过扩展名：只有「本来会被扫」的文件才算「被 .gitignore 挡掉」，
        // 否则 `.log` 这类本就不支持的扩展名会虚增忽略计数
        if (!isSupported(entry.name)) continue
        if (respectGitignore) {
          const rel = relative(root, abs).split(sep).join('/')
          if (isIgnored(rel, false)) {
            report.ignored_files++
            continue
          }
        }
        candidates.push(abs)
      }
    } finally {
      if (pushed) layers.pop()
    }
  }
  await walk(root, '')
  report.discovered = candidates.length
  report.unreadable = unreadable

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
        ...(effectiveOwner !== undefined ? { owner: effectiveOwner } : {}),
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

  // 源文件已消失、索引仍在的条目（生产级：明确报告，不静默留孤儿）
  const seenIds = new Set(report.files.filter((f) => f.status !== 'skipped').map((f) => idFromRel(f.rel)))
  report.missing = await findMissingSources(kb, {
    book,
    ...(effectiveOwner !== undefined ? { owner: effectiveOwner } : {}),
    seenIds,
  })

  return report
}
