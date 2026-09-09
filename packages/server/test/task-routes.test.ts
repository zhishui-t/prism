import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { makeTempDir } from './helpers.js'

describe('任务台账路由（被动台账：register / report / list / graph / stats）', () => {
  let app: AppHandle
  let base: string

  beforeAll(async () => {
    const home = await makeTempDir('prism-task-routes-')
    app = await startServer({ home, kb: undefined as never, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('register → list → get → dag 全链路', async () => {
    const res = await post('/api/tasks/register', {
      dag_id: 'dag-http',
      session_id: 'sess-1',
      team_id: 'core-dev',
      project_id: 'prism',
      version: 'v1',
      difficulty: 'normal',
      tasks: [
        { id: 'h1', description: '设计' },
        { id: 'h2', description: '开发', depends_on: ['h1'] },
      ],
    })
    const body = (await res.json()) as { ok: boolean; value: { tasks: number; edges: number } }
    expect(body.ok).toBe(true)
    expect(body.value).toEqual({ dag_id: 'dag-http', tasks: 2, edges: 1 })

    const list = (await (await fetch(`${base}/api/tasks?dag_id=dag-http`)).json()) as {
      ok: boolean
      value: Array<{ id: string; status: string }>
    }
    expect(list.value.map((t) => t.id).sort()).toEqual(['h1', 'h2'])
    expect(list.value.every((t) => t.status === 'WAITING')).toBe(true)

    const single = (await (await fetch(`${base}/api/tasks/h1`)).json()) as { value: { description: string } }
    expect(single.value.description).toBe('设计')

    const dag = (await (await fetch(`${base}/api/dags/dag-http`)).json()) as {
      ok: boolean
      value: { edges: Array<{ from: string; to: string }>; tasks: unknown[] }
    }
    expect(dag.value.edges).toEqual([{ from: 'h1', to: 'h2' }])
    expect(dag.value.tasks).toHaveLength(2)
  })

  it('report：合法转移落库并递增 revision；依赖数组被解析为数组', async () => {
    const res = await post('/api/tasks/report', { task_id: 'h1', to_status: 'RUNNING', by: 'dev-1' })
    const body = (await res.json()) as {
      ok: boolean
      value: { status: string; revision: number; dependencies: unknown }
    }
    expect(body.ok).toBe(true)
    expect(body.value.status).toBe('RUNNING')
    expect(body.value.revision).toBe(1)
    expect(Array.isArray(body.value.dependencies)).toBe(true)
  })

  it('非法转移 → invalid_status_transition；stale revision → task_stale_revision', async () => {
    const bad = await post('/api/tasks/report', { task_id: 'h2', to_status: 'COMPLETED', by: 'x' })
    const badBody = (await bad.json()) as { ok: boolean; error: { code: string } }
    expect(badBody.ok).toBe(false)
    expect(badBody.error.code).toBe('invalid_status_transition')

    const stale = await post('/api/tasks/report', {
      task_id: 'h1',
      to_status: 'COMPLETED',
      by: 'dev-1',
      expected_revision: 0,
    })
    const staleBody = (await stale.json()) as { ok: boolean; error: { code: string } }
    expect(staleBody.error.code).toBe('task_stale_revision')
  })

  it('缺参数 / 未知任务 / 未知 DAG → 4xx', async () => {
    expect((await post('/api/tasks/report', { task_id: 'h1' })).status).toBe(400)
    expect((await fetch(`${base}/api/tasks/ghost`)).status).toBe(404)
    expect((await fetch(`${base}/api/dags/ghost`)).status).toBe(404)
  })

  it('stats：按状态计数', async () => {
    const stats = (await (await fetch(`${base}/api/tasks/stats`)).json()) as {
      ok: boolean
      value: { total: number; dags: number; by_status: Record<string, number> }
    }
    expect(stats.ok).toBe(true)
    expect(stats.value.total).toBe(2)
    expect(stats.value.dags).toBe(1)
    expect(stats.value.by_status['RUNNING']).toBe(1)
    expect(stats.value.by_status['WAITING']).toBe(1)
  })
})
