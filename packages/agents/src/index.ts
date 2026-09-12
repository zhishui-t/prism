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
  RoleInitResult,
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
export {
  injectAgentsBlock,
  removeAgentsBlock,
  hasPrismBlock,
  findPrismBlock,
  PRISM_BLOCK_BEGIN,
  PRISM_BLOCK_END,
  type InjectResult,
} from './agents-md.js'
export type { ParseRoleOptions } from './role/parse.js'
export {
  checkPrincipleConsistency,
  claimsFinalSay,
  positionInChain,
  type ConsistencyOptions,
} from './role/consistency.js'
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
export { resolveTeamExtends, MAX_EXTENDS_DEPTH, type TeamResolver, type MergeTeamInput } from './team/extends.js'
// 团队工作流 → archify workflow IR（F-C4；纯函数，零 IO 零时钟）
export { buildTeamWorkflowIr } from './team/workflow-ir.js'
export type {
  WorkflowIr,
  WorkflowIrLane,
  WorkflowIrNode,
  WorkflowIrEdge,
  WorkflowIrPhase,
  WorkflowNodeType,
} from './team/workflow-ir.js'
export { activateTeam } from './team/activate.js'
export type { ActivateTeamOptions } from './team/activate.js'
export { renderZcodeTeam, teamMarker, hasTeamMarker } from './team/render.js'
// `team init` 脚手架（只渲染不落盘；F-C1）+ 内置团队模板（独立于 server 出厂模板）
export { renderTeamScaffold, parseMembersSpec, type TeamInitOptions, type TeamScaffold } from './team/init.js'
export {
  MINIMAL_TEAM_MD,
  CORE_DEV_TEAM_MD,
  TEAM_TEMPLATES,
  TEAM_TEMPLATE_TEAM_ID_PLACEHOLDER,
  TEAM_TEMPLATE_NAME_PLACEHOLDER,
  TEAM_TEMPLATE_DESCRIPTION_PLACEHOLDER,
  fillTeamTemplate,
} from './team/templates.js'

// Skill 有效集（F-D1：纯函数；装配函数在 server/src/roles/wiring.ts）
export {
  computeEffectiveSkills,
  type EffectiveSkill,
  type EffectiveSkillSet,
  type ComputeEffectiveSkillsInput,
} from './skill-effective.js'

// 注册表
export { createRoleRegistry, createTeamRegistry } from './registry.js'
export type { ImportFailures } from './registry.js'

// 角色模板初始化（「装配」语义已随「角色直接住宿主目录」移除：无 installRoles / installTeamDefinitions / migrateTeams）
export { initRole, InitRoleError } from './init-role.js'
export type { InitRoleOptions } from './init-role.js'

// 宿主适配器注册表（deployment-model §1：编译期多适配器，运行期只激活一个）
// **新增 harness 只改 `harness-manifest.ts`（加一行），本文件无需改动**——
// 清单与默认 id 从这里转出，消费方拿到的都是通用符号。
export {
  buildHarnessRegistry,
  resolveHarness,
  harnessLayout,
  harnessSummary,
  listHarnesses,
  harnessDir,
  type HarnessListing,
} from './harness.js'
export {
  HARNESS_MANIFEST,
  DEFAULT_HARNESS_ID,
  HARNESS_ENV_VAR,
  type HarnessEntry,
  type HarnessFactoryOptions,
} from './harness-manifest.js'
// **Harness 适配器插件**（运行期自动注册：第三方把包放 <PRISM_HOME>/harnesses/ 即可）
export {
  loadHarnessPlugins,
  ensureHarnessPluginsLoaded,
  harnessPluginReport,
  harnessPluginsDir,
  harnessPluginsLoaded,
  resetHarnessPlugins,
  externalHarnessIds,
  type HarnessPluginLoad,
} from './harness-plugins.js'
export type {
  PrismHarnessAdapter,
  BuildHarnessRegistryOptions,
  ResolveHarnessOptions,
  ResolvedHarness,
  HarnessLayout,
} from './harness.js'

// 内置适配器：**转出各个适配器是历史包袱**（内部已有清单）。仍保留 zcode 的
// 具名导出供既有调用方使用；新增 harness 不必在此追加导出（走 HARNESS_MANIFEST）。
export {
  createZcodeAdapter,
  DEFAULT_ZCODE_DIR,
  ZCODE_ADAPTER_ID,
  ZCODE_FRONTMATTER_FIELDS,
} from './adapters/zcode.js'
export type { ZcodeAdapterOptions } from './adapters/zcode.js'

// 目录解析（装配语义简化：直接住在宿主目录；prism.yaml 可选覆盖）
export {
  loadPrismConfig,
  parsePrismConfig,
  resolveDirs,
  resolveDirsFromHome,
  expandTildePath,
} from './dirs.js'
export type { PrismDirConfig, PrismDirKey, ResolvedDirs, DirProvenance } from './dirs.js'

// 内置模板
export { ROLE_TEMPLATE_MD, ROLE_TEMPLATE_NAME_PLACEHOLDER } from './templates.js'
