/**
 * v9 F3 回收站**服务端两个面**的契约测试（全部临时目录，红线 R5/R6）：
 *
 * - `GET /api/trash`：响应 **snake_case 逐字段冻结**（`id/kind/name/deleted_at/original_paths/broken`）
 *   + `?kind=` 过滤（design-v9 §3 / G-2）；
 * - `DELETE /api/roles/:name` / `DELETE /api/teams/:id` / `POST /api/skills/uninstall`
 *   三个删除入口把本体**搬进回收站**（原位置消失、trash 出现单元、meta 受管根正确、
 *   返回体含 trash_id），审计 `trash.put` 的 trigger = HTTP；
 * - MCP `prism_role_rm` 同口径（trigger = MCP）；
 * - `createApp({ trashSweep })` 开关：默认**关**（零定时器副作用），打开才在启动时清到期单元。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditLog, TrashStore } from '@prism/core'

import { createApp, startServer, type AppHandle } from '../src/app.js'
import { createMcpTools, handleRpcRequest, type JsonRpcResponse, type McpTool } from '../src/mcp/server.js'

const ROLE_MD = `---
name: dev-1
description: "开发角色：交付可运行增量。"
color: blue
---

# 开发 1

## 核心契约
**交付可运行的增量。**
`

/** 造一个「很久以前删除」的回收站单元（用于 sweep 到期断言）；返回单元 id。 */
async function seedExpiredUnit(trashDir: string, managedRoot: string, name: string): Promise<string> {
  const unitName = '20200101-000000-' + name
  const unitDir = join(trashDir, 'role', unitName)
  await mkdir(unitDir, { recursive: true })
  await writeFile(
    join(unitDir, 'trash-meta.json'),
    JSON.stringify(
      {
        original_paths: [join(managedRoot, `${name}.md`)],
        managed_root: managedRoot,
        deleted_at: new Date('2020-01-01T00:00:00.000Z').toISOString(),
        trigger: 'CLI',
      },
      null,
      2,
    ),
    'utf-8',
  )
  return `role/${unitName}`
}

function textOf(response: JsonRpcResponse | null): string {
  const content = (response?.result as { content?: Array<{ text?: string }> } | undefined)?.content
  return content?.[0]?.text ?? ''
}

