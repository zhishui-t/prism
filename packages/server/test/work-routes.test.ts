import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUILTIN_VALIDATORS, openPersistence, WorkQueue, WORK_KINDS } from '@prism/core'

import { startServer, type AppHandle } from '../src/app.js'
import { makeTempDir } from './helpers.js'

describe('工作队列路由（拉取式：pending/claim/complete/fail/reclaim/stats）', () => {
  let app: AppHandle
  let base: string
  let queue: WorkQueue
  let persistence: ReturnType<typeof openPersistence>

  beforeAll(async () => {
    persistence = openPersistence({ inMemory: true })
    queue = new WorkQueue({ persistence })
    for (const kind of WORK_KINDS) queue.registerValidator(kind, BUILTIN_VALIDATORS[kind])
    const home = await makeTempDir('prism-work-routes-')
    app = await startServer({ home, kb: undefined as never, workQueue: queue, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    persistence.close()
  })

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('enqueue（经 queue）→ GET pending → POST claim → POST complete 全链路', async () => {
    await queue.enqueue({ kind: 'summarize', payload: { knowledge_id: 'K-1' }, id: 'w-http' })

    const pendingRes = await fetch(`${base}/api/work/pending`)
    const pending = (await pendingRes.json()) as { ok: boolean; value: Array<{ id: string }> }
    expect(pending.ok).toBe(true)
    expect(pending.value.map((p) => p.id)).toContain('w-http')

    const claimRes = await post('/api/work/claim', { id: 'w-http', claimed_by: 'host-A' })
    const claim = (await claimRes.json()) as { ok: boolean; value: { attempt_token: string } }
    expect(claim.ok).toBe(true)

    const completeRes = await post('/api/work/complete', {
      id: 'w-http',
      attempt_token: claim.value.attempt_token,
      result: { summary: '摘要' },
    })
    const done = (await completeRes.json()) as { ok: boolean; value: { status: string } }
    expect(done.ok).toBe(true)
    expect(done.value.status).toBe('completed')
  })

  it('重复 claim → 409/错误码 work_already_claimed', async () => {
    await queue.enqueue({ kind: 'classify', payload: {}, id: 'w-dup' })
    await post('/api/work/claim', { id: 'w-dup', claimed_by: 'A' })
    const res = await post('/api/work/claim', { id: 'w-dup', claimed_by: 'B' })
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('work_already_claimed')
  })

  it('complete 结果校验失败 → work_result_invalid', async () => {
    await queue.enqueue({ kind: 'summarize', payload: {}, id: 'w-bad' })
    const claimRes = await post('/api/work/claim', { id: 'w-bad', claimed_by: 'A' })
    const claim = (await claimRes.json()) as { value: { attempt_token: string } }
    const res = await post('/api/work/complete', {
      id: 'w-bad',
      attempt_token: claim.value.attempt_token,
      result: { nope: 1 },
    })
    const body = (await res.json()) as { ok: boolean; error: { code: string } }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('work_result_invalid')
  })

  it('claim 缺参数 → bad_request；fail + reclaim + stats 可用', async () => {
    const bad = await post('/api/work/claim', { id: 'x' })
    expect(bad.status).toBe(400)

    await queue.enqueue({ kind: 'classify', payload: {}, id: 'w-fail' })
    const claimRes = await post('/api/work/claim', { id: 'w-fail', claimed_by: 'A' })
    const claim = (await claimRes.json()) as { value: { attempt_token: string } }
    const failRes = await post('/api/work/fail', {
      id: 'w-fail',
      attempt_token: claim.value.attempt_token,
      error: 'boom',
    })
    const failed = (await failRes.json()) as { ok: boolean; value: { status: string; fail_count: number } }
    expect(failed.value.fail_count).toBe(1)
    expect(failed.value.status).toBe('pending')

    const reclaimRes = await post('/api/work/reclaim', {})
    expect(((await reclaimRes.json()) as { ok: boolean }).ok).toBe(true)

    const statsRes = await fetch(`${base}/api/work/stats`)
    const stats = (await statsRes.json()) as { ok: boolean; value: { pending: number } }
    expect(stats.ok).toBe(true)
    expect(stats.value.pending).toBeGreaterThanOrEqual(1)
  })
})
