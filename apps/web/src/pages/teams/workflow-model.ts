/**
 * 团队**工作流编排器**的纯模型（v11 F2 / design-v11 §1–§3）。
 *
 * 职责边界（为什么另起一个文件）：
 * - 编排器的全部状态变换是**值到值**的（草稿 → 草稿 / 草稿 → 请求体），与 React 无关；
 *   把它们混进 `TeamForm` 会让「上下移之后未映射列跟没跟着走」这类断言只能靠渲染间接验。
 * - `form-logic.ts` 管的是**提交语义**（校验 / PATCH 差集）；本文件管的是**表结构语义**
 *   （列集 / 列映射 / 行身份）。两者都被 `TeamForm` 消费，互不调用。
 *
 * 三条硬口径（都来自 design-v11，改动前先读原文）：
 * 1. **列集是文件的，不是 UI 的**：列名认核心字段靠 `WORKFLOW_HEADER_SYNONYMS` 逐字全等；
 *    认不出的列是「未映射列」，编辑后**原样写回**（R-v11-1 的数据丢失红线在服务端 serialize，
 *    但前端的列集/行身份必须如实表达，否则服务端没得保）。
 * 2. **行身份（`rowId`）是未映射列值的锚**（R-v11-3）：上移 / 下移 / 删除 / 新增都不重编
 *    rowId，故「第 3 行的自定义列值」永远跟着它那一行走，不整体错行；新建行**无** rowId。
 * 3. **自由文本的转换是本地模型变换**（R-v11-9）：只产出「核心八列 + `原文`」这一种起点形态，
 *    **不生成 markdown 表格**——序列化是服务端单点（apps/web 无 `@prism/*` 依赖）。
 */

import {
  mapWorkflowColumns,
  WORKFLOW_CORE_COLUMNS,
  WORKFLOW_HEADER_SYNONYMS,
  WORKFLOW_PROSE_COLUMN,
  type TeamWorkflowInput,
  type WorkflowCoreField,
  type WorkflowMode,
  type WorkflowParseIssue,
  type WorkflowParseResult,
  type WorkflowStage,
} from '../../api-team.ts'

/** 编排器的三个态：有表可编排 / 自由文本 / 文件里连小节都没有。 */
export type WorkflowState = 'table' | 'prose' | 'missing'

/** 一张阶段卡（= 表格的一行）。`extra` 只装**未映射列**的值。 */
export interface StageCard {
  /** 行身份（来自 `RawWorkflowTable.rowIds`）；**新建行没有**。 */
  rowId?: string
  stage: string
  roles: string[]
  mode: WorkflowMode
  input: string
  output: string
  done: string
  reflow: string
  /** 未映射列值：列名 → 值。 */
  extra: Record<string, string>
}

/** 编辑草稿：列集 + 卡片 + 态。表单持有的就是它（`TeamFormValues.workflow`）。 */
export interface WorkflowDraft {
  state: WorkflowState
  /** 实际列集（含未映射列，保序）。 */
  columns: string[]
  cards: StageCard[]
  /** 自由文本态的**小节原文**；转换后仍留着，故「恢复为自由文本」无损。 */
  proseText: string
  /** 本草稿是由自由文本转换来的 → 表格态下给「恢复为自由文本」出口（未保存可取消）。 */
  fromProse: boolean
  /** 服务端行级诊断（只读展示）。 */
  issues: WorkflowParseIssue[]
  /**
   * M-6：本文件**没有**工作流表格而「生效的」阶段**继承自父级**（extends 合并）时带上的那份
   * （`WorkflowParseResult.inheritedStages` 原样搬运；只有 prose / missing 两态可能非空）。
   *
   * 它是**只读上下文**：不进 `cards`、不进 `workflowInput`。唯一的两个去处是编辑器里的提示条，
   * 以及 prose 态「结构化为表格」的**起点**（用户看得见那条提示，故不是暗改——见 `toTableDraft`）。
   */
  inherited: WorkflowStage[]
}

/** 服务端的 mode 归一（镜像 `parse.ts`：非「并行」即串行）。 */
export function toMode(mode: string): WorkflowMode {
  return mode === 'parallel' ? 'parallel' : 'serial'
}

/**
 * 列 → 核心字段（`null` = 未映射列）。**定义在 `api-team.ts`**（`mapWorkflowColumns`）——因为
 * `adaptWorkflowParse` 读本文件表格推阶段时也要用它，而本文件反向依赖那边；这里只作**转名出口**
 * （既有消费方与测试都按 `mapColumns` 调）。语义（贪心、表序靠前者胜）见那边的注释。
 */
export const mapColumns = mapWorkflowColumns

