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
 * **OCR（v14 B-4 / SPEC-3.1–3.4）**：图片（png/jpg/jpeg/webp）与**图片型扫描 PDF**
 * 的正文来源是 OCR（`3rd/ocr`，零 LLM、离线）。就绪判据是 `ocrAvailable()`
 * （模型三件在 + pip 依赖可导入，结果缓存）：
 * - 就绪 → 转出 Markdown（`## 第 N 页` 分节）走正常入库链；
 * - **未就绪**（含 runner 调用失败）→ 与从前**逐字节一致**：图片仍旧报
 *   `unsupported`（`不支持的扩展名: .png`）、扫描 PDF 仍旧报 `needs_ocr`
 *   （anydoc 的原话）——老机器行为零变化（SPEC-3.2）。
 *
 * **内嵌图片（v17 B-A4）**：`toMarkdownBytes` 支持格式（**PDF 除外**——anydoc 对 PDF
 * 无 `toDocument`）里的内嵌图片，经 `toDocument` 取 `assets[].data` → 临时文件 →
 * 同一 OCR 管道 → OCR 文本以 `> [图片 N] …` 引用块**插回原 alt 位置**。OCR 未就绪 /
 * 单图失败 → **原样保留**（整篇转换不失败）；非白名单 mediaType 跳过。
 * ⚠ 实测：anydoc 的 Markdown 渲染器对**内嵌 asset 图**不写 `![alt](…)`，而是把 alt
 *   当**纯文本**内联（`src/render/markdown/inline.rs` 的 `ImageSource::Asset` 分支，
 *   alt 为空则什么都不输出）——故锚点只能是「alt 独占整行」。
 *
 * 正文以外的两处配套在 server 侧（`packages/server/src/kb/scan.ts`）：图片并入扫描
 * 范围的条件派生集（S2）、OCR 正文的少文本守卫（S3）、转换前哈希短路（M3）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { repoRoot, tmpTag } from '@prism/core'

/** anydoc 运行时目录（setup-anydoc.mjs 的安装目标）。发行根向上查找，兼容打包布局。 */
export function anydocRuntimeDir(): string {
  const root = repoRoot(import.meta.url, 8) ?? fileURLToPath(new URL('../../../', import.meta.url))
  return join(root, '3rd', 'anydoc-runtime')
}

/** anydoc 模块最小接口（toMarkdownBytes + 可选 toDocument，后者用于内嵌图片）。 */
interface AnydocModule {
  toMarkdownBytes: (bytes: Uint8Array, format: string) => Promise<string>
  /** 结构化文档模型（v17 B-A4：assets + 内嵌图 inline）。PDF 不支持（d.ts:120-125）。 */
  toDocument?: (bytes: Uint8Array, format?: string | null) => Promise<AnydocDocument>
}

