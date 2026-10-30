/**
 * 知识导入的**实现单点**（MCP `prism_kb_import` 与 HTTP `POST /api/kb/import` 共用）。
 *
 * 口径与 CLI `prism kb sync` 同源（都走 `scanProject`）：项目文件为真相，Prism 只存
 * 索引 + 转换后的检索副本（R7）；`dry_run` 用 `makeDryRunKb` 包一层只报告不落库。
 * OCR 表格/版面开关按 `prism.yaml`（v17 M-2），与 MCP 侧同一 wiring。
 */

import type { KnowledgeService } from './port.js'
import { makeDryRunKb, scanProject } from './scan.js'
import { resolveOcrWiringConfigForHome } from './wiring.js'

/** 导入参数（HTTP/MCP 同形；path+owner 必填，其余可选）。 */
export interface KbImportParams {
  /** 项目根目录绝对路径（调用方从项目注册表取，不猜）。 */
  path: string
  /** 项目名（project 层 owner）。 */
  owner: string
  book?: string
  module?: string
  dry_run?: boolean
  respect_gitignore?: boolean
  include_ext?: string[]
}

/** 导入结果摘要（对齐 MCP `prism_kb_import` 响应形状——两边不另造第二套）。 */
export interface KbImportSummary {
  root: string
  discovered: number
  created: number
  updated: number
  unchanged: number
  skipped: number
  by_skip_reason: Record<string, number>
  truncated: boolean
  missing: string[]
  ignored_dirs: string[]
  ignored_files: number
  dry_run: boolean
}

export async function runKbImport(
  getKb: () => Promise<KnowledgeService>,
  home: string,
  params: KbImportParams,
): Promise<KbImportSummary> {
  const service = await getKb()
  const target = params.dry_run === true ? makeDryRunKb(service) : service
  const ocrEnabled = resolveOcrWiringConfigForHome(home)
  const report = await scanProject(target, {
    root: params.path,
    layer: 'project',
    owner: params.owner,
    ...(params.book !== undefined && params.book !== '' ? { book: params.book } : {}),
    ...(params.module !== undefined && params.module !== '' ? { module: params.module } : {}),
    ...(typeof params.respect_gitignore === 'boolean' ? { respectGitignore: params.respect_gitignore } : {}),
    ...(params.include_ext !== undefined && params.include_ext.length > 0 ? { includeExt: params.include_ext } : {}),
    ocr: ocrEnabled.ocr,
  })
  return {
    root: report.root,
    discovered: report.discovered,
    created: report.created,
    updated: report.updated,
    unchanged: report.unchanged,
    skipped: report.skipped,
    by_skip_reason: report.by_skip_reason,
    truncated: report.truncated,
    missing: report.missing,
    ignored_dirs: report.ignored_dirs,
    ignored_files: report.ignored_files,
    dry_run: params.dry_run === true,
  }
}
