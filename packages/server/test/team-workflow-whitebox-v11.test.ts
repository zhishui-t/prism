/**
 * v11 白盒补测（tester-whitebox）：spec-verify-matrix-v11 的缺口项（HTTP 面）。
 *
 * - W-6（矩阵 M-D3）：`GET /api/teams` **列表**响应不含 `workflow_raw` / `source_mtime`
 *   （v11-backend-report §0 冻结节：「列表 GET 不加 workflow_raw」——既有测试只锁单团队 GET）。
 * - W-7 / W-8（矩阵 M-D4）：`workflow_raw` 取**被编辑文件本体**、**不经 extends 合并**
 *   （design-v11 §3）。父级有标准表、子文件 prose → GET 的 `team.workflow` 是合并结果
 *   （父级阶段胜出，M-6 既有语义），而 `workflow_raw.prose/proseText` 必须反映**子文件**
 *   ——两者同响应不同源，正是「编辑器底账不能拿合并结果顶替」的契约锁。
 *
 * 全部落临时目录（红线 R5/R6）；复用 team-workflow-api.test.ts 的自建 server 手法。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'

const ZCODE_ROLE_MD = `---
name: dev-1
description: "开发角色：交付可运行增量，绝不扩大战场。"
color: blue
---

# 开发 1
`

const PARENT_TEAM_MD = `---
team_id: parent-team
name: 父级团队
description: 有标准 8 列工作流的父团队。
members:
  - role: dev-1
    count: 1
---

# 父级团队

## 工作流

| # | 阶段 | 负责角色 | 串/并行 | 输入 | 输出 | 完成判定 | 回流路径 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 父级阶段甲 | dev-1 | 串行 | 任务书 | recon.md | 结论落盘 | — |
| 2 | 父级阶段乙 | dev-1 | 串行 | recon.md | design.md | 需求全覆盖 | — |
`

/** 子团队：extends 父级，**自身工作流是 prose**（无表格）。 */
const CHILD_PROSE_TEAM_MD = `---
team_id: child-team
name: 子级团队
description: 继承父级，工作流自己写成自由文本。
extends: parent-team
members:
  - role: dev-1
    count: 1
---

# 子级团队

## 工作流

子级自己的自由文本工作流：先探索，再交付。

## 备注

子级还有别的小节。
`

describe('v11 白盒补测：GET 列表契约 + extends 团队 workflow_raw 本体 sourced', () => {
  let app: AppHandle
  let base: string
  let tmp: string
  let teamsDir: string
  let rolesDir: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-team-wf-wb-'))
    const home = join(tmp, 'home')
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
    await writeFile(join(teamsDir, 'parent-team.md'), PARENT_TEAM_MD, 'utf-8')
    await writeFile(join(teamsDir, 'child-team.md'), CHILD_PROSE_TEAM_MD, 'utf-8')

    app = await startServer({ home, harnessRoot: join(tmp, 'zcode'), port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('W-6：GET /api/teams 列表项不含 workflow_raw / source_mtime（冻结节：列表不加）', async () => {
    const res = await fetch(`${base}/api/teams`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; value: { teams: Record<string, unknown>[] } }
    expect(body.value.teams.length).toBeGreaterThanOrEqual(2)
    for (const team of body.value.teams) {
      expect(team).not.toHaveProperty('workflow_raw')
      expect(team).not.toHaveProperty('source_mtime')
    }
  })

  it('W-7：extends 子团队 GET——team.workflow 是合并结果（父级阶段），workflow_raw 是子文件本体（prose）', async () => {
    const res = await fetch(`${base}/api/teams/child-team`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      value: {
        workflow: Array<{ stage: string }>
        workflow_raw: { columns: string[]; prose: boolean; sectionMissing: boolean; proseText: string; rowIds: string[] }
        source_mtime: number
      }
    }
    const { value } = body
    // 合并结果（M-6 既有语义：父级的表恒胜出——declared 永不含 workflow）
    expect(value.workflow.map((s) => s.stage)).toEqual(['父级阶段甲', '父级阶段乙'])
    // workflow_raw = 子文件本体：prose 态 + 子级原文，**不是**父级的表
    expect(value.workflow_raw.prose).toBe(true)
    expect(value.workflow_raw.columns).toEqual([])
    expect(value.workflow_raw.rowIds).toEqual([])
    expect(value.workflow_raw.proseText).toBe('子级自己的自由文本工作流：先探索，再交付。')
    expect(value.source_mtime).toBeGreaterThan(0)
  })

  it('W-8：父团队自己 GET——workflow_raw 是父级的表（两文件互不串）', async () => {
    const res = await fetch(`${base}/api/teams/parent-team`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      value: { workflow_raw: { columns: string[]; prose: boolean; proseText: string } }
    }
    expect(body.value.workflow_raw.prose).toBe(false)
    expect(body.value.workflow_raw.columns[0]).toBe('#')
    expect(body.value.workflow_raw.columns[1]).toBe('阶段')
    expect(body.value.workflow_raw.proseText).toBe('')
  })
})
