/**
 * 富化结果回写（work-queue.md §7 流程⑤，此前断链：宿主 complete 后结果被丢弃）。
 *
 * 回写规则（全部确定性，零 LLM）：
 * - `summarize { summary }` → 以 `SUMMARY-<entry_id>` 落一条 `type: summary` 条目，
 *   正文引用原条目（`[[entry_id]]` 建边）；
 * - `classify { labels }` → 取原条目最新版，deposit 同 id 版次 + tags 合并
 *   （去重；内容哈希去重保证「标签没变不产生新版次」）；
 * - `extract_entities { entities, relations }` → 每个实体落一条 `type: other` 条目
 *   （同书 _inbox），实体间 relations 以双链 `[[from]]` 写进正文（建边）。
 *
 * 边界：回写失败不吞——向上抛给调用方（MCP/HTTP complete 已把 work 置 completed，
 * 回写失败由审计留痕 + 错误信息返回宿主重试；不自动回滚 work 状态）。
 */

import type { KnowledgeService, DepositInput } from '@prism/knowledge'

export interface EnrichmentResult {
  kind: string
  payload: Record<string, unknown>
  result: Record<string, unknown>
}

export interface WritebackReport {
  kind: string
  action: string
  detail: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/**
 * 把一份富化结果回写进知识库。
 *
 * @param kb 知识服务（需 deposit/get）
 * @param enrichment kind + 原始 payload + 已校验的 result
 * @param defaults 归属缺省（layer/owner/book 由 payload 或调用方给）
 */
export async function writeEnrichment(
  kb: KnowledgeService,
  enrichment: EnrichmentResult,
  defaults: { layer?: string; owner?: string; book?: string; deposited_by?: DepositInput['deposited_by'] } = {},
): Promise<WritebackReport | null> {
  const entryId = str(enrichment.payload['entry_id'])
  // 缺省 global：富化产物无需 owner（project 层强制 owner，回写器拿不到时会炸）
  const layer = (str(enrichment.payload['layer']) ?? defaults.layer ?? 'global') as DepositInput['layer']
  const owner = str(enrichment.payload['owner']) ?? defaults.owner
  const book = str(enrichment.payload['book']) ?? defaults.book ?? 'enrichment'

  if (enrichment.kind === 'summarize') {
    const summary = str(enrichment.result['summary'])
    if (entryId === undefined || summary === undefined) {
      return { kind: enrichment.kind, action: 'skipped', detail: 'payload 缺 entry_id 或 result 缺 summary' }
    }
    const source = await kb.get(entryId)
    const deposited = await kb.deposit({
      id: `SUMMARY-${entryId}`,
      title: `摘要：${source?.title ?? entryId}`,
      type: 'summary',
      layer: source?.layer ?? layer,
      ...(source?.owner !== undefined ? { owner: source.owner } : owner !== undefined ? { owner } : {}),
      book: source?.book ?? book,
      content: `${summary}\n\n原条目：[[${entryId}]]`,
      tags: ['enrichment', 'summary'],
      source: { kind: 'agent', ref: `work:${enrichment.kind}` },
      ...(defaults.deposited_by !== undefined ? { deposited_by: defaults.deposited_by } : {}),
    })
    return {
      kind: enrichment.kind,
      action: deposited.action,
      detail: `SUMMARY-${entryId}@v${deposited.version}`,
    }
  }

  if (enrichment.kind === 'classify') {
    const labels = enrichment.result['labels']
    if (entryId === undefined || !Array.isArray(labels)) {
      return { kind: enrichment.kind, action: 'skipped', detail: 'payload 缺 entry_id 或 result 缺 labels' }
    }
    const source = await kb.get(entryId)
    if (source === null) {
      return { kind: enrichment.kind, action: 'skipped', detail: `原条目不存在: ${entryId}` }
    }
    const merged = [...new Set([...source.tags, ...labels.map(String)])]
    // 标签没变 → deposit 走哈希去重，不产生新版次
    const deposited = await kb.deposit({
      id: entryId,
      title: source.title,
      type: source.type,
      layer: source.layer,
      ...(source.owner !== undefined ? { owner: source.owner } : {}),
      book: source.book,
      ...(source.module !== '' ? { module: source.module } : {}),
      content: source.content,
      tags: merged,
      source: { kind: 'agent', ref: `work:${enrichment.kind}` },
      ...(defaults.deposited_by !== undefined ? { deposited_by: defaults.deposited_by } : {}),
    })
    return {
      kind: enrichment.kind,
      action: deposited.action,
      detail: `tags: ${source.tags.length} → ${merged.length}`,
    }
  }

  if (enrichment.kind === 'extract_entities') {
    const entities = enrichment.result['entities']
    const relations = enrichment.result['relations']
    if (!Array.isArray(entities) || entities.length === 0) {
      return { kind: enrichment.kind, action: 'skipped', detail: 'result 缺 entities' }
    }
    // 实体 → 条目；relations 以双链写进「from」实体正文（去重建边）
    const byId = new Map<string, string>()
    for (const e of entities) {
      if (typeof e !== 'object' || e === null) continue
      const id = str((e as Record<string, unknown>)['id'])
      if (id === undefined) continue
      const label = str((e as Record<string, unknown>)['label']) ?? id
      const type = str((e as Record<string, unknown>)['type'])
      byId.set(id, label)
      await kb.deposit({
        id: `ENT-${id}`,
        title: label,
        type: 'other',
        layer,
        ...(owner !== undefined ? { owner } : {}),
        book,
        content: `实体类型：${type ?? 'unknown'}`,
        tags: ['enrichment', 'entity'],
        source: { kind: 'agent', ref: `work:${enrichment.kind}` },
        ...(defaults.deposited_by !== undefined ? { deposited_by: defaults.deposited_by } : {}),
      })
    }
    let edgeCount = 0
    if (Array.isArray(relations)) {
      for (const r of relations) {
        if (typeof r !== 'object' || r === null) continue
        const rec = r as Record<string, unknown>
        const from = str(rec['from'])
        const to = str(rec['to'])
        const relation = str(rec['relation']) ?? 'related'
        if (from === undefined || to === undefined || !byId.has(from) || !byId.has(to)) continue
        // 把关系写成 to 的双链（追加进 from 实体正文 → references 边）
        const existing = await kb.get(`ENT-${from}`)
        if (existing === null) continue
        const line = `关联（${relation}）：[[ENT-${to}]]`
        if (existing.content.includes(line)) continue
        await kb.deposit({
          id: `ENT-${from}`,
          title: existing.title,
          type: existing.type,
          layer: existing.layer,
          ...(existing.owner !== undefined ? { owner: existing.owner } : {}),
          book: existing.book,
          content: `${existing.content}\n${line}`,
          tags: existing.tags,
          source: { kind: 'agent', ref: `work:${enrichment.kind}` },
          ...(defaults.deposited_by !== undefined ? { deposited_by: defaults.deposited_by } : {}),
        })
        edgeCount++
      }
    }
    return {
      kind: enrichment.kind,
      action: 'written',
      detail: `实体 ${byId.size} 条目 · 关系边 ${edgeCount}`,
    }
  }

  // embed / diagram_ir 等：结果存队列已够，回写暂无消费端（向量索引未落地）
  return null
}
