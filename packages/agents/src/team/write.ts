/**
 * 团队写盘（`prism team edit | rm`）。
 *
 * 分工：`team new` 的脚手架渲染在 `team/init.ts`（`renderTeamScaffold`，只渲染不落盘）；
 * 本文件负责**改**与**删**——与 `role/write.ts` 对称。
 *
 * `edit` 是**外科式补丁**：`patchTeamRaw` 只动点名的那几处：
 * - `members` 变更 → 复用 `narrowWorkflow` 收窄工作流，再经 `serializeWorkflowTable` **保列集**
 *   写回（未映射列按 rowId 合并，R-v11-3）；**roles 列缺失 / prose / 无小节 → 收窄整体跳过**
 *   并出 warning，绝不把工作流正文替换成空表（R-v11-1 数据丢失红线）；
 * - `workflow` 变更 → 同上保列集写回，且**只换表格区行区间**（`raw.headerLine/lastLine`）：
 *   小节内的段落/引用块/第二张表逐行存活（B-1，R7「文件为真相」）——无 raw 的 prose 转换
 *   才整节替换；
 * - 其余 frontmatter 键（name/description/skills/knowledge/deposit/arbitration/rework_limit）就地覆盖；
 * - 正文其余小节与未知 frontmatter 键原样保留。
 *
 * `rm` 把团队文件本体（扁平 `<id>.md` 与兼容形态 `<id>/AGENTS.md` 都认）**整单元搬进回收站**
 * （v9 F3：原「直接删」改为 `TrashStore.put`，可 `prism trash restore <id>` 还原）；是否放行由
 * 调用方的写守卫决定（默认宿主目录需 `--yes`）。
 *
 * 安全：目标目录由参数传入，**绝不硬编码宿主根**；测试必须用临时目录。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { TrashStore, TrashTrigger } from '@prism/core'

import { renderMarkdownFile, splitFrontmatter, type FrontmatterData } from '../frontmatter.js'
import type {
  DepositPolicy,
  KnowledgeBinding,
  TeamMember,
  ValidationIssue,
  WorkflowParseResult,
  WorkflowSerializeRow,
} from '../types.js'
import { narrowWorkflow } from './init.js'
import { mapWorkflowColumns, parseWorkflowSection } from './parse.js'
import { serializeWorkflowSection, serializeWorkflowTable, WorkflowSectionMissingError } from './serialize.js'
import { stripInstanceMarker } from './validate.js'

/** 团队写盘失败（id 非法 / 目录不可写 / 目标不存在 / 陈旧写等）。 */
export class TeamWriteError extends Error {
  readonly code: 'team_id_invalid' | 'team_write_failed' | 'team_not_found' | 'stale_write'
  readonly path?: string

  constructor(code: TeamWriteError['code'], message: string, path?: string) {
    super(`${code}: ${message}${path ? ` (${path})` : ''}`)
    this.name = 'TeamWriteError'
    this.code = code
    this.path = path
  }
}

const KEBAB_CASE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface TeamWriteResult {
  written: string[]
  skipped: { path: string; reason: string }[]
  /** 工作流随名册收窄等诊断（供 CLI/HTTP 打印）。 */
  issues: ValidationIssue[]
}

/** 团队定义补丁（只列可改字段；`team_id` 是文件名，不支持改）。 */
export interface TeamPatch {
  name?: string
  description?: string
  members?: TeamMember[]
  skills?: string[]
  knowledge?: KnowledgeBinding
  deposit?: Partial<DepositPolicy>
  arbitration?: string[]
  reworkLimit?: number
  /**
   * 结构化保存工作流（v11 F2 / R-v11-3）：`stages` 的 `rowId` 对齐原 raw 行的**未映射列**，
   * 无 `rowId` = 新行，原 raw 有而未提交的 rowId 连同其未映射列删除。
   *
   * `columns`（v11 派修 M-2，可选）= 提交的**列集**（含未映射列，保持列序）：给了就用它
   * 渲染表头（核心字段列不在其中 = 该字段不入表、值随列弃；自定义列按列名取 `row.extra`）；
   * 不给 = 回落 `raw.columns`，再无 → 核心八列 + `原文`（既有口径不变）。
   *
   * 与 `members` **同给时 workflow 胜**（编辑器所见即所存）——名册收窄整体跳过并出
   * `workflow_narrow_skipped`（详见 `patchTeamRaw`）。
   */
  workflow?: { stages: WorkflowSerializeRow[]; columns?: string[] }
}

