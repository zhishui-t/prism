import { createKnowledgeService } from '@prism/knowledge'
import { PrismError, WorkQueue, openPersistence, prismPaths } from '@prism/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { activeModel, embedText, setEmbeddingTier } from './embedding.js'
import type { KnowledgeService } from './port.js'

/** 读 `<PRISM_HOME>/prism.yaml` 某个键的值（支持 `key: value` 简单行；无则 undefined）。 */
export function prismConfigValue(home: string | undefined, key: string): string | undefined {
  try {
    const file = join(prismPaths(home).home, 'prism.yaml')
    const text = readFileSync(file, 'utf-8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('#') || !trimmed.includes(':')) continue
      const idx = trimmed.indexOf(':')
      const k = trimmed.slice(0, idx).trim()
      if (k !== key) continue
      const v = trimmed.slice(idx + 1).trim()
      return v === '' ? undefined : v
    }
  } catch {
    // 无配置文件
  }
  return undefined
}

/**
 * 应用 `<PRISM_HOME>/prism.yaml` 的 embedding 档位配置（`embedding_model`）。
 * **组合根与 CLI 都要调**——否则 `prism embedding use <tier>` 写了配置、
 * 但 `status`/`reindex` 等命令不读，会报错误的生效档位。
 */
export function applyEmbeddingConfig(home?: string): void {
  setEmbeddingTier(prismConfigValue(home, 'embedding_model'))
}

/**
 * 读取 `<PRISM_HOME>/prism.yaml` 的富化开关（A4）。
 * 只认 `enrich_on_deposit: true`——**默认关闭**，避免落库时静默产生大量队列任务
 * 影响既有行为与测试。
 */
export function enrichmentEnabled(home?: string): boolean {
  return prismConfigValue(home, 'enrich_on_deposit')?.toLowerCase() === 'true'
}

/**
 * 组合根：装载真实知识服务（@prism/knowledge，stream-1 交付）。
 * 每次调用返回独立实例；HTTP server 与 MCP stdio 进程经 SQLite WAL 并存（design.md §3.5）。
 *
 * A4：若 `prism.yaml` 开启 `enrich_on_deposit`，注入入队回调——
 * 落库后自动投 `summarize`/`classify` 任务给宿主（Prism 自身零 LLM）。
 *
 * 变更 2：注入本地 embedding（分档：小/默认/强，按算力自动选）——落库自动写向量、
 * 检索走 BM25+向量混合。未安装 embedding 时 `embedText` 返回 ok:false，此处转成 null，
 * knowledge 侧静默跳过、纯 BM25 降级（不炸、不阻塞落库）。
 */
export async function loadKnowledgeService(home?: string): Promise<KnowledgeService> {
  try {
    const enqueue = enrichmentEnabled(home)
      ? buildEnqueueCallback(home)
      : undefined
    // 应用 prism.yaml 的 embedding_model（env PRISM_EMBEDDING_MODEL 优先级更高，在
    // embedding.ts 的 activeTier 里处理）
    applyEmbeddingConfig(home)
    const embed: (text: string) => Promise<Float32Array | null> = async (text) => {
      const r = await embedText(text)
      return r.ok && r.vector !== undefined ? r.vector : null
    }
    return createKnowledgeService({
      home,
      embed,
      embeddingModel: activeModel().id,
      ...(enqueue !== undefined ? { enqueueEnrichment: enqueue } : {}),
    })
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
