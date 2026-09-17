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
  adaptWorkflowParse,
  teamApi,
  type RoleDefinition,
  type TeamDefinition,
  type TeamMember,
  type WorkflowStage,
} from '../../api-team.ts'
import { useT } from '../../i18n.ts'
import {
  buildCreateInput,
  buildUpdatePatch,
  validateCreate,
  verifyCreated,
  type TeamFormValues,
} from './form-logic.ts'
import { describeFailure, isStaleWrite, type TFunc } from './errors.ts'
import { DepositRules } from './parts/DepositRules.tsx'
import { MemberPicker } from './parts/MemberStepper.tsx'
import { WorkflowEditor } from './parts/WorkflowEditor.tsx'
import { FIELD_ORDER, TEMPLATE_LABEL, TEMPLATE_STAGES, type Template } from './templates.ts'
import { draftFromParse, draftFromStages } from './workflow-model.ts'

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

/**
 * 模板阶段 → 编排器的起始卡片（仅 create）。
 *
 * ⚠ 只预填**阶段名**：模板的负责角色（`dev` / `tester` 等）是服务端模板文件里的东西，
 * web 的 `TEMPLATE_STAGES` 只有阶段名的字典键。**不编造**角色——空着由用户指派，
 * 或干脆不动（服务端按模板落盘时自会带上它自己的角色）。
 *
 * ⚠ `custom` 的起点是**一张空白阶段卡**（O-1 队长裁决，2026-09-17），与
 * `TEMPLATE_STAGES.custom`（= minimal）**有意不同**：后者记的是「服务端**没收到** template
 * 时会落什么盘」（`buildCreateInput` 对 custom 不发 `workflow_template`，服务端按 minimal
 * 兜底；`verifyCreated` 的回读预期也用它）。那是**服务端的兜底**，不是给用户看的起点——
 * 若照它预填，选了 custom 也照样出现三张卡，「自定义」这个选项就没有意义了。
 * 注意：custom 且用户把卡**删光**时我们仍**不发** workflow 段，文件按 minimal 骨架落盘
 * （'teams.form.customHint' 已如实告知）。
 */
function templateStages(t: TFunc, template: Template): WorkflowStage[] {
  if (template === 'custom') {
    return [
      { order: 1, stage: '', roles: [], mode: 'serial', input: '', output: '', done: '', reflow: '' },
    ]
  }
  return TEMPLATE_STAGES[template].map((key, index) => ({
    order: index + 1,
    stage: t(key),
    roles: [],
    mode: 'serial',
    input: '',
    output: '',
    done: '',
    reflow: '',
  }))
}

