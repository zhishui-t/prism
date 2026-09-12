/**
 * 角色写盘（`prism role new | edit | rm` 的唯一实现）。
 *
 * **形态口径（2026-09-12 定）**：
 * - **落盘 = 宿主原生形态**，由激活适配器的 `renderRole` 生成——frontmatter 只含该适配器声明的
 *   白名单字段（zcode 六字段 / workbuddy `name,description`），Prism 扩展（skills 白名单、知识绑定）
 *   一律落正文的 `## 能力（Skill 白名单）` / `## 知识绑定` 两节。原 `role init` 把
 *   `skills` / `knowledge` 塞进 frontmatter，与两个适配器自述都冲突，已废（见 `templates.ts`）。
 * - `edit` 是**外科式补丁**：只动点名的那几处（`patchRoleRaw`），正文与未知 frontmatter 键原样保留；
 *   绝不整文件重渲染——人写的内容不该被命令重排。
 * - `rm` 只删角色文件本体（扁平 `<name>.md` 与兼容形态 `<name>/AGENTS.md` 都认）；是否放行由调用方
 *   的写守卫决定（默认宿主目录需 `--yes`）。
 *
 * **历史**：本文件原为「装配」实现（design-v3 §5 冲突策略：渲染后写入宿主目录，含 marker 冲突策略、
 * `.prism-new` 对比、旧源目录迁移）。「角色直接住宿主目录」确立后该路径不再成立——
 * `installRoles` / `installTeamDefinitions` / `migrateTeams` 已随 `team install` / `role import` /
 * `role install` 三个命令一并移除（2026-09-11）。
 *
 * 安全：目标目录由参数传入，**绝不硬编码宿主根**；测试必须用临时目录。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { renderMarkdownFile, splitFrontmatter, type FrontmatterData } from '../frontmatter.js'
import { ROLE_BODY_SKELETON, ROLE_TEMPLATE_NAME_PLACEHOLDER } from '../templates.js'
import type { KnowledgeBinding, RoleColor, RoleDefinition, RoleWriteResult } from '../types.js'
import { extractPrinciple } from './parse.js'
import { OVERLAY_KNOWLEDGE_HEADING, OVERLAY_SKILLS_HEADING, renderZcodeRole, roleMarker } from './render.js'

/** 角色写盘失败（名字非法 / 目录不可写 / 目标不存在等）。 */
export class RoleWriteError extends Error {
  readonly code: 'role_name_invalid' | 'role_write_failed' | 'role_not_found'
  readonly path?: string

  constructor(code: RoleWriteError['code'], message: string, path?: string) {
    super(`${code}: ${message}${path ? ` (${path})` : ''}`)
    this.name = 'RoleWriteError'
    this.code = code
    this.path = path
  }
}

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 占位描述（只给 name 时用；给了 `--description` 就不该再出现 TODO）。 */
export const ROLE_DESCRIPTION_PLACEHOLDER = 'TODO：一句话说清职责 + 适用于 + 不适用于（派遣决策依据）。'

/** 宿主原生形态的渲染器（CLI/server 传激活适配器的 `renderRole`）。 */
export type RoleRenderer = (role: RoleDefinition) => string

export interface NewRoleInput {
  /** 新角色名（必须 kebab-case；即文件名）。 */
  name: string
  /** 角色受管目录（`resolveDirs().rolesDir`；新模型下即宿主 agents 目录）。 */
  rolesDir: string
  description?: string
  skills?: string[]
  knowledge?: KnowledgeBinding
  color?: RoleColor
  model?: string
  thoughtLevel?: string
  /** 正文（`--from` 复用既有角色正文）；缺省用内置骨架。 */
  body?: string
  /** 渲染成宿主原生形态；缺省 `renderZcodeRole`。 */
  renderRole?: RoleRenderer
  /** 已存在时覆盖（缺省跳过，绝不覆盖人写文件）。 */
  force?: boolean
}

export interface RolePatch {
  description?: string
  skills?: string[]
  knowledge?: KnowledgeBinding
  /** `null` = 删除该 frontmatter 键（PATCH 的「清除」语义）。 */
  color?: string | null
  model?: string | null
  thoughtLevel?: string | null
  /** 整段替换正文（尾部 marker 若原本存在则保留）。 */
  body?: string
}

