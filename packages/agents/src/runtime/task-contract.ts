/**
 * 任务契约的**机械可判定**部分（纯函数，零 IO）。
 *
 * 借鉴 `dsh-agent-teams` 的质量门禁设计（2026-10-26 调研），但只取**校验**、不取**调度**：
 * 那边在宿主进程内派活（`ctx.subagents`），Prism 守 R1 不碰；「完成的判定能不能被机器核」
 * 则是控制面该干的活——它直接回答「测试结果是不是在忽悠人」。
 *
 * 一套契约字段（`dag.json` 节点上的可选键，全部向后兼容）：
 *
 * ```jsonc
 * {
 *   "id": "v19_2",
 *   "label": "实现编辑域",
 *   "role": "dev",
 *   "status": "done",
 *   "deps": ["v19_1"],
 *   "kind": "implementation",        // work | requirements | implementation | verification | review | repair | integration
 *   "objective": "……",               // 目标（结构化任务必填）
 *   "acceptance": ["……"],            // 验收项（结构化任务必填 ≥1）
 *   "inScope": ["packages/agents"],  // 写域（implementation/repair 必填）
 *   "outOfScope": ["apps/web"],      // 显式排除（优先级高于 inScope）
 *   "verify": ["pnpm typecheck"],    // 必跑的验证命令（implementation/repair/verification 必填）
 *   "reviewedTaskId": "v19_2",       // review 专用：被审任务
 *   "verdict": "pass",               // review 结论：pass | needs_revision | reject
 *   "findings": [{ "severity": "high", "text": "……" }],
 *   "acceptanceResults": [{ "acceptance": "……", "status": "pass", "evidence": "……" }],
 *   "commandsRun": [{ "command": "pnpm typecheck", "status": "pass" }],
 *   "changedPaths": ["packages/agents/src/runtime/blackboard.ts"],
 *   "attempt": 1
 * }
 * ```
 *
 * 判定口径（与插件同构，适配 Prism 的四态）：
 * - **完成必须有证据**：`done` 的 implementation/repair/verification 要 `acceptanceResults`
 *   覆盖每一条 acceptance 且全 pass、`commandsRun` 覆盖每一条 verify 且全 pass；
 * - **review 只能以 pass 结案**：`needs_revision`/`reject` 必须不是 `done`，且至少一条 finding；
 * - **写域可审计**：`changedPaths` 必须落在 `inScope` 内、不碰 `outOfScope` 与默认排除项
 *   （绝对路径与 `..` 逃逸一律拒绝）；这是**完成时审计**，不是写盘拦截；
 * - **并行写域冲突**：同时可派发的任务若 `inScope` 重叠 → warning（会互相踩文件）。
 */

/** 任务种类：`work` 是自由文本完成的旧形态，其余走结构化契约。 */
export type TaskKind =
  | 'work'
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'

export const TASK_KINDS: readonly TaskKind[] = [
  'work',
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
]

export interface TaskFinding {
  severity: string
  text: string
}

export interface TaskAcceptanceResult {
  /** 对应 `acceptance` 的那一条原文。 */
  acceptance: string
  status: string
  evidence?: string
}

export interface TaskCommandRun {
  command: string
  status: string
  output?: string
}

/** 结构化契约（`work` 也可以带，但只做展示不做强制）。 */
export interface TaskContract {
  kind: TaskKind
  objective: string
  acceptance: string[]
  inScope: string[]
  outOfScope: string[]
  verify: string[]
  reviewedTaskId: string
  verdict: string
  findings: TaskFinding[]
  acceptanceResults: TaskAcceptanceResult[]
  commandsRun: TaskCommandRun[]
  changedPaths: string[]
  attempt: number | null
}

export const EMPTY_CONTRACT: TaskContract = {
  kind: 'work',
  objective: '',
  acceptance: [],
  inScope: [],
  outOfScope: [],
  verify: [],
  reviewedTaskId: '',
  verdict: '',
  findings: [],
  acceptanceResults: [],
  commandsRun: [],
  changedPaths: [],
  attempt: null,
}

/** 契约问题（与运行时缺口同形，便于合并展示）。 */
export interface ContractIssue {
  level: 'error' | 'warning' | 'info'
  code: string
  message: string
  where?: string
}

