import { describe, expect, it } from 'vitest'
import {
  COMPLETION_TERMINALS,
  DERIVED_TRANSITIONS,
  PrismError,
  TaskStateMachine,
  TASK_TRANSITIONS,
} from '../src/index.js'
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

  it('派生转移不在矩阵内，但属系统可产生的合法转移', () => {
    expect(DERIVED_TRANSITIONS).toHaveLength(4)
    for (const t of DERIVED_TRANSITIONS) {
      // 派生转移绝不与权威矩阵重叠（重叠即意味着矩阵定义被污染）
      expect(TaskStateMachine.canTransition(t.from, t.to)).toBe(false)
      expect(TaskStateMachine.isDerivedTransition(t.from, t.to)).toBe(true)
      // 审计口径（系统能否产生）= 矩阵 ∪ 派生
      expect(TaskStateMachine.isLegalTransition(t.from, t.to)).toBe(true)
    }
    // 矩阵转移当然也是合法转移
    expect(TaskStateMachine.isLegalTransition('RUNNING', 'FAILED')).toBe(true)
    expect(TaskStateMachine.isDerivedTransition('RUNNING', 'FAILED')).toBe(false)
    // 两侧都覆盖不到 → 非法
    expect(TaskStateMachine.isLegalTransition('COMPLETED', 'WAITING')).toBe(false)
    expect(TaskStateMachine.isLegalTransition('COMPLETED', 'SKIPPED')).toBe(false)
  })

  it('派生函数输出真实转移事实（plan）', () => {
    const d = dag([task('a', 'FAILED'), task('b', 'WAITING', ['a']), task('c', 'BLOCKED', ['b'])])
    const p = TaskStateMachine.propagateFailure(d, 'a')
    // from 取真实前态：c 的前态是 BLOCKED，不是 WAITING
    expect(p.plan).toEqual([
      { id: 'b', from: 'WAITING', to: 'SKIPPED' },
      { id: 'c', from: 'BLOCKED', to: 'SKIPPED' },
    ])

    const r = dag([task('a', 'COMPLETED'), task('b', 'SKIPPED', ['a']), task('c', 'SKIPPED', ['b'])])
    const re = TaskStateMachine.reactivateSkipped(r, 'a')
    // b 的依赖已就绪 → WAITING；c 的依赖（b）尚未完成 → BLOCKED
    expect(re.plan).toEqual([
      { id: 'b', from: 'SKIPPED', to: 'WAITING' },
      { id: 'c', from: 'SKIPPED', to: 'BLOCKED' },
    ])
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

  it('完成终态判定（COMPLETED / CLOSED）', () => {
    expect(TaskStateMachine.isCompletionTerminal('COMPLETED')).toBe(true)
    expect(TaskStateMachine.isCompletionTerminal('CLOSED')).toBe(true)
    expect(TaskStateMachine.isCompletionTerminal('AWAITING_FEEDBACK')).toBe(false)
    expect(COMPLETION_TERMINALS).toEqual(['COMPLETED', 'CLOSED'])
  })

  /**
   * R-3：成功侧此前**一条派生规则都没有** —— 失败侧有下推（propagateFailure）与回拉
   * （reactivateSkipped）两条，成功侧零条。于是 reactivateSkipped **自己产出**的
   * `SKIPPED→BLOCKED` 在上游最终完成时无人清理，任务永久滞留 BLOCKED。
   */
  it('上游完成解锁依赖已就绪的 BLOCKED 下游（plan 带真实 from→to）', () => {
    const d = dag([task('a', 'COMPLETED'), task('b', 'BLOCKED', ['a']), task('c', 'BLOCKED', ['b'])])
    const r = TaskStateMachine.unblockDownstream(d, 'a')
    // b 依赖 a（已完成）→ WAITING；c 依赖 b（刚变 WAITING，尚未完成）→ 本轮不动
    expect(r.plan).toEqual([{ id: 'b', from: 'BLOCKED', to: 'WAITING' }])
    expect(r.unblocked).toEqual(['b'])
    expect(d.tasks.map((t) => t.status)).toEqual(['COMPLETED', 'WAITING', 'BLOCKED'])
  })

  it('依赖未全部就绪的 BLOCKED 下游不解锁', () => {
    const d = dag([task('a', 'COMPLETED'), task('x', 'RUNNING'), task('b', 'BLOCKED', ['a', 'x'])])
    const r = TaskStateMachine.unblockDownstream(d, 'a')
    expect(r.plan).toEqual([])
    expect(d.tasks[2]?.status).toBe('BLOCKED')
  })

  it('解锁尊重 skip_override，且不碰 SKIPPED / 不可达任务', () => {
    const d = dag([
      task('a', 'COMPLETED'),
      { ...task('b', 'BLOCKED', ['a']), skip_override: true }, // 宿主显式跳过 → 不动
      task('c', 'SKIPPED', ['a']), // SKIPPED 归 reactivateSkipped → 不动
      task('d', 'BLOCKED'), // 与 a 无依赖关系、不可达 → 不动
    ])
    const r = TaskStateMachine.unblockDownstream(d, 'a')
    expect(r.plan).toEqual([])
    expect(d.tasks.map((t) => t.status)).toEqual(['COMPLETED', 'BLOCKED', 'SKIPPED', 'BLOCKED'])
  })

  it('解锁未知任务抛 task_not_found', () => {
    expect(() => TaskStateMachine.unblockDownstream(dag([]), 'nope')).toThrow(PrismError)
  })

  it('未知任务抛 task_not_found', () => {
    expect(() => TaskStateMachine.propagateFailure(dag([]), 'nope')).toThrow(PrismError)
  })
})