/** 未映射列名（保序）。 */
export function unmappedColumns(columns: readonly string[]): string[] {
  const mapping = mapColumns(columns)
  return columns.filter((_, index) => mapping[index] === null)
}

/** 某核心字段**当前映射到的列名**；没这一列 → `undefined`（UI 据此显示「+ 添加此列」）。 */
export function columnFor(columns: readonly string[], field: WorkflowCoreField): string | undefined {
  const index = mapColumns(columns).indexOf(field)
  return index === -1 ? undefined : columns[index]
}

/** 字段展示名用的列名（「+ 添加此列」加的就是它）：核心字段的首个同义词。 */
export function primaryColumnName(field: WorkflowCoreField): string {
  return WORKFLOW_HEADER_SYNONYMS[field][0]!
}

/** 解析结果落在哪个态（详情页与编排器共用同一判据，免得两处各判一次）。 */
export function workflowStateOf(parse: Pick<WorkflowParseResult, 'prose' | 'sectionMissing'>): WorkflowState {
  if (parse.sectionMissing === true) return 'missing'
  if (parse.prose === true) return 'prose'
  return 'table'
}

/** 解析结果 → 可编辑草稿。 */
export function draftFromParse(parse: WorkflowParseResult): WorkflowDraft {
  const state = workflowStateOf(parse)
  const columns = parse.raw !== undefined ? [...parse.raw.columns] : [...WORKFLOW_CORE_COLUMNS]
  const mapping = mapColumns(columns)
  const rows = parse.raw?.rows ?? []
  const cards = parse.stages.map((stage, index) => {
    const row = rows[index]
    const extra: Record<string, string> = {}
    columns.forEach((column, columnIndex) => {
      if (mapping[columnIndex] === null) extra[column] = row?.[columnIndex] ?? ''
    })
    const rowId = parse.raw?.rowIds[index]
    return {
      ...(rowId !== undefined ? { rowId } : {}),
      stage: stage.stage,
      roles: [...stage.roles],
      mode: toMode(stage.mode),
      input: stage.input,
      output: stage.output,
      done: stage.done,
      reflow: stage.reflow,
      extra,
    }
  })
  return {
    state,
    columns,
    cards,
    proseText: parse.proseText ?? '',
    fromProse: false,
    issues: [...parse.issues],
    inherited: [...(parse.inheritedStages ?? [])],
  }
}

/** 只有 stages（新建模板预填）时的草稿：列集按核心八列假设。 */
export function draftFromStages(stages: readonly WorkflowStage[]): WorkflowDraft {
  return draftFromParse({ stages: [...stages], unmappedColumns: [], issues: [] })
}

/** 一张**新建**空卡（无 rowId —— 服务端据此按序插入）。 */
export function emptyCard(): StageCard {
  return { stage: '', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '', extra: {} }
}

/** 追加一张新卡（末尾）。 */
export function addCard(draft: WorkflowDraft): WorkflowDraft {
  return { ...draft, cards: [...draft.cards, emptyCard()] }
}

/** 删除第 `index` 张卡（该行的未映射列值一并消失 —— UI 上用户看得见）。 */
export function removeCard(draft: WorkflowDraft, index: number): WorkflowDraft {
  if (index < 0 || index >= draft.cards.length) return draft
  return { ...draft, cards: draft.cards.filter((_, i) => i !== index) }
}

/** 上移 / 下移（`delta` 取 −1 / +1）。越界或无效 → 原样返回（幂等）。 */
export function moveCard(draft: WorkflowDraft, index: number, delta: number): WorkflowDraft {
  const target = index + delta
  if (index < 0 || index >= draft.cards.length || target < 0 || target >= draft.cards.length) return draft
  const cards = [...draft.cards]
  const [moved] = cards.splice(index, 1)
  cards.splice(target, 0, moved!)
  return { ...draft, cards }
}

/** 卡片上可自由输入文本的核心字段（`order` 是位置、`roles` 是多选、`mode` 是两档开关）。 */
export type EditableField = 'stage' | 'input' | 'output' | 'done' | 'reflow'

/** 改一张卡的一个文本字段。 */
export function setCardField(
  draft: WorkflowDraft,
  index: number,
  field: EditableField,
  value: string,
): WorkflowDraft {
  if (index < 0 || index >= draft.cards.length) return draft
  return { ...draft, cards: draft.cards.map((card, i) => (i === index ? { ...card, [field]: value } : card)) }
}

/** 改一张卡的串·并行（服务端只认 serial / parallel 两档）。 */
export function setCardMode(draft: WorkflowDraft, index: number, mode: WorkflowMode): WorkflowDraft {
  if (index < 0 || index >= draft.cards.length) return draft
  return { ...draft, cards: draft.cards.map((card, i) => (i === index ? { ...card, mode } : card)) }
}

