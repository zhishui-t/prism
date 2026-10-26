/**
 * 工作流单元写盘（workflow-asset v2：HTTP `PATCH /api/workflows/:id` 与 MCP `prism_workflow_edit`
 * 共用写路径）+ 读侧详情单点（steps_raw / source_mtime——图编辑器的底账与乐观锁前置）。
 */

import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { PrismError } from '@prism/core'
import {
  editWorkflow,
  parseWorkflowMarkdown,
  resolveWorkflowFile,
  WorkflowWriteError,
  type StepSerializeRow,
  type WorkflowDefinition,
} from '@prism/agents'

import { loadRoles, loadWorkflow } from './wiring.js'

/** GET /api/workflows/:id 与 MCP prism_workflow_get 的详情包装（同 team-read 的口径）。 */
export interface WorkflowReadDetail {
  workflow: WorkflowDefinition
  /** 被编辑文件本体的 epoch 毫秒整数（PATCH if_match 用）。 */
  source_mtime: number
}

/** 读单个工作流单元 + 底账 + mtime（图编辑器前置数据）。不存在 → null。 */
export async function readWorkflowDetail(
  workflowsDir: string,
  workflowId: string,
  opts: { rolesDir?: string; knownSkills?: string[] } = {},
): Promise<WorkflowReadDetail | null> {
  const file = resolveWorkflowFile(workflowsDir, workflowId)
  if (file === null) return null
  const parsed = parseWorkflowMarkdown(await readFile(file, 'utf-8'), { sourcePath: file })
  // issues 与列表同口径（binds 角色校验需要角色库）
  const loaded = await loadWorkflow(workflowsDir, workflowId, opts)
  const wf = loaded ?? parsed
  // steps_raw 取文件本体解析（loaded 与 parsed 同源文件，等价；显式取 parsed 保字段确定存在）
  return {
    workflow: { ...wf, steps_raw: parsed.steps_raw },
    source_mtime: Math.round(statSync(file).mtimeMs),
  }
}

/** `PATCH /api/workflows/:id` 请求体。 */
export interface UpdateWorkflowBody {
  /** 步骤行（含 rowId 对齐未映射列；语义字段缺省按空处理）。 */
  steps?: unknown
  /** 列集（含未映射列）。 */
  columns?: unknown
  /** 乐观锁：GET 的 source_mtime；不符 → 409 stale_write。 */
  if_match?: unknown
  /** **必填**：写入目录（无 env 回落，绝不回落到默认宿主目录）。 */
  workflows_dir?: unknown
  /** binds 校验用的角色库（可选）。 */
  roles_dir?: unknown
}

/** 步骤行的严格解析（镜像 team-create 的 parseWorkflowPatch 口径：形状坏 → 400 bad_request）。 */
export function parseStepsPatch(value: unknown): StepSerializeRow[] {
  if (!Array.isArray(value)) {
    throw new PrismError('bad_request', 'steps_patch_invalid：steps 必须是行数组（order/step/owner/skills/input/output/done/reflow，可选 rowId/extra）')
  }
  return value.map((row) => {
    if (typeof row !== 'object' || row === null) {
      throw new PrismError('bad_request', 'steps_patch_invalid：步骤行必须是对象')
    }
    const r = row as Record<string, unknown>
    const owner = Array.isArray(r['owner']) ? r['owner'].filter((o): o is string => typeof o === 'string') : []
    const extraSrc = typeof r['extra'] === 'object' && r['extra'] !== null ? (r['extra'] as Record<string, unknown>) : undefined
    const extra: Record<string, string> | undefined =
      extraSrc !== undefined
        ? Object.fromEntries(Object.entries(extraSrc).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : undefined
    return {
      ...(typeof r['rowId'] === 'string' ? { rowId: r['rowId'] } : {}),
      order: typeof r['order'] === 'number' ? r['order'] : 0,
      step: typeof r['step'] === 'string' ? r['step'] : '',
      owner,
      skills: typeof r['skills'] === 'string' ? r['skills'] : '',
      input: typeof r['input'] === 'string' ? r['input'] : '',
      output: typeof r['output'] === 'string' ? r['output'] : '',
      done: typeof r['done'] === 'string' ? r['done'] : '',
      reflow: typeof r['reflow'] === 'string' ? r['reflow'] : '',
      ...(extra !== undefined ? { extra } : {}),
    }
  })
}

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

/** `PATCH /api/workflows/:id` / `prism_workflow_edit`：改步骤表（校验通过才落盘）。 */
export async function updateWorkflowDefinition(
  workflowId: string,
  body: UpdateWorkflowBody,
): Promise<{ path: string; source_mtime: number }> {
  const workflowsDir = asNonEmptyString(body.workflows_dir)
  if (workflowsDir === undefined) {
    throw new PrismError('bad_request', 'workflows_dir_required：未指定工作流目录（防误写真实宿主，写路径一律显式参数化）。')
  }
  if (body.steps === undefined) {
    throw new PrismError('bad_request', 'steps_patch_empty：PATCH 需要给 steps（行数组）；只改列集请附原行。')
  }
  const steps = parseStepsPatch(body.steps)
  const columns = Array.isArray(body.columns) ? body.columns.filter((c): c is string => typeof c === 'string') : undefined
  const ifMatch = parseIfMatch(body.if_match)
  const rolesDir = asNonEmptyString(body.roles_dir)
  try {
    const result = editWorkflow({
      workflow: workflowId,
      workflowsDir,
      patch: { steps, ...(columns !== undefined ? { columns } : {}) },
      ...(ifMatch !== undefined ? { ifMatch } : {}),
      ...(rolesDir !== undefined ? { validateOptions: { roles: await loadRoles(rolesDir) } } : {}),
    })
    return { path: result.path, source_mtime: result.sourceMtime }
  } catch (err) {
    if (err instanceof WorkflowWriteError) {
      const status =
        err.code === 'workflow_not_found' ? 'not_found' : err.code === 'stale_write' ? 'stale_write' : err.code === 'steps_section_missing' ? 'workflow_section_missing' : 'bad_request'
      const detail: Record<string, unknown> = { path: err.path }
      if (err.issues !== undefined) detail['issues'] = err.issues
      throw new PrismError(status, err.message, detail)
    }
    throw err
  }
}

function parseIfMatch(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isInteger(n) || n < 0) {
    throw new PrismError('bad_request', 'if_match_invalid：必须是 epoch 毫秒整数（取自 GET 的 source_mtime）')
  }
  return n
}
