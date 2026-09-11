import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AuditLog } from '../src/index.js'
import { openPersistence } from '../src/persistence/persistence.js'
import { TaskLedger, newTaskId } from '../src/tasks/task-ledger.js'

let auditDir: string
beforeEach(async () => {
  auditDir = await mkdtemp(join(tmpdir(), 'prism-ledger-audit-'))
})
afterEach(async () => {
  await rm(auditDir, { recursive: true, force: true })
})

/**
 * 台账装配：**注入 AuditLog**，与生产三处装配（cli / http / mcp）保持一致。
 *
 * 这里曾经一律不传 audit，`this.#audit?.record()` 短路成空操作——于是
 * 「级联转移合法、但审计用错口径把它拒掉」这类缺陷在单测里永远不现形，
 * 只在真机 CLI/MCP 上报错（D-5 的逃逸原因）。默认注入是这张网的根。
 */
function makeLedger(): { ledger: TaskLedger; audit: AuditLog; close: () => void } {
  const persistence = openPersistence({ inMemory: true })
  const audit = new AuditLog({ dir: auditDir, queue: persistence.queue })
  return {
    ledger: new TaskLedger({ persistence, audit }),
    audit,
    close: () => persistence.close(),
  }
}

/** 把审计事件压成 `from→to` 字符串，便于断言。 */
async function auditTransitions(audit: AuditLog, taskId?: string): Promise<string[]> {
  const events = await audit.query({
    types: ['task.status_changed'],
    ...(taskId !== undefined ? { taskId } : {}),
    order: 'asc',
  })
  return events.map((e) => {
    const t = e as { task_id: string; from: string; to: string }
    return `${t.task_id}:${t.from}→${t.to}`
  })
}

const BASE_DAG = {
  dag_id: 'dag-1',
  session_id: 'sess-1',
  team_id: 'core-dev',
  project_id: 'prism',
  version: 'v1',
  difficulty: 'normal',
}

