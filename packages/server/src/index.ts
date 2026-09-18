/**
 * @prism/server — Prism HTTP 服务 + stdio MCP
 * 零框架（node:http / node:util.parseArgs / 手写 JSON-RPC）。
 */

// 应用与启动
export { createApp, startServer, type AppOptions, type AppHandle } from './app.js'

// 回收站装配点（v9 F3）：三入口（MCP/HTTP/CLI）共用同一 TrashStore 构造（trashDir + AuditLog 归属 home）
export { trashStoreFor } from './trash.js'

// 控制台（HTTP serve）的按需拉起 / 状态 / 停止——CLI `serve --ensure|--check|--stop`
// 与宿主启动时的 MCP 共用同一套实现（幂等；只认 Prism 自己的 /api/health）
export {
  ensureServe,
  probeServe,
  stopServe,
  serveStatePath,
  serveLogPath,
  backgroundServeEntry,
  backgroundServeArgv,
  DEFAULT_SERVE_PORT,
  type ServeStatus,
  type ServeRecord,
  type EnsureServeOptions,
  type EnsureServeResult,
  type StopServeResult,
  type ServeLauncher,
} from './serve-control.js'

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
export {
  loadKnowledgeService,
  applyEmbeddingConfig,
  // v13 §1.1：CLI 的 `kb reindex --chunks` 需与服务**同一份** chunkOptions（单点解析）
  resolveKbConfigForHome,
  CHUNK_MIN_CHARS,
  type KbWiringConfig,
} from './kb/wiring.js'
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
  accelBackend,
  activeModel,
  activeTier,
  cpuBackendHint,
  embeddingInstalled,
  ensureEmbeddingServer,
  embedText,
  gpuBackendLabel,
  gpuServerCandidates,
  preferredBackend,
  setEmbeddingTier,
  stopEmbeddingServer,
  type AccelBackend,
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
  BUILD_CONFIG_BASENAMES,
  BUILD_CONFIG_DOT_PREFIXES,
  BUILD_FILE_NAMES,
  BUILD_FILE_SUFFIXES,
  DEFAULT_IGNORE_DIRS,
  DOC_ONLY_EXTENSIONS,
  GATE_SKIP_REASONS,
  SKIP_REASONS,
  WEB_EXTENSIONS,
  extractTitle,
  idFromRel,
  isBuildFileName,
  makeDryRunKb,
  moduleFromRel,
  normalizeExtensions,
  scanProject,
  type ScanOptions,
  type ScanReport,
  type ScannedFile,
} from './kb/scan.js'
// `.gitignore` 解析（扫描范围过滤；纯函数，零外部依赖）
export {
  createGitignoreMatcher,
  GitignoreMatcher,
  parseGitignore,
  type GitignoreRule,
} from './kb/gitignore.js'
// 文档转换（anydoc 封装；MCP prism_kb_convert / CLI 用）
export {
  convertFileToMarkdown,
  type ConvertFileOptions,
  type ConvertFileResult,
} from './kb/convert-file.js'

// 图谱
export {
  resolveGraphifyCommand,
  runGraphify,
  buildGraphArgs,
  vendoredGraphifyDir,
  vendoredGraphifyVersion,
  defaultGraphPath,
  readCodeGraph,
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
  PRISM_EXCLUDED_SCAN_DIR,
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
  ARCHIFY_SCHEMA_KEYS,
  readArchifySchema,
  artifactMetaPath,
  artifactStat,
  irHash,
  irTitle,
  readArtifactMeta,
  readIrCopy,
  writeArtifactMeta,
  type ArchifyArtifactMeta,
  type ArchifyDiagramType,
  type ArchifySchemaKey,
  type ArchifyValidation,
  type RenderResult,
} from './graph/archify.js'

// 架构图产物**落盘路由**（v9 F1）：三入口同口径（MCP / HTTP / CLI 共用）。
// 消费方：CLI `arch from-graph`（缺省落项目目录）、HTTP/MCP 的 project 落点解析。
export {
  PROJECT_DIAGRAM_TYPES,
  assertProjectRoot,
  globalArchDir,
  isProjectDiagramType,
  projectArchDir,
  resolveArchPlacement,
  sanitizeArtifactName,
  type ArchPlacement,
  type ArchPlacementInput,
  type ProjectDiagramType,
} from './graph/arch-placement.js'

// 角色与团队域（返工单 B4：类型与行为委托 @prism/agents，server 仅保留 wiring/glue）。
// 显式导出：ENTRY_TYPES 与 kb/port 的导出同名（枚举一致），避免星号导出冲突。
export type {
  RoleColor,
  KnowledgeBinding,
  RoleDefinition,
  TeamMember,
  WorkflowStage,
  WorkflowCoreField,
  RawWorkflowTable,
  ParseIssue,
  WorkflowParseResult,
  WorkflowSerializeRow,
  WorkflowSerializeInput,
  DepositRule,
  DepositPolicy,
  TeamDefinition,
  ValidationIssue,
  ValidationResult,
  TeamActivation,
  RoleWriteResult,
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
  // v11 F2：工作流弹性解析 / 序列化 / 双形态落点（消费方：GET workflow_raw、PATCH workflow）
  parseWorkflowSection,
  locateWorkflowSection,
  mapWorkflowColumns,
  serializeWorkflowTable,
  serializeWorkflowSection,
  WorkflowSectionMissingError,
  resolveTeamFile,
  extractPrinciple,
  stripInstanceMarker,
  validateRole,
  validateTeam,
  renderZcodeRole,
  renderZcodeTeam,
  newRole,
  editRole,
  removeRole,
  patchRoleRaw,
  editTeam,
  removeTeam,
  patchTeamRaw,
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
  ROLE_BODY_SKELETON,
  splitFrontmatter,
  parseFrontmatter,
  emitScalar,
  serializeFrontmatter,
  roleMarker,
  teamMarker,
  hasPrismMarker,
  hasTeamMarker,
  harnessPaths,
  harnessAdapterOf,
  roleRendererFor,
  defaultHarnessRoot,
  CORE_DEV_TEAM_MD,
  teamNotFoundMessage,
  roleNotFoundMessage,
} from './roles/index.js'

// 角色/团队写盘（HTTP 与 MCP 共用；CLI 也走同一实现，避免三份写路径漂移）
export {
  createRoleDefinition,
  updateRoleDefinition,
  deleteRoleDefinition,
  createTeamDefinition,
  updateTeamDefinition,
  deleteTeamDefinition,
  type RoleWriteBody,
  type RoleWriteOutcome,
  type NewTeamBody,
  type UpdateTeamBody,
  type CreateTeamResult,
} from './roles/index.js'

// 技能分类存储（v12 F4 双节形态：`<PRISM_HOME>/skill-categories.json`；三入口共用）
export {
  SkillCategoryStore,
  parseCategorizeInput,
  type SkillCategoryData,
  type SkillCategoryMap,
  type SkillCategorizeResult,
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
