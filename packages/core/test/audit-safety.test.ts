import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog, CircuitBreaker, LoopGuard, PrismError } from '../src/index.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prism-audit-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AuditLog', () => {
  it('写入并查询合法事件', async () => {
    const log = new AuditLog({ dir })
    await log.record({
      type: 'task.status_changed',
      task_id: 't1',
      from: 'WAITING',
      to: 'RUNNING',
      by: 'dev-1',
    })
    const events = await log.query({ taskId: 't1' })
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('task.status_changed')
  })

  it('拒绝非法状态转移且不落盘', async () => {
    const log = new AuditLog({ dir })
    await expect(
      log.record({
        type: 'task.status_changed',
        task_id: 't1',
        from: 'COMPLETED',
        to: 'WAITING',
        by: 'x',
      }),
    ).rejects.toThrow(PrismError)
    expect(await log.query({})).toHaveLength(0)
  })

  it('拒绝缺必填字段的事件', async () => {
    const log = new AuditLog({ dir })
    await expect(
      log.record({ type: 'knowledge.approved', knowledge_id: 'k1' } as never),
    ).rejects.toThrow(PrismError)
  })
})

describe('CircuitBreaker', () => {
  it('连续失败 3 次进入 BANNED，冷却后恢复', async () => {
    let now = 1_000_000
    const cb = new CircuitBreaker({ now: () => now })
    for (let i = 0; i < 3; i++) await cb.recordFailure('agent', 'dev-1')
    await expect(cb.check('agent', 'dev-1')).rejects.toThrow(PrismError)
    now += 1800_001
    await expect(cb.check('agent', 'dev-1')).rejects.toThrow(PrismError)
    now += 1800_001
    await expect(cb.check('agent', 'dev-1')).resolves.toBeUndefined()
  })

  it('retire 后不复活', async () => {
    const cb = new CircuitBreaker()
    await cb.retire('agent', 'bad')
    await cb.resolve('bad')
    await expect(cb.check('agent', 'bad')).rejects.toThrow(PrismError)
  })
})

describe('LoopGuard', () => {
  it('相同动作连续 3 次触发 loop_detected', () => {
    const g = new LoopGuard({ minOutputGrowth: 0 })
    g.step({ action: 'a', output: 'x'.repeat(100) })
    g.step({ action: 'a', output: 'x'.repeat(200) })
    expect(() => g.step({ action: 'a', output: 'x'.repeat(300) })).toThrow(PrismError)
  })

  it('步数超限触发', () => {
    const g = new LoopGuard({ maxSteps: 2, minOutputGrowth: 0 })
    g.step({ action: 'a', output: 'x'.repeat(100) })
    g.step({ action: 'b', output: 'x'.repeat(200) })
    expect(() => g.step({ action: 'c', output: 'x'.repeat(300) })).toThrow(PrismError)
  })
})