/** anydoc 文档模型的最小结构（只消费 blocks 里的 image inline 与 assets）。 */
interface AnydocInline {
  kind?: string
  alt?: string
  source?: { kind?: string; assetId?: number }
  content?: AnydocInline[]
}
interface AnydocBlock {
  content?: AnydocInline[]
  blocks?: AnydocBlock[]
}
interface AnydocAsset {
  id: number
  mediaType: string
  data?: Uint8Array
}
interface AnydocDocument {
  blocks: AnydocBlock[]
  assets: AnydocAsset[]
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
  /**
   * **OCR 就绪但 runner 调用失败**的原因（D-v14-tester-1）。
   *
   * `reason` 是**回落文案**（SPEC-3.2 逐字契约：图片仍是 `不支持的扩展名: …`、扫描 PDF
   * 仍是 anydoc 原话），两者用途不同——没有这个字段时，「装了 OCR 但 runner 坏了」与
   * 「根本没装 OCR」在报告里**同貌**，用户看不到 `setup-ocr` / 模型缺失这类线索。
   *
   * 只在「就绪但失败」时出现：未就绪（含 `PRISM_OCR=off`）路径**不带**此字段，
   * 老机器行为零变化。
   */
  ocr_failure?: string
  /** 转换耗时（毫秒，仅 converted 有意义） */
  elapsed_ms?: number
  /**
   * **正文来自 OCR**（v14 B-4）。
   *
   * 调用方据此施加 OCR 专属策略（server 侧 scan 的少文本守卫，SPEC-3.4）——
   * 普通 anydoc 转换与纯文本直读**都不设**此位（不能拿 OCR 的阈值去卡正常文档）。
   */
  ocr?: true
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

// ---------------------------------------------------------------------------
// OCR（v14 B-4 / SPEC-3.1–3.4）：图片 / 图片型扫描 PDF 的正文来源
// ---------------------------------------------------------------------------

/**
 * 走 OCR 的图片扩展名（**单一真相源**）。
 *
 * server 侧 scan 的「OCR 就绪条件派生白名单」（SPEC-3.3 / S2）也从这里取——两个包
 * 各留一份必然漂移。刻意只开四类最常见格式：`3rd/ocr` 本体还能识 bmp/tif/gif，
 * 但**不进默认扫描集**。
 */
export const OCR_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const

/** OCR 工具目录（`3rd/ocr`）。发行根向上查找，兼容打包布局（同 {@link anydocRuntimeDir}）。 */
export function ocrToolDir(): string {
  const root = repoRoot(import.meta.url, 8) ?? fileURLToPath(new URL('../../../', import.meta.url))
  return join(root, '3rd', 'ocr')
}

/** ONNX 模型目录（`3rd/ocr/models`，`scripts/setup-ocr.mjs` 的下载目标）。 */
export function ocrModelsDir(): string {
  return join(ocrToolDir(), 'models')
}

/** 模型件数（det/rec/cls 三件；见 {@link ocrModelsReady} 的口径说明）。 */
export const OCR_MODEL_COUNT = 3

/**
 * 模型是否就绪：`modelsDir` 下**至少三个 `.onnx`**（`ocr_main.py` 的 `MODEL_FILES`
 * 是 det/rec/cls 三件、平铺在该目录里，由 `scripts/setup-ocr.mjs` 下载）。
 *
 * 刻意**不比对文件名与 SHA256**——那是 `setup-ocr.mjs --check` 的职责，两处各留一份表
 * 必然漂移（上游换模型版本时，写死名字会让这里**静默**判「未装」）。这里只要
 * 「三件到位」这个量级判据：断点续传中途（只有 `.part`）或没下过 → 不足三件。
 * 宁可放过（跑起来失败会回落旧文案），也不误判成「没装」。
 */
export function ocrModelsReady(modelsDir: string = ocrModelsDir()): boolean {
  return ocrModelCount(modelsDir) >= OCR_MODEL_COUNT
}

/**
 * 模型件数（`modelsDir` 下平铺的 `.onnx` 个数）；目录缺失/不可读 → 0。
 *
 * 判据与 {@link ocrModelsReady} **同一个筛子**（后者即本函数的 `>= OCR_MODEL_COUNT`）——
 * 这个计数只用于**给人看的诊断**（`prism doctor` 的 ocr 行报 `模型 2/3 件`，能看出
 * 「下到一半」），判断就绪仍走 `ocrModelsReady()`，不在这里另立一套口径。
 */
export function ocrModelCount(modelsDir: string = ocrModelsDir()): number {
  try {
    return readdirSync(modelsDir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.onnx'),
    ).length
  } catch {
    return 0 // 目录缺失/不可读 → 算 0 件
  }
}

/**
 * 可选两件模型的文件名（v17 B-A1：表格结构 + 版面分析）。
 *
 * **镜像** `scripts/setup-ocr.mjs` 的 MODELS 表与 `3rd/ocr/ocr_main.py` 的
 * `TABLE_MODEL_FILE` / `LAYOUT_MODEL_FILE`（跨语言无法共享常量，改动**三处同步**）。
 * 这两件是**可选**的：缺任一件只让 table/layout 增强回到旧输出，不动 OCR 主路
 * （故不并入 {@link ocrModelsReady} 的「至少三件」判据——见该函数说明）。
 */
export const OCR_TABLE_MODEL_FILE = 'slanet-plus.onnx'
export const OCR_LAYOUT_MODEL_FILE = 'pp_doc_layoutv3.onnx'

/** 表格模型文件是否在位（**不**校验 SHA256/可导入——那是 setup-ocr --check 与 Python 的活）。 */
export function ocrTableModelReady(modelsDir: string = ocrModelsDir()): boolean {
  return existsSync(join(modelsDir, OCR_TABLE_MODEL_FILE))
}

/** 版面模型文件是否在位（口径同 {@link ocrTableModelReady}）。 */
export function ocrLayoutModelReady(modelsDir: string = ocrModelsDir()): boolean {
  return existsSync(join(modelsDir, OCR_LAYOUT_MODEL_FILE))
}

/** 依赖探测超时（只看 `import` 能不能过，不该慢）。 */
const OCR_DEPS_TIMEOUT_MS = 20_000

/**
 * 单文件 OCR 超时护栏：整本 PDF 要逐页 300dpi 栅格化 + 推理，给足预算；
 * 但不能不设——`spawnSync` 无限等会把整次扫描挂死。
 */
export const OCR_RUN_TIMEOUT_MS = 300_000

/** OCR 调用结果：成功给 Markdown，失败给可读原因（回落文案由调用方决定）。 */
export type OcrRunResult = { ok: true; markdown: string } | { ok: false; reason: string }

/**
 * OCR 调用选项。
 *
 * - `fake`：mock 推理层（测试用，不暴露成产品开关）；
 * - `table` / `layout`（v17 B-A1）：表格还原 / 版面分析的开关。`undefined` = **不透传
 *   flag**，由 `ocr_main.py` 决定（缺省两者都开）；显式 `false` → `--no-table` /
 *   `--no-layout`（等价「回到无 table/layout 的旧输出」）。两件模型未装时 Python 侧
 *   静默跳过，故透传 `true` 也不会炸。
 */
export interface OcrRunOptions {
  fake?: boolean
  table?: boolean
  layout?: boolean
}

/** OCR runner 签名（`input` = 源文件**路径**：工具自己读盘，不经内存）。 */
export type OcrRunner = (input: string, options?: OcrRunOptions) => Promise<OcrRunResult>

/**
 * 构造薄壳 `ocr_tool.mjs` 的 argv（**纯函数**，便于断言 flag 透传，不必真 spawn）。
 *
 * `table`/`layout` 只在**显式给出**时透传：`true` → `--table`/`--layout`，
 * `false` → `--no-table`/`--no-layout`，`undefined` → 不带（Python 缺省开）。
 */
export function buildOcrToolArgs(input: string, options: OcrRunOptions = {}): string[] {
  const args = [join(ocrToolDir(), 'ocr_tool.mjs'), input]
  if (options.fake === true) args.push('--fake')
  if (options.table === true) args.push('--table')
  if (options.table === false) args.push('--no-table')
  if (options.layout === true) args.push('--layout')
  if (options.layout === false) args.push('--no-layout')
  return args
}

/**
 * 默认 runner：spawn Node 薄壳 `3rd/ocr/ocr_tool.mjs`（薄壳再 spawn Python）。
 *
 * 走**薄壳**而不是直接 spawn Python——解释器解析 / 模型目录 / 退出码口径都收在薄壳里
 * （M6 镜像三件套之一），本包只认「Markdown / 失败原因」。`fake` 供无模型环境跑通
 * 结构（测试用，不暴露成产品开关）。
 */
export async function runOcrTool(input: string, options: OcrRunOptions = {}): Promise<OcrRunResult> {
  const tool = join(ocrToolDir(), 'ocr_tool.mjs')
  if (!existsSync(tool)) {
    return { ok: false, reason: `OCR 工具缺失（${tool}）——跑 node scripts/setup-ocr.mjs` }
  }
  const args = buildOcrToolArgs(input, options)
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf-8',
    timeout: OCR_RUN_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, reason: `无法启动 OCR 工具：${result.error.message}` }
  }
  if (result.status !== 0) {
    const first = (result.stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '')
    return { ok: false, reason: first ?? `OCR 工具退出码 ${String(result.status)}` }
  }
  const markdown = result.stdout ?? ''
  if (markdown.trim() === '') return { ok: false, reason: 'OCR 未返回任何文本' }
  return { ok: true, markdown }
}

