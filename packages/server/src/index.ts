/**
 * @prism/server — Prism HTTP 服务 + stdio MCP
 * 零框架（node:http / node:util.parseArgs / 手写 JSON-RPC）。
 */

// 应用与启动
export { createApp, startServer, type AppOptions, type AppHandle } from './app.js'

// 信封与错误码（跨流契约 design.md §4）
export { ERROR_CODES, ok, fail, toEnvelope, type Envelope, type ErrorCode } from './http/envelope.js'

// 路由器
export { Router, type RouteContext, type RouteHandler } from './http/router.js'

// 知识服务端口（§3.2 契约镜像）与装载
export type {
  Layer,
  EntryType,
  DepositInput,
  DepositResult,
  KnowledgeEntry,
  SearchQuery,
  SearchResult,
  BookNode,
  BookStructure,
  EntryVersion,
  KbStats,
  KnowledgeService,
  KbFactory,
} from './kb/port.js'
export { LAYERS, ENTRY_TYPES } from './kb/port.js'
export { loadKnowledgeService, applyEmbeddingConfig } from './kb/wiring.js'
// 落库入口（F-E2：MCP/HTTP/CLI 共用同一团队沉淀策略；CLI `prism kb deposit --team` 用）
export {
  depositWithPolicy,
  type DepositEntryDeps,
  type DepositRequest,
} from './kb/deposit-entry.js'
export {
  exportKnowledgeGraph,
  kbGraphWorkDir,
  type KbGraphExportOptions,
  type KbGraphExportResult,
} from './kb/graph-export.js'
// 文档转换探测（doctor 用）；实现与 anydoc 同在 @prism/knowledge
export { probeConverter } from '@prism/knowledge'
// 本地向量化（变更 2）：Prism 自理，分档（小/默认/强）按算力自动选
export {
  EMBEDDING_CTX,
  EMBEDDING_DIM,
  EMBEDDING_PORT,
  activeModel,
  activeTier,
  embeddingInstalled,
  ensureEmbeddingServer,
  embedText,
  preferredBackend,
  setEmbeddingTier,
  stopEmbeddingServer,
  type EmbedText,
  type EmbeddingBackend,
} from './kb/embedding.js'
export {
  EMBEDDING_MODELS,
  EMBEDDING_TIERS,
  resolveTier,
  type EmbeddingModelDef,
  type EmbeddingTier,
} from './kb/embedding-models.js'
export { ScanHistory, type ScanRecord } from './kb/scan-history.js'
export {
  writeEnrichment,
  type EnrichmentResult,
  type WritebackReport,
} from './kb/enrich-writeback.js'
export {
  buildContextPack,
  estimateTokens,
  type ContextPack,
  type ContextPackItem,
  type ContextPackOptions,
} from './kb/context-pack.js'
export {
  DEFAULT_IGNORE_DIRS,
  extractTitle,
  idFromRel,
  makeDryRunKb,
  moduleFromRel,
  scanProject,
  type ScanOptions,
  type ScanReport,
  type ScannedFile,
} from './kb/scan.js'
// 文档转换（anydoc 封装；MCP prism_kb_convert / CLI 用）
export {
  convertFileToMarkdown,
  type ConvertFileOptions,
  type ConvertFileResult,
} from './kb/convert-file.js'

// 任务完成 → 沉淀建议清单（F-E3：只建议不落库；CLI `task report` 与 MCP 共用）
export {
  buildDepositSuggestions,
  inferDepositKinds,
  type DepositSuggestion,
  type DepositSuggestionInput,
} from './tasks/deposit-suggestions.js'

// 图谱
export {
  resolveGraphifyCommand,
  runGraphify,
  buildGraphArgs,
  vendoredGraphifyDir,
  vendoredGraphifyVersion,
  defaultGraphPath,
  graphQuery,
  graphPath,
  graphExplain,
  graphAffected,
  graphGodNodes,
  graphSummary,
  graphExport,
  renderExternalGraph,
  exportExternalGraph,
  GRAPHIFY_EXPORT_FORMATS,
  EXPORT_FORMAT_LABELS,
  type GraphifyExportFormat,
  type GraphExportResult,
  type GraphQueryOptions,
  formatCommand,
  DEFAULT_GRAPHIFY_TIMEOUT_MS,
  // v5 F-C2：多项目合并（低层命令封装；CLI 经公共面调用，避免复刻 argv 造成契约漂移）
  mergeGraphArgs,
  mergeGraphs,
  type MergeGraphsResult,
} from './graph/graphify.js'
export { BuildJobManager, type BuildJob, type BuildRunner, type JobStatus } from './graph/jobs.js'
export {
  mergedGraphDir,
  mergeProjectGraphs,
  type MergeProjectInput,
  type MergeProjectGraphsOptions,
  type MergeProjectGraphsResult,
} from './graph/merge.js'
export { ProjectRegistry, inspectGraphStatus, type ProjectInfo, type GraphStatusDetail } from './graph/registry.js'

