/**
 * @prism/knowledge — Prism 知识库核心。
 *
 * 对外只暴露 types.ts 冻结的契约 + 服务工厂；实现细节（分词/文件布局/SQL）
 * 供测试与高级用法引用，但 server/cli 应优先依赖 createKnowledgeService。
 */
export type {
  BookNode,
  BookStructure,
  CatalogEntry,
  DepositInput,
  DepositResult,
  EdgeConfidence,
  EdgeRelation,
  EntryStatus,
  EntryType,
  EntryVersion,
  GraphNode,
  GraphPath,
  GraphQuery,
  GraphView,
  IndexInput,
  IndexResult,
  KbStats,
  KnowledgeConflict,
  KnowledgeEdge,
  KnowledgeEntry,
  KnowledgeService,
  KnowledgeServiceOptions,
  Layer,
  ReindexReport,
  RemoveResult,
  RestoreResult,
  SearchQuery,
  SearchHit,
  SearchResponse,
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

export {
  KB_FTS_DDL,
  ensureKbFts,
  indexEntry,
  searchFts,
  // 段级三表原语（v13 §2）：CLI 的 `kb reindex --chunks` 直查路径复用（N-6）
  ensureKbChunks,
  deleteChunks,
  indexChunks,
  type IndexedChunk,
} from './index-db.js'

// 文档格式分流与转换（A2）：文本直读、二进制走 anydoc、图片/扫描 PDF 走 OCR（B-4）
export {
  CONVERTIBLE_EXTENSIONS,
  MIN_OCR_VALID_CHARS,
  OCR_IMAGE_EXTENSIONS,
  OCR_MODEL_COUNT,
  OCR_RUN_TIMEOUT_MS,
  SUPPORTED_EXTENSIONS,
  TEXT_EXTENSIONS,
  countValidChars,
  extensionOf,
  isSupported,
  ocrAvailable,
  ocrDepsReady,
  ocrModelCount,
  ocrModelsDir,
  ocrModelsReady,
  ocrToolDir,
  parseOcrOff,
  probeConverter,
  runOcrTool,
  setOcrHooks,
  stripOcrArtifacts,
  toMarkdown,
  type ConvertResult,
  type ConvertStatus,
  type OcrHooks,
  type OcrRunResult,
  type OcrRunner,
} from './convert.js'

export {
  PrismKnowledgeService,
  createKnowledgeService,
  GRAPH_FUSION_DECAY,
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

// 长文档分段切分（v13 §1）：纯函数，零仓库内依赖
export {
  assembleChunkEmbeddingInput,
  chunkMarkdown,
  defaultMaxChars,
  type Chunk,
  type ChunkOptions,
} from './chunker.js'

// 检索融合常量（v13 §4）：段向量扫描上限的**唯一真相源**（server wiring 直接复用）
export { CHUNK_HITS_PER_ENTRY, DEFAULT_VECTOR_SCAN_CAP } from './vector.js'
