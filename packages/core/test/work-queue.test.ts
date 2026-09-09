import { describe, expect, it } from 'vitest'

import { openPersistence } from '../src/persistence/persistence.js'
import { WorkQueue, WORK_KINDS, type WorkKind } from '../src/work/work-queue.js'
import { BUILTIN_VALIDATORS } from '../src/work/validators.js'

function makeQueue(overrides: Partial<Parameters<typeof WorkQueue.prototype.constructor>[0]> = {}): {
  queue: WorkQueue
  close: () => void
} {
  const persistence = openPersistence({ inMemory: true })
  const queue = new WorkQueue({ persistence, ...overrides })
  for (const kind of WORK_KINDS) {
    queue.registerValidator(kind, BUILTIN_VALIDATORS[kind])
  }
  return { queue, close: () => persistence.close() }
}

describe('WorkQueue 基本流转（pending → claimed → completed）', () => {
  it('enqueue → pending 列出 → claim 签发 token → complete 落结果', async () => {
    const { queue, close } = makeQueue()
    try {
      const enqueued = await queue.enqueue({ kind: 'summarize', payload: { knowledge_id: 'K-1' } })
      expect(enqueued.status).toBe('pending')
      expect(enqueued.priority).toBe(0)

      const pending = await queue.pending()
      expect(pending.map((w) => w.id)).toEqual([enqueued.id])
      expect(pending[0]?.payload).toEqual({ knowledge_id: 'K-1' })

      const claim = await queue.claim(enqueued.id, 'host-session-1')
      expect(claim.attempt_token).toMatch(/^[0-9a-f-]{36}$/)
      expect(claim.payload).toEqual({ knowledge_id: 'K-1' })
      expect(Date.parse(claim.deadline)).toBeGreaterThan(Date.now())

      // 认领后不再出现在待办
      expect(await queue.pending()).toHaveLength(0)

      const done = await queue.complete({
        id: enqueued.id,
        attempt_token: claim.attempt_token,
        result: { summary: '这是摘要。' },
      })
      expect(done.status).toBe('completed')
      expect(done.result).toEqual({ summary: '这是摘要。' })
      expect(done.attempt_token).toBeNull()
    } finally {
      close()
    }
  })

  it('优先级：priority 大的先出；limit 生效', async () => {
    const { queue, close } = makeQueue()
    try {
      await queue.enqueue({ kind: 'classify', payload: {}, priority: 1, id: 'low' })
      await queue.enqueue({ kind: 'classify', payload: {}, priority: 9, id: 'high' })
      await queue.enqueue({ kind: 'classify', payload: {}, priority: 5, id: 'mid' })
      const pending = await queue.pending({ limit: 2 })
      expect(pending.map((w) => w.id)).toEqual(['high', 'mid'])
    } finally {
      close()
    }
  })

  it('kind / priority_min 过滤', async () => {
    const { queue, close } = makeQueue()
    try {
      await queue.enqueue({ kind: 'embed', payload: {}, priority: 1, id: 'e1' })
      await queue.enqueue({ kind: 'summarize', payload: {}, priority: 5, id: 's1' })
      expect((await queue.pending({ kind: 'embed' })).map((w) => w.id)).toEqual(['e1'])
      expect((await queue.pending({ priority_min: 3 })).map((w) => w.id)).toEqual(['s1'])
    } finally {
      close()
    }
  })
})

