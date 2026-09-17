/**
 * 服务端错误码 → 界面文案（未列出的 code 一律走通用文案，**不静默**）。
 *
 * 服务端实际形状（读 `packages/server/src/roles/team-create.ts` + `http/routes/people.ts`，非猜测）：
 * - 业务码直接在**信封 code** 上：`id_conflict`（已存在不覆盖）；
 * - 多数校验失败信封 code 是 `bad_request`，**具体码在 message 开头**并以全角冒号分隔：
 *   `teams_dir_required：…` / `team_id_invalid：…` / `members_invalid：…` / `member_role_unknown：…`。
 * ui-spec §2.3 的码表是设计期预填（`role_not_found`/`invalid_members`/`team_exists`），
 * 落地后以服务端为准——两套都认，避免任一侧改动后变成「静默失败」。
 */

import type { DictKey } from '../../i18n.ts'

/** 翻译函数签名（`useT()` 的返回值）。 */
export type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string

export function describeFailure(t: TFunc, raw: string, teamId: string): string {
  const idx = raw.indexOf(': ')
  const envelopeCode = idx === -1 ? '' : raw.slice(0, idx)
  const message = idx === -1 ? raw : raw.slice(idx + 2)

  // 无 code = fetch 抛错或响应不是 JSON（服务未起/代理错误页）
  if (envelopeCode === '') return t('teams.err.connect', { msg: raw })
  // message 开头的具体码（全角/半角冒号都认）
  const detailCode = /^([a-z_]+)\s*[:：]/.exec(message)?.[1] ?? ''
  const code = detailCode !== '' ? detailCode : envelopeCode
  const detail = message.replace(/^[a-z_]+\s*[:：]\s*/, '')

  if (code === 'teams_dir_required') return t('teams.err.dirRequired')
  if (code === 'team_id_invalid') return t('teams.err.idInvalid')
  if (code === 'member_role_unknown' || code === 'role_not_found') {
    const matched = /角色(?:不在角色库中|不存在)\s*[:：]\s*([^\s（(]+)/.exec(detail)
    return t('teams.err.roleUnknown', { role: matched?.[1] ?? '?' })
  }
  if (code === 'members_invalid' || code === 'invalid_members') {
    return t('teams.err.membersInvalid', { msg: detail })
  }
  if (code === 'id_conflict' || code === 'team_exists') return t('teams.err.exists', { id: teamId })
  // v11 F2（R-v11-15）：乐观并发失败——文件在「读到 → 保存」之间被外部改过。
  if (code === 'stale_write') return t('teams.err.stale')
  // v11 F2 写侧契约（design-v11 §3 表：400 三码）。`workflow_invalid` / `if_match_invalid`
  // 落在 **`bad_request` 信封 + message 开头的具体码**（同 `teams_dir_required` 那一档），
  // `workflow_section_missing` 则是独立信封码——两种形态都在上面被 `code` 归一，故此处并列即可。
  if (code === 'workflow_invalid') return t('teams.err.workflowInvalid', { msg: detail })
  if (code === 'if_match_invalid') return t('teams.err.ifMatchInvalid')
  // R-v11-11：服务端**不自动插小节**，故文案必须给出「去文件里补」这一可执行动作，
  // 否则用户只知道存不下去、不知道下一步做什么。
  if (code === 'workflow_section_missing') return t('teams.err.workflowSectionMissing', { id: teamId })
  // bad_request 且无具体码：直接把服务端原因（已含可执行信息）呈现出来
  if (envelopeCode === 'bad_request') return detail
  return t('teams.err.generic', { code, msg: message })
}

/**
 * 是否为「陈旧写」（design-v11 §3 / R-v11-15 的 409 `stale_write`）。
 *
 * 单独抽出来的理由：调用方要按它**分流动作**（给「重新加载」出口，而不是只把文案改个词），
 * 而 code 的解析规则属于本模块（`describeFailure` 刚做过同一件事）——调用方不该自己
 * `startsWith` 猜信封形态。
 */
export function isStaleWrite(raw: string): boolean {
  // 与 `describeFailure` 同款两来源（信封码 + message 开头的具体码），免得一处认得、一处认不得。
  const idx = raw.indexOf(': ')
  const envelope = idx === -1 ? '' : raw.slice(0, idx)
  const message = idx === -1 ? raw : raw.slice(idx + 2)
  const detail = /^([a-z_]+)\s*[:：]/.exec(message)?.[1] ?? ''
  return envelope === 'stale_write' || detail === 'stale_write'
}
