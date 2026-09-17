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

/**
 * 工作流核心字段名（v11 F2 弹性表格模型）。
 * 列名 → 字段的同义词映射表落在 `team/parse.ts`（行为，不放进类型文件）。
 */
export type WorkflowCoreField = 'order' | 'name' | 'roles' | 'mode' | 'input' | 'output' | 'done' | 'reflow'

/**
 * 工作流表的**原始底账**（v11 F2，design-v11 §1）。
 *
 * 存在理由：`WorkflowStage` 只是核心字段的语义投影，未映射列（自定义列）与行的**身份**
 * 不在其中；编辑后回写要保列集、保未映射列值，必须靠这份底账。
 */
export interface RawWorkflowTable {
  /** 表头原样（含未映射列），已按转义契约解码。 */
  columns: string[]
  /** 数据行单元格原样（已解码，长度已对齐表头——列数不符者已截断/补空）。 */
  rows: string[][]
  /** 行身份 `r1..rn`（原始行序）——编辑合并未映射列的锚（R-v11-3）。 */
  rowIds: string[]
  /**
   * 表格首行（表头行）在**解析输入**中的 0 基行号（v11 派修 B-1）。
   *
   * 写回定位用：`serializeWorkflowSection` 只 splice `[headerLine, lastLine]` 行区间为
   * 新表格，区间外的段落/引用块/第二张表逐行原样保留（不再整节替换 → 静默删正文）。
   * 行号基于 `parseWorkflowSection` 的**同一入参字符串**（`patchTeamRaw` 里 parse 与
   * serialize 吃同一份 `nextBody`，天然对齐）；无表格（prose / sectionMissing）时缺省。
   */
  headerLine?: number
  /** 表格**末行**（末数据行；空表 = 分隔行）在解析输入中的 0 基行号。 */
  lastLine?: number
}

/** 工作流行级降级诊断（R-v11-5：不抛异常的替代通道，GET 层并入响应 issues）。 */
export interface ParseIssue {
  code: string
  message: string
  /** 1 起始的**整份文件**行号（可判定时给）。 */
  line?: number
}

/** `## 工作流` 小节的弹性解析结果（design-v11 §1）。 */
export interface WorkflowParseResult {
  /** 语义映射后的核心字段（缺列按缺省值：order←行号、mode←serial、其余空）。 */
  stages: WorkflowStage[]
  /** 原始表格（有表格时必带）——序列化的保真底账。 */
  raw?: RawWorkflowTable
  /** 未映射列名（含同义双列冲突中被表序靠前者挤掉的那列）。 */
  unmappedColumns: string[]
  /** 小节存在但无表格（仅自由文本）。 */
  prose?: boolean
  /**
   * prose 小节的**原文**（v11 收口）：`## 工作流` 标题行之后到下一个 `## ` 标题之前的内容，
   * 去首尾空行、保留内部行。仅 `prose === true` 时给出；表格态 / sectionMissing → `undefined`
   * （server GET 层会归一为 `''`，保证字段恒存在）。
   */
  proseText?: string
  /** 全文无 `## 工作流` 小节——与 prose 区分（R-v11-7）。 */
  sectionMissing?: boolean
  issues: ParseIssue[]
}

/** 序列化输入的一行（编辑后的阶段 + 未映射列值）。 */
export interface WorkflowSerializeRow {
  /**
   * 原 raw 行身份（`RawWorkflowTable.rowIds` 之一）。
   * 有 → 对齐原 raw 行合并未映射列；无 → 新行（按序插入，未映射列空）。
   */
  rowId?: string
  order: number
  stage: string
  roles: string[]
  mode: 'serial' | 'parallel'
  input: string
  output: string
  done: string
  reflow: string
  /** 未映射列值（列名 → 值）；缺省时回落到 raw 中该 rowId 的原值。 */
  extra?: Record<string, string>
}

/** 工作流表格序列化输入（design-v11 §2）。 */
export interface WorkflowSerializeInput {
  /** 列集（含未映射列，保持列序）。缺省：取 `raw.columns`；再无 → 核心八列 + `原文`。 */
  columns?: string[]
  rows: WorkflowSerializeRow[]
  /** 原 raw 底账（列序 + 未映射列合并来源 + rowId 索引）。 */
  raw?: RawWorkflowTable
}

/** 沉淀规则：按内容特征覆盖默认落点（P4）。 */
export interface DepositRule {
  /**
   * 可匹配键（design-v4 F-E1，全部精确相等，tags 例外为「包含全部」）：
   * `type` / `layer` / `risk` / `book` / `module` / `tags`；未知键一律不匹配（保守）。
   */
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
  /** 按内容特征覆盖默认值（**解析 + 机械执行合并**；执行见 team/deposit-policy.ts）。 */
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

/**
 * 角色写盘结果（`prism role new | edit`；`written` 为空 / `skipped` 非空 = 目标已存在且未 `--force`）。
 *
 * 2026-09-12 两次改名，都是为了跟上命令语义：`InstallResult` → `RoleInitResult` → `RoleWriteResult`。
 * 旧的 `InstallOptions`（`targetDir` + `roles` + `force` + 渲染适配器）已作为**死类型**删除——
 * 它唯一真实使用者是随「装配语义」删除的 `installRoles`。
 */
export interface RoleWriteResult {
  written: string[]
  skipped: {
    path: string
    reason: string
  }[]
}