/** 改某张卡某个未映射列的值。 */
export function setExtra(draft: WorkflowDraft, index: number, column: string, value: string): WorkflowDraft {
  if (index < 0 || index >= draft.cards.length) return draft
  return {
    ...draft,
    cards: draft.cards.map((card, i) => (i === index ? { ...card, extra: { ...card.extra, [column]: value } } : card)),
  }
}

/** 勾 / 取消勾一个负责角色（幂等：重复勾不产生重复项）。 */
export function toggleRole(draft: WorkflowDraft, index: number, name: string): WorkflowDraft {
  if (index < 0 || index >= draft.cards.length) return draft
  return {
    ...draft,
    cards: draft.cards.map((card, i) => {
      if (i !== index) return card
      const roles = card.roles.includes(name)
        ? card.roles.filter((r) => r !== name)
        : [...card.roles, name]
      return { ...card, roles }
    }),
  }
}

/** 「+ 添加此列」：该核心字段缺列时把它的主列名加进列集（已有 → 幂等）。 */
export function addFieldColumn(draft: WorkflowDraft, field: WorkflowCoreField): WorkflowDraft {
  if (columnFor(draft.columns, field) !== undefined) return draft
  return { ...draft, columns: [...draft.columns, primaryColumnName(field)] }
}

/** 「增自定义列」：列集加一列，并给每张卡补一个空格（空白名 / 重名 → 幂等）。 */
export function addCustomColumn(draft: WorkflowDraft, name: string): WorkflowDraft {
  const column = name.trim()
  if (column === '' || draft.columns.includes(column)) return draft
  return {
    ...draft,
    columns: [...draft.columns, column],
    cards: draft.cards.map((card) => ({ ...card, extra: { ...card.extra, [column]: '' } })),
  }
}

/**
 * 删列（**只许删未映射列**，见 `unmappedColumns`）。
 *
 * 为什么不让删核心字段的列：删掉「输出」列不等于「清空输出」——它会让该字段在表格里
 * 彻底没有容身处，值随列一起消失且无处可写。要清值请清输入框；删列只服务自定义列
 * （design-v11 §3 / R-v11-12：`原文` 列删掉即等于放弃原文）。
 */
export function removeColumn(draft: WorkflowDraft, column: string): WorkflowDraft {
  if (!unmappedColumns(draft.columns).includes(column)) return draft
  return {
    ...draft,
    columns: draft.columns.filter((c) => c !== column),
    cards: draft.cards.map((card) => ({ ...card, extra: omit(card.extra, column) })),
  }
}

/**
 * 自由文本 → 表格（**本地模型变换**，design-v11 §3 / R-v11-9）：
 * 列集 = 核心八列 + `原文`，原全文进 `原文` 列 —— 「拿到一个可编排的起点」是本按钮的全部承诺，
 * **不硬解析自然语言**（任务书 F2）。
 *
 * M-6 的**继承起点**：本文件没有工作流表格、而生效的工作流继承自父级时（`draft.inherited` 非空），
 * 起点改用**继承来的那几张阶段卡**（编辑器已用提示条明说「来源是父级、保存落本文件」，故不是暗改，
 * 正是「允许以继承内容作为转换起点」）。原文仍进 `原文` 列（R-v11-12 的唯一载体）——此时落在
 * **第一行的「原文」格里**（列不够摊，行没有「原文」这一行的说法），故原文一个字节都不丢；
 * 另有 `proseText` 兜着，未保存前「恢复为自由文本」无损。
 */
export function toTableDraft(draft: WorkflowDraft): WorkflowDraft {
  const columns = [...WORKFLOW_CORE_COLUMNS, WORKFLOW_PROSE_COLUMN]
  const cards: StageCard[] =
    draft.inherited.length === 0
      ? [emptyCard()]
      : draft.inherited.map((stage) => ({
          // 继承来的阶段在**本文件**里没有行身份（它们不是本文件的行）→ 一律按新行提交
          stage: stage.stage,
          roles: [...stage.roles],
          mode: toMode(stage.mode),
          input: stage.input,
          output: stage.output,
          done: stage.done,
          reflow: stage.reflow,
          extra: {},
        }))
  const first = cards[0]
  // 恒设该键（值为空串也设）：与「无原文」区分得开——「这一格是空的」是**用户看得到的事实**，
  // 而不是「我们没给它位置」。（提交侧 `workflowInput` 对缺失键同样按空串走，两处等价。）
  if (first !== undefined) first.extra[WORKFLOW_PROSE_COLUMN] = draft.proseText
  return {
    state: 'table',
    columns,
    cards,
    proseText: draft.proseText,
    fromProse: true,
    issues: draft.issues,
    inherited: draft.inherited,
  }
}

