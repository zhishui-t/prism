/**
 * 知识库服务端口 = design.md §3.2 契约。
 *
 * 对齐记录（2026-09-09）：dev-1 的 packages/knowledge/src/types.ts 已落盘并冻结，
 * 与 §3.2 逐字段一致。server 不再维护镜像类型，直接 re-export 契约真相，
 * 服务实例由 kb/wiring.ts 经 createKnowledgeService 装载；测试注入内存桩。
 */
import type {
  Layer,
  EntryType,
  KnowledgeService,
} from '@prism/knowledge'

export type {
  Layer,
  EntryType,
  DepositInput,
  KnowledgeEntry,
  SearchQuery,
  SearchResult,
  BookNode,
  CatalogEntry,
  KbStats,
  KnowledgeService,
  EdgeRelation,
  EdgeConfidence,
  KnowledgeEdge,
  GraphNode,
  GraphView,
  GraphQuery,
  GraphPath,
} from '@prism/knowledge'

export const LAYERS: readonly Layer[] = ['global', 'project', 'role']

export const ENTRY_TYPES: readonly EntryType[] = [
  'rule',
  'doc',
  'guide',
  'pitfall',
  'pattern',
  'diagram',
  'summary',
  'other',
]

/** 惰性创建知识服务（组合根用；可注入替换）。 */
export type KbFactory = () => Promise<KnowledgeService>
