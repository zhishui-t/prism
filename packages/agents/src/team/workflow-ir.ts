/**
 * 团队工作流 → archify `workflow` IR（design-v5 §F-C4）——**纯函数**：零 IO、零时钟、零随机。
 *
 * 为什么必须是纯函数：IR 是**派生视图**（团队定义才是真相，红线 R7）。同输入必须同字节，
 * 否则每次渲染产物哈希都变，sidecar 的 `ir_hash` 就失去「产物是否与源同步」的意义。
 * 因此本文件**不得**出现 `new Date()` / `Math.random()` / `fs` 调用。
 *
 * 映射口径（队长裁决 D4/D5，改口径 = 改所有产物，需评审）：
 *
 * - **D4 角色 → `nodes[].type`**：`dev*` / `super-dev` / `leader` / `队长` → `backend`；
 *   `frontend*` → `frontend`；`tester*` / `qa*` / `reviewer*` / `researcher*` → `external`；
 *   未匹配 → `external`（保守）。映射来源写进 `meta.subtitle`——schema 对 `meta` 是
 *   `additionalProperties: false`，加不了自定义键，故用副标题承载溯源。
 * - **D5 阶段序号 → `nodes[].col`**（archify 上限 0..5）：
 *   `col = min(5, floor(order * 6 / maxOrder))`；同 `order` 必同 `col`；同 `col` 的阶段
 *   合成一个 `phases` 条目（避免同列多 phase 互相压字）。
 *
 * 泳道模型：**lane = 角色实例**（`dev-1#1` 与 `dev-1#2` 是两条泳道），
 * **node = 阶段 × 角色**，横向按阶段推进；edge = 相邻阶段之间的主路径连线。
 * 阶段无角色时落到合成泳道 `workflow`（否则该阶段会从图上消失）。
 *
 * id 约束（`common.schema.json#/$defs/id`：`^[a-zA-Z][a-zA-Z0-9_-]*$`）：
 * 中文角色名（`队长`）与实例记号（`dev-1#2`）都不能直接当 id，故统一 slug 化。
 */

import type { TeamDefinition, WorkflowStage } from '../types.js'
import { stripInstanceMarker } from './validate.js'

/** archify `common.schema.json#/$defs/componentType` 的 7 值枚举。 */
export type WorkflowNodeType =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'cloud'
  | 'security'
  | 'messagebus'
  | 'external'

export interface WorkflowIrLane {
  id: string
  label: string
}

export interface WorkflowIrNode {
  id: string
  lane: string
  col: number
  type: WorkflowNodeType
  label: string
  sublabel?: string
  tag?: string
}

/**
 * 节点文本的**硬上限**（单位 = archify 的「文本单位」：全角/宽字符 2、其余 1）。
 *
 * 为什么必须截断：archify `workflow` 渲染器把 `label`/`sublabel`/`tag` 画成
 * **不换行的单行 `<text>`**，并拒绝「缩到 6px 仍放不下」的节点
 * （`workflow-compiler.mjs:2265-2273`，口径 `textUnits*6*0.6 <= node.width-8`；
 * label 更严：`textUnits*6.2 <= node.width+6`）。
 * 默认节点宽 `node.width = 92`（`layout.nodeW`），故可用文字宽 84px →
 * sublabel/tag ≤ 23 单位、label ≤ 15 单位。
 *
 * **不能靠「加宽节点」绕过**（实测）：节点一加宽，自动布线就会横向错位，
 * 触发 `clean-flow/endpoint-side-direction` 与 `edge-through-node` 一连串错误。
 * 故唯一稳妥的做法是**收敛文本**——留 1 单位余量（22 / 14），不贴着上限。
 *
 * `phase` 同理但有独立口径：阶段头标签的画布宽在 `schema_version=1` 下**不参与**布局扩张
 * （`workflow-compiler.mjs:2729` 只对 v2 计入），校验为
 * `textUnits*5.6 <= 单列宽(92) + 8` → ≤ 17 单位；取 16 留余量。
 * 同列多阶段会被合并成一条 phase 标签，故截断在合并之后进行。
 */
const TEXT_LIMITS = { label: 14, sublabel: 22, phase: 16 } as const

/**
 * 宽字符判定（CJK / 全角 / 星平面）。
 *
 * 与 archify `shared/utils.mjs:textUnits` 的 `FULLWIDTH_RE` **同口径的保守近似**：
 * 列出的区段与原正则一致；不在列表内的一律按窄字符（1）计。
 * 采用「只多不少」的星平面规则（>0xFFFF → 2），使未知码点只会得到更宽的估算，
 * 不会把超限文本误判为可放。
 */
function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint > 0xffff ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97c) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  )
}

/** 文本占位宽度（单位数）。 */
function textUnits(text: string): number {
  let units = 0
  for (const ch of text) units += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
  return units
}

