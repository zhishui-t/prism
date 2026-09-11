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

  it('放行派生转移（失败传播 / SKIPPED 重激活），仍拒绝两者之外的转移', async () => {
    const log = new AuditLog({ dir })
    // 失败传播：WAITING/BLOCKED → SKIPPED，不在 32 条矩阵内，但系统会产生
    await log.record({ type: 'task.status_changed', task_id: 't2', from: 'WAITING', to: 'SKIPPED', by: 'x' })
    await log.record({ type: 'task.status_changed', task_id: 't3', from: 'BLOCKED', to: 'SKIPPED', by: 'x' })
    // SKIPPED 重激活：→ WAITING / → BLOCKED
    await log.record({ type: 'task.status_changed', task_id: 't4', from: 'SKIPPED', to: 'WAITING', by: 'x' })
    await log.record({ type: 'task.status_changed', task_id: 't5', from: 'SKIPPED', to: 'BLOCKED', by: 'x' })
    expect(await log.query({})).toHaveLength(4)

    // 矩阵与派生都覆盖不到 → 仍被拒，且不落盘
    await expect(
      log.record({ type: 'task.status_changed', task_id: 't6', from: 'COMPLETED', to: 'SKIPPED', by: 'x' }),
    ).rejects.toThrow(PrismError)
    await expect(
      log.record({ type: 'task.status_changed', task_id: 't7', from: 'COMPLETED', to: 'WAITING', by: 'x' }),
    ).rejects.toThrow(PrismError)
    expect(await log.query({})).toHaveLength(4)
  })

  it('recordMany：全量校验通过才一次落盘；半批非法 → 整批零落盘', async () => {
    const log = new AuditLog({ dir })
    const written = await log.recordMany([
      { type: 'task.status_changed', task_id: 'a1', from: 'WAITING', to: 'RUNNING', by: 'x' },
      { type: 'task.status_changed', task_id: 'a2', from: 'WAITING', to: 'SKIPPED', by: 'x' },
    ])
    expect(written).toHaveLength(2)
    expect(await log.query({})).toHaveLength(2)

    // 第二条非法 → 第一条也不许落盘（级联场景下不允许「写一半」）
    await expect(
      log.recordMany([
        { type: 'task.status_changed', task_id: 'a3', from: 'WAITING', to: 'RUNNING', by: 'x' },
        { type: 'task.status_changed', task_id: 'a4', from: 'COMPLETED', to: 'WAITING', by: 'x' },
      ]),
    ).rejects.toThrow(PrismError)
    expect(await log.query({})).toHaveLength(2)
    expect(await log.query({ taskId: 'a3' })).toHaveLength(0)

    expect(await log.recordMany([])).toEqual([])
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
