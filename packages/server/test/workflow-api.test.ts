/**
 * 工作流单元 API 测试（workflow-asset.md v1：HTTP + MCP 一文件，仿 team-workflow-api.test.ts）。
 * 红线 R5/R6：全部落临时目录（prism.yaml 显式 workflows_dir），绝不写真实宿主目录。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { createMcpTools, handleRpcRequest, type JsonRpcResponse } from '../src/mcp/server.js'

const ROLE_MD = (name: string): string => `---
name: "${name}"
description: "测试角色"
---
## 核心契约

测试用。
`

const WORKFLOW_MD = `---
workflow: demo-flow
name: 演示单元
level: role
binds:
  - dev-1
skills: []
---

# 演示单元（demo-flow）

## 步骤表

| # | 步骤 | 承接 | skill | 输入工件 | 输出工件 | 完成判定 | 回流路径 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | 装载 | dev-1 | — | tasks.md | 上下文 | 文件读完 | — |
| 2 | 执行 | dev-1 + 队长 | — | 上下文 | diff | 自测过 | 回 1 |

## 硬性约束

- 测试。
`

const BROKEN_MD = `---
workflow: broken-flow
name: 坏单元
level: role
binds:
  - ghost-role
---
# 坏单元（binds 引用不存在的角色；步骤表缺失）

只有正文。
`

describe('工作流单元 API（GET /api/workflows + MCP prism_workflow_list/get）', () => {
  let app: AppHandle
  let base: string
  let tmp: string
  let home: string
  let workflowsDir: string
  let tools: ReturnType<typeof createMcpTools>

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-workflow-api-'))
    home = join(tmp, 'home')
    workflowsDir = join(tmp, 'workflows')
    const rolesDir = join(home, 'roles')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${rolesDir.replaceAll('\\', '/')}\nworkflows_dir: ${workflowsDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    await mkdir(rolesDir, { recursive: true })
    await writeFile(join(rolesDir, 'dev-1.md'), ROLE_MD('dev-1'), 'utf-8')
    await mkdir(workflowsDir, { recursive: true })
    await writeFile(join(workflowsDir, 'demo-flow.md'), WORKFLOW_MD, 'utf-8')
    await writeFile(join(workflowsDir, 'broken-flow.md'), BROKEN_MD, 'utf-8')
    // README.md = 无 frontmatter 的文档文件：加载层必须跳过（不算单元、不算错误）
    await writeFile(join(workflowsDir, 'README.md'), '# 工作流库说明\n', 'utf-8')

    app = await startServer({ home, harnessRoot: join(tmp, 'zcode'), port: 0 })
    base = `http://127.0.0.1:${app.port}`
    tools = createMcpTools({ home, harnessRoot: join(tmp, 'zcode'), kbFactory: async () => { throw new Error('kb not used') } })
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const rpc = async (id: number, name: string, args: Record<string, unknown>): Promise<JsonRpcResponse | null | undefined> =>
    await handleRpcRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, tools)
  const rawTextOf = (r: JsonRpcResponse | null | undefined): string =>
    ((r?.result as { content?: Array<{ text: string }> } | undefined)?.content ?? [])[0]!.text
  const textOf = (r: JsonRpcResponse | null | undefined): unknown => JSON.parse(rawTextOf(r))

  it('GET /api/workflows → { workflows, workflows_dir }；README 被跳过；issues 挂载', async () => {
    const res = await fetch(`${base}/api/workflows`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; value: { workflows: Array<{ workflow: string; issues?: Array<{ code: string }> }>; workflows_dir: string } }
    expect(body.ok).toBe(true)
    expect(body.value.workflows.map((w) => w.workflow)).toEqual(['broken-flow', 'demo-flow'])
    expect(body.value.workflows_dir.replaceAll('\\', '/')).toBe(workflowsDir.replaceAll('\\', '/'))
    // 坏单元：binds 引用不存在角色 → error issue 挂载
    const broken = body.value.workflows.find((w) => w.workflow === 'broken-flow')!
    expect(broken.issues?.some((i) => i.code === 'workflow_binds_role_unknown')).toBe(true)
    // 好单元：无 issue（承接列的 dev-1 是角色、队长是豁免词）
    const demo = body.value.workflows.find((w) => w.workflow === 'demo-flow')!
    expect(demo.issues ?? []).toEqual([])
  })

  it('GET /api/workflows/:id → steps + body；不存在 → 404 not_found', async () => {
    const ok = await fetch(`${base}/api/workflows/demo-flow`)
    expect(ok.status).toBe(200)
    const value = ((await ok.json()) as { value: { steps: unknown[]; body: string; binds: string[] } }).value
    expect(value.steps).toHaveLength(2)
    expect(value.binds).toEqual(['dev-1'])
    expect(value.body).toContain('## 硬性约束')

    const miss = await fetch(`${base}/api/workflows/no-such`)
    expect(miss.status).toBe(404)
    const err = (await miss.json()) as { error: { code: string } }
    expect(err.error.code).toBe('not_found')
  })

  it('MCP prism_workflow_list → 同源列表（count/workflows/workflows_dir）', async () => {
    const r = await rpc(1, 'prism_workflow_list', {})
    expect(r?.result).toMatchObject({ isError: false })
    const value = textOf(r) as { count: number; workflows: Array<{ workflow: string }>; workflows_dir: string }
    expect(value.count).toBe(2)
    expect(value.workflows.map((w) => w.workflow)).toContain('demo-flow')
    expect(value.workflows_dir.replaceAll('\\', '/')).toBe(workflowsDir.replaceAll('\\', '/'))
  })

  it('MCP prism_workflow_get → 单元详情；缺 workflow 报错；不存在 isError', async () => {
    const missingArg = await rpc(2, 'prism_workflow_get', {})
    expect(missingArg?.result).toMatchObject({ isError: true })

    const ok = await rpc(3, 'prism_workflow_get', { workflow: 'demo-flow' })
    expect(ok?.result).toMatchObject({ isError: false })
    const value = textOf(ok) as { name: string; steps: unknown[] }
    expect(value.name).toBe('演示单元')
    expect(value.steps).toHaveLength(2)

    const miss = await rpc(4, 'prism_workflow_get', { workflow: 'no-such' })
    expect(miss?.result).toMatchObject({ isError: true })
    expect(rawTextOf(miss)).toContain('不存在')
  })

  it('workflows_dir 未显式配置时跟随 roles_dir 同级（目录联动口径）', async () => {
    // 本套件 prism.yaml 显式给 workflows_dir（防写真实宿主）；联动口径由 agents 的 dirs 测试覆盖，
    // 这里只断言响应回读的目录与配置一致——目录解析的分支覆盖见 packages/agents/test/dirs.test.ts。
    const res = await fetch(`${base}/api/workflows`)
    const body = (await res.json()) as { value: { workflows_dir: string } }
    expect(body.value.workflows_dir).toContain('workflows')
  })

  it('v2 PATCH：steps 写回 + if_match；409/400 契约', async () => {
    // 先拿详情（steps_raw + source_mtime）
    const detailRes = await fetch(`${base}/api/workflows/demo-flow`)
    const detail = (await detailRes.json()) as {
      value: { steps: Array<{ step: string; owner: string[]; reflow: string }>; steps_raw?: { rowIds: string[] }; source_mtime: number }
    }
    expect(detail.value.steps_raw?.rowIds).toEqual(['r1', 'r2'])
    const ifMatch = detail.value.source_mtime

    const steps = [
      { rowId: 'r2', step: '先执行', owner: ['dev-1'], skills: '', input: 'i', output: 'o', done: 'd', reflow: '回 1' },
      { rowId: 'r1', step: '后装载', owner: ['dev-1'], skills: '', input: 'i', output: 'o', done: 'd', reflow: '—' },
    ]
    const patch = async (body: Record<string, unknown>): Promise<{ status: number; json: unknown }> => {
      const r = await fetch(`${base}/api/workflows/demo-flow`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflows_dir: workflowsDir.replaceAll('\\', '/'), ...body }),
      })
      return { status: r.status, json: await r.json() }
    }

    // ① 旧 if_match → 409 stale_write
    const stale = await patch({ steps, if_match: ifMatch - 999999 })
    expect(stale.status).toBe(409)
    expect((stale.json as { error: { code: string } }).error.code).toBe('stale_write')

    // ② 校验失败（清空步骤）→ 400 workflow_invalid（不落盘）
    const invalid = await patch({ steps: [], if_match: ifMatch })
    expect(invalid.status).toBe(400)

    // ③ 正常写回 → 200，读回顺序翻转载荷正确
    const okRes = await patch({ steps, if_match: ifMatch })
    expect(okRes.status).toBe(200)
    const after = await fetch(`${base}/api/workflows/demo-flow`)
    const afterValue = ((await after.json()) as { value: { steps: Array<{ order: number; step: string; reflow: string }> } }).value
    expect(afterValue.steps.map((s) => s.step)).toEqual(['先执行', '后装载'])
    expect(afterValue.steps[0]!.reflow).toBe('回 1')

    // ④ 不存在 → 404；缺 steps → 400
    const miss = await fetch(`${base}/api/workflows/no-such`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps, workflows_dir: workflowsDir.replaceAll('\\', '/') }),
    })
    expect(miss.status).toBe(404)
    const empty = await patch({ if_match: 1 })
    expect(empty.status).toBe(400)
  })
})
