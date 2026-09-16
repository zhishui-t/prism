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
  // bad_request 且无具体码：直接把服务端原因（已含可执行信息）呈现出来
  if (envelopeCode === 'bad_request') return detail
  return t('teams.err.generic', { code, msg: message })
}
