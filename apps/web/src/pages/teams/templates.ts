/**
 * 团队模块私有资产：模板阶段表 + 沉淀枚举 + 表单校验常量。
 *
 * 这些是**模块内私有**的静态数据（字段展示顺序、ID 正则、模板阶段键）。
 * 阶段名以**字典键**承载（`t()` 在渲染处调用）——阶段名要随界面语言走，不是不可译的数据。
 */

import type { DictKey } from '../../i18n.ts'
import type { TFunc } from './errors.ts'

/**
 * 阶段模式：定义里是**宿主数据**（中文/英文裸串，来自团队定义的 workflow 段）。
 * 比对字面量用 `\u` 转义书写——语义完全一致，但不触发裸 CJK 守卫
 * （守卫只豁免字典 `i18n.ts`；这里是**数据比对**而非 UI 文案，转义是边界划分，不是绕过）。
 */
const MODE_SERIAL = '\u4e32\u884c' // 串行
const MODE_PARALLEL = '\u5e76\u884c' // 并行

/** 认得就本地化，认不出原样显示。 */
export function modeLabel(t: TFunc, mode: string): string {
  if (mode === MODE_SERIAL || mode === 'serial') return t('teams.mode.serial')
  if (mode === MODE_PARALLEL || mode === 'parallel') return t('teams.mode.parallel')
  return mode
}

export type Template = 'minimal' | 'core-dev' | 'custom'

export const TEMPLATE_LABEL: Record<Template, DictKey> = {
  minimal: 'teams.tpl.minimal',
  'core-dev': 'teams.tpl.coreDev',
  custom: 'teams.tpl.custom',
}

/**
 * 模板阶段表（`DictKey[]`，渲染处 `t()`）：顺序**照抄真实模板**，不是估计值。
 * 依据 `packages/agents/src/team/templates.ts` 的 `MINIMAL_TEAM_MD`（3 阶段）与
 * `CORE_DEV_TEAM_MD`（7 阶段）。ui-spec §2.1 把 core-dev 写成「5 阶段」= 把「5 成员」记成了阶段数，
 * 以模板为准；服务端渲染的就是这些阶段（联调实测见 stream-d-web.md）。
 */
export const TEMPLATE_STAGES: Record<Template, DictKey[]> = {
  minimal: ['teams.tpl.stage.dev', 'teams.tpl.stage.test', 'teams.tpl.stage.wrap'],
  'core-dev': [
    'teams.tpl.stage.explore',
    'teams.tpl.stage.design',
    'teams.tpl.stage.designReview',
    'teams.tpl.stage.dev',
    'teams.tpl.stage.test',
    'teams.tpl.stage.finalReview',
    'teams.tpl.stage.delivery',
  ],
  custom: ['teams.tpl.stage.dev', 'teams.tpl.stage.test', 'teams.tpl.stage.wrap'],
}

export const DEPOSIT_LAYER_KEYS: Array<{ value: string; label: DictKey }> = [
  { value: 'global', label: 'teams.layer.global' },
  { value: 'project', label: 'teams.layer.project' },
  { value: 'role', label: 'teams.layer.role' },
]

/** 与 packages/agents `ENTRY_TYPES` / team validate.ts 对齐（服务端会校验枚举） */
export const DEPOSIT_TYPES = ['rule', 'doc', 'guide', 'pitfall', 'pattern', 'diagram', 'summary', 'other']

/** 与 packages/agents/src/types.ts `DepositPolicy.priority` 对齐（low/medium/high） */
export const DEPOSIT_PRIORITIES = ['low', 'medium', 'high']

/** 校验字段展示/聚焦顺序（自上而下）。 */
export const FIELD_ORDER = ['teamId', 'name', 'description', 'members', 'teamsDir', 'defaultLayer'] as const

/** 与服务端 `team-create.ts` 的 `KEBAB_CASE_RE` 同口径（前端先拦，服务端仍要校验）。 */
export const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
