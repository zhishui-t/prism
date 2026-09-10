/**
 * `prism task`（task-center.md §4）：被动台账的命令行面。
 *
 * Prism 不驱动任务——宿主/队长登记 DAG、回报状态，Prism 只记录、可视化、审计。
 */
import { AuditLog, prismPaths, openPersistence, TaskLedger, isPrismError, type TaskStatus } from '@prism/core'
import { loadTeam } from '@prism/server'
import { readFile } from 'node:fs/promises'

import type { ArgValues, CommandContext } from '../argv.js'
import { resolveTargetDirs } from '../argv.js'
import { runKbDeposit } from './kb.js'

/** 组装台账（每次命令独立打开持久化，随命令结束关闭）。 */
function makeLedger(ctx: CommandContext): { ledger: TaskLedger; close: () => void } {
  const persistence = ctx.persistence ?? openPersistence({ home: ctx.home })
  return {
    ledger: new TaskLedger({
      persistence,
      audit: new AuditLog({ dir: prismPaths(ctx.home).auditDir, queue: persistence.queue }),
    }),
    close: () => {
      if (ctx.persistence === undefined) persistence.close()
    },
  }
}

/** `prism task <list|show|graph|register|report|stats> ...`。 */
export async function runTask(ctx: CommandContext, args: string[], values: ArgValues): Promise<number> {
  const [sub, ...rest] = args
  const { ledger, close } = makeLedger(ctx)
  try {
    switch (sub) {
      case 'list':
        return await taskList(ctx, ledger, values)
      case 'show':
        return await taskShow(ctx, ledger, rest)
      case 'graph':
        return await taskGraph(ctx, ledger, rest)
      case 'register':
        return await taskRegister(ctx, ledger, rest, values)
      case 'report':
        return await taskReport(ctx, ledger, rest, values)
      case 'stats':
        return await taskStats(ctx, ledger)
      default:
        ctx.stderr(
          `用法: prism task <list|show|graph|register|report|stats> ...\n` +
            `  list [--dag <id>] [--status <S>] [--session <id>]   台账列表\n` +
            `  show <task-id>                                     单任务\n` +
            `  graph <dag-id>                                     依赖图（文本）\n` +
            `  register --dag <id> --session <id> --team <id> --project <id> --dag-version <v> --difficulty <d> --file <dag.json>\n` +
            `  report <task-id> --to <STATUS> --by <who> [--from <STATUS>] [--revision N] [--result <json>] [--error-type <t>]\n` +
            `  stats                                              台账统计`,
        )
        return 1
    }
  } catch (error) {
    if (isPrismError(error)) {
      ctx.stderr(`错误 [${error.code}] ${error.message}`)
      return 1
    }
    throw error
  } finally {
    close()
  }
}

async function taskList(ctx: CommandContext, ledger: TaskLedger, values: ArgValues): Promise<number> {
  const rows = ledger.list({
    ...(values.dag !== undefined ? { dag_id: String(values.dag) } : {}),
    ...(values.status !== undefined ? { status: values.status as TaskStatus } : {}),
    ...(values.session !== undefined ? { session_id: String(values.session) } : {}),
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: rows }))
    return 0
  }
  if (rows.length === 0) {
    ctx.stdout('（台账为空）')
    return 0
  }
  for (const row of rows) {
    ctx.stdout(`${row.status.padEnd(18)} ${row.id}  [${row.dag_id}]  r${row.revision}  ${row.description.slice(0, 40)}`)
  }
  ctx.stdout(`共 ${rows.length} 个任务`)
  return 0
}

async function taskShow(ctx: CommandContext, ledger: TaskLedger, args: string[]): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    ctx.stderr('用法: prism task show <task-id>')
    return 1
  }
  const row = ledger.get(id)
  ctx.stdout(JSON.stringify(ctx.json ? { ok: true, value: row } : row, null, 2))
  return 0
}

async function taskGraph(ctx: CommandContext, ledger: TaskLedger, args: string[]): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    ctx.stderr('用法: prism task graph <dag-id>')
    return 1
  }
  const graph = ledger.dag(id)
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: graph }))
    return 0
  }
  ctx.stdout(`DAG ${graph.dag_id}（${graph.status}）：${graph.tasks.length} 任务 / ${graph.edges.length} 边`)
  for (const task of graph.tasks) {
    const deps = JSON.parse(task.dependencies || '[]') as string[]
    const depText = deps.length > 0 ? `  ← ${deps.join(', ')}` : ''
    ctx.stdout(`  ${task.status.padEnd(18)} ${task.id}${depText}`)
  }
  return 0
}