export interface EditRoleInput {
  name: string
  rolesDir: string
  patch: RolePatch
}

export interface RemoveRoleInput {
  name: string
  rolesDir: string
}

/**
 * `role new`：按宿主原生形态写一个角色文件到 `rolesDir`。
 * 只给 `name` → 正文为骨架、描述为占位 TODO（可 `prism role validate` 看到待填项）；
 * 给了 `description` / `skills` / `knowledge` / `body` → 写出的就是填好的定义。
 */
export async function newRole(input: NewRoleInput): Promise<RoleWriteResult> {
  const name = input.name.trim()
  if (!KEBAB_CASE_RE.test(name)) {
    throw new RoleWriteError('role_name_invalid', `角色名必须是 kebab-case：${input.name}（用于文件名 ${name}.md）`)
  }
  const path = join(input.rolesDir, `${name}.md`)
  if (existsSync(path) && input.force !== true) {
    return { written: [], skipped: [{ path, reason: '角色文件已存在（--force 覆盖）' }] }
  }
  ensureDir(input.rolesDir)

  const body = (input.body ?? ROLE_BODY_SKELETON).replaceAll(ROLE_TEMPLATE_NAME_PLACEHOLDER, name).trimEnd()
  const role: RoleDefinition = {
    name,
    description: input.description ?? ROLE_DESCRIPTION_PLACEHOLDER,
    skills: input.skills ?? [],
    knowledge: input.knowledge ?? { layers: ['global', 'project'] },
    principle: extractPrinciple(body),
    body,
  }
  if (input.color !== undefined) role.color = input.color
  if (input.model !== undefined) role.model = input.model
  if (input.thoughtLevel !== undefined) role.thoughtLevel = input.thoughtLevel as RoleDefinition['thoughtLevel']

  const render = input.renderRole ?? ((r: RoleDefinition): string => renderZcodeRole(r))
  writeFile(path, render(role))
  return { written: [path], skipped: [] }
}

/**
 * `role edit`：对既有角色打字段补丁（正文/未知键原样保留）。
 * 目标不存在 → `role_not_found`（本命令只改，不隐式新建）。
 */
export async function editRole(input: EditRoleInput): Promise<RoleWriteResult> {
  const path = join(input.rolesDir, `${input.name.trim()}.md`)
  if (!existsSync(path)) {
    throw new RoleWriteError('role_not_found', `角色不存在，无法修改：${input.name}`, path)
  }
  const raw = readFileSync(path, 'utf8')
  writeFile(path, patchRoleRaw(raw, input.patch))
  return { written: [path], skipped: [] }
}

/**
 * 纯函数：给角色 Markdown 打补丁。
 *
 * 落点判定刻意分两形态（同一文件两种写法都要改对）：
 * - frontmatter **已有** `skills` / `knowledge` 键（Prism 规范形态 / 手写形态）→ 改 frontmatter；
 * - 否则（宿主原生形态，键不存在）→ 改正文的 overlay 小节。
 *   这样既不会给宿主原生文件擅自塞进白名单外的 frontmatter 键，也不会把 Prism 形态的键丢掉。
 */
export function patchRoleRaw(raw: string, patch: RolePatch): string {
  const { data, body } = splitFrontmatter(raw)
  const fm: FrontmatterData = data ?? {}
  const hadMarker = raw.includes('<!-- generated by prism (role: ')
  let nextBody = body.replace(/^\n+/, '')

  if (patch.description !== undefined) fm.description = patch.description
  // null = 清除该键（不写空串，避免留下 `color: ''` 这类半残状态）
  if (patch.color !== undefined) {
    if (patch.color === null) delete fm.color
    else fm.color = patch.color
  }
  if (patch.model !== undefined) {
    if (patch.model === null) delete fm.model
    else fm.model = patch.model
  }
  if (patch.thoughtLevel !== undefined) {
    if (patch.thoughtLevel === null) delete fm.thoughtLevel
    else fm.thoughtLevel = patch.thoughtLevel
  }

  if (patch.skills !== undefined) {
    if (Object.prototype.hasOwnProperty.call(fm, 'skills')) {
      fm.skills = [...patch.skills]
    } else {
      nextBody = replaceSection(nextBody, OVERLAY_SKILLS_HEADING, patch.skills.map((s) => `- ${s}`).join('\n'))
    }
  }

  if (patch.knowledge !== undefined) {
    if (Object.prototype.hasOwnProperty.call(fm, 'knowledge')) {
      fm.knowledge = knowledgeToFrontmatter(patch.knowledge)
    } else {
      nextBody = replaceSection(nextBody, OVERLAY_KNOWLEDGE_HEADING, knowledgeToOverlay(patch.knowledge))
    }
  }

  if (patch.body !== undefined) nextBody = patch.body.trimEnd()

  const content = renderMarkdownFile(fm, normalizeBlankLines(nextBody.trimEnd()))
  if (!hadMarker) return content
  const markerName = typeof fm.name === 'string' && fm.name !== '' ? fm.name : ''
  if (markerName === '') return content
  return `${content.trimEnd()}\n${roleMarker(markerName)}\n`
}

