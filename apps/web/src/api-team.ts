/** 角色 / 团队 / 技能 相关 API（design-v3.md §3.3）。 */

import type { Envelope } from './api.ts'

export interface KnowledgeBinding {
  layers: string[]
  books?: string[]
}

export interface RoleDefinition {
  name: string
  description: string
  color?: string
  skills: string[]
  knowledge: KnowledgeBinding
  principle: string
  body: string
  model?: string
  thoughtLevel?: string
  sourcePath?: string
  /** 校验结果（服务端随列表/详情返回，P9） */
  issues?: ValidationIssue[]
  /** 只读：宿主 agents 目录里是否已有该角色定义（server 侧包装，v5/S5） */
  installed?: boolean
}

export interface TeamMember {
  role: string
  count: number
}

export interface WorkflowStage {
  order: number
  stage: string
  /** 该阶段负责角色（多角色用 `name#N` 表示第 N 个实例） */
  roles: string[]
  mode: string
  input: string
  output: string
  done: string
  reflow: string
}

/* ==================== 工作流弹性表格模型（v11 F2 / design-v11 §1–§3） ====================
 *
 * 这一段的类型**全部是** `packages/agents/src/types.ts` 的镜像（跨包契约冻结：改 agents 侧
 * 必须同步本文件）。web 没有 `@prism/*` 依赖，故只能镜像、不能 import（design-v11 §3 / R-v11-9）。
 */

/** 工作流核心字段名（镜像 agents `WorkflowCoreField`）。 */
export type WorkflowCoreField = 'order' | 'name' | 'roles' | 'mode' | 'input' | 'output' | 'done' | 'reflow'

/** 阶段模式（镜像 agents 的写入口径：PATCH 只认这两档）。 */
export type WorkflowMode = 'serial' | 'parallel'

/**
 * 核心字段顺序（= 无表格起点时的列序）。镜像 agents `WORKFLOW_CORE_FIELDS`（`team/parse.ts`）。
 */
export const WORKFLOW_CORE_FIELDS: readonly WorkflowCoreField[] = [
  'order',
  'name',
  'roles',
  'mode',
  'input',
  'output',
  'done',
  'reflow',
]

/**
 * 核心字段 → 认的列名（**列名 trim 后全等**，不是「包含」；表序首中即用）。
 * 镜像 agents `HEADER_SYNONYMS`（`team/parse.ts`）——它是**解析契约**的一部分，
 * 编排器要靠它判断「某核心字段有没有对应列」。
 *
 * ⚠ 表里的中文用 `\u` 转义书写，**不是**走 `t()`：这些是**宿主数据**（团队文件里写死的表头
 * 字面量），认的是文件内容，不随界面语言变。转义与 `pages/teams/templates.ts` 的
 * `MODE_SERIAL` / `MODE_PARALLEL` 同一手法（语义完全一致，只是不触发裸 CJK 守卫）。
 * 每行末尾的注释是可读形态；改这里必须同步 agents 的 `HEADER_SYNONYMS`。
 */
export const WORKFLOW_HEADER_SYNONYMS: Readonly<Record<WorkflowCoreField, readonly string[]>> = {
  order: ['#', '\u5e8f\u53f7' /* 序号 */, 'Order'],
  name: ['\u9636\u6bb5' /* 阶段 */, '\u540d\u79f0' /* 名称 */, 'Stage'],
  roles: ['\u8d1f\u8d23\u89d2\u8272' /* 负责角色 */, '\u89d2\u8272' /* 角色 */, 'Roles'],
  mode: [
    '\u4e32/\u5e76\u884c' /* 串/并行 */,
    '\u4e32\u00b7\u5e76\u884c' /* 串·并行 */,
    '\u6a21\u5f0f' /* 模式 */,
    'Mode',
  ],
  input: ['\u8f93\u5165' /* 输入 */, 'Input'],
  output: ['\u8f93\u51fa' /* 输出 */, 'Output'],
  done: ['\u5b8c\u6210\u5224\u5b9a' /* 完成判定 */, '\u5224\u5b9a' /* 判定 */, 'Done'],
  reflow: ['\u56de\u6d41\u8def\u5f84' /* 回流路径 */, '\u56de\u6d41' /* 回流 */, 'Reflow'],
}

/** 标准 8 列列名（= 各核心字段的首个同义词）。镜像 agents `CORE_COLUMN_NAMES`。 */
export const WORKFLOW_CORE_COLUMNS: readonly string[] = WORKFLOW_CORE_FIELDS.map(
  (field) => WORKFLOW_HEADER_SYNONYMS[field][0]!,
)

/**
 * 自由文本 → 表格的起始列集里的那一列（design-v11 §2 / R-v11-9：起点列集三处口径统一）。
 * 镜像 agents `serialize.ts` 的同一字面量（同样是宿主数据，故同样转义书写：`原文`）。
 */
export const WORKFLOW_PROSE_COLUMN = '\u539f\u6587'

/**
 * 列 → 核心字段（`null` = 未映射列）。**贪心、表序靠前者胜**——与 agents
 * `mapWorkflowColumns` 逐行为等价：一列命中某字段后该字段即为「已用」，
 * 于是「既有 `输出` 又有 `Output`」时靠后的那列落成未映射列（R-v11-8）。
 *
 * 放在这里（而不是 `pages/teams/workflow-model.ts`）的原因：**读原始表格**（`workflow_raw`
 * → 阶段）也用它，那条路径属本文件（`adaptWorkflowParse`，见下），而 `workflow-model` 反向
 * 依赖 api-team ⇒ 定义只能落在被依赖的一侧（该文件只 re-export，见其 `mapColumns`）。
 */