/** `dependency` 之外的最小任务投影（避免本模块依赖 blackboard 的完整类型）。 */
export interface ContractTaskView {
  id: string
  label: string
  status: 'done' | 'running' | 'pending' | 'blocked' | 'failed'
  ready: boolean
  contract: TaskContract
}

/* ===== 写域匹配（纯函数） ===== */

/** 默认硬排除（即使没写进 outOfScope 也不许动）。 */
export const DEFAULT_EXCLUDED_PREFIXES: readonly string[] = ['.git/', 'node_modules/']
export const DEFAULT_EXCLUDED_FILES: readonly string[] = ['.env']
export const DEFAULT_EXCLUDED_SUFFIXES: readonly string[] = ['.pem', '.key']

/**
 * 相对路径归一：拒绝绝对路径与 `..` 逃逸（Windows 盘符、UNC、POSIX 绝对、`~` 都算绝对）。
 * 返回 null = 非法。
 */
export function normalizeRelPath(path: string): string | null {
  const p = path.trim().replace(/\\/g, '/')
  if (p === '') return null
  if (p.startsWith('/') || p.startsWith('~')) return null
  if (/^[A-Za-z]:/.test(p)) return null
  const parts = p.split('/')
  if (parts.some((s) => s === '..')) return null
  const norm = parts.filter((s) => s !== '' && s !== '.').join('/')
  return norm === '' ? null : norm
}

/** 是否命中默认硬排除。 */
export function isDefaultExcluded(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  if (DEFAULT_EXCLUDED_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))) return true
  if (DEFAULT_EXCLUDED_FILES.some((f) => p === f || p.startsWith(`${f}/`))) return true
  if (p.startsWith('.env.') || p.includes('/.env.') || p.endsWith('/.env')) return true
  return DEFAULT_EXCLUDED_SUFFIXES.some((suffix) => p.toLowerCase().endsWith(suffix))
}

/** 路径是否落在某条写域声明内（整文件相等，或目录前缀）。 */
export function pathInScope(path: string, scope: string): boolean {
  const p = normalizeRelPath(path)
  const s = normalizeRelPath(scope)
  if (p === null || s === null) return false
  return p === s || p.startsWith(`${s}/`)
}

export interface ScopeAudit {
  ok: boolean
  /** 越界 / 被排除的路径及原因。 */
  violations: Array<{ path: string; reason: string }>
}

/**
 * 改动路径审计：`outOfScope` 优先于 `inScope`；默认排除项无条件拒绝；
 * 未声明 `inScope` 时按「无写域声明」处理（implementation/repair 由契约必填项拦）。
 */
export function auditChangedPaths(
  changedPaths: readonly string[],
  inScope: readonly string[],
  outOfScope: readonly string[],
): ScopeAudit {
  const violations: Array<{ path: string; reason: string }> = []
  for (const raw of changedPaths) {
    const path = normalizeRelPath(raw)
    if (path === null) {
      violations.push({ path: raw, reason: '不是项目内的相对路径（绝对路径 / .. 逃逸 / 空）' })
      continue
    }
    if (isDefaultExcluded(path)) {
      violations.push({ path, reason: '命中默认排除项（.git / node_modules / .env / 密钥）' })
      continue
    }
    const ex = outOfScope.find((s) => pathInScope(path, s))
    if (ex !== undefined) {
      violations.push({ path, reason: `显式排除于 outOfScope: ${ex}` })
      continue
    }
    if (inScope.length === 0) {
      violations.push({ path, reason: '任务未声明 inScope（写域未知，无法判定是否越界）' })
      continue
    }
    if (!inScope.some((s) => pathInScope(path, s))) {
      violations.push({ path, reason: '不在声明的 inScope 内' })
    }
  }
  return { ok: violations.length === 0, violations }
}

/* ===== 契约校验 ===== */

/** 需要写域的 kind。 */
const NEEDS_SCOPE: ReadonlySet<TaskKind> = new Set(['implementation', 'repair'])
/** 需要 verify 命令的 kind。 */
const NEEDS_VERIFY: ReadonlySet<TaskKind> = new Set(['implementation', 'repair', 'verification'])
/** 需要结构化契约（objective + acceptance）的 kind。 */
const NEEDS_CONTRACT: ReadonlySet<TaskKind> = new Set([
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
])