/**
 * `role rm`：删除角色文件本体（扁平 `<name>.md` + 兼容形态 `<name>/AGENTS.md`）。
 * 两处都不存在 → `role_not_found`。删除是否放行由调用方的写守卫决定，本函数不做二次确认。
 */
export async function removeRole(input: RemoveRoleInput): Promise<{ removed: string[] }> {
  const name = input.name.trim()
  const flat = join(input.rolesDir, `${name}.md`)
  const dirForm = join(input.rolesDir, name, 'AGENTS.md')
  const removed: string[] = []
  if (existsSync(flat)) {
    rmSync(flat, { force: true })
    removed.push(flat)
  }
  if (existsSync(dirForm)) {
    rmSync(dirname(dirForm), { recursive: true, force: true })
    removed.push(dirForm)
  }
  if (removed.length === 0) {
    throw new RoleWriteError('role_not_found', `角色不存在，无法删除：${name}`, flat)
  }
  return { removed }
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    throw new RoleWriteError(
      'role_write_failed',
      `目标目录创建失败（不可写或被占用）：${err instanceof Error ? err.message : String(err)}`,
      dir,
    )
  }
  if (!existsSync(dir)) {
    throw new RoleWriteError('role_write_failed', '目标目录创建失败：路径不可用', dir)
  }
}

function writeFile(path: string, content: string): void {
  try {
    writeFileSync(path, content, 'utf8')
  } catch (err) {
    throw new RoleWriteError('role_write_failed', `目标文件不可写：${err instanceof Error ? err.message : String(err)}`, path)
  }
}

/** knowledge 绑定 → frontmatter 值（只写非空键）。 */
function knowledgeToFrontmatter(knowledge: KnowledgeBinding): FrontmatterData {
  const out: FrontmatterData = { layers: [...knowledge.layers] }
  const books = knowledge.books ?? []
  if (books.length > 0) out.books = [...books]
  return out
}

/** knowledge 绑定 → 正文 overlay 小节（`- layers: a, b` / `- books: x`）。 */
function knowledgeToOverlay(knowledge: KnowledgeBinding): string {
  const lines: string[] = []
  if (knowledge.layers.length > 0) lines.push(`- layers: ${knowledge.layers.join(', ')}`)
  const books = knowledge.books ?? []
  if (books.length > 0) lines.push(`- books: ${books.join(', ')}`)
  return lines.join('\n')
}

/**
 * 替换或追加一个 `## <heading>` 小节。
 * - 小节已存在 → 连标题带内容整段替换；`content` 为空则整段删除；
 * - 不存在 → `content` 非空时追加到文末。
 */
export function replaceSection(body: string, heading: string, content: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) {
    if (content === '') return body
    return `${body.trimEnd()}\n\n${heading}\n${content}\n`
  }
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l.trim()))
  if (end === -1) end = lines.length
  const head = lines.slice(0, start)
  const tail = lines.slice(end)
  const middle = content === '' ? [] : [heading, content]
  return normalizeBlankLines([...head, ...middle, ...tail].join('\n'))
}

/** 收敛连续空行（命令改过的文件不该被空行淹没）。 */
function normalizeBlankLines(text: string): string {
  return `${text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trimEnd()}\n`
}
