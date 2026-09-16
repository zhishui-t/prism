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
 *   遍历目录 → 过滤扩展名（`DOC_ONLY_EXTENSIONS` ∪ `include_ext`）/ 文件名级跳过表 /
 *   硬编码忽略目录 / `.gitignore` 忽略 → 逐个转 Markdown（非 anydoc 扩展直读纯文本）→
 *   算源哈希 → kb.index()（created/updated/unchanged）。
 *
 * 扫描范围（design-v8 §4）：
 * - **默认只扫文档**：`DOC_ONLY_EXTENSIONS` = anydoc 支持集 − {html, htm}——
 *   html/h5 默认不扫（用户点名「h5 默认不扫」的落点）；源码/构建脚本/配置默认跳过，
 *   由 `includeExt` 显式纳入。
 * - **跳过要给账**：每个没纳入的文件按原因计入 `ScanReport.by_skip_reason`，
 *   使 `--dry-run` 能分列「纳入 / 跳过」。
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'

import { SUPPORTED_EXTENSIONS, extensionOf, isSupported, type KnowledgeService } from '@prism/knowledge'

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

/**
 * **默认不扫**的 anydoc 支持扩展（design-v8 §4）：html/h5 与文档格式同属 anydoc
 * 支持集，但不该默认进知识库。
 */
export const WEB_EXTENSIONS = ['.html', '.htm'] as const

/**
 * 默认扫描的扩展集 = **anydoc 支持集 − {html, htm}**（design-v8 §4）。
 *
 * 从 `SUPPORTED_EXTENSIONS` **派生**而非另抄一份字面量：anydoc 支持集变动时默认集跟着动，
 * 不会两边漂移。旧 Office/ODF 家族（doc/ppt/xls 系列）在内，不误伤。
 * 想收额外扩展（如 h/cpp）用 `includeExt` 显式纳入。
 */
export const DOC_ONLY_EXTENSIONS: readonly string[] = (SUPPORTED_EXTENSIONS as readonly string[]).filter(
  (ext) => !(WEB_EXTENSIONS as readonly string[]).includes(ext),
)

/**
 * 文件名级跳过表之一：**精确文件名**（design-v8 §4）。
 *
 * 为什么光有扩展门不够：`extensionOf('CMakeLists.txt')` = `.txt`（在默认集里），
 * `Makefile` 连扩展名都没有——扩展门挡不住用户点名的这些构建杂项。
 */
export const BUILD_FILE_NAMES = [
  // 构建脚本（无扩展名 / `.txt`）
  'CMakeLists.txt',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Rakefile',
  'Gemfile',
  'Dockerfile',
  // 包管理 / 工程配置
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'pnpm-workspace.yaml',
  'lerna.json',
  'turbo.json',
  'rush.json',
  'nx.json',
] as const

/** 文件名级跳过表之二：**带后缀的构建文件**（`*.mk` / `*.cmake`）。 */
export const BUILD_FILE_SUFFIXES = ['.mk', '.cmake'] as const

/**
 * 文件名级跳过表之三：**打包器/编译器/测试运行器配置**——`<base>.<任意后缀>` 一律算配置
 * （`webpack.config.js` / `vite.config.ts` / `tsconfig.node.json` / `jest.config.mjs` …）。
 * 这些文件通常连扩展名都不在默认集里，但用户 `--include-ext js,ts,json` 时会重新落进来。
 */
export const BUILD_CONFIG_BASENAMES = [
  'webpack.config',
  'vite.config',
  'rollup.config',
  'esbuild.config',
  'babel.config',
  'jest.config',
  'vitest.config',
  'eslint.config',
  'tsconfig',
  'jsconfig',
] as const

/** 文件名级跳过表之四：**点文件形态的配置**（`.eslintrc*` / `.prettierrc*` / `.babelrc*`）。 */
export const BUILD_CONFIG_DOT_PREFIXES = ['.eslintrc', '.prettierrc', '.babelrc'] as const

/**
 * 上四张表的**小写化查表副本**（模块加载时派生一次，不每次调用重算）。
 *
 * 为什么需要：判定是**大小写不敏感**的（见 {@link isBuildFileName}），而
 * `BUILD_FILE_NAMES` 里有带大写的规范写法（`CMakeLists.txt` / `GNUmakefile`）——
 * 表保留规范拼写当**文档**，查表用小写副本。
 */
const BUILD_FILE_NAME_SET: ReadonlySet<string> = new Set(
  (BUILD_FILE_NAMES as readonly string[]).map((n) => n.toLowerCase()),
)

/**
 * 该文件名是否属于「构建文件 / 配置」跳过表（命中 → 默认跳过，reason=`build_file`）。
 *
 * 判定只看**文件名**（不看路径）：构建杂项散落在任意层级，同名同义。
 *
 * **大小写不敏感**（MIN-6，2026-09-16）：匹配前统一 `toLowerCase()`。否则
 * `CMakeLists.TXT` 会在 Windows/macOS 这类大小写不敏感的文件系统上滑过文件名表
 * （`extensionOf` 归一出 `.txt`，恰好在默认集里）→ 正是用户点名要挡的 cmake 类。
 */
