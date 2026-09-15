/**
 * 团队表单（T5：新建 / 编辑两份 ~200 行重复表单合一）。
 *
 * `mode: 'create' | 'edit'`，差异**只保留在必要处**并就地注释：
 * - create：要 `team_id`（含查重）、要选工作流模板、提交后回读校验、`FIELD_ORDER` 逐字段定位；
 * - edit：身份不可改，只提交**改动过**的字段（PATCH 语义），改 members 需 `roles_dir`；
 *   校验失败只给一条 `alert`（原实现如此），不逐字段定位。
 * 字段校验口径以两份中**较全者**为准（create 的 40/200 长度限制 + edit 的「至少留 1 人」）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  teamApi,
  type RoleDefinition,
  type TeamDefinition,
  type TeamMember,
} from '../../api-team.ts'
import { useT } from '../../i18n.ts'
import {
  buildCreateInput,
  buildUpdatePatch,
  validateCreate,
  verifyCreated,
  type TeamFormValues,
} from './form-logic.ts'
import { describeFailure } from './errors.ts'
import { DepositRules } from './parts/DepositRules.tsx'
import { MemberPicker } from './parts/MemberStepper.tsx'
import { FIELD_ORDER, TEMPLATE_LABEL, TEMPLATE_STAGES, type Template } from './templates.ts'

interface CommonProps {
  roles: RoleDefinition[]
  rolesLoading: boolean
  rolesError: string | undefined
  onReloadRoles: () => void
  defaultTeamsDir: string | undefined
  onCancel: () => void
}

export type TeamFormProps = (
  | {
      mode: 'create'
      existingIds: string[]
      onCreated: (id: string) => void
    }
  | {
      mode: 'edit'
      team: TeamDefinition
      rolesDir: string | undefined
      /** R-6 Q1：保存反馈只留抽屉内 → 父级只负责刷新，文案与 warning 不再上抛。 */
      onSaved: () => void
    }
) &
  CommonProps

/** 初值：create 预选 1 个 dev-1 + 1 个 tester（与 F-C1「最小可用模板」口径一致）。 */
function initialValues(props: TeamFormProps): TeamFormValues {
  const counts: Record<string, number> = {}
  if (props.mode === 'create') {
    for (const name of ['dev-1', 'tester']) {
      if (props.roles.some((r) => r.name === name)) counts[name] = 1
    }
  } else {
    for (const m of props.team.members) counts[m.role] = m.count
  }
  return {
    teamId: '',
    name: props.mode === 'edit' ? props.team.name : '',
    description: props.mode === 'edit' ? props.team.description : '',
    counts,
    filter: '',
    template: 'minimal',
    depositEnabled: props.mode === 'edit' ? props.team.deposit.enabled : false,
    defaultLayer: props.mode === 'edit' ? props.team.deposit.default_layer : 'project',
    defaultType: props.mode === 'edit' ? props.team.deposit.default_type : 'other',
    priority: props.mode === 'edit' ? props.team.deposit.priority : 'medium',
    requireNote: props.mode === 'edit' ? props.team.deposit.require_note : false,
    teamsDir: props.defaultTeamsDir ?? '',
  }
}