describe('v9 F3：HTTP 三入口 + GET /api/trash（回收站）', () => {
  let tmp: string
  let home: string
  let rolesDir: string
  let teamsDir: string
  let app: AppHandle
  let base: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-trash-surface-'))
    home = join(tmp, 'home')
    rolesDir = join(tmp, 'managed-roles')
    teamsDir = join(tmp, 'managed-teams')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\nteams_dir: ${join(home, 'teams').replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    // 角色库（team new 校验成员存在用）
    await mkdir(join(home, 'roles', 'dev-1'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1', 'AGENTS.md'), ROLE_MD, 'utf-8')
    app = await startServer({ home, harnessRoot: join(tmp, 'zcode'), port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterEach(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const send = (method: string, path: string, payload?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })

  const trashStore = (): TrashStore => new TrashStore({ trashDir: join(home, 'trash') })

  it('DELETE /api/roles/:name → 整目录形态也搬净（无残目录）+ 返回 trash_id + 审计 trigger=HTTP', async () => {
    // 目录形态：只搬 AGENTS.md 会留残目录（v9.1 D-1 的验收点）
    await mkdir(join(rolesDir, 'dir-role'), { recursive: true })
    await writeFile(join(rolesDir, 'dir-role', 'AGENTS.md'), ROLE_MD, 'utf-8')
    await writeFile(join(rolesDir, 'dir-role', 'notes.md'), '# 附带\n', 'utf-8')

    const res = await send('DELETE', '/api/roles/dir-role', { roles_dir: rolesDir })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { value: { removed: string[]; trash_id: string } }
    expect(body.value.removed).toEqual([join(rolesDir, 'dir-role')])
    expect(body.value.trash_id.startsWith('role/')).toBe(true)
    expect(existsSync(join(rolesDir, 'dir-role'))).toBe(false)
    expect(existsSync(rolesDir)).toBe(true)

    const unit = (await trashStore().list('role')).find((u) => u.id === body.value.trash_id)
    expect(unit).toMatchObject({
      kind: 'role',
      name: 'dir-role',
      originalPaths: [join(rolesDir, 'dir-role')],
      managedRoot: rolesDir,
      broken: false,
    })

    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      kind: 'role',
      unit_id: body.value.trash_id,
      trigger: 'HTTP',
      paths: [join(rolesDir, 'dir-role')],
    })
  })

  it('DELETE /api/teams/:id → 搬进回收站（kind=team，受管根 = 请求里的 teams_dir）', async () => {
    const created = await send('POST', '/api/teams', {
      team_id: 'trash-team',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: teamsDir,
    })
    expect(created.status).toBe(200)

    const res = await send('DELETE', '/api/teams/trash-team', { teams_dir: teamsDir })
    const body = (await res.json()) as { value: { removed: string[]; trash_id: string } }
    expect(res.status).toBe(200)
    expect(body.value.removed).toEqual([join(teamsDir, 'trash-team.md')])
    expect(body.value.trash_id.startsWith('team/')).toBe(true)
    expect(existsSync(join(teamsDir, 'trash-team.md'))).toBe(false)
    expect((await trashStore().list('team')).map((u) => u.id)).toContain(body.value.trash_id)
  })

  it('POST /api/skills/uninstall → 只回收 Prism 产物（整目录）+ 返回 trash_ids', async () => {
    const skillsDir = join(tmp, 'skills')
    await send('POST', '/api/skills/install', { skills_dir: skillsDir, names: ['prism'] })
    await mkdir(join(skillsDir, 'handwritten'), { recursive: true })
    await writeFile(join(skillsDir, 'handwritten', 'SKILL.md'), '# 人写的\n', 'utf-8')

    const res = await send('POST', '/api/skills/uninstall', { skills_dir: skillsDir })
    const body = (await res.json()) as {
      value: { removed: string[]; trash_ids: string[]; kept: Array<{ name: string }> }
    }
    expect(res.status).toBe(200)
    expect(body.value.removed).toEqual([join(skillsDir, 'prism')])
    expect(body.value.trash_ids).toEqual([expect.stringMatching(/^skill\//)])
    expect(body.value.kept.map((k) => k.name)).toEqual(['handwritten'])
    expect(existsSync(join(skillsDir, 'handwritten', 'SKILL.md'))).toBe(true)
    expect((await trashStore().list('skill')).map((u) => u.id)).toEqual(body.value.trash_ids)
  })

  it('GET /api/trash：字段逐字 snake_case（id/kind/name/deleted_at/original_paths/broken）+ ?kind= 过滤', async () => {
    // 三类各造一个单元：团队（扁平）先建（成员校验要用 dev-1），再删角色（目录形态）与 Skill（整目录）
    const teamsCreated = await send('POST', '/api/teams', {
      team_id: 'gone-team',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: teamsDir,
    })
    expect(teamsCreated.status).toBe(200)
    await send('DELETE', '/api/teams/gone-team', { teams_dir: teamsDir })

    const skillsDir = join(tmp, 'skills2')
    await send('POST', '/api/skills/install', { skills_dir: skillsDir, names: ['prism'] })
    await send('POST', '/api/skills/uninstall', { skills_dir: skillsDir })

    const delRole = await send('DELETE', '/api/roles/dev-1', { roles_dir: join(home, 'roles') })
    expect(delRole.status).toBe(200)

    const res = await fetch(`${base}/api/trash`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; value: Array<Record<string, unknown>> }
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.value)).toBe(true)

    for (const unit of body.value) {
      // 逐字冻结：多一个键也算漂移（前端按此契约开工）
      expect(Object.keys(unit).sort()).toEqual(
        ['broken', 'deleted_at', 'id', 'kind', 'name', 'original_paths'].sort(),
      )
      expect(typeof unit['id']).toBe('string')
      expect(typeof unit['kind']).toBe('string')
      expect(typeof unit['name']).toBe('string')
      expect(typeof unit['deleted_at']).toBe('string')
      expect(Array.isArray(unit['original_paths'])).toBe(true)
      expect(typeof unit['broken']).toBe('boolean')
      expect((unit['id'] as string).startsWith(`${unit['kind'] as string}/`)).toBe(true)
    }
    expect(body.value.map((u) => u['kind']).sort()).toEqual(['role', 'skill', 'team'])

    // ?kind= 过滤
    const onlyTeams = await fetch(`${base}/api/trash?kind=team`)
    const teamsBody = (await onlyTeams.json()) as { value: Array<{ kind: string; name: string }> }
    expect(teamsBody.value.map((u) => u.kind)).toEqual(['team'])
    expect(teamsBody.value.map((u) => u.name)).toEqual(['gone-team'])

    const none = await fetch(`${base}/api/trash?kind=nope`)
    expect(((await none.json()) as { value: unknown[] }).value).toEqual([])
  })

  // 白盒补测（tester-whitebox，审计闭环）：此前只断言了 HTTP role 删除的审计 trigger；
  // team / skill 两类走同一 TrashStore 单点，但「trigger 随入口正确传递」仍应逐类锁定。
  it('补测（审计闭环）：DELETE teams + skills/uninstall 也写 trash.put 且 trigger=HTTP', async () => {
    // team：建 → 删
    const created = await send('POST', '/api/teams', {
      team_id: 'audit-team',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: teamsDir,
    })
    expect(created.status).toBe(200)
    const del = await send('DELETE', '/api/teams/audit-team', { teams_dir: teamsDir })
    expect(del.status).toBe(200)

    // skill：装 → 卸
    const skillsDir = join(tmp, 'skills-audit')
    const installed = await send('POST', '/api/skills/install', { skills_dir: skillsDir, names: ['prism'] })
    expect(installed.status).toBe(200)
    const uninstalled = await send('POST', '/api/skills/uninstall', { skills_dir: skillsDir })
    expect(uninstalled.status).toBe(200)

    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
    const triggerByKind = new Map(
      audit.map((e) => [(e as { kind: string }).kind, (e as { trigger: string }).trigger]),
    )
    expect(triggerByKind.get('team')).toBe('HTTP')
    expect(triggerByKind.get('skill')).toBe('HTTP')
  })
})

describe('v9 F3：MCP prism_role_rm 走同一回收站（trigger=MCP）', () => {
  let tmp: string
  let home: string
  let tools: McpTool[]

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-trash-mcp-'))
    home = join(tmp, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, 'prism.yaml'), `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\n`, 'utf-8')
    await mkdir(join(home, 'roles', 'dir-role'), { recursive: true })
    await writeFile(join(home, 'roles', 'dir-role', 'AGENTS.md'), ROLE_MD, 'utf-8')
    tools = createMcpTools({
      home,
      harnessRoot: join(tmp, 'zcode'),
      kbFactory: async () => {
        throw new Error('本测试不消费 kb')
      },
    })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('删除目录形态角色 → 整目录进回收站 + 返回 trash_id + 审计 trigger=MCP', async () => {
    const res = await handleRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_role_rm', arguments: { name: 'dir-role', roles_dir: join(home, 'roles') } } },
      tools,
    )
    expect(res?.result).toMatchObject({ isError: false })
    const value = JSON.parse(textOf(res)) as { removed: string[]; trash_id: string }
    expect(value.removed).toEqual([join(home, 'roles', 'dir-role')])
    expect(value.trash_id.startsWith('role/')).toBe(true)
    expect(existsSync(join(home, 'roles', 'dir-role'))).toBe(false)

    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ kind: 'role', unit_id: value.trash_id, trigger: 'MCP' })
  })

  // 白盒补测（tester-whitebox，审计闭环）：MCP 面此前只锁了 role rm 的审计；
  // team rm 同走 TrashStore 单点，trigger=MCP 逐类锁定。
  it('补测（审计闭环）：prism_team_rm → trash.put trigger=MCP', async () => {
    const teamsDir = join(home, 'teams')
    await mkdir(teamsDir, { recursive: true })
    await writeFile(join(teamsDir, 'mcp-del.md'), '---\nteam_id: mcp-del\n---\n\n# 团队\n', 'utf-8')

    const res = await handleRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_team_rm', arguments: { team_id: 'mcp-del', teams_dir: teamsDir } } },
      tools,
    )
    expect(res?.result).toMatchObject({ isError: false })
    expect(existsSync(join(teamsDir, 'mcp-del.md'))).toBe(false)

    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.put'] })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ kind: 'team', trigger: 'MCP' })
    expect(typeof (audit[0] as { unit_id?: string }).unit_id).toBe('string')
    expect(((audit[0] as { unit_id?: string }).unit_id ?? '').startsWith('team/')).toBe(true)
  })
})

