/**
 * v11 F2 批 B：团队工作流 API 契约（design-v11 §3，v11.1）。
 *
 * 覆盖：
 * - `GET /api/teams/:id` 增 `workflow_raw`（被编辑文件本体的原始表）/ `source_mtime` /
 *   读侧 ParseIssue 并入 `issues`（R-v11-5 / R-v11-13 / R-v11-15）；
 * - `PATCH /api/teams/:id` 的 `workflow`（结构化保存，未映射列按 rowId 合并）+ `if_match`
 *   （陈旧写 409）+ `team_patch_empty` 扩容 + prose/无 roles 不误清空（R-v11-1 / R-v11-3）；
 * - MCP `prism_team_edit` schema 同口径（R-v11-16）。
 *
 * 全部落临时目录（红线 R5/R6：测试绝不写真实宿主目录，写路径恒为显式 `teams_dir`）。
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { createMcpTools, handleRpcRequest, type JsonRpcResponse } from '../src/mcp/server.js'

const ZCODE_ROLE_MD = `---
name: dev-1
description: "开发角色：交付可运行增量，绝不扩大战场。"
color: blue
---

# 开发 1

## 核心契约
**交付可运行的增量，绝不扩大战场。**
`

/** 标准 8 列（design-v3 §7）——GET `workflow_raw` 的基准形态。 */
const STD_TEAM_MD = `---
team_id: std-team
name: 标准八列团队
description: 标准 8 列工作流。
members:
  - role: dev-1
    count: 1
---

# 标准八列团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 | 串行 | 任务书 | recon.md | 结论落盘 | — |
| 2 | 开发 | dev-1 | 并行 | recon.md | patch | 自验通过 | 卡死 → 队长 |
| 3 | 交付 | dev-1 | 串行 | 全部 | DELIVERY.md | 用户验收 | — |
`

/** 标准 8 列 + 「备注」「负责人」两个未映射列（rowId 合并的判据）。 */
const COL_TEAM_MD = `---
team_id: col-team
name: 多余列团队
description: 标准 8 列之外还有两列，结构化保存时必须按 rowId 保住。
members:
  - role: dev-1
    count: 2
  - role: tester
    count: 1
---

# 多余列团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 | 备注 | 负责人 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1/2 | 并行 | 任务书 | recon.md | 结论落盘 | 缺资料 → 补调研 | 时间盒 2 天 | 张三 |
| 2 | 测试 | tester | 串行 | patch | test-report.md | 全项有运行证据 | 缺陷 → dev 修复 | 冒烟先行 | 李四 |
| 3 | 交付 | dev-1 | 串行 | 全部 | DELIVERY.md | 用户验收 | — | 无 | 张三 |

## 备注

多余列靠 rowId 合并，不随阶段增删排序错行。
`

/** prose 工作流 + 后续小节含「阶段」普通表（R-v11-2 跨小节误命中的活体场景）。 */
const PROSE_TEAM_MD = `---
team_id: prose-team
name: 自由文本团队
description: 工作流写成说明文字，没有表格。
members:
  - role: dev-1
    count: 1
---

# 自由文本团队

## 工作流

先探索，再设计，最后交付。没有表格。

## 交付技能组合（跨小节误命中回归）

这一节的表格含「阶段 + 输出」两个核心字段。

| 阶段 | 技能 | 输出 | 备注 |
| :--- | :--- | :--- | :--- |
| 1 定方向 | frontend-design | 设计简报 | 只出简报不写码 |
`

/** 混排：段落 + 表 + 引用块 + 第二张表（B-1 写回范围红线的活体素材）。 */
const MIXED_TEAM_MD = `---
team_id: mix-team
name: 混排团队
description: 工作流小节里段落 + 表 + 引用块 + 第二张表——保存后必须逐行存活。
members:
  - role: dev-1
    count: 1
---

# 混排团队

## 工作流

本团队的工作流如下（这段说明不属于表格，保存时不得删除）：

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 | 备注 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 | 串行 | 任务书 | recon.md | 结论落盘 | — | 时间盒 |
| 2 | 交付 | 队长 | 串行 | 全部 | DELIVERY.md | 用户验收 | — | 无 |

> 补充说明：引用块也不是表格，保存必须保留。

| 阶段 | 说明 |
| :--- | :--- |
| 附 | 第二张表按正文保留 |

## 备注

下一小节正文。
`

/** 混排素材里「备注」列的两行值（列集通道的保真判据）。 */
const MIXED_NOTES = ['时间盒', '无']