export function TeamForm(props: TeamFormProps) {
  const t = useT()
  const { roles, rolesLoading, rolesError, onReloadRoles, defaultTeamsDir, onCancel } = props
  const isCreate = props.mode === 'create'
  const idPrefix = isCreate ? 'ntf-' : 'etf-'
  const editTeam = props.mode === 'edit' ? props.team : undefined
  const rolesDir = props.mode === 'edit' ? props.rolesDir : undefined

  const [baseline] = useState<TeamFormValues>(() => initialValues(props))
  const [v, setV] = useState<TeamFormValues>(baseline)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [alert, setAlert] = useState('')
  /** T4：保存后抽屉不立即关闭，把服务端 warning 留在保存按钮上方。 */
  const [saveWarn, setSaveWarn] = useState<string[]>([])
  /** R-6 Q1：保存成功文案也留在抽屉内（不再上抛给列表提示条）。 */
  const [saveOk, setSaveOk] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const summaryRef = useRef<HTMLDivElement | null>(null)
  const seeded = useRef(false)

  // 角色库是异步到的：到手后补一次「预选 1 个 dev-1 + 1 个 tester」；用户已动手则不覆盖（仅 create）
  useEffect(() => {
    if (!isCreate || seeded.current || roles.length === 0) return
    seeded.current = true
    setV((prev) => {
      if (Object.values(prev.counts).some((c) => c > 0)) return prev
      const counts = { ...prev.counts }
      for (const name of ['dev-1', 'tester']) {
        if (roles.some((r) => r.name === name)) counts[name] = 1
      }
      return { ...prev, counts }
    })
  }, [roles, isCreate])

  const set = <K extends keyof TeamFormValues>(key: K, value: TeamFormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }))

  /** 编辑候选 = 角色库 + 定义里出现但角色库已没有的角色（后者必须可见，否则无法移除）。 */
  const candidates = useMemo(() => {
    if (editTeam === undefined) return roles
    const known = new Set(roles.map((r) => r.name))
    const orphan = [...new Set(editTeam.members.map((m) => m.role))]
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
  }, [roles, editTeam])

  const members = useMemo<TeamMember[]>(
    () =>
      Object.entries(v.counts)
        .filter(([, count]) => count > 0)
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => a.role.localeCompare(b.role)),
    [v.counts],
  )
  const bump = (role: string, delta: number) =>
    setV((prev) => {
      const next = Math.max(0, Math.min(9, (prev.counts[role] ?? 0) + delta))
      return { ...prev, counts: { ...prev.counts, [role]: next } }
    })

  /** 提交：只做「校验 → 调接口 → 落地提示」的编排，纯逻辑在 form-logic.ts。 */
  const submit = async () => {
    if (props.mode === 'create') return submitCreate()
    return submitEdit()
  }

  async function submitCreate() {
    if (props.mode !== 'create') return
    const found = validateCreate(t, v, members, roles, props.existingIds)
    const bad = FIELD_ORDER.filter((key) => found[key] !== undefined)
    if (bad.length > 0) {
      setErrors(found)
      setAlert(t('teams.form.fixCount', { n: bad.length }))
      const el = document.getElementById(`${idPrefix}${bad[0]}`)
      el?.scrollIntoView({ block: 'center' })
      el?.focus()
      return
    }
    setErrors({})
    setAlert('')
    setSaveOk('')
    setSaveWarn([])
    const input = buildCreateInput(v, members)
    setSubmitting(true)
    try {
      const result = await teamApi.create(input)
      const warning = await verifyCreated(t, input, members)
      if (props.mode === 'create') {
        // R-6 Q1：创建结果就地留在抽屉内（含回读比对 warning），父级只刷新列表 + 记下待选中 id
        setSaveOk(t('teams.form.created', { id: input.team_id, path: result.path }))
        setSaveWarn(warning === '' ? [] : [warning])
        props.onCreated(input.team_id)
      }
    } catch (e) {
      setAlert(describeFailure(t, e instanceof Error ? e.message : String(e), v.teamId.trim()))
      summaryRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  async function submitEdit() {
    if (props.mode !== 'edit') return
    const team = props.team
    const built = buildUpdatePatch(t, v, baseline, members, team, rolesDir)
    if (!built.ok) {
      setAlert(built.error)
      return
    }
    setAlert('')
    setSaveOk('')
    setSubmitting(true)
    try {
      const result = await teamApi.updateTeam(team.team_id, built.patch)
      // 服务端的 issues（如 members 变更触发的 workflow_pruned）必须可见，不静默
      const warns = (result.issues ?? []).filter((i) => i.level !== 'error').map((i) => i.message)
      // T4 + R-6 Q1：成功文案与 warning 都留在抽屉内（保存按钮上方），抽屉不关
      setSaveWarn(warns)
      setSaveOk(t('teams.form.updated', { id: team.team_id, fields: built.fields.join(', ') }))
      props.onSaved()
    } catch (e) {
      // R-6 Q1：失败就地可见、可改（不再上抛给列表提示条）
      setAlert(describeFailure(t, e instanceof Error ? e.message : String(e), team.team_id))
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit =
    !submitting &&
    !rolesLoading &&
    roles.length > 0 &&
    v.teamsDir.trim() !== '' &&
    members.length > 0
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
      {isCreate ? (
        <div className="row" style={{ gap: 'var(--s-2)', marginBottom: 'var(--s-3)', flexWrap: 'wrap' }}>
          {t('teams.form.steps')
            .split('›')
            .map((step) => (
              <span className="tag" key={step}>
                {step.trim()}
              </span>
            ))}
        </div>
      ) : (
        <div className="small muted" style={{ marginBottom: 'var(--s-3)' }}>
          {t('teams.form.editHint')}
        </div>
      )}

      {alert !== '' && (
        <div className="error" role="alert" tabIndex={-1} ref={summaryRef} style={{ marginBottom: 'var(--s-3)' }}>
          {alert}
        </div>
      )}

      {/* 1 身份 */}
      <div className="form-grid">
        {isCreate && (
          <label className="field" htmlFor={`${idPrefix}teamId`}>
            <span className="label">{t('teams.form.idLabel')}</span>
            <input
              id={`${idPrefix}teamId`}
              value={v.teamId}
              placeholder="core-dev-v2"
              disabled={submitting}
              aria-describedby={errors.teamId !== undefined ? `${idPrefix}teamId-err` : undefined}
              onChange={(e) => set('teamId', e.target.value)}
            />
            {errors.teamId !== undefined && (
              <span className="err-text" id={`${idPrefix}teamId-err`}>
                {errors.teamId}
              </span>
            )}
          </label>
        )}
        <label className="field" htmlFor={`${idPrefix}name`}>
          <span className="label">
            {isCreate ? t('teams.form.nameLabel') : t('common.name')}
          </span>
          <input
            id={`${idPrefix}name`}
            value={v.name}
            placeholder={isCreate ? t('teams.form.name') : undefined}
            disabled={submitting}
            aria-describedby={errors.name !== undefined ? `${idPrefix}name-err` : undefined}
            onChange={(e) => set('name', e.target.value)}
          />
          {errors.name !== undefined && (
            <span className="err-text" id={`${idPrefix}name-err`}>
              {errors.name}
            </span>
          )}
        </label>
        <label className="field" htmlFor={`${idPrefix}description`} style={{ gridColumn: '1 / -1' }}>
          <span className="label">{isCreate ? t('teams.form.descLabel') : t('teams.form.description')}</span>
          <textarea
            id={`${idPrefix}description`}
            rows={2}
            value={v.description}
            placeholder={isCreate ? t('teams.form.descPlaceholder') : undefined}
            disabled={submitting}
            onChange={(e) => set('description', e.target.value)}
          />
          {errors.description !== undefined && <span className="err-text">{errors.description}</span>}
        </label>
      </div>

      {/* 2 成员 */}
      <MemberPicker
        candidates={candidates}
        counts={v.counts}
        filter={v.filter}
        loading={rolesLoading}
        error={rolesError}
        membersError={errors.members}
        disabled={submitting}
        idPrefix={idPrefix}
        showIssues={isCreate}
        showEmptyState={isCreate}
        onReloadRoles={onReloadRoles}
        onFilter={(text) => set('filter', text)}
        onBump={bump}
      />

      {/* 3 工作流（仅 create：模板决定落地阶段；edit 走 PATCH，收窄由服务端做） */}
      {isCreate && (
        <>
          <h4>{t('teams.form.workflowTitle')}</h4>
          <div className="row" style={{ gap: 'var(--s-2)' }}>
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
          <div className="small muted" style={{ marginTop: 'var(--s-2)' }}>
            {t('teams.form.templateStages', {
              n: TEMPLATE_STAGES[v.template].length,
              stages: TEMPLATE_STAGES[v.template].map((k) => t(k)).join(' → '),
            })}
            <div style={{ marginTop: 'var(--s-1)' }}>{t('teams.form.templateHint')}</div>
            {v.template === 'custom' && (
              <div style={{ marginTop: 'var(--s-1)' }}>
                {t('teams.form.customHint', { path: `${v.teamsDir || '<teams_dir>'}/${v.teamId || '<id>'}.md` })}
              </div>
            )}
          </div>
        </>
      )}

      {/* 4 沉淀规则 */}
      <DepositRules
        v={v}
        idPrefix={idPrefix}
        disabled={submitting}
        {...(errors.defaultLayer !== undefined ? { error: errors.defaultLayer } : {})}
        onChange={(patch) => setV((prev) => ({ ...prev, ...patch }))}
      />

      {/* 5 写入目录 + 提交 */}
      <label className="field" htmlFor={`${idPrefix}teamsDir`} style={{ marginTop: 'var(--s-4)' }}>
        <span className="label">{isCreate ? t('teams.form.writeDirHint') : t('teams.dir')}</span>
        <input
          id={`${idPrefix}teamsDir`}
          value={v.teamsDir}
          placeholder="/path/to/prism-home/teams"
          disabled={submitting}
          aria-describedby={errors.teamsDir !== undefined ? `${idPrefix}teamsDir-err` : undefined}
          onChange={(e) => set('teamsDir', e.target.value)}
        />
        {defaultTeamsDir === undefined ? (
          <span className="small muted">{t('teams.dirManual')}</span>
        ) : (
          isCreate && <span className="small muted">{t('teams.dirHint')}</span>
        )}
        {errors.teamsDir !== undefined && (
          <span className="err-text" id={`${idPrefix}teamsDir-err`}>
            {errors.teamsDir}
          </span>
        )}
      </label>

      {/* R-6 Q1：保存成功的反馈贴在保存按钮上方（与 T4 warning 同槽），抽屉不关 */}
      {saveOk !== '' && (
        <div className="banner small" role="status">
          {saveOk}
        </div>
      )}

      {/* T4：收窄预览——服务端 warning 文本已含阶段名，原样逐条列出，不猜 */}
      {saveWarn.length > 0 && (
        <div className="scope-callout" role="status">
          <div className="small muted">{t('teams.form.warnTitle', { n: saveWarn.length })}</div>
          {saveWarn.map((w, i) => (
            <div key={`warn-${i}`} className="small">
              {w}
            </div>
          ))}
          <div className="small muted">{t('teams.form.warnHint')}</div>
        </div>
      )}

      <div className="form-actions" style={{ marginTop: 'var(--s-3)' }}>
        {isCreate && disabledReason !== '' && <span className="small muted">{disabledReason}</span>}
        <button onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </button>
        {isCreate && (
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
        )}
        <button
          className="primary"
          onClick={() => void submit()}
          disabled={isCreate ? !canSubmit : submitting || v.teamsDir.trim() === ''}
        >
          {submitting
            ? isCreate
              ? t('teams.form.submittingNew')
              : t('teams.form.submittingEdit')
            : isCreate
              ? t('teams.form.submitNew')
              : t('teams.form.submitEdit')}
        </button>
      </div>
    </div>
  )
}