export function isBuildFileName(name: string): boolean {
  const lower = name.toLowerCase()
  if (BUILD_FILE_NAME_SET.has(lower)) return true
  if ((BUILD_FILE_SUFFIXES as readonly string[]).some((suffix) => lower.endsWith(suffix))) return true
  if (
    (BUILD_CONFIG_BASENAMES as readonly string[]).some(
      (base) => lower === base || lower.startsWith(`${base}.`),
    )
  ) {
    return true
  }
  return (BUILD_CONFIG_DOT_PREFIXES as readonly string[]).some((prefix) => lower.startsWith(prefix))
}

/** `by_skip_reason` 的稳定原因键（人读文案见各调用点的 `ScannedFile.reason`）。 */
export const SKIP_REASONS = {
  /** 扩展名不在「默认集 ∪ include_ext」里（html/htm、源码、图片、数据文件等） */
  extNotIncluded: 'ext_not_included',
  /** 命中文件名级跳过表（CMakeLists.txt / Makefile / *.cmake / 构建配置…） */
  buildFile: 'build_file',
  /** 超过单文件大小上限 */
  tooLarge: 'too_large',
  /** 读取失败（权限/占用等） */
  readFailed: 'read_failed',
  /** 纯文本直读时 utf-8 解码失败（include_ext 纳入的二进制文件等） */
  decodeFailed: 'decode_failed',
  /** anydoc 转换失败 */
  convertFailed: 'convert_failed',
  /** 图片型扫描 PDF（anydoc 的能力边界，不是 bug） */
  needsOcr: 'needs_ocr',
  /** 索引写入失败 */
  indexFailed: 'index_failed',
} as const

/**
 * **门挡**类原因（候选**之外**就被挡下）：只有这两类不计入 `discovered`。
 *
 * 其余 {@link SKIP_REASONS} 都是**候选内处理失败**——同时计入 `discovered` 与 `skipped`。
 * 人读输出据此把「未纳入」（本表两类）与「处理失败」（其余）分成两行，避免双计
 * （MAJ-2，2026-09-16；恒等式见 `ScanReport.by_skip_reason`）。
 */
export const GATE_SKIP_REASONS: readonly string[] = [
  SKIP_REASONS.extNotIncluded,
  SKIP_REASONS.buildFile,
]

/**
 * `include_ext` 入参归一化：**trim + 小写 + 去前导点**（`' H '` / `'.c'` / `'CPP'`
 * → `.h` / `.c` / `.cpp`），去重保序。
 *
 * 归一化后的形态与 `extensionOf()` 的输出同形（小写、含点），后续判定一律走
 * `extensionOf`，两边不会因为写法差异对不上。
 */