/** 一条 acceptance / verify 是否被证据覆盖。 */
function covers(items: readonly string[], results: readonly { acceptance?: string; command?: string; status: string }[]): {
  missing: string[]
  failed: string[]
} {
  const missing: string[] = []
  const failed: string[] = []
  for (const item of items) {
    const hit = results.filter((r) => (r.acceptance ?? r.command ?? '').trim() === item.trim())
    if (hit.length === 0) {
      missing.push(item)
      continue
    }
    if (!hit.some((r) => r.status.trim().toLowerCase() === 'pass')) failed.push(item)
  }
  return { missing, failed }
}

/**
 * 校验单个任务的契约与完成证据。
 *
 * @param task 任务投影（含解析好的 contract）
 */
export function validateTaskContract(task: ContractTaskView): ContractIssue[] {
  const issues: ContractIssue[] = []
  const c = task.contract
  const where = `dag.json · ${task.id}`
  const done = task.status === 'done'

  // kind 非法
  if (!TASK_KINDS.includes(c.kind)) {
    issues.push({
      level: 'warning',
      code: 'task_kind_unknown',
      message: `任务「${task.label}」的 kind 未知（${c.kind}）——按 work 处理`,
      where,
    })
  }

  // 结构化任务的结构要求
  if (NEEDS_CONTRACT.has(c.kind)) {
    if (c.objective.trim() === '') {
      issues.push({
        level: 'error',
        code: 'task_contract_objective_required',
        message: `任务「${task.label}」（${c.kind}）缺少 objective`,
        where,
      })
    }
    if (c.acceptance.length === 0) {
      issues.push({
        level: 'error',
        code: 'task_contract_acceptance_required',
        message: `任务「${task.label}」（${c.kind}）缺少 acceptance（至少一条验收项）`,
        where,
      })
    }
  }
  if (NEEDS_SCOPE.has(c.kind) && c.inScope.length === 0) {
    issues.push({
      level: 'error',
      code: 'task_contract_scope_required',
      message: `任务「${task.label}」（${c.kind}）缺少 inScope（没有写域就无法审计越界）`,
      where,
    })
  }
  if (NEEDS_VERIFY.has(c.kind) && c.verify.length === 0) {
    issues.push({
      level: 'error',
      code: 'task_contract_verify_required',
      message: `任务「${task.label}」（${c.kind}）缺少 verify（没有验证命令就无法证明完成）`,
      where,
    })
  }
  if (c.kind === 'review' && c.reviewedTaskId.trim() === '') {
    issues.push({
      level: 'error',
      code: 'task_review_target_required',
      message: `任务「${task.label}」是 review 但缺少 reviewedTaskId（审的是哪个任务？）`,
      where,
    })
  }

  // 完成证据（只对已完成的实现类任务较真）
  if (done) {
    if (c.kind === 'implementation' || c.kind === 'repair' || c.kind === 'verification') {
      const acc = covers(c.acceptance, c.acceptanceResults)
      if (acc.missing.length > 0) {
        issues.push({
          level: 'error',
          code: 'task_acceptance_unproven',
          message: `任务「${task.label}」已标完成，但验收项没有结果：${acc.missing.join('；')}`,
          where,
        })
      }
      if (acc.failed.length > 0) {
        issues.push({
          level: 'error',
          code: 'task_acceptance_failed',
          message: `任务「${task.label}」已标完成，但验收项未通过：${acc.failed.join('；')}`,
          where,
        })
      }
      // verify 用 command 字段做匹配（acceptance 用 acceptance 字段）
      const verifyMissing = c.verify.filter(
        (v) => !c.commandsRun.some((r) => r.command.trim() === v.trim()),
      )
      const verifyFailed = c.verify.filter((v) => {
        const hit = c.commandsRun.filter((r) => r.command.trim() === v.trim())
        return hit.length > 0 && !hit.some((r) => r.status.trim().toLowerCase() === 'pass')
      })
      if (verifyMissing.length > 0) {
        issues.push({
          level: 'error',
          code: 'task_verify_unproven',
          message: `任务「${task.label}」已标完成，但验证命令没跑：${verifyMissing.join('；')}`,
          where,
        })
      }
      if (verifyFailed.length > 0) {
        issues.push({
          level: 'error',
          code: 'task_verify_failed',
          message: `任务「${task.label}」已标完成，但验证命令未通过：${verifyFailed.join('；')}`,
          where,
        })
      }
      if (NEEDS_SCOPE.has(c.kind) && c.changedPaths.length === 0) {
        issues.push({
          level: 'error',
          code: 'task_changed_paths_required',
          message: `任务「${task.label}」已标完成，但没有 changedPaths（改了什么？）`,
          where,
        })
      }
    }
    if (c.kind === 'review') {
      const verdict = c.verdict.trim().toLowerCase()
      if (verdict !== 'pass') {
        issues.push({
          level: 'error',
          code: 'task_review_not_pass',
          message: `任务「${task.label}」是 review 且已标完成，但 verdict=${verdict === '' ? '空' : c.verdict}（只有 pass 能以完成结案）`,
          where,
        })
      }
    }
  }

  // review 的非 pass 结论必须留下 finding
  if (c.kind === 'review') {
    const verdict = c.verdict.trim().toLowerCase()
    if ((verdict === 'needs_revision' || verdict === 'reject') && c.findings.length === 0) {
      issues.push({
        level: 'error',
        code: 'task_review_findings_required',
        message: `任务「${task.label}」结论为 ${c.verdict}，但没有任何 finding（打回必须说清问题）`,
        where,
      })
    }
  }

  // 写域审计
  if (c.changedPaths.length > 0) {
    const audit = auditChangedPaths(c.changedPaths, c.inScope, c.outOfScope)
    for (const v of audit.violations) {
      issues.push({
        level: 'error',
        code: 'task_scope_violation',
        message: `任务「${task.label}」改动了写域外的文件 ${v.path}：${v.reason}`,
        where,
      })
    }
  }

  return issues
}

