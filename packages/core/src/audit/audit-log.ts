import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { prismPaths } from '../config/paths.js'
import { SingleWriterQueue } from '../persistence/single-writer-queue.js'
import { PrismError } from '../state/errors.js'
import { TASK_STATUSES, TaskStateMachine } from '../state/index.js'

/** 审计事件类型。 */
export const AUDIT_EVENT_TYPES = [
  'task.status_changed',
  'knowledge.status_changed',
  'knowledge.superseded',
  'knowledge.deposited',
  'knowledge.deprecated',
  'knowledge.deleted',
  'knowledge.approved',
  'knowledge.rejected',
  'knowledge.conflict_detected',
  'import.confirmed',
  'work.enqueued',
  'work.claimed',
  'work.completed',
  'work.expired',
  'team.switched',
] as const

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number]

export interface AuditEventBase {
  id?: string
  type: AuditEventType
  occurred_at?: string
  session_id?: string | null
}

export type AuditEvent =
  | (AuditEventBase & { type: 'task.status_changed'; task_id: string; from: string; to: string; by: string })
  | (AuditEventBase & { type: 'knowledge.status_changed'; knowledge_id: string; from: string; to: string })
  | (AuditEventBase & { type: 'knowledge.superseded'; new_id: string; old_id: string; reason: string })
  | (AuditEventBase & { type: 'knowledge.deposited'; knowledge_id: string; layer: string; source: string })
  | (AuditEventBase & { type: 'knowledge.deprecated'; knowledge_id: string; layer: string; source: string })
  | (AuditEventBase & { type: 'knowledge.deleted'; knowledge_id: string; layer: string })
  | (AuditEventBase & { type: 'knowledge.approved'; knowledge_id: string; subject: string; degraded: boolean })
  | (AuditEventBase & { type: 'knowledge.rejected'; knowledge_id: string; subject: string; reason: string })
  | (AuditEventBase & { type: 'knowledge.conflict_detected'; high_id: string; low_id: string; kind: string })
  | (AuditEventBase & { type: 'import.confirmed'; job_id: string; candidate_id: string })
  | (AuditEventBase & { type: 'work.enqueued'; request_id: string; kind: string })
  | (AuditEventBase & { type: 'work.claimed'; request_id: string; claimed_by: string })
  | (AuditEventBase & { type: 'work.completed'; request_id: string; ok: boolean })
  | (AuditEventBase & { type: 'work.expired'; request_id: string })
  | (AuditEventBase & { type: 'team.switched'; session_id: string; from_team: string; to_team: string })

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type AuditEventInput = DistributiveOmit<AuditEvent, 'id' | 'occurred_at'> & {
  occurred_at?: string
}

/** 各事件类型的必填字段。 */
export const AUDIT_EVENT_REQUIRED_FIELDS: Record<AuditEventType, readonly string[]> = {
  'task.status_changed': ['task_id', 'from', 'to', 'by'],
  'knowledge.status_changed': ['knowledge_id', 'from', 'to'],
  'knowledge.superseded': ['new_id', 'old_id', 'reason'],
  'knowledge.deposited': ['knowledge_id', 'layer', 'source'],
  'knowledge.deprecated': ['knowledge_id', 'layer', 'source'],
  'knowledge.deleted': ['knowledge_id', 'layer'],
  'knowledge.approved': ['knowledge_id', 'subject', 'degraded'],
  'knowledge.rejected': ['knowledge_id', 'subject', 'reason'],
  'knowledge.conflict_detected': ['high_id', 'low_id', 'kind'],
  'import.confirmed': ['job_id', 'candidate_id'],
  'work.enqueued': ['request_id', 'kind'],
  'work.claimed': ['request_id', 'claimed_by'],
  'work.completed': ['request_id', 'ok'],
  'work.expired': ['request_id'],
  'team.switched': ['session_id', 'from_team', 'to_team'],
}

export interface AuditLogOptions {
  /** audit 目录，默认 <PRISM_HOME>/audit */
  dir?: string
  /** 单写者队列；与持久化层共享时传入同一队列 */
  queue?: SingleWriterQueue
  /** 可注入时钟（测试用） */
  now?: () => Date
  idFactory?: () => string
}

export interface AuditQuery {
  types?: AuditEventType[]
  taskId?: string
  knowledgeId?: string
  jobId?: string
  requestId?: string
  sessionId?: string
  from?: string
  to?: string
  limit?: number
  order?: 'asc' | 'desc'
}

