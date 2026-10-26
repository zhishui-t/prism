/**
 * 团队运行时看板（读取 `.agent-team/` 黑板，**只读**）。
 *
 * 定位（R1）：Prism **不调度、不派发**——调度由队长（宿主 agent）做，运行时真相是
 * 项目下的 `.agent-team/` 黑板（`dag.json` / `agents.md` / `context.md` / 门禁文件 /
 * `DELIVERY*.md`）。本模块只做三件事：
 *
 * 1. **解析**：把黑板读成结构化快照（容错优先——缺文件/坏 JSON 不抛，落 `gaps`）；
 * 2. **推导**：按「依赖全 done 且自己 pending」算**可派发集**，其余 pending 算受阻；
 * 3. **对账**：任务角色 × 名册 × 会话登记 × 门禁文件的一致性缺口（`gaps`）。
 *
 * 口径：
 * - 文件为真相（R7）：不缓存、不改写、不生成黑板文件；
 * - 路径只来自显式传入的项目根（R6：调用方从项目注册表取，不在本模块猜）；
 * - 读失败一律降级为 `gaps` 条目，**绝不把「读不到」显示成「全部完成」**。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { PrismError } from '@prism/core'

import {
  TASK_KINDS,
  detectReadyScopeCollisions,
  evaluateDeliveryGate,
  validateTaskContract,
  type ContractTaskView,
  type DeliveryGate,
  type TaskContract,
  type TaskKind,
} from './task-contract.js'

/** 黑板相对项目根的目录名（与 prism 技能 agent-team 手册同源）。 */
export const BLACKBOARD_DIR = '.agent-team'

export type RuntimeTaskStatus = 'done' | 'running' | 'pending' | 'blocked'

/** 任务节点（dag.json 的节点 + 推导出的派发状态）。 */
export interface RuntimeTask {
  id: string
  label: string
  /** 承接角色原文（可为组合，如「dev + junior-dev」「双 tester」）。 */
  role: string
  status: RuntimeTaskStatus
  /** 状态原文（未知值原样保留；已知值为四态之一）。 */
  statusRaw: string
  deps: string[]
  /** 可派发：自身 pending 且依赖全部 done。 */
  ready: boolean
  /** 受阻：自身 pending 且仍有未完成依赖。 */
  waiting: boolean
  /** 依赖里指向不存在节点的 id（数据缺陷，落 gap）。 */
  missingDeps: string[]
  /** 结构化契约（dag.json 的可选扩展键；缺省为 work/自由文本）。 */
  contract: TaskContract
}

/** 会话登记（agents.md 的一行）。 */
export interface RuntimeDispatchEntry {
  role: string
  agentId: string | null
  sessionId: string | null
  state: string
  /** 该登记对应的 dag 任务 id（按角色名匹配，可能为空）。 */
  taskIds: string[]
}

/** 一致性缺口（对账结果；error 会阻断「一切正常」的观感）。 */
export interface RuntimeGap {
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
  where?: string
}

/** 断点快照（context.md 的 `- 键：值` 行）。 */
export interface RuntimeSnapshotRow {
  key: string
  value: string
}

/** 门禁文件（`.design_ok` / `.code_ok_v18` / `.qa_ok` …）。 */
export interface RuntimeGate {
  name: string
  present: boolean
}

/** 黑板文件存在性（「我到底看到了什么」——不猜）。 */
export interface RuntimeFileInfo {
  name: string
  present: boolean
  /** epoch 毫秒。 */
  mtime?: number
}