export function normalizeExtensions(list: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of list) {
    const name = raw.trim().toLowerCase().replace(/^\.+/, '')
    if (name === '') continue
    const ext = `.${name}`
    if (!out.includes(ext)) out.push(ext)
  }
  return out
}

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
   * **显式纳入**的扩展名（design-v8 §4；CLI `--include-ext` / MCP `include_ext`）。
   *
   * 入参不挑写法（`['H', '.c', ' cpp ']` 都认），内部经 {@link normalizeExtensions}
   * 归一化后**追加**到默认集 {@link DOC_ONLY_EXTENSIONS} 上（默认集始终生效）。
   * 纳入的非 anydoc 支持扩展走**纯文本直读**（见 `scanProject`）。
   */
  includeExt?: string[]
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
  /**
   * **过门候选**的文件数（`= created + updated + unchanged + skipped`）。
   *
   * 注意含**候选内处理失败**的（`skipped`），不含被扩展门/文件名表挡掉的
   * （那些只在 `by_skip_reason` 里，见该字段的恒等式）。
   */
  discovered: number
  /** 新建索引数 */
  created: number
  /** 更新（源变了）数 */
  updated: number
  /** 未变跳过数 */
  unchanged: number
  /** 候选内处理失败的数（= Σ`by_skip_reason` 里非门挡的那几类） */
  skipped: number
  /**
   * 本次**没纳入**的文件按原因分列计数（design-v8 §4；键见 {@link SKIP_REASONS}）。
   *
   * 覆盖两类：
   * - **候选之外被门挡掉的**——扩展不在默认集/`include_ext`（`ext_not_included`，含 html/htm）
   *   或命中文件名级跳过表（`build_file`）；
   * - **候选之内处理失败的**——`too_large`/`read_failed`/`decode_failed`/`convert_failed`/
   *   `needs_ocr`/`index_failed`（这些**同时**计入 `skipped`，见下）。
   *
   * **对账恒等式**（MINOR 订正，2026-09-16）：
   * ```
   * (created + updated + unchanged) + Σ by_skip_reason = 审视全量
   * ```
   * 等价地 `discovered = (created + updated + unchanged) + Σ候选内失败`（= `skipped`）。
   * ⚠ 别拿 `discovered` 去加**全量** `by_skip_reason`——候选内失败会被算两遍
   * （旧注释就是这么写的，实测 4 文件项目打出「发现 2 + 未纳入 3」）。
   *
   * 「审视全量」= 本次**逐个子项判定过**的项目文件；**不含**——
   * 被 `.gitignore` 剪枝的（另计 `ignored_dirs`/`ignored_files`）、
   * `DEFAULT_IGNORE_DIRS`/`ignoreDirs` 挡掉的目录、非普通文件（软链等，`walk` 直接跳过）、
   * 以及 `maxFiles` 截断后没走到的文件。所以它 ≤ 项目里的文件总数。
   *
   * 这是 `--dry-run` 下「纳入 / 处理失败 / 未纳入」三行对账的物（CLI 人读输出同口径）。
   */
  by_skip_reason: Record<string, number>
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
    by_skip_reason: {},
    files: [],
    truncated: false,
    missing: [],
    unreadable: [],
    ignored_dirs: [],
    ignored_files: 0,
  }

  /** 计一笔「没纳入」（各跳过分支的唯一落点，保证不留静默跳过）。 */
  const bumpSkip = (reason: string): void => {
    report.by_skip_reason[reason] = (report.by_skip_reason[reason] ?? 0) + 1
  }

  /** 生效的扩展集 = 默认文档集 + `include_ext` 显式纳入（归一化后）。 */
  const includeExts = new Set<string>([
    ...DOC_ONLY_EXTENSIONS,
    ...normalizeExtensions(options.includeExt ?? []),
  ])

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
        // ① 文件名级跳过表：**先于扩展门**——`CMakeLists.txt` 的扩展名是 `.txt`（默认集里），
        //    `Makefile` 连扩展名都没有，扩展门拦不住这些构建杂项
        if (isBuildFileName(entry.name)) {
          bumpSkip(SKIP_REASONS.buildFile)
          continue
        }
        // ② 扩展门：默认集（html/htm 已退出）+ `include_ext` 显式纳入
        if (!includeExts.has(extensionOf(entry.name))) {
          bumpSkip(SKIP_REASONS.extNotIncluded)
          continue
        }
        // ③ 先过扩展名：只有「本来会被扫」的文件才算「被 .gitignore 挡掉」，
        // 否则 `.log` 这类本就不在扫描范围的文件会虚增忽略计数
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
        bumpSkip(SKIP_REASONS.tooLarge)
        report.files.push({ rel, abs, source_hash: '', status: 'skipped', reason: `文件过大（${info.size} 字节）`, bytes: info.size })
        continue
      }
      bytes = await readFile(abs)
    } catch (error) {
      report.skipped++
      bumpSkip(SKIP_REASONS.readFailed)
      report.files.push({ rel, abs, source_hash: '', status: 'skipped', reason: `读取失败: ${String(error)}`, bytes: 0 })
      continue
    }

    const sourceHash = createHash('sha256').update(bytes).digest('hex')
    /**
     * 正文来源分两支（design-v8 §4）：
     * - **anydoc 支持集内**（默认集内的文件都在内）→ 既有 `toMarkdown` 管线；
     * - **`include_ext` 纳入的集外扩展**（h/cpp 等）→ **纯文本直读**。
     *   不能落到 `toMarkdown`：它对这类扩展报 `unsupported` → 一律 skipped，
     *   参数就形同虚设。
     */
    let markdown: string
    if (isSupported(abs)) {
      const { toMarkdown } = await import('@prism/knowledge')
      const converted = await toMarkdown(bytes, abs)
      if (converted.status !== 'text' && converted.status !== 'converted') {
        report.skipped++
        bumpSkip(converted.status === 'needs_ocr' ? SKIP_REASONS.needsOcr : SKIP_REASONS.convertFailed)
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
      markdown = converted.markdown
    } else {
      let decoded: string | undefined
      try {
        // fatal: true——坏字节抛错而不是静默替换成 U+FFFD（纳入的二进制文件要能看见）
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        decoded = undefined
      }
      /**
       * MIN-5（2026-09-16）：**无 BOM 的 UTF-16** 每个字符后面跟一个 `0x00`，全部字节
       * < 0x80，对 `fatal: true` 而言是**合法** utf-8 序列——不抛错，正文里只剩 NUL 串。
       * 落库就是二进制垃圾且计不到 `decode_failed`。故解码成功后补一道 NUL 判据。
       * （GBK / 带 BOM 的 UTF-16 会在上面直接抛错，路径不变。）
       */
      const hasNul = decoded !== undefined && decoded.includes('\u0000')
      if (decoded === undefined || hasNul) {
        report.skipped++
        bumpSkip(SKIP_REASONS.decodeFailed)
        report.files.push({
          rel,
          abs,
          source_hash: sourceHash,
          status: 'skipped',
          reason: hasNul
            ? '解码后含 NUL 字节（无 BOM 的 UTF-16 等二进制；include_ext 纳入的）'
            : 'utf-8 解码失败（include_ext 纳入的可能是二进制文件）',
          bytes: info.size,
        })
        continue
      }
      markdown = decoded
    }

    const title = extractTitle(markdown, basename(rel, extname(rel)))
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
        content: markdown,
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
      bumpSkip(SKIP_REASONS.indexFailed)
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