export function mapWorkflowColumns(columns: readonly string[]): Array<WorkflowCoreField | null> {
  const used = new Set<WorkflowCoreField>()
  return columns.map((column) => {
    const name = column.trim()
    for (const field of WORKFLOW_CORE_FIELDS) {
      if (used.has(field)) continue
      if (WORKFLOW_HEADER_SYNONYMS[field].includes(name)) {
        used.add(field)
        return field
      }
    }
    return null
  })
}

/**
 * roles 单元格 → 角色 token（镜像 agents `parseRoleCell`）：`+` 分隔、`—` 视作空、
 * `dev-1/2` 展开为 `dev-1#1` / `dev-1#2`（实例记号），非法记号**原样保留**（不编造、不吞）。
 * 行级诊断归服务端（`workflow_role_cell_invalid`），web 只复现同一份 token 列表。
 */
function rolesFromCell(cell: string): string[] {
  const text = cell.trim()
  if (text === '' || text === '—' || text === '-') return []
  const tokens = text
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '—')
  const roles: string[] = []
  for (const token of tokens) {
    const shorthand = /^([^/#]+)\/(\d+)$/.exec(token)
    const count = shorthand === null ? 0 : Number.parseInt(shorthand[2]!, 10)
    if (shorthand !== null && !Number.isNaN(count) && count >= 1) {
      for (let k = 1; k <= count; k++) roles.push(`${shorthand[1]!.trim()}#${k}`)
    } else {
      roles.push(token)
    }
  }
  return roles
}

/**
 * **本文件表格**（`workflow_raw` 的 `columns` / `rows`）→ 阶段数组。
 *
 * 为什么 web 要从原始表格自己推阶段，而不是直接用 `TeamDefinition.workflow`（M-6 混源）：
 * GET 的 `workflow` 是 **extends 合并之后**的结果，而合并判据 `declared` 取的是 **frontmatter 键**
 * ——工作流在正文表格里，故 `declared` 永不含 `workflow`，`extends.ts` 的 `pick()` 于是
 * **父级的表恒胜出**（实测：子表 `子级自有阶段` → 合并结果 `父级阶段甲/乙`）；`workflow_raw`
 * 却是**被编辑文件本体**。两者混用 ⇒ 编辑器显示父级的阶段、却拿本文件的列集与行身份，
 * 保存时把父级的阶段写进本文件（子文件自己的表从未展示即被覆盖）。故**只认 `workflow_raw`**：
 * 所见 = 本文件所有。口径镜像 agents `team/parse.ts` 的 `buildStage`（同一张表，两处同一读法）。
 */
function stagesFromRawTable(columns: readonly string[], rows: readonly string[][]): WorkflowStage[] {
  const mapping = mapWorkflowColumns(columns)
  const valueOf = (cells: readonly string[], field: WorkflowCoreField): string => {
    const index = mapping.indexOf(field)
    return index === -1 ? '' : (cells[index] ?? '').trim()
  }
  return rows.map((cells, row) => {
    const orderText = valueOf(cells, 'order')
    const parsed = Number.parseInt(orderText, 10)
    return {
      // 缺列 / 非整数 → 按行号（与 agents 同口径；行级 issue 由服务端记）
      order: orderText === '' || Number.isNaN(parsed) ? row + 1 : parsed,
      stage: valueOf(cells, 'name'),
      // 与 agents 同口径：仅当 roles 列存在才解析
      roles: mapping.includes('roles') ? rolesFromCell(valueOf(cells, 'roles')) : [],
      // 与 agents 同口径：非「并行」即串行（`\u5e76\u884c` = 宿主数据「并行」，不走翻译）
      mode: valueOf(cells, 'mode').includes('\u5e76\u884c') ? 'parallel' : 'serial',
      input: valueOf(cells, 'input'),
      output: valueOf(cells, 'output'),
      done: valueOf(cells, 'done'),
      reflow: valueOf(cells, 'reflow'),
    }
  })
}

/**
 * 工作流表的**原始底账**（镜像 agents `RawWorkflowTable`）。
 * `rowIds` 是编辑合并未映射列的锚（R-v11-3）：排序 / 增删后未映射列值跟随行身份走，不错行。
 */
export interface RawWorkflowTable {
  columns: string[]
  rows: string[][]
  rowIds: string[]
}

/** 行级降级诊断（镜像 agents `ParseIssue`）。 */
export interface WorkflowParseIssue {
  code: string
  message: string
  /** 1 起始的整份文件行号（可判定时给）。 */
  line?: number
}

/** `## 工作流` 小节的弹性解析结果（镜像 agents `WorkflowParseResult` + 一处契约缺口补充）。 */
export interface WorkflowParseResult {
  stages: WorkflowStage[]
  /** 原始表格（有表格时必带）——序列化的保真底账。 */
  raw?: RawWorkflowTable
  /** 未映射列名（含同义双列冲突中被表序靠前者挤掉的那列）。 */
  unmappedColumns: string[]
  /** 小节存在但无表格（仅自由文本）。 */
  prose?: boolean
  /** 全文无 `## 工作流` 小节（与 `prose` 是两个态）。 */
  sectionMissing?: boolean
  issues: WorkflowParseIssue[]
  /**
   * 自由文本态的**小节原文**（`workflow_raw.proseText` 直传；服务端已下发，非 prose 态为空串）。
   *
   * design-v11 §3 要求 `prose` 态「Markdown 渲染 + 可一键结构化为表格」，两件事都要原文；
   * 服务端在 prose 态下发小节原文（`readTeamDetail` → `workflow_raw.proseText`），有表格时
   * 原文在 `原文` 列里。
   *
   * 只在**真的拿到**时给：拿不到就保持 `undefined`，UI 如实说「拿不到原文」——
   * **不编造、不把空串当原文**。
   */
  proseText?: string
  /**
   * M-6：本文件**没有**工作流表格（`prose` / `sectionMissing`）而**合并结果**有阶段时，
   * 这里带上那份「生效的」阶段——即**继承自父级**（extends 合并）的那份。
   *
   * 语义边界（两个方向都不能越）：
   * - 它是**只读提示**，不是本文件的内容：**绝不参与播种、绝不进提交**（写回只认本文件的
   *   `stages` / `raw`）；编辑器只在提示条里说明「来源是父级」；
   * - 只在这一态出现：本文件**有**表时 `stages` 就是本文件的（`def.workflow` 那份合并结果
   *   在没有 extends 时与本文件同源，在有 extends 时是父级的——但**不入本字段**，因为编辑器
   *   此时编排的是本文件的表，来源已由「本文件有表」自证，不需要提示条）。
   */
  inheritedStages?: WorkflowStage[]
}

/**
 * `GET /api/teams/:id` 的 `workflow_raw`（服务端包装，同 `installed` 先例 / design-v11 §3）。
 * 只有底账 + 两态标记：stages 仍走 `TeamDefinition.workflow`（不重复下发）。
 *
 * ⚠ 字段名以**服务端实际形态**为准（`packages/server/src/http/routes/people.ts` 的 `team` 路由）：
 * 未映射列那一个是 **`unmapped`**（design-v11 §3 的清单写的也是 `unmapped`）——不是 agents
 * `WorkflowParseResult.unmappedColumns`（那是解析层的名字，server 包装时改了名）。
 * 行级诊断**不在这里**：服务端把它并入**顶层** `issues`（`TeamDefinition.issues`，level=warning）。
 */
export interface WorkflowRawView {
  columns: string[]
  rows: string[][]
  rowIds: string[]
  /** 未映射列名（server 包装口径：`unmapped`）。 */
  unmapped: string[]
  prose?: boolean
  sectionMissing?: boolean
  /** prose 态小节原文（v11 后端收口批已下发，恒为字符串、非 prose 态为空串）。 */
  proseText?: string
}

/**
 * 一行序列化输入（镜像 agents `WorkflowSerializeRow`）——即 PATCH body 的
 * `workflow.stages[]` 元素（design-v11 §3，逐字段）。
 */
export interface WorkflowStageInput {
  /** 原 raw 行身份；有 → 对齐原行合并未映射列值，无 → 新行按序插入。 */
  rowId?: string
  order: number
  stage: string
  roles: string[]
  mode: WorkflowMode
  input: string
  output: string
  done: string
  reflow: string
  /** 未映射列值（列名 → 值）；**省略时服务端回落到 raw 中该 rowId 的原值**。 */
  extra?: Record<string, string>
}

/** PATCH / POST body 的 workflow 段（design-v11 §3 / R-v11-13；v11 派修 M-2 增 `columns`）。 */
export interface TeamWorkflowInput {
  /**
   * 提交的**列集**（含未映射列，保序）：服务端按它渲染表头，未映射列的值按**列名**从
   * `stages[].extra` 取——故列名与 extra 的键必须由**同一份草稿**产出（`workflowInput` 单点）。
   *
   * 服务端契约（`parseWorkflowColumns`）：**非空**字符串数组、trim 后唯一；非法 400
   * `workflow_invalid`（空数组无法表达列集；列名重复会造成按列名寻址歧义）。
   *
   * 语义（`serializeWorkflowTable` 的列集优先级）：**提交 columns > raw.columns > 八列 + `原文`**。
   * 故它同时是「增列 / 删列」的生效通道：不在 columns 里的核心字段列不入表（值随列弃），
   * 不在其中的自定义列连同其 extra 值一并消失。
   */
  columns: string[]
  stages: WorkflowStageInput[]
}

/**
 * M-8：`TeamDefinition.issues` 是服务端 `readTeamDetail` 组装的**合并流**——字段校验类
 * （`name_required` / `member_role_unknown` / `deposit_*` …）与工作流相关诊断混在一起。
 * 编排器的提示条只讲**工作流**，故只放行工作流相关的那些。
 *
 * 判据取 **code 前缀 `workflow_`**：工作流相关 code 一律以此打头（parse 侧 5 个降级诊断 +
 * 校验侧的 `workflow_role_unknown`）。不取 `level`（parse 诊断与多数字段校验同为 `warning`，
 * 区分不了）、不取 `where`（服务端组装时未填充，只有 level/code/message）。
 */
function isWorkflowIssue(code: string): boolean {
  return code.startsWith('workflow_')
}

/**
 * 把 GET 的字段适配成编排器要的 `WorkflowParseResult`（web 读侧的**唯一适配点**：服务端包装
 * 形状变化只改这里，所有调用点不变）。
 *
 * **有 `workflow_raw` 时**（服务端已落地）：**以本文件的表为唯一真相**——阶段由原始表格
 * 逐行推出（`stagesFromRawTable`），列集 / 未映射列 / 两态 / 顶层 issues 照实传。
 * ⚠ **不拿 `TeamDefinition.workflow`（extends 合并结果）播种**：那是父级胜出的表，混用会让
 * 编辑器显示父级阶段、保存又写进本文件（M-6 混源）。合并结果只在**本文件没有表**时降级成
 * 只读提示（`inheritedStages`）。
 *
 * **没有 `workflow_raw` 时**（旧响应，未含该包装字段）：从 `TeamDefinition.workflow` 合成——
 * - 列集按**核心八列**假设（与 agents serialize 的「无表格起点」同一份列集）；
 * - `unmappedColumns` 空（没有底账 ⇒ 认不出自定义列，**不猜**）；
 * - `prose` / `sectionMissing` 一律 `false`（保守缺省：没有原文与边界信息时**不编造文件状态**，
 *   UI 于是走「空表格 + 可加阶段」的中性态，而不是谎报「自由文本」骗用户点转换）；
 * - `rowIds` 仍按行序合成 `r1..rn`：agents `parse.ts` 就是按行序这么编号的，故这份 rowId 与
 *   原底账天然对齐（未映射列值由服务端按 rowId 从 raw 回落，不会错行）。
 *   这一支没有底账可判继承，故也不给 `inheritedStages`（宁缺不猜）。
 *
 * 两态判据与服务端**同源**（`sectionMissing` 优于 `prose`，见 `workflowStateOf`）。
 */
export function adaptWorkflowParse(def: TeamDefinition): WorkflowParseResult {
  const view = def.workflow_raw
  if (view !== undefined) {
    // 本文件没有表 = 服务端解析出的两态（有表时二者恒为 false，故不必看 raw.rows 是否为空：
    // 表头在、零数据行也是「本文件有表」）
    const noLocalTable = view.prose === true || view.sectionMissing === true
    return {
      stages: stagesFromRawTable(view.columns, view.rows),
      raw: { columns: view.columns, rows: view.rows, rowIds: view.rowIds },
      // server 的包装名是 `unmapped`，解析层的名字是 `unmappedColumns`——这里是改名点
      unmappedColumns: view.unmapped,
      prose: view.prose === true,
      sectionMissing: view.sectionMissing === true,
      // 行级诊断在**顶层** `issues`（server 已把它与校验 issue 合并），不在 workflow_raw 里；
      // M-8：只透传工作流相关的那批（见 `isWorkflowIssue`），字段校验类不冒充工作流提示
      issues: (def.issues ?? [])
        .filter((issue) => isWorkflowIssue(issue.code))
        .map((issue) => ({ code: issue.code, message: issue.message })),
      ...(view.proseText !== undefined ? { proseText: view.proseText } : {}),
      // 本文件无表而合并有阶段 ⇒ 那份阶段来自父级（extends；非 extends 团队此时合并结果必为空，
      // 见 `stagesFromRawTable` 的注）——只作提示，绝不参与播种/写回
      ...(noLocalTable && def.workflow.length > 0 ? { inheritedStages: [...def.workflow] } : {}),
    }
  }
  const columns = [...WORKFLOW_CORE_COLUMNS]
  const cell = (stage: WorkflowStage, field: WorkflowCoreField): string => {
    if (field === 'order') return String(stage.order)
    if (field === 'name') return stage.stage
    if (field === 'roles') return stage.roles.join(' + ')
    if (field === 'mode') return stage.mode
    return stage[field]
  }
  return {
    stages: def.workflow,
    raw: {
      columns,
      rows: def.workflow.map((stage) => WORKFLOW_CORE_FIELDS.map((field) => cell(stage, field))),
      rowIds: def.workflow.map((_, index) => `r${index + 1}`),
    },
    unmappedColumns: [],
    prose: false,
    sectionMissing: false,
    issues: [],
  }
}

export interface DepositPolicy {
  enabled: boolean
  default_layer: string
  default_type: string
  priority: string
  require_note: boolean
}

export interface TeamDefinition {
  team_id: string
  name: string
  description: string
  default: boolean
  members: TeamMember[]
  skills: string[]
  knowledge: KnowledgeBinding
  deposit: DepositPolicy
  arbitration: string[]
  workflow: WorkflowStage[]
  /**
   * 只读：`GET /api/teams/:id` 的 `## 工作流` 小节原始底账 + 两态标记（服务端包装，
   * **不改** agents 的 `TeamDefinition` 冻结类型 / design-v11 §3）。
   *
   * 页面**不直接读它**，一律经 `adaptWorkflowParse()`（改服务端包装形状时只改适配函数内部）。
   * 服务端未下发时（旧响应）该键缺席，适配函数退化为从 `workflow` 合成。
   */
  workflow_raw?: WorkflowRawView
  /**
   * 只读：文件 mtime（epoch 毫秒整数）。PATCH 时回传为 `if_match` 做乐观并发
   * （design-v11 §3 / R-v11-15），不符 → 409 `stale_write`。
   *
   * 未下发时**不带 `if_match`**（不带 ≠ 带 undefined 的字符串）：宁可没有防护，
   * 也不拿一个编造的值去触发假冲突。
   */
  source_mtime?: number
  /**
   * 只读：服务端 `readTeamDetail` 组装的**合并 issue 流**——字段校验 issue + 工作流降级诊断
   * （parse 侧以 `level:'warning'` 并入）。
   *
   * ⚠ 混流不是工作流提示：`adaptWorkflowParse` 按 code 前缀 `workflow_` 过滤后（M-8）才交给
   * 编排器，故提示条只数**工作流相关**的那批。本字段本身不据此改行为。
   */
  issues?: ValidationIssue[]
}

/** 图 status 详情（镜像 server `graph/registry.ts` 的 `GraphStatusDetail`，只读展示用）。 */
export interface GraphStatusDetail {
  project: string
  root: string
  graph_exists: boolean
  built_at: string | null
  changed_files: number
  total_files: number
  stale: boolean
  note?: string
}

export interface TeamActivation {
  team_id: string
  members: Array<{
    role: string
    count: number
    installed: boolean
    dispatch: string
    hint?: string
  }>
  workflow: WorkflowStage[]
  deposit: DepositPolicy
  /**
   * 只读图状态（server 侧附加，`?project=<名>` 给出时才有值，否则 `null`）。
   * 当前 UI 的 activate 调用**不带 project** → 恒为 `null`（不伪造）。
   */
  graph_status?: GraphStatusDetail | null
  /** `?build=1` 时返回的建图任务句柄。 */
  graph_build?: { job_id: string }
}

export interface PrismSkill {
  name: string
  description: string
  builtin: boolean
  /**
   * 分类（v8 F7 / design-v8 §3、R-v8-5）：服务端把 `PRISM_HOME/skill-categories.json`
   * 的映射**合并进 `/api/skills` 的每条技能**——**映射里没有该技能则不加这个键**
   * （与 MCP `prism_skill_list` 同口径），故消费方一律按 `skill.category ?? ''` 读。
   *
   * 它是「这条技能属于哪个分类」的**唯一来源**（R-v8-5：不回头查第二张表）。
   *
   * ⚠ v12 F4（W-6）起技能页分组的**组集与组序**另有来源：`GET /api/skills/categories` 的
   * `categories` 清单（能表达空分类）。两者分工是「谁属于谁」与「有哪些组、什么顺序」——
   * 本字段仍是前者，故按值读、不按清单二次筛选（`groupSkills` 负责把游离值归未分类）。
   */
  category?: string
}

export interface ValidationIssue {
  level: string
  code: string
  message: string
  where?: string
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

/**
 * 统一请求：解析信封，失败抛错（与 `api.ts` 的 `request()` 同一契约的第二处实现）。
 *
 * ⚠ **契约（debts D-1，不得更改）**：错误**必须**以 `` `${code}: ${message}` `` 抛成 `Error.message`
 * ——错误码靠这个前缀承载（消费方按 `startsWith('not_found')` 之类的判断分派）。
 * 改这里就必须同步 `api.ts` 的同名函数。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body = (await res.json()) as Envelope<T>
  if (!body.ok) throw new Error(`${body.error.code}: ${body.error.message}`)
  return body.value
}

/** 技能使用视图（/api/skills/usage）。 */
export interface SkillUsage {
  name: string
  builtin: boolean
  installed: boolean
  roles: string[]
  teams: string[]
  /**
   * 分类（v8 F7-1）：服务端已按与 `/api/skills` **完全一致**的口径逐条合并
   * `PRISM_HOME/skill-categories.json` 的映射——**映射里没有该技能则不加这个键**
   * （与 `PrismSkill.category` 同源同口径），故消费方一律按 `item.category ?? ''` 读。
   *
   * 它是**外部技能**唯一的分类来源：`/api/skills` 只列内置技能，宿主已装的外部技能
   * 只出现在 usage 路，分组时要靠这里补上（见 `Skills.tsx` 的 `row.category ??=`）。
   */
  category?: string
  /**
   * 外部可删态（v10 F3，design-v10 F3「UI 数据支撑」）：`true` = 该技能落点是宿主技能目录里
   * 一个**有 SKILL.md、且不带 Prism 标记**的目录 ⇒ 可以整目录搬进回收站（「删除」）。
   *
   * 判定在服务端（按**落点文件**判，不按名字查内置清单——否则「复制内置后改写的人写同名技能」
   * 在 UI 恒显「卸载」而卸载恒 `kept`）。服务端**不加该键**时按 `undefined` 读 ⇒ 与 `false`
   * 同档：保持现状（内置 / Prism 产物显「卸载」）。
   */
  external_removable?: boolean
}

/**
 * 外部技能删除结果（`DELETE /api/skills/external/:name`，design-v10 F3 契约冻结）。
 *
 * 与 v9 删除族同形：**200 + 返回体**（不是 204——信封层没有无 body 通道，且 `trash_id`
 * 是 UI「可恢复」提示的唯一来源）。
 */
export interface SkillExternalRemoveResult {
  /** 宿主技能目录（服务端配置解析后的同源值） */
  skills_dir: string
  /** 被搬走的目录（整目录，含 references/ 等子项） */
  removed: string[]
  /** 回收站单元 id，可 `prism trash restore <id>` 还原 */
  trash_id: string
}

/** 技能 → 分类的映射（值 = 分类名；缺键 = 未分类）。 */
export type SkillCategoryMap = Record<string, string>

/**
 * 技能分类台账（v12 F4 / B-1 迁移后的**冻结形状**）。
 *
 * `categories` 是**分类清单**（含当前 0 条技能的空分类），`mapping` 是技能→分类映射。
 * 二者**不是冗余**：`mapping` 的值域理论上可能出现不在 `categories` 里的「游离分类」
 * （SPEC-4.3：读时按未分类呈现），故消费方一律以 `categories` 为准。
 *
 * GET / POST / PATCH / DELETE 四条口**成功时都返回这个形状**（同形 ⇒ 前端可整表替换，
 * 省一次 GET）。
 */
export interface SkillCategoryData {
  categories: string[]
  mapping: SkillCategoryMap
}

/**
 * 归类写入结果（`POST /api/skills/categorize`，v12 F4 迁移后的冻结形状）。
 *
 * 逐字段照服务端 `SkillCategorizeResult`（`packages/server/src/roles/skill-categories.ts`）：
 * `category` 为 `null` = 本次是**清除**；`updated` / `cleared` 是写入后**带 / 不带**该分类的
 * 技能名；`categories` 是写入后的分类清单、`mapping` 是全量映射（回显用）。
 *
 * 控制台只消费「成功与否」（真结果一律靠随后的 `GET` 刷新，不做本地臆测级联）——类型写全
 * 是为**契约冻结留痕**：形状不对时类型层先红。
 */
export interface SkillCategorizeResult {
  category: string | null
  updated: string[]
  cleared: string[]
  categories: string[]
  mapping: SkillCategoryMap
}

/**
 * 单个技能详情（GET /api/skills/:name）：正文 + 安装路径 + 引用方。
 */
export interface SkillDetail {
  name: string
  description: string
  builtin: boolean
  installed: boolean
  /** 预期（或实际）安装目录：`<skills_dir>/<name>` */
  path: string
  roles: string[]
  teams: string[]
  /** SKILL.md 全文（含 frontmatter）；读不到为空串 */
  content: string
}

/**
 * 内置 Skill 清单响应（`GET /api/skills`，v7 改型）。
 *
 * 由裸数组改为 `{ skills, skills_dir }`：与 MCP `prism_skill_list` 对齐，
 * `skills_dir` 供安装/卸载表单回填（服务端 body 的 `skills_dir` **必填**）。
 */
export interface SkillListResult {
  skills: PrismSkill[]
  /** 宿主技能目录（服务端已解析；安装/卸载的原样入参） */
  skills_dir: string
}

/** 安装结果（`POST /api/skills/install`）——与 server 的 `SkillInstallOutcome` 同形。 */
export interface SkillInstallOutcome {
  skills_dir: string
  written: string[]
  skipped: Array<{ path: string; reason: string }>
}

/** 卸载结果（`POST /api/skills/uninstall`）——与 server 的 `SkillUninstallOutcome` 同形。 */
export interface SkillUninstallOutcome {
  skills_dir: string
  removed: string[]
  /** 未删的（人写的 Skill / 无 SKILL.md）：卸载只动 Prism 产物 */
  kept: Array<{ name: string; path: string; reason: string }>
}

/** 团队列表 + 受管 teams 目录（design-v4 §3.4：GET /api/teams 增只读 teamsDir）。 */
export interface TeamsIndex {
  teams: TeamDefinition[]
  /** 受管 teams 目录绝对路径（只读）。仅用于新建表单预填，**不硬编码宿主路径**（R6）。 */
  teamsDir?: string
}

/**
 * GET /api/teams 形状兼容：历史为裸数组 → `{ teams, teamsDir }`（v5）→ `{ teams, teams_dir }`（v6.1，
 * 键名与写参数 `teams_dir` 同名，读回即可回填）。三种形状都接受，避免与后端落地形状耦合。
 */
function normalizeTeams(
  value: TeamDefinition[] | { teams: TeamDefinition[]; teams_dir?: string; teamsDir?: string },
): TeamsIndex {
  if (Array.isArray(value)) return { teams: value }
  const dir = value.teams_dir ?? value.teamsDir
  return {
    teams: value.teams ?? [],
    ...(dir !== undefined ? { teamsDir: dir } : {}),
  }
}

/** 新建团队入参（ui-spec-v4 §2.5）。`teams_dir` 必须由调用方显式提供（无 env 回落）。 */
export interface NewTeamInput {
  team_id: string
  name: string
  description?: string
  members: TeamMember[]
  skills?: string[]
  deposit?: Partial<DepositPolicy>
  /** 工作流模板（后端缺省 = minimal）。 */
  workflow_template?: 'minimal' | 'core-dev'
  /**
   * 编排后的工作流（POST 侧服务端已落地：`createTeamDefinition` 经 `parseWorkflowPatch` →
   * agents `patchTeamRaw` 写回模板产物的 `## 工作流` 表格）。
   *
   * 语义（v11 收口）：模板恒有工作流表格，而新建提交的 stages **无 `rowId`** ⇒ 模板行**全换**
   * 为提交行；**省略该键** = 模板工作流原样（产物 byte 级不变）。新建表单的编排器是
   * 「模板预填 + 可增删改」，不同步提交就会把用户在新建时的编排改动静默丢弃——故必须发。
   */
  workflow?: TeamWorkflowInput
  teams_dir: string
}

export interface NewTeamResult {
  ok: boolean
  path: string
  issues: ValidationIssue[]
}

/* ==================== 角色增删改（v5 三入口对齐） ==================== */

const ROLE_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const

export type RoleColor = (typeof ROLE_COLORS)[number]

/** 合法角色色（与服务端 `packages/agents/src/role/validate.ts` 的 `ROLE_COLORS` 同口径）。 */
export const ROLE_COLOR_OPTIONS: readonly RoleColor[] = ROLE_COLORS

/** `GET /api/roles` 返回体（v6.1：`{ roles, roles_dir }`，键名与写参数同名，与 `/api/teams` 同形）。 */
export interface RolesIndex {
  roles: RoleDefinition[]
  /** 受管 roles 目录绝对路径（只读）。仅用于新建表单预填，**不硬编码宿主路径**（R6）。 */
  rolesDir?: string
}

/** 裸数组（历史形状）、`{roles, rolesDir}`（v5）与 `{roles, roles_dir}`（v6.1）都接受。 */
function normalizeRoles(
  value: RoleDefinition[] | { roles: RoleDefinition[]; roles_dir?: string; rolesDir?: string },
): RolesIndex {
  if (Array.isArray(value)) return { roles: value }
  const dir = value.roles_dir ?? value.rolesDir
  return {
    roles: value.roles ?? [],
    ...(dir !== undefined ? { rolesDir: dir } : {}),
  }
}

/** 新建/修改角色入参。`roles_dir` 必须由调用方显式提供（无 env 回落，R5/R6）。 */
export interface RoleWriteInput {
  name?: string
  description?: string
  /** 能力白名单；`[]` = 清空（仅 PATCH 有意义） */
  skills?: string[]
  knowledge?: KnowledgeBinding
  /** 正文（Markdown）。`new` 时省略 → 用内置骨架；`update` 时给出即整体替换正文。 */
  body?: string
  /** `''` / `null` = 清除该 frontmatter 键（仅 PATCH 有意义） */
  color?: RoleColor | '' | null
  model?: string | null
  thought_level?: ThoughtLevel | '' | null
  /** **必填**：写入目录 */
  roles_dir: string
  /** 仅 `create` 认：目标已存在时是否覆盖。 */
  force?: boolean
}

/** 思考档位（与 `packages/agents/src/types.ts` 的 `RoleDefinition.thoughtLevel` 同口径）。 */
export type ThoughtLevel = 'low' | 'high' | 'max'

export const THOUGHT_LEVELS: readonly ThoughtLevel[] = ['low', 'high', 'max']

/** 角色写盘结果（`POST/PATCH /api/roles`）。 */
export interface RoleWriteResult {
  path: string
  /** 是否发生了覆盖（`force: true`）。 */
  overwritten: boolean
}

/** `DELETE /api/roles/:name` 结果。 */
export interface RoleRemoveResult {
  removed: string[]
}

/** 修改团队入参（`PATCH /api/teams/:id`）。改 `members` 时须同时给 `roles_dir`。 */
export interface UpdateTeamInput {
  name?: string
  description?: string
  members?: TeamMember[]
  deposit?: Partial<DepositPolicy>
  /**
   * 编排后的工作流（design-v11 §3 PATCH 契约；服务端已落地）。
   *
   * 服务端口径：
   * - **raw 底账由服务端重读文件获得**，不采信客户端回传的整份 raw（缩信任面）；
   * - `members` 与 `workflow` 同给 → **workflow 胜**，跳过收窄并记 issue `workflow_narrow_skipped`；
   * - `team_patch_empty` 守卫把 workflow 计为有效字段（否则 workflow-only 补丁会 400）；
   * - 提交 `columns` = 列集生效通道（增 / 删列，见 `TeamWorkflowInput.columns`）。
   */
  workflow?: TeamWorkflowInput
  /**
   * 乐观并发（design-v11 §3 / R-v11-15）：取 GET 的 `source_mtime`，与文件当前 mtime 不符
   * → 409 `stale_write`；服务端 `parseIfMatch` 只认**整数**（非整数 400 `if_match_invalid`）。
   *
   * 放在 **body** 而非 `If-Match` 头：本模块的 `request()` 是 JSON body 单一通道，且
   * design 把它列在「PATCH 契约逐字段」清单里。页面侧只传值、不碰传输层（`updateTeam`）。
   */
  if_match?: number
  /** **必填**：目标 teams 目录 */
  teams_dir: string
  /** 改 `members` 时必填（校验角色存在） */
  roles_dir?: string
}

/** `DELETE /api/teams/:id` 结果。 */
export interface RemoveResult {
  removed: string[]
}

/**
 * `PATCH /api/teams/:id` 结果（服务端 `team-create.ts` 的 `PatchTeamResult`）。
 *
 * `source_mtime` 是**写后**的文件 mtime：保存成功后必须用它顶掉表单里那个旧值，
 * 否则下一次保存带着旧 mtime 必然 409 `stale_write`（文件刚被自己改过）。
 * 标可选以兼容未升级的服务端（旧响应没有这个键）。
 */
export interface TeamPatchResult {
  path: string
  issues: ValidationIssue[]
  source_mtime?: number
}

/** Skill 有效集（F-D2，角色 × 团队 → 能用的 skill）。 */
export interface EffectiveSkill {
  name: string
  /** 声明来源，去重；顺序固定 global → team → role。 */
  sources: Array<'global' | 'team' | 'role'>
  /** 宿主是否已安装 */
  available: boolean
}

export interface EffectiveSkillSet {
  role: string
  team?: string
  skills: EffectiveSkill[]
  warnings: ValidationIssue[]
}

export const teamApi = {
  roles: () =>
    request<RoleDefinition[] | { roles: RoleDefinition[]; roles_dir?: string; rolesDir?: string }>('/api/roles').then(normalizeRoles),
  role: (name: string) => request<RoleDefinition>(`/api/roles/${encodeURIComponent(name)}`),
  teams: () =>
    request<TeamDefinition[] | { teams: TeamDefinition[]; teams_dir?: string; teamsDir?: string }>('/api/teams').then(
      normalizeTeams,
    ),
  team: (id: string) => request<TeamDefinition>(`/api/teams/${encodeURIComponent(id)}`),
  activate: (id: string) => request<TeamActivation>(`/api/teams/${encodeURIComponent(id)}/activate`),
  /** 内置 Skill 清单（v7 改型：`{ skills, skills_dir }`，与 MCP `prism_skill_list` 对齐）。 */
  skills: () => request<SkillListResult>('/api/skills'),
  skill: (name: string) => request<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`),
  skillUsage: () => request<SkillUsage[]>('/api/skills/usage'),

  /**
   * 技能分类台账（`GET /api/skills/categories`，v12 F4 / B-1 迁移后的新形状）。
   *
   * 它是技能页分组的**分类清单来源**（组集与组序），与逐条技能上的 `category` 字段分工不同：
   * 前者能表达**空分类**（0 条技能的组），后者只能表达「这条技能属于谁」。
   */
  skillCategories: () => request<SkillCategoryData>('/api/skills/categories'),

  /**
   * 新建分类（`POST /api/skills/categories`，body `{name}`）。
   *
   * 失败面（冻结契约）：`bad_request`(400) = 名字 trim 后为空；`id_conflict`(409) = 重名。
   * UI 逐条映射人话见 `skills-logic.ts#categoryErrorKey`。
   */
  skillCategoryAdd: (input: { name: string }) =>
    request<SkillCategoryData>('/api/skills/categories', { method: 'POST', body: JSON.stringify(input) }),

  /**
   * 分类改名（`PATCH /api/skills/categories/:name`）。
   *
   * ⚠ 路径段是**旧名**、body 的 `name` 是**新名**（冻结契约的逐字段口径，别写反）。
   * 服务端**级联**更新 `mapping`（组内技能的展示分类随之变）；同名是幂等 no-op。
   * 失败面：`bad_request`(400) 空新名 / `id_conflict`(409) 目标名重名 / `not_found`(404) 源不存在。
   */
  skillCategoryRename: (input: { from: string; to: string }) =>
    request<SkillCategoryData>(`/api/skills/categories/${encodeURIComponent(input.from)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: input.to }),
    }),

  /**
   * 删除分类（`DELETE /api/skills/categories/:name`）。
   *
   * 服务端把组内技能的 `mapping` 一并清除（回未分类），**技能本身不动**——确认弹窗的文案
   * 要把这件事说清楚（`skills.category.removeBody`）。失败面：`not_found`(404) 源不存在。
   */
  skillCategoryRemove: (name: string) =>
    request<SkillCategoryData>(`/api/skills/categories/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  /**
   * 归类：技能 → 分类（`POST /api/skills/categorize`，v12 F4 / W-7 的 DnD 与键盘下拉共用）。
   *
   * 入参 `{ names: string[]; category?: string }`；**`category` 省略 = 清除分类**——
   * 服务端 `parseCategorizeInput` 把「省略 / `null` / 空串（含纯空白）」归同一档（`people.ts` 的
   * `skillCategorize` 注释同此）。故「拖到未分类组」应传**不带 `category` 键**的载荷，
   * 而不是 `category: ''`（两档等价，但省略是契约里写明的表达，见 `skills-logic#categorizePayload`）。
   *
   * 失败面：`bad_request`(400) = `names` 空 / `category` 非字符串。
   * 响应 = `SkillCategorizeResult`（写入后的清单与映射，整表可替换）。
   */
  skillCategorize: (input: { names: string[]; category?: string }) =>
    request<SkillCategorizeResult>('/api/skills/categorize', { method: 'POST', body: JSON.stringify(input) }),

  /** 新建团队（F-C2 → POST /api/teams，F-C3 落地）。 */
  create: (input: NewTeamInput) =>
    request<NewTeamResult>('/api/teams', { method: 'POST', body: JSON.stringify(input) }),

  /**
   * 修改团队（v5 → PATCH /api/teams/:id）。改 members 时服务端会就地收窄工作流；
   * 带 `workflow` 时**所见即所存**（同给 members 也以 workflow 为准）。
   */
  updateTeam: (id: string, input: UpdateTeamInput) =>
    request<TeamPatchResult>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /** 删除团队（v5 → DELETE /api/teams/:id）。**硬删**，`teams_dir` 必填。 */
  deleteTeam: (id: string, teamsDir: string) =>
    request<RemoveResult>(`/api/teams/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: JSON.stringify({ teams_dir: teamsDir }),
    }),

  /** 新建角色（v5 → POST /api/roles），按宿主原生形态落盘。 */
  createRole: (input: RoleWriteInput) =>
    request<RoleWriteResult>('/api/roles', { method: 'POST', body: JSON.stringify(input) }),

  /** 修改角色（v5 → PATCH /api/roles/:name），外科式字段补丁，正文不重排。 */
  updateRole: (name: string, input: RoleWriteInput) =>
    request<RoleWriteResult>(`/api/roles/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /** 删除角色（v5 → DELETE /api/roles/:name）。**硬删**，`roles_dir` 必填。 */
  deleteRole: (name: string, rolesDir: string) =>
    request<RoleRemoveResult>(`/api/roles/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: JSON.stringify({ roles_dir: rolesDir }),
    }),

  /** Skill 有效集（F-D2 → GET /api/skills/effective）。角色不存在时服务端 404 信封。 */
  effectiveSkills: (role: string, team?: string) => {
    const qs = new URLSearchParams({ role })
    if (team !== undefined && team !== '') qs.set('team', team)
    return request<EffectiveSkillSet>(`/api/skills/effective?${qs.toString()}`)
  },

  /**
   * 安装内置 Skill（`POST /api/skills/install`，§4.3 S5）。
   *
   * - `skills_dir` **必填**且原样传给服务端——服务端绝不复用默认宿主目录（写路径不回落），
   *   所以 UI 必须把 `skills()` 返回的 `skills_dir` 带回来；
   * - `names` 省略/空 = 全部内置；
   * - `force` 缺省**不覆盖**人写的同名 Skill（服务端写 `.prism-new` 供对比）。
   */
  skillInstall: (input: { skills_dir: string; names?: string[]; force?: boolean }) =>
    request<SkillInstallOutcome>('/api/skills/install', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** 卸载 Skill（`POST /api/skills/uninstall`）。只删 Prism 产物，人写的记入 `kept`。 */
  skillUninstall: (input: { skills_dir: string; names?: string[] }) =>
    request<SkillUninstallOutcome>('/api/skills/uninstall', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /**
   * 删除**外部**技能（`DELETE /api/skills/external/:name`，v10 F3）。
   *
   * 与 `skillUninstall` 的分工：卸载只清 Prism 产物（外部技能恒 `kept`），本口才真把整个
   * 技能目录搬进回收站。服务端的失败面（UI 逐条映射人话，见 `skills-logic.ts`）：
   * - `id_conflict`（409）：落点 SKILL.md 带 Prism 标记 → 该走卸载；
   * - `not_found`（404）：目录不存在 / 没有 SKILL.md（非技能目录）；
   * - `bad_request`：`:name` 消毒没过（空串 / `.` / `..` / 含分隔符 / 根自身）。
   *
   * `:name` 走 `encodeURIComponent`（服务端在解码**之后**做消毒，两侧不重复表达同一条规则）。
   */
  skillDeleteExternal: (name: string) =>
    request<SkillExternalRemoveResult>(`/api/skills/external/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
}