/** 一个项目的团队运行时快照。 */
export interface TeamRuntime {
  project: string
  root: string
  /** `.agent-team/` 是否存在。 */
  hasBlackboard: boolean
  title: string
  tasks: RuntimeTask[]
  edges: Array<{ from: string; to: string }>
  counts: Record<RuntimeTaskStatus, number>
  /** 可派发任务 id（依赖已就绪、自身待开始）。 */
  ready: string[]
  /** 受阻任务 id（依赖未就绪）。 */
  waiting: string[]
  /** 会话登记与任务的映射。 */
  dispatch: RuntimeDispatchEntry[]
  snapshot: RuntimeSnapshotRow[]
  gates: RuntimeGate[]
  /** 最新交付报告（文件名 + mtime）；没有则 null。 */
  delivery: { file: string; mtime: number } | null
  files: RuntimeFileInfo[]
  gaps: RuntimeGap[]
  /** 已解析的 dag 标题行（dag.json title 缺失时为空串）。 */
  dagTitle: string
  /** 交付门禁：全部完成 + 审核 pass + 无失败（机械判定，不看叙述）。 */
  deliveryGate: DeliveryGate
  /** 本次快照读的是哪个任务目录（'' = 旧版平铺布局 / 无黑板）。 */
  run: string
  /** `.agent-team/` 下识别到的全部任务目录（多团队并行时用于切换）。 */
  runs: TeamRunInfo[]
}

/** 一个任务目录（run）的识别信息。 */
export interface TeamRunInfo {
  /** 任务目录名（`.agent-team/<id>/`）；空串 = 旧版平铺布局（状态文件直接在 .agent-team/ 下）。 */
  id: string
  /** dag.json 的 title（读不到为空串；选择器显示用）。 */
  title: string
  /** dag.json mtime（epoch 毫秒；无 dag 为 undefined——按「无图」排后）。 */
  dagMtime?: number
  /** 旧版平铺布局（id 为空串时恒 true）。 */
  legacy: boolean
}

/** dag.json 的节点形状（容错读取：字段类型不对按缺失处理）。 */
interface RawWfNode {
  id: string
  label: string
  role: string
  status: string
  deps: string[]
  /** 原始节点对象（契约字段从这里取；未声明的键一律忽略）。 */
  raw: Record<string, unknown>
}

/** 目录读取结果（不含 run/runs——编排层补）。 */
type RunSnapshot = Omit<TeamRuntime, 'run' | 'runs'>

/** 任务目录名：单段、字母数字开头、可含 . _ -（拒路径分隔与 .. 逃逸）。 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 读项目黑板的运行时快照（**按任务目录**）。
 *
 * 一个项目可以同时跑多个任务（多支团队并行）——黑板按 `.agent-team/<run>/` 分目录，
 * 互不覆盖。`run` 省略 = 自动选** dag.json 最新**的任务（多任务并行时通常是想看最活跃的）；
 * 指定不存在或非法的 run → 明确报错（不静默回落到别的任务——那等于看错队）。
 *
 * 旧版平铺布局（状态文件直接在 `.agent-team/` 下）以 `run: ''` 的 legacy 形态识别与兼容。
 *
 * @param root 项目根（由调用方从项目注册表取——本模块不猜路径）
 * @param project 项目名（仅回显）
 * @param run 任务目录名（省略 = 自动选最新）
 */
export async function readTeamRuntime(root: string, project: string, run?: string): Promise<TeamRuntime> {
  if (run !== undefined && run !== '' && !RUN_ID_RE.test(run)) {
    throw new PrismError('bad_request', `非法的任务目录名: ${run}（须为 .agent-team/ 下的单段目录名）`)
  }
  const runs = await listTeamRuns(root)
  // run 省略 = 自动选最新；显式给出（含 '' = 旧版平铺）= 精确指定，找不到就报错
  const picked = run === undefined ? pickActiveRun(runs) : runs.find((r) => r.id === run)
  if (run !== undefined && picked === undefined) {
    throw new PrismError(
      'not_found',
      `.agent-team/ 下没有任务目录: ${run}（现有：${runs.map((r) => r.id || '(根目录·旧布局)').join('、') || '无'}）`,
    )
  }
  const dir = picked === undefined || picked.legacy
    ? join(root, BLACKBOARD_DIR)
    : join(root, BLACKBOARD_DIR, picked.id)
  const snapshot = await readRunDir(root, project, dir)
  return { ...snapshot, run: picked?.id ?? '', runs }
}

