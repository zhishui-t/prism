/**
 * 落库入口（design-v4 F-E2）：**MCP / HTTP / CLI 三入口共用同一团队沉淀策略**。
 *
 * 抽自 `mcp/server.ts:402-437`（此前是唯一调用点）：策略执行只有一处，
 * 「三入口同策略同结果」才可判定、可测试；HTTP/MCP 只负责取参 + 信封。
 *
 * 边界（红线 R3）：Prism **不做审核**——策略只做团队声明的机械校验（enabled /
 * require_note / 默认值 / rules 覆盖），规则对错由团队定义负责。
 */

import { PrismError } from '@prism/core'
import { applyDepositPolicy, type TeamDefinition } from '@prism/agents'

import type { DepositInput, DepositResult, KnowledgeService } from './port.js'

/** 落库请求：`DepositInput` + 团队策略开关（`team_id` 只用于选策略，不落库）。 */
export type DepositRequest = DepositInput & { team_id?: string }

export interface DepositEntryDeps {
  /** 知识服务（HTTP 传 `getKb`、MCP 传惰性 `kb()`） */
  kb: () => Promise<KnowledgeService>
  /** 按 team_id 取团队定义；不存在 → 抛错（错误码/文案由调用方决定） */
  loadTeam: (teamId: string) => Promise<TeamDefinition>
}

/**
 * 落库（带可选团队策略）：
 * - `team_id` 缺省/空 → 直传落库，**与改动前逐字节一致**；
 * - `team_id` 有值 → `applyDepositPolicy` 机械校验 + 默认值 + rules 覆盖；
 *   被拒 → `PrismError('bad_request')`（HTTP 400 信封；MCP 转 JSON-RPC 错误）。
 */
export async function depositWithPolicy(
  deps: DepositEntryDeps,
  raw: DepositRequest,
): Promise<DepositResult> {
  const kb = await deps.kb()
  const teamId = raw.team_id
  if (teamId === undefined || teamId === '') {
    return await kb.deposit(raw)
  }

  const team = await deps.loadTeam(teamId)
  const outcome = applyDepositPolicy(team.deposit, {
    title: raw.title,
    type: raw.type,
    layer: raw.layer,
    book: raw.book,
    content: raw.content,
    ...(raw.owner !== undefined ? { owner: raw.owner } : {}),
    ...(raw.module !== undefined ? { module: raw.module } : {}),
    ...(raw.tags !== undefined ? { tags: raw.tags } : {}),
    ...(raw.risk !== undefined ? { risk: raw.risk } : {}),
    ...(raw.source !== undefined ? { source: raw.source } : {}),
    ...(raw.origin_task !== undefined ? { origin_task: raw.origin_task } : {}),
    ...(raw.deposited_by !== undefined ? { deposited_by: raw.deposited_by } : {}),
  })
  if (!outcome.allowed) {
    throw new PrismError('bad_request', `沉淀策略拒绝：${outcome.errors.join('；')}`)
  }
  const p = outcome.input
  return await kb.deposit({
    title: p.title,
    type: p.type as DepositInput['type'],
    layer: p.layer as DepositInput['layer'],
    book: p.book,
    content: p.content,
    ...(p.owner !== undefined ? { owner: p.owner } : {}),
    ...(p.module !== undefined ? { module: p.module } : {}),
    ...(p.tags !== undefined ? { tags: p.tags } : {}),
    ...(p.risk !== undefined ? { risk: p.risk as DepositInput['risk'] } : {}),
    ...(p.source !== undefined ? { source: p.source } : {}),
    ...(p.origin_task !== undefined ? { origin_task: p.origin_task } : {}),
    ...(p.visibility !== undefined ? { visibility: p.visibility as DepositInput['visibility'] } : {}),
    ...(raw.confidence !== undefined ? { confidence: raw.confidence } : {}),
    ...(raw.overrides !== undefined ? { overrides: raw.overrides } : {}),
    ...(raw.deposited_by !== undefined ? { deposited_by: raw.deposited_by } : {}),
  })
}
