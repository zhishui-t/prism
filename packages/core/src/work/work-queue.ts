/**
 * 工作队列服务（work-queue.md）：**Prism 不调 LLM**，需要 LLM 的工作落成
 * work_request 由宿主拉取执行。
 *
 * 状态机（§3.1）：
 *   pending ──claim──→ claimed ──complete──→ completed
 *      ↑                  ├──fail──→ failed
 *      └──超时回收────────┘
 *
 * 护栏（§6）：积压上限 / 优先级 / 认领超时回收 / 失败重试上限。
 * 并发安全：claim 用 `UPDATE ... WHERE status='pending'` 原子迁移 + 签发 attempt token，
 * 同一任务不会被两个宿主认领（`changes === 0` 即认领失败）。
 */
import { randomUUID } from 'node:crypto'

import type { AuditLog } from '../audit/audit-log.js'
import type { PrismPersistence } from '../persistence/persistence.js'
import { PrismError } from '../state/errors.js'

/** 工作类型（§1）。 */
export type WorkKind = 'embed' | 'summarize' | 'classify' | 'extract_entities' | 'diagram_ir'

export const WORK_KINDS: readonly WorkKind[] = [
  'embed',
  'summarize',
  'classify',
  'extract_entities',
  'diagram_ir',
]

/** 工作状态（§3.1）。 */
export type WorkStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'expired'

export interface WorkRequest {
  id: string
  kind: WorkKind
  /** 输入与期望（原样 JSON） */
  payload: unknown
  status: WorkStatus
  priority: number
  attempt_token: string | null
  claimed_by: string | null
  claimed_at: string | null
  /** 认领截止时刻（超时回收依据） */
  claimed_deadline: string | null
  fail_count: number
  result: unknown
  error: string | null
  created_at: string
  updated_at: string
}

export interface WorkEnqueueInput {
  kind: WorkKind
  payload: unknown
  /** 越大越优先，默认 0 */
  priority?: number
  /** 指定 id（幂等重放/测试）；不传自动生成 */
  id?: string
}

export interface WorkPendingQuery {
  kind?: WorkKind
  limit?: number
  priority_min?: number
}

export interface WorkClaimResult {
  id: string
  attempt_token: string
  payload: unknown
  /** 认领截止时刻（ISO） */
  deadline: string
}

export interface WorkCompleteInput {
  id: string
  attempt_token: string
  result: unknown
  /** 回填者标识（审计用） */
  by?: string
}

export interface WorkQueueOptions {
  persistence: PrismPersistence
  audit?: AuditLog
  /** 认领超时（毫秒），默认 30 分钟；超时后 reclaim 回收为 pending */
  claimTimeoutMs?: number
  /** 积压上限（pending+claimed 总数），默认 1000；超限 enqueue 抛 work_backlog_full */
  backlogLimit?: number
  /** 同一任务失败上限，超过后不再自动重试，标记待人工（仍置 failed），默认 3 */
  maxRetries?: number
  now?: () => Date
  idFactory?: () => string
}

/** 结果校验器：返回 null 表示通过，否则返回原因。 */
export type WorkResultValidator = (payload: unknown, result: unknown) => string | null

interface WorkRow {
  id: string
  kind: string
  payload: string
  status: string
  priority: number
  attempt_token: string | null
  claimed_by: string | null
  claimed_at: string | null
  claimed_deadline: string | null
  fail_count: number
  result: string | null
  error: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = `id, kind, payload, status, priority, attempt_token, claimed_by, claimed_at,
  claimed_deadline, fail_count, result, error, created_at, updated_at`

/** 工作队列服务。 */
export class WorkQueue {
  readonly #persistence: PrismPersistence
  readonly #audit: AuditLog | undefined
  readonly #claimTimeoutMs: number
  readonly #backlogLimit: number
  readonly #maxRetries: number
  readonly #now: () => Date
  readonly #idFactory: () => string
  readonly #validators = new Map<WorkKind, WorkResultValidator>()