/** OCR 主路 pip 依赖模块（与 `scripts/setup-ocr.mjs` 的 CORE_DEPS 同口径）。 */
const OCR_CORE_DEPS = ['rapidocr', 'onnxruntime', 'pypdfium2'] as const
/** OCR 可选 pip 依赖模块（v17 B-A1：表格结构 + 版面分析）。 */
const OCR_EXTRA_DEPS = ['rapid_table', 'rapid_layout'] as const

/**
 * 指定 pip 模块是否可导入（解释器**借用薄壳导出的 `resolvePython`**）。
 *
 * 不在这里再写一份平台判断——R6/AGENTS「平台差异只在唯一判定位」的红线：
 * 多一处平台分支就是多一处漏抽象。
 */
async function pythonModulesReady(modules: readonly string[]): Promise<boolean> {
  try {
    const tool = join(ocrToolDir(), 'ocr_tool.mjs')
    if (!existsSync(tool)) return false
    const mod = (await import(pathToFileURL(tool).href)) as {
      resolvePython?: (env?: NodeJS.ProcessEnv) => string
    }
    if (typeof mod.resolvePython !== 'function') return false
    const probe = spawnSync(mod.resolvePython(), ['-c', `import ${modules.join(', ')}`], {
      encoding: 'utf-8',
      timeout: OCR_DEPS_TIMEOUT_MS,
      windowsHide: true,
    })
    return probe.status === 0
  } catch {
    return false
  }
}

