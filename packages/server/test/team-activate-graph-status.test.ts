/**
 * F-C3：`GET /api/teams/:id/activate` 的**只读** `graph_status`。
 *
 * 判据（design-v5 §2 F-C3）：响应含只读 `graph_status`（不全量哈希）；
 * **缺省图谱产物 mtime 不变**；仅显式 `?build=1` 才建图（守 R1「不抢调度」）。
 * 包装在 server 侧完成——`packages/agents` 的 `TeamActivation` 冻结类型未改。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CORE_DEV_TEAM_MD, fillTeamTemplate } from '@prism/agents'

import { startServer, type AppHandle } from '../src/app.js'

interface ActivationEnvelope {
  ok: boolean
  value: {
    team_id: string
    graph_status: {
      project: string
      root: string
      graph_exists: boolean
      built_at: string | null
      changed_files: number
      total_files: number
      stale: boolean
      note?: string
    } | null
    graph_build?: { job_id: string }
  }
}

let app: AppHandle
let base: string
let home: string
let projectRoot: string
/** 注入的假建图 runner：记录调用次数（断言「缺省绝不建图」）。 */
let buildCalls = 0

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'prism-activate-home-'))
  const harnessRoot = await mkdtemp(join(tmpdir(), 'prism-activate-harness-'))
  projectRoot = await mkdtemp(join(tmpdir(), 'prism-activate-proj-'))

  app = await startServer({
    home,
    harnessRoot,
    kb: undefined as never,
    port: 0,
    buildRunner: async () => {
      buildCalls++
    },
  })
  base = `http://127.0.0.1:${app.port}`

  // ① 团队落盘：先问服务端要 teams_dir（保证与生产解析同源，不靠猜）
  const teams = (await (await fetch(`${base}/api/teams`)).json()) as { value: { teams_dir: string } }
  await mkdir(teams.value.teams_dir, { recursive: true })
  await writeFile(
    join(teams.value.teams_dir, 'core-dev.md'),
    fillTeamTemplate(CORE_DEV_TEAM_MD, { teamId: 'core-dev', name: '核心研发团队', description: '测试用' }),
    'utf-8',
  )

  // ② 造一个「已建图」的注册项目（直接落注册表 + 产物，绕开真实建图）
  await mkdir(join(projectRoot, 'graphify-out'), { recursive: true })
  await writeFile(join(projectRoot, 'graphify-out', 'graph.json'), '{"nodes":[]}\n', 'utf-8')
  await writeFile(
    join(projectRoot, 'graphify-out', 'manifest.json'),
    JSON.stringify({ 'src/a.ts': { mtime: 1 } }),
    'utf-8',
  )
  await mkdir(join(home, 'graph'), { recursive: true })
  await writeFile(
    join(home, 'graph', 'projects.json'),
    JSON.stringify({
      version: 1,
      projects: {
        demo: { root: projectRoot, built_at: '2026-09-11T00:00:00.000Z', registered_at: '2026-09-11T00:00:00.000Z' },
      },
    }),
    'utf-8',
  )
})

afterAll(async () => {
  await app.close()
})

const activate = async (query = ''): Promise<ActivationEnvelope> =>
  (await (await fetch(`${base}/api/teams/core-dev/activate${query}`)).json()) as ActivationEnvelope

describe('F-C3：team activate 的只读 graph_status', () => {
  it('缺省（不指定项目）：graph_status = null，且**绝不建图**、产物 mtime 不变', async () => {
    const graphFile = join(projectRoot, 'graphify-out', 'graph.json')
    const before = (await stat(graphFile)).mtimeMs
    const callsBefore = buildCalls

    const body = await activate()

    expect(body.ok).toBe(true)
    expect(body.value.graph_status).toBeNull() // 字段恒存在，值为 null
    expect(buildCalls).toBe(callsBefore)
    expect((await stat(graphFile)).mtimeMs).toBe(before)
  })

  it('?project=<名>：返回只读状态（graph_exists/stale/changed_files 齐备），仍不建图', async () => {
    const graphFile = join(projectRoot, 'graphify-out', 'graph.json')
    const before = (await stat(graphFile)).mtimeMs
    const callsBefore = buildCalls

    const body = await activate('?project=demo')

    expect(body.ok).toBe(true)
    const status = body.value.graph_status
    expect(status).not.toBeNull()
    expect(status!.project).toBe('demo')
    expect(status!.graph_exists).toBe(true)
    expect(status!.built_at).toBe('2026-09-11T00:00:00.000Z')
    expect(status!.total_files).toBe(1)
    expect(typeof status!.changed_files).toBe('number')
    expect(typeof status!.stale).toBe('boolean')

    expect(buildCalls).toBe(callsBefore)
    expect((await stat(graphFile)).mtimeMs).toBe(before)
  })

  it('?project= 指向未注册项目 → not_found（不静默给假状态）', async () => {
    const res = await fetch(`${base}/api/teams/core-dev/activate?project=nope`)
    expect(res.status).toBe(404)
  })

  it('?build=1 缺 project → bad_request（Prism 不猜项目）', async () => {
    const res = await fetch(`${base}/api/teams/core-dev/activate?build=1`)
    expect(res.status).toBe(400)
  })

  it('?build=1&project=<名>：才真正触发建图，并回 job_id', async () => {
    const callsBefore = buildCalls
    const body = await activate('?project=demo&build=1')

    expect(body.ok).toBe(true)
    expect(body.value.graph_build?.job_id).toBeTruthy()
    // 建图是后台 job（submit 即返回 job_id），轮询等 runner 被真正调用
    const deadline = Date.now() + 5000
    while (buildCalls === callsBefore && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(buildCalls).toBe(callsBefore + 1)

    const job = (await (
      await fetch(`${base}/api/graph/build/${body.value.graph_build!.job_id}`)
    ).json()) as { ok: boolean; value: { project: string } }
    expect(job.ok).toBe(true)
    expect(job.value.project).toBe('demo')
  })

  it('团队不存在 → not_found', async () => {
    const res = await fetch(`${base}/api/teams/no-such-team/activate`)
    expect(res.status).toBe(404)
  })

  it('未改冻结契约：激活响应仍是 TeamActivation 字段 + 附加 graph_status', async () => {
    const body = await activate('?project=demo')
    expect(body.value.team_id).toBe('core-dev')
    expect(Array.isArray((body.value as unknown as { members: unknown[] }).members)).toBe(true)
    // 参考断言：teamsDir 下确实存在团队文件（防「测试自己造了不该有的路径」）
    expect(existsSync(join(home, 'graph', 'projects.json'))).toBe(true)
  })
})