/**
 * AuditLog — 追加式 JSONL 审计日志（<home>/audit/audit-YYYY-MM-DD.jsonl）。
 * record() 做事件类型/必填字段校验 + task.status_changed 走状态机合法性校验，
 * 写入经 SingleWriterQueue 串行化。
 */
export class AuditLog {
  readonly dir: string
  readonly queue: SingleWriterQueue
  readonly #now: () => Date
  readonly #idFactory: () => string

  constructor(options: AuditLogOptions = {}) {
    this.dir = options.dir ?? prismPaths().auditDir
    this.queue = options.queue ?? new SingleWriterQueue()
    this.#now = options.now ?? (() => new Date())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  #fileFor(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return join(this.dir, `audit-${y}-${m}-${d}.jsonl`)
  }

  /** 写入一条审计事件；返回完整事件（含生成字段）。校验失败抛 PrismError 且不落盘。 */
  async record(event: AuditEventInput): Promise<AuditEvent> {
    const full: AuditEvent = {
      ...event,
      id: (event as Partial<AuditEvent>).id ?? this.#idFactory(),
      occurred_at: event.occurred_at ?? this.#now().toISOString(),
    } as unknown as AuditEvent
    this.#validate(full)
    const line = `${JSON.stringify(full)}\n`
    await this.queue.run(async () => {
      await mkdir(this.dir, { recursive: true })
      await appendFile(this.#fileFor(this.#now()), line, { encoding: 'utf-8' })
    })
    return full
  }

  #validate(event: AuditEvent): void {
    const asRecord = event as unknown as Record<string, unknown>
    if (!AUDIT_EVENT_TYPES.includes(event.type)) {
      throw new PrismError('invalid_audit_event', `未知审计事件类型: ${String(event.type)}`, {
        type: event.type,
      })
    }
    const missing = AUDIT_EVENT_REQUIRED_FIELDS[event.type].filter((f) => asRecord[f] == null)
    if (missing.length > 0) {
      throw new PrismError('invalid_audit_event', `审计事件缺少必填字段: ${missing.join(', ')}`, {
        type: event.type,
        missing,
      })
    }
    if (event.type === 'task.status_changed') {
      const { from, to } = event as { from: string; to: string }
      if (!TASK_STATUSES.includes(from as never) || !TASK_STATUSES.includes(to as never)) {
        throw new PrismError('invalid_audit_event', `非法状态值: ${from} → ${to}`, { from, to })
      }
      if (!TaskStateMachine.canTransition(from as never, to as never)) {
        throw new PrismError('invalid_status_transition', `审计拒绝非法转移: ${from} → ${to}`, {
          from,
          to,
        })
      }
    }
  }

  /** 查询入口：按类型/实体/时间过滤，order 默认 desc，limit 默认全部。 */
  async query(filter: AuditQuery = {}): Promise<AuditEvent[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((f) => /^audit-.*\.jsonl$/.test(f))
      .sort()
    const events: AuditEvent[] = []
    for (const file of files) {
      const content = await readFile(join(this.dir, file), { encoding: 'utf-8' })
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          events.push(JSON.parse(trimmed) as AuditEvent)
        } catch {
          // 跳过损坏行（容忍部分损坏，不阻断审计查询）
        }
      }
    }
    const matched = events.filter((e) => this.#matches(e, filter))
    matched.sort((a, b) => {
      const cmp = String(a.occurred_at).localeCompare(String(b.occurred_at))
      return (filter.order ?? 'desc') === 'asc' ? cmp : -cmp
    })
    return filter.limit != null ? matched.slice(0, filter.limit) : matched
  }

  #matches(event: AuditEvent, filter: AuditQuery): boolean {
    const e = event as unknown as Record<string, unknown>
    if (filter.types && !filter.types.includes(event.type)) return false
    if (filter.taskId && e.task_id !== filter.taskId) return false
    if (filter.knowledgeId && e.knowledge_id !== filter.knowledgeId) return false
    if (filter.jobId && e.job_id !== filter.jobId) return false
    if (filter.requestId && e.request_id !== filter.requestId) return false
    if (filter.sessionId && e.session_id !== filter.sessionId) return false
    if (filter.from && String(e.occurred_at) < filter.from) return false
    if (filter.to && String(e.occurred_at) > filter.to) return false
    return true
  }
}