/**
 * pip 依赖是否可导入（口径同 `scripts/setup-ocr.mjs --check` 的 pip 那一行）。
 */
export async function ocrDepsReady(): Promise<boolean> {
  return pythonModulesReady(OCR_CORE_DEPS)
}

/**
 * **可选** pip 依赖（`rapid_table` / `rapid_layout`）是否可导入（v17 B-A1）。
 *
 * 与 {@link ocrDepsReady} 分开：可选件缺失只让 table/layout 增强不可用，
 * **不影响** OCR 主路就绪判据（`prism doctor` 分列报告）。
 */
export async function ocrExtrasDepsReady(): Promise<boolean> {
  return pythonModulesReady(OCR_EXTRA_DEPS)
}

/**
 * 少文本守卫阈值（SPEC-3.4 / S3）：有效字符 < 此值 → 不入库。**单值，不分语种**。
 * （判定落在 server 侧 scan：`no_text_detected` 是扫描的跳过原因。）
 */
export const MIN_OCR_VALID_CHARS = 50

/**
 * 有效字符计数（SPEC-3.4 的谓词）：CJK 计 1 + `[A-Za-z0-9]` 计 1，空白/标点计 0。
 *
 * CJK 取宽口径（常用汉字 + 扩展 A + 兼容表意 + 假名 + 谚文）——OCR 文本可能混日韩，
 * 而判据只看「有多少字」，不区分语种。
 */
export function countValidChars(text: string): number {
  let count = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x30 && code <= 0x39) || // 0-9
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x3040 && code <= 0x30ff) || // 平假名 / 片假名
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
      (code >= 0xac00 && code <= 0xd7af) // 谚文
    ) {
      count++
    }
  }
  return count
}

/** 本管道自加的页头行形态（`ocr_main.py::render_markdown`：`## 第 N 页`）。 */
const OCR_PAGE_HEADER = /^## 第 \d+ 页$/

