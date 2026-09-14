import { useEffect, useMemo, useRef, useState } from 'react'

import {
  teamApi,
  type DepositPolicy,
  type NewTeamInput,
  type RoleDefinition,
  type TeamActivation,
  type TeamDefinition,
  type TeamMember,
  type UpdateTeamInput,
} from '../api-team.ts'
import { EffectiveSkills } from '../components/EffectiveSkills.tsx'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { Drawer, PageHead, Pane, StatusTag, firstSentence } from '../components/ui.tsx'
import { useT, type DictKey } from '../i18n.ts'

/** 翻译函数签名（`useT()` 的返回值）。 */
type TFunc = (key: DictKey, vars?: Record<string, string | number>) => string

/**
 * 团队页：左列表 + 右详情。
 *
 * 2026-09-14 重构（与角色页同构）。原先是一张 4 列宽表 + 详情堆在表格下方 + 内联「新建团队」
 * 表单直接铺在页面中间（5 段字段、几十个角色步进器）——用户反馈「一堆信息、不知道有什么、没重点」。
 * 现在：
 * - 列表行 = 团队名 + 一句话职责（两行截断）+ 默认/成员数/阶段数标签；
 * - 详情在主从右侧：概览 kv → 工作流**横向阶段流**（一眼看全）→ 成员名册 → 有效 Skill；
 *   阶段明细表按需展开，装配状态在点「启用团队」后才出现；
 * - 新建 / 编辑收进右侧抽屉，删除收进危险区（与角色页一致）。
 */
export function TeamsPage({
  sel,
  onSelect,
  onOpenRole,
  onOpenUsageSkills,
}: {
  /** 当前展开的团队（来自 hash 深链） */
  sel?: string
  onSelect?: (id: string) => void
  /** 成员角色 → 角色详情（正向视图） */
  onOpenRole?: (name: string) => void
  /** 跳到技能页看反向视图 */
  onOpenUsageSkills?: () => void
} = {}) {
  const t = useT()
  const teams = useAsync(() => teamApi.teams(), [])
  const [filter, setFilter] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const selected = sel ?? ''
  const detail = useAsync(
    () => (selected !== '' ? teamApi.team(selected) : Promise.resolve(undefined)),
    [selected],
  )

  // 角色库只在打开表单时拉取（省一次首屏请求）
  const needRoles = formOpen
  const roleIndex = useAsync(
    () =>
      needRoles
        ? teamApi.roles()
        : Promise.resolve({ roles: [] as RoleDefinition[], rolesDir: undefined as string | undefined }),
    [needRoles],
  )

  const list = teams.data?.teams ?? []
  const teamsDir = teams.data?.teamsDir

  /** 写操作统一出口：刷新列表 + 置提示条。 */
  const afterWrite = (kind: 'ok' | 'err', text: string, opts: { close?: boolean } = {}) => {
    setBanner({ kind, text })
    teams.reload()
    detail.reload()
    if (opts.close === true) onSelect?.('')
  }

  useEffect(() => {
    // 列表刷新后，深链指向的团队已不存在 → 收起详情（不留空壳）
    if (selected !== '' && teams.data !== undefined && !list.some((x) => x.team_id === selected)) {
      onSelect?.('')
    }
  }, [teams.data, selected, list, onSelect])

  const keyword = filter.trim().toLowerCase()
  const shown =
    keyword === ''
      ? list
      : list.filter(
          (x) =>
            x.name.toLowerCase().includes(keyword) ||
            x.team_id.toLowerCase().includes(keyword) ||
            x.description.toLowerCase().includes(keyword),
        )

  return (
    <>
      <PageHead title={t('teams.title')} sub={t('teams.desc')}>
        <button
          className="primary"
          onClick={() => {
            setFormOpen(true)
            setBanner(null)
          }}
        >
          {t('teams.new')}
        </button>
      </PageHead>

      {banner !== null && (
        <div className="banner">
          <StatusTag kind={banner.kind === 'ok' ? 'ok' : 'err'}>
            {banner.kind === 'ok' ? t('common.save') : t('status.failed')}
          </StatusTag>
          <span className="small">{banner.text}</span>
        </div>
      )}

      <State
        loading={teams.loading}
        error={teams.error}
        empty={!teams.loading && !teams.error && list.length === 0}
        emptyText={t('teams.empty')}
      >
        <div className="md">
          <div className="md-list">
            <div style={{ padding: '4px 4px 8px' }}>
              <input
                style={{ width: '100%' }}
                placeholder={t('teams.filterPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {shown.length === 0 && (
              <div className="small muted" style={{ padding: '8px 10px' }}>
                {t('common.empty')}
              </div>
            )}
            {shown.map((team) => (
              <button
                key={team.team_id}
                className={`md-row${selected === team.team_id ? ' sel' : ''}`}
                onClick={() => {
                  onSelect?.(team.team_id)
                  setBanner(null)
                }}
              >
                <span className="t">
                  {team.name}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {team.team_id}
                  </span>
                </span>
                {team.description !== '' && <span className="s">{firstSentence(team.description, 76)}</span>}
                <span className="tags">
                  {team.default && <StatusTag kind="ok">{t('teams.default')}</StatusTag>}
                  <StatusTag kind="info">{t('teams.membersCount', { n: team.members.length })}</StatusTag>
                  <StatusTag kind="info">{t('teams.stages', { n: team.workflow.length })}</StatusTag>
                </span>
              </button>
            ))}
          </div>

          <div className="md-detail">
            {selected === '' ? (
              <Pane>
                <div className="small muted">{t('teams.selectHint')}</div>
              </Pane>
            ) : (
              <TeamDetail
                key={selected}
                id={selected}
                detail={detail.data}
                loading={detail.loading}
                error={detail.error}
                teamsDir={teamsDir}
                onOpenRole={onOpenRole}
                onOpenUsage={onOpenUsageSkills}
                onEdit={() => setFormOpen(true)}
                onDeleted={(text) => afterWrite('ok', text, { close: true })}
              />
            )}
          </div>
        </div>
      </State>

      {formOpen && (
        <Drawer
          title={selected !== '' ? `${t('teams.form.edit')} · ${selected}` : t('teams.form.new')}
          onClose={() => setFormOpen(false)}
        >
          {selected !== '' && detail.data !== undefined ? (
            <EditTeamForm
              team={detail.data}
              roles={roleIndex.data?.roles ?? []}
              rolesLoading={roleIndex.loading}
              rolesError={roleIndex.error}
              onReloadRoles={roleIndex.reload}
              rolesDir={roleIndex.data?.rolesDir}
              defaultTeamsDir={teamsDir}
              onCancel={() => setFormOpen(false)}
              onSaved={(text) => {
                setFormOpen(false)
                afterWrite('ok', text)
              }}
              onFailed={(text) => afterWrite('err', text)}
            />
          ) : (
            <NewTeamForm
              roles={roleIndex.data?.roles ?? []}
              rolesLoading={roleIndex.loading}
              rolesError={roleIndex.error}
              onReloadRoles={roleIndex.reload}
              existingIds={list.map((x) => x.team_id)}
              defaultTeamsDir={teamsDir}
              onCancel={() => setFormOpen(false)}
              onCreated={(id, path, warning) => {
                setFormOpen(false)
                afterWrite('ok', `${id} → ${path}${warning === '' ? '' : `\n${warning}`}`)
                onSelect?.(id)
              }}
            />
          )}
        </Drawer>
      )}
    </>
  )
}