export interface EditTeamInput {
  teamId: string
  teamsDir: string
  patch: TeamPatch
  /**
   * 陈旧写防护（R-v11-15）：调用方从 `GET /api/teams/:id` 的 `source_mtime` 带来的
   * epoch 毫秒整数。与写前 `statSync(file).mtimeMs` 取整比对，不匹配 → `stale_write`。
   * 不给 = 不做并发校验（向后兼容；CLI 面不强制）。
   */
  ifMatch?: number
}

export interface RemoveTeamInput {
  teamId: string
  teamsDir: string
  /** 回收站（搬移 + 审计单点）；由入口层按 `PRISM_HOME` 构造后注入（见 role/write.ts 同名注释）。 */
  trash: TrashStore
  /** 触发入口（进回收站 meta 与审计，仅作溯源）。 */
  trigger: TrashTrigger
}

/** `team rm` 的结果。 */
export interface TeamRemoveResult {
  /** **实际落点**：扁平形态 = `<id>.md`；目录形态 = 整个 `<id>/` 目录（不是其中的 AGENTS.md）。 */
  removed: string[]
  /** 回收站单元 id（`<kind>/<单元目录名>`）。 */
  trashId: string
}

/**
 * 解析团队文件本体（双形态，**目录式优先**）：`<teamsDir>/<id>/AGENTS.md` → `<teamsDir>/<id>.md`。
 * 两处都不存在 → `null`（不隐式新建）。
 *
 * 候选序对齐 `wiring.ts` 的 `loadTeam`（`[<id>/AGENTS.md, <id>.md]`，M-7）：两形态共存
 * （病理态）时 GET 的 raw/mtime 与写落点必须**同一文件**，否则「读的是 A、写的是 B」。
 * 单形态行为不变（任一形态存在即唯一命中）。
 *
 * 单点理由：`loadTeam` / `removeTeam` / `editTeam` 与 server 的 GET raw/mtime
 * 必须同一套落点判定；散落多份就是漂移的温床（P0-5：editTeam 曾只认扁平形态）。
 * 注：`removeTeam` 双形态**都删**（回收站整单元语义），不取本函数的「单一落点」。
 */
export function resolveTeamFile(teamsDir: string, teamId: string): string | null {
  const id = teamId.trim()
  const dirForm = join(teamsDir, id, 'AGENTS.md')
  if (existsSync(dirForm)) return dirForm
  const flat = join(teamsDir, `${id}.md`)
  if (existsSync(flat)) return flat
  return null
}

/**
 * `team edit`：对既有团队打字段补丁。目标不存在 → `team_not_found`（本命令只改，不隐式新建）。
 *
 * 落点双形态（P0-5 / R-v11-14 / M-7）：**目录式 `<id>/AGENTS.md` 优先**，其次扁平
 * `<id>.md`——与 `loadTeam` 候选序一致（真实团队常是目录式，旧实现只认扁平形态，保存直接 404）。
 *
 * `ifMatch` 给出时先做**陈旧写**判定（R-v11-15，三入口经本单点获得同一防护）。
 */