/** 识别 `.agent-team/` 下的任务目录（子目录 + 旧版平铺），只认含状态文件的目录。 */
export async function listTeamRuns(root: string): Promise<TeamRunInfo[]> {
  const base = join(root, BLACKBOARD_DIR)
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const runs: TeamRunInfo[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const info = await runInfoOf(join(base, e.name), e.name, false)
    if (info !== null) runs.push(info)
  }
  runs.sort((a, b) => a.id.localeCompare(b.id))
  const legacy = await runInfoOf(base, '', true)
  if (legacy !== null) runs.push(legacy)
  return runs
}

/** 单个候选目录的识别（不含任一状态文件 → null，不进清单）。 */
async function runInfoOf(dir: string, id: string, legacy: boolean): Promise<TeamRunInfo | null> {
  const dagMtime = await statSafe(join(dir, 'dag.json'))
  const agentsMtime = await statSafe(join(dir, 'agents.md'))
  const contextMtime = await statSafe(join(dir, 'context.md'))
  if (dagMtime === undefined && agentsMtime === undefined && contextMtime === undefined) return null
  let title = ''
  if (dagMtime !== undefined) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'dag.json'), 'utf8')) as { title?: unknown }
      if (typeof parsed.title === 'string') title = parsed.title
    } catch {
      /* 坏 JSON 的目录照样列出（title 留空）；读快照时再报 runtime_dag_invalid */
    }
  }
  return { id, title, ...(dagMtime !== undefined ? { dagMtime } : {}), legacy }
}

/** 自动选「最活跃」的任务：有 dag 的按 dag.json mtime 最新；无 dag 的排后（按列出序）。 */
function pickActiveRun(runs: readonly TeamRunInfo[]): TeamRunInfo | undefined {
  if (runs.length === 0) return undefined
  return [...runs].sort((a, b) => (b.dagMtime ?? -1) - (a.dagMtime ?? -1))[0]
}

