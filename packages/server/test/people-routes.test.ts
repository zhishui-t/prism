import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { CORE_DEV_TEAM_MD } from '../src/roles/templates.js'

const ZCODE_ROLE_MD = `---
name: dev-1
description: "开发角色：交付可运行增量，绝不扩大战场。"
color: blue
---

# 开发 1

## 核心契约
**交付可运行的增量，绝不扩大战场。**

## 职责
- 写代码
`

/** 团队成员收敛为 dev-1（便于 activate 断言），保留工作流/沉淀/仲裁全字段。 */
const TEAM_MD = CORE_DEV_TEAM_MD.replace(
  /members:\n(?: {2}- role: .*\n {4}count: \d+\n)+/,
  'members:\n  - role: dev-1\n    count: 2\n',
).replace(/ {2}- role: (dev-2|researcher|super-dev|tester|qa-checker)\n/g, '  - role: dev-1\n')

describe('people 路由（design-v3 §3.4 F11：信封 + issues + activate）', () => {
  let app: AppHandle
  let base: string
  let home: string
  let harnessRoot: string

  beforeAll(async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'prism-people-routes-'))
    home = join(tmp, 'home')
    harnessRoot = join(tmp, 'zcode')
    // B8：数据源与 CLI 同源（resolveDirs）——用 prism.yaml 显式指向临时目录，避免回落真实宿主
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\nteams_dir: ${join(home, 'teams').replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    await mkdir(join(home, 'roles', 'dev-1'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1', 'AGENTS.md'), ZCODE_ROLE_MD, 'utf-8')
    await mkdir(join(home, 'teams', 'core-dev'), { recursive: true })
    await writeFile(join(home, 'teams', 'core-dev', 'AGENTS.md'), TEAM_MD, 'utf-8')
    app = await startServer({ home, harnessRoot, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    await rm(join(home, '..'), { recursive: true, force: true }).catch(() => {})
  })

  it('GET /api/roles → 信封 ok:true，角色数组携带 issues 数组', async () => {
    const res = await fetch(`${base}/api/roles`)
    const body = (await res.json()) as {
      ok: boolean
      value: Array<{ name: string; skills: string[]; issues: Array<{ level: string; code: string }> }>
    }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.map((r) => r.name)).toContain('dev-1')
    expect(Array.isArray(body.value[0].issues)).toBe(true)
  })

  it('GET /api/roles/:name → 单角色；不存在 → not_found 信封', async () => {
    const ok = await fetch(`${base}/api/roles/dev-1`)
    const okBody = (await ok.json()) as { ok: boolean; value: { name: string; principle: string; issues: unknown[] } }
    expect(ok.status).toBe(200)
    expect(okBody.value.name).toBe('dev-1')
    expect(okBody.value.principle).toContain('绝不扩大战场')

    const miss = await fetch(`${base}/api/roles/nope`)
    const missBody = (await miss.json()) as { ok: boolean; error: { code: string } }
    expect(miss.status).toBe(404)
    expect(missBody).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('GET /api/teams → { teams, teamsDir }（F-C3 只读目录字段）；GET /api/teams/:id', async () => {
    const list = await fetch(`${base}/api/teams`)
    const listBody = (await list.json()) as {
      ok: boolean
      value: { teams: Array<{ team_id: string; issues: unknown[]; workflow: unknown[] }>; teamsDir: string }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.value.teams.map((t) => t.team_id)).toContain('core-dev')
    expect(Array.isArray(listBody.value.teams[0].issues)).toBe(true)
    expect(listBody.value.teams[0].workflow.length).toBe(7)
    // design-v4 §3.4 / ui-spec §8-D1：只读 teamsDir 供新建表单预填（不得为 undefined）
    // 路径分隔符随 prism.yaml 原样回传（/ 或 \），比较前归一
    expect(listBody.value.teamsDir.replaceAll('\\', '/')).toBe(join(home, 'teams').replaceAll('\\', '/'))

    const one = await fetch(`${base}/api/teams/core-dev`)
    const oneBody = (await one.json()) as { ok: boolean; value: { team_id: string; deposit: Record<string, unknown> } }
    expect(oneBody.ok).toBe(true)
    expect(oneBody.value.deposit.default_type).toBe('pitfall')

    const miss = await fetch(`${base}/api/teams/nope`)
    expect(miss.status).toBe(404)
  })

  /**
   * ui-spec-v4 §8-D5：团队 not_found 文案必须报**真实落点** `<teams_dir>/<id>.md`
   * （agents `installTeamDefinitions` 的产物形态），目录式 `<id>/AGENTS.md` 只作兼容形态附带说明
   * ——旧文案只写 `<id>/AGENTS.md`，用户会去错路径。两个 HTTP 入口文案同源；错误码保持 not_found。
   */
  it('ui-spec §8-D5：团队 not_found 文案指向真实落点 <id>.md（并注明兼容 <id>/AGENTS.md）', async () => {
    const list = await fetch(`${base}/api/teams`)
    const teamsDirShown = ((await list.json()) as { value: { teamsDir: string } }).value.teamsDir
    const norm = (s: string): string => s.replaceAll('\\', '/')
    const expectedSource = `数据源 ${norm(teamsDirShown)}/<id>.md`

    const get = await fetch(`${base}/api/teams/nope`)
    const getBody = (await get.json()) as { error: { code: string; message: string } }
    expect(get.status).toBe(404)
    expect(getBody.error.code).toBe('not_found')
    expect(norm(getBody.error.message)).toContain(expectedSource)
    expect(getBody.error.message).toContain('兼容 <id>/AGENTS.md 双形态')

    // teamActivate 分支（同一文案单点）
    const activate = await fetch(`${base}/api/teams/nope/activate`)
    const activateBody = (await activate.json()) as { error: { code: string; message: string } }
    expect(activate.status).toBe(404)
    expect(activateBody.error.code).toBe('not_found')
    expect(norm(activateBody.error.message)).toContain(expectedSource)
  })

  it('GET /api/teams/:id/activate → TeamActivation（dispatch 仅由 installed 推导，P8）', async () => {
    const res = await fetch(`${base}/api/teams/core-dev/activate`)
    const body = (await res.json()) as {
      ok: boolean
      value: {
        team_id: string
        members: Array<{ role: string; installed: boolean; dispatch: string; definition?: { name: string }; hint?: string }>
        workflow: Array<{ order: number }>
        rework_limit: number
      }
    }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.team_id).toBe('core-dev')
    expect(body.value.members[0]).toMatchObject({ role: 'dev-1', installed: false, dispatch: 'fallback' })
    expect(body.value.members[0].definition?.name).toBe('dev-1')
    expect(body.value.members[0].hint).toContain('prism role init')

    // 装配后 → native
    await mkdir(join(harnessRoot, 'agents'), { recursive: true })
    await writeFile(join(harnessRoot, 'agents', 'dev-1.md'), '---\nname: dev-1\ndescription: "x"\n---\n\n<!-- generated by prism (role: dev-1) -->\n', 'utf-8')
    const after = await fetch(`${base}/api/teams/core-dev/activate`)
    const afterBody = (await after.json()) as { value: { members: Array<{ installed: boolean; dispatch: string }> } }
    expect(afterBody.value.members[0]).toMatchObject({ installed: true, dispatch: 'native' })
  })

  /**
   * v5 / S5：`GET /api/roles` 增只读 `installed`（宿主 agents 目录有无该角色定义）。
   * 判定与 `/api/teams/:id/activate` 的 `installed` 同源——两处不得打架。
   * 位置在 activate 用例之后：那里刚把 `<harnessRoot>/agents/dev-1.md` 写出来；
   * 本用例仍自行幂等写入，不依赖执行顺序。
   */
  it('GET /api/roles → 每角色携带只读 installed（与 activate 判定同源）', async () => {
    await mkdir(join(harnessRoot, 'agents'), { recursive: true })
    await writeFile(
      join(harnessRoot, 'agents', 'dev-1.md'),
      '---\nname: dev-1\ndescription: "x"\n---\n\n<!-- generated by prism (role: dev-1) -->\n',
      'utf-8',
    )
    // 只住在 Prism 受管 roles_dir、未进宿主 agents 目录 → 未装
    await mkdir(join(home, 'roles', 'tester'), { recursive: true })
    await writeFile(join(home, 'roles', 'tester', 'AGENTS.md'), ZCODE_ROLE_MD.replace(/dev-1/g, 'tester'), 'utf-8')

    const res = await fetch(`${base}/api/roles`)
    const body = (await res.json()) as { ok: boolean; value: Array<{ name: string; installed?: boolean }> }
    expect(res.status).toBe(200)
    expect(Array.isArray(body.value)).toBe(true) // 容器形态不变（数组）
    const byName = new Map(body.value.map((r) => [r.name, r.installed]))
    expect(byName.get('dev-1')).toBe(true)
    expect(byName.get('tester')).toBe(false)

    // 与 activate 同源核对
    const act = await fetch(`${base}/api/teams/core-dev/activate`)
    const actBody = (await act.json()) as { value: { members: Array<{ role: string; installed: boolean }> } }
    expect(actBody.value.members[0]).toMatchObject({ role: 'dev-1', installed: true })
  })

  it('GET /api/skills → 内置 PrismSkill[]（含 prism 元 skill）', async () => {
    const res = await fetch(`${base}/api/skills`)
    const body = (await res.json()) as { ok: boolean; value: Array<{ name: string; builtin: boolean }> }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.map((s) => s.name)).toContain('prism')
    expect(body.value.every((s) => s.builtin)).toBe(true)
  })
})

/** F-C3 `POST /api/teams` + F-D2 `GET /api/skills/effective`（design-v4 §3.4）。 */
describe('people 写路由（F-C3 新建团队）与有效集（F-D2）', () => {
  let app: AppHandle
  let base: string
  let tmp: string
  let home: string
  let writeDir: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-people-create-'))
    home = join(tmp, 'home')
    writeDir = join(tmp, 'managed-teams')
    await mkdir(home, { recursive: true })
    // 读源=临时目录（避免真实宿主）；**写目标另给**（写路径只认 body.teams_dir）
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\nteams_dir: ${join(home, 'teams').replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    await mkdir(join(home, 'roles', 'dev-1'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1', 'AGENTS.md'), ZCODE_ROLE_MD, 'utf-8')
    await mkdir(join(home, 'roles', 'tester'), { recursive: true })
    await writeFile(join(home, 'roles', 'tester', 'AGENTS.md'), ZCODE_ROLE_MD.replace(/dev-1/g, 'tester'), 'utf-8')
    app = await startServer({ home, harnessRoot: join(tmp, 'zcode'), port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const post = (payload: unknown): Promise<Response> =>
    fetch(`${base}/api/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

  it('缺 teams_dir → 400 + teams_dir_required（不回落默认宿主目录）', async () => {
    const res = await post({ team_id: 'demo-team', name: '演示', members: [{ role: 'dev-1', count: 1 }] })
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } }
    expect(res.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('teams_dir_required')
    // 关键：默认 teams_dir（home/teams）下不该出现任何文件
    expect(existsSync(join(home, 'teams', 'demo-team.md'))).toBe(false)
  })

  it('非法 team_id（非 kebab）→ 400 + team_id_invalid', async () => {
    const res = await post({ team_id: 'Demo_Team', members: [{ role: 'dev-1', count: 1 }], teams_dir: writeDir })
    const body = (await res.json()) as { error: { message: string } }
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('team_id_invalid')
  })

  it('members 为空 → 400 + members_invalid', async () => {
    const res = await post({ team_id: 'demo-team', members: [], teams_dir: writeDir })
    const body = (await res.json()) as { error: { message: string } }
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('members_invalid')
  })

  it('成员角色不存在 → 400 + member_role_unknown（不落盘）', async () => {
    const res = await post({
      team_id: 'demo-team',
      members: [{ role: 'ghost-role', count: 1 }],
      teams_dir: writeDir,
    })
    const body = (await res.json()) as { error: { message: string } }
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('member_role_unknown')
    expect(existsSync(join(writeDir, 'demo-team.md'))).toBe(false)
  })

  it('正例：写显式 teams_dir → {path, issues} + 文件落盘 + 读回列出（闭环）', async () => {
    const res = await post({
      team_id: 'demo-team',
      name: '演示团队',
      description: '由 POST /api/teams 创建',
      members: [
        { role: 'dev-1', count: 1 },
        { role: 'tester', count: 1 },
      ],
      deposit: { enabled: true, default_layer: 'global', default_type: 'rule', priority: 'high', require_note: false },
      teams_dir: writeDir,
    })
    const body = (await res.json()) as { ok: boolean; value: { path: string; issues: Array<{ level: string }> } }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.path.replaceAll('\\', '/')).toBe(join(writeDir, 'demo-team.md').replaceAll('\\', '/'))
    expect(existsSync(body.value.path)).toBe(true)
    // 沉淀策略被采用（控制台会回读核对这 5 个字段）
    const md = await readFile(body.value.path, 'utf-8')
    expect(md).toContain('default_layer: global')
    expect(md).toContain('require_note: false')

    // 闭环：改用同一目录作为读源 → loadTeams 能看到（扁平 `<id>.md` 形态）
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\nteams_dir: ${writeDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    const app2 = await startServer({ home, harnessRoot: join(tmp, 'zcode'), port: 0 })
    try {
      const list = await fetch(`http://127.0.0.1:${app2.port}/api/teams`)
      const listBody = (await list.json()) as { value: { teams: Array<{ team_id: string }> } }
      expect(listBody.value.teams.map((t) => t.team_id)).toContain('demo-team')
    } finally {
      await app2.close()
    }
  })

  it('已存在 → 409 id_conflict（不静默覆盖）', async () => {
    const res = await post({ team_id: 'demo-team', members: [{ role: 'dev-1', count: 1 }], teams_dir: writeDir })
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('id_conflict')
  })

  it('F-D2 GET /api/skills/effective 角色不存在 → 404 信封', async () => {
    const res = await fetch(`${base}/api/skills/effective?role=ghost`)
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } }
    expect(res.status).toBe(404)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('not_found')
    expect(body.error.message).toContain('角色不存在')
  })
})