/** 取消转换：回到自由文本态（原文一直在 `proseText` 里，**从未落盘**）。 */
export function toProseDraft(draft: WorkflowDraft): WorkflowDraft {
  if (!draft.fromProse && draft.proseText === '') return draft
  return { ...draft, state: 'prose', cards: [], fromProse: false }
}

/**
 * 草稿 → 提交给服务端的 **workflow 段**（`TeamWorkflowInput` = 列集 + 阶段数组）。
 *
 * **列集与 extra 必须由同一份草稿产出**（M-2 的关键不变量）：服务端 `serializeWorkflowTable`
 * 按**列名**取 `extra`，故 `columns` 里的未映射列名与每张卡 `extra` 的键要字字相同
 * （这里的 `extras` 与 `pick` 用的是同一个 `draft.columns` 过滤结果）。两者分头算就会
 * 「列在上报里、值在服务端找不到」= 静默丢值。
 *
 * 语义：`columns` = 草稿的**实际列集**（含增 / 删列的结果、保序）；`order` 按卡片位置重编为
 * 1..n；`rowId` 有才带；未映射列只在真有列时才带 `extra`。
 */
export function workflowInput(draft: WorkflowDraft): TeamWorkflowInput {
  const mapping = mapColumns(draft.columns)
  const extras = draft.columns.filter((_, index) => mapping[index] === null)
  return {
    columns: [...draft.columns],
    stages: draft.cards.map((card, index) => ({
      ...(card.rowId !== undefined ? { rowId: card.rowId } : {}),
      order: index + 1,
      stage: card.stage,
      roles: [...card.roles],
      mode: card.mode,
      input: card.input,
      output: card.output,
      done: card.done,
      reflow: card.reflow,
      ...(extras.length > 0 ? { extra: pick(card.extra, extras) } : {}),
    })),
  }
}

/**
 * **只读**渲染适配（design-v11 §3：`WorkflowFlow` 不动渲染代码，改喂给它的数据）。
 *
 * 兜的是「缺字段也要成链」：order 非法 / 缺失 → 按位置补；mode 空 → `serial`
 * （服务端口径就是「非并行即串行」）；roles / reflow / 三个文本字段缺失 → 空。
 * 缺 roles ⇒ 明细里画不出徽章、缺 reflow ⇒ `WorkflowFlow` 的 `showReflow` 本就为假 ⇒
 * 连「序号 + 名称」也照样成链。
 */
export function toFlowStages(stages: readonly WorkflowStage[]): WorkflowStage[] {
  return stages.map((stage, index) => ({
    order: Number.isFinite(stage.order) ? stage.order : index + 1,
    stage: stage.stage ?? '',
    roles: [...(stage.roles ?? [])],
    mode: stage.mode === '' || stage.mode === undefined ? 'serial' : stage.mode,
    input: stage.input ?? '',
    output: stage.output ?? '',
    done: stage.done ?? '',
    reflow: stage.reflow ?? '',
  }))
}

/** 草稿 → 预览的 stages（order = 卡片位置：**所见即所存**）。 */
export function flowStages(draft: WorkflowDraft): WorkflowStage[] {
  return toFlowStages(draft.cards.map((card, index) => ({ ...card, order: index + 1 })))
}

/** 草稿是否等价（用于 PATCH 差集：不动工作流就不发 workflow 段）。 */
export function workflowEqual(a: WorkflowDraft, b: WorkflowDraft): boolean {
  if (a.state !== b.state || a.proseText !== b.proseText) return false
  /**
   * prose 态没有表格内容：`columns` 只是「转换过又回退」留下的残值，不代表改动。
   * 不比它，否则「转换 → 恢复为自由文本 → 保存」会被判成改过工作流，提交 `{ columns, stages: [] }`
   * 把自由文本小节替成空表（`workflow_prose_replaced` 级的数据丢失）。
   */
  if (a.state === 'prose') return true
  if (!sameList(a.columns, b.columns)) return false
  if (a.cards.length !== b.cards.length) return false
  return a.cards.every((card, index) => cardEqual(card, b.cards[index]!))
}

function cardEqual(a: StageCard, b: StageCard): boolean {
  return (
    a.rowId === b.rowId &&
    a.stage === b.stage &&
    a.mode === b.mode &&
    a.input === b.input &&
    a.output === b.output &&
    a.done === b.done &&
    a.reflow === b.reflow &&
    sameList(a.roles, b.roles) &&
    sameRecord(a.extra, b.extra)
  )
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((key) => a[key] === b[key])
}

function omit(record: Record<string, string>, key: string): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [k, value] of Object.entries(record)) if (k !== key) next[k] = value
  return next
}

function pick(record: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const next: Record<string, string> = {}
  for (const key of keys) next[key] = record[key] ?? ''
  return next
}
