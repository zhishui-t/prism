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
  KnowledgeEntry,
  SearchQuery,
  SearchResult,
  BookNode,
  KbStats,
  KnowledgeService,
  KbFactory,
} from './kb/port.js'
export { LAYERS, ENTRY_TYPES } from './kb/port.js'
export { loadKnowledgeService } from './kb/wiring.js'
export {
  exportKnowledgeGraph,
  kbGraphWorkDir,
  type KbGraphExportOptions,
  type KbGraphExportResult,
} from './kb/graph-export.js'
// 文档转换探测（doctor 用）；实现与 anydoc 同在 @prism/knowledge
export { probeConverter } from '@prism/knowledge'
export { ScanHistory, type ScanRecord } from './kb/scan-history.js'
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
  moduleFromRel,
  scanProject,
  type ScanOptions,
  type ScanReport,
  type ScannedFile,
} from './kb/scan.js'

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
} from './graph/graphify.js'
export { BuildJobManager, type BuildJob, type BuildRunner, type JobStatus } from './graph/jobs.js'
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
  InstallResult,
  InstallOptions,
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
  renderPrismRole,
  installRoles,
  installTeamDefinitions,
  initRole,
  migrateTeams,
  installTeam,
  activateTeam,
  loadRoles,
  loadRole,
  loadTeams,
  loadTeam,
  installedSkillNames,
  parseRoleFile,
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
  zcodePaths,
  defaultZcodeDir,
  CORE_DEV_TEAM_MD,
} from './roles/index.js'

// MCP stdio
export { createMcpTools, handleRpcRequest, runMcpStdio, type McpTool, type McpDeps } from './mcp/server.js'
