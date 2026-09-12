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

  it('GET /api/roles → {roles, roles_dir} 携带 issues（v6.1 键名 = 写参数名）', async () => {
    const res = await fetch(`${base}/api/roles`)
    const body = (await res.json()) as {
      ok: boolean
      value: {
        roles: Array<{ name: string; skills: string[]; issues: Array<{ level: string; code: string }> }>
        roles_dir: string
      }
    }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.roles.map((r) => r.name)).toContain('dev-1')
    expect(Array.isArray(body.value.roles[0]!.issues)).toBe(true)
    // roles_dir 只读返回，供控制台新建表单预填（写路径仍只认 POST /api/roles 的显式 roles_dir）
    // 契约：键名与写参数**同名**（宿主/控制台读回即可回填，不必 camel↔snake 转换）
    // 分隔符按 `/` 归一后比较：prism.yaml 里写的是 `/` 形式，回读保持原样
    expect(body.value.roles_dir.replaceAll('\\', '/')).toBe(join(home, 'roles').replaceAll('\\', '/'))
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

  it('GET /api/teams → { teams, teams_dir }（v6.1 只读目录字段）；GET /api/teams/:id', async () => {
    const list = await fetch(`${base}/api/teams`)
    const listBody = (await list.json()) as {
      ok: boolean
      value: { teams: Array<{ team_id: string; issues: unknown[]; workflow: unknown[] }>; teams_dir: string }
    }
    expect(listBody.ok).toBe(true)
    expect(listBody.value.teams.map((t) => t.team_id)).toContain('core-dev')
    expect(Array.isArray(listBody.value.teams[0].issues)).toBe(true)
    expect(listBody.value.teams[0].workflow.length).toBe(7)
    // v6.1：只读 teams_dir 供新建表单预填（不得为 undefined），键名与写参数 `teams_dir` 同名
    // 路径分隔符随 prism.yaml 原样回传（/ 或 \），比较前归一
    expect(listBody.value.teams_dir.replaceAll('\\', '/')).toBe(join(home, 'teams').replaceAll('\\', '/'))

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
    const teamsDirShown = ((await list.json()) as { value: { teams_dir: string } }).value.teams_dir
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
    expect(body.value.members[0].hint).toContain('prism role new')

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
    const body = (await res.json()) as {
      ok: boolean
      value: { roles: Array<{ name: string; installed?: boolean }>; roles_dir: string }
    }
    expect(res.status).toBe(200)
    expect(Array.isArray(body.value.roles)).toBe(true) // roles 仍是数组（容器改为 {roles, roles_dir}）
    const byName = new Map(body.value.roles.map((r) => [r.name, r.installed]))
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

/**
 * v6：角色 / 团队写路由补齐（`POST|PATCH|DELETE /api/roles[/:name]`、`PATCH|DELETE /api/teams/:id`）。
 *
 * 口径（与 CLI / MCP 三入口同名同位）：
 * - 写路径的 `roles_dir` / `teams_dir` **必填**，绝不复用默认宿主目录（R5/R6）；
 * - `POST /api/roles` 落**宿主原生形态**：frontmatter 只含适配器白名单字段，
 *   `skills` / 知识绑定落正文 `## 能力（Skill 白名单）` / `## 知识绑定` 小节；
 * - `PATCH` 是**外科式补丁**：只动点名字段，正文与未知 frontmatter 键原样保留；
 *   `''` / `null` = 清除该 frontmatter 键；
 * - `DELETE` 是**硬删**（不可逆）。
 */
describe('people 写路由 v6（角色与团队 增删改）', () => {
  let app: AppHandle
  let base: string
  let tmp: string
  let home: string
  let rolesDir: string
  let teamsDir: string

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-people-v6-'))
    home = join(tmp, 'home')
    // 读源 = 临时 home 下；**写目标另给**（写路径只认 body 里的显式目录）
    rolesDir = join(tmp, 'managed-roles')
    teamsDir = join(tmp, 'managed-teams')
    await mkdir(home, { recursive: true })
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

  const send = (method: string, path: string, payload?: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    })

  it('POST /api/roles：缺 roles_dir → 400 + roles_dir_required（不落默认宿主目录）', async () => {
    const res = await send('POST', '/api/roles', { name: 'v6-role' })
    const body = (await res.json()) as { ok: boolean; error: { message: string } }
    expect(res.status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error.message).toContain('roles_dir_required')
    expect(existsSync(join(home, 'roles', 'v6-role.md'))).toBe(false)
  })

  it('POST /api/roles：宿主原生形态落盘（skills / 知识绑定落正文小节，不污染 frontmatter）', async () => {
    const res = await send('POST', '/api/roles', {
      name: 'v6-role',
      description: 'v6 冒烟角色',
      skills: ['kb', 'graph'],
      knowledge: { layers: ['global'] },
      color: 'blue',
      roles_dir: rolesDir,
    })
    const body = (await res.json()) as { ok: boolean; value: { path: string; overwritten: boolean } }
    expect(res.status).toBe(200)
    expect(body.value.path.replaceAll('\\', '/')).toBe(join(rolesDir, 'v6-role.md').replaceAll('\\', '/'))
    expect(body.value.overwritten).toBe(false)

    const md = await readFile(body.value.path, 'utf-8')
    // frontmatter 只有白名单字段（name/description/color）——不含 skills / knowledge
    const fm = md.slice(md.indexOf('---'), md.indexOf('---', 3))
    expect(fm).toContain('name: v6-role')
    expect(fm).toContain('color: blue')
    expect(fm).not.toContain('skills')
    expect(fm).not.toContain('knowledge')
    // Prism 扩展落正文
    expect(md).toContain('## 能力（Skill 白名单）')
    expect(md).toContain('- kb')
    expect(md).toContain('## 知识绑定')
    expect(md).toContain('- layers: global')

    // 读回闭环：换成 writeDir 当读源后仍能解析出 skills / knowledge
    const app2 = await startServer({ home: await rolesHome(rolesDir), harnessRoot: join(tmp, 'zcode'), port: 0 })
    try {
      const got = await fetch(`http://127.0.0.1:${app2.port}/api/roles/v6-role`)
      const gotBody = (await got.json()) as {
        value: { skills: string[]; knowledge: { layers: string[] }; color?: string }
      }
      expect(gotBody.value.skills).toEqual(['kb', 'graph'])
      expect(gotBody.value.knowledge.layers).toEqual(['global'])
      expect(gotBody.value.color).toBe('blue')
    } finally {
      await app2.close()
    }
  })

  it('POST /api/roles 已存在 → 409 id_conflict（不静默覆盖）', async () => {
    const res = await send('POST', '/api/roles', { name: 'v6-role', roles_dir: rolesDir })
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('id_conflict')
  })

  it('PATCH /api/roles/:name：外科式补丁（改 skills 只动白名单；model 键保留）', async () => {
    // 先给一个 model，验证补丁**不动**未点名的字段
    const rolePath = join(rolesDir, 'v6-role.md')
    const before = await readFile(rolePath, 'utf-8')
    await writeFile(rolePath, before.replace('color: blue', 'color: blue\nmodel: "custom:x"'), 'utf-8')

    const res = await send('PATCH', '/api/roles/v6-role', { skills: ['arch'], roles_dir: rolesDir })
    expect(res.status).toBe(200)

    const md = await readFile(rolePath, 'utf-8')
    expect(md).toContain('model: "custom:x"') // 未点名 → 保留
    expect(md).toContain('- arch')
    expect(md).not.toContain('- kb') // 白名单被整体替换（补丁语义，不是追加）
  })

  it('PATCH /api/roles/:name：color 空串 → 清除该 frontmatter 键（不是留个空串）', async () => {
    const res = await send('PATCH', '/api/roles/v6-role', { color: '', roles_dir: rolesDir })
    expect(res.status).toBe(200)
    const md = await readFile(join(rolesDir, 'v6-role.md'), 'utf-8')
    expect(md).not.toMatch(/^color:/m)
  })

  it('PATCH /api/roles/:name：未给任何字段 → 400 role_patch_empty', async () => {
    const res = await send('PATCH', '/api/roles/v6-role', { roles_dir: rolesDir })
    const body = (await res.json()) as { error: { message: string } }
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('role_patch_empty')
  })

  it('PATCH /api/roles/:name：目标不存在 → 404（只改，不隐式新建）', async () => {
    const res = await send('PATCH', '/api/roles/ghost-role', { description: 'x', roles_dir: rolesDir })
    const body = (await res.json()) as { error: { code: string } }
    expect(res.status).toBe(404)
    expect(body.error.code).toBe('not_found')
    expect(existsSync(join(rolesDir, 'ghost-role.md'))).toBe(false)
  })

  it('DELETE /api/roles/:name：硬删文件本体；再删 → 404', async () => {
    const rolePath = join(rolesDir, 'v6-role.md')
    expect(existsSync(rolePath)).toBe(true)

    const del = await send('DELETE', '/api/roles/v6-role', { roles_dir: rolesDir })
    const delBody = (await del.json()) as { ok: boolean; value: { removed: string[] } }
    expect(del.status).toBe(200)
    expect(delBody.value.removed.length).toBe(1)
    expect(existsSync(rolePath)).toBe(false)

    const again = await send('DELETE', '/api/roles/v6-role', { roles_dir: rolesDir })
    const againBody = (await again.json()) as { error: { code: string } }
    expect(again.status).toBe(404)
    expect(againBody.error.code).toBe('not_found')
  })

  it('DELETE /api/roles/:name：缺 roles_dir → 400（不回落默认宿主目录）', async () => {
    const res = await send('DELETE', '/api/roles/dev-1', {})
    const body = (await res.json()) as { error: { message: string } }
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('roles_dir_required')
  })

  it('PATCH /api/teams/:id：改名册 → 工作流就地收窄（workflow_pruned）；DELETE 硬删', async () => {
    // 先建一个双成员团队
    const created = await send('POST', '/api/teams', {
      team_id: 'v6-team',
      name: 'v6 队',
      members: [
        { role: 'dev-1', count: 1 },
        { role: 'tester', count: 1 },
      ],
      teams_dir: teamsDir,
    })
    expect(created.status).toBe(200)

    const patched = await send('PATCH', '/api/teams/v6-team', {
      members: [{ role: 'dev-1', count: 2 }],
      teams_dir: teamsDir,
      roles_dir: join(home, 'roles'),
    })
    const patchedBody = (await patched.json()) as { ok: boolean; value: { issues: Array<{ code: string }> } }
    expect(patched.status).toBe(200)
    expect(patchedBody.value.issues.some((i) => i.code === 'workflow_pruned')).toBe(true)

    const md = await readFile(join(teamsDir, 'v6-team.md'), 'utf-8')
    expect(md).toContain('- role: dev-1')
    expect(md).not.toContain('- role: tester')

    const del = await send('DELETE', '/api/teams/v6-team', { teams_dir: teamsDir })
    expect(del.status).toBe(200)
    expect(existsSync(join(teamsDir, 'v6-team.md'))).toBe(false)
  })

  it('POST /api/roles：首次创建带 force → overwritten=false（回真实是否覆盖，不回显入参）', async () => {
    const res = await send('POST', '/api/roles', {
      name: 'v6-force-first',
      description: '首次创建',
      force: true,
      roles_dir: rolesDir,
    })
    const body = (await res.json()) as { ok: boolean; value: { overwritten: boolean } }
    expect(res.status).toBe(200)
    expect(body.value.overwritten).toBe(false) // 首次创建并没有覆盖任何既有文件

    const again = await send('POST', '/api/roles', {
      name: 'v6-force-first',
      description: '第二次（此时文件已存在）',
      force: true,
      roles_dir: rolesDir,
    })
    const againBody = (await again.json()) as { value: { overwritten: boolean } }
    expect(againBody.value.overwritten).toBe(true)
  })

  it('POST /api/teams：显式 roles_dir 生效（成员校验用指定角色库，不再无条件回落默认库）', async () => {
    // 隔离角色库：只有 alt-role（默认 home/roles 里没有）
    const altRoles = join(tmp, 'alt-roles')
    await mkdir(altRoles, { recursive: true })
    await writeFile(join(altRoles, 'alt-role.md'), ZCODE_ROLE_MD.replace(/dev-1/g, 'alt-role'), 'utf-8')

    // 缺省仍回落默认角色库 → alt-role 不在库中 → 400（老行为保留，向后兼容）
    const fallback = await send('POST', '/api/teams', {
      team_id: 'v6-team-alt-default',
      members: [{ role: 'alt-role', count: 1 }],
      teams_dir: teamsDir,
    })
    expect(fallback.status).toBe(400)
    expect(((await fallback.json()) as { error: { message: string } }).error.message).toContain('member_role_unknown')

    // 显式 roles_dir → 用隔离库校验 → 通过并落盘
    const res = await send('POST', '/api/teams', {
      team_id: 'v6-team-alt',
      members: [{ role: 'alt-role', count: 1 }],
      teams_dir: teamsDir,
      roles_dir: altRoles,
    })
    expect(res.status).toBe(200)
    expect(existsSync(join(teamsDir, 'v6-team-alt.md'))).toBe(true)
    await send('DELETE', '/api/teams/v6-team-alt', { teams_dir: teamsDir })
  })

  it('PATCH /api/teams/:id：改 members 缺 roles_dir → 400（校验角色存在所需参数不得隐式回落）', async () => {
    const created = await send('POST', '/api/teams', {
      team_id: 'v6-team-2',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: teamsDir,
    })
    expect(created.status).toBe(200)
    const res = await send('PATCH', '/api/teams/v6-team-2', {
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: teamsDir,
    })
    const body = (await res.json()) as { error: { message: string } }
    expect(res.status).toBe(400)
    expect(body.error.message).toContain('roles_dir_required')
  })
})

/** 为一个受管 roles 目录造一个最小 home（写 prism.yaml 指向它），用于「读回」断言。 */
async function rolesHome(dir: string): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), 'prism-people-v6-read-'))
  await writeFile(join(h, 'prism.yaml'), `roles_dir: ${dir.replaceAll('\\', '/')}\n`, 'utf-8')
  return h
}