// 架构图谱（Archify 封装，knowledge-base.md §4.4 / D10）
export {
  ARCHIFY_DIAGRAM_TYPES,
  ARCHIFY_TYPE_LABELS,
  ARCHIFY_VERSION,
  DEFAULT_ARCHIFY_TIMEOUT_MS,
  resolveArchifyCommand,
  runArchify,
  validateDiagram,
  renderDiagram,
  vendoredArchifyEntry,
  artifactMetaPath,
  artifactStat,
  irHash,
  irTitle,
  readArtifactMeta,
  readIrCopy,
  writeArtifactMeta,
  type ArchifyArtifactMeta,
  type ArchifyDiagramType,
  type ArchifyValidation,
  type RenderResult,
} from './graph/archify.js'

// 角色与团队域（返工单 B4：类型与行为委托 @prism/agents，server 仅保留 wiring/glue）。
// 显式导出：ENTRY_TYPES 与 kb/port 的导出同名（枚举一致），避免星号导出冲突。
export type {
  RoleColor,
  KnowledgeBinding,
  RoleDefinition,
  TeamMember,
  WorkflowStage,
  DepositRule,
  DepositPolicy,
  TeamDefinition,
  ValidationIssue,
  ValidationResult,
  TeamActivation,
  RoleInitResult,
  EffectiveSkill,
  EffectiveSkillSet,
  TeamInitOptions,
  TeamScaffold,
  LoadEffectiveSkillsInput,
} from './roles/index.js'
export {
  ORCHESTRATOR_ROLES,
  ROLE_COLORS,
  THOUGHT_LEVELS,
  KNOWLEDGE_LAYERS,
  parseRoleMarkdown,
  parseTeamMarkdown,
  parseRoleCell,
  parseWorkflowTable,
  extractPrinciple,
  stripInstanceMarker,
  validateRole,
  validateTeam,
  renderZcodeRole,
  renderZcodeTeam,
  initRole,
  activateTeam,
  // 沉淀策略执行 + 原则一致性
  applyDepositPolicy,
  priorityScore,
  checkPrincipleConsistency,
  claimsFinalSay,
  positionInChain,
  loadRoles,
  loadRole,
  loadTeams,
  loadTeam,
  installedSkillNames,
  // 团队脚手架渲染（F-C1/F-C3 同一实现）+ Skill 有效集（F-D1 纯函数 / F-D2 装配）
  renderTeamScaffold,
  parseMembersSpec,
  computeEffectiveSkills,
  loadEffectiveSkills,
  // 目录解析（装配语义简化：prism.yaml 覆盖适配器默认）
  loadPrismConfig,
  parsePrismConfig,
  resolveDirs,
  resolveDirsFromHome,
  expandTildePath,
  ROLE_TEMPLATE_MD,
  splitFrontmatter,
  parseFrontmatter,
  emitScalar,
  serializeFrontmatter,
  roleMarker,
  teamMarker,
  hasPrismMarker,
  hasTeamMarker,
  harnessPaths,
  defaultHarnessRoot,
  CORE_DEV_TEAM_MD,
  teamNotFoundMessage,
  roleNotFoundMessage,
} from './roles/index.js'

// AGENTS.md 注入块（knowledge-injection.md §5 模式 C）
export {
  injectAgentsBlock,
  removeAgentsBlock,
  hasPrismBlock,
  findPrismBlock,
} from '@prism/agents'

// Harness 适配器插件（<PRISM_HOME>/harnesses/ 运行期自动注册）
export {
  ensureHarnessPluginsLoaded,
  harnessDir,
  harnessPluginReport,
  harnessPluginsDir,
  listHarnesses,
  type HarnessPluginLoad,
} from '@prism/agents'

// MCP stdio
export { createMcpTools, handleRpcRequest, runMcpStdio, type McpTool, type McpDeps } from './mcp/server.js'