/** 全文无 `## 工作流` 小节（sectionMissing 态）。 */
const NO_WF_TEAM_MD = `---
team_id: no-wf-team
name: 无工作流团队
description: 全文没有工作流小节。
members:
  - role: dev-1
    count: 1
---

# 无工作流团队

## 职责

只说职责，不写流程。
`

/** 行级降级素材：列数不齐 / `#` 非整数 / 实例记号非法——GET 不 500，issue 并入响应。 */
const RAGGED_TEAM_MD = `---
team_id: ragged-team
name: 行级降级团队
description: 行级问题降级为 issue，不炸整份文件。
members:
  - role: dev-1
    count: 1
---

# 行级降级团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 探索 | dev-1 | 串行 | 任务书 | recon.md | 结论落盘 | — |
| x | 设计 | dev-1 | 串行 | recon.md | design.md | 需求全覆盖 |
`

interface WorkflowRawShape {
  columns: string[]
  rows: string[][]
  rowIds: string[]
  unmapped: string[]
  prose: boolean
  sectionMissing: boolean
  /** v11 收口：prose 小节的原文（字符串恒存在；非 prose 为 ''）。 */
  proseText: string
}

interface TeamGetValue {
  team_id: string
  name: string
  issues: Array<{ level: string; code: string; message: string }>
  workflow_raw: WorkflowRawShape
  source_mtime: number
}