/** 超限则按单位截断并以 `…` 结尾（省略号占 1 单位）；不超限原样返回。 */
function fitUnits(text: string, maxUnits: number): string {
  if (textUnits(text) <= maxUnits) return text
  const out: string[] = []
  let units = 0
  for (const ch of text) {
    const cost = isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (units + cost > maxUnits - 1) break // 留 1 单位给省略号
    out.push(ch)
    units += cost
  }
  return `${out.join('').trimEnd()}…`
}

export interface WorkflowIrEdge {
  from: string
  to: string
  role?: 'main'
}

export interface WorkflowIrPhase {
  id: string
  label: string
  fromCol: number
  toCol: number
}

export interface WorkflowIr {
  schema_version: 1
  diagram_type: 'workflow'
  meta: {
    title: string
    subtitle?: string
  }
  lanes: WorkflowIrLane[]
  phases: WorkflowIrPhase[]
  nodes: WorkflowIrNode[]
  edges: WorkflowIrEdge[]
  /** 主路径（每阶段首个节点）；阶段 < 2 时省略（schema 要求 minItems 2）。 */
  mainPath?: string[]
}

/** 无角色阶段的兜底泳道 id / 标签。 */
const FALLBACK_LANE_ID = 'workflow'
const FALLBACK_LANE_LABEL = '工作流'

/** 已知中文角色名的 ASCII 别名（slug 化做不到音译，只能查表；未列出的纯中文名走 `role-N`）。 */
const ROLE_SLUG_ALIASES: Readonly<Record<string, string>> = {
  队长: 'leader',
  leader: 'leader',
}

/** D4 映射表（顺序即优先级：`dev*` 在前，`super-dev` 单独判，避免被 `/^dev/` 抢走无影响但要显式）。 */
function mapRoleToNodeType(roleRef: string): WorkflowNodeType {
  const name = stripInstanceMarker(roleRef).toLowerCase()
  if (name.startsWith('dev') || name === 'super-dev' || name === 'leader' || name === '队长') {
    return 'backend'
  }
  if (name.startsWith('frontend')) return 'frontend'
  if (
    name.startsWith('tester') ||
    name.startsWith('qa') ||
    name.startsWith('reviewer') ||
    name.startsWith('researcher')
  ) {
    return 'external'
  }
  return 'external'
}

/** D5 列映射：`min(5, floor(order * 6 / maxOrder))`。 */
function columnOf(order: number, maxOrder: number): number {
  if (maxOrder <= 0) return 0
  return Math.min(5, Math.floor((order * 6) / maxOrder))
}

/**
 * 角色引用 → 合法 id 片段。
 * `dev-1#2` → `dev-1-2`；`队长` → `leader`（别名）；纯中文且无别名 → `''`（由调用方给 `role-N` 兜底）。
 */
function slugRole(roleRef: string): string {
  const trimmed = roleRef.trim()
  const alias = ROLE_SLUG_ALIASES[trimmed]
  const source = alias ?? trimmed
  return source
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 稳定的 `role-N` 兜底（N = 泳道首次出现序号，1 起）；保证 id 以字母开头且唯一。 */
function fallbackLaneId(index: number): string {
  return `role-${index}`
}

function assertId(id: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error(`内部错误：生成的 id 不合 archify schema：${id}`)
  }
}

/** 按 order 稳定排序（order 相同时保留输入顺序，保证同输入同输出）。 */
function sortStages(stages: readonly WorkflowStage[]): WorkflowStage[] {
  return stages
    .map((stage, index) => ({ stage, index }))
    .sort((a, b) => a.stage.order - b.stage.order || a.index - b.index)
    .map((item) => item.stage)
}

/**
 * 团队定义 → archify `workflow` IR。
 *
 * @throws Error 团队工作流为空时抛出（schema 要求 `nodes` 至少 1 项，
 *   为空说明团队定义本身不完整，交给校验器/调用方报错，不伪造节点）。
 */