/** 读取单个黑板目录（平铺或任务目录同一段实现）。 */
async function readRunDir(root: string, project: string, dir: string): Promise<RunSnapshot> {
  const gaps: RuntimeGap[] = []
  const files: RuntimeFileInfo[] = []

  const [dagRaw, agentsRaw, contextRaw, dirEntries] = await Promise.all([
    readText(join(dir, 'dag.json')),
    readText(join(dir, 'agents.md')),
    readText(join(dir, 'context.md')),
    readDirSafe(dir),
  ])

  const dagStat = await statSafe(join(dir, 'dag.json'))
  const agentsStat = await statSafe(join(dir, 'agents.md'))
  const contextStat = await statSafe(join(dir, 'context.md'))

  files.push({ name: 'dag.json', present: dagRaw !== null, ...(dagStat !== undefined ? { mtime: dagStat } : {}) })
  files.push({ name: 'agents.md', present: agentsRaw !== null, ...(agentsStat !== undefined ? { mtime: agentsStat } : {}) })
  files.push({ name: 'context.md', present: contextRaw !== null, ...(contextStat !== undefined ? { mtime: contextStat } : {}) })

  const hasBlackboard = dirEntries !== null

  /* ---- dag.json ---- */
  let dagTitle = ''
  const rawNodes: RawWfNode[] = []
  const rawEdges: Array<{ from: string; to: string }> = []
  if (dagRaw !== null) {
    try {
      const parsed = JSON.parse(dagRaw) as unknown
      if (typeof parsed !== 'object' || parsed === null) {
        gaps.push({ level: 'error', code: 'runtime_dag_invalid', message: 'dag.json 顶层不是对象', where: 'dag.json' })
      } else {
        const obj = parsed as { title?: unknown; nodes?: unknown; edges?: unknown }
        dagTitle = typeof obj.title === 'string' ? obj.title : ''
        if (Array.isArray(obj.nodes)) {
          for (const n of obj.nodes) {
            if (typeof n !== 'object' || n === null) continue
            const o = n as Record<string, unknown>
            const id = typeof o['id'] === 'string' ? o['id'].trim() : ''
            if (id === '') continue
            const deps = Array.isArray(o['deps'])
              ? o['deps'].filter((d): d is string => typeof d === 'string').map((d) => d.trim()).filter((d) => d !== '')
              : []
            rawNodes.push({
              id,
              label: typeof o['label'] === 'string' ? o['label'] : id,
              role: typeof o['role'] === 'string' ? o['role'] : '',
              status: typeof o['status'] === 'string' ? o['status'] : 'pending',
              deps,
              raw: o,
            })
          }
        } else {
          gaps.push({ level: 'error', code: 'runtime_dag_invalid', message: 'dag.json 缺少 nodes 数组', where: 'dag.json' })
        }
        if (Array.isArray(obj.edges)) {
          for (const e of obj.edges) {
            if (!Array.isArray(e) || e.length < 2) continue
            const from = typeof e[0] === 'string' ? e[0].trim() : ''
            const to = typeof e[1] === 'string' ? e[1].trim() : ''
            if (from !== '' && to !== '') rawEdges.push({ from, to })
          }
        }
      }
    } catch (e) {
      gaps.push({
        level: 'error',
        code: 'runtime_dag_invalid',
        message: `dag.json 解析失败：${e instanceof Error ? e.message : String(e)}`,
        where: 'dag.json',
      })
    }
  } else if (hasBlackboard) {
    gaps.push({
      level: 'info',
      code: 'runtime_dag_missing',
      message: '项目有 .agent-team/ 但没有 dag.json——队长尚未建任务依赖图（可跑 agent-team 的 scripts/dag.mjs 初始化）',
      where: BLACKBOARD_DIR,
    })
  }

  /* ---- 边与依赖合并（与 dag.mjs 同口径：nodes[].deps ∪ edges，去重） ---- */
  const idSet = new Set(rawNodes.map((n) => n.id))
  const edgeKey = new Set<string>()
  const edges: Array<{ from: string; to: string }> = []
  const addEdge = (from: string, to: string): void => {
    const key = `${from}\u0000${to}`
    if (edgeKey.has(key)) return
    edgeKey.add(key)
    edges.push({ from, to })
  }
  for (const e of rawEdges) {
    addEdge(e.from, e.to)
  }
  for (const n of rawNodes) {
    for (const d of n.deps) addEdge(d, n.id)
  }
  // 稳定输出序（from → to）：黑板文件的行序不是语义，读侧排序让同一份数据每次给出同一形状
  edges.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)))
  for (const e of edges) {
    if (!idSet.has(e.from)) {
      gaps.push({
        level: 'error',
        code: 'runtime_dep_missing',
        message: `依赖边指向不存在的任务：${e.from} → ${e.to}`,
        where: 'dag.json',
      })
    }
    if (!idSet.has(e.to)) {
      gaps.push({
        level: 'error',
        code: 'runtime_dep_missing',
        message: `依赖边指向不存在的任务：${e.from} → ${e.to}`,
        where: 'dag.json',
      })
    }
  }

  /* ---- 状态归一 + 依赖就绪判定 ---- */
  const statusOf = new Map<string, RuntimeTaskStatus>()
  const tasks: RuntimeTask[] = rawNodes.map((n) => {
    const status = normalizeStatus(n.status)
    statusOf.set(n.id, status)
    return {
      id: n.id,
      label: n.label,
      role: n.role,
      status,
      statusRaw: n.status,
      deps: [...n.deps],
      ready: false,
      waiting: false,
      missingDeps: n.deps.filter((d) => !idSet.has(d)),
      contract: parseTaskContract(n.raw),
    }
  })

  // 环检测（Kahn）：有环时全部 pending 都会「永远不就绪」，必须显式报
  const cycle = detectCycle(rawNodes, edges)
  if (cycle !== null) {
    gaps.push({
      level: 'error',
      code: 'runtime_cycle',
      message: `任务依赖存在环：${cycle.join(' → ')}`,
      where: 'dag.json',
    })
  }

  for (const t of tasks) {
    if (t.status !== 'pending') {
      t.ready = false
      t.waiting = false
      continue
    }
    const allDone = t.deps.length === 0 || t.deps.every((d) => statusOf.get(d) === 'done')
    t.ready = allDone
    t.waiting = !allDone
  }

  const counts: Record<RuntimeTaskStatus, number> = { done: 0, running: 0, pending: 0, blocked: 0 }
  for (const t of tasks) counts[t.status] += 1

  const unknown = tasks.filter((t) => !isKnownStatus(t.statusRaw))
  if (unknown.length > 0) {
    gaps.push({
      level: 'warning',
      code: 'runtime_unknown_status',
      message: `任务状态不在四态（done/running/pending/blocked）内，已按 pending 处理：${unknown
        .map((t) => `${t.id}=${t.statusRaw === '' ? '空' : t.statusRaw}`)
        .join('、')}`,
      where: 'dag.json',
    })
  }

  /* ---- agents.md（会话登记） ---- */
  const registrations = agentsRaw === null ? [] : parseAgentsMd(agentsRaw)
  const dispatch: RuntimeDispatchEntry[] = registrations.map((r) => ({
    ...r,
    taskIds: tasks.filter((t) => roleMatches(t.role, r.role)).map((t) => t.id),
  }))

  /* ---- context.md（断点快照） ---- */
  const snapshot = contextRaw === null ? [] : parseContextMd(contextRaw)

  /* ---- 门禁文件 ---- */
  const gates: RuntimeGate[] = (dirEntries ?? [])
    .filter((name) => /^\.[\w.-]*_ok(_v\d+)?$/.test(name) || /_ok(_v\d+)?$/.test(name))
    .filter((name) => name.startsWith('.'))
    .sort()
    .map((name) => ({ name, present: true }))

  /* ---- DELIVERY ---- */
  const deliveryFiles = (dirEntries ?? []).filter((name) => /^DELIVERY.*\.md$/i.test(name))
  let delivery: { file: string; mtime: number } | null = null
  for (const file of deliveryFiles) {
    const mtime = await statSafe(join(dir, file))
    if (mtime !== undefined && (delivery === null || mtime > delivery.mtime)) delivery = { file, mtime }
  }

  /* ---- 任务契约与交付门禁（机械可判定部分） ---- */
  const contractViews: ContractTaskView[] = tasks.map((t) => ({
    id: t.id,
    label: t.label,
    status: t.status === 'blocked' && t.statusRaw.trim().toLowerCase() === 'failed' ? 'failed' : t.status,
    ready: t.ready,
    contract: t.contract,
  }))
  for (const view of contractViews) {
    gaps.push(...validateTaskContract(view))
  }
  gaps.push(...detectReadyScopeCollisions(contractViews))
  const deliveryGate = evaluateDeliveryGate(contractViews)

  /* ---- 对账（缺口） ---- */
  // 1) 运行中/可派发任务的角色没有会话登记 → 不知道谁在做
  for (const t of tasks) {
    if (t.status !== 'running' && !t.ready) continue
    if (t.role.trim() === '') continue
    if (!registrationFor(t.role, dispatch)) {
      gaps.push({
        level: 'warning',
        code: 'runtime_task_unregistered',
        message: `任务「${t.label}」（${t.id}，${t.status === 'running' ? '进行中' : '可派发'}）的承接「${t.role}」在 agents.md 没有会话登记`,
        where: 'agents.md',
      })
    }
  }
  // 2) 已登记但没有对应任务的会话（空闲信息，不算错）
  for (const d of dispatch) {
    if (d.taskIds.length === 0 && d.agentId !== null) {
      gaps.push({
        level: 'info',
        code: 'runtime_idle_instance',
        message: `会话登记「${d.role}」(${d.agentId}) 没有对应的 dag 任务——可能是已归档的实例，或 dag.json 未覆盖`,
        where: 'agents.md',
      })
    }
  }
  // 3) 断点快照比 dag 旧 → 可能过期
  if (contextStat !== undefined && dagStat !== undefined && contextStat < dagStat) {
    gaps.push({
      level: 'warning',
      code: 'runtime_snapshot_stale',
      message: 'context.md 比 dag.json 旧——断点快照可能已过期，压缩恢复前先核对',
      where: 'context.md',
    })
  }
  // 4) 有 dag 但没有任何门禁文件（info：可能还没走到审核环节）
  if (tasks.length > 0 && gates.length === 0) {
    gaps.push({
      level: 'info',
      code: 'runtime_no_gates',
      message: '黑板里没有任何门禁文件（.design_ok / .code_ok / .qa_ok）——审核环节可能尚未开始',
      where: BLACKBOARD_DIR,
    })
  }
  // 5) 全部任务已完成，但交付报告不存在或比 dag 更旧
  //    ——这是最容易「看起来收工了其实少交一份东西」的形态（实测本仓 v18 就是：
  //    dag 全 done 且比 DELIVERY-v17 新 8 小时，v18 的交付报告根本没写）
  const allSettled = tasks.length > 0 && counts.pending === 0 && counts.running === 0
  if (allSettled && (delivery === null || (dagStat !== undefined && delivery.mtime < dagStat))) {
    gaps.push({
      level: 'warning',
      code: 'runtime_delivery_missing',
      message:
        delivery === null
          ? '任务全部完成，但黑板里没有任何 DELIVERY*.md 交付报告'
          : `任务全部完成，但最新的交付报告 ${delivery.file} 比 dag.json 旧——本轮的交付报告可能还没写`,
      where: 'DELIVERY*.md',
    })
  }

  return {
    project,
    root,
    hasBlackboard,
    title: dagTitle !== '' ? dagTitle : project,
    dagTitle,
    tasks,
    edges,
    counts,
    ready: tasks.filter((t) => t.ready).map((t) => t.id),
    waiting: tasks.filter((t) => t.waiting).map((t) => t.id),
    dispatch,
    snapshot,
    gates,
    delivery,
    files,
    gaps,
    deliveryGate,
  }
}

