/**
 * 文件存储（design.md §3.3 存储模型）。
 *
 * 版次文件布局（文件为真相，DB path 列指向版次文件）：
 *
 *   <knowledgeDir>/<layer>[/<owner>]/<book>/<module|_inbox>/<id>/v<NN>.md   # 该版次正文
 *   <knowledgeDir>/<layer>[/<owner>]/<book>/<module|_inbox>/<id>/<id>.md    # 最新版副本
 *
 * 规则：
 * - project/role 层必须有 owner 段；global 层不设 owner 段；
 * - module 省略 → 落 `<book>/_inbox/`，DB module=''；
 * - `<id>.md` 每次 deposit 后重写为最新版正文。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { splitFrontmatter } from './frontmatter.js'
import type { Layer } from './types.js'

/** 文件层面的条目地址。module 为 '' 时落到 _inbox/。 */
export interface EntryAddress {
  layer: Layer
  owner?: string
  book: string
  module: string
}

/** 未归类暂存区目录名（保留名，禁止作为 book/module/id 显式传入）。 */
export const INBOX_DIR = '_inbox'

/**
 * 段名合法性校验（design.md §3.5：非法段名抛 bad_request）。
 * 禁止：空串、路径分隔符、控制字符、`.`/`..`、尾随点/空格（Windows）、
 * Windows 保留设备名、`%`/`_` 之外的 LIKE 通配符天然不存在（`*`/`?` 允许但不推荐）。
 */
export function isValidSegment(name: string): boolean {
  if (!name || name !== name.trim()) return false
  if (name === '.' || name === '..') return false
  if (/[/\\]/.test(name)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return false
  if (/[.]$/.test(name) || /\s$/.test(name)) return false
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return false
  return true
}

/** 条目目录：`<knowledgeDir>/<layer>[/<owner>]/<book>/<module|_inbox>/<id>`。 */
export function entryDirPath(knowledgeDir: string, address: EntryAddress, id: string): string {
  const parts = [knowledgeDir, address.layer]
  if (address.layer !== 'global') parts.push(address.owner ?? '')
  parts.push(address.book, address.module === '' ? INBOX_DIR : address.module, id)
  return join(...parts)
}

/** 版次文件：`v<NN>.md`（NN 两位零填充，≥100 自然进位）。 */
export function versionFilePath(dir: string, version: number): string {
  return join(dir, `v${String(version).padStart(2, '0')}.md`)
}

/** 最新版副本：`<id>.md`。 */
export function latestFilePath(dir: string, id: string): string {
  return join(dir, `${id}.md`)
}

/**
 * 从 DB path 列推导 owner（表结构无 owner 列，owner 是路径段，由 path 反解）。
 * 无法解析时返回 undefined。
 */
export function ownerFromPath(knowledgeDir: string, entryPath: string): string | undefined {
  const rel = relative(knowledgeDir, entryPath)
  if (!rel || rel.startsWith('..')) return undefined
  const segments = rel.split(sep)
  if (segments.length < 2) return undefined
  const layer = segments[0] as Layer
  if (layer === 'global') return undefined
  if (layer !== 'project' && layer !== 'role') return undefined
  return segments[1] || undefined
}

/** 同步写版次文件与最新版副本（在持久化事务临界区内调用）。 */
export function writeEntryFiles(
  knowledgeDir: string,
  address: EntryAddress,
  id: string,
  version: number,
  markdown: string,
): { dir: string; versionFile: string; latestFile: string } {
  const dir = entryDirPath(knowledgeDir, address, id)
  mkdirSync(dir, { recursive: true })
  const versionFile = versionFilePath(dir, version)
  const latestFile = latestFilePath(dir, id)
  writeFileSync(versionFile, markdown, 'utf-8')
  writeFileSync(latestFile, markdown, 'utf-8')
  return { dir, versionFile, latestFile }
}

/** 读正文文件；不存在返回 null（文件为真相，DB 仅索引）。 */
export function readContentFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 读取条目正文（剥离 frontmatter 后的 body）。
 * 版次文件 = frontmatter + 正文；无 frontmatter 的手改文件按原文返回。
 */
export function readEntryContent(filePath: string): string | null {
  const fileText = readContentFile(filePath)
  if (fileText === null) return null
  const { data, body } = splitFrontmatter(fileText)
  return data === null ? fileText : body
}