describe('并发安全与守卫', () => {
  it('同一任务不能被两个宿主认领（原子迁移，第二次 → work_already_claimed）', async () => {
    const { queue, close } = makeQueue()
    try {
      const w = await queue.enqueue({ kind: 'classify', payload: {} })
      const first = await queue.claim(w.id, 'host-A')
      expect(first.attempt_token).not.toBe('')
      await expect(queue.claim(w.id, 'host-B')).rejects.toMatchObject({
        code: 'work_already_claimed',
      })
    } finally {
      close()
    }
  })

  it('token 不匹配 → work_token_mismatch（迟到回填被拒）', async () => {
    const { queue, close } = makeQueue()
    try {
      const w = await queue.enqueue({ kind: 'summarize', payload: {} })
      await queue.claim(w.id, 'host-A')
      await expect(
        queue.complete({ id: w.id, attempt_token: 'bogus', result: { summary: 'x' } }),
      ).rejects.toMatchObject({ code: 'work_token_mismatch' })
    } finally {
      close()
    }
  })

  it('未知 id → not_found；claim 缺 claimed_by → bad_request', async () => {
    const { queue, close } = makeQueue()
    try {
      await expect(queue.claim('ghost', 'x')).rejects.toMatchObject({ code: 'not_found' })
      const w = await queue.enqueue({ kind: 'classify', payload: {} })
      await expect(queue.claim(w.id, '  ')).rejects.toMatchObject({ code: 'bad_request' })
    } finally {
      close()
    }
  })
})

describe('结果校验（§5：校验失败 → failed 并附原因）', () => {
  it('summarize 缺 summary → work_result_invalid，任务置 failed', async () => {
    const { queue, close } = makeQueue()
    try {
      const w = await queue.enqueue({ kind: 'summarize', payload: {} })
      const claim = await queue.claim(w.id, 'host-A')
      await expect(
        queue.complete({ id: w.id, attempt_token: claim.attempt_token, result: { nope: 1 } }),
      ).rejects.toMatchObject({ code: 'work_result_invalid' })
      const row = queue.get(w.id)
      expect(row.status).toBe('failed')
      expect(row.error).toContain('result_invalid')
    } finally {
      close()
    }
  })

  it('embed 维度不符 → 拒绝；维度正确 → 通过', async () => {
    const { queue, close } = makeQueue()
    try {
      const bad = await queue.enqueue({ kind: 'embed', payload: { dim: 3 } })
      const badClaim = await queue.claim(bad.id, 'h')
      await expect(
        queue.complete({ id: bad.id, attempt_token: badClaim.attempt_token, result: { vector: [1, 2] } }),
      ).rejects.toMatchObject({ code: 'work_result_invalid' })

      const good = await queue.enqueue({ kind: 'embed', payload: { dim: 2 } })
      const goodClaim = await queue.claim(good.id, 'h')
      const done = await queue.complete({
        id: good.id,
        attempt_token: goodClaim.attempt_token,
        result: { vector: [0.1, 0.2] },
      })
      expect(done.status).toBe('completed')
    } finally {
      close()
    }
  })

  it('extract_entities 结构非法 → 拒绝', async () => {
    const { queue, close } = makeQueue()
    try {
      const w = await queue.enqueue({ kind: 'extract_entities', payload: {} })
      const claim = await queue.claim(w.id, 'h')
      await expect(
        queue.complete({ id: w.id, attempt_token: claim.attempt_token, result: { entities: [{ id: 'x' }] } }),
      ).rejects.toMatchObject({ code: 'work_result_invalid' })
    } finally {
      close()
    }
  })
})