/** 已知状态值（含常见别名）——归一后不报 unknown；其余一律 pending + 告警。 */
const KNOWN_STATUS_ALIASES: Readonly<Record<string, RuntimeTaskStatus>> = {
  done: 'done',
  completed: 'done',
  closed: 'done',
  running: 'running',
  active: 'running',
  in_progress: 'running',
  pending: 'pending',
  todo: 'pending',
  blocked: 'blocked',
  failed: 'blocked',
  stuck: 'blocked',
}

/** 状态归一：未知值按 pending（并留 statusRaw 供 gap 报告）。 */
function normalizeStatus(raw: string): RuntimeTaskStatus {
  return KNOWN_STATUS_ALIASES[raw.trim().toLowerCase()] ?? 'pending'
}

/** 该状态原文是否已知（别名表内）。 */
function isKnownStatus(raw: string): boolean {
  return Object.prototype.hasOwnProperty.call(KNOWN_STATUS_ALIASES, raw.trim().toLowerCase())
}

/** 环检测：返回环路径（找不到返回 null）。 */
function detectCycle(nodes: readonly RawWfNode[], edges: readonly { from: string; to: string }[]): string[] | null {
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const n of nodes) {
    adj.set(n.id, [])
    indeg.set(n.id, 0)
  }
  for (const e of edges) {
    if (!adj.has(e.from) || !indeg.has(e.to)) continue
    adj.get(e.from)!.push(e.to)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const seen = new Set<string>()
  while (queue.length > 0) {
    const cur = queue.shift()!
    seen.add(cur)
    for (const next of adj.get(cur) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (seen.size === nodes.length) return null
  // 剩下的都是环上（或环下游）节点——按 id 顺序给一条可读链
  return nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)
}

/** 解析 agents.md 的会话登记表（跳过「已归档」小节；只认带 agent_/wbdy- 痕迹的行）。 */
export function parseAgentsMd(markdown: string): Array<{
  role: string
  agentId: string | null
  sessionId: string | null
  state: string
}> {
  const out: Array<{ role: string; agentId: string | null; sessionId: string | null; state: string }> = []
  let archived = false
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) {
      archived = /归档|已归档|archive/i.test(trimmed)
      continue
    }
    if (archived || !trimmed.startsWith('|')) continue
    const cells = splitRow(trimmed)
    if (cells.length < 2) continue
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue
    const joined = cells.join(' ')
    if (cells[0]!.includes('岗位') || cells[0]!.includes('角色/') || cells[0]!.includes('角色 →')) continue
    const agentId = /agent_[A-Za-z0-9_-]+/.exec(joined)?.[0] ?? null
    const sessionId = /wbdy-[A-Za-z0-9_-]+/.exec(joined)?.[0] ?? null
    if (agentId === null && sessionId === null) continue
    const role = cleanRoleName(cells[0]!)
    if (role === '') continue
    const state = cells[cells.length - 1]!.trim()
    out.push({ role, agentId, sessionId, state })
  }
  return out
}

