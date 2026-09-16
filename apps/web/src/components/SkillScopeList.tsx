/**
 * Skill **生效层 / 有效集** 公共零件（brief-A §4.3 S1/S2/S8）。
 *
 * 「层」= **谁指定了它**（不是技能本身分层，见 S2 / `people.ts` 的服务端裁决）：
 * 全局（已装但无声明者）/ 团队 / 角色。skills 详情与 teams 详情共用本组件，
 * 避免「同一个层级概念两页两种表达」。
 *
 * 零依赖（只用 Ref + i18n），文案全走字典（禁止模板串拼 key）。
 */

import type { ReactNode } from 'react'

import type { EffectiveSkill } from '../api-team.ts'
import { Ref } from './ref.tsx'
import { useT, type DictKey } from '../i18n.ts'

export type Scope = 'global' | 'team' | 'role'

/** 来源分组顺序（与 F-D1 合并顺序一致：global → team → role）。 */
export const SOURCE_ORDER: readonly Scope[] = ['global', 'team', 'role']

/** 来源标签的字典键（静态键：禁止模板串拼 key，否则死键脚本无法判定）。 */
export const SOURCE_LABEL: Record<Scope, DictKey> = {
  global: 'skills.scope.global',
  team: 'skills.scope.team',
  role: 'skills.scope.role',
}

/**
 * **生效层三行**（单个技能的视角）：全局 = 已装到宿主；团队 / 角色 = 谁声明了它。
 * 每行都是可点 `<Ref>`，空层不给行（由调用方决定是否给出路）。
 */
export function ScopeLayerRows({
  installed,
  teams,
  roles,
}: {
  installed: boolean
  teams: string[]
  roles: string[]
}) {
  const t = useT()
  return (
    <div className="scope-rows">
      <ScopeRow label={t('skills.scope.global')} count={installed ? 1 : 0}>
        {installed ? (
          <span className="muted small">{t('skills.scope.installed')}</span>
        ) : (
          <span className="muted small">{t('skills.scope.notInstalled')}</span>
        )}
      </ScopeRow>
      <ScopeRow label={t('skills.scope.team')} count={teams.length}>
        {teams.length === 0 ? (
          <span className="muted small">{t('skills.scope.none')}</span>
        ) : (
          teams.map((id) => <Ref key={id} kind="team" name={id} />)
        )}
      </ScopeRow>
      <ScopeRow label={t('skills.scope.role')} count={roles.length}>
        {roles.length === 0 ? (
          <span className="muted small">{t('skills.scope.none')}</span>
        ) : (
          roles.map((name) => <Ref key={name} kind="role" name={name} />)
        )}
      </ScopeRow>
    </div>
  )
}

function ScopeRow({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  return (
    <div className="scope-row">
      <span className="scope-label">{label}</span>
      <span className="scope-leader" />
      <span className="scope-count">{count}</span>
      <span className="scope-body">{children}</span>
    </div>
  )
}

/**
 * **有效集列表**（正向视图）：按主来源分组渲染 `EffectiveSkill[]`，
 * 同名只出现一次、多来源挂多枚标签；未装行给 lamp + 可复制命令（S4）。
 *
 * **组折叠（R-v8-7）**：`foldedSources` 列出的来源组改用 `<details>` 承载（**默认收起**），
 * 组头沿用既有的 `.rsec-label`（放进 `<summary>`，计数 `{label}（{n}）` 常驻，收起也知道有几条）。
 * 未列出的组**结构一字不变**（`<div>` + `.rsec-label` + 行）——技能页 `EffectiveSkills` 是既有
 * 消费方，本参数不传即零变更，折叠只是团队页「防全局技能罗列」的收窄手段。
 */
export function SkillScopeList({
  skills,
  note,
  foldedSources = [],
}: {
  skills: EffectiveSkill[]
  /** 可选的逐行补充（团队有效集用来标注「由哪些成员角色带进来」）。 */
  note?: (s: EffectiveSkill) => React.ReactNode
  /** 默认**收起**的来源组（团队页只给 `global`，见 R-v8-7）。 */
  foldedSources?: readonly Scope[]
}) {
  const t = useT()
  const notInstalled = skills.filter((s) => !s.available)
  const groups = SOURCE_ORDER.map((source) => ({
    source,
    items: skills.filter((s) => (s.sources[0] ?? 'global') === source),
  })).filter((g) => g.items.length > 0)

  if (skills.length === 0) return <div className="rsec-empty">{t('skills.effective.none')}</div>

  return (
    <>
      <div className="row small muted" style={{ gap: 'var(--s-2)', marginBottom: 'var(--s-2)' }}>
        <span>
          {t('common.installed')} {skills.length - notInstalled.length} / {t('common.notInstalled')}{' '}
          {notInstalled.length}
        </span>
        {notInstalled.length === 0 && <span className="tag">{t('skills.effective.allInstalled')}</span>}
      </div>
      <div className="scope-groups">
        {groups.map((g) => {
          const label = t('skills.effective.groupCount', { label: t(SOURCE_LABEL[g.source]), n: g.items.length })
          const items = g.items.map((s) => (
            <div key={s.name} className={`scope-item${s.available ? '' : ' missing'}`}>
              <Ref kind="skill" name={s.name} />
              {s.sources.map((src) => (
                <span key={src} className="tag">{t(SOURCE_LABEL[src])}</span>
              ))}
              <span className="scope-count">{s.available ? t('common.installed') : t('common.notInstalled')}</span>
              {note !== undefined && note(s)}
              {!s.available && <span className="scope-lamp" />}
              {!s.available && (
                <div className="scope-cmd">
                  {t('skills.effective.hostNotInstalled')}
                  <span className="mono">prism skill install {s.name}</span>
                </div>
              )}
            </div>
          ))
          // 折叠组：`<details>` 原生展开态（无 `open` = 默认收起），组头即 `summary`。
          if (foldedSources.includes(g.source)) {
            return (
              <details key={g.source} className="scope-group">
                <summary className="rsec-label">{label}</summary>
                {items}
              </details>
            )
          }
          return (
            <div key={g.source}>
              <div className="rsec-label">{label}</div>
              {items}
            </div>
          )
        })}
      </div>
    </>
  )
}