/* ==================== 团队详情 ==================== */

function TeamDetail({
  id,
  detail,
  loading,
  error,
  teamsDir,
  onOpenRole,
  onOpenUsage,
  onEdit,
  onDeleted,
}: {
  id: string
  detail: TeamDefinition | undefined
  loading: boolean
  error: string | undefined
  teamsDir: string | undefined
  onOpenRole?: (name: string) => void
  onOpenUsage?: () => void
  onEdit: () => void
  onDeleted: (text: string) => void
}) {
  const t = useT()
  /** 装配状态：只有点过「启用团队」才有——避免把「未装配」误读成「坏了」。 */
  const [activation, setActivation] = useState<TeamActivation | null>(null)
  const [activating, setActivating] = useState(false)
  const [actError, setActError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [delError, setDelError] = useState('')
  /** `null` = 跟随父级给的默认目录；用户动过就固化为自己的值。 */
  const [dirOverride, setDirOverride] = useState<string | null>(null)
  /** 阶段明细表默认收起——阶段流已经回答了「这个团队怎么干活」。 */
  const [showStages, setShowStages] = useState(false)

  const dirValue = dirOverride ?? teamsDir ?? ''
  const effectiveDir = dirValue.trim()

  useEffect(() => {
    setConfirming(false)
    setDelError('')
  }, [id])

  const onActivate = async () => {
    setActivating(true)
    setActError('')
    setActivation(null)
    try {
      setActivation(await teamApi.activate(id))
    } catch (e) {
      setActError(e instanceof Error ? e.message : String(e))
    } finally {
      setActivating(false)
    }
  }

  const onDelete = async () => {
    if (effectiveDir === '') {
      setDelError(t('teams.v.dirRequired'))
      return
    }
    setDeleting(true)
    setDelError('')
    try {
      const result = await teamApi.deleteTeam(id, effectiveDir)
      onDeleted(`${id} — ${result.removed.length}`)
    } catch (e) {
      setDelError(describeFailure(t, e instanceof Error ? e.message : String(e), id))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <Pane
        head={
          <div className="pane-head">
            <h3 className="mono">{detail?.name ?? id}</h3>
            <span className="mono small muted">{id}</span>
            {detail?.default === true && <StatusTag kind="ok">{t('teams.default')}</StatusTag>}
            <span className="spacer">
              {detail !== undefined && (
                <>
                  <button className="primary" onClick={() => void onActivate()} disabled={activating}>
                    {activating ? t('teams.activating') : t('teams.activate')}
                  </button>
                  <button onClick={onEdit}>{t('common.edit')}</button>
                </>
              )}
              <button
                onClick={() => {
                  setConfirming((prev) => !prev)
                  setDelError('')
                }}
                disabled={deleting}
              >
                {t('common.delete')}
              </button>
            </span>
          </div>
        }
      >
        <State loading={loading} error={error}>
          {detail !== undefined && (
            <>
              <h4>{t('teams.overview')}</h4>
              <dl className="kv">
                <dt>{t('common.name')}</dt>
                <dd>{detail.name !== '' ? detail.name : '—'}</dd>
                {detail.description !== '' && (
                  <>
                    <dt>{t('common.description')}</dt>
                    <dd>{detail.description}</dd>
                  </>
                )}
                <dt>{t('teams.col.members')}</dt>
                <dd className="mono">{detail.members.map((m) => `${m.role}×${m.count}`).join(', ') || '—'}</dd>
                <dt>{t('teams.col.stages')}</dt>
                <dd className="mono">{t('teams.stages', { n: detail.workflow.length })}</dd>
                <dt>{t('teams.deposit')}</dt>
                <dd>
                  <StatusTag kind={detail.deposit.enabled ? 'ok' : 'info'}>
                    {detail.deposit.enabled ? t('common.yes') : t('common.no')}
                  </StatusTag>
                  {detail.deposit.enabled && (
                    <>
                      <span className="small muted" style={{ marginLeft: 8 }}>
                        {detail.deposit.default_layer} · {detail.deposit.default_type} · {detail.deposit.priority}
                        {detail.deposit.require_note ? ' · note' : ''}
                      </span>
                    </>
                  )}
                </dd>
                {detail.arbitration.length > 0 && (
                  <>
                    <dt>{t('teams.arbitration')}</dt>
                    <dd className="mono small">{detail.arbitration.join(' > ')}</dd>
                  </>
                )}
                {detail.skills.length > 0 && (
                  <>
                    <dt>{t('skills.title')}</dt>
                    <dd className="mono small">{detail.skills.join(', ')}</dd>
                  </>
                )}
              </dl>
            </>
          )}
        </State>
      </Pane>

      {detail !== undefined && (
        <Pane
          head={
            <div className="pane-head">
              <h3>{t('teams.workflow')}</h3>
              <span className="spacer">
                <button onClick={() => setShowStages((prev) => !prev)}>
                  {showStages ? t('common.hideDetails') : t('common.showDetails')}
                </button>
              </span>
            </div>
          }
        >
          {detail.workflow.length === 0 ? (
            <div className="small muted">—</div>
          ) : (
            <div className="flow">
              {detail.workflow.map((stage, i) => (
                <span key={stage.order} style={{ display: 'contents' }}>
                  {i > 0 && <span className="sep">→</span>}
                  <span className="stage" title={stage.done}>
                    <span className="n">
                      {stage.order} · {modeLabel(t, stage.mode)}
                    </span>
                    <div>{stage.stage}</div>
                    <span className="r">{stage.roles.join(' + ')}</span>
                  </span>
                </span>
              ))}
            </div>
          )}
          {showStages && detail.workflow.length > 0 && (
            <div className="table-scroll" style={{ marginTop: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>#</th>
                    <th style={{ width: 100 }}>{t('teams.col.stage')}</th>
                    <th style={{ width: 130 }}>{t('teams.col.owner')}</th>
                    <th style={{ width: 70 }}>{t('teams.col.mode')}</th>
                    <th>{t('teams.col.done')}</th>
                    <th style={{ width: 150 }}>{t('teams.col.reflow')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.workflow.map((stage) => (
                    <tr key={stage.order}>
                      <td className="mono">{stage.order}</td>
                      <td>{stage.stage}</td>
                      <td className="mono small">{stage.roles.join(' + ')}</td>
                      <td className="small muted">{modeLabel(t, stage.mode)}</td>
                      <td className="small">{stage.done}</td>
                      <td className="small muted">{stage.reflow || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Pane>
      )}

      {detail !== undefined && (
        <Pane title={`${t('teams.roster')} · ${detail.members.length}`}>
          <div className="small muted" style={{ marginBottom: 8 }}>
            {t('teams.rosterHint')}
          </div>
          <div className="form-grid">
            {detail.members.map((m) => (
              <div key={m.role} className="list-row">
                {onOpenRole !== undefined ? (
                  <button className="rel-link mono" onClick={() => onOpenRole(m.role)}>
                    {m.role}
                  </button>
                ) : (
                  <span className="mono list-main">{m.role}</span>
                )}
                <StatusTag kind="info">×{m.count}</StatusTag>
              </div>
            ))}
          </div>
        </Pane>
      )}

      {/* F-D2 有效集（正向视图）：与技能页「使用情况」互链 */}
      {detail !== undefined && (
        <Pane>
          <EffectiveSkills
            key={id}
            team={id}
            teamFixed
            role={detail.members[0]?.role ?? ''}
            roleOptions={[...new Set(detail.members.map((m) => m.role))]}
            onOpenUsage={onOpenUsage}
          />
        </Pane>
      )}

      {actError !== '' && (
        <Pane>
          <div className="error" role="alert">
            {t('teams.activateFailed', { msg: actError })}
          </div>
        </Pane>
      )}

      {activation !== null && (
        <Pane title={t('teams.activation')}>
          <div className="small muted" style={{ marginBottom: 8 }}>
            {t('teams.activationHint')}
          </div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 160 }}>{t('teams.col.owner')}</th>
                <th style={{ width: 70 }}>{t('teams.col.qty')}</th>
                <th style={{ width: 90 }}>{t('teams.col.assembled')}</th>
                <th style={{ width: 110 }}>{t('teams.col.dispatch')}</th>
                <th>{t('common.details')}</th>
              </tr>
            </thead>
            <tbody>
              {activation.members.map((m) => (
                <tr key={m.role}>
                  <td className="mono">{m.role}</td>
                  <td className="mono">{m.count}</td>
                  <td>
                    <StatusTag kind={m.installed ? 'ok' : 'warn'}>
                      {m.installed ? t('common.yes') : t('common.no')}
                    </StatusTag>
                  </td>
                  <td>
                    <StatusTag kind={m.dispatch === 'native' ? 'ok' : 'warn'}>{m.dispatch}</StatusTag>
                  </td>
                  <td className="small muted">{m.hint ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Pane>
      )}

      {confirming && (
        <Pane>
          <div className="danger-zone">
            <div className="small" style={{ marginBottom: 8 }}>
              <strong>{t('common.irreversible')}</strong> — {t('teams.deleteWarning', { id })}
            </div>
            <label className="field" htmlFor="td-dir">
              <span className="label">{t('teams.dir')}</span>
              <input
                id="td-dir"
                value={dirValue}
                placeholder={teamsDir ?? ''}
                disabled={deleting}
                onChange={(e) => setDirOverride(e.target.value)}
              />
              {teamsDir === undefined && <span className="small muted">{t('teams.dirManual')}</span>}
            </label>
            {delError !== '' && (
              <div className="error" role="alert" style={{ marginTop: 8 }}>
                {delError}
              </div>
            )}
            <div className="form-actions" style={{ marginTop: 10 }}>
              <button onClick={() => setConfirming(false)} disabled={deleting}>
                {t('common.cancel')}
              </button>
              <button className="primary" onClick={() => void onDelete()} disabled={deleting || effectiveDir === ''}>
                {deleting ? t('common.deleting') : t('common.confirmDelete')}
              </button>
            </div>
          </div>
        </Pane>
      )}
    </>
  )
}

/** 阶段模式（定义里是中文/英文裸串，属数据；认得出就本地化，认不出原样显示）。 */
function modeLabel(t: TFunc, mode: string): string {
  if (mode === '串行' || mode === 'serial') return t('teams.mode.serial')
  if (mode === '并行' || mode === 'parallel') return t('teams.mode.parallel')
  return mode
}

/* ==================== F-C2 新建团队（抽屉内表单） ==================== */

type Template = 'minimal' | 'core-dev' | 'custom'

const TEMPLATE_LABEL: Record<Template, DictKey> = {
  minimal: 'teams.tpl.minimal',
  'core-dev': 'teams.tpl.coreDev',
  custom: 'teams.tpl.custom',
}

/**
 * 阶段摘要（**照抄真实模板**，不是估计值）：
 * `packages/agents/src/team/templates.ts` 的 `MINIMAL_TEAM_MD`（3 阶段）与
 * `CORE_DEV_TEAM_MD`（7 阶段）。ui-spec §2.1 把 core-dev 写成「5 阶段」= 把「5 成员」记成了阶段数，
 * 以模板为准；服务端渲染的就是这些阶段（联调实测见 stream-d-web.md）。
 *
 * 阶段名是**模板数据**（中文），不随界面语言翻译。
 */
const TEMPLATE_STAGES: Record<Template, string[]> = {
  minimal: ['开发', '测试', '收口'],
  'core-dev': ['探索', '设计', '设计审核', '开发', '测试', '总审', '交付'],
  custom: ['开发', '测试', '收口'],
}

const DEPOSIT_LAYER_KEYS: Array<{ value: string; label: DictKey }> = [
  { value: 'global', label: 'teams.layer.global' },
  { value: 'project', label: 'teams.layer.project' },
  { value: 'role', label: 'teams.layer.role' },
]

/** 与 packages/agents `ENTRY_TYPES` / team validate.ts 对齐（服务端会校验枚举） */
const DEPOSIT_TYPES = ['rule', 'doc', 'guide', 'pitfall', 'pattern', 'diagram', 'summary', 'other']

/** 与 packages/agents/src/types.ts `DepositPolicy.priority` 对齐（low/medium/high） */
const DEPOSIT_PRIORITIES = ['low', 'medium', 'high']

/** 校验字段展示/聚焦顺序（自上而下）。 */
const FIELD_ORDER = ['teamId', 'name', 'description', 'members', 'teamsDir', 'defaultLayer'] as const

/** 与服务端 `team-create.ts` 的 `KEBAB_CASE_RE` 同口径（前端先拦，服务端仍要校验）。 */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

interface FormValues {
  teamId: string
  name: string
  description: string
  counts: Record<string, number>
  filter: string
  template: Template
  depositEnabled: boolean
  defaultLayer: string
  defaultType: string
  priority: string
  requireNote: boolean
  teamsDir: string
}

function NewTeamForm({
  roles,
  rolesLoading,
  rolesError,
  onReloadRoles,
  existingIds,
  defaultTeamsDir,
  onCancel,
  onCreated,
}: {
  roles: RoleDefinition[]
  rolesLoading: boolean
  rolesError: string | undefined
  onReloadRoles: () => void
  existingIds: string[]
  defaultTeamsDir: string | undefined
  onCancel: () => void
  onCreated: (id: string, path: string, warning: string) => void
}) {
  const t = useT()
  const [v, setV] = useState<FormValues>(() => {
    // 预选 1 个 dev-1 + 1 个 tester（与 F-C1「最小可用模板」口径一致）
    const counts: Record<string, number> = {}
    for (const name of ['dev-1', 'tester']) {
      if (roles.some((r) => r.name === name)) counts[name] = 1
    }
    return {
      teamId: '',
      name: '',
      description: '',
      counts,
      filter: '',
      template: 'minimal',
      depositEnabled: false,
      defaultLayer: 'project',
      defaultType: 'other',
      priority: 'medium',
      requireNote: false,
      teamsDir: defaultTeamsDir ?? '',
    }
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [alert, setAlert] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const summaryRef = useRef<HTMLDivElement | null>(null)
  const seeded = useRef(false)

  // 角色库是异步到的：到手后补一次「预选 1 个 dev-1 + 1 个 tester」；用户已动手则不覆盖
  useEffect(() => {
    if (seeded.current || roles.length === 0) return
    seeded.current = true
    setV((prev) => {
      if (Object.values(prev.counts).some((c) => c > 0)) return prev
      const counts = { ...prev.counts }
      for (const name of ['dev-1', 'tester']) {
        if (roles.some((r) => r.name === name)) counts[name] = 1
      }
      return { ...prev, counts }
    })
  }, [roles])

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }))

  const members = useMemo<TeamMember[]>(
    () =>
      Object.entries(v.counts)
        .filter(([, count]) => count > 0)
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => a.role.localeCompare(b.role)),
    [v.counts],
  )
  const totalMembers = members.reduce((sum, m) => sum + m.count, 0)

  /** 已选置顶，其余按名排序；过滤纯前端 substring。 */
  const visibleRoles = useMemo(() => {
    const q = v.filter.trim().toLowerCase()
    return roles
      .filter((r) => q === '' || r.name.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        const picked = (r: RoleDefinition) => ((v.counts[r.name] ?? 0) > 0 ? 0 : 1)
        const diff = picked(a) - picked(b)
        return diff !== 0 ? diff : a.name.localeCompare(b.name)
      })
  }, [roles, v.counts, v.filter])

  const bump = (role: string, delta: number) =>
    setV((prev) => {
      const next = Math.max(0, Math.min(9, (prev.counts[role] ?? 0) + delta))
      return { ...prev, counts: { ...prev.counts, [role]: next } }
    })

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {}
    const id = v.teamId.trim()
    if (id === '') e.teamId = t('teams.v.idRequired')
    else if (!ID_RE.test(id)) e.teamId = t('teams.v.idInvalid')
    else if (id.length > 40) e.teamId = t('teams.v.idLong')
    else if (existingIds.includes(id)) e.teamId = t('teams.v.idTaken', { id })

    if (v.name.trim() === '') e.name = t('teams.v.nameRequired')
    else if (v.name.trim().length > 40) e.name = t('teams.v.nameLong')

    if (v.description.length > 200) e.description = t('teams.v.descLong')

    if (members.length === 0) e.members = t('teams.v.membersRequired')
    else if (members.some((m) => m.count < 1 || m.count > 9)) e.members = t('teams.v.membersRange')
    else {
      const unknown = members.find((m) => !roles.some((r) => r.name === m.role))
      if (unknown !== undefined) e.members = t('teams.v.memberUnknown', { role: unknown.role })
    }

    if (v.teamsDir.trim() === '') e.teamsDir = t('teams.v.dirRequired')
    if (v.depositEnabled && !DEPOSIT_LAYER_KEYS.some((l) => l.value === v.defaultLayer)) {
      e.defaultLayer = t('teams.v.layerRequired')
    }
    return e
  }

  const submit = async () => {
    const found = validate()
    const bad = FIELD_ORDER.filter((key) => found[key] !== undefined)
    if (bad.length > 0) {
      setErrors(found)
      setAlert(t('teams.form.fixCount', { n: bad.length }))
      const el = document.getElementById(`ntf-${bad[0]}`)
      el?.scrollIntoView({ block: 'center' })
      el?.focus()
      return
    }
    setErrors({})
    setAlert('')

    const deposit: DepositPolicy = {
      enabled: v.depositEnabled,
      default_layer: v.defaultLayer,
      default_type: v.defaultType,
      priority: v.priority,
      require_note: v.requireNote,
    }
    const input: NewTeamInput = {
      team_id: v.teamId.trim(),
      name: v.name.trim(),
      members,
      deposit,
      teams_dir: v.teamsDir.trim(),
      ...(v.description.trim() === '' ? {} : { description: v.description.trim() }),
      // custom 本轮不做编辑器 → 不传模板，服务端按最小可用骨架落盘
      ...(v.template === 'custom' ? {} : { workflow_template: v.template as 'minimal' | 'core-dev' }),
    }

    setSubmitting(true)
    try {
      const result = await teamApi.create(input)
      // 回读新团队定义：服务端若未采用某些字段 / 跳过某些阶段，必须**可见**而不是静默
      let warning = ''
      try {
        const actual = await teamApi.team(input.team_id)
        const want = members.map((m) => `${m.role}×${m.count}`).sort().join(',')
        const got = actual.members.map((m) => `${m.role}×${m.count}`).sort().join(',')
        const diff: string[] = []
        if (want !== got) diff.push('members')
        if (actual.deposit.enabled !== deposit.enabled) diff.push('deposit.enabled')
        if (actual.deposit.default_layer !== deposit.default_layer) diff.push('deposit.default_layer')
        if (actual.deposit.default_type !== deposit.default_type) diff.push('deposit.default_type')
        if (actual.deposit.priority !== deposit.priority) diff.push('deposit.priority')
        if (actual.deposit.require_note !== deposit.require_note) diff.push('deposit.require_note')
        const notes: string[] = []
        if (diff.length > 0) notes.push(t('teams.warn.readback', { fields: diff.join(' / ') }))
        // 服务端会跳过「模板里角色未入选」的阶段（实测：core-dev 7 阶段 + 仅 dev-1/tester → 落盘 5 阶段）
        const expectedStages = TEMPLATE_STAGES[v.template].length
        if (actual.workflow.length !== expectedStages) {
          notes.push(
            t('teams.warn.stages', {
              actual: actual.workflow.length,
              expected: expectedStages,
              stages: TEMPLATE_STAGES[v.template].join(' → '),
            }),
          )
        }
        warning = notes.join(' ')
      } catch (e) {
        warning = t('teams.warn.readbackFailed', { msg: e instanceof Error ? e.message : String(e) })
      }
      onCreated(input.team_id, result.path, warning)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setAlert(describeFailure(t, raw, v.teamId.trim()))
      summaryRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit =
    !submitting && !rolesLoading && roles.length > 0 && v.teamsDir.trim() !== '' && members.length > 0
  const disabledReason =
    rolesLoading || roles.length === 0
      ? t('teams.rolesLoading')
      : members.length === 0
        ? t('teams.v.membersRequired')
        : v.teamsDir.trim() === ''
          ? t('teams.v.dirRequired')
          : ''

  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {t('teams.form.steps')
          .split('·')
          .map((step) => (
            <span className="tag" key={step}>
              {step.trim()}
            </span>
          ))}
      </div>

      {alert !== '' && (
        <div className="error" role="alert" tabIndex={-1} ref={summaryRef} style={{ marginBottom: 12 }}>
          {alert}
        </div>
      )}

      {/* 1 身份 */}
      <div className="form-grid">
        <label className="field" htmlFor="ntf-teamId">
          <span className="label">{t('teams.form.idLabel')}</span>
          <input
            id="ntf-teamId"
            value={v.teamId}
            placeholder="core-dev-v2"
            disabled={submitting}
            aria-describedby={errors.teamId !== undefined ? 'ntf-teamId-err' : undefined}
            onChange={(e) => set('teamId', e.target.value)}
          />
          {errors.teamId !== undefined && (
            <span className="err-text" id="ntf-teamId-err">
              {errors.teamId}
            </span>
          )}
        </label>
        <label className="field" htmlFor="ntf-name">
          <span className="label">{t('teams.form.nameLabel')}</span>
          <input
            id="ntf-name"
            value={v.name}
            placeholder={t('teams.form.name')}
            disabled={submitting}
            aria-describedby={errors.name !== undefined ? 'ntf-name-err' : undefined}
            onChange={(e) => set('name', e.target.value)}
          />
          {errors.name !== undefined && (
            <span className="err-text" id="ntf-name-err">
              {errors.name}
            </span>
          )}
        </label>
        <label className="field" htmlFor="ntf-description" style={{ gridColumn: '1 / -1' }}>
          <span className="label">{t('teams.form.descLabel')}</span>
          <textarea
            id="ntf-description"
            rows={2}
            value={v.description}
            placeholder={t('teams.form.descPlaceholder')}
            disabled={submitting}
            onChange={(e) => set('description', e.target.value)}
          />
          {errors.description !== undefined && <span className="err-text">{errors.description}</span>}
        </label>
      </div>

      {/* 2 成员 */}
      <h4>{t('teams.form.membersTitle')}</h4>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="small muted">
          {totalMembers > 0
            ? t('teams.form.selectedMembers', {
                n: totalMembers,
                list: members.map((m) => `${m.role}×${m.count}`).join(', '),
              })
            : t('teams.form.noMembers')}
        </span>
        {!rolesLoading && roles.length > 0 && (
          <span className="small muted">
            {t('teams.form.availableRoles', { n: roles.filter((r) => (v.counts[r.name] ?? 0) === 0).length })}
          </span>
        )}
      </div>

      {rolesLoading ? (
        <div className="empty">{t('teams.rolesLoading')}</div>
      ) : rolesError !== undefined ? (
        <div className="error" role="alert">
          {t('teams.rolesFailed', { msg: rolesError })}{' '}
          <button className="rel-link" onClick={onReloadRoles}>
            {t('common.retry')}
          </button>
        </div>
      ) : roles.length === 0 ? (
        <div className="empty">
          {t('teams.rolesEmpty')}
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button onClick={onReloadRoles}>{t('common.retry')}</button>
          </div>
        </div>
      ) : (
        <>
          {roles.length > 8 && (
            <label className="field" htmlFor="ntf-filter" style={{ marginBottom: 8 }}>
              <input
                id="ntf-filter"
                value={v.filter}
                placeholder={t('teams.rolesFilter')}
                onChange={(e) => set('filter', e.target.value)}
              />
            </label>
          )}
          <div id="ntf-members" tabIndex={-1} className="form-grid">
            {visibleRoles.map((r) => {
              const count = v.counts[r.name] ?? 0
              const errs = (r.issues ?? []).filter((i) => i.level === 'error').length
              const warns = (r.issues ?? []).length - errs
              return (
                <div
                  key={r.name}
                  className={`list-row${count === 0 ? ' muted' : ''}`}
                  style={{ borderLeft: `3px solid ${count > 0 ? 'var(--accent)' : 'transparent'}` }}
                >
                  <span className="mono list-main">{r.name}</span>
                  <span
                    className={`tag${errs > 0 ? ' err' : warns > 0 ? ' warn' : ' ok'}`}
                    title={(r.issues ?? []).map((i) => `[${i.code}] ${i.message}`).join('\n')}
                  >
                    {errs > 0 ? `${errs}E` : warns > 0 ? `${warns}W` : 'ok'}
                  </span>
                  <div className="stepper">
                    <button
                      aria-label={`- ${r.name}`}
                      disabled={count <= 0 || submitting}
                      onClick={() => bump(r.name, -1)}
                    >
                      −
                    </button>
                    <span className="n">{count}</span>
                    <button
                      aria-label={`+ ${r.name}`}
                      disabled={count >= 9 || submitting}
                      onClick={() => bump(r.name, 1)}
                    >
                      +
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          {errors.members !== undefined && (
            <span className="err-text" style={{ color: 'var(--err)', fontSize: 12 }}>
              {errors.members}
            </span>
          )}
        </>
      )}

      {/* 3 工作流 */}
      <h4>{t('teams.form.workflowTitle')}</h4>
      <div className="row" style={{ gap: 6 }}>
        {(Object.keys(TEMPLATE_LABEL) as Template[]).map((tpl) => (
          <button
            key={tpl}
            className={v.template === tpl ? 'primary' : ''}
            aria-pressed={v.template === tpl}
            disabled={submitting}
            onClick={() => set('template', tpl)}
          >
            {t(TEMPLATE_LABEL[tpl])}
          </button>
        ))}
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        {t('teams.form.templateStages', {
          n: TEMPLATE_STAGES[v.template].length,
          stages: TEMPLATE_STAGES[v.template].join(' → '),
        })}
        <div style={{ marginTop: 4 }}>{t('teams.form.templateHint')}</div>
        {v.template === 'custom' && (
          <div style={{ marginTop: 4 }}>
            {t('teams.form.customHint', {
              path: `${v.teamsDir || '<teams_dir>'}/${v.teamId || '<id>'}.md`,
            })}
          </div>
        )}
      </div>

      {/* 4 沉淀规则 */}
      <h4>{t('teams.deposit')}</h4>
      <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={v.depositEnabled}
          disabled={submitting}
          onChange={(e) => set('depositEnabled', e.target.checked)}
        />
        <span>{t('teams.deposit.enable')}</span>
      </label>
      {v.depositEnabled && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label className="field" htmlFor="ntf-defaultLayer">
            <span className="label">{t('teams.deposit.layer')}</span>
            <select
              id="ntf-defaultLayer"
              value={v.defaultLayer}
              disabled={submitting}
              onChange={(e) => set('defaultLayer', e.target.value)}
            >
              {DEPOSIT_LAYER_KEYS.map((l) => (
                <option key={l.value} value={l.value}>
                  {t(l.label)}
                </option>
              ))}
            </select>
            {errors.defaultLayer !== undefined && <span className="err-text">{errors.defaultLayer}</span>}
          </label>
          <label className="field" htmlFor="ntf-defaultType">
            <span className="label">{t('teams.deposit.type')}</span>
            <select
              id="ntf-defaultType"
              value={v.defaultType}
              disabled={submitting}
              onChange={(e) => set('defaultType', e.target.value)}
            >
              {DEPOSIT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="ntf-priority">
            <span className="label">{t('teams.deposit.priority')}</span>
            <select
              id="ntf-priority"
              value={v.priority}
              disabled={submitting}
              onChange={(e) => set('priority', e.target.value)}
            >
              {DEPOSIT_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 6, alignSelf: 'end', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={v.requireNote}
              disabled={submitting}
              onChange={(e) => set('requireNote', e.target.checked)}
            />
            <span className="small">{t('teams.deposit.requireNote')}</span>
          </label>
        </div>
      )}

      {/* 5 写入目录 + 提交 */}
      <label className="field" htmlFor="ntf-teamsDir" style={{ marginTop: 16 }}>
        <span className="label">{t('teams.form.writeDirHint')}</span>
        <input
          id="ntf-teamsDir"
          value={v.teamsDir}
          placeholder="/path/to/prism-home/teams"
          disabled={submitting}
          aria-describedby={errors.teamsDir !== undefined ? 'ntf-teamsDir-err' : undefined}
          onChange={(e) => set('teamsDir', e.target.value)}
        />
        {defaultTeamsDir === undefined ? (
          <span className="small muted">{t('teams.dirManual')}</span>
        ) : (
          <span className="small muted">{t('teams.dirHint')}</span>
        )}
        {errors.teamsDir !== undefined && (
          <span className="err-text" id="ntf-teamsDir-err">
            {errors.teamsDir}
          </span>
        )}
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        {disabledReason !== '' && <span className="small muted">{disabledReason}</span>}
        <button onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </button>
        <button
          onClick={() => {
            setErrors({})
            setAlert('')
            set('filter', '')
          }}
          disabled={submitting}
        >
          {t('common.reset')}
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? t('teams.form.submittingNew') : t('teams.form.submitNew')}
        </button>
      </div>
    </div>
  )
}

/* ==================== v5 修改团队（字段补丁：只提交改动过的那几项） ==================== */

interface TeamEditValues {
  name: string
  description: string
  counts: Record<string, number>
  depositEnabled: boolean
  defaultLayer: string
  defaultType: string
  priority: string
  requireNote: boolean
  teamsDir: string
}

/**
 * `PATCH /api/teams/:id`：改身份 / 成员 / 沉淀规则。
 *
 * - 只提交**改动过**的字段（服务端 PATCH 语义：缺省 = 不改）；
 * - 改 `members` 时服务端会**就地收窄工作流**（`narrowWorkflow`）并回 `workflow_pruned` warning
 *   ——这里把服务端返回的 issues 原样呈现，不静默；
 * - `teams_dir` 必填；改 members 还要 `roles_dir`（校验角色存在，取自 `GET /api/roles`）。
 */
function EditTeamForm({
  team,
  roles,
  rolesLoading,
  rolesError,
  onReloadRoles,
  rolesDir,
  defaultTeamsDir,
  onCancel,
  onSaved,
  onFailed,
}: {
  team: TeamDefinition
  roles: RoleDefinition[]
  rolesLoading: boolean
  rolesError: string | undefined
  onReloadRoles: () => void
  rolesDir: string | undefined
  defaultTeamsDir: string | undefined
  onCancel: () => void
  onSaved: (text: string) => void
  onFailed: (text: string) => void
}) {
  const t = useT()
  const [initial] = useState<TeamEditValues>(() => ({
    name: team.name,
    description: team.description,
    counts: Object.fromEntries(team.members.map((m) => [m.role, m.count])),
    depositEnabled: team.deposit.enabled,
    defaultLayer: team.deposit.default_layer,
    defaultType: team.deposit.default_type,
    priority: team.deposit.priority,
    requireNote: team.deposit.require_note,
    teamsDir: defaultTeamsDir ?? '',
  }))
  const [v, setV] = useState<TeamEditValues>(initial)
  const [filter, setFilter] = useState('')
  const [alert, setAlert] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const set = <K extends keyof TeamEditValues>(key: K, value: TeamEditValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }))

  /** 角色库 + 定义里出现但角色库已没有的角色（后者必须可见，否则无法移除） */
  const candidates = useMemo(() => {
    const known = new Set(roles.map((r) => r.name))
    const orphan = [...new Set(team.members.map((m) => m.role))]
      .filter((n) => !known.has(n))
      .map(
        (name) =>
          ({
            name,
            description: '',
            skills: [],
            knowledge: { layers: [] },
            principle: '',
            body: '',
          }) as RoleDefinition,
      )
    return [...roles, ...orphan]
  }, [roles, team.members])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return candidates
      .filter((r) => q === '' || r.name.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        const picked = (r: RoleDefinition) => ((v.counts[r.name] ?? 0) > 0 ? 0 : 1)
        const diff = picked(a) - picked(b)
        return diff !== 0 ? diff : a.name.localeCompare(b.name)
      })
  }, [candidates, v.counts, filter])

  const members = useMemo<TeamMember[]>(
    () =>
      Object.entries(v.counts)
        .filter(([, count]) => count > 0)
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => a.role.localeCompare(b.role)),
    [v.counts],
  )
  const initialMembers = useMemo(
    () => [...team.members].sort((a, b) => a.role.localeCompare(b.role)),
    [team.members],
  )

  const bump = (role: string, delta: number) =>
    setV((prev) => {
      const next = Math.max(0, Math.min(9, (prev.counts[role] ?? 0) + delta))
      return { ...prev, counts: { ...prev.counts, [role]: next } }
    })

  const submit = async () => {
    const teamsDir = v.teamsDir.trim()
    if (teamsDir === '') {
      setAlert(t('teams.v.dirRequired'))
      return
    }
    if (v.name.trim() === '') {
      setAlert(t('teams.v.nameRequired'))
      return
    }
    if (v.name.trim().length > 40) {
      setAlert(t('teams.v.nameLong'))
      return
    }
    if (v.description.length > 200) {
      setAlert(t('teams.v.descLong'))
      return
    }
    if (members.length === 0) {
      setAlert(t('teams.v.keepOne'))
      return
    }

    const init = initial
    const patch: UpdateTeamInput = { teams_dir: teamsDir }
    const fields: string[] = []

    if (v.name !== init.name) {
      patch.name = v.name.trim()
      fields.push('name')
    }
    if (v.description !== init.description) {
      patch.description = v.description
      fields.push('description')
    }
    const sameMembers =
      members.map((m) => `${m.role}×${m.count}`).join(',') ===
      initialMembers.map((m) => `${m.role}×${m.count}`).join(',')
    if (!sameMembers) {
      if (rolesDir === undefined || rolesDir.trim() === '') {
        setAlert(t('teams.form.rolesDirMissing'))
        return
      }
      patch.members = members
      patch.roles_dir = rolesDir
      fields.push('members')
    }
    const depositChanged =
      v.depositEnabled !== init.depositEnabled ||
      v.defaultLayer !== init.defaultLayer ||
      v.defaultType !== init.defaultType ||
      v.priority !== init.priority ||
      v.requireNote !== init.requireNote
    if (depositChanged) {
      patch.deposit = {
        enabled: v.depositEnabled,
        default_layer: v.defaultLayer,
        default_type: v.defaultType,
        priority: v.priority,
        require_note: v.requireNote,
      }
      fields.push('deposit')
    }

    if (fields.length === 0) {
      setAlert(t('teams.form.nothingChanged'))
      return
    }
    setAlert('')
    setSubmitting(true)
    try {
      const result = await teamApi.updateTeam(team.team_id, patch)
      // 服务端的 issues（如 members 变更触发的 workflow_pruned）必须可见，不静默
      const warns = (result.issues ?? []).filter((i) => i.level !== 'error').map((i) => i.message)
      onSaved(
        t('teams.form.updated', { id: team.team_id, fields: fields.join(', ') }) +
          (warns.length > 0 ? ` — ${warns.join('; ')}` : ''),
      )
    } catch (e) {
      onFailed(describeFailure(t, e instanceof Error ? e.message : String(e), team.team_id))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 12 }}>
        {t('teams.form.editHint')}
      </div>

      {alert !== '' && (
        <div className="error" role="alert" style={{ marginBottom: 12 }}>
          {alert}
        </div>
      )}

      <div className="form-grid">
        <label className="field" htmlFor="etf-name">
          <span className="label">{t('common.name')}</span>
          <input id="etf-name" value={v.name} disabled={submitting} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field" htmlFor="etf-description" style={{ gridColumn: '1 / -1' }}>
          <span className="label">{t('teams.form.description')}</span>
          <textarea
            id="etf-description"
            rows={2}
            value={v.description}
            disabled={submitting}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>
      </div>

      <h4>{t('teams.form.membersTitle')}</h4>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="small muted">
          {members.length > 0
            ? t('teams.form.selectedMembers', {
                n: members.reduce((sum, m) => sum + m.count, 0),
                list: members.map((m) => `${m.role}×${m.count}`).join(', '),
              })
            : t('teams.form.noMembers')}
        </span>
        {!rolesLoading && roles.length > 0 && (
          <span className="small muted">
            {t('teams.form.availableRoles', { n: candidates.filter((r) => (v.counts[r.name] ?? 0) === 0).length })}
          </span>
        )}
      </div>

      {rolesLoading ? (
        <div className="empty">{t('teams.rolesLoading')}</div>
      ) : rolesError !== undefined ? (
        <div className="error" role="alert">
          {t('teams.rolesFailed', { msg: rolesError })}{' '}
          <button className="rel-link" onClick={onReloadRoles}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          {candidates.length > 8 && (
            <label className="field" htmlFor="etf-filter" style={{ marginBottom: 8 }}>
              <input
                id="etf-filter"
                value={filter}
                placeholder={t('teams.rolesFilter')}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
          )}
          <div className="form-grid">
            {visible.map((r) => {
              const count = v.counts[r.name] ?? 0
              return (
                <div
                  key={r.name}
                  className={`list-row${count === 0 ? ' muted' : ''}`}
                  style={{ borderLeft: `3px solid ${count > 0 ? 'var(--accent)' : 'transparent'}` }}
                >
                  <span className="mono list-main">{r.name}</span>
                  <div className="stepper">
                    <button aria-label={`- ${r.name}`} disabled={count <= 0 || submitting} onClick={() => bump(r.name, -1)}>
                      −
                    </button>
                    <span className="n">{count}</span>
                    <button aria-label={`+ ${r.name}`} disabled={count >= 9 || submitting} onClick={() => bump(r.name, 1)}>
                      +
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <h4>{t('teams.deposit')}</h4>
      <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={v.depositEnabled}
          disabled={submitting}
          onChange={(e) => set('depositEnabled', e.target.checked)}
        />
        <span>{t('teams.deposit.enable')}</span>
      </label>
      {v.depositEnabled && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label className="field" htmlFor="etf-defaultLayer">
            <span className="label">{t('teams.deposit.layer')}</span>
            <select
              id="etf-defaultLayer"
              value={v.defaultLayer}
              disabled={submitting}
              onChange={(e) => set('defaultLayer', e.target.value)}
            >
              {DEPOSIT_LAYER_KEYS.map((l) => (
                <option key={l.value} value={l.value}>
                  {t(l.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="etf-defaultType">
            <span className="label">{t('teams.deposit.type')}</span>
            <select
              id="etf-defaultType"
              value={v.defaultType}
              disabled={submitting}
              onChange={(e) => set('defaultType', e.target.value)}
            >
              {DEPOSIT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="etf-priority">
            <span className="label">{t('teams.deposit.priority')}</span>
            <select
              id="etf-priority"
              value={v.priority}
              disabled={submitting}
              onChange={(e) => set('priority', e.target.value)}
            >
              {DEPOSIT_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="row" style={{ gap: 6, alignSelf: 'end', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={v.requireNote}
              disabled={submitting}
              onChange={(e) => set('requireNote', e.target.checked)}
            />
            <span className="small">{t('teams.deposit.requireNote')}</span>
          </label>
        </div>
      )}

      <label className="field" htmlFor="etf-teamsDir" style={{ marginTop: 16 }}>
        <span className="label">{t('teams.dir')}</span>
        <input
          id="etf-teamsDir"
          value={v.teamsDir}
          placeholder="/path/to/prism-home/teams"
          disabled={submitting}
          onChange={(e) => set('teamsDir', e.target.value)}
        />
        {defaultTeamsDir === undefined && <span className="small muted">{t('teams.dirManual')}</span>}
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        <button onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </button>
        <button className="primary" onClick={() => void submit()} disabled={submitting || v.teamsDir.trim() === ''}>
          {submitting ? t('teams.form.submittingEdit') : t('teams.form.submitEdit')}
        </button>
      </div>
    </div>
  )
}

/** 服务端错误码 → 界面文案（未列出的 code 一律走通用文案，**不静默**）。
 *
 * 服务端实际形状（读 `packages/server/src/roles/team-create.ts` + `http/routes/people.ts`，非猜测）：
 * - 业务码直接在**信封 code** 上：`id_conflict`（已存在不覆盖）；
 * - 多数校验失败信封 code 是 `bad_request`，**具体码在 message 开头**并以全角冒号分隔：
 *   `teams_dir_required：…` / `team_id_invalid：…` / `members_invalid：…` / `member_role_unknown：…`。
 * ui-spec §2.3 的码表是设计期预填（`role_not_found`/`invalid_members`/`team_exists`），
 * 落地后以服务端为准——两套都认，避免任一侧改动后变成「静默失败」。
 */
function describeFailure(t: TFunc, raw: string, teamId: string): string {
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