describe('TaskLedger 批量登记（被动记录，不触发执行）', () => {
  it('登记 DAG → 任务与依赖边落库；幂等重复登记不重复写', async () => {
    const { ledger, close } = makeLedger()
    try {
      const result = await ledger.registerDag({
        ...BASE_DAG,
        tasks: [
          { id: 't1', description: '设计' },
          { id: 't2', description: '开发', depends_on: ['t1'] },
          { id: 't3', description: '测试', depends_on: ['t2'], write_scopes: ['packages/knowledge'] },
        ],
      })
      expect(result).toEqual({ dag_id: 'dag-1', tasks: 3, edges: 2 })

      const dag = ledger.dag('dag-1')
      expect(dag.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
      expect(dag.edges).toEqual([
        { from: 't1', to: 't2' },
        { from: 't2', to: 't3' },
      ])
      expect(dag.tasks.every((t) => t.status === 'WAITING')).toBe(true)

      // 幂等
      const again = await ledger.registerDag({ ...BASE_DAG, tasks: [{ id: 't1', description: '设计' }] })
      expect(again).toEqual({ dag_id: 'dag-1', tasks: 3, edges: 2 })
    } finally {
      close()
    }
  })

  it('校验：依赖不在本批 / 自依赖 / 有环 / 重复 id / 缺字段 → bad_request', async () => {
    const { ledger, close } = makeLedger()
    try {
      await expect(
        ledger.registerDag({ ...BASE_DAG, dag_id: 'd1', tasks: [{ id: 'a', description: 'A', depends_on: ['ghost'] }] }),
      ).rejects.toMatchObject({ code: 'bad_request' })

      await expect(
        ledger.registerDag({ ...BASE_DAG, dag_id: 'd2', tasks: [{ id: 'a', description: 'A', depends_on: ['a'] }] }),
      ).rejects.toMatchObject({ code: 'bad_request' })

      // 环：a→b→a
      await expect(
        ledger.registerDag({
          ...BASE_DAG,
          dag_id: 'd3',
          tasks: [
            { id: 'a', description: 'A', depends_on: ['b'] },
            { id: 'b', description: 'B', depends_on: ['a'] },
          ],
        }),
      ).rejects.toMatchObject({ code: 'bad_request' })

      await expect(
        ledger.registerDag({
          ...BASE_DAG,
          dag_id: 'd4',
          tasks: [
            { id: 'a', description: 'A' },
            { id: 'a', description: 'dup' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'bad_request' })

      await expect(ledger.registerDag({ ...BASE_DAG, dag_id: '', tasks: [] })).rejects.toMatchObject({
        code: 'bad_request',
      })
    } finally {
      close()
    }
  })

  it('合法 DAG 通过环检测（菱形依赖不算环）', async () => {
    const { ledger, close } = makeLedger()
    try {
      const result = await ledger.registerDag({
        ...BASE_DAG,
        dag_id: 'diamond',
        tasks: [
          { id: 'a', description: 'A' },
          { id: 'b', description: 'B', depends_on: ['a'] },
          { id: 'c', description: 'C', depends_on: ['a'] },
          { id: 'd', description: 'D', depends_on: ['b', 'c'] },
        ],
      })
      expect(result.tasks).toBe(4)
      expect(result.edges).toBe(4)
    } finally {
      close()
    }
  })
})

describe('TaskLedger 状态回报（状态机校验 + 乐观并发 + 审计）', () => {
  async function seed(ledger: TaskLedger): Promise<void> {
    await ledger.registerDag({
      ...BASE_DAG,
      tasks: [
        { id: 't1', description: '设计' },
        { id: 't2', description: '开发', depends_on: ['t1'] },
      ],
    })
  }

  it('合法转移落库：WAITING → RUNNING → COMPLETED，revision 递增', async () => {
    const { ledger, close } = makeLedger()
    try {
      await seed(ledger)
      const running = await ledger.report({ task_id: 't1', to_status: 'RUNNING', by: 'dev-1' })
      expect(running.status).toBe('RUNNING')
      expect(running.revision).toBe(1)

      const done = await ledger.report({
        task_id: 't1',
        to_status: 'COMPLETED',
        by: 'dev-1',
        result: { summary: 'done' },
      })
      expect(done.status).toBe('COMPLETED')
      expect(done.revision).toBe(2)
      expect(done.result).toBe(JSON.stringify({ summary: 'done' }))
    } finally {
      close()
    }
  })

  it('非法转移 → invalid_status_transition（不落库）', async () => {
    const { ledger, close } = makeLedger()
    try {
      await seed(ledger)
      // WAITING → COMPLETED 不在 32 条矩阵里
      await expect(
        ledger.report({ task_id: 't1', to_status: 'COMPLETED', by: 'dev-1' }),
      ).rejects.toMatchObject({ code: 'invalid_status_transition' })
      expect(ledger.get('t1').status).toBe('WAITING')
      expect(ledger.get('t1').revision).toBe(0)
    } finally {
      close()
    }
  })

  it('from_status 不符 → task_stale_revision（防重复回报）', async () => {
    const { ledger, close } = makeLedger()
    try {
      await seed(ledger)
      await ledger.report({ task_id: 't1', to_status: 'RUNNING', by: 'dev-1' })
      await expect(
        ledger.report({ task_id: 't1', from_status: 'WAITING', to_status: 'RUNNING', by: 'dev-2' }),
      ).rejects.toMatchObject({ code: 'task_stale_revision' })
    } finally {
      close()
    }
  })

  it('expected_revision 不符 → task_stale_revision', async () => {
    const { ledger, close } = makeLedger()
    try {
      await seed(ledger)
      await ledger.report({ task_id: 't1', to_status: 'RUNNING', by: 'dev-1' })
      await expect(
        ledger.report({ task_id: 't1', to_status: 'COMPLETED', by: 'dev-1', expected_revision: 0 }),
      ).rejects.toMatchObject({ code: 'task_stale_revision' })
      // 正确的 revision 通过
      await expect(
        ledger.report({ task_id: 't1', to_status: 'COMPLETED', by: 'dev-1', expected_revision: 1 }),
      ).resolves.toMatchObject({ status: 'COMPLETED' })
    } finally {
      close()
    }
  })

  it('未知任务 → not_found；缺 by → bad_request；非法状态 → bad_request', async () => {
    const { ledger, close } = makeLedger()
    try {
      await seed(ledger)
      await expect(ledger.report({ task_id: 'ghost', to_status: 'RUNNING', by: 'x' })).rejects.toMatchObject({
        code: 'not_found',
      })
      await expect(ledger.report({ task_id: 't1', to_status: 'RUNNING', by: '  ' })).rejects.toMatchObject({
        code: 'bad_request',
      })
      await expect(
        ledger.report({ task_id: 't1', to_status: 'BOGUS' as never, by: 'x' }),
      ).rejects.toMatchObject({ code: 'bad_request' })
    } finally {
      close()
    }
  })

  it('list / stats 过滤与计数', async () => {
    const { ledger, close } = makeLedger()
    try {
      await seed(ledger)
      await ledger.report({ task_id: 't1', to_status: 'RUNNING', by: 'dev-1' })
      expect(ledger.list({ dag_id: 'dag-1' })).toHaveLength(2)
      expect(ledger.list({ status: 'RUNNING' }).map((t) => t.id)).toEqual(['t1'])
      const stats = ledger.stats()
      expect(stats.total).toBe(2)
      expect(stats.dags).toBe(1)
      expect(stats.by_status['RUNNING']).toBe(1)
      expect(stats.by_status['WAITING']).toBe(1)
    } finally {
      close()
    }
  })

  it('dag() 未知 DAG → not_found；newTaskId 格式', () => {
    const { ledger, close } = makeLedger()
    try {
      expect(() => ledger.dag('ghost')).toThrowError(expect.objectContaining({ code: 'not_found' }))
      expect(newTaskId()).toMatch(/^task-[0-9a-f]{8}$/)
    } finally {
      close()
    }
  })
})

/**
 * 原子性：report 是「先算全量转移计划 → 全量校验 → 单事务落库 → 批量审计」。
 * 被拒的回报必须**零副作用**——旧实现先改主任务再审计，而审计拒绝级联转移，
 * 于是「调用方看到失败、状态却已经变了」（revision 被推高、下游被级联）。
 */
describe('report 原子性（拒绝 ⇒ 零副作用）', () => {
  async function seedChain(ledger: TaskLedger, dagId: string): Promise<void> {
    await ledger.registerDag({
      ...BASE_DAG,
      dag_id: dagId,
      tasks: [
        { id: 'A', description: 'a', depends_on: [], write_scopes: [] },
        { id: 'B', description: 'b', depends_on: ['A'], write_scopes: [] },
      ],
    })
  }

  it('非法转移被拒 → 主任务与下游都不动，审计零痕迹', async () => {
    const { ledger, audit, close } = makeLedger()
    await seedChain(ledger, 'atomic-1')
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })

    // RUNNING → SKIPPED 既不在 32 条矩阵内，也不在派生规则内（派生只从 WAITING/BLOCKED 出发）
    await expect(
      ledger.report({ task_id: 'A', to_status: 'SKIPPED', by: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_status_transition' })

    expect(ledger.get('A').status).toBe('RUNNING')
    expect(ledger.get('A').revision).toBe(1)
    expect(ledger.get('B').status).toBe('WAITING')
    expect(ledger.get('B').revision).toBe(0)
    expect(await auditTransitions(audit)).toEqual(['A:WAITING→RUNNING'])
    close()
  })

  it('乐观并发冲突被拒 → 不顺手把下游级联掉', async () => {
    const { ledger, audit, close } = makeLedger()
    await seedChain(ledger, 'atomic-2')
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })

    // expected_revision 过期：这次 FAILED 必须整体不生效（若先写主任务再校验并发，
    // A 会变成 FAILED、B 会被级联成 SKIPPED，而调用方收到的是「失败」）
    await expect(
      ledger.report({ task_id: 'A', to_status: 'FAILED', by: 'x', expected_revision: 0 }),
    ).rejects.toMatchObject({ code: 'task_stale_revision' })

    expect(ledger.get('A').status).toBe('RUNNING')
    expect(ledger.get('A').revision).toBe(1)
    expect(ledger.get('B').status).toBe('WAITING')
    expect(await auditTransitions(audit)).toEqual(['A:WAITING→RUNNING'])
    close()
  })

  it('FAILED → SKIPPED 时触发任务自身不被「重激活」（不能既是因又是果）', async () => {
    const { ledger, close } = makeLedger()
    await seedChain(ledger, 'atomic-3')
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'A', to_status: 'FAILED', by: 'x' })
    expect(ledger.get('B').status).toBe('SKIPPED')

    // A 从 FAILED 转到 SKIPPED（放弃重试）。若把 A 也算进「重激活候选」，
    // 它会在同一次回报里被自己翻回 WAITING。
    await ledger.report({ task_id: 'A', to_status: 'SKIPPED', by: 'human' })
    expect(ledger.get('A').status).toBe('SKIPPED')
    close()
  })
})

/** 派生规则接线（task-center.md §3，此前 report 不触发、生产断链）。 */
describe('report 派生规则（失败传播 / SKIPPED 重激活）', () => {
  it('FAILED → 下游 WAITING/BLOCKED 级联 SKIPPED（含间接下游），派生转移照常落审计', async () => {
    const { ledger, audit, close } = makeLedger()
    await ledger.registerDag({
      ...BASE_DAG,
      dag_id: 'prop-1',
      tasks: [
        { id: 'A', description: 'a', depends_on: [], write_scopes: [] },
        { id: 'B', description: 'b', depends_on: ['A'], write_scopes: [] },
        { id: 'C', description: 'c', depends_on: ['B'], write_scopes: [] },
      ],
    })
    // 让 C 真实处于 BLOCKED（宿主如实登记「依赖未就绪」），否则级联只会产出 WAITING→SKIPPED，
    // 「级联写伪造 from」这条缺陷就测不出来。
    await ledger.report({ task_id: 'C', to_status: 'BLOCKED', by: 'x' })
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'A', to_status: 'FAILED', by: 'x' })
    expect(ledger.get('B').status).toBe('SKIPPED')
    expect(ledger.get('C').status).toBe('SKIPPED')

    // 审计必须放行派生转移（WAITING/BLOCKED→SKIPPED 不在 32 条矩阵内）：
    // 这几行是 D-5 的回归网——改用纯矩阵口径校验时，上面的 report(A, FAILED) 会直接抛错。
    // from 也必须是**真实前态**：C 是 BLOCKED→SKIPPED，不是被硬编码成的 WAITING→SKIPPED。
    expect(await auditTransitions(audit)).toEqual([
      'C:WAITING→BLOCKED', // 准备：宿主如实登记 C 被阻塞
      'A:WAITING→RUNNING',
      'A:RUNNING→FAILED',
      'B:WAITING→SKIPPED',
      'C:BLOCKED→SKIPPED',
    ])
    close()
  })

  it('上游 FAILED 重开 WAITING → 下游按「依赖是否就绪」重激活（就绪才 WAITING）', async () => {
    const { ledger, audit, close } = makeLedger()
    await ledger.registerDag({
      ...BASE_DAG,
      dag_id: 'prop-2',
      tasks: [
        { id: 'A', description: 'a', depends_on: [], write_scopes: [] },
        { id: 'B', description: 'b', depends_on: ['A'], write_scopes: [] },
      ],
    })
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'A', to_status: 'FAILED', by: 'x' })
    expect((await ledger.get('B')).status).toBe('SKIPPED')
    // 重开 A 只是「重新排队」，A 并未完成 → B 的依赖未就绪 → BLOCKED。
    // （旧实现把状态机算出的 BLOCKED 写死成 WAITING，等于向宿主谎报「B 可执行」。）
    await ledger.report({ task_id: 'A', to_status: 'WAITING', by: 'human' })
    expect((await ledger.get('A')).status).toBe('WAITING')
    expect((await ledger.get('B')).status).toBe('BLOCKED')
    expect(await auditTransitions(audit, 'B')).toEqual(['B:WAITING→SKIPPED', 'B:SKIPPED→BLOCKED'])
    close()
  })

  it('BANNED / LOOP_TERMINATED 同样向下游传播（触发集取失败终态全集）', async () => {
    const { ledger, close } = makeLedger()
    await ledger.registerDag({
      ...BASE_DAG,
      dag_id: 'prop-4',
      tasks: [
        { id: 'A', description: 'a', depends_on: [], write_scopes: [] },
        { id: 'B', description: 'b', depends_on: ['A'], write_scopes: [] },
        { id: 'C', description: 'c', depends_on: [], write_scopes: [] },
        { id: 'D', description: 'd', depends_on: ['C'], write_scopes: [] },
      ],
    })
    // BANNED：旧实现只认 FAILED|CANCELLED，B 会永久停在 WAITING
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'A', to_status: 'BANNED', by: 'x' })
    expect(ledger.get('B').status).toBe('SKIPPED')

    // LOOP_TERMINATED：同在 FAILURE_TERMINALS 内，同样必须传播
    await ledger.report({ task_id: 'C', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'C', to_status: 'LOOP_TERMINATED', by: 'x' })
    expect(ledger.get('D').status).toBe('SKIPPED')
    close()
  })

  it('COMPLETED 不触发传播；无下游的 FAILED 传播为空', async () => {
    const { ledger, close } = makeLedger()
    await ledger.registerDag({
      ...BASE_DAG,
      dag_id: 'prop-3',
      tasks: [
        { id: 'A', description: 'a', depends_on: [], write_scopes: [] },
        { id: 'B', description: 'b', depends_on: [], write_scopes: [] },
      ],
    })
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'A', to_status: 'COMPLETED', by: 'x' })
    expect((await ledger.get('B')).status).toBe('WAITING')
    await ledger.report({ task_id: 'B', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'B', to_status: 'FAILED', by: 'x' })
    expect((await ledger.get('B')).status).toBe('FAILED') // 无下游，不影响别人
    close()
  })
})