/**
 * 并行写域冲突：同时**可派发**（ready）的任务，`inScope` 有重叠就会互相踩文件。
 * 这是「派发质量」的直接检查——比事后发现冲突便宜得多。
 */
export function detectReadyScopeCollisions(tasks: readonly ContractTaskView[]): ContractIssue[] {
  const issues: ContractIssue[] = []
  const ready = tasks.filter((t) => t.ready)
  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      const a = ready[i]!
      const b = ready[j]!
      const overlap = a.contract.inScope.filter((sa) =>
        b.contract.inScope.some((sb) => {
          const na = normalizeRelPath(sa)
          const nb = normalizeRelPath(sb)
          if (na === null || nb === null) return false
          return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)
        }),
      )
      if (overlap.length > 0) {
        issues.push({
          level: 'warning',
          code: 'task_scope_collision',
          message: `可派发任务「${a.label}」与「${b.label}」写域重叠（${overlap.join(', ')}）——并行派发会互相踩文件，加依赖串行化或拆写域`,
          where: `dag.json · ${a.id} / ${b.id}`,
        })
      }
    }
  }
  return issues
}

/** 交付门禁：全部完成 + 所有 review pass + 无失败 + 验收全有证据。 */
export interface DeliveryGate {
  ok: boolean
  blockers: ContractIssue[]
}

export function evaluateDeliveryGate(tasks: readonly ContractTaskView[]): DeliveryGate {
  const blockers: ContractIssue[] = []
  if (tasks.length === 0) return { ok: false, blockers: [] }

  const unfinished = tasks.filter((t) => t.status !== 'done')
  if (unfinished.length > 0) {
    blockers.push({
      level: 'error',
      code: 'gate_unfinished_tasks',
      message: `还有 ${unfinished.length} 个任务未完成：${unfinished.map((t) => t.id).join(', ')}`,
      where: 'dag.json',
    })
  }
  const failed = tasks.filter((t) => t.status === 'failed')
  if (failed.length > 0) {
    blockers.push({
      level: 'error',
      code: 'gate_failed_tasks',
      message: `存在失败任务：${failed.map((t) => t.id).join(', ')}`,
      where: 'dag.json',
    })
  }
  const badReview = tasks.filter(
    (t) => t.contract.kind === 'review' && t.contract.verdict.trim().toLowerCase() !== '' &&
      t.contract.verdict.trim().toLowerCase() !== 'pass',
  )
  if (badReview.length > 0) {
    blockers.push({
      level: 'error',
      code: 'gate_review_not_pass',
      message: `存在未通过的审核结论：${badReview.map((t) => `${t.id}=${t.contract.verdict}`).join(', ')}`,
      where: 'dag.json',
    })
  }
  return { ok: blockers.length === 0, blockers }
}