export async function editTeam(input: EditTeamInput): Promise<TeamWriteResult> {
  const teamId = input.teamId.trim()
  const path = resolveTeamFile(input.teamsDir, teamId)
  if (path === null) {
    throw new TeamWriteError('team_not_found', `团队不存在，无法修改：${teamId}`, join(input.teamsDir, `${teamId}.md`))
  }
  if (input.ifMatch !== undefined) {
    const actual = Math.round(statSync(path).mtimeMs)
    if (actual !== Math.round(input.ifMatch)) {
      // 宿主手改是常态（delivery 两日 7 份 .backups）；无防护的 read→write 会整段覆盖
      // 用户没碰过的单元格 —— 宁可拒绝，也不做「静默 lost update」。
      throw new TeamWriteError(
        'stale_write',
        `文件已被他方修改（期望 mtime ${Math.round(input.ifMatch)}，实际 ${actual}）——请重新读取后再提交`,
        path,
      )
    }
  }
  const { markdown, issues } = patchTeamRaw(readFileSync(path, 'utf8'), input.patch)
  writeFile(path, markdown)
  return { written: [path], skipped: [], issues }
}

/**
 * 纯函数：给团队 Markdown 打补丁。
 *
 * `issues` 来源，都为了让人看得见「改名册顺手动了（或没动）工作流」这件事：
 * - `workflow_pruned`：收窄剔除的角色/阶段；
 * - `workflow_narrow_skipped`：roles 列缺失 / prose / 无小节 → 收窄整体跳过（R-v11-1）；
 *   或 `members` 与 `workflow` 同给 → 工作流以提交的 stages 为准（R-v11-13）；
 * - 工作流读侧的降级 issue（ragged / order 回退 / 多余列 / 第二张表按正文等，R-v11-5）原样透出；
 * - `workflow_prose_replaced`：prose 态被表格替换（原文不再自动保留，M-12）。
 *
 * `workflow` 补丁的分支语义（R-v11-3 / R-v11-11 / M-2）：
 * - 有表格 → `serializeWorkflowTable({ columns?, raw, rows })`（列集 = 提交 columns > raw.columns；
 *   未映射列按 rowId **按列名**合并，保列集）；
 * - prose（有节无表）→ 无 raw 起点：核心八列 + `原文`（自由文本结构化的唯一起点形态）；
 * - 无 `## 工作流` 小节 → 抛 `WorkflowSectionMissingError`（向上透传，不静默、不自动插小节）。
 *
 * 写回范围（B-1，红线 R7）：有 raw 且行号齐备 → 只换**表格区行区间**，小节内段落/引用/第二张表
 * 逐行存活；无 raw（prose 转换）才整节替换。
 */