describe('v9 F3：createApp 的 trashSweep 开关（默认关，防定时器泄漏）', () => {
  let tmp: string
  let home: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-trash-sweep-'))
    home = join(tmp, 'home')
    await mkdir(join(home, 'roles'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('默认关：启动不做 sweep，到期单元原样留着（零隐藏副作用）', async () => {
    const id = await seedExpiredUnit(join(home, 'trash'), join(home, 'roles'), 'old-role')
    const app = await createApp({ home })
    try {
      const units = await new TrashStore({ trashDir: join(home, 'trash') }).list('role')
      expect(units.map((u) => u.id)).toEqual([id])
    } finally {
      await new Promise<void>((resolve) => app.server.close(() => resolve()))
    }
  })

  it('打开开关：启动 sweep 一次清掉到期单元；server.close 后不再有定时器（unref + clearInterval）', async () => {
    const id = await seedExpiredUnit(join(home, 'trash'), join(home, 'roles'), 'old-role')

    const app = await createApp({ home, trashSweep: true })
    expect(app.home).toBe(home)
    // 启动即 sweep：到期单元（2020 年那条）被清除
    const units = await new TrashStore({ trashDir: join(home, 'trash') }).list()
    expect(units.map((u) => u.id)).not.toContain(id)

    // 关停路径 = server.close → clearInterval（定时器不再持有事件循环；unref 亦保证不挡退出）
    await new Promise<void>((resolve) => app.server.close(() => resolve()))
    // 幂等：再 sweep 一次不报错（purge 幂等是既有契约）
    expect(await new TrashStore({ trashDir: join(home, 'trash') }).sweep()).toEqual([])
    // 审计：sweep 走 purge → trash.purge（trigger CLI）
    const audit = await new AuditLog({ dir: join(home, 'audit') }).query({ types: ['trash.purge'] })
    expect(audit.some((e) => (e as { unit_id: string }).unit_id === id && (e as { trigger: string }).trigger === 'CLI')).toBe(true)
  })
})