/** 本管道自加的空白页占位符（`render_markdown` 在 `blocks === 0` 时写入）。 */
const OCR_EMPTY_PAGE_PLACEHOLDER = '（未检出文本）'

/**
 * 剥掉 OCR 管道**自加**的段落标记（波次 3 / A.1）：页头行 + 空白页占位符。
 *
 * `ocr_main.py::render_markdown` 为每页拼一个 `## 第 N 页` 小节头，无文本块的页写占位符
 * `（未检出文本）`。这两样都对不上「有效字符」的语义：小节头里的 `第`/`页`/页码是
 * **版式噪声**，占位符是**我们自己的**措辞——都不是识别出来的正文。不剥的话，全空白
 * PDF 会靠「页数 × 每页约 8 个字」把计数堆过 50 阈值（10 页即 ~80），少文本守卫
 * （SPEC-3.4）形同虚设。
 *
 * 剥法**按整行精确匹配**：只认 `^## 第 <数字> 页$` 这种整行形态（行允许前后空白），
 * 不碰其它任何行。**取舍**：正文里用户自写的同名标题会被一并剥掉——但本函数的唯一
 * 消费方是 OCR 守卫（`converted.ocr === true`，正文全是机器生成的），非 OCR 文档不走
 * 这里，故可接受；将来若扩大使用面需重新评估（见报告）。
 */
export function stripOcrArtifacts(markdown: string): string {
  const kept: string[] = []
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (OCR_PAGE_HEADER.test(line) || line === OCR_EMPTY_PAGE_PLACEHOLDER) continue
    kept.push(raw)
  }
  return kept.join('\n')
}

/**
 * OCR 全局降级开关：`PRISM_OCR=off` 强制按「未装 OCR」走（与 `PRISM_EMBEDDING=off` /
 * `PRISM_RERANK=off` 同形）。
 *
 * 存在的理由与它们一致：**确定性测试**。e2e 的 `kb sync` 要断精确 `discovered` 数，
 * 而 e2e 是把 CLI 当**子进程**跑的（够不到进程内的 `setOcrHooks`），只能走 env——装没装
 * OCR 模型的机器上结论必须一致。
 */
export function parseOcrOff(input: string | undefined): boolean {
  const v = input?.trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false'
}

/**
 * OCR 注入点（**测试专用**；真机走 `runOcrTool` + `ocrAvailable` 探测）。
 *
 * 注入是**唯一**的测试缝：scan 的条件派生白名单与这里的图片/扫描 PDF 路由都读
 * `ocrAvailable()`，一处注入两边一致，不会出现「白名单开了但路由没开」的半开状态。
 */
export interface OcrHooks {
  available: () => boolean
  run: OcrRunner
}

let ocrHooks: OcrHooks | null = null
let ocrAvailableCache: boolean | undefined

/** 注入 / 还原 OCR 钩子（`null` 还原默认并丢弃探测缓存）。 */
export function setOcrHooks(hooks: OcrHooks | null): void {
  ocrHooks = hooks
  ocrAvailableCache = undefined
}

/**
 * OCR 是否可用（**结果缓存**）：模型三件在 + pip 依赖可导入。
 *
 * 缓存的是「本进程当时」的结论——装完模型要重启进程才生效（与 embedding 档位同口径）。
 * 探测失败一律 `false`（回落旧文案，不是错误，也不抛）。
 */
export async function ocrAvailable(): Promise<boolean> {
  if (ocrHooks !== null) return ocrHooks.available()
  if (parseOcrOff(process.env['PRISM_OCR'])) return false
  if (ocrAvailableCache === undefined) {
    ocrAvailableCache = ocrModelsReady() && (await ocrDepsReady())
  }
  return ocrAvailableCache
}