export function patchTeamRaw(raw: string, patch: TeamPatch): { markdown: string; issues: ValidationIssue[] } {
  const { data, body } = splitFrontmatter(raw)
  const fm: FrontmatterData = data ?? {}
  const hadMarker = raw.includes('<!-- generated by prism (team: ')
  const issues: ValidationIssue[] = []
  let nextBody = body.replace(/^\n+/, '')

  if (patch.name !== undefined) fm.name = patch.name
  if (patch.description !== undefined) fm.description = patch.description
  if (patch.skills !== undefined) fm.skills = [...patch.skills]
  if (patch.knowledge !== undefined) {
    fm.knowledge = {
      layers: [...patch.knowledge.layers],
      ...(patch.knowledge.books !== undefined ? { books: [...patch.knowledge.books] } : {}),
    }
  }
  if (patch.arbitration !== undefined) fm.arbitration = [...patch.arbitration]
  if (patch.reworkLimit !== undefined) fm.rework_limit = patch.reworkLimit
  if (patch.deposit !== undefined) fm.deposit = mergeDeposit(fm.deposit, patch.deposit)

  if (patch.members !== undefined) {
    const members = patch.members
    fm.members = members.map((m) => ({ role: m.role, count: m.count }))
    if (patch.workflow !== undefined) {
      // members 与 workflow 同给 → **workflow 胜**（编辑器所见即所存）：名册只改 frontmatter，
      // 工作流以提交的 stages 为准，不收窄、不重编号（R-v11-13）。
      issues.push({
        level: 'warning',
        code: 'workflow_narrow_skipped',
        message: 'members 与 workflow 同给：工作流以提交的 stages 为准，未按名册收窄',
      })
    } else {
      // 名册收窄 → 工作流就地裁剪（与 `team new --members` 同一裁剪器 `narrowWorkflow`）。
      // 读侧走弹性解析（不抛），写侧走 serialize（保列集 / 未映射列按 rowId 合并）。
      const memberRoles = new Set(members.map((m) => stripInstanceMarker(m.role)))
      const parsed = parseWorkflowSection(nextBody, { baseLine: bodyLineOffset(raw, body, nextBody) })
      issues.push(
        ...parsed.issues.map((issue) => ({ level: 'warning' as const, code: issue.code, message: issue.message })),
      )
      const rolesMapped = parsed.raw !== undefined && mapWorkflowColumns(parsed.raw.columns).includes('roles')
      const { stages, prunedRoles, prunedStages, keptIndexes } = narrowWorkflow(parsed.stages, memberRoles, {
        rolesMapped,
      })
      if (!rolesMapped) {
        // R-v11-1：roles 未映射（缺列 / prose / 无小节）时收窄与回流校验整体跳过，
        // 工作流正文原样保留——旧实现在此把整段表替换成固定 8 列空表且零诊断。
        issues.push({
          level: 'warning',
          code: 'workflow_narrow_skipped',
          message: `名册已更新，但工作流未收窄（${workflowNarrowSkipReason(parsed)}）——工作流正文原样保留`,
        })
      } else {
        const rawTable = parsed.raw!
        const rows: WorkflowSerializeRow[] = stages.map((stage, index) => ({
          rowId: rawTable.rowIds[keptIndexes[index]],
          order: stage.order,
          stage: stage.stage,
          roles: stage.roles,
          mode: stage.mode,
          input: stage.input,
          output: stage.output,
          done: stage.done,
          reflow: stage.reflow,
        }))
        nextBody = serializeWorkflowSection(nextBody, serializeWorkflowTable({ raw: rawTable, rows }), rawTable)
        if (prunedRoles.length > 0 || prunedStages.length > 0) {
          issues.push({
            level: 'warning',
            code: 'workflow_pruned',
            message: `工作流已按名册收窄：剔除角色 [${[...new Set(prunedRoles)].join(', ') || '—'}]，删除阶段 [${prunedStages.join(', ') || '—'}]`,
          })
        }
      }
    }
  }

  if (patch.workflow !== undefined) {
    // raw 底账用**本次补丁内**的同一份 parse（不重读文件、不采信客户端回传的 raw）——
    // 缩信任面 + 缩并发窗口（design-v11 §3）。parse 与 serialize 吃同一份 nextBody，
    // 故 parsed.raw 的 headerLine/lastLine 可直接当写回行区间（B-1）。
    const parsed = parseWorkflowSection(nextBody, { baseLine: bodyLineOffset(raw, body, nextBody) })
    if (parsed.sectionMissing === true) {
      throw new WorkflowSectionMissingError(
        '团队文件没有「## 工作流」小节，结构化工作流无处写回（不自动插入小节，避免造出半成品）',
      )
    }
    // 读侧降级诊断（ragged / order 回退 / 第二张表按正文 / 表头变体…）原样透出——
    // 对齐 members 分支；旧实现 workflow 分支 `issues: []`，保存删正文却零诊断（B-1）。
    issues.push(...parsed.issues.map((issue) => ({ level: 'warning' as const, code: issue.code, message: issue.message })))
    if (parsed.raw === undefined) {
      // M-12：prose 态（有节无表）→ 无 raw 起点，整节替换。客户端没把原文带进 `原文` 列时
      // 自由文本就此消失——服务端手里有 proseText，零成本给个 warning（**不填充、不改契约**）。
      issues.push({
        level: 'warning',
        code: 'workflow_prose_replaced',
        message:
          '工作流小节原是自由文本（无表格），本次保存以表格替换该小节——原文不会自动保留（如需保留请写进「原文」列）',
      })
    }
    const table = serializeWorkflowTable({
      ...(patch.workflow.columns !== undefined ? { columns: patch.workflow.columns } : {}),
      ...(parsed.raw !== undefined ? { raw: parsed.raw } : {}),
      rows: patch.workflow.stages,
    })
    nextBody = serializeWorkflowSection(nextBody, table, parsed.raw)
  }

  const content = renderMarkdownFile(fm, normalizeBlankLines(nextBody.trimEnd()))
  const teamId = typeof fm.team_id === 'string' ? fm.team_id : ''
  const markdown = hadMarker && teamId !== '' ? `${content.trimEnd()}\n<!-- generated by prism (team: ${teamId}) -->\n` : content
  return { markdown, issues }
}