describe('护栏（§6：重试 / 超时回收 / 积压上限）', () => {
  it('fail 未超上限 → 回收为 pending 可再认领；超上限 → failed 待人工', async () => {
    const { queue, close } = makeQueue({ maxRetries: 2 })
    try {
      const w = await queue.enqueue({ kind: 'classify', payload: {} })
      const c1 = await queue.claim(w.id, 'h1')
      const afterFail1 = await queue.fail(w.id, c1.attempt_token, 'boom-1')
      expect(afterFail1.status).toBe('pending')
      expect(afterFail1.fail_count).toBe(1)

      const c2 = await queue.claim(w.id, 'h2')
      const afterFail2 = await queue.fail(w.id, c2.attempt_token, 'boom-2')
      expect(afterFail2.status).toBe('failed')
      expect(afterFail2.fail_count).toBe(2)
      // 超上限后不再回 pending
      expect(await queue.pending()).toHaveLength(0)
    } finally {
      close()
    }
  })

  it('reclaimExpired：认领超时 → 回收为 pending（token 作废）', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const persistence = openPersistence({ inMemory: true })
    const queue = new WorkQueue({
      persistence,
      claimTimeoutMs: 1000,
      now: () => new Date(nowMs),
    })
    try {
      const w = await queue.enqueue({ kind: 'classify', payload: {} })
      const claim = await queue.claim(w.id, 'host-A')
      // 未超时 → 不回收
      expect((await queue.reclaimExpired()).reclaimed).toEqual([])
      // 越过截止时刻
      nowMs += 2000
      expect((await queue.reclaimExpired()).reclaimed).toEqual([w.id])
      const row = queue.get(w.id)
      expect(row.status).toBe('pending')
      expect(row.attempt_token).toBeNull()
      // 旧 token 回填被拒（已被回收）
      await expect(
        queue.complete({ id: w.id, attempt_token: claim.attempt_token, result: { labels: ['x'] } }),
      ).rejects.toMatchObject({ code: 'bad_request' })
    } finally {
      persistence.close()
    }
  })

  it('积压上限：超过 backlogLimit → work_backlog_full', async () => {
    const { queue, close } = makeQueue({ backlogLimit: 2 })
    try {
      await queue.enqueue({ kind: 'classify', payload: {}, id: 'a' })
      await queue.enqueue({ kind: 'classify', payload: {}, id: 'b' })
      await expect(queue.enqueue({ kind: 'classify', payload: {}, id: 'c' })).rejects.toMatchObject({
        code: 'work_backlog_full',
      })
      // 已完成的释放额度
      const claim = await queue.claim('a', 'h')
      await queue.complete({ id: 'a', attempt_token: claim.attempt_token, result: { labels: ['x'] } })
      await expect(queue.enqueue({ kind: 'classify', payload: {}, id: 'c' })).resolves.toMatchObject({
        id: 'c',
      })
    } finally {
      close()
    }
  })

  it('stats：队列水位与最老待办年龄', async () => {
    const { queue, close } = makeQueue()
    try {
      await queue.enqueue({ kind: 'classify', payload: {}, id: 'a' })
      await queue.enqueue({ kind: 'embed', payload: {}, id: 'b' })
      const claim = await queue.claim('a', 'h')
      await queue.complete({ id: 'a', attempt_token: claim.attempt_token, result: { labels: ['x'] } })
      const stats = await queue.stats()
      expect(stats.pending).toBe(1)
      expect(stats.completed).toBe(1)
      expect(stats.oldest_pending_age_ms).toBeGreaterThanOrEqual(0)
    } finally {
      close()
    }
  })

  it('幂等入队：同 id 重复 enqueue 返回既有记录，不重复入队', async () => {
    const { queue, close } = makeQueue()
    try {
      const first = await queue.enqueue({ kind: 'classify', payload: { v: 1 }, id: 'dup' })
      const second = await queue.enqueue({ kind: 'classify', payload: { v: 2 }, id: 'dup' })
      expect(second.created_at).toBe(first.created_at)
      expect(second.payload).toEqual({ v: 1 }) // 既有记录优先
      expect(await queue.pending()).toHaveLength(1)
    } finally {
      close()
    }
  })

  it('非法 kind / 非整数 priority → bad_request', async () => {
    const { queue, close } = makeQueue()
    try {
      await expect(queue.enqueue({ kind: 'bogus' as WorkKind, payload: {} })).rejects.toMatchObject({
        code: 'bad_request',
      })
      await expect(
        queue.enqueue({ kind: 'classify', payload: {}, priority: 1.5 }),
      ).rejects.toMatchObject({ code: 'bad_request' })
    } finally {
      close()
    }
  })
})
