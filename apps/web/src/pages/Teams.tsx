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
import type { NavTarget } from '../nav.ts'

/**
 * 团队页：团队列表 + 新建团队（F-C2，内联卡片表单） + 详情（工作流 / 沉淀 / 有效 Skill F-D2）
 * + 启用（装配状态）。
 */
export function TeamsPage({
  nav,
  onOpenSkills,
}: {
  /** 跨页跳转意图（有效集反向视图 → 本页展开指定团队） */
  nav?: NavTarget
  onOpenSkills?: () => void
} = {}) {
  const teams = useAsync(() => teamApi.teams(), [])
  const [selected, setSelected] = useState<string>('')
  const [activation, setActivation] = useState<TeamActivation | null>(null)
  const [activating, setActivating] = useState(false)
  const [actError, setActError] = useState<string>('')
  const [formOpen, setFormOpen] = useState(false)
  /** 详情里就地编辑（v5：团队与角色对称，`new|edit|rm` 三入口同名同位） */
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [delError, setDelError] = useState('')
  /** 删除时的 teams_dir：`null` = 跟随服务端给的默认目录 */
  const [delDir, setDelDir] = useState<string | null>(null)
  const [created, setCreated] = useState<{ id: string; path: string; warning: string } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 角色库只在打开表单/编辑时拉取（省一次首屏请求）；`GET /api/roles` 返回 `{roles, rolesDir}`（v5）
  const needRoles = formOpen || editing
  const roleIndex = useAsync(
    () =>
      needRoles
        ? teamApi.roles()
        : Promise.resolve({ roles: [] as RoleDefinition[], rolesDir: undefined as string | undefined }),
    [needRoles],
  )
  const roleList = roleIndex.data?.roles ?? []
  /** 角色受管目录：改 members 时服务端要求显式给出（用于校验角色存在） */
  const rolesDir = roleIndex.data?.rolesDir

  // 从「技能 → 使用情况」跳进来时展开目标团队
  useEffect(() => {
    if (nav?.team !== undefined && nav.team !== '') setSelected(nav.team)
  }, [nav])

  // 成功条保留 6 秒后自动隐去
  useEffect(() => {
    if (created === null) return
    const timer = setTimeout(() => setCreated(null), 6000)
    return () => clearTimeout(timer)
  }, [created])

  const detail = useAsync(
    () => (selected ? teamApi.team(selected) : Promise.resolve(undefined)),
    [selected],
  )

  const onActivate = async () => {
    if (!selected) return
    setActivating(true)
    setActError('')
    setActivation(null)
    try {
      setActivation(await teamApi.activate(selected))
    } catch (e) {
      setActError(e instanceof Error ? e.message : String(e))
    } finally {
      setActivating(false)
    }
  }

  /** 删除团队（`DELETE /api/teams/:id`，硬删；`teams_dir` 必须显式给出）。 */
  const onDelete = async () => {
    if (!selected) return
    const dir = (delDir ?? teams.data?.teamsDir ?? '').trim()
    if (dir === '') {
      setDelError('未指定团队目录（teams_dir）——请在下方填写后再删除。')
      return
    }
    setDeleting(true)
    setDelError('')
    try {
      const result = await teamApi.deleteTeam(selected, dir)
      setNotice({ kind: 'ok', text: `${selected} 已删除（${result.removed.length} 个文件；不可逆）` })
      setSelected('')
      setActivation(null)
      setConfirming(false)
      teams.reload()
    } catch (e) {
      setDelError(describeFailure(e instanceof Error ? e.message : String(e), selected))
    } finally {
      setDeleting(false)
    }
  }

  const onCreated = (id: string, path: string, warning: string) => {
    setFormOpen(false)
    teams.reload()
    setSelected(id)
    setActivation(null)
    setActError('')
    setCreated({ id, path, warning })
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="page-title">团队</h2>
        <button
          className="primary"
          onClick={() => {
            setFormOpen(true)
            setCreated(null)
          }}
          disabled={formOpen}
        >
          新建团队
        </button>
      </div>
      <p className="page-desc">
        团队 = 成员引用角色库 + 固定工作流 + 沉淀规则 + 优先级。Prism 只定义与校验，不执行调度。
      </p>

      <div className="card">
        <h3>团队列表</h3>
        {created !== null && (
          <div style={{ marginBottom: 10 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="tag ok">已创建</span>
              <span className="mono small">
                {created.id} → {created.path}
              </span>
            </div>
            {created.warning !== '' && (
              <div className="small" style={{ color: 'var(--warn)', marginTop: 6 }}>
                {created.warning}
              </div>
            )}
          </div>
        )}
        <State
          loading={teams.loading}
          error={teams.error}
          empty={!teams.loading && !teams.error && (teams.data?.teams.length ?? 0) === 0}
          emptyText="还没有团队定义。在 <PRISM_HOME>/teams/ 下放 <team-id>.md，或用上方「新建团队」创建。"
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>团队</th>
                  <th>描述</th>
                  <th style={{ width: 200 }}>成员</th>
                  <th style={{ width: 80 }}>工作流</th>
                </tr>
              </thead>
              <tbody>
                {teams.data?.teams.map((t) => (
                  <tr key={t.team_id}>
                    <td>
                      <button
                        className="nav-item"
                        style={{ padding: 0, color: 'var(--accent)' }}
                        onClick={() => {
                          setSelected(t.team_id)
                          setActivation(null)
                          setActError('')
                        }}
                      >
                        {t.name}
                      </button>
                      <div className="mono small muted">{t.team_id}</div>
                    </td>
                    <td className="small">{t.description}</td>
                    <td className="mono small muted">
                      {t.members.map((m) => `${m.role}×${m.count}`).join(', ')}
                    </td>
                    <td className="mono small">{t.workflow.length} 阶段</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </div>

      {formOpen && (
        <NewTeamForm
          roles={roleList}
          rolesLoading={roleIndex.loading}
          rolesError={roleIndex.error}
          onReloadRoles={roleIndex.reload}
          existingIds={(teams.data?.teams ?? []).map((t) => t.team_id)}
          defaultTeamsDir={teams.data?.teamsDir}
          onCancel={() => setFormOpen(false)}
          onCreated={onCreated}
        />
      )}

      {selected && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3>
              团队详情 <span className="mono small muted">{selected}</span>
            </h3>
            <div className="row">
              {!editing && (
                <button className="primary" onClick={onActivate} disabled={activating}>
                  {activating ? '启用中…' : '启用团队'}
                </button>
              )}
              {!editing && detail.data !== undefined && (
                <button
                  onClick={() => {
                    setEditing(true)
                    setConfirming(false)
                    setNotice(null)
                  }}
                >
                  编辑
                </button>
              )}
              {!editing && detail.data !== undefined && (
                <button
                  onClick={() => {
                    setConfirming((prev) => !prev)
                    setDelError('')
                  }}
                  disabled={deleting}
                >
                  {confirming ? '取消删除' : '删除'}
                </button>
              )}
              <button
                onClick={() => {
                  setSelected('')
                  setActivation(null)
                  setEditing(false)
                  setConfirming(false)
                }}
              >
                关闭
              </button>
            </div>
          </div>

          {notice !== null && (
            <div className="row" style={{ gap: 8, marginBottom: 10 }}>
              <span className={`tag ${notice.kind === 'ok' ? 'ok' : 'err'}`}>
                {notice.kind === 'ok' ? '已完成' : '失败'}
              </span>
              <span className="small">{notice.text}</span>
            </div>
          )}

          {confirming && !editing && detail.data !== undefined && (
            <div
              className="card"
              style={{ background: 'var(--panel-2)', marginBottom: 12, borderLeft: '3px solid var(--err)' }}
            >
              <div className="small" style={{ marginBottom: 8 }}>
                <strong>删除是不可逆的硬删</strong>：会直接删掉 <span className="mono">{selected}.md</span>
                （兼容形态 <span className="mono">{selected}/AGENTS.md</span> 一并删）。服务端要求显式给出目录。
              </div>
              <label className="field" htmlFor="td-dir">
                <span className="label">团队目录（teams_dir，必填）</span>
                <input
                  id="td-dir"
                  value={delDir ?? teams.data?.teamsDir ?? ''}
                  placeholder={teams.data?.teamsDir ?? '如 D:\\prism-home\\teams'}
                  disabled={deleting}
                  onChange={(e) => setDelDir(e.target.value)}
                />
                {teams.data?.teamsDir === undefined && (
                  <span className="small muted">
                    未从 <span className="mono">GET /api/teams</span> 拿到默认目录 → 必须手动填写。
                  </span>
                )}
              </label>
              {delError !== '' && (
                <div className="error" role="alert" style={{ marginTop: 8 }}>
                  {delError}
                </div>
              )}
              <div className="form-actions" style={{ marginTop: 10 }}>
                <button onClick={() => setConfirming(false)} disabled={deleting}>
                  取消
                </button>
                <button
                  className="primary"
                  disabled={deleting || (delDir ?? teams.data?.teamsDir ?? '').trim() === ''}
                  onClick={() => void onDelete()}
                >
                  {deleting ? '删除中…' : '确认删除'}
                </button>
              </div>
            </div>
          )}

          {editing && detail.data !== undefined ? (
            <EditTeamForm
              team={detail.data}
              roles={roleList}
              rolesLoading={roleIndex.loading}
              rolesError={roleIndex.error}
              onReloadRoles={roleIndex.reload}
              rolesDir={rolesDir}
              defaultTeamsDir={teams.data?.teamsDir}
              onCancel={() => setEditing(false)}
              onSaved={(text) => {
                setEditing(false)
                setNotice({ kind: 'ok', text })
                teams.reload()
                detail.reload()
              }}
              onFailed={(text) => setNotice({ kind: 'err', text })}
            />
          ) : (
          <State loading={detail.loading} error={detail.error}>
            {detail.data && (
              <>
                <div className="row" style={{ marginBottom: 12 }}>
                  {detail.data.default && <span className="tag ok">默认团队</span>}
                  <span className="tag">沉淀: {detail.data.deposit.enabled ? '开' : '关'}</span>
                  <span className="tag">默认层: {detail.data.deposit.default_layer}</span>
                  <span className="tag">优先级: {detail.data.deposit.priority}</span>
                  {detail.data.arbitration.length > 0 && (
                    <span className="tag">仲裁: {detail.data.arbitration.join(' > ')}</span>
                  )}
                </div>

                {/* F-D2 有效集（正向视图）：工作流表上方；与技能页「使用情况」互链 */}
                <EffectiveSkills
                  key={selected}
                  team={selected}
                  teamFixed
                  role={detail.data.members[0]?.role ?? ''}
                  roleOptions={[...new Set(detail.data.members.map((m) => m.role))]}
                  onOpenUsage={onOpenSkills}
                />

                <h3 style={{ marginTop: 14 }}>工作流</h3>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}>#</th>
                        <th style={{ width: 120 }}>阶段</th>
                        <th style={{ width: 130 }}>负责角色</th>
                        <th style={{ width: 70 }}>串/并行</th>
                        <th>完成判定</th>
                        <th style={{ width: 160 }}>回流路径</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.workflow.map((s) => (
                        <tr key={s.order}>
                          <td className="mono">{s.order}</td>
                          <td>{s.stage}</td>
                          <td className="mono small">{s.roles.join(' + ')}</td>
                          <td className="small muted">{s.mode}</td>
                          <td className="small">{s.done}</td>
                          <td className="small muted">{s.reflow || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </State>
          )}

          {!editing && actError && (
            <div className="error" style={{ marginTop: 12 }} role="alert">
              启用失败：{actError}
            </div>
          )}

          {!editing && activation && (
            <>
              <h3 style={{ marginTop: 16 }}>装配状态</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 180 }}>角色</th>
                      <th style={{ width: 70 }}>数量</th>
                      <th style={{ width: 100 }}>已装配</th>
                      <th style={{ width: 110 }}>派发路径</th>
                      <th>提示</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activation.members.map((m) => (
                      <tr key={m.role}>
                        <td className="mono">{m.role}</td>
                        <td className="mono">{m.count}</td>
                        <td>
                          <span className={`tag${m.installed ? ' ok' : ' warn'}`}>
                            {m.installed ? '是' : '否'}
                          </span>
                        </td>
                        <td>
                          <span className={`tag${m.dispatch === 'native' ? ' ok' : ' warn'}`}>
                            {m.dispatch}
                          </span>
                        </td>
                        <td className="small muted">{m.hint ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}

/* ==================== F-C2 新建团队（内联表单） ==================== */

type Template = 'minimal' | 'core-dev' | 'custom'

const TEMPLATE_LABEL: Record<Template, string> = {
  minimal: '最小可用（3 阶段）',
  'core-dev': '核心开发（7 阶段）',
  custom: '自定义',
}

/**
 * 阶段摘要（**照抄真实模板**，不是估计值）：
 * `packages/agents/src/team/templates.ts` 的 `MINIMAL_TEAM_MD`（3 阶段）与
 * `CORE_DEV_TEAM_MD`（7 阶段）。ui-spec §2.1 把 core-dev 写成「5 阶段」= 把「5 成员」记成了阶段数，
 * 以模板为准；服务端渲染的就是这些阶段（联调实测见 stream-d-web.md）。
 */
const TEMPLATE_STAGES: Record<Template, string[]> = {
  minimal: ['开发', '测试', '收口'],
  'core-dev': ['探索', '设计', '设计审核', '开发', '测试', '总审', '交付'],
  custom: ['开发', '测试', '收口'],
}

const DEPOSIT_LAYERS = [
  { value: 'global', label: 'global 全局' },
  { value: 'project', label: 'project 项目' },
  { value: 'role', label: 'role 专家' },
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
    if (id === '') e.teamId = '团队 ID 不能为空'
    else if (!ID_RE.test(id)) e.teamId = '只能用小写字母、数字和连字符（-），且以字母或数字开头'
    else if (id.length > 40) e.teamId = '团队 ID 最多 40 字符'
    else if (existingIds.includes(id)) e.teamId = `团队 ID「${id}」已被占用，换一个`

    if (v.name.trim() === '') e.name = '名称不能为空'
    else if (v.name.trim().length > 40) e.name = '名称最多 40 字符'

    if (v.description.length > 200) e.description = '描述最多 200 字'

    if (members.length === 0) e.members = '至少选 1 个成员角色'
    else if (members.some((m) => m.count < 1 || m.count > 9)) e.members = '数量需在 1–9 之间'
    else {
      const unknown = members.find((m) => !roles.some((r) => r.name === m.role))
      if (unknown !== undefined) e.members = `角色「${unknown.role}」不在角色库中`
    }

    if (v.teamsDir.trim() === '') e.teamsDir = '请先填写写入目录'
    if (v.depositEnabled && !DEPOSIT_LAYERS.some((l) => l.value === v.defaultLayer)) {
      e.defaultLayer = '请选择默认层'
    }
    return e
  }

  const submit = async () => {
    const found = validate()
    const bad = FIELD_ORDER.filter((key) => found[key] !== undefined)
    if (bad.length > 0) {
      setErrors(found)
      setAlert(`有 ${bad.length} 项需要修正，已在下方标出`)
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
      ...(v.template === 'custom' ? {} : { workflow_template: v.template }),
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
        if (want !== got) diff.push('成员')
        if (actual.deposit.enabled !== deposit.enabled) diff.push('沉淀开关')
        if (actual.deposit.default_layer !== deposit.default_layer) diff.push('沉淀默认层')
        if (actual.deposit.default_type !== deposit.default_type) diff.push('沉淀默认类型')
        if (actual.deposit.priority !== deposit.priority) diff.push('沉淀优先级')
        if (actual.deposit.require_note !== deposit.require_note) diff.push('要求备注')
        const notes: string[] = []
        if (diff.length > 0) {
          notes.push(
            `注意：回读新团队定义与提交值不一致（${diff.join(' / ')}）——服务端可能未采用这些字段，请核对 POST /api/teams。`,
          )
        }
        // 服务端会跳过「模板里角色未入选」的阶段（实测：core-dev 7 阶段 + 仅 dev-1/tester → 落盘 5 阶段）
        const expectedStages = TEMPLATE_STAGES[v.template].length
        if (actual.workflow.length !== expectedStages) {
          notes.push(
            `已按模板落盘 ${actual.workflow.length} 个阶段（模板共 ${expectedStages} 个：${TEMPLATE_STAGES[v.template].join(' → ')}）——缺少对应成员的阶段由服务端跳过。`,
          )
        }
        warning = notes.join(' ')
      } catch (e) {
        warning = `回读新团队失败（不影响创建结果）：${e instanceof Error ? e.message : String(e)}`
      }
      onCreated(input.team_id, result.path, warning)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setAlert(describeFailure(raw, v.teamId.trim()))
      summaryRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit =
    !submitting && !rolesLoading && roles.length > 0 && v.teamsDir.trim() !== '' && members.length > 0
  const disabledReason =
    rolesLoading || roles.length === 0
      ? '角色库未就绪'
      : members.length === 0
        ? '至少选 1 个成员角色'
        : v.teamsDir.trim() === ''
          ? '请先填写写入目录'
          : ''

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>新建团队</h3>
        <button onClick={onCancel} disabled={submitting}>
          取消
        </button>
      </div>

      <div className="row" style={{ gap: 6, marginTop: 8, marginBottom: 10 }}>
        <span className="tag">1 身份</span>
        <span className="tag">2 成员</span>
        <span className="tag">3 工作流</span>
        <span className="tag">4 沉淀规则</span>
        <span className="tag">5 提交</span>
      </div>

      {alert !== '' && (
        <div className="error" role="alert" tabIndex={-1} ref={summaryRef} style={{ marginBottom: 12 }}>
          {alert}
        </div>
      )}

      {/* 1 身份 */}
      <div className="form-grid">
        <label className="field" htmlFor="ntf-teamId">
          <span className="label">团队 ID（必填，kebab-case）</span>
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
          <span className="label">名称（必填）</span>
          <input
            id="ntf-name"
            value={v.name}
            placeholder="核心研发团队"
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
          <span className="label">描述（选填，最多 200 字）</span>
          <textarea
            id="ntf-description"
            rows={2}
            value={v.description}
            placeholder="这个团队做什么、什么时候用"
            disabled={submitting}
            onChange={(e) => set('description', e.target.value)}
          />
          {errors.description !== undefined && <span className="err-text">{errors.description}</span>}
        </label>
      </div>

      {/* 2 成员 */}
      <h3 style={{ marginTop: 16 }}>成员（角色 + 数量）</h3>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="small muted">
          {totalMembers > 0
            ? `已选 ${totalMembers} 个成员（${members.map((m) => `${m.role}×${m.count}`).join(', ')}）`
            : '未选成员'}
        </span>
        {!rolesLoading && roles.length > 0 && (
          <span className="small muted">还可选：{roles.filter((r) => (v.counts[r.name] ?? 0) === 0).length} 个角色</span>
        )}
      </div>

      {rolesLoading ? (
        <div className="empty">加载中…</div>
      ) : rolesError !== undefined ? (
        <div className="error" role="alert">
          请求失败：{rolesError}{' '}
          <button className="rel-link" onClick={onReloadRoles}>
            重试
          </button>
        </div>
      ) : roles.length === 0 ? (
        <div className="empty">
          角色库是空的，无法建队。先执行 <span className="mono">prism role new dev-1</span> 生成角色骨架（或直接写角色文件）。
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button onClick={onReloadRoles}>重试</button>
          </div>
        </div>
      ) : (
        <>
          {roles.length > 8 && (
            <label className="field" htmlFor="ntf-filter" style={{ marginBottom: 8 }}>
              <input
                id="ntf-filter"
                value={v.filter}
                placeholder="筛选角色…"
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
                  <span className={`tag${errs > 0 ? ' err' : warns > 0 ? ' warn' : ' ok'}`} title={(r.issues ?? []).map((i) => `[${i.code}] ${i.message}`).join('\n')}>
                    {errs > 0 ? `${errs}E` : warns > 0 ? `${warns}W` : 'ok'}
                  </span>
                  <div className="stepper">
                    <button
                      aria-label={`减少 ${r.name} 数量`}
                      disabled={count <= 0 || submitting}
                      onClick={() => bump(r.name, -1)}
                    >
                      −
                    </button>
                    <span className="n">{count}</span>
                    <button
                      aria-label={`增加 ${r.name} 数量`}
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
      <h3 style={{ marginTop: 16 }}>工作流模板</h3>
      <div className="row" style={{ gap: 6 }}>
        {(Object.keys(TEMPLATE_LABEL) as Template[]).map((t) => (
          <button
            key={t}
            className={v.template === t ? 'primary' : ''}
            aria-pressed={v.template === t}
            disabled={submitting}
            onClick={() => set('template', t)}
          >
            {TEMPLATE_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        模板阶段（{TEMPLATE_STAGES[v.template].length}）：{TEMPLATE_STAGES[v.template].join(' → ')}
        <div style={{ marginTop: 4 }}>
          实际落盘 = 其中「角色已入选」的阶段；缺对应成员的阶段由服务端跳过（创建后回读核对并给出实际阶段数）。
        </div>
        {v.template === 'custom' && (
          <div style={{ marginTop: 4 }}>
            自定义工作流本轮不做编辑器：创建后编辑{' '}
            <span className="mono">
              {v.teamsDir || '<teams_dir>'}/{v.teamId || '<id>'}.md
            </span>{' '}
            的 workflow 段即可；这里按「最小可用」骨架落盘。
          </div>
        )}
      </div>

      {/* 4 沉淀规则 */}
      <h3 style={{ marginTop: 16 }}>沉淀规则</h3>
      <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={v.depositEnabled}
          disabled={submitting}
          onChange={(e) => set('depositEnabled', e.target.checked)}
        />
        <span>启用沉淀（关 = 任务完成时不提示落库）</span>
      </label>
      {v.depositEnabled && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label className="field" htmlFor="ntf-defaultLayer">
            <span className="label">默认层</span>
            <select
              id="ntf-defaultLayer"
              value={v.defaultLayer}
              disabled={submitting}
              onChange={(e) => set('defaultLayer', e.target.value)}
            >
              {DEPOSIT_LAYERS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            {errors.defaultLayer !== undefined && <span className="err-text">{errors.defaultLayer}</span>}
          </label>
          <label className="field" htmlFor="ntf-defaultType">
            <span className="label">默认类型</span>
            <select
              id="ntf-defaultType"
              value={v.defaultType}
              disabled={submitting}
              onChange={(e) => set('defaultType', e.target.value)}
            >
              {DEPOSIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="ntf-priority">
            <span className="label">优先级</span>
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
            <span className="small">要求备注（require_note）</span>
          </label>
        </div>
      )}

      {/* 5 写入目录 + 提交 */}
      <label className="field" htmlFor="ntf-teamsDir" style={{ marginTop: 16 }}>
        <span className="label">写入目录（teams_dir，必填；写真实宿主前请确认）</span>
        <input
          id="ntf-teamsDir"
          value={v.teamsDir}
          placeholder="如 D:\prism-home\teams"
          disabled={submitting}
          aria-describedby={errors.teamsDir !== undefined ? 'ntf-teamsDir-err' : undefined}
          onChange={(e) => set('teamsDir', e.target.value)}
        />
        {defaultTeamsDir === undefined ? (
          <span className="small muted">
            未从 <span className="mono">GET /api/teams</span> 拿到默认目录（服务端未返回 teamsDir）→ 请手动填写。
          </span>
        ) : (
          <span className="small muted">默认取自服务端受管目录，可改；Prism 不会回落到宿主默认目录。</span>
        )}
        {errors.teamsDir !== undefined && (
          <span className="err-text" id="ntf-teamsDir-err">
            {errors.teamsDir}
          </span>
        )}
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        {disabledReason !== '' && <span className="small muted">{disabledReason}</span>}
        <button
          onClick={() => {
            setErrors({})
            setAlert('')
            set('filter', '')
          }}
          disabled={submitting}
        >
          重置
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? '创建中…' : '创建团队'}
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
      .map((name) => ({ name, description: '（不在角色库中）', skills: [], knowledge: { layers: [] }, principle: '', body: '' }) as RoleDefinition)
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
      setAlert('请先填写团队目录（teams_dir）')
      return
    }
    if (v.name.trim() === '') {
      setAlert('名称不能为空')
      return
    }
    if (v.name.trim().length > 40) {
      setAlert('名称最多 40 字符')
      return
    }
    if (v.description.length > 200) {
      setAlert('描述最多 200 字')
      return
    }
    if (members.length === 0) {
      setAlert('至少保留 1 个成员角色')
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
        setAlert('改动成员需要 roles_dir（服务端用于校验角色存在），但没从 GET /api/roles 拿到 → 请刷新角色库')
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
      setAlert('没有任何改动——改一处再提交。')
      return
    }
    setAlert('')
    setSubmitting(true)
    try {
      const result = await teamApi.updateTeam(team.team_id, patch)
      // 服务端的 issues（如 members 变更触发的 workflow_pruned）必须可见，不静默
      const warns = (result.issues ?? []).filter((i) => i.level !== 'error').map((i) => i.message)
      onSaved(
        `${team.team_id} 已更新（改动字段：${fields.join(', ')}）` + (warns.length > 0 ? `；${warns.join('；')}` : ''),
      )
    } catch (e) {
      onFailed(describeFailure(e instanceof Error ? e.message : String(e), team.team_id))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          编辑团队 <span className="mono small muted">{team.team_id}</span>
        </h3>
        <span className="small muted">只提交改动过的字段；改成员会就地把工作流收窄。</span>
      </div>

      {alert !== '' && (
        <div className="error" role="alert" style={{ marginBottom: 12 }}>
          {alert}
        </div>
      )}

      <div className="form-grid">
        <label className="field" htmlFor="etf-name">
          <span className="label">名称</span>
          <input
            id="etf-name"
            value={v.name}
            disabled={submitting}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="field" htmlFor="etf-description" style={{ gridColumn: '1 / -1' }}>
          <span className="label">描述</span>
          <textarea
            id="etf-description"
            rows={2}
            value={v.description}
            disabled={submitting}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>
      </div>

      <h3 style={{ marginTop: 16 }}>成员（角色 + 数量）</h3>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="small muted">
          {members.length > 0
            ? `当前 ${members.length} 个成员（${members.map((m) => `${m.role}×${m.count}`).join(', ')}）`
            : '未选成员'}
        </span>
        {!rolesLoading && roles.length > 0 && (
          <span className="small muted">还可选：{candidates.filter((r) => (v.counts[r.name] ?? 0) === 0).length} 个角色</span>
        )}
      </div>

      {rolesLoading ? (
        <div className="empty">加载中…</div>
      ) : rolesError !== undefined ? (
        <div className="error" role="alert">
          请求失败：{rolesError}{' '}
          <button className="rel-link" onClick={onReloadRoles}>
            重试
          </button>
        </div>
      ) : (
        <>
          {candidates.length > 8 && (
            <label className="field" htmlFor="etf-filter" style={{ marginBottom: 8 }}>
              <input
                id="etf-filter"
                value={filter}
                placeholder="筛选角色…"
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
                    <button
                      aria-label={`减少 ${r.name} 数量`}
                      disabled={count <= 0 || submitting}
                      onClick={() => bump(r.name, -1)}
                    >
                      −
                    </button>
                    <span className="n">{count}</span>
                    <button
                      aria-label={`增加 ${r.name} 数量`}
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
        </>
      )}

      <h3 style={{ marginTop: 16 }}>沉淀规则</h3>
      <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={v.depositEnabled}
          disabled={submitting}
          onChange={(e) => set('depositEnabled', e.target.checked)}
        />
        <span>启用沉淀（关 = 任务完成时不提示落库）</span>
      </label>
      {v.depositEnabled && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <label className="field" htmlFor="etf-defaultLayer">
            <span className="label">默认层</span>
            <select
              id="etf-defaultLayer"
              value={v.defaultLayer}
              disabled={submitting}
              onChange={(e) => set('defaultLayer', e.target.value)}
            >
              {DEPOSIT_LAYERS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="etf-defaultType">
            <span className="label">默认类型</span>
            <select
              id="etf-defaultType"
              value={v.defaultType}
              disabled={submitting}
              onChange={(e) => set('defaultType', e.target.value)}
            >
              {DEPOSIT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="etf-priority">
            <span className="label">优先级</span>
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
            <span className="small">要求备注（require_note）</span>
          </label>
        </div>
      )}

      <label className="field" htmlFor="etf-teamsDir" style={{ marginTop: 16 }}>
        <span className="label">团队目录（teams_dir，必填）</span>
        <input
          id="etf-teamsDir"
          value={v.teamsDir}
          placeholder="如 D:\prism-home\teams"
          disabled={submitting}
          onChange={(e) => set('teamsDir', e.target.value)}
        />
        {defaultTeamsDir === undefined && (
          <span className="small muted">
            未从 <span className="mono">GET /api/teams</span> 拿到默认目录 → 必须手动填写。
          </span>
        )}
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        <button onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button className="primary" onClick={() => void submit()} disabled={submitting || v.teamsDir.trim() === ''}>
          {submitting ? '保存中…' : '保存修改'}
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
function describeFailure(raw: string, teamId: string): string {
  const idx = raw.indexOf(': ')
  const envelopeCode = idx === -1 ? '' : raw.slice(0, idx)
  const message = idx === -1 ? raw : raw.slice(idx + 2)

  // 无 code = fetch 抛错或响应不是 JSON（服务未起/代理错误页）
  if (envelopeCode === '') {
    return `创建失败：无法连接服务（${raw}）。检查 \`prism serve\` 是否在运行，然后重试。`
  }
  // message 开头的具体码（全角/半角冒号都认）
  const detailCode = /^([a-z_]+)\s*[:：]/.exec(message)?.[1] ?? ''
  const code = detailCode !== '' ? detailCode : envelopeCode
  const detail = message.replace(/^[a-z_]+\s*[:：]\s*/, '')

  if (code === 'teams_dir_required') {
    return '创建失败：未指定团队目录（防误写真实宿主）。请在下方「写入目录」填入 teams 目录后重试。'
  }
  if (code === 'team_id_invalid') return '创建失败：团队 ID 不合法。只能用小写字母、数字和连字符。'
  if (code === 'member_role_unknown' || code === 'role_not_found') {
    const matched = /角色(?:不在角色库中|不存在)\s*[:：]\s*([^\s（(]+)/.exec(detail)
    return `创建失败：角色「${matched?.[1] ?? '未知'}」不存在。刷新角色库后重选。`
  }
  if (code === 'members_invalid' || code === 'invalid_members') {
    return `创建失败：成员列表不合法（${detail}）。`
  }
  if (code === 'id_conflict' || code === 'team_exists') {
    return `创建失败：团队「${teamId}」已存在（未覆盖）。换一个 ID，或先删除原定义文件。`
  }
  // bad_request 且无具体码：直接把服务端原因（已含可执行信息）呈现出来
  if (envelopeCode === 'bad_request') return `创建失败：${detail}`
  return `创建失败：${code}：${message}`
}