/** 行内角色名清洗：去加粗、去括号说明（中英文括号）、去「×N」。 */
function cleanRoleName(cell: string): string {
  return cell
    .replace(/\*\*/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[×x]\s*\d+\s*$/i, '')
    .trim()
}

/** 解析 context.md 的 `- 键：值` 行。 */
export function parseContextMd(markdown: string): RuntimeSnapshotRow[] {
  const out: RuntimeSnapshotRow[] = []
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^\s*[-*]\s*([^：:]{1,20})[：:]\s*(.*)$/.exec(line)
    if (m !== null) out.push({ key: m[1]!.trim(), value: m[2]!.trim() })
  }
  return out
}

/** 任务角色（可组合）是否匹配登记角色：分词后任一命中即算。 */
export function roleMatches(taskRole: string, regRole: string): boolean {
  const task = splitRoleTokens(taskRole)
  const reg = splitRoleTokens(regRole)
  return task.some((t) => reg.includes(t))
}

function splitRoleTokens(role: string): string[] {
  return role
    .replace(/\*\*/g, '')
    .split(/[+＋/、,，\s]+/)
    .map((x) => x.replace(/[×x]\s*\d+$/i, '').trim().toLowerCase())
    .filter((x) => x !== '')
}

function registrationFor(
  taskRole: string,
  dispatch: readonly RuntimeDispatchEntry[],
): RuntimeDispatchEntry | undefined {
  return dispatch.find((d) => roleMatches(taskRole, d.role))
}

