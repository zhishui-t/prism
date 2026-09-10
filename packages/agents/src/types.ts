/**
 * @prism/agents — 角色与团队类型（**接口冻结**，design-v3 §3.1）。
 *
 * 本文件是 dev-2（skills/server/cli）消费的冻结契约：
 * 只放类型形状，不放行为；行为见 role/ team/ adapters/ registry/ install 模块。
 */

export type RoleColor = 'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan'

/** 知识绑定：层 + 可选书（省略 books = 该层全部）。 */
export interface KnowledgeBinding {
  layers: Array<'global' | 'project' | 'role'>
  books?: string[]
}

/** 专家角色定义（决策契约，role-definition.md）。 */
export interface RoleDefinition {
  /** kebab-case；Prism 原生存储 = 目录名，ZCode 产物 = 文件名。 */
  name: string
  description: string
  color?: RoleColor
  /** 能力白名单；**空数组 = 未声明能力**（校验给 warning，不是 error）。 */
  skills: string[]
  knowledge: KnowledgeBinding
  /** `## 核心契约` / `## 核心第一原则` 正文（决策层）。 */
  principle: string
  /** 完整正文（frontmatter 之后）。 */
  body: string
  // 环境属性（导入保留，渲染时由环境决定是否写入产物）
  model?: string
  thoughtLevel?: 'low' | 'high' | 'max'
  injectAgentsMd?: boolean
  /** 来源文件（导入时记录）。 */
  sourcePath?: string
  /** 校验结果（server 返回时携带，供 Web 展示）。 */
  issues?: ValidationIssue[]
}

/** 团队成员：引用角色库中的角色 + 实例数量。 */
export interface TeamMember {
  role: string
  count: number
}

/**
 * 工作流阶段（P1 修订）。
 * `roles` 为**多角色**数组，元素语法：
 *   - `dev-1`            引用角色库中的角色
 *   - `dev-1#2`          该角色的第 2 个实例（实例记号）
 *   - `leader` / `队长`  编排角色，**豁免 members 校验**（见 validateTeam）
 */
export interface WorkflowStage {
  order: number
  stage: string
  /** 多角色；元素可带 #N 实例记号。 */
  roles: string[]
  mode: 'serial' | 'parallel'
  input: string
  output: string
  done: string
  reflow: string
}

/** 沉淀规则：按内容特征覆盖默认落点（P4）。 */
export interface DepositRule {
  /** 如 { type: 'rule' } / { tags: ['security'] }。 */
  match: Record<string, unknown>
  /** 如 { layer: 'global', priority: 'high' }。 */
  set: Record<string, unknown>
}

/** 知识沉淀策略。 */
export interface DepositPolicy {
  enabled: boolean
  default_layer: 'global' | 'project' | 'role'
  /** 必须 ∈ EntryType（knowledge：rule/doc/guide/pitfall/pattern/diagram/summary/other）。 */
  default_type: string
  priority: 'low' | 'medium' | 'high'
  require_note: boolean
  /** 按内容特征覆盖默认值（本期只解析校验，不执行合并）。 */
  rules?: DepositRule[]
}

/** 团队定义（team-definition.md）。 */
export interface TeamDefinition {
  team_id: string
  name: string
  description: string
  default: boolean
  /** P4：继承另一个团队（本期只解析记录，不实现合并）。 */
  extends?: string | null
  members: TeamMember[]
  skills: string[]
  knowledge: KnowledgeBinding
  deposit: DepositPolicy
  arbitration: string[]
  /** 返工上限（轮），正整数，默认 2。 */
  rework_limit: number
  workflow: WorkflowStage[]
  body: string
  issues?: ValidationIssue[]
}

export interface ValidationIssue {
  level: 'error' | 'warning'
  code: string
  message: string
  where?: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

export interface RoleRegistry {
  list(): RoleDefinition[]
  get(name: string): RoleDefinition | undefined
  importFromDir(dir: string): Promise<RoleDefinition[]>
}

export interface TeamRegistry {
  list(): TeamDefinition[]
  get(teamId: string): TeamDefinition | undefined
  loadFromDir(dir: string): Promise<TeamDefinition[]>
}

/** 启用团队（P8 修订：返回成员角色定义本体，供 fallback 派发粘契约）。 */
export interface TeamActivation {
  team_id: string
  team_name: string
  members: Array<{
    role: string
    count: number
    installed: boolean
    dispatch: 'native' | 'fallback'
    /** fallback 时宿主需要粘进 prompt 的角色定义本体。 */
    definition?: RoleDefinition
    hint?: string
  }>
  workflow: WorkflowStage[]
  skills: string[]
  knowledge: KnowledgeBinding
  deposit: DepositPolicy
  arbitration: string[]
  rework_limit: number
}

/** 角色装配选项（目标目录由参数传入，**绝不硬编码宿主根**）。 */
export interface InstallOptions {
  targetDir: string
  roles: RoleDefinition[]
  env?: {
    model?: string
    thoughtLevel?: string
  }
  force?: boolean
  /** 渲染用适配器；缺省取激活适配器（测试可注入，避免硬编码 ZCode 格式）。 */
  adapter?: import('@prism/core').HarnessAdapter<RoleDefinition, TeamDefinition>
}

export interface InstallResult {
  written: string[]
  skipped: {
    path: string
    reason: string
  }[]
}
