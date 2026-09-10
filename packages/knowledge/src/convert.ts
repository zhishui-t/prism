/**
 * 文档格式分流与转换（design-knowledge-model-v1 §7）。
 *
 * **两类输入，两种处理**：
 * - Markdown / 纯文本 / HTML：**直接读原文**——anydoc 的 `Format` 枚举里没有它们
 *   （实测 0.2.4 只有 doc/docx/odt/pdf/ppt/pptx/rtf/epub/xlsx/ods/odp/csv 共 12 种）。
 * - 其余二进制格式：经 anydoc 本地转 GFM Markdown（零 LLM、零网络）。
 *
 * **anydoc 是 3rd 三方件**（Rust/napi-rs，无本机 Rust 工具链不可自编译）：源码在
 * submodule `3rd/anydoc`，平台预编译 `.node` 由 `scripts/setup-anydoc.mjs` 下到
 * `3rd/anydoc-runtime/`（包装层 + 原生绑定同目录，napi 加载器零改动）。本文件从
 * 该目录按绝对路径加载，不再依赖 `node_modules` 里的 `@firecrawl/anydoc`。
 *
 * **边界**：图片型扫描 PDF 会抛 `needsOcr`——这是设计边界不是 bug，调用方应
 * 跳过并记录，不能因此让整次扫描失败。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** anydoc 运行时目录（setup-anydoc.mjs 的安装目标）。src 与 dist 同深度 → 上 3 级 = 仓库根。 */
export function anydocRuntimeDir(): string {
  return fileURLToPath(new URL('../../../3rd/anydoc-runtime', import.meta.url))
}

/** anydoc 模块最小接口（只用 toMarkdownBytes）。 */
interface AnydocModule {
  toMarkdownBytes: (bytes: Uint8Array, format: string) => Promise<string>
}

let cached: AnydocModule | null = null
let cachedError: string | null = null

/**
 * 加载 anydoc（从 `3rd/anydoc-runtime/`）。未安装/加载失败 → 抛出可读错误，
 * 调用方降级（md/txt/html 仍可直读）。
 */
export async function loadAnydoc(): Promise<AnydocModule> {
  if (cached !== null) return cached
  if (cachedError !== null) throw new Error(cachedError)
  const entry = join(anydocRuntimeDir(), 'anydoc.js')
  if (!existsSync(entry)) {
    cachedError = `anydoc 未安装（缺 ${entry}）——跑 node scripts/setup-anydoc.mjs`
    throw new Error(cachedError)
  }
  try {
    const mod = (await import(pathToFileURL(entry).href)) as Partial<AnydocModule>
    if (typeof mod.toMarkdownBytes !== 'function') {
      throw new Error('anydoc 已加载但缺少 toMarkdownBytes（版本不匹配）')
    }
    cached = mod as AnydocModule
    return cached
  } catch (error) {
    cachedError = error instanceof Error ? error.message : String(error)
    throw new Error(cachedError)
  }
}

/** 可直接读原文的扩展名（不走 anydoc）。 */
export const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.text', '.html', '.htm'] as const

/** 交给 anydoc 转换的扩展名（与 anydoc Format 枚举一致）。 */
export const CONVERTIBLE_EXTENSIONS = [
  '.doc',
  '.docx',
  '.odt',
  '.pdf',
  '.ppt',
  '.pptx',
  '.rtf',
  '.epub',
  '.xlsx',
  '.ods',
  '.odp',
  '.csv',
] as const

/** 扫描器关心的全部扩展名。 */
export const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, ...CONVERTIBLE_EXTENSIONS] as const

export type ConvertStatus = 'text' | 'converted' | 'unsupported' | 'needs_ocr' | 'failed'

export interface ConvertResult {
  status: ConvertStatus
  /** 提取出的 Markdown 正文（text/converted 时非空） */
  markdown: string
  /** 原始扩展名（小写，含点） */
  extension: string
  /** 失败原因（unsupported/needs_ocr/failed 时给出） */
  reason?: string
  /** 转换耗时（毫秒，仅 converted 有意义） */
  elapsed_ms?: number
}

/** 取小写扩展名（含点）；无扩展名返回 ''。 */
export function extensionOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** 该扩展名是否属于扫描范围。 */
export function isSupported(path: string): boolean {
  const ext = extensionOf(path)
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * 探测文档转换依赖是否可用（`prism doctor` 用）。
 * 返回 null 表示可用，否则返回错误信息（便于直接展示给用户）。
 */
export async function probeConverter(): Promise<string | null> {
  try {
    await loadAnydoc()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * 把任意支持格式转成 Markdown。
 *
 * @param bytes 文件内容
 * @param path 文件路径（用于推断扩展名）
 */
export async function toMarkdown(bytes: Uint8Array, path: string): Promise<ConvertResult> {
  const ext = extensionOf(path)

  // ① 纯文本类：直接解码，不经过 anydoc
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { status: 'text', markdown: new TextDecoder('utf-8').decode(bytes), extension: ext }
  }

  // ② 二进制类：anydoc 转换
  if (!(CONVERTIBLE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { status: 'unsupported', markdown: '', extension: ext, reason: `不支持的扩展名: ${ext || '(无)'}` }
  }

  const started = Date.now()
  try {
    const anydoc = await loadAnydoc()
    const format = ext.slice(1) // '.docx' → 'docx'
    const markdown = await anydoc.toMarkdownBytes(bytes, format)
    return { status: 'converted', markdown, extension: ext, elapsed_ms: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // anydoc 对图片型 PDF 抛 needsOcr（设计边界，不是错误）
    if (/needsOcr|needs ocr|OCR/i.test(message)) {
      return { status: 'needs_ocr', markdown: '', extension: ext, reason: message }
    }
    return { status: 'failed', markdown: '', extension: ext, reason: message }
  }
}
