/**
 * 角色/团队域装配点（返工单 B4：委托 `@prism/agents`，消除契约镜像漂移）。
 *
 * - 类型：一律 re-export agents（design-v3 §3.1 冻结契约的唯一来源，不保留第二份定义）；
 * - 行为：解析/校验/渲染/装配/启用直接转发 agents；
 * - wiring：仅保留目录加载 + issues 挂载（P9）、装配组合与签名兼容 shim（见 wiring.ts）；
 * - templates：server 侧出厂团队模板（agents 无此资产）。
 */

// 冻结类型（唯一来源：@prism/agents；requirement 3：不保留两份类型定义）
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
  InstallOptions,
  InstallResult,
  EffectiveSkill,
  EffectiveSkillSet,
  TeamInitOptions,
  TeamScaffold,
} from '@prism/agents'

// 行为委托：解析 / 校验 / 渲染 / 装配 / 启用 / frontmatter / 标记 / 常量
export {
  // 解析
  parseRoleMarkdown,
  parseTeamMarkdown,
  parseWorkflowTable,
  parseRoleCell,
  extractPrinciple,
  // 校验
  validateRole,
  validateTeam,
  validateRoleUniqueness,
  stripInstanceMarker,
  // 渲染（ZCode 产物）
  renderZcodeRole,
  renderZcodeTeam,
  // 模板初始化（装配/导入语义已于 2026-09-11 移除）
  initRole,
  // 团队脚手架渲染（F-C1/F-C3 同一实现；只渲染不落盘）+ Skill 有效集纯函数（F-D1）
  renderTeamScaffold,
  parseMembersSpec,
  computeEffectiveSkills,
  // 启用（P8：dispatch 仅由 installed 推导）
  activateTeam,
  // 团队沉淀策略机械执行（team-definition.md §5）
  applyDepositPolicy,
  priorityScore,
  // 原则一致性检查（role-definition.md §2.1）
  checkPrincipleConsistency,
  claimsFinalSay,
  positionInChain,
  // frontmatter / 标记
  splitFrontmatter,
  parseFrontmatter,
  emitScalar,
  serializeFrontmatter,
  renderMarkdownFile,
  roleMarker,
  teamMarker,
  hasPrismMarker,
  hasTeamMarker,
  // 常量与枚举（KNOWLEDGE_LAYERS/ENTRY_TYPES 与 knowledge 域一致）
  ROLE_COLORS,
  THOUGHT_LEVELS,
  KNOWLEDGE_LAYERS,
  ORCHESTRATOR_ROLES,
  ENTRY_TYPES,
  DESCRIPTION_MAX,
  // 适配器与注册表（需要更细控制时直接消费）
  createZcodeAdapter,
  createRoleRegistry,
  createTeamRegistry,
  DEFAULT_ZCODE_DIR,
  // 宿主适配器注册表（deployment-model §1：运行期只激活一个）
  buildHarnessRegistry,
  resolveHarness,
  harnessSummary,
  DEFAULT_HARNESS_ID,
  HARNESS_ENV_VAR,
} from '@prism/agents'
export type {
  PrismHarnessAdapter,
  ResolvedHarness,
} from '@prism/agents'

// 目录解析（装配语义简化：prism.yaml 覆盖适配器默认；server 读侧同样由此取目录）
export {
  loadPrismConfig,
  parsePrismConfig,
  resolveDirs,
  resolveDirsFromHome,
  expandTildePath,
  ROLE_TEMPLATE_MD,
  type PrismDirConfig,
  type ResolvedDirs,
} from '@prism/agents'

// server 侧 glue（目录加载 + issues、路径约定、有效集装配；装配/导入 shim 已于 2026-09-11 移除）
export {
  loadRoles,
  loadRole,
  loadTeams,
  loadTeam,
  installedSkillNames,
  harnessPaths,
  defaultHarnessRoot,
  loadEffectiveSkills,
  teamNotFoundMessage,
  type HarnessPaths,
  type LoadEffectiveSkillsInput,
} from './wiring.js'

// 新建团队定义（F-C3：HTTP POST /api/teams 与 MCP prism_team_create 共用写路径）
export {
  createTeamDefinition,
  asNonEmptyString,
  parseMembers,
  type NewTeamBody,
  type CreateTeamResult,
} from './team-create.js'

// 出厂团队模板（server 侧资产）
export { CORE_DEV_TEAM_MD } from './templates.js'
