import { createKnowledgeService } from '@prism/knowledge'
import { PrismError, prismPaths } from '@prism/core'
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
 * 组合根：装载真实知识服务（@prism/knowledge）。
 * 每次调用返回独立实例；HTTP server 与 MCP stdio 进程经 SQLite WAL 并存（design.md §3.5）。
 *
 * embedding（分档：小/默认/强，按算力自动选）：落库自动写向量、检索走 BM25+向量混合。
 * 未安装时 `embedText` 返回 ok:false → 此处转 null，knowledge 侧静默跳过、纯 BM25 降级。
 *
 * 注：工作队列已移除。富化（摘要/分类/实体抽取/图表 IR）由宿主经 MCP `prism_kb_enrich`
 * 直接回写（见 enrich-writeback.ts），不再经队列投递。
 */
export async function loadKnowledgeService(home?: string): Promise<KnowledgeService> {
  try {
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
    })
  } catch (error) {
    throw new PrismError(
      'internal',
      `装载 @prism/knowledge 失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