async function taskRegister(
  ctx: CommandContext,
  ledger: TaskLedger,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const dagId = values.dag ?? args[0]
  if (dagId === undefined || values.file === undefined) {
    ctx.stderr('用法: prism task register --dag <id> --session <id> --team <id> --project <id> --dag-version <v> --difficulty <d> --file <dag.json>')
    return 1
  }
  let parsed: { tasks?: unknown }
  try {
    parsed = JSON.parse(await readFile(String(values.file), 'utf-8')) as { tasks?: unknown }
  } catch (error) {
    ctx.stderr(`错误 [bad_request] 读取 --file 失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const result = await ledger.registerDag({
    dag_id: String(dagId),
    session_id: String(values.session ?? ''),
    team_id: String(values.team ?? ''),
    project_id: String(values.project ?? ''),
    version: String(values['dag-version'] ?? 'v1'),
    difficulty: String(values.difficulty ?? 'normal'),
    tasks: (parsed.tasks ?? []) as never,
  })
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: result }))
  } else {
    ctx.stdout(`已登记 DAG ${result.dag_id}：${result.tasks} 任务 / ${result.edges} 边（被动记录，不触发执行）`)
  }
  return 0
}

async function taskReport(
  ctx: CommandContext,
  ledger: TaskLedger,
  args: string[],
  values: ArgValues,
): Promise<number> {
  const id = args[0]
  if (id === undefined || values.to === undefined) {
    ctx.stderr(
      '用法: prism task report <task-id> --to <STATUS> --by <who> [--from <STATUS>] [--revision N] [--deposit <md|->]',
    )
    return 1
  }
  let result: unknown
  if (values.result !== undefined) {
    try {
      result = JSON.parse(String(values.result))
    } catch (error) {
      ctx.stderr(`错误 [bad_request] --result 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
  }
  const row = await ledger.report({
    task_id: id,
    to_status: String(values.to) as TaskStatus,
    by: String(values.by ?? 'cli'),
    ...(values.from !== undefined ? { from_status: String(values.from) as TaskStatus } : {}),
    ...(values.revision !== undefined ? { expected_revision: Number(values.revision) } : {}),
    ...(values['error-type'] !== undefined ? { error_type: String(values['error-type']) } : {}),
    ...(result !== undefined ? { result } : {}),
  })
  // 终态沉淀建议（F-E3 / 裁决 A4）
  const { hint, suggestions } = await depositOutcome(ctx, values, row)
  if (ctx.json) {
    ctx.stdout(
      JSON.stringify({
        ok: true,
        value: {
          ...row,
          ...(hint !== undefined ? { deposit_hint: hint } : {}),
          ...(suggestions !== undefined ? { deposit_suggestions: suggestions } : {}),
        },
      }),
    )
  } else {
    ctx.stdout(`已回报 ${row.id} → ${row.status}（revision ${row.revision}）`)
    if (hint !== undefined) {
      ctx.stdout(`提示: 任务已完成（COMPLETED）—— 待收口（CLOSED）后再沉淀（deposit_hint=${hint}）`)
    }
    if (suggestions !== undefined) {
      ctx.stdout(`建议沉淀（任务 ${row.status}）：`)
      for (const s of suggestions) {
        ctx.stdout(
          `  - ${s.kind.padEnd(9)} layer=${s.layer}  priority=${s.priority}  require_note=${String(s.require_note)}  理由: ${s.reason}`,
        )
      }
      ctx.stdout(
        `一步落库: prism kb deposit --file <md|-> --title <t> --type <kind>${row.team_id !== '' ? ` --team ${row.team_id}` : ''} --task ${row.id}`,
      )
    }
  }

  // 可选一步落库（F-E3）：复用 F-E2 的 CLI 落库路径（同一策略/同一校验）
  if (values.deposit !== undefined) {
    if (!ctx.json) ctx.stdout(`一步落库（--deposit ${values.deposit}）...`)
    return await runKbDeposit(ctx, values, {
      file: String(values.deposit),
      ...(values.title !== undefined ? { title: String(values.title) } : {}),
      ...(values.type !== undefined ? { type: String(values.type) } : {}),
      ...(values.layer !== undefined ? { layer: String(values.layer) } : {}),
      ...(values.owner !== undefined ? { owner: String(values.owner) } : {}),
      ...(values.book !== undefined ? { book: String(values.book) } : {}),
      ...(values.module !== undefined ? { module: String(values.module) } : {}),
      ...(values.tags !== undefined ? { tags: String(values.tags) } : {}),
      ...(row.team_id !== '' ? { teamId: row.team_id } : {}),
      taskId: row.id,
      ...(values.by !== undefined ? { by: String(values.by) } : {}),
      ...(values.note !== undefined ? { note: String(values.note) } : {}),
    })
  }
  return 0
}

/** 沉淀建议（F-E3 / 裁决 A4：**只有 CLOSED 才给清单**）。 */
export interface DepositSuggestion {
  kind: string
  layer: string
  priority: string
  reason: string
  require_note: boolean
}

/** 任务文本关键词 → 沉淀建议的确定性映射（零 LLM；顺序即输出顺序）。 */
const KEYWORD_SUGGESTIONS: ReadonlyArray<{
  pattern: RegExp
  kind: string
  /** 固定层（安全类强制 global）；缺省用团队 default_layer */
  layer?: string
  reason: string
}> = [
  {
    pattern: /安全|security|漏洞|越权|注入/i,
    kind: 'rule',
    layer: 'global',
    reason: '任务阶段/描述命中安全关键词',
  },
  {
    pattern: /坑|陷阱|教训|pitfall|bug|缺陷|故障/i,
    kind: 'pitfall',
    reason: '任务阶段/描述命中踩坑关键词',
  },
  {
    pattern: /性能|performance|延迟|吞吐/i,
    kind: 'pattern',
    reason: '任务阶段/描述命中性能关键词',
  },
]

/**
 * 任务到达终态时的沉淀建议（design-v4 §F-E3）。
 *
 * 口径：
 * - 非终态 / `FAILED` 等 → 什么都不给；
 * - `COMPLETED` → 仅 `deposit_hint: 'await_close'`（**裁决 A4：不给清单**，避免返工后建议过期）；
 * - `CLOSED` → 任务 `team_id` → 团队 `deposit` 规则（`match{...}` 逐条）+ `stage`/`description`
 *   关键词（确定性映射）；无团队 / `deposit.enabled=false` / 既无规则又无关键词命中 → 不返回该字段。
 */
async function depositOutcome(
  ctx: CommandContext,
  values: ArgValues,
  row: { id: string; status: string; team_id: string; stage: string; description: string },
): Promise<{ hint?: 'await_close'; suggestions?: DepositSuggestion[] }> {
  if (row.status === 'COMPLETED') return { hint: 'await_close' }
  if (row.status !== 'CLOSED') return {}

  if (row.team_id === '') return {}
  const dirs = resolveTargetDirs(ctx, values)
  const team = await loadTeam(dirs.teamsDir, row.team_id, { rolesDir: dirs.rolesDir })
  if (team === null || !team.deposit.enabled) return {}

  const deposit = team.deposit
  const suggestions: DepositSuggestion[] = []
  for (const rule of deposit.rules ?? []) {
    const match = Object.entries(rule.match)
      .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join('|') : String(v)}`)
      .join('+')
    suggestions.push({
      kind: typeof rule.set['type'] === 'string' ? rule.set['type'] : deposit.default_type,
      layer: typeof rule.set['layer'] === 'string' ? rule.set['layer'] : deposit.default_layer,
      priority: typeof rule.set['priority'] === 'string' ? rule.set['priority'] : deposit.priority,
      reason: `团队规则 match{${match}}`,
      require_note: deposit.require_note,
    })
  }

  const text = `${row.stage} ${row.description}`
  for (const kw of KEYWORD_SUGGESTIONS) {
    if (!kw.pattern.test(text)) continue
    const kind = kw.kind
    const layer = kw.layer ?? deposit.default_layer
    if (suggestions.some((s) => s.kind === kind && s.layer === layer && s.reason === kw.reason)) continue
    suggestions.push({
      kind,
      layer,
      priority: kw.layer === 'global' ? 'high' : deposit.priority,
      reason: kw.reason,
      require_note: deposit.require_note,
    })
  }

  return suggestions.length > 0 ? { suggestions } : {}
}

async function taskStats(ctx: CommandContext, ledger: TaskLedger): Promise<number> {
  const stats = ledger.stats()
  if (ctx.json) {
    ctx.stdout(JSON.stringify({ ok: true, value: stats }))
    return 0
  }
  ctx.stdout(`任务 ${stats.total} 个，DAG ${stats.dags} 个`)
  for (const [status, count] of Object.entries(stats.by_status).sort()) {
    ctx.stdout(`  ${status.padEnd(20)} ${count}`)
  }
  return 0
}
