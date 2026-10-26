/**
 * `prism workflow edit` 的唯一实现（workflow-asset v2 图编辑器写路径）。
 *
 * 结构镜像 `role/write.ts` + `team/write.ts` 的组合：
 * - 落点单点 `resolveWorkflowFile`（扁平 `<id>.md`；工作流单元无目录形态）；
 * - 补丁纯函数 `patchWorkflowRaw`（只 splice `## 步骤表` 表格行区间，frontmatter 与
 *   节外正文逐行原样——raw 底账不采信客户端，服务端对文件本体重解析，同 patchTeamRaw）；
 * - `if_match` 陈旧写防护（mtime 毫秒整数，照 editTeam）；
 * - 写前跑 `validateWorkflow`：error 级 issue 拒绝落盘（`workflow_invalid`，带 issue 摘要）。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderMarkdownFile, splitFrontmatter, stripPrismMarkerTail, type FrontmatterData } from '../frontmatter.js'
import type { StepSerializeRow, WorkflowDefinition, WorkflowStep } from '../types.js'
import { parseWorkflowMarkdown } from './parse.js'
import { serializeStepSection, serializeStepTable, StepsSectionMissingError } from './serialize.js'
import { validateWorkflow, type ValidateWorkflowOptions } from './validate.js'

/** 工作流写盘失败。 */
export class WorkflowWriteError extends Error {
  readonly code: 'workflow_id_invalid' | 'workflow_not_found' | 'stale_write' | 'steps_section_missing' | 'workflow_invalid' | 'workflow_write_failed'
  readonly path?: string
  /** `workflow_invalid` 时携带校验 issue 摘要（供界面逐条展示）。 */
  readonly issues?: Array<{ level: string; code: string; message: string }>

  constructor(
    code: WorkflowWriteError['code'],
    message: string,
    path?: string,
    issues?: Array<{ level: string; code: string; message: string }>,
  ) {
    super(`${code}: ${message}${path !== undefined ? ` (${path})` : ''}`)
    this.name = 'WorkflowWriteError'
    this.code = code
    this.path = path
    this.issues = issues
  }
}

export interface WorkflowPatch {
  /** 步骤表全量行（含 rowId 对齐未映射列；`[]` = 清空表格——validateWorkflow 会拒 steps_empty）。 */
  steps: StepSerializeRow[]
  /** 列集（含未映射列，保持列序）；缺省 = 原 steps_raw.columns。 */
  columns?: string[]
}

export interface EditWorkflowInput {
  workflow: string
  workflowsDir: string
  patch: WorkflowPatch
  /** 陈旧写防护：文件 epoch 毫秒整数（取自 GET 详情的 source_mtime）；不符 → stale_write。 */
  ifMatch?: number
  /** 校验上下文（binds 角色存在性等）；缺省跳过需要角色库的检查。 */
  validateOptions?: ValidateWorkflowOptions
}

export interface WorkflowEditResult {
  path: string
  /** 写后文件 mtime（epoch 毫秒整数）——续作下一次 if_match。 */
  sourceMtime: number
}

/** 落点单点：`<workflowsDir>/<id>.md`（扁平形态；不存在 → null）。 */
export function resolveWorkflowFile(workflowsDir: string, workflowId: string): string | null {
  const id = workflowId.trim()
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    throw new WorkflowWriteError('workflow_id_invalid', `工作流 id 必须是 kebab-case：${workflowId}`, join(workflowsDir, `${id}.md`))
  }
  const file = join(workflowsDir, `${id}.md`)
  return existsSync(file) ? file : null
}

/**
 * 纯函数：给工作流 Markdown 打步骤表补丁。
 * frontmatter 与 `## 步骤表` 表格行区间之外的内容**逐行原样**；raw 底账从入参原文重解析
 * （不采信调用方转述），保证 splice 行号与内容对齐。
 */
export function patchWorkflowRaw(raw: string, patch: WorkflowPatch): { next: string; candidate: WorkflowDefinition } {
  const { data, body } = splitFrontmatter(raw)
  const fm: FrontmatterData = data ?? {}
  const cleanBody = stripPrismMarkerTail(body)
  const parsed = parseWorkflowMarkdown(raw)
  const table = serializeStepTable({ rows: patch.steps, ...(patch.columns !== undefined ? { columns: patch.columns } : {}), ...(parsed.steps_raw !== undefined ? { raw: parsed.steps_raw } : {}) })
  const nextBody = serializeStepSection(cleanBody, table, parsed.steps_raw)
  const next = renderMarkdownFile(fm, nextBody)
  // 候选定义（写前校验用）：语义步骤从提交行重建
  const steps: WorkflowStep[] = patch.steps.map((row, index) => ({
    order: index + 1,
    step: row.step,
    owner: [...row.owner],
    skills: row.skills,
    input: row.input,
    output: row.output,
    done: row.done,
    reflow: row.reflow,
  }))
  const candidate: WorkflowDefinition = { ...parsed, steps }
  return { next, candidate }
}

/** `workflow edit`：改步骤表（校验通过才落盘）。不存在 → workflow_not_found；mtime 不符 → stale_write。 */
export function editWorkflow(input: EditWorkflowInput): WorkflowEditResult {
  const file = resolveWorkflowFile(input.workflowsDir, input.workflow)
  if (file === null) {
    throw new WorkflowWriteError('workflow_not_found', `工作流不存在，无法修改：${input.workflow}`, join(input.workflowsDir, `${input.workflow}.md`))
  }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {
    // 读不到 mtime 按 0：ifMatch 缺省时无影响；给了 ifMatch 必不匹配 → stale_write（安全侧）
  }
  if (input.ifMatch !== undefined && Math.round(mtimeMs) !== input.ifMatch) {
    throw new WorkflowWriteError('stale_write', `文件已被其他人修改（磁盘 mtime ${Math.round(mtimeMs)} ≠ if_match ${input.ifMatch}）——重新读取后再提交`, file)
  }
  const raw = readFileSync(file, 'utf-8')
  let next: string
  let candidate: WorkflowDefinition
  try {
    ;({ next, candidate } = patchWorkflowRaw(raw, input.patch))
  } catch (err) {
    if (err instanceof StepsSectionMissingError) {
      throw new WorkflowWriteError('steps_section_missing', err.message, file)
    }
    throw new WorkflowWriteError('workflow_write_failed', err instanceof Error ? err.message : String(err), file)
  }
  const check = validateWorkflow(candidate, input.validateOptions ?? {})
  const errors = check.issues.filter((i) => i.level === 'error')
  if (errors.length > 0) {
    throw new WorkflowWriteError('workflow_invalid', `校验未通过，拒绝落盘：${errors.map((e) => `[${e.code}] ${e.message}`).join('；')}`, file, check.issues)
  }
  try {
    writeFileSync(file, next, 'utf-8')
  } catch (err) {
    throw new WorkflowWriteError('workflow_write_failed', `写入失败：${err instanceof Error ? err.message : String(err)}`, file)
  }
  return { path: file, sourceMtime: Math.round(statSync(file).mtimeMs) }
}