  constructor(options: WorkQueueOptions) {
    this.#persistence = options.persistence
    this.#audit = options.audit
    this.#claimTimeoutMs = options.claimTimeoutMs ?? 30 * 60 * 1000
    this.#backlogLimit = options.backlogLimit ?? 1000
    this.#maxRetries = options.maxRetries ?? 3
    this.#now = options.now ?? (() => new Date())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  /** 注册某类工作的结果校验器（§5）；重复注册覆盖。 */
  registerValidator(kind: WorkKind, validator: WorkResultValidator): void {
    this.#validators.set(kind, validator)
  }

  /**
   * 入队（§6 积压护栏）：超过上限抛 work_backlog_full。
   * 幂等：同 id 已存在 → 返回既有记录，不重复入队。
   */
  async enqueue(input: WorkEnqueueInput): Promise<WorkRequest> {
    if (!WORK_KINDS.includes(input.kind)) {
      throw new PrismError('bad_request', `非法工作类型: ${String(input.kind)}`, {
        allowed: WORK_KINDS,
      })
    }
    const nowIso = this.#now().toISOString()
    const id = input.id ?? this.#idFactory()
    const priority = input.priority ?? 0
    if (!Number.isInteger(priority)) {
      throw new PrismError('bad_request', `priority 必须为整数: ${String(input.priority)}`)
    }
    const payload = JSON.stringify(input.payload ?? null)

    const row = await this.#persistence.knowledge.run((raw) => {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const existing = raw.prepare(`SELECT ${COLUMNS} FROM work_requests WHERE id = ?`).get(id) as
          | WorkRow
          | undefined
        if (existing !== undefined) {
          raw.exec('COMMIT')
          return existing
        }
        const backlog = (
          raw
            .prepare("SELECT COUNT(*) AS c FROM work_requests WHERE status IN ('pending', 'claimed')")
            .get() as { c: number }
        ).c
        if (backlog >= this.#backlogLimit) {
          throw new PrismError(
            'work_backlog_full',
            `工作队列积压已达上限 ${this.#backlogLimit}，停止入队（先让宿主消费）`,
            { backlog, limit: this.#backlogLimit },
          )
        }
        raw
          .prepare(
            `INSERT INTO work_requests (id, kind, payload, status, priority, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(id, input.kind, payload, priority, nowIso, nowIso)
        const created = raw.prepare(`SELECT ${COLUMNS} FROM work_requests WHERE id = ?`).get(id) as unknown as WorkRow
        raw.exec('COMMIT')
        return created
      } catch (error) {
        try {
          raw.exec('ROLLBACK')
        } catch {
          // 事务已终止时忽略
        }
        throw error
      }
    })

    // 幂等重放（已存在）不重复记审计
    if (row.created_at === nowIso) {
      await this.#audit?.record({ type: 'work.enqueued', request_id: id, kind: input.kind })
    }
    return this.#toRequest(row)
  }

  /** 列出待办（§4，按优先级降序、创建时间升序）。 */
  async pending(query: WorkPendingQuery = {}): Promise<WorkRequest[]> {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 20)), 200)
    const clauses = ["status = 'pending'"]
    const params: Array<string | number> = []
    if (query.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(query.kind)
    }
    if (query.priority_min !== undefined) {
      clauses.push('priority >= ?')
      params.push(query.priority_min)
    }
    const rows = this.#persistence.knowledge.raw
      .prepare(
        `SELECT ${COLUMNS} FROM work_requests WHERE ${clauses.join(' AND ')}
         ORDER BY priority DESC, created_at ASC LIMIT ?`,
      )
      .all(...params, limit) as unknown as WorkRow[]
    return rows.map((row) => this.#toRequest(row))
  }

  /**
   * 认领（§4）：原子迁移 pending→claimed + 签发 attempt token。
   * 已被他人认领 → 抛 work_already_claimed（并发安全：changes=0 即失败）。
   */
  async claim(id: string, claimedBy: string): Promise<WorkClaimResult> {
    if (claimedBy.trim() === '') {
      throw new PrismError('bad_request', 'claim 需要 claimed_by 标识')
    }
    const now = this.#now()
    const nowIso = now.toISOString()
    const deadline = new Date(now.getTime() + this.#claimTimeoutMs).toISOString()
    const token = randomUUID()

    const changes = await this.#persistence.knowledge.run((raw) =>
      Number(
        raw
          .prepare(
            `UPDATE work_requests
             SET status = 'claimed', attempt_token = ?, claimed_by = ?, claimed_at = ?,
                 claimed_deadline = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(token, claimedBy, nowIso, deadline, nowIso, id).changes,
      ),
    )
    if (changes === 0) {
      const exists = this.#persistence.knowledge.raw
        .prepare('SELECT status FROM work_requests WHERE id = ?')
        .get(id) as { status: string } | undefined
      if (exists === undefined) {
        throw new PrismError('not_found', `工作不存在: ${id}`)
      }
      throw new PrismError('work_already_claimed', `工作已被认领或不在待办状态: ${id}`, {
        status: exists.status,
      })
    }
    const row = this.#persistence.knowledge.raw
      .prepare(`SELECT ${COLUMNS} FROM work_requests WHERE id = ?`)
      .get(id) as unknown as WorkRow
    await this.#audit?.record({ type: 'work.claimed', request_id: id, claimed_by: claimedBy })
    return { id, attempt_token: token, payload: this.#parseJson(row.payload), deadline }
  }

  /**
   * 回填（§4/§5）：token 校验 + 结果 schema 校验。
   * 校验失败 → 置 failed（附原因）并抛 work_result_invalid；成功 → completed。
   */
  async complete(input: WorkCompleteInput): Promise<WorkRequest> {
    const row = this.#requireRow(input.id)
    if (row.status !== 'claimed') {
      throw new PrismError('bad_request', `工作不在 claimed 状态: ${input.id}`, {
        status: row.status,
      })
    }
    if (row.attempt_token !== input.attempt_token) {
      throw new PrismError('work_token_mismatch', `attempt_token 不匹配（可能已超时回收或重派）: ${input.id}`)
    }
    const kind = row.kind as WorkKind
    const validator = this.#validators.get(kind)
    const payload = this.#parseJson(row.payload)
    if (validator !== undefined) {
      const reason = validator(payload, input.result)
      if (reason !== null) {
        await this.#finish(input.id, input.attempt_token, 'failed', null, `result_invalid: ${reason}`)
        await this.#audit?.record({ type: 'work.completed', request_id: input.id, ok: false })
        throw new PrismError('work_result_invalid', `结果校验失败: ${reason}`, { kind })
      }
    }
    const updated = await this.#finish(input.id, input.attempt_token, 'completed', input.result, null)
    await this.#audit?.record({ type: 'work.completed', request_id: input.id, ok: true })
    return updated
  }

  /** 显式失败回填（宿主执行报错时调用）。 */
  async fail(id: string, attemptToken: string, error: string): Promise<WorkRequest> {
    const row = this.#requireRow(id)
    if (row.status !== 'claimed' || row.attempt_token !== attemptToken) {
      throw new PrismError('work_token_mismatch', `工作不在可失败的认领状态: ${id}`)
    }
    const failCount = row.fail_count + 1
    // 未超重试上限 → 回收为 pending 允许再认领；超限 → 保持 failed 待人工
    const nextStatus: WorkStatus = failCount < this.#maxRetries ? 'pending' : 'failed'
    const nowIso = this.#now().toISOString()
    await this.#persistence.knowledge.run((raw) =>
      raw
        .prepare(
          `UPDATE work_requests
           SET status = ?, attempt_token = NULL, claimed_by = NULL, claimed_at = NULL,
               claimed_deadline = NULL, fail_count = ?, error = ?, updated_at = ?
           WHERE id = ? AND attempt_token = ?`,
        )
        .run(nextStatus, failCount, error, nowIso, id, attemptToken),
    )
    return this.#toRequest(this.#requireRow(id))
  }

  /**
   * 超时回收（§6）：claimed 且超过 claimed_deadline → 回收为 pending。
   * 由宿主/控制台按需调用（Prism 不主动轮询宿主）。
   */
  async reclaimExpired(): Promise<{ reclaimed: string[] }> {
    const nowIso = this.#now().toISOString()
    const rows = this.#persistence.knowledge.raw
      .prepare(
        `SELECT id FROM work_requests
         WHERE status = 'claimed' AND claimed_deadline IS NOT NULL AND claimed_deadline < ?`,
      )
      .all(nowIso) as Array<{ id: string }>
    for (const { id } of rows) {
      await this.#persistence.knowledge.run((raw) =>
        raw
          .prepare(
            `UPDATE work_requests
             SET status = 'pending', attempt_token = NULL, claimed_by = NULL, claimed_at = NULL,
                 claimed_deadline = NULL, updated_at = ?
             WHERE id = ? AND status = 'claimed'`,
          )
          .run(nowIso, id),
      )
      await this.#audit?.record({ type: 'work.expired', request_id: id })
    }
    return { reclaimed: rows.map((r) => r.id) }
  }

