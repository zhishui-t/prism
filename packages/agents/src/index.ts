/**
 * @prism/agents — 专家角色与团队定义：解析、校验、渲染、ZCode 适配器与装配。
 *
 * 公共 API 即 design-v3 §3.1 冻结契约（types.ts）+ 各模块实现。
 * 依赖方向：core ← agents（不依赖 knowledge；frontmatter 解析独立实现）。
 */

// 冻结类型（dev-2 消费面）
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
  RoleRegistry,
  TeamRegistry,
  TeamActivation,
  InstallOptions,
  InstallResult,
} from './types.js'

// frontmatter（独立 YAML 子集，§3.1.1）
export {
  FrontmatterError,
  splitFrontmatter,
  parseFrontmatter,
  serializeFrontmatter,
  renderMarkdownFile,
  emitScalar,
  stripPrismMarkerTail,
} from './frontmatter.js'
export type { FrontmatterData, FrontmatterValue } from './frontmatter.js'

// 角色
export { RoleParseError, parseRoleMarkdown, extractPrinciple, extractSection, toRoleParseError } from './role/parse.js'
export type { ParseRoleOptions } from './role/parse.js'
export { validateRole, validateRoleUniqueness, ROLE_COLORS, THOUGHT_LEVELS, DESCRIPTION_MAX } from './role/validate.js'
export type { ValidateRoleOptions } from './role/validate.js'
export { renderZcodeRole, roleMarker, hasPrismMarker } from './role/render.js'
export type { RenderEnv } from './role/render.js'

// 团队
export { TeamParseError, parseTeamMarkdown, parseWorkflowTable, parseRoleCell } from './team/parse.js'
export type { ParseTeamOptions } from './team/parse.js'
export { validateTeam, stripInstanceMarker, ORCHESTRATOR_ROLES, ENTRY_TYPES, KNOWLEDGE_LAYERS } from './team/validate.js'
export type { ValidateTeamOptions } from './team/validate.js'
export {
  applyDepositPolicy,
  priorityScore,
  type DepositPolicyOutcome,
  type PolicyDepositInput,
} from './team/deposit-policy.js'
export { activateTeam } from './team/activate.js'
export type { ActivateTeamOptions } from './team/activate.js'
export { renderZcodeTeam, teamMarker, hasTeamMarker } from './team/render.js'

// 适配器
export {
  createZcodeAdapter,
  DEFAULT_ZCODE_DIR,
  ZCODE_ADAPTER_ID,
  ZCODE_FRONTMATTER_FIELDS,
} from './adapters/zcode.js'
export type { ZcodeAdapterOptions } from './adapters/zcode.js'

// 注册表
export { createRoleRegistry, createTeamRegistry } from './registry.js'
export type { ImportFailures } from './registry.js'

// 装配
export { installRoles, installTeamDefinitions, initRole, migrateTeams, InstallError } from './install.js'
export type { InstallTeamsOptions, InitRoleOptions, MigrateTeamsOptions } from './install.js'

// 宿主适配器注册表（deployment-model §1：编译期多适配器，运行期只激活一个）
export {
  buildHarnessRegistry,
  resolveHarness,
  harnessSummary,
} from './harness.js'
export { DEFAULT_HARNESS_ID, HARNESS_ENV_VAR, ZCODE_HARNESS_ID } from './harness-id.js'
export type {
  PrismHarnessAdapter,
  BuildHarnessRegistryOptions,
  ResolveHarnessOptions,
  ResolvedHarness,
} from './harness.js'

// 目录解析（装配语义简化：直接住在宿主目录；prism.yaml 可选覆盖）
export {
  loadPrismConfig,
  parsePrismConfig,
  resolveDirs,
  resolveDirsFromHome,
  expandTildePath,
} from './dirs.js'
export type { PrismDirConfig, PrismDirKey, ResolvedDirs } from './dirs.js'

// 内置模板
export { ROLE_TEMPLATE_MD, ROLE_TEMPLATE_NAME_PLACEHOLDER } from './templates.js'
