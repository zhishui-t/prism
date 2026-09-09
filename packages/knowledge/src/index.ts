/**
 * @prism/knowledge — Prism 知识库核心。
 *
 * 对外只暴露 types.ts 冻结的契约 + 服务工厂；实现细节（分词/文件布局/SQL）
 * 供测试与高级用法引用，但 server/cli 应优先依赖 createKnowledgeService。
 */
export type {
  BookNode,
  CatalogEntry,
  DepositInput,
  EdgeConfidence,
  EdgeRelation,
  EntryType,
  GraphNode,
  GraphPath,
  GraphQuery,
  GraphView,
  IndexInput,
  IndexResult,
  KbStats,
  KnowledgeEdge,
  KnowledgeEntry,
  KnowledgeService,
  KnowledgeServiceOptions,
  Layer,
  ReindexReport,
  RemoveResult,
  SearchQuery,
  SearchResult,
} from './types.js'

export {
  bigram,
  toMatchExpression,
} from './tokenize.js'

export {
  parseFrontmatter,
  renderMarkdownFile,
  serializeFrontmatter,
  splitFrontmatter,
  type FrontmatterData,
  type FrontmatterValue,
} from './frontmatter.js'

export {
  INBOX_DIR,
  entryDirPath,
  isValidSegment,
  latestFilePath,
  ownerFromPath,
  readContentFile,
  readEntryContent,
  versionFilePath,
  type EntryAddress,
} from './store.js'

export { KB_FTS_DDL, ensureKbFts, indexEntry, searchFts } from './index-db.js'

// 文档格式分流与转换（A2）：文本直读、二进制走 anydoc
export {
  CONVERTIBLE_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  TEXT_EXTENSIONS,
  extensionOf,
  isSupported,
  toMarkdown,
  type ConvertResult,
  type ConvertStatus,
} from './convert.js'

export {
  PrismKnowledgeService,
  createKnowledgeService,
} from './service.js'

// 知识图谱 → Graphify 导出（D9：借 Graphify 渲染/Obsidian，Prism 零 LLM 抽边）
export {
  toGraphifyGraph,
  graphifyExportSummary,
  graphViewFromEntries,
  type GraphifyGraph,
  type GraphifyNode,
  type GraphifyLink,
  type GraphifyExportSummary,
} from './graphify-export.js'