/** 调 runner（注入优先；runner 抛错也算失败——注入方失约不该炸掉整次扫描）。 */
async function runOcr(input: string, options: OcrRunOptions): Promise<OcrRunResult> {
  const run = ocrHooks !== null ? ocrHooks.run : runOcrTool
  try {
    return await run(input, options)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 试跑 OCR 的三种归宿：成功 / **未就绪**（`{ ok:false }` 无 failure，不是错误）/
 * **就绪但 runner 失败**（`failure` 带可读原因，供调用方另挂 `ConvertResult.ocr_failure`）。
 *
 * 调用方各自回落自己的旧文案（SPEC-3.2），本函数**不改**任何文案。
 */
type OcrAttempt =
  | { ok: true; markdown: string; elapsedMs: number }
  | { ok: false; failure?: string }

async function tryOcr(path: string, options: OcrRunOptions): Promise<OcrAttempt> {
  if (!(await ocrAvailable())) return { ok: false }
  const started = Date.now()
  const result = await runOcr(path, options)
  if (!result.ok) return { ok: false, failure: result.reason }
  return { ok: true, markdown: result.markdown, elapsedMs: Date.now() - started }
}

// ---------------------------------------------------------------------------
// 内嵌图片（v17 B-A4）：anydoc toDocument → assets → OCR → `> [图片 N]` 引用块
// ---------------------------------------------------------------------------

/**
 * 内嵌图片可 OCR 的 mediaType 白名单 → 临时文件扩展名（v17 B-A4）。
 *
 * 与 {@link OCR_IMAGE_EXTENSIONS}（扫描范围白名单）**同口径**：png / jpeg / webp。
 * `image/jpeg` 落 `.jpg`（OCR 工具按扩展名分流，`.jpeg` 也认，统一更省事）。
 * 其余 mediaType（bmp/gif/svg/octet-stream…）**跳过**——不猜、不动原 alt 行。
 */
export const EMBEDDED_IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** 一张可处理的内嵌图片（白名单 mediaType + 有字节 + alt 非空）。 */
interface EmbeddedImageRef {
  /** 锚点：anydoc 把它当纯文本内联，Prism 按「alt 独占整行」定位。 */
  alt: string
  mediaType: string
  data: Uint8Array
  /** 文档内第几张图（1 起，**含被跳过的图**）——「图片 N」的编号口径。 */
  ordinal: number
}

/** 按文档序收集 blocks 里的 image inline（含嵌套 content / 子 blocks）。 */
function collectImageInlines(blocks: AnydocBlock[], out: AnydocInline[] = []): AnydocInline[] {
  const walk = (inlines: AnydocInline[] | undefined): void => {
    for (const inline of inlines ?? []) {
      if (inline.kind === 'image') out.push(inline)
      if (Array.isArray(inline.content)) walk(inline.content)
    }
  }
  for (const block of blocks) {
    walk(block.content)
    if (Array.isArray(block.blocks)) collectImageInlines(block.blocks, out)
  }
  return out
}

/**
 * 取文档里可处理的内嵌图片（文档序）。`toDocument` 不可用/解析失败 → 空数组
 * （主路已经是 `toMarkdownBytes` 的 Markdown，内嵌图拿不到不该让整篇失败）。
 */
async function collectEmbeddedImages(
  anydoc: AnydocModule,
  bytes: Uint8Array,
  format: string,
): Promise<EmbeddedImageRef[]> {
  if (typeof anydoc.toDocument !== 'function') return []
  let document: AnydocDocument
  try {
    document = await anydoc.toDocument(bytes, format)
  } catch {
    return []
  }
  const assets = new Map<number, AnydocAsset>()
  for (const asset of document.assets ?? []) assets.set(asset.id, asset)

  const refs: EmbeddedImageRef[] = []
  collectImageInlines(document.blocks ?? []).forEach((inline, index) => {
    const ordinal = index + 1
    if (inline.source?.kind !== 'asset') return
    const assetId = inline.source.assetId
    if (assetId === undefined) return
    const asset = assets.get(assetId)
    if (asset?.data === undefined) return
    if (EMBEDDED_IMAGE_MEDIA_TYPES[asset.mediaType] === undefined) return // 白名单外 → 跳过
    const alt = (inline.alt ?? '').trim()
    if (alt === '') return // 无锚点（anydoc 也不输出任何东西）→ 跳过
    refs.push({ alt, mediaType: asset.mediaType, data: asset.data, ordinal })
  })
  return refs
}

/** 找 alt **独占的整行**（未消费过的第一处）；找不到返回 -1。 */
function findAltLine(lines: readonly string[], consumed: ReadonlySet<number>, alt: string): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (consumed.has(index)) continue
    if (lines[index].trim() === alt) return index
  }
  return -1
}

