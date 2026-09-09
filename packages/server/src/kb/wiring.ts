import { createKnowledgeService } from '@prism/knowledge'
import { PrismError, WorkQueue, openPersistence, prismPaths } from '@prism/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { KnowledgeService } from './port.js'

/**
 * 读取 `<PRISM_HOME>/prism.yaml` 的富化开关（A4）。
 * 只认 `enrich_on_deposit: true`——**默认关闭**，避免落库时静默产生大量队列任务
 * 影响既有行为与测试。
 */
export function enrichmentEnabled(home?: string): boolean {
  try {
    const file = join(prismPaths(home).home, 'prism.yaml')
    const text = readFileSync(file, 'utf-8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed.includes(':')) continue
      const [key, ...rest] = trimmed.split(':')
      if (key?.trim() === 'enrich_on_deposit') {
        return rest.join(':').trim().toLowerCase() === 'true'
      }
    }
  } catch {
    // 无配置文件 → 关闭
  }
  return false
}

/**
 * 组合根：装载真实知识服务（@prism/knowledge，stream-1 交付）。
 * 每次调用返回独立实例；HTTP server 与 MCP stdio 进程经 SQLite WAL 并存（design.md §3.5）。
 *
 * A4：若 `prism.yaml` 开启 `enrich_on_deposit`，注入入队回调——
 * 落库后自动投 `summarize`/`classify` 任务给宿主（Prism 自身零 LLM）。
 */
export async function loadKnowledgeService(home?: string): Promise<KnowledgeService> {
  try {
    const enqueue = enrichmentEnabled(home)
      ? buildEnqueueCallback(home)
      : undefined
    return createKnowledgeService({ home, ...(enqueue !== undefined ? { enqueueEnrichment: enqueue } : {}) })
  } catch (error) {
    throw new PrismError(
      'internal',
      `装载 @prism/knowledge 失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** 落库后投递富化任务（宿主经 prism_work_pending 领取）。 */
function buildEnqueueCallback(
  home?: string,
): (entry: { id: string; version: number; layer: string; book: string; module: string; type: string }) => Promise<void> {
  return async (entry) => {
    const persistence = openPersistence({ home })
    const queue = new WorkQueue({ persistence })
    try {
      // 只投「理解类」任务；embed 需要 embedding backend，暂不自动投。
      await queue.enqueue({
        kind: 'summarize',
        payload: { entry_id: entry.id, version: entry.version, book: entry.book, module: entry.module },
        priority: 0,
      })
      await queue.enqueue({
        kind: 'classify',
        payload: { entry_id: entry.id, version: entry.version, type: entry.type },
        priority: 0,
      })
    } finally {
      persistence.close()
    }
  }
}
