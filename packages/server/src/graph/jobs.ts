import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismError } from '@prism/core'

export type JobStatus = 'running' | 'done' | 'failed'

export interface BuildJob {
  job_id: string
  project: string
  status: JobStatus
  log: string[]
  error: string | null
  started_at: string
  ended_at: string | null
}

/** 构建执行体：把日志行追加进 job（真实实现跑 graphify；测试注入假执行体）。 */
export type BuildRunner = (project: string, root: string, appendLog: (line: string) => void) => Promise<void>

const LOCK_STALE_MS = 30 * 60_000

/**
 * 异步建图任务（design.md §4：提交即返回 job_id，内存任务表）。
 * 同项目并发：进程内 Set 守卫 + 跨进程文件锁（<root>/.prism/build.lock）→ build_in_progress。
 * 锁放 .prism/（Prism 自身协调态）而非 graphify-out/——产物目录归 graphify 管，不放杂物。
 */
export class BuildJobManager {
  readonly #jobs = new Map<string, BuildJob>()
  readonly #running = new Set<string>()
  readonly #maxJobs = 200

  /**
   * 提交建图任务；同项目已有运行中任务 → PrismError('build_in_progress')。
   * 任务体异步执行，不阻塞返回。
   */
  submit(project: string, root: string, lockDir: string, runner: BuildRunner): BuildJob {
    if (this.#running.has(project)) {
      throw new PrismError('build_in_progress', `项目 ${project} 正在建图，请稍后用 job 查询进度`)
    }
    this.#running.add(project)
    const job: BuildJob = {
      job_id: randomUUID(),
      project,
      status: 'running',
      log: [],
      error: null,
      started_at: new Date().toISOString(),
      ended_at: null,
    }
    this.#jobs.set(job.job_id, job)
    if (this.#jobs.size > this.#maxJobs) {
      const oldest = this.#jobs.keys().next().value
      if (oldest !== undefined && this.#jobs.get(oldest)?.status !== 'running') {
        this.#jobs.delete(oldest)
      }
    }

    const appendLog = (line: string): void => {
      job.log.push(`[${new Date().toISOString()}] ${line}`)
      if (job.log.length > 1000) {
        job.log.splice(0, job.log.length - 1000)
      }
    }

    void (async () => {
      let lockHeld = false
      try {
        await acquireLock(buildLockPath(lockDir))
        lockHeld = true
        appendLog(`开始建图: ${root}`)
        await runner(project, root, appendLog)
        job.status = 'done'
        appendLog('建图完成')
      } catch (error) {
        job.status = 'failed'
        job.error = error instanceof Error ? error.message : String(error)
        appendLog(`建图失败: ${job.error}`)
      } finally {
        if (lockHeld) {
          await releaseLock(buildLockPath(lockDir))
        }
        this.#running.delete(project)
        job.ended_at = new Date().toISOString()
      }
    })()

    return job
  }

  /** 查询任务；不存在 → PrismError('not_found')。 */
  get(jobId: string): BuildJob {
    const job = this.#jobs.get(jobId)
    if (job === undefined) {
      throw new PrismError('not_found', `未知建图任务: ${jobId}`)
    }
    return job
  }

  /** 轮询等待任务到达终态（done/failed）；测试与 CLI 复用，替代裸 sleep。 */
  async waitFor(jobId: string, timeoutMs = 5_000): Promise<BuildJob> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const job = this.get(jobId)
      if (job.status !== 'running') return job
      if (Date.now() >= deadline) {
        throw new PrismError('graphify_timeout', `等待任务 ${jobId} 超时（${timeoutMs}ms）`)
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  list(): BuildJob[] {
    return [...this.#jobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at))
  }
}

/** 跨进程文件锁：存在且未过期（30min）→ build_in_progress；过期视为残留并接管。 */
/** 建图跨进程锁路径：<root>/.prism/build.lock（Prism 协调态，不进 graphify-out 产物目录）。 */
function buildLockPath(root: string): string {
  return join(root, '.prism', 'build.lock')
}

async function acquireLock(lockPath: string): Promise<void> {
  try {
    const raw = await readFile(lockPath, 'utf-8')
    const { at } = JSON.parse(raw) as { at?: string }
    const atMs = at !== undefined ? Date.parse(at) : NaN
    if (Number.isFinite(atMs) && Date.now() - atMs < LOCK_STALE_MS) {
      throw new PrismError('build_in_progress', `另一个进程正在建图（锁: ${lockPath}）`)
    }
  } catch (error) {
    if (error instanceof PrismError) {
      throw error
    }
    // 锁不存在或损坏 → 继续
  }
  const { mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(lockPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid })}\n`, 'utf-8')
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath)
  } catch {
    // 已被并发进程清理 → 忽略
  }
}