/** 把 OCR 文本包成 `> [图片 N] …` 引用块（首行带标记，其余行续引）。 */
function referenceBlock(ordinal: number, text: string): string[] {
  return text.split('\n').map((line, index) => {
    const body = line.trim()
    if (index === 0) return body === '' ? `> [图片 ${ordinal}]` : `> [图片 ${ordinal}] ${body}`
    return body === '' ? '>' : `> ${body}`
  })
}

/**
 * 内嵌图片 → OCR → 引用块插回原 alt 位置（v17 B-A4）。
 *
 * 归一路径（任一不成立即**原样返回** `markdown`）：
 *  - PDF（anydoc 无 `toDocument`，运行时按 format 守卫——不依赖它报错）；
 *  - OCR 未就绪（`ocrAvailable()` 为假）→ 与 v14 的逐字节回落契约零冲突；
 *  - 没有可处理的内嵌图（无资产 / 白名单外 / alt 为空）。
 *
 * 单图失败（runner 报错 / 无有效文本）→ 该图**保留原 alt 行**，其余照做；整篇不失败。
 * 临时文件落 `os.tmpdir()` 的独立 `mkdtemp` 目录，`finally` 必删（R5）。
 *
 * 说明：图片 OCR 文本**进 FTS 与段向量**（它就是正文，随 Markdown 一起入库）；
 * 但**不**给 `ConvertResult` 打 `ocr: true`——那一位的含义是「正文整体来自 OCR」，
 * 会触发 server 侧 OCR 专属的少文本守卫（SPEC-3.4），而这里的正文主体仍来自 anydoc。
 */
