/**
 * 角色定义解析（ZCode / Prism 双形态 → RoleDefinition）。
 *
 * - ZCode 源：扁平 `<name>.md`（name = 文件名）
 * - Prism 原生：目录式 `<role-id>/AGENTS.md`（name = 目录名）
 * - 正文节：`## 核心契约` 与 `## 核心第一原则` 都认（导入容错，design-v3 §7）
 * - 导入缺省：补 `skills: []`、`knowledge.layers: ['global','project']`（role-definition §5）
 */

import {
  FrontmatterError,
  splitFrontmatter,
  stripPrismMarkerTail,
  type FrontmatterData,
  type FrontmatterValue,
} from '../frontmatter.js'
import type { KnowledgeBinding, RoleColor, RoleDefinition } from '../types.js'

/** 角色文件解析失败。 */
export class RoleParseError extends Error {
  readonly code: 'no_frontmatter' | 'parse_unsupported' | 'parse_failed'
  readonly path?: string

  constructor(code: RoleParseError['code'], message: string, path?: string) {
    super(`${code}: ${message}${path ? ` (${path})` : ''}`)
    this.name = 'RoleParseError'
    this.code = code
    this.path = path
  }
}

export interface ParseRoleOptions {
  /** 来源文件路径（记录到 sourcePath）。 */
  sourcePath?: string
}

/** 解析角色 Markdown（frontmatter + 正文节提取）。解析失败抛 RoleParseError。 */
export function parseRoleMarkdown(raw: string, opts: ParseRoleOptions = {}): RoleDefinition {
  let data: FrontmatterData | null
  let body: string
  try {
    ;({ data, body } = splitFrontmatter(raw))
  } catch (err) {
    throw toRoleParseError(err, opts.sourcePath ?? '')
  }
  if (data === null) {
    throw new RoleParseError('no_frontmatter', '缺少 frontmatter（--- 头）', opts.sourcePath)
  }
  const cleanBody = stripPrismMarkerTail(body)
  const name = str(data.name) ?? ''
  const description = str(data.description) ?? ''
  // skills：frontmatter 优先；ZCode 产物（Prism 渲染）从正文「能力（Skill 白名单）」节回收
  const fmSkills = strArray(data.skills)
  const skills = fmSkills.length > 0 ? fmSkills : extractOverlaySkills(cleanBody)
  // knowledge：frontmatter 显式给出时优先；否则从正文「知识绑定」节回收；再缺省 → 导入默认
  const fmKnowledge = typeof data.knowledge === 'object' && data.knowledge !== null ? parseKnowledge(data.knowledge) : undefined
  const knowledge = fmKnowledge ?? extractOverlayKnowledge(cleanBody) ?? parseKnowledge(undefined)
  const role: RoleDefinition = {
    name,
    description,
    skills,
    knowledge,
    principle: extractPrinciple(cleanBody),
    body: cleanBody,
  }
  const color = str(data.color)
  if (color !== undefined) role.color = color as RoleColor
  const model = str(data.model)
  if (model !== undefined) role.model = model
  const thoughtLevel = str(data.thoughtLevel)
  if (thoughtLevel !== undefined) role.thoughtLevel = thoughtLevel as RoleDefinition['thoughtLevel']
  if (typeof data.injectAgentsMd === 'boolean') role.injectAgentsMd = data.injectAgentsMd
  if (opts.sourcePath !== undefined) role.sourcePath = opts.sourcePath
  return role
}

/** catch 包装：把 FrontmatterError 归一为 RoleParseError。 */
export function toRoleParseError(err: unknown, path: string): RoleParseError {
  if (err instanceof FrontmatterError) {
    return new RoleParseError(err.code === 'parse_unsupported' ? 'parse_unsupported' : 'parse_failed', err.message, path)
  }
  if (err instanceof RoleParseError) return err
  return new RoleParseError('parse_failed', err instanceof Error ? err.message : String(err), path)
}

/**
 * 提取核心第一原则正文：`## 核心第一原则` 优先，兼容既有 `## 核心契约`。
 * 找不到返回 ''（由 validateRole 报 principle_missing）。
 */
export function extractPrinciple(body: string): string {
  return extractSection(body, ['## 核心第一原则', '## 核心契约'])
}

/** 提取指定标题（任一别名）小节的正文（到下一个 `## ` 或文末）。 */
export function extractSection(body: string, headings: string[]): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  let start = -1
  for (const heading of headings) {
    const idx = lines.findIndex((l) => l.trim() === heading)
    if (idx !== -1) {
      start = idx + 1
      break
    }
  }
  if (start === -1) return ''
  const end = lines.findIndex((l, i) => i >= start && /^##\s/.test(l.trim()))
  const section = (end === -1 ? lines.slice(start) : lines.slice(start, end)).join('\n').trim()
  return section
}

/** 尾部 Prism marker（渲染产物标识）不属于正文：解析时剥掉（stripPrismMarkerTail，见 frontmatter.ts）。 */

/** 从正文「能力（Skill 白名单）」节回收技能白名单（`- skill` 行；无节返回 []）。 */
export function extractOverlaySkills(body: string): string[] {
  const section = extractSection(body, ['## 能力（Skill 白名单）'])
  if (section === '') return []
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(1).trim())
    .filter((s) => s !== '')
}

/** 从正文「知识绑定」节回收知识绑定（`- layers: a, b` / `- books: x`；无节/无层返回 undefined）。 */
export function extractOverlayKnowledge(body: string): KnowledgeBinding | undefined {
  const section = extractSection(body, ['## 知识绑定'])
  if (section === '') return undefined
  const layers: KnowledgeBinding['layers'] = []
  const books: string[] = []
  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    const layersMatch = /^-\s*layers:\s*(.+)$/.exec(trimmed)
    if (layersMatch) {
      for (const part of layersMatch[1].split(',')) {
        const layer = part.trim()
        if ((['global', 'project', 'role'] as const).includes(layer as 'global' | 'project' | 'role')) {
          layers.push(layer as 'global' | 'project' | 'role')
        }
      }
      continue
    }
    const booksMatch = /^-\s*books:\s*(.+)$/.exec(trimmed)
    if (booksMatch) {
      for (const part of booksMatch[1].split(',')) {
        const book = part.trim()
        if (book !== '') books.push(book)
      }
    }
  }
  return layers.length > 0 ? (books.length > 0 ? { layers, books } : { layers }) : undefined
}

function parseKnowledge(value: FrontmatterValue | undefined): KnowledgeBinding {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    // 缺省：role-definition §5 导入规则（默认 global + project 两层）
    return { layers: ['global', 'project'] }
  }
  const record = value as { [key: string]: FrontmatterValue }
  const layers = strArray(record.layers).filter((l): l is KnowledgeBinding['layers'][number] =>
    (['global', 'project', 'role'] as const).includes(l as 'global' | 'project' | 'role'),
  )
  const books = strArray(record.books)
  return books.length > 0 ? { layers, books } : { layers }
}

function str(value: FrontmatterValue): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strArray(value: FrontmatterValue): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}
