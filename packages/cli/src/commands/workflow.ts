import { readFileSync } from 'node:fs'

import {
  editWorkflow,
  loadRoles,
  loadWorkflow,
  loadWorkflows,
  parseStepsPatch,
  validateWorkflowUniqueness,
  workflowNotFoundMessage,
  type StepSerializeRow,
  type WorkflowDefinition,
} from '@prism/server'

import type { ArgValues, CommandContext } from '../argv.js'
import { expandHome, guardWriteTarget, resolveTargetDirs } from '../argv.js'

/**
 * `prism workflow list/show/validate`（workflow-asset.md v1：**只读三命令**）。
 * 工作流单元目录 = resolveDirs().workflowsDir（适配器 `agent.workflowDir`，默认宿主根下
 * workflows/；prism.yaml `workflows_dir` 可覆盖）。编辑保持文件级——`new/edit/rm` 是 v2。
 */
export async function runWorkflow(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const dirs = resolveTargetDirs(ctx, values)
  // `--source` 覆盖受管目录（读命令也生效，与 team 侧同口径；只读无写守卫问题）
  const sourceExplicit = values.source !== undefined
  const workflowsDir = sourceExplicit ? expandHome(values.source!) : dirs.workflowsDir
  // `--roles-dir`：binds 存在性校验用的角色库
  const rolesDir =
    values['roles-dir'] !== undefined ? expandHome(values['roles-dir']) : dirs.rolesDir

  switch (sub) {
    case 'list': {
      const workflows = await loadWorkflows(workflowsDir, { rolesDir })
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: workflows }))
        return 0
      }
      if (workflows.length === 0) {
        ctx.stdout(`工作流库为空: ${workflowsDir}（单元是 markdown 文件，直接放入即可被识别）`)
        return 0
      }
      for (const wf of workflows) {
        const errors = (wf.issues ?? []).filter((i) => i.level === 'error').length
        const tag = (wf.issues ?? []).length > 0 ? `issues(${errors}E/${wf.issues!.length - errors}W)` : 'ok'
        const binds = wf.binds.length > 0 ? wf.binds.join('+') : '—'
        ctx.stdout(`${wf.workflow}  ${wf.name}  ${wf.level}  binds=${binds}  步骤=${wf.steps.length}  ${tag}`)
      }
      ctx.stdout(`共 ${workflows.length} 个单元（数据源 ${workflowsDir}）`)
      return 0
    }

    case 'show': {
      const id = rest[0]
      if (id === undefined) {
        ctx.stderr('用法: prism workflow show <id> [--source <dir>] [--roles-dir <dir>]')
        return 1
      }
      const wf = await loadWorkflow(workflowsDir, id, { rolesDir })
      if (wf === null) {
        ctx.stderr(`错误 [not_found] ${workflowNotFoundMessage(workflowsDir, id)}`)
        return 1
      }
      if (ctx.json) {
        ctx.stdout(JSON.stringify({ ok: true, value: wf }))
        return 0
      }
      ctx.stdout(`workflow: ${wf.workflow}（${wf.name}）`)
      ctx.stdout(`level: ${wf.level}  binds: [${wf.binds.join(', ')}]  skills: [${wf.skills.join(', ')}]`)
      if (wf.sourcePath !== undefined) ctx.stdout(`source: ${wf.sourcePath}`)
      for (const issue of wf.issues ?? []) {
        ctx.stdout(`${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
      }
      ctx.stdout('--- 步骤表 ---')
      for (const step of wf.steps) {
        ctx.stdout(`#${step.order} ${step.step} [${step.owner.join('+')}] ${step.skills} | ${step.input} → ${step.output} | 判定: ${step.done} | 回流: ${step.reflow}`)
      }
      return 0
    }

    case 'validate': {
      const id = rest[0]
      // 缺省 id = 全库逐个校验（+ 库内 id 唯一性）；给出 id = 单个校验
      const loaded: Array<WorkflowDefinition | null> = id !== undefined
        ? [await loadWorkflow(workflowsDir, id, { rolesDir })]
        : await loadWorkflows(workflowsDir, { rolesDir })
      if (id !== undefined && loaded[0] === null) {
        ctx.stderr(`错误 [not_found] ${workflowNotFoundMessage(workflowsDir, id)}`)
        return 1
      }
      const items: WorkflowDefinition[] = loaded.filter((w): w is WorkflowDefinition => w !== null)
      const dup = validateWorkflowUniqueness(items)
      if (ctx.json) {
        const value: Array<{ workflow: string; ok: boolean; issues: unknown[] }> = items.map((wf) => ({
          workflow: wf.workflow,
          ok: !(wf.issues ?? []).some((issue) => issue.level === 'error'),
          issues: wf.issues ?? [],
        }))
        if (!dup.ok) value.push({ workflow: '(库)', ok: false, issues: dup.issues })
        const allOk = value.every((v) => v.ok)
        ctx.stdout(JSON.stringify({ ok: allOk, value }))
        return allOk ? 0 : 1
      }
      let failed = 0
      for (const wf of items) {
        const errors = (wf.issues ?? []).filter((issue) => issue.level === 'error')
        if (errors.length === 0) {
          const warnings = (wf.issues ?? []).length
          ctx.stdout(`校验工作流 ${wf.workflow}: 通过${warnings > 0 ? `（${warnings} 条 warning）` : ''}`)
          for (const issue of wf.issues ?? []) {
            if (issue.level === 'warning') ctx.stdout(`  WARN [${issue.code}] ${issue.message}`)
          }
        } else {
          failed++
          ctx.stdout(`校验工作流 ${wf.workflow}: 失败`)
          for (const issue of wf.issues ?? []) {
            ctx.stdout(`  ${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
          }
        }
      }
      for (const issue of dup.issues) {
        failed++
        ctx.stdout(`校验工作流库: ${issue.level === 'error' ? 'ERROR' : 'WARN'} [${issue.code}] ${issue.message}`)
      }
      return failed > 0 ? 1 : 0
    }

    case 'edit': {
      const id = rest[0]
      const file = values['steps-file']
      if (id === undefined || file === undefined) {
        ctx.stderr('用法: prism workflow edit <id> --steps-file <json|-> [--source <dir>] [--roles-dir <dir>] [--json]')
        return 1
      }
      // 写命令：--source 覆盖受管目录并解除写守卫（与 team edit 同口径）；未显式给目录 → 守卫要求 --yes
      const writeDirs = sourceExplicit ? { ...dirs, guard: { ...dirs.guard, workflows: false } } : dirs
      if (!guardWriteTarget(ctx, values, writeDirs, 'workflows', 1)) return 1
      let rawJson: string
      if (file === '-') {
        rawJson = await (ctx.readStdin ? ctx.readStdin() : readFileSync(0, 'utf-8'))
      } else {
        rawJson = readFileSync(expandHome(file), 'utf-8')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawJson)
      } catch (e) {
        ctx.stderr(`错误 [bad_request] steps-file 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
        return 1
      }
      let steps: StepSerializeRow[]
      try {
        steps = parseStepsPatch(parsed)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        ctx.stderr(`错误 [bad_request] ${msg}`)
        return 1
      }
      try {
        const result = editWorkflow({
          workflow: id,
          workflowsDir,
          patch: { steps },
          ...(rolesDir !== undefined ? { validateOptions: { roles: await loadRoles(rolesDir) } } : {}),
        })
        if (ctx.json) {
          ctx.stdout(JSON.stringify({ ok: true, value: result }))
        } else {
          ctx.stdout(`已写入 ${result.path}（mtime=${result.sourceMtime}）`)
        }
        return 0
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'workflow_write_failed'
        ctx.stderr(`错误 [${code}] ${e instanceof Error ? e.message : String(e)}`)
        return 1
      }
    }

    default:
      ctx.stderr('用法: prism workflow <list|show|validate|edit> ...')
      return 1
  }
}