  /** 取单条；不存在 → not_found。 */
  get(id: string): WorkRequest {
    return this.#toRequest(this.#requireRow(id))
  }

  /** 队列水位（§6 成本可见）：待办数 / 认领中 / 最老待办年龄（毫秒）/ 已完成统计。 */
  async stats(): Promise<{
    pending: number
    claimed: number
    completed: number
    failed: number
    oldest_pending_age_ms: number | null
  }> {
    const raw = this.#persistence.knowledge.raw
    const counts = raw
      .prepare('SELECT status, COUNT(*) AS c FROM work_requests GROUP BY status')
      .all() as Array<{ status: string; c: number }>
    const byStatus = new Map(counts.map((r) => [r.status, r.c]))
    const oldest = raw
      .prepare("SELECT MIN(created_at) AS oldest FROM work_requests WHERE status = 'pending'")
      .get() as { oldest: string | null }
    const age =
      oldest.oldest === null ? null : Math.max(0, this.#now().getTime() - Date.parse(oldest.oldest))
    return {
      pending: byStatus.get('pending') ?? 0,
      claimed: byStatus.get('claimed') ?? 0,
      completed: byStatus.get('completed') ?? 0,
      failed: byStatus.get('failed') ?? 0,
      oldest_pending_age_ms: Number.isFinite(age) ? age : null,
    }
  }

  /** 终态落库（带 token 守卫；changes=0 说明认领已失效）。 */
  async #finish(
    id: string,
    token: string,
    status: 'completed' | 'failed',
    result: unknown,
    error: string | null,
  ): Promise<WorkRequest> {
    const nowIso = this.#now().toISOString()
    const changes = await this.#persistence.knowledge.run((raw) =>
      Number(
        raw
          .prepare(
            `UPDATE work_requests
             SET status = ?, result = ?, error = ?, attempt_token = NULL, updated_at = ?
             WHERE id = ? AND attempt_token = ?`,
          )
          .run(status, result === null ? null : JSON.stringify(result), error, nowIso, id, token).changes,
      ),
    )
    if (changes === 0) {
      throw new PrismError('work_token_mismatch', `回填失败（认领已失效）: ${id}`)
    }
    return this.#toRequest(this.#requireRow(id))
  }

  #requireRow(id: string): WorkRow {
    const row = this.#persistence.knowledge.raw
      .prepare(`SELECT ${COLUMNS} FROM work_requests WHERE id = ?`)
      .get(id) as unknown as WorkRow | undefined
    if (row === undefined) {
      throw new PrismError('not_found', `工作不存在: ${id}`)
    }
    return row
  }

  #parseJson(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  #toRequest(row: WorkRow): WorkRequest {
    return {
      id: row.id,
      kind: row.kind as WorkKind,
      payload: this.#parseJson(row.payload),
      status: row.status as WorkStatus,
      priority: row.priority,
      attempt_token: row.attempt_token,
      claimed_by: row.claimed_by,
      claimed_at: row.claimed_at,
      claimed_deadline: row.claimed_deadline,
      fail_count: row.fail_count,
      result: row.result === null ? null : this.#parseJson(row.result),
      error: row.error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}

/** 便捷工厂。 */
export function createWorkQueue(options: WorkQueueOptions): WorkQueue {
  return new WorkQueue(options)
}
