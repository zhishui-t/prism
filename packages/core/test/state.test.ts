import { describe, expect, it } from 'vitest'
import { PrismError, TaskStateMachine, TASK_TRANSITIONS } from '../src/index.js'
import type { TaskDag, TaskRecord } from '../src/index.js'

function task(id: string, status: TaskRecord['status'], deps: string[] = []): TaskRecord {
  return {
    id,
    dag_id: 'dag-1',
    session_id: 's1',
    team_id: 't1',
    project_id: 'p1',
    version: 'v1',
    description: id,
    stage: '',
    dependencies: deps,
    write_scopes: [],
    revision: 0,
    attempt_token: null,
    assigned_agent: null,
    executor: null,
    status,
    revision_count: 0,
    max_revisions: 5,
    feedback_timeout_seconds: 1800,
    feedback_expires_at: null,
    skip_override: false,
    skip_reason: null,
    fail_count: 0,
    result: null,
    error_type: null,
    created_at: '2026-09-08T00:00:00Z',
    updated_at: '2026-09-08T00:00:00Z',
  }
}

function dag(tasks: TaskRecord[], edges: TaskDag['edges'] = []): TaskDag {
  return { dag_id: 'dag-1', tasks, edges, status: 'running' }
}

describe('TaskStateMachine', () => {
  it('矩阵共 32 条合法转移', () => {
    expect(TASK_TRANSITIONS).toHaveLength(32)
  })

  it('合法转移通过，非法转移抛错', () => {
    expect(TaskStateMachine.canTransition('WAITING', 'RUNNING')).toBe(true)
    expect(TaskStateMachine.transition('WAITING', 'RUNNING')).toBe('RUNNING')
    expect(TaskStateMachine.canTransition('COMPLETED', 'WAITING')).toBe(false)
    expect(() => TaskStateMachine.transition('COMPLETED', 'WAITING')).toThrow(PrismError)
  })

  it('失败终态判定', () => {
    expect(TaskStateMachine.isFailureTerminal('FAILED')).toBe(true)
    expect(TaskStateMachine.isFailureTerminal('COMPLETED')).toBe(false)
  })

  it('失败向下游传播 SKIPPED', () => {
    const d = dag([task('a', 'FAILED'), task('b', 'WAITING', ['a']), task('c', 'BLOCKED', ['b'])])
    const r = TaskStateMachine.propagateFailure(d, 'a')
    expect(r.skipped).toEqual(['b', 'c'])
    expect(d.tasks.map((t) => t.status)).toEqual(['FAILED', 'SKIPPED', 'SKIPPED'])
  })

  it('上游重试后重激活 SKIPPED 下游', () => {
    const d = dag([
      task('a', 'COMPLETED'),
      task('b', 'SKIPPED', ['a']),
      task('c', 'SKIPPED', ['b']),
    ])
    const r = TaskStateMachine.reactivateSkipped(d, 'a')
    expect(r.reactivated).toContain('b')
    expect(d.tasks[1]?.status).toBe('WAITING')
  })

  it('未知任务抛 task_not_found', () => {
    expect(() => TaskStateMachine.propagateFailure(dag([]), 'nope')).toThrow(PrismError)
  })
})