/** 表格行切分（容忍 `\|` 转义；去首尾空管道）。 */
function splitRow(line: string): string[] {
  const body = line.replace(/^\|/, '').replace(/\|$/, '')
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function statSafe(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

async function readDirSafe(path: string): Promise<string[] | null> {
  try {
    return await readdir(path)
  } catch {
    return null
  }
}

/* ===== 任务契约解析（dag.json 节点上的可选扩展键） ===== */

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '') : []

function objArr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : []
}

/**
 * 从 dag 节点读结构化契约。**缺键一律回落默认值**（向后兼容旧 dag.json：
 * 老数据只有 id/label/role/status/deps，照样能看）。
 */
export function parseTaskContract(raw: Record<string, unknown>): TaskContract {
  const kindRaw = str(raw['kind']).trim().toLowerCase()
  const kind: TaskKind = (TASK_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as TaskKind) : 'work'
  const attemptRaw = raw['attempt']
  return {
    kind,
    objective: str(raw['objective']),
    acceptance: strArr(raw['acceptance']),
    inScope: strArr(raw['inScope']),
    outOfScope: strArr(raw['outOfScope']),
    verify: strArr(raw['verify']),
    reviewedTaskId: str(raw['reviewedTaskId']),
    verdict: str(raw['verdict']),
    findings: objArr(raw['findings']).map((f) => ({ severity: str(f['severity']), text: str(f['text']) })),
    acceptanceResults: objArr(raw['acceptanceResults']).map((r) => ({
      acceptance: str(r['acceptance']),
      status: str(r['status']),
      ...(typeof r['evidence'] === 'string' ? { evidence: r['evidence'] } : {}),
    })),
    commandsRun: objArr(raw['commandsRun']).map((r) => ({
      command: str(r['command']),
      status: str(r['status']),
      ...(typeof r['output'] === 'string' ? { output: r['output'] } : {}),
    })),
    changedPaths: strArr(raw['changedPaths']),
    attempt: typeof attemptRaw === 'number' && Number.isFinite(attemptRaw) ? attemptRaw : null,
  }
}
