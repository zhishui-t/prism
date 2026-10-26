/**
 * 工作流单元路由（workflow-asset.md v1：**只读**两条）。
 *
 * - `GET /api/workflows` → `{ workflows, workflows_dir }`（issues 已挂载，供页面校验状态展示）
 * - `GET /api/workflows/:id` → 单个单元（steps + body + issues）
 *
 * 数据源与 CLI / MCP **同源**（`resolveDirsFromHome`：prism.yaml `workflows_dir` 覆盖 → 适配器
 * `agent.workflowDir` → roles 同级 workflows/）。v1 无写路由——编辑保持文件级（页面给路径提示），
 * 结构化编辑器是 v2（见设计文档待确认项）。
 */

import { fail, ok, type Envelope } from '../envelope.js'
import type { RouteContext } from '../router.js'
import {
  loadWorkflows,
  readWorkflowDetail,
  resolveDirsFromHome,
  updateWorkflowDefinition,
  workflowNotFoundMessage,
  type UpdateWorkflowBody,
} from '../../roles/index.js'

export interface WorkflowDeps {
  /** PRISM_HOME（prism.yaml 配置源）。 */
  home: string
  /** 宿主根目录（默认推导基准）。 */
  harnessRoot: string
}

export function workflowRoutes(deps: WorkflowDeps): {
  workflows: (ctx: RouteContext) => Promise<Envelope>
  workflow: (ctx: RouteContext) => Promise<Envelope>
  workflowUpdate: (ctx: RouteContext) => Promise<Envelope>
} {
  const dirs = resolveDirsFromHome(deps.home, { harnessRoot: deps.harnessRoot, rootExplicit: true })
  const workflowsDir = dirs.workflowsDir
  const rolesDir = dirs.rolesDir

  const workflows = async (): Promise<Envelope> =>
    ok({
      workflows: await loadWorkflows(workflowsDir, { rolesDir }),
      workflows_dir: workflowsDir,
    })

  /** v2：详情带 steps_raw（底账）+ source_mtime（图编辑器乐观锁前置），与 MCP prism_workflow_get 同一单点。 */
  const workflow = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    const detail = await readWorkflowDetail(workflowsDir, id, { rolesDir })
    if (detail === null) {
      return fail('not_found', workflowNotFoundMessage(workflowsDir, id))
    }
    return ok({ ...detail.workflow, source_mtime: detail.source_mtime })
  }

  /** `PATCH /api/workflows/:id`：改步骤表。写目录只认 body **显式** `workflows_dir`（不回落默认宿主，同 role/team 写路径口径）。 */
  const workflowUpdate = async (ctx: RouteContext): Promise<Envelope> => {
    const id = ctx.params.id ?? ''
    const body = (await ctx.body()) as UpdateWorkflowBody
    const result = await updateWorkflowDefinition(id, body)
    return ok(result)
  }

  return { workflows, workflow, workflowUpdate }
}
