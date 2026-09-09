import { createKnowledgeService } from '@prism/knowledge'
import { PrismError } from '@prism/core'

import type { KnowledgeService } from './port.js'

/**
 * 组合根：装载真实知识服务（@prism/knowledge，stream-1 交付）。
 * 每次调用返回独立实例；HTTP server 与 MCP stdio 进程经 SQLite WAL 并存（design.md §3.5）。
 */
export async function loadKnowledgeService(home?: string): Promise<KnowledgeService> {
  try {
    return createKnowledgeService({ home })
  } catch (error) {
    throw new PrismError(
      'internal',
      `装载 @prism/knowledge 失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
