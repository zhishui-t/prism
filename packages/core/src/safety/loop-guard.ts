import { PrismError } from '../state/errors.js'

/** 委托链深度上限 */
export const MAX_DELEGATION_DEPTH = 3
/** 等待超时 */
export const WAIT_TIMEOUT_MS = 300_000

export interface LoopGuardOptions {
  /** 步数上限，默认 30 */
  maxSteps?: number
  /** 相同动作连续次数上限，默认 3 */
  maxSameAction?: number
  /** 判定为"零增长"的最小输出增量（字符），默认 10 */
  minOutputGrowth?: number
  /** 连续零增长判定上限，默认 3 */
  maxZeroGrowthChecks?: number
  /** 时间上限 ms，默认 300_000 */
  maxDurationMs?: number
  /** 可注入时钟（测试用），默认 Date.now */
  now?: () => number
}

export interface LoopStep {
  /** 本轮动作/工具标识 */
  action: string
  /** 本轮输出文本（用于零增长检测） */
  output: string
  /** 可选：直接给定输出长度 */
  outputLength?: number
}

export const DEFAULT_LOOP_GUARD_OPTIONS = {
  maxSteps: 30,
  maxSameAction: 3,
  minOutputGrowth: 10,
  maxZeroGrowthChecks: 3,
  maxDurationMs: 300_000,
} as const

/**
 * 循环检测：步数/工具重复/输出零增长/时间限制。
 * 任一阈值被突破即抛 PrismError('loop_detected')。
 */
export class LoopGuard {
  readonly #maxSteps: number
  readonly #maxSameAction: number
  readonly #minOutputGrowth: number
  readonly #maxZeroGrowthChecks: number
  readonly #maxDurationMs: number
  readonly #now: () => number

  #stepCount = 0
  #lastAction: string | null = null
  #sameActionCount = 0
  #lastLength = 0
  #zeroGrowthCount = 0
  #startedAt: number | null = null

  constructor(options: LoopGuardOptions = {}) {
    const d = DEFAULT_LOOP_GUARD_OPTIONS
    this.#maxSteps = options.maxSteps ?? d.maxSteps
    this.#maxSameAction = options.maxSameAction ?? d.maxSameAction
    this.#minOutputGrowth = options.minOutputGrowth ?? d.minOutputGrowth
    this.#maxZeroGrowthChecks = options.maxZeroGrowthChecks ?? d.maxZeroGrowthChecks
    this.#maxDurationMs = options.maxDurationMs ?? d.maxDurationMs
    this.#now = options.now ?? Date.now
  }

  get steps(): number {
    return this.#stepCount
  }

  reset(): void {
    this.#stepCount = 0
    this.#lastAction = null
    this.#sameActionCount = 0
    this.#lastLength = 0
    this.#zeroGrowthCount = 0
    this.#startedAt = null
  }

  /** 记录一步；循环特征出现时抛 PrismError('loop_detected')。 */
  step(input: LoopStep): void {
    const now = this.#now()
    if (this.#startedAt === null) {
      this.#startedAt = now
    }
    if (now - this.#startedAt > this.#maxDurationMs) {
      throw this.#loop('max_duration', {
        startedAt: this.#startedAt,
        elapsedMs: now - this.#startedAt,
        maxDurationMs: this.#maxDurationMs,
      })
    }
    this.#stepCount++
    if (this.#stepCount > this.#maxSteps) {
      throw this.#loop('max_steps', { steps: this.#stepCount, maxSteps: this.#maxSteps })
    }
    if (input.action === this.#lastAction) {
      this.#sameActionCount++
      if (this.#sameActionCount >= this.#maxSameAction) {
        throw this.#loop('same_action', { action: input.action, count: this.#sameActionCount })
      }
    } else {
      this.#lastAction = input.action
      this.#sameActionCount = 1
    }
    const length = input.outputLength ?? input.output.length
    const growth = this.#lastLength === 0 ? length : length - this.#lastLength
    if (growth < this.#minOutputGrowth) {
      this.#zeroGrowthCount++
      if (this.#zeroGrowthCount >= this.#maxZeroGrowthChecks) {
        throw this.#loop('zero_growth', {
          checks: this.#zeroGrowthCount,
          minOutputGrowth: this.#minOutputGrowth,
          lastLength: this.#lastLength,
          length,
        })
      }
    } else {
      this.#zeroGrowthCount = 0
    }
    this.#lastLength = length
  }

  #loop(kind: string, details: Record<string, unknown>): PrismError {
    return new PrismError('loop_detected', `循环检测触发: ${kind}`, { kind, ...details })
  }
}

/** 委托链防循环：深度 ≤ 3；同一执行器重复且未完成 → 拒绝。 */
export class DelegationChain {
  #chain: string[] = []

  get depth(): number {
    return this.#chain.length
  }

  snapshot(): string[] {
    return [...this.#chain]
  }

  /** 进入一层委托；超深或执行器重复（未完成链内）抛 PrismError('loop_detected')。 */
  push(executorId: string): void {
    if (this.#chain.length >= MAX_DELEGATION_DEPTH) {
      throw new PrismError(
        'loop_detected',
        `委托链深度超限: ${this.#chain.length + 1} > ${MAX_DELEGATION_DEPTH}`,
        { kind: 'chain_depth', maxDepth: MAX_DELEGATION_DEPTH, chain: this.snapshot() },
      )
    }
    if (this.#chain.includes(executorId)) {
      throw new PrismError('loop_detected', `委托链闭环: 执行器重复且未完成: ${executorId}`, {
        kind: 'executor_repeat',
        executorId,
        chain: this.snapshot(),
      })
    }
    this.#chain.push(executorId)
  }

  pop(): void {
    this.#chain.pop()
  }
}