/**
 * `team rm`：把团队文件本体搬进回收站（扁平 `<id>.md` + 兼容形态 `<id>/AGENTS.md`）。
 * 两处都不存在 → `team_not_found`。删除是否放行由调用方的写守卫决定，本函数不做二次确认。
 *
 * **落点粒度**同 `role rm`（v9.1 D-1）：目录形态整目录搬走，不留残目录。
 */
export async function removeTeam(input: RemoveTeamInput): Promise<TeamRemoveResult> {
  const teamId = input.teamId.trim()
  const flat = join(input.teamsDir, `${teamId}.md`)
  const dirForm = join(input.teamsDir, teamId, 'AGENTS.md')
  const targets: string[] = []
  if (existsSync(flat)) {
    targets.push(flat)
  }
  if (existsSync(dirForm)) {
    targets.push(dirname(dirForm))
  }
  if (targets.length === 0) {
    throw new TeamWriteError('team_not_found', `团队不存在，无法删除：${teamId}`, flat)
  }
  const moved = await input.trash.put('team', teamId, targets, {
    managedRoot: input.teamsDir,
    trigger: input.trigger,
  })
  return { removed: moved.originalPaths, trashId: moved.id }
}

/** 校验团队 id 形状（CLI 建团队入口用）。 */
export function assertTeamId(teamId: string): void {
  if (!KEBAB_CASE_RE.test(teamId.trim())) {
    throw new TeamWriteError('team_id_invalid', `团队 id 必须 kebab-case（小写字母/数字/连字符）：${teamId}`)
  }
}

function writeFile(path: string, content: string): void {
  try {
    writeFileSync(path, content, 'utf8')
  } catch (err) {
    throw new TeamWriteError('team_write_failed', `目标文件不可写：${err instanceof Error ? err.message : String(err)}`, path)
  }
}

/** 合并 deposit 补丁（只认已知 5 键；未知/非法值忽略，不猜不崩）。 */
function mergeDeposit(current: unknown, patch: Partial<DepositPolicy>): FrontmatterData {
  const base: FrontmatterData =
    typeof current === 'object' && current !== null && !Array.isArray(current) ? { ...(current as FrontmatterData) } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) base[key] = value as FrontmatterData[string]
  }
  return base
}

/** 收窄被跳过的原因（进 warning 文案；三态与 parseWorkflowSection 的两态对应）。 */
function workflowNarrowSkipReason(parsed: WorkflowParseResult): string {
  if (parsed.sectionMissing === true) return '无 `## 工作流` 小节'
  if (parsed.prose === true) return '工作流小节为自由文本（无表格）'
  return '工作流表无「角色」列'
}

/**
 * 正文（已剥 frontmatter、去前导空行）首行对应的**整份文件行号基准**：
 * `prefix` = frontmatter 占的行数，`body.length - strippedBody.length` = 被剥掉的前导换行数。
 *
 * CRLF 归一（M-5）：`splitFrontmatter` 已把正文归一到 LF，故比对 raw 前必须先做同样的
 * `\r\n → \n`——否则 `raw.endsWith(body)` 在 CRLF 文件下恒 false、prefix=0，
 * 同一内容 CRLF 与 LF 会报出不同行号。
 */
function bodyLineOffset(raw: string, body: string, strippedBody: string): number {
  const normalized = raw.replace(/\r\n/g, '\n')
  const prefix = normalized.endsWith(body)
    ? normalized.slice(0, normalized.length - body.length).split('\n').length - 1
    : 0
  return prefix + (body.length - strippedBody.length)
}

function normalizeBlankLines(text: string): string {
  return `${text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trimEnd()}\n`
}