/** 初值：create 预选 1 个 dev-1 + 1 个 tester（与 F-C1「最小可用模板」口径一致）。 */
function initialValues(props: TeamFormProps, t: TFunc): TeamFormValues {
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
    /**
     * v11 F2：工作流初值两来源——
     * create = 所选模板的阶段；edit = **本文件**的原始底账（经 `adaptWorkflowParse`：
     * 阶段 / 列集 / 行身份全部由 `workflow_raw` 推出，**不**拿 extends 合并后的 `workflow`
     * 播种——M-6：合并结果里父级的表恒胜出，混用会「显示父级、写进本文件」）。
     */
    workflow:
      props.mode === 'edit'
        ? draftFromParse(adaptWorkflowParse(props.team))
        : draftFromStages(templateStages(t, 'minimal')),
    ...(props.mode === 'edit' && props.team.source_mtime !== undefined
      ? { sourceMtime: props.team.source_mtime }
      : {}),
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

  const [baseline, setBaseline] = useState<TeamFormValues>(() => initialValues(props, t))
  const [v, setV] = useState<TeamFormValues>(baseline)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [alert, setAlert] = useState('')
  /** T4：保存后抽屉不立即关闭，把服务端 warning 留在保存按钮上方。 */
  const [saveWarn, setSaveWarn] = useState<string[]>([])
  /** R-6 Q1：保存成功文案也留在抽屉内（不再上抛给列表提示条）。 */
  const [saveOk, setSaveOk] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** v11 F2：保存撞上「文件被别人改过」（409 stale_write）→ 给「重新加载」出口，不静默覆盖。 */
  const [stale, setStale] = useState(false)
  const summaryRef = useRef<HTMLDivElement | null>(null)
  const seeded = useRef(false)
  /** create：上一次套用的模板（用户换模板 ⇒ 重铺阶段草稿，见下）。 */
  const appliedTemplate = useRef<TeamFormValues['template']>(baseline.template)
  /** 点过「重新加载」后等新详情到手的闸门（到了才重播种，见下）。 */
  const awaitingReseed = useRef(false)

  /**
   * 陈旧写之后点「重新加载」：`onSaved` 触发父级重取列表与详情，新详情到手时**重播种本表单**。
   *
   * 为什么必须重播种：`baseline` 是初值快照，不跟着 props 走；若只刷新外部数据而不重播种，
   * 「重新加载」就只是改了个提示条——用户拿的还是旧底账，一存还是覆盖别人的改动
   * （这正是 R-v11-15 要防的 lost update）。**只在用户主动点过之后**才重播种，
   * 所以日常保存后的 reload 不会吃掉正在编辑的输入。
   */
  const teamProp = props.mode === 'edit' ? props.team : undefined
  useEffect(() => {
    if (!awaitingReseed.current || teamProp === undefined) return
    awaitingReseed.current = false
    const next = initialValues(props, t)
    setBaseline(next)
    setV(next)
    setStale(false)
    setAlert('')
    setSaveOk('')
    setSaveWarn([])
  }, [teamProp])

  /**
   * create：换模板 ⇒ 重铺阶段草稿（模板就是「起点」的定义，换起点自然换阶段）。
   * 语言变化**不**重铺（草稿里的阶段名是用户可编辑的字符串，重铺会吃掉编辑）。
   */
  useEffect(() => {
    if (!isCreate || appliedTemplate.current === v.template) return
    appliedTemplate.current = v.template
    setV((prev) => ({ ...prev, workflow: draftFromStages(templateStages(t, prev.template)) }))
  }, [isCreate, v.template, t])

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
      /**
       * 乐观并发的收尾（R-v11-15）：服务端返回**写后**的 `source_mtime`，必须顶掉表单里的旧值——
       * 不然第二次保存带的还是上一次读到的 mtime，而文件刚被自己改过 ⇒ 必然 409，
       * 用户会撞上一个「我什么都没改也被说成别人改过」的假冲突。
       */
      if (result.source_mtime !== undefined) set('sourceMtime', result.source_mtime)
      // 服务端的 issues（如 members 变更触发的 workflow_pruned）必须可见，不静默
      const warns = (result.issues ?? []).filter((i) => i.level !== 'error').map((i) => i.message)
      // T4 + R-6 Q1：成功文案与 warning 都留在抽屉内（保存按钮上方），抽屉不关
      setSaveWarn(warns)
      setSaveOk(t('teams.form.updated', { id: team.team_id, fields: built.fields.join(', ') }))
      props.onSaved()
    } catch (e) {
      // R-6 Q1：失败就地可见、可改（不再上抛给列表提示条）
      const raw = e instanceof Error ? e.message : String(e)
      setAlert(describeFailure(t, raw, team.team_id))
      // v11 F2（R-v11-15）：陈旧写不是「参数错了」，是「底账过期了」——给重新加载的出口。
      setStale(isStaleWrite(raw))
    } finally {
      setSubmitting(false)
    }
  }

  /** 陈旧写之后的重加载：先拉新数据，新详情到手再重播种（见 `awaitingReseed` 的注）。 */
  const reloadAfterStale = () => {
    if (props.mode !== 'edit') return
    awaitingReseed.current = true
    props.onSaved()
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
          {/* 陈旧写：文案说了「请先重新加载」，这里就得有那颗按钮（否则用户只能自己猜怎么刷新） */}
          {stale && props.mode === 'edit' && (
            <div className="row" style={{ marginTop: 'var(--s-2)' }}>
              <button type="button" onClick={reloadAfterStale} disabled={submitting}>
                {t('teams.wf.staleReload')}
              </button>
            </div>
          )}
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

      {/* 3 工作流（v11 F2）：create 先选模板作**起点**，再在编排器里增删改；
          edit 直接编排服务端给的底账（列集、行身份与阶段全部取自本文件的 `workflow_raw`）。 */}
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
            <div>{t('teams.form.templateHint')}</div>
            {v.template === 'custom' && <div style={{ marginTop: 'var(--s-1)' }}>{t('teams.form.customHint')}</div>}
          </div>
        </>
      )}

      <WorkflowEditor
        draft={v.workflow}
        roles={candidates}
        rolesLoading={rolesLoading}
        rolesError={rolesError}
        onReloadRoles={onReloadRoles}
        disabled={submitting}
        onChange={(next) => set('workflow', next)}
      />

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
