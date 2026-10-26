/**
 * 工作流单元数据层（workflow-asset.md v1：**只读**）。
 *
 * web 无 @prism/* 依赖——类型只能**镜像**服务端契约（`@prism/agents` WorkflowDefinition /
 * `GET /api/workflows` 响应），不能 import；来源在注释里标明，契约变更时以服务端为准。
 * 请求信封的唯一实现在 ./http.ts（与 api-team.ts 同源，不另造）。
 */

import { request } from './http.ts'

/** 镜像 @prism/agents WorkflowStep（步骤表行的语义投影；owner 可为编排语义词）。 */
export interface WorkflowStep {
  order: number
  step: string
  owner: string[]
  skills: string
  input: string
  output: string
  done: string
  reflow: string
}

/** 镜像 @prism/agents RawWorkflowTable（步骤表底账：columns/rows/rowIds——图编辑器对齐未映射列）。 */
export interface StepsRawTable {
  columns: string[]
  rows: string[][]
  rowIds: string[]
}

/** 镜像 @prism/agents WorkflowDefinition（一等资产；issues 供页面校验状态展示）。 */
export interface WorkflowDefinition {
  workflow: string
  name: string
  level: 'role' | 'team'
  binds: string[]
  skills: string[]
  steps: WorkflowStep[]
  steps_raw?: StepsRawTable
  body: string
  sourcePath?: string
  /** v2：被编辑文件 mtime（epoch 毫秒整数）——PATCH if_match 用。 */
  source_mtime?: number
  issues?: Array<{ level: 'error' | 'warning'; code: string; message: string; where?: string }>
}

/** `GET /api/workflows` 响应（v1 形状 `{ workflows, workflows_dir }`；兼容旧 camel 键）。 */
export interface WorkflowIndex {
  workflows: WorkflowDefinition[]
  workflowsDir: string
}

/** 形状兼容：裸数组 / `{workflows, workflowsDir}` / `{workflows, workflows_dir}` 三态归一。 */
export function normalizeWorkflows(value: unknown): WorkflowIndex {
  if (Array.isArray(value)) return { workflows: value as WorkflowDefinition[], workflowsDir: '' }
  const v = (value ?? {}) as { workflows?: unknown; workflowsDir?: unknown; workflows_dir?: unknown }
  const workflows = Array.isArray(v.workflows) ? (v.workflows as WorkflowDefinition[]) : []
  const workflowsDir = typeof v.workflowsDir === 'string' ? v.workflowsDir : typeof v.workflows_dir === 'string' ? v.workflows_dir : ''
  return { workflows, workflowsDir }
}

/** PATCH /api/workflows/:id 的步骤行（镜像服务端 StepSerializeRow）。 */
export interface WorkflowStepPatchRow {
  rowId?: string
  order: number
  step: string
  owner: string[]
  skills: string
  input: string
  output: string
  done: string
  reflow: string
}

export interface WorkflowUpdateResult {
  path: string
  source_mtime: number
}

export const workflowApi = {
  /** 列表（含 issues；binds 校验用的角色库在服务端解析）。 */
  list: (): Promise<WorkflowIndex> => request<unknown>('/api/workflows').then(normalizeWorkflows),
  /** 单个单元详情（steps + body + issues + steps_raw + source_mtime）。 */
  detail: (id: string): Promise<WorkflowDefinition> =>
    request<WorkflowDefinition>(`/api/workflows/${encodeURIComponent(id)}`),
  /** v2 图编辑器：改步骤表（写目录显式给——取列表的 workflows_dir）。 */
  update: (
    id: string,
    input: { steps: WorkflowStepPatchRow[]; if_match?: number; workflows_dir: string },
  ): Promise<WorkflowUpdateResult> =>
    request<WorkflowUpdateResult>(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
}