async function embedImageText(
  anydoc: AnydocModule,
  bytes: Uint8Array,
  format: string,
  markdown: string,
  runOptions: OcrRunOptions,
): Promise<string> {
  if (format === 'pdf') return markdown
  if (typeof anydoc.toDocument !== 'function') return markdown
  if (!(await ocrAvailable())) return markdown
  const refs = await collectEmbeddedImages(anydoc, bytes, format)
  if (refs.length === 0) return markdown

  const lines = markdown.split('\n')
  const consumed = new Set<number>()
  const replacements = new Map<number, string[]>()
  const dir = await mkdtemp(join(tmpdir(), `prism-ocr-asset-${tmpTag()}-`))
  try {
    for (const ref of refs) {
      const index = findAltLine(lines, consumed, ref.alt)
      if (index < 0) continue // 不是独占整行（行内小图）→ 不替换，免得吞掉同行的正文
      const extension = EMBEDDED_IMAGE_MEDIA_TYPES[ref.mediaType]
      const file = join(dir, `image-${ref.ordinal}.${extension}`)
      await writeFile(file, ref.data)
      const result = await runOcr(file, runOptions)
      if (!result.ok) continue // 单图失败 → 保留原 alt 行
      const text = stripOcrArtifacts(result.markdown).trim()
      if (text === '') continue // 无有效文本（空白图/占位符）→ 保留原 alt 行
      consumed.add(index)
      replacements.set(index, referenceBlock(ref.ordinal, text))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  if (replacements.size === 0) return markdown

  const out: string[] = []
  lines.forEach((line, index) => {
    const replacement = replacements.get(index)
    if (replacement === undefined) out.push(line)
    else out.push(...replacement)
  })
  return out.join('\n')
}

/**
 * `toMarkdown` 的可选参数。
 *
 * `ocr` 是 v17 B-A1 的**表格 / 版面增强开关**：缺省两者都**开启**（与 `prism.yaml`
 * 的 `ocr_table`/`ocr_layout` 缺省一致），模型未装时 Python 侧静默跳过（回到旧输出）。
 * 扫描链路（`packages/server/src/kb/scan.ts`）按配置显式传入 `false` 即可逐字节回到
 * 「无 table/layout 的旧输出」（SPEC-A1.2/A2.3）。
 */
export interface ToMarkdownOptions {
  ocr?: { table?: boolean; layout?: boolean }
}

/** 把 `ToMarkdownOptions.ocr` 归一成 runner 选项（缺省都开）。 */
function ocrRunOptions(options: ToMarkdownOptions): OcrRunOptions {
  return {
    table: options.ocr?.table ?? true,
    layout: options.ocr?.layout ?? true,
  }
}

/**
 * 把任意支持格式转成 Markdown。
 *
 * @param bytes 文件内容
 * @param path 文件路径（推断扩展名 + **交给 OCR 工具读盘**）
 * @param options OCR 增强开关（v17 B-A1；缺省两者都开，见 {@link ToMarkdownOptions}）
 */
export async function toMarkdown(
  bytes: Uint8Array,
  path: string,
  options: ToMarkdownOptions = {},
): Promise<ConvertResult> {
  const ext = extensionOf(path)
  const runOptions = ocrRunOptions(options)

  // ① 纯文本类：直接解码，不经过 anydoc
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { status: 'text', markdown: new TextDecoder('utf-8').decode(bytes), extension: ext }
  }

  // ② 图片：OCR 就绪则识别，否则与从前一样报 unsupported（SPEC-3.3 / 3.2）
  if ((OCR_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    const ocr = await tryOcr(path, runOptions)
    if (!ocr.ok) {
      // 文案逐字不变（SPEC-3.2）；runner 失败的原因**另挂**在 ocr_failure 上（D-v14-tester-1）
      const fallen: ConvertResult = {
        status: 'unsupported',
        markdown: '',
        extension: ext,
        reason: `不支持的扩展名: ${ext || '(无)'}`,
      }
      if (ocr.failure !== undefined) fallen.ocr_failure = ocr.failure
      return fallen
    }
    return { status: 'converted', markdown: ocr.markdown, extension: ext, elapsed_ms: ocr.elapsedMs, ocr: true }
  }

  // ③ 二进制类：anydoc 转换
  if (!(CONVERTIBLE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { status: 'unsupported', markdown: '', extension: ext, reason: `不支持的扩展名: ${ext || '(无)'}` }
  }

  const started = Date.now()
  try {
    const anydoc = await loadAnydoc()
    const format = ext.slice(1) // '.docx' → 'docx'
    const markdown = await anydoc.toMarkdownBytes(bytes, format)
    // v17 B-A4：内嵌图片 OCR 后插回（PDF / OCR 未就绪 / 无可处理图 → 原样返回）
    const withImages = await embedImageText(anydoc, bytes, format, markdown, runOptions)
    return { status: 'converted', markdown: withImages, extension: ext, elapsed_ms: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // anydoc 对图片型 PDF 抛 needsOcr（设计边界，不是错误）
    if (/needsOcr|needs ocr|OCR/i.test(message)) {
      // OCR 就绪 → 改走 OCR；不可用 / 调用失败 → **原样**回落 anydoc 的原话（SPEC-3.2）
      const ocr = await tryOcr(path, runOptions)
      if (!ocr.ok) {
        const fallen: ConvertResult = { status: 'needs_ocr', markdown: '', extension: ext, reason: message }
        if (ocr.failure !== undefined) fallen.ocr_failure = ocr.failure
        return fallen
      }
      return { status: 'converted', markdown: ocr.markdown, extension: ext, elapsed_ms: ocr.elapsedMs, ocr: true }
    }
    return { status: 'failed', markdown: '', extension: ext, reason: message }
  }
}