describe('v11 F2 团队工作流 API（GET workflow_raw / PATCH workflow+if_match）', () => {
  let app: AppHandle
  let base: string
  let tmp: string
  let home: string
  let teamsDir: string
  let rolesDir: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-team-wf-api-'))
    home = join(tmp, 'home')
    teamsDir = join(tmp, 'teams')
    rolesDir = join(home, 'roles')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${rolesDir.replaceAll('\\', '/')}\nteams_dir: ${teamsDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    await mkdir(join(rolesDir, 'dev-1'), { recursive: true })
    await writeFile(join(rolesDir, 'dev-1', 'AGENTS.md'), ZCODE_ROLE_MD, 'utf-8')
    await mkdir(join(rolesDir, 'tester'), { recursive: true })
    await writeFile(join(rolesDir, 'tester', 'AGENTS.md'), ZCODE_ROLE_MD.replace(/dev-1/g, 'tester'), 'utf-8')

    await mkdir(teamsDir, { recursive: true })
    await writeFile(join(teamsDir, 'std-team.md'), STD_TEAM_MD, 'utf-8')
    await writeFile(join(teamsDir, 'col-team.md'), COL_TEAM_MD, 'utf-8')
    await writeFile(join(teamsDir, 'prose-team.md'), PROSE_TEAM_MD, 'utf-8')
    await writeFile(join(teamsDir, 'no-wf-team.md'), NO_WF_TEAM_MD, 'utf-8')
    await writeFile(join(teamsDir, 'ragged-team.md'), RAGGED_TEAM_MD, 'utf-8')
    await writeFile(join(teamsDir, 'mix-team.md'), MIXED_TEAM_MD, 'utf-8')

    app = await startServer({ home, harnessRoot: join(tmp, 'zcode'), port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const getTeam = async (id: string): Promise<{ status: number; value: TeamGetValue; raw: unknown }> => {
    const res = await fetch(`${base}/api/teams/${id}`)
    const body = (await res.json()) as { ok: boolean; value: TeamGetValue }
    return { status: res.status, value: body.value, raw: body }
  }

  const send = (method: string, path: string, payload?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })

  const patch = async (id: string, payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    const res = await send('PATCH', `/api/teams/${id}`, { teams_dir: teamsDir, ...payload })
    return { status: res.status, body: (await res.json()) as unknown }
  }

  /** GET 一个团队的「编辑器提交形态」：语义 stages + 原行身份（rowId）+ 列集。 */
  const editorPayload = async (
    id: string,
  ): Promise<{ stages: Array<Record<string, unknown>>; columns: string[]; rows: string[][] }> => {
    const { value } = await getTeam(id)
    const workflow = (value as unknown as {
      workflow: Array<{ order: number; stage: string; roles: string[]; mode: string; input: string; output: string; done: string; reflow: string }>
    }).workflow
    const raw = value.workflow_raw
    return {
      stages: workflow.map((stage, index) => ({ rowId: raw.rowIds[index], ...stage })),
      columns: raw.columns,
      rows: raw.rows,
    }
  }

  it('GET 标准 8 列：workflow_raw 逐字段（columns/rows/rowIds 长度一致、unmapped 空）+ source_mtime 为正整数', async () => {
    const { status, value } = await getTeam('std-team')
    expect(status).toBe(200)
    expect(value.workflow_raw.columns).toEqual([
      '#',
      '阶段',
      '负责角色',
      '串/并行',
      '输入',
      '输出',
      '完成判定',
      '回流路径',
    ])
    expect(value.workflow_raw.rows).toHaveLength(3)
    expect(value.workflow_raw.rowIds).toEqual(['r1', 'r2', 'r3'])
    expect(value.workflow_raw.rows.every((row) => row.length === value.workflow_raw.columns.length)).toBe(true)
    expect(value.workflow_raw.unmapped).toEqual([])
    expect(value.workflow_raw.prose).toBe(false)
    expect(value.workflow_raw.sectionMissing).toBe(false)
    // 表格态：proseText 恒为空串（字段恒存在，前端免判 undefined）
    expect(value.workflow_raw.proseText).toBe('')
    expect(Number.isInteger(value.source_mtime)).toBe(true)
    expect(value.source_mtime).toBeGreaterThan(0)
    expect(Array.isArray(value.issues)).toBe(true)
    // 列表路由**不**加 workflow_raw（按需拉取，省列表开销）
    const list = await fetch(`${base}/api/teams`)
    const listBody = (await list.json()) as { value: { teams: Array<Record<string, unknown>> } }
    expect(listBody.value.teams.every((t) => !('workflow_raw' in t))).toBe(true)
  })

  it('GET prose 团队 → prose:true、columns 空；后续小节的「阶段」表不被误吞（R-v11-2）', async () => {
    const { value } = await getTeam('prose-team')
    expect(value.workflow_raw.prose).toBe(true)
    expect(value.workflow_raw.sectionMissing).toBe(false)
    expect(value.workflow_raw.columns).toEqual([])
    expect(value.workflow_raw.rows).toEqual([])
    expect(value.workflow_raw.rowIds).toEqual([])
    // 小节原文（标题行之后到下一个 `## ` 标题之前，去首尾空行）
    expect(value.workflow_raw.proseText).toBe('先探索，再设计，最后交付。没有表格。')
    // 误命中会给出 3 个语义阶段——这里必须是 0
    expect((value as unknown as { workflow: unknown[] }).workflow).toEqual([])
  })

  it('GET 无 `## 工作流` 小节 → sectionMissing:true（与 prose 两态区分）', async () => {
    const { value } = await getTeam('no-wf-team')
    expect(value.workflow_raw.sectionMissing).toBe(true)
    expect(value.workflow_raw.prose).toBe(false)
    expect(value.workflow_raw.columns).toEqual([])
    expect(value.workflow_raw.proseText).toBe('')
  })

  it('GET 行级问题 → 不 500，ParseIssue 以 warning 并入 issues（R-v11-5）', async () => {
    const { value } = await getTeam('ragged-team')
    expect(value.workflow_raw.rows).toHaveLength(2)
    const issue = value.issues.find((i) => i.code === 'workflow_order_defaulted')
    expect(issue).toBeDefined()
    expect(issue?.level).toBe('warning')
    expect(issue?.message).toContain('2') // 行号进 message
  })

  it('GET 不存在 → 仍为 not_found（不因新增字段而变码）', async () => {
    const res = await fetch(`${base}/api/teams/ghost-team`)
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
  })

  it('PATCH workflow-only（改序 + 改名）：未映射列按 rowId 随行不错位；响应回新 source_mtime', async () => {
    const before = await getTeam('col-team')
    const ids = before.value.workflow_raw.rowIds
    expect(ids).toEqual(['r1', 'r2', 'r3'])

    const stages = [
      { rowId: ids[2], order: 1, stage: '交付', roles: ['dev-1'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '' },
      { rowId: ids[0], order: 2, stage: '探索改', roles: ['dev-1'], mode: 'parallel', input: 'i', output: 'o', done: 'd', reflow: '' },
      { rowId: ids[1], order: 3, stage: '测试', roles: ['tester'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '' },
    ]
    const res = await patch('col-team', { workflow: { stages } })
    expect(res.status).toBe(200)
    const patched = res.body as { value: { path: string; issues: unknown[]; source_mtime: number } }
    expect(patched.value.source_mtime).toBeGreaterThan(before.value.source_mtime)
    expect(Array.isArray(patched.value.issues)).toBe(true)

    const after = await getTeam('col-team')
    expect(after.value.workflow_raw.columns).toEqual([
      '#',
      '阶段',
      '负责角色',
      '串/并行',
      '输入',
      '输出',
      '完成判定',
      '回流路径',
      '备注',
      '负责人',
    ])
    expect(after.value.workflow_raw.unmapped).toEqual(['备注', '负责人'])
    // workflow-only PATCH 响应回的新 mtime = 随后 GET 的 mtime（客户端可直接续用为 if_match）
    expect(after.value.source_mtime).toBe(patched.value.source_mtime)

    const noteIndex = after.value.workflow_raw.columns.indexOf('备注')
    const ownerIndex = after.value.workflow_raw.columns.indexOf('负责人')
    const stagesOrder = after.value.workflow_raw.rows.map((row) => row[1])
    expect(stagesOrder).toEqual(['交付', '探索改', '测试'])
    expect(after.value.workflow_raw.rows.map((row) => row[noteIndex])).toEqual(['无', '时间盒 2 天', '冒烟先行'])
    expect(after.value.workflow_raw.rows.map((row) => row[ownerIndex])).toEqual(['张三', '张三', '李四'])
  })

  it('PATCH workflow-only 不再触发 team_patch_empty；真正空补丁仍 400（守卫扩容）', async () => {
    const empty = await patch('std-team', {})
    expect(empty.status).toBe(400)
    expect(JSON.stringify(empty.body)).toContain('team_patch_empty')
  })

  it('PATCH workflow 形状非法 → 400（stages 非数组 / 缺 stage / mode 越界）', async () => {
    const bad1 = await patch('col-team', { workflow: { stages: 'nope' } })
    expect(bad1.status).toBe(400)
    const bad2 = await patch('col-team', { workflow: { stages: [{ order: 1 }] } })
    expect(bad2.status).toBe(400)
    const bad3 = await patch('col-team', { workflow: { stages: [{ order: '1', stage: 'x' }] } })
    expect(bad3.status).toBe(400)
    const bad4 = await patch('col-team', { workflow: { stages: [{ order: 1, stage: 'x', mode: 'both' }] } })
    expect(bad4.status).toBe(400)
    const bad5 = await patch('col-team', { workflow: {} })
    expect(bad5.status).toBe(400)
  })

  it('PATCH members-only（prose 团队）→ 工作流正文原样保留 + workflow_narrow_skipped（R-v11-1 不误清空）', async () => {
    const before = await readFile(join(teamsDir, 'prose-team.md'), 'utf-8')
    const res = await patch('prose-team', { members: [{ role: 'dev-1', count: 1 }], roles_dir: rolesDir })
    expect(res.status).toBe(200)
    const value = res.body as { value: { issues: Array<{ level: string; code: string }> } }
    const skipped = value.value.issues.find((i) => i.code === 'workflow_narrow_skipped')
    expect(skipped).toBeDefined()
    expect(skipped?.level).toBe('warning')
    expect(value.value.issues.map((i) => i.code)).not.toContain('workflow_pruned')

    const after = await readFile(join(teamsDir, 'prose-team.md'), 'utf-8')
    expect(after).toContain('先探索，再设计，最后交付。没有表格。')
    expect(after).toContain('frontend-design')
    expect(after).toContain('## 交付技能组合（跨小节误命中回归）')
    expect(before).toContain('team_id: prose-team')
  })

  it('PATCH members + workflow 同给 → workflow 胜（不收窄）+ workflow_narrow_skipped', async () => {
    const before = await getTeam('col-team')
    const ids = before.value.workflow_raw.rowIds
    const stages = [
      { rowId: ids[0], order: 1, stage: '探索', roles: ['dev-1'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '' },
      { rowId: ids[1], order: 2, stage: '测试', roles: ['tester'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '' },
      { rowId: ids[2], order: 3, stage: '交付', roles: ['dev-1'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '' },
    ]
    const res = await patch('col-team', {
      members: [{ role: 'dev-1', count: 1 }],
      roles_dir: rolesDir,
      workflow: { stages },
    })
    expect(res.status).toBe(200)
    const value = res.body as { value: { issues: Array<{ code: string }> } }
    expect(value.value.issues.map((i) => i.code)).toContain('workflow_narrow_skipped')
    expect(value.value.issues.map((i) => i.code)).not.toContain('workflow_pruned')

    // 名册已改（tester 移除），但 workflow 以提交为准 → tester 阶段仍在
    const md = await readFile(join(teamsDir, 'col-team.md'), 'utf-8')
    expect(md).toContain('- role: dev-1')
    expect(md).not.toContain('- role: tester')
    const after = await getTeam('col-team')
    expect(after.value.workflow_raw.rows.map((row) => row[1])).toEqual(['探索', '测试', '交付'])
    expect(after.value.workflow_raw.rows.map((row) => row[2])).toEqual(['dev-1', 'tester', 'dev-1'])
  })

  it('PATCH if_match：不匹配 → 409 stale_write 且不落盘；匹配 → 200', async () => {
    const before = await getTeam('std-team')
    const stale = await patch('std-team', { name: '不该写', if_match: 1 })
    expect(stale.status).toBe(409)
    expect(JSON.stringify(stale.body)).toContain('stale_write')
    expect(await readFile(join(teamsDir, 'std-team.md'), 'utf-8')).not.toContain('不该写')

    const ok = await patch('std-team', { name: '陈旧写通过', if_match: before.value.source_mtime })
    expect(ok.status).toBe(200)
    const value = ok.body as { value: { issues: unknown[]; source_mtime: number } }
    expect(value.value.source_mtime).toBeGreaterThan(0)
    // frontmatter 由 agents 渲染器重排（中文值加引号）——断言语义值，不断言引号形态
    const saved = await readFile(join(teamsDir, 'std-team.md'), 'utf-8')
    expect(saved).toContain('陈旧写通过')
    expect(saved).not.toContain('不该写')

    // 再拿旧 mtime → 409（写后 mtime 已变）
    const again = await patch('std-team', { name: '再来一次', if_match: before.value.source_mtime })
    expect(again.status).toBe(409)

    // if_match 非整数 → 400（不静默忽略防护）
    const badIfMatch = await patch('std-team', { name: 'x', if_match: '1758096000000' })
    expect(badIfMatch.status).toBe(400)
    expect(JSON.stringify(badIfMatch.body)).toContain('if_match_invalid')
  })

  it('PATCH workflow 到无小节团队 → 400 workflow_section_missing（不自动插小节）', async () => {
    const res = await patch('no-wf-team', {
      workflow: {
        stages: [
          { order: 1, stage: '探索', roles: ['dev-1'], mode: 'serial', input: '', output: '', done: '', reflow: '' },
        ],
      },
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('workflow_section_missing')
    expect(await readFile(join(teamsDir, 'no-wf-team.md'), 'utf-8')).not.toContain('## 工作流')
  })

  it('PATCH workflow: { stages: [] } → 清空表格但保留小节（编辑器所见即所存）', async () => {
    const res = await patch('no-wf-team', { name: '占位', workflow: { stages: [] } })
    expect(res.status).toBe(400) // 无小节 → 仍报缺小节（不因空数组放行）
    expect(JSON.stringify(res.body)).toContain('workflow_section_missing')
  })

  it('PATCH 目录形态团队（<id>/AGENTS.md）可保存（P0-5 在 HTTP 面同样成立）', async () => {
    await mkdir(join(teamsDir, 'dir-team'), { recursive: true })
    await writeFile(join(teamsDir, 'dir-team', 'AGENTS.md'), STD_TEAM_MD.replaceAll('std-team', 'dir-team'), 'utf-8')
    const res = await patch('dir-team', { description: '目录形态改述' })
    expect(res.status).toBe(200)
    const md = await readFile(join(teamsDir, 'dir-team', 'AGENTS.md'), 'utf-8')
    expect(md).toContain('目录形态改述')
    expect(existsSync(join(teamsDir, 'dir-team.md'))).toBe(false)
  })

  it('B-1：PATCH workflow 只换表格区——段落 / 引用块 / 第二张表 逐行存活 + issues 透传', async () => {
    const { stages, columns } = await editorPayload('mix-team')
    const res = await patch('mix-team', { workflow: { stages, columns } })
    expect(res.status).toBe(200)
    const value = res.body as { value: { issues: Array<{ code: string; level: string }> } }
    // 读侧 issue 透传（旧实现 workflow 分支 issues 恒空，删正文却零诊断）
    expect(value.value.issues.map((i) => i.code)).toContain('workflow_multiple_tables')

    const md = await readFile(join(teamsDir, 'mix-team.md'), 'utf-8')
    expect(md).toContain('本团队的工作流如下（这段说明不属于表格，保存时不得删除）：')
    expect(md).toContain('> 补充说明：引用块也不是表格，保存必须保留。')
    expect(md).toContain('| 附 | 第二张表按正文保留 |')
    expect(md).toContain('下一小节正文。')
  })

  it('M-2：PATCH workflow.columns 增列带值落盘 / 列序调整值按名随列 / 删列生效（M-13）', async () => {
    const { stages, columns } = await editorPayload('mix-team')
    const owners = ['张三', '李四']

    // 增自定义列「负责人」并填值
    const withOwner = stages.map((stage, index) => ({ ...stage, extra: { 负责人: owners[index] } }))
    expect((await patch('mix-team', { workflow: { stages: withOwner, columns: [...columns, '负责人'] } })).status).toBe(200)
    const added = await getTeam('mix-team')
    expect(added.value.workflow_raw.columns).toEqual([...columns, '负责人'])
    expect(added.value.workflow_raw.rows.map((row) => row[added.value.workflow_raw.columns.indexOf('负责人')])).toEqual(owners)
    // 原未映射列「备注」仍在（按名回落）
    expect(added.value.workflow_raw.rows.map((row) => row[added.value.workflow_raw.columns.indexOf('备注')])).toEqual(MIXED_NOTES)

    // 列序调整：「负责人」插到「备注」之前 → 值按名随列（M-13 按位置寻址即错位）
    const reordered = [...columns.slice(0, 8), '负责人', '备注']
    expect((await patch('mix-team', { workflow: { stages: withOwner, columns: reordered } })).status).toBe(200)
    const re = await getTeam('mix-team')
    expect(re.value.workflow_raw.columns).toEqual(reordered)
    expect(re.value.workflow_raw.rows.map((row) => row[re.value.workflow_raw.columns.indexOf('负责人')])).toEqual(owners)
    expect(re.value.workflow_raw.rows.map((row) => row[re.value.workflow_raw.columns.indexOf('备注')])).toEqual(MIXED_NOTES)

    // 删列：提交原始列集 → 「负责人」连同其值消失
    expect((await patch('mix-team', { workflow: { stages, columns } })).status).toBe(200)
    const dropped = await getTeam('mix-team')
    expect(dropped.value.workflow_raw.columns).toEqual(columns)
    expect(JSON.stringify(dropped.value.workflow_raw)).not.toContain('张三')
  })

  it('M-2：PATCH workflow.columns 非法（空数组 / 重复 / 非字符串 / 空白名）→ 400 workflow_invalid', async () => {
    const { stages } = await editorPayload('mix-team')
    for (const columns of [[], ['阶段', '阶段'], ['阶段', 1], ['阶段', '  ']]) {
      const res = await patch('mix-team', { workflow: { stages, columns } })
      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body)).toContain('workflow_invalid')
    }
  })
})

describe('v11 收口：POST /api/teams 接收 workflow（结构化新建）', () => {
  let app: AppHandle
  let base: string
  let tmp: string
  let home: string
  let teamsDir: string
  let rolesDir: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-team-post-wf-'))
    home = join(tmp, 'home')
    teamsDir = join(tmp, 'teams')
    rolesDir = join(home, 'roles')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${rolesDir.replaceAll('\\', '/')}\nteams_dir: ${teamsDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    await mkdir(join(rolesDir, 'dev-1'), { recursive: true })
    await writeFile(join(rolesDir, 'dev-1', 'AGENTS.md'), ZCODE_ROLE_MD, 'utf-8')
    await mkdir(join(rolesDir, 'tester'), { recursive: true })
    await writeFile(join(rolesDir, 'tester', 'AGENTS.md'), ZCODE_ROLE_MD.replace(/dev-1/g, 'tester'), 'utf-8')
    await mkdir(teamsDir, { recursive: true })
    app = await startServer({ home, harnessRoot: join(tmp, 'zcode'), port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const post = async (payload: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${base}/api/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: (await res.json()) as unknown }
  }

  const getWorkflow = async (id: string): Promise<Array<{ stage: string }>> => {
    const res = await fetch(`${base}/api/teams/${id}`)
    const body = (await res.json()) as { value: { workflow: Array<{ stage: string }> } }
    return body.value.workflow
  }

  /** 模板自带的 3 行（用于「已替换 / 原样」的判据）。 */
  const TEMPLATE_ROWS = ['| 1 | 开发 | dev-1 |', '| 2 | 测试 | tester |', '| 3 | 收口 | 队长 |']

  it('带 workflow.stages → 落盘序列化表格且 stages 正确（模板行全换为提交行）', async () => {
    const res = await post({
      team_id: 'wf-team',
      name: '结构化新建',
      members: [
        { role: 'dev-1', count: 1 },
        { role: 'tester', count: 1 },
      ],
      teams_dir: teamsDir,
      workflow: {
        stages: [
          { order: 1, stage: '探索', roles: ['dev-1'], mode: 'parallel', input: '任务书', output: 'recon.md', done: '结论落盘', reflow: '' },
          { order: 2, stage: '交付', roles: ['dev-1', 'tester'], mode: 'serial', input: '全部', output: 'DELIVERY.md', done: '用户验收', reflow: '超范围 → 返工' },
        ],
      },
    })
    expect(res.status).toBe(200)
    const md = await readFile(join(teamsDir, 'wf-team.md'), 'utf-8')
    expect(md).toContain('| 1 | 探索 | dev-1 | 并行 | 任务书 | recon.md | 结论落盘 |  |')
    expect(md).toContain('| 2 | 交付 | dev-1 + tester | 串行 | 全部 | DELIVERY.md | 用户验收 | 超范围 → 返工 |')
    for (const row of TEMPLATE_ROWS) expect(md).not.toContain(row)
    // 语义回读：3 行模板已被 2 行提交替换
    expect((await getWorkflow('wf-team')).map((s) => s.stage)).toEqual(['探索', '交付'])
  })

  it('stages: [] → 保留 `## 工作流` 但空表（模板数据行全清）', async () => {
    const res = await post({
      team_id: 'empty-wf',
      members: [
        { role: 'dev-1', count: 1 },
        { role: 'tester', count: 1 },
      ],
      teams_dir: teamsDir,
      workflow: { stages: [] },
    })
    expect(res.status).toBe(200)
    const md = await readFile(join(teamsDir, 'empty-wf.md'), 'utf-8')
    expect(md).toContain('## 工作流')
    expect(md).toContain('| # | 阶段 | 负责角色 |')
    for (const row of TEMPLATE_ROWS) expect(md).not.toContain(row)
    expect(await getWorkflow('empty-wf')).toEqual([])
  })

  it('非法 workflow → 400 workflow_invalid 且不落盘', async () => {
    const bad = await post({
      team_id: 'bad-wf',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: teamsDir,
      workflow: { stages: [{ order: 1 }] },
    })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain('workflow_invalid')
    expect(existsSync(join(teamsDir, 'bad-wf.md'))).toBe(false)

    const bad2 = await post({
      team_id: 'bad-wf2',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: teamsDir,
      workflow: {},
    })
    expect(bad2.status).toBe(400)
    expect(JSON.stringify(bad2.body)).toContain('workflow_invalid')
    expect(existsSync(join(teamsDir, 'bad-wf2.md'))).toBe(false)
  })

  it('不带 workflow → 模板工作流原样（回归：产物不受新增分支影响）', async () => {
    const res = await post({
      team_id: 'plain-wf',
      members: [
        { role: 'dev-1', count: 1 },
        { role: 'tester', count: 1 },
      ],
      teams_dir: teamsDir,
    })
    expect(res.status).toBe(200)
    const md = await readFile(join(teamsDir, 'plain-wf.md'), 'utf-8')
    for (const row of TEMPLATE_ROWS) expect(md).toContain(row)
    expect((await getWorkflow('plain-wf')).map((s) => s.stage)).toEqual(['开发', '测试', '收口'])
  })

  it('workflow.columns（POST 与 PATCH 同口径）：自定义列带值落盘（M-2）', async () => {
    const res = await post({
      team_id: 'wf-cols',
      members: [
        { role: 'dev-1', count: 1 },
        { role: 'tester', count: 1 },
      ],
      teams_dir: teamsDir,
      workflow: {
        columns: ['#', '阶段', '负责角色', '串/并行', '输入', '输出', '完成判定', '回流路径', '负责人'],
        stages: [
          { order: 1, stage: '探索', roles: ['dev-1'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '', extra: { 负责人: '张三' } },
        ],
      },
    })
    expect(res.status).toBe(200)
    const md = await readFile(join(teamsDir, 'wf-cols.md'), 'utf-8')
    expect(md).toContain('| 负责人 |')
    expect(md).toContain('张三')

    const detail = await fetch(`${base}/api/teams/wf-cols`)
    const body = (await detail.json()) as { value: { workflow_raw: { columns: string[]; rows: string[][] } } }
    const ownerIndex = body.value.workflow_raw.columns.indexOf('负责人')
    expect(ownerIndex).toBeGreaterThan(-1)
    expect(body.value.workflow_raw.rows.map((row) => row[ownerIndex])).toEqual(['张三'])
  })
})

describe('MCP prism_team_edit：workflow / if_match 同口径（R-v11-16）', () => {
  let tmp: string
  let home: string
  let teamsDir: string
  let rolesDir: string
  let tools: ReturnType<typeof createMcpTools>

  const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({
    jsonrpc: '2.0' as const,
    id,
    method,
    ...(params === undefined ? {} : { params }),
  })
  const textOf = (response: JsonRpcResponse | null): string =>
    ((response?.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? '')

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-mcp-team-wf-'))
    home = join(tmp, 'home')
    teamsDir = join(tmp, 'teams')
    rolesDir = join(home, 'roles')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${rolesDir.replaceAll('\\', '/')}\nteams_dir: ${teamsDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    await mkdir(join(rolesDir, 'dev-1'), { recursive: true })
    await writeFile(join(rolesDir, 'dev-1', 'AGENTS.md'), ZCODE_ROLE_MD, 'utf-8')
    await mkdir(teamsDir, { recursive: true })
    await writeFile(join(teamsDir, 'std-team.md'), STD_TEAM_MD, 'utf-8')
    tools = createMcpTools({
      home,
      harnessRoot: join(tmp, 'zcode'),
      kbFactory: async () => {
        throw new Error('本测试不消费 kb')
      },
    })
  })

  afterAll(async () => {
    tools.close?.()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const call = async (name: string, args: Record<string, unknown>): Promise<JsonRpcResponse | null> =>
    await handleRpcRequest(rpc(900, 'tools/call', { name, arguments: args }), tools)

  it('inputSchema 增 workflow / if_match（且仍为可选参数）；workflow 增 columns（M-2/M-3）', () => {
    const edit = tools.find((tool) => tool.name === 'prism_team_edit')
    expect(edit).toBeDefined()
    const schema = edit?.inputSchema as { properties: Record<string, unknown>; required?: string[] }
    expect(Object.keys(schema.properties)).toContain('workflow')
    expect(Object.keys(schema.properties)).toContain('if_match')
    expect(schema.required).toEqual(['team_id', 'teams_dir'])
    expect(edit?.description ?? '').toContain('workflow')
    const workflow = schema.properties['workflow'] as { properties?: Record<string, unknown> }
    expect(Object.keys(workflow.properties ?? {})).toContain('columns')
  })

  it('prism_team_get 响应含 workflow_raw.rowIds + source_mtime（M-3：schema 前置可取）', async () => {
    const res = await call('prism_team_get', { team_id: 'std-team' })
    expect(res?.result).toMatchObject({ isError: false })
    const value = JSON.parse(textOf(res)) as {
      workflow_raw: { rowIds: string[]; columns: string[]; prose: boolean; sectionMissing: boolean; proseText: string }
      source_mtime: number
      issues: Array<{ level: string; code: string }>
    }
    expect(value.workflow_raw.rowIds).toEqual(['r1', 'r2', 'r3'])
    expect(value.workflow_raw.columns).toHaveLength(8)
    expect(value.workflow_raw.prose).toBe(false)
    expect(value.workflow_raw.sectionMissing).toBe(false)
    expect(value.workflow_raw.proseText).toBe('')
    expect(Number.isInteger(value.source_mtime)).toBe(true)
    expect(value.source_mtime).toBeGreaterThan(0)
    expect(Array.isArray(value.issues)).toBe(true)
  })

  it('prism_team_new schema 亦增 workflow（v11 收口），workflow_template 语义不变', () => {
    const created = tools.find((tool) => tool.name === 'prism_team_new')
    expect(created).toBeDefined()
    const schema = created?.inputSchema as {
      properties: Record<string, { required?: string[] }>
      required?: string[]
    }
    expect(Object.keys(schema.properties)).toContain('workflow')
    expect(schema.properties['workflow']?.required).toEqual(['stages'])
    // workflow_template 未被替换（枚举与语义一字不动）
    expect(schema.properties['workflow_template']).toMatchObject({ enum: ['minimal', 'core-dev'] })
    expect(schema.required).toEqual(['team_id', 'members', 'teams_dir'])
  })

  it('tools/call 带 workflow → 结构化写回；带陈旧 if_match → isError stale_write', async () => {
    const res = await call('prism_team_edit', {
      team_id: 'std-team',
      teams_dir: teamsDir,
      workflow: {
        stages: [
          { order: 1, stage: '探索', roles: ['dev-1'], mode: 'serial', input: 'i', output: 'o', done: 'd', reflow: '' },
        ],
      },
    })
    expect(res?.result).toMatchObject({ isError: false })
    const md = await readFile(join(teamsDir, 'std-team.md'), 'utf-8')
    expect(md).toContain('| 1 | 探索 | dev-1 | 串行 |')
    expect(md).not.toContain('| 3 | 交付 |')

    const stale = await call('prism_team_edit', {
      team_id: 'std-team',
      teams_dir: teamsDir,
      name: '不该写',
      if_match: 1,
    })
    expect(stale?.result).toMatchObject({ isError: true })
    expect(textOf(stale)).toContain('stale_write')
  })
})
