import { describe, expect, it } from 'vitest'

import { openPersistence } from '../src/persistence/persistence.js'
import { TaskLedger, newTaskId } from '../src/tasks/task-ledger.js'

function makeLedger(): { ledger: TaskLedger; close: () => void } {
  const persistence = openPersistence({ inMemory: true })
  return { ledger: new TaskLedger({ persistence }), close: () => persistence.close() }
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

/** 派生规则接线（task-center.md §3，此前 report 不触发、生产断链）。 */
describe('report 派生规则（失败传播 / SKIPPED 重激活）', () => {
  it('FAILED → 下游 WAITING 级联 SKIPPED（含间接下游）', async () => {
    const { ledger, close } = makeLedger()
    await ledger.registerDag({
      ...BASE_DAG,
      dag_id: 'prop-1',
      tasks: [
        { id: 'A', description: 'a', depends_on: [], write_scopes: [] },
        { id: 'B', description: 'b', depends_on: ['A'], write_scopes: [] },
        { id: 'C', description: 'c', depends_on: ['B'], write_scopes: [] },
      ],
    })
    await ledger.report({ task_id: 'A', to_status: 'RUNNING', by: 'x' })
    await ledger.report({ task_id: 'A', to_status: 'FAILED', by: 'x' })
    expect((await ledger.get('B')).status).toBe('SKIPPED')
    expect((await ledger.get('C')).status).toBe('SKIPPED')
    close()
  })

  it('上游 FAILED 重开 WAITING → SKIPPED 下游重激活', async () => {
    const { ledger, close } = makeLedger()
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
    await ledger.report({ task_id: 'A', to_status: 'WAITING', by: 'human' })
    expect((await ledger.get('B')).status).toBe('WAITING')
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