export function buildTeamWorkflowIr(team: TeamDefinition): WorkflowIr {
  const stages = sortStages(team.workflow)
  if (stages.length === 0) {
    throw new Error(`团队「${team.team_id}」没有工作流阶段，无法生成架构图 IR`)
  }

  const maxOrder = stages.reduce((max, stage) => Math.max(max, stage.order), 0)

  // ① 泳道：角色实例首次出现即登记（顺序 = 首次出现顺序，可复现）
  const lanes: WorkflowIrLane[] = []
  const laneIdOf = new Map<string, string>()
  const usedLaneIds = new Set<string>()
  const laneFor = (roleRef: string): string => {
    const key = roleRef.trim()
    const existing = laneIdOf.get(key)
    if (existing !== undefined) return existing
    let id = slugRole(key)
    if (id === '' || usedLaneIds.has(id)) {
      // 纯中文无名别名 / slug 撞车 → 稳定兜底（首个可用序号）
      let n = lanes.length + 1
      while (usedLaneIds.has(fallbackLaneId(n))) n++
      id = fallbackLaneId(n)
    }
    assertId(id)
    usedLaneIds.add(id)
    laneIdOf.set(key, id)
    lanes.push({ id, label: key })
    return id
  }

  // ② 节点：阶段 × 角色；无角色阶段落合成泳道
  const nodes: WorkflowIrNode[] = []
  const stageNodes = new Map<number, string[]>()
  const usedNodeIds = new Set<string>()
  for (const stage of stages) {
    const nodeIds: string[] = []
    const roles = [...new Set(stage.roles.map((role) => role.trim()).filter((role) => role !== ''))]
    const targets: string[] = roles.length > 0 ? roles : [FALLBACK_LANE_LABEL]

    for (const roleRef of targets) {
      const laneId =
        roles.length > 0
          ? laneFor(roleRef)
          : (() => {
              const existing = laneIdOf.get(FALLBACK_LANE_LABEL)
              if (existing !== undefined) return existing
              usedLaneIds.add(FALLBACK_LANE_ID)
              laneIdOf.set(FALLBACK_LANE_LABEL, FALLBACK_LANE_ID)
              lanes.push({ id: FALLBACK_LANE_ID, label: FALLBACK_LANE_LABEL })
              return FALLBACK_LANE_ID
            })()

      let id = `s${stage.order}-${laneId}`
      let suffix = 2
      while (usedNodeIds.has(id)) id = `s${stage.order}-${laneId}-${suffix++}`
      assertId(id)
      usedNodeIds.add(id)
      nodeIds.push(id)
      // 文本一律过 `fitUnits`：阶段名/产出物是**团队定义的自由文本**，长度不可控，
      // 而 archify 节点文本不换行、放不下即判「非法」（见 TEXT_LIMITS）。
      // 阶段名为空时给稳定兜底：schema 要求 `label` 至少 1 字符。
      const stageName = stage.stage.trim() === '' ? `阶段 ${stage.order}` : stage.stage.trim()
      const output = stage.output.trim()
      const tag = stage.mode === 'parallel' ? '并行' : ''
      nodes.push({
        id,
        lane: laneId,
        col: columnOf(stage.order, maxOrder),
        type: roles.length > 0 ? mapRoleToNodeType(roleRef) : 'external',
        label: fitUnits(stageName, TEXT_LIMITS.label),
        ...(output !== '' ? { sublabel: fitUnits(output, TEXT_LIMITS.sublabel) } : {}),
        ...(tag !== '' ? { tag: fitUnits(tag, TEXT_LIMITS.sublabel) } : {}),
      })
    }
    stageNodes.set(stage.order, nodeIds)
  }

  // ③ 边：相邻「非空阶段」之间的主路径连线
  const orderedGroups = stages
    .map((stage) => ({ order: stage.order, nodeIds: stageNodes.get(stage.order) ?? [] }))
    .filter((group) => group.nodeIds.length > 0)
  const edges: WorkflowIrEdge[] = []
  for (let i = 0; i + 1 < orderedGroups.length; i++) {
    for (const from of orderedGroups[i].nodeIds) {
      for (const to of orderedGroups[i + 1].nodeIds) {
        edges.push({ from, to, role: 'main' })
      }
    }
  }

  // ④ phases：同 col 的阶段合成一条（同列多 phase 会互相压字）
  const phases: WorkflowIrPhase[] = []
  const phasesByCol = new Map<number, string[]>()
  for (const stage of stages) {
    const col = columnOf(stage.order, maxOrder)
    const labels = phasesByCol.get(col)
    if (labels === undefined) phasesByCol.set(col, [stage.stage])
    else labels.push(stage.stage)
  }
  for (const col of [...phasesByCol.keys()].sort((a, b) => a - b)) {
    const id = `phase-${col}`
    assertId(id)
    // 阶段头标签的画布宽是**定值**（见 TEXT_LIMITS.phase）→ 合并后必须收敛。
    phases.push({
      id,
      label: fitUnits(phasesByCol.get(col)!.join(' / '), TEXT_LIMITS.phase),
      fromCol: col,
      toCol: col,
    })
  }

  // ⑤ 主路径：每阶段取首个节点（≥2 段才有意义，schema 要求 minItems 2）
  const mainPath = orderedGroups.map((group) => group.nodeIds[0]).filter((id) => id !== undefined)

  return {
    schema_version: 1,
    diagram_type: 'workflow',
    meta: {
      title: `${team.name} 工作流`,
      subtitle:
        `团队 ${team.team_id} ｜ 角色→类型映射（D4 固定表）：` +
        `dev*/super-dev/队长/leader→backend；frontend*→frontend；` +
        `tester*/qa*/reviewer*/researcher*/未匹配→external`,
    },
    lanes,
    phases,
    nodes,
    edges,
    ...(mainPath.length >= 2 ? { mainPath } : {}),
  }
}
