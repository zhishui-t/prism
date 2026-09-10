/**
 * 文档转换便捷封装（MCP `prism_kb_convert` / CLI 用）。
 *
 * 读文件字节 → `@prism/knowledge` 的 `toMarkdown`（文本直读 / 二进制走 anydoc）。
 * 只读文件、不落库——转换结果交给宿主提炼后自行 deposit（Prism 不做语义抽取）。
 */
import { readFile } from 'node:fs/promises'

import { PrismError } from '@prism/core'
import { toMarkdown, type ConvertResult } from '@prism/knowledge'

export interface ConvertFileOptions {
  /** 返回正文上限（默认 20 万字符）；超出截断并标 truncated */
  maxChars?: number
}

export interface ConvertFileResult extends ConvertResult {
  /** 原文件路径 */
  path: string
  /** 是否因上限被截断 */
  truncated?: boolean
}

const DEFAULT_MAX_CHARS = 200_000

/** 读文件并转 Markdown。文件不存在/不可读 → PrismError('not_found')。 */
export async function convertFileToMarkdown(
  path: string,
  options: ConvertFileOptions = {},
): Promise<ConvertFileResult> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new PrismError('not_found', `读不到文件: ${path}`, {
      path,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  const result = await toMarkdown(bytes, path)
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  if (result.markdown.length > maxChars) {
    return { ...result, path, markdown: result.markdown.slice(0, maxChars), truncated: true }
  }
  return { ...result, path }
}
