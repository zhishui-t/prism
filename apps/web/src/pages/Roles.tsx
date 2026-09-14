import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ROLE_COLOR_OPTIONS,
  THOUGHT_LEVELS,
  teamApi,
  type KnowledgeBinding,
  type RoleColor,
  type RoleDefinition,
  type RoleWriteInput,
  type ThoughtLevel,
  type ValidationIssue,
} from '../api-team.ts'
import { EffectiveSkills } from '../components/EffectiveSkills.tsx'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { Drawer, PageHead, Pane, StatusTag, firstSentence } from '../components/ui.tsx'
import { useT } from '../i18n.ts'

const COLOR_MAP: Record<string, string> = {
  red: '#e05555',
  blue: '#5b8cff',
  green: '#35c46b',
  yellow: '#e0c23a',
  purple: '#a06bff',
  orange: '#e08a3a',
  pink: '#e06ba0',
  cyan: '#3ac0c4',
}

/** 知识范围（与服务端 `role-create.ts` 的 `KNOWLEDGE_LAYERS` 同口径）。 */
const LAYERS: Array<{ value: KnowledgeBinding['layers'][number]; label: string }> = [
  { value: 'global', label: 'global 全局' },
  { value: 'project', label: 'project 项目' },
  { value: 'role', label: 'role 专家' },
]

/** 与服务端 `packages/agents/src/role/write.ts` 的 `KEBAB_CASE_RE` 同口径（前端先拦，服务端仍校验）。 */
const ROLE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 角色页：左列表 + 右详情。
 *
 * 2026-09-14 重构：原先是一张 5 列宽表，**描述列是大段白文**（每行 3–5 行），
 * 名称只是一个按钮，详情渲染在**表格下方**——点完还得往下找，用户反馈「一堆信息、没重点」。
 * 现在：列表行 = 角色名 + 一句话职责（两行截断）+ 状态标签；详情在主从右侧，
 * 核心第一原则置顶高亮，职责/边界分栏，能力与知识绑定成标签，正文折叠在最后。
 *
 * 增删改与 CLI/MCP 同名同位（`new` / `edit` / `rm`），表单在抽屉里打开。
 */
export function RolesPage({
  sel,
  onSelect,
  onOpenUsageSkills,
}: {
  /** 当前展开的角色（来自 hash 深链） */
  sel?: string
  onSelect?: (name: string) => void
  /** 跳到技能页看反向视图 */
  onOpenUsageSkills?: () => void
} = {}) {
  const t = useT()
  const roles = useAsync(() => teamApi.roles(), [])
  const [formOpen, setFormOpen] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [filter, setFilter] = useState('')

  const selected = sel ?? ''
  const detail = useAsync(
    () => (selected !== '' ? teamApi.role(selected) : Promise.resolve(undefined)),
    [selected],
  )

  const list = roles.data?.roles ?? []
  const rolesDir = roles.data?.rolesDir

  /** 写操作统一出口：刷新列表 + 置提示条（成功保留详情，删除后收起）。 */
  const afterWrite = (kind: 'ok' | 'err', text: string, opts: { close?: boolean; keep?: string } = {}) => {
    setBanner({ kind, text })
    roles.reload()
    detail.reload()
    if (opts.close === true) onSelect?.('')
    if (opts.keep !== undefined) onSelect?.(opts.keep)
  }

  const keyword = filter.trim().toLowerCase()
  const shown =
    keyword === ''
      ? list
      : list.filter(
          (r) => r.name.toLowerCase().includes(keyword) || r.description.toLowerCase().includes(keyword),
        )

  useEffect(() => {
    // 列表刷新后，深链指向的角色已不存在 → 收起详情（不留空壳）
    if (selected !== '' && roles.data !== undefined && !list.some((r) => r.name === selected)) {
      onSelect?.('')
    }
  }, [roles.data, selected, list, onSelect])

  return (
    <>
      <PageHead title={t('roles.title')} sub={t('roles.desc')}>
        <button
          className="primary"
          onClick={() => {
            setFormOpen(true)
            setBanner(null)
          }}
        >
          {t('roles.new')}
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
        loading={roles.loading}
        error={roles.error}
        empty={!roles.loading && !roles.error && list.length === 0}
        emptyText={t('roles.empty')}
      >
        <div className="md">
          <div className="md-list">
            <div style={{ padding: '4px 4px 8px' }}>
              <input
                style={{ width: '100%' }}
                placeholder={t('roles.filterPlaceholder')}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            {shown.length === 0 && (
              <div className="small muted" style={{ padding: '8px 10px' }}>
                {t('common.empty')}
              </div>
            )}
            {shown.map((role) => (
              <button
                key={role.name}
                className={`md-row${selected === role.name ? ' sel' : ''}`}
                onClick={() => {
                  onSelect?.(role.name)
                  setBanner(null)
                }}
              >
                <span className="t">
                  <span className="dot" style={{ background: COLOR_MAP[role.color ?? ''] ?? 'var(--accent)' }} />
                  {role.name}
                </span>
                <span className="s">{firstSentence(role.description, 76)}</span>
                <span className="tags">
                  <StatusTag kind={role.installed === false ? 'warn' : 'ok'}>
                    {role.installed === false ? t('common.notInstalled') : t('common.installed')}
                  </StatusTag>
                  <IssueBadge issues={role.issues} />
                </span>
              </button>
            ))}
          </div>

          <div className="md-detail">
            {selected === '' ? (
              <Pane>
                <div className="small muted">{t('roles.selectHint')}</div>
              </Pane>
            ) : (
              <RoleDetail
                name={selected}
                detail={detail.data}
                loading={detail.loading}
                error={detail.error}
                rolesDir={rolesDir}
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
          title={
            selected !== '' ? `${t('roles.form.edit')} · ${selected}` : t('roles.form.new')
          }
          onClose={() => setFormOpen(false)}
        >
          {selected !== '' && detail.data !== undefined ? (
            <RoleEditForm
              role={detail.data}
              defaultRolesDir={rolesDir}
              onCancel={() => setFormOpen(false)}
              onSaved={(text) => {
                setFormOpen(false)
                afterWrite('ok', text, { keep: selected })
              }}
              onFailed={(text) => afterWrite('err', text, { keep: selected })}
            />
          ) : (
            <NewRoleForm
              existingNames={list.map((r) => r.name)}
              defaultRolesDir={rolesDir}
              onCancel={() => setFormOpen(false)}
              onCreated={(name, path) => {
                setFormOpen(false)
                afterWrite('ok', `${name} → ${path}`, { keep: name })
              }}
            />
          )}
        </Drawer>
      )}
    </>
  )
}

/* ==================== 角色详情（读 + 删除入口） ==================== */

function RoleDetail({
  name,
  detail,
  loading,
  error,
  rolesDir,
  onOpenUsage,
  onEdit,
  onDeleted,
}: {
  name: string
  detail: RoleDefinition | undefined
  loading: boolean
  error: string | undefined
  rolesDir: string | undefined
  onOpenUsage?: () => void
  onEdit: () => void
  onDeleted: (text: string) => void
}) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [delError, setDelError] = useState('')
  /** `null` = 跟随父级给的默认目录；一旦用户动过就固化为自己的值（可清空）。 */
  const [dirOverride, setDirOverride] = useState<string | null>(null)
  /** 正文默认折叠——列表页要「有重点」，长正文按需展开。 */
  const [showBody, setShowBody] = useState(false)

  const dirValue = dirOverride ?? rolesDir ?? ''
  const effectiveDir = dirValue.trim()

  useEffect(() => {
    setConfirming(false)
    setDelError('')
    setShowBody(false)
  }, [name])

  const onDelete = async () => {
    if (effectiveDir === '') {
      setDelError('未指定角色目录（roles_dir）——请在下方填写后再删除。')
      return
    }
    setDeleting(true)
    setDelError('')
    try {
      const result = await teamApi.deleteRole(name, effectiveDir)
      onDeleted(`${name} 已删除（${result.removed.length} 个文件；不可逆）`)
    } catch (e) {
      setDelError(describeRoleFailure(e instanceof Error ? e.message : String(e), name))
    } finally {
      setDeleting(false)
    }
  }

  const duties = useMemo(() => splitSection(detail?.body ?? '', ['职责']), [detail?.body])
  const bounds = useMemo(() => splitSection(detail?.body ?? '', ['边界（禁止）', '边界']), [detail?.body])

  return (
    <>
      <Pane
        head={
          <div className="pane-head">
            <h3 className="mono" style={{ color: COLOR_MAP[detail?.color ?? ''] ?? 'var(--tx)' }}>
              {name}
            </h3>
            {detail?.installed !== undefined && (
              <StatusTag kind={detail.installed ? 'ok' : 'warn'}>
                {detail.installed ? t('common.installed') : t('common.notInstalled')}
              </StatusTag>
            )}
            <IssueBadge issues={detail?.issues} />
            <span className="spacer">
              {detail !== undefined && (
                <button className="primary" onClick={onEdit}>
                  {t('common.edit')}
                </button>
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
              <h4>{t('roles.principle')}</h4>
              <div className="highlight">
                <div style={{ fontWeight: 600 }}>
                  {detail.principle !== '' ? detail.principle : t('roles.principleMissing')}
                </div>
              </div>

              {detail.description !== '' && (
                <>
                  <h4>{t('common.description')}</h4>
                  <div className="small">{detail.description}</div>
                </>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 14 }}>
                <div>
                  <h4>{t('roles.duties')}</h4>
                  {duties.length === 0 ? (
                    <div className="small muted">—</div>
                  ) : (
                    <ul className="lines">
                      {duties.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h4>{t('roles.bounds')}</h4>
                  {bounds.length === 0 ? (
                    <div className="small muted">—</div>
                  ) : (
                    <ul className="lines">
                      {bounds.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <h4>{t('roles.capabilities')}</h4>
              <div className="chips">
                {(detail.skills ?? []).length === 0 ? (
                  <span className="small muted">—</span>
                ) : (
                  detail.skills?.map((s) => <StatusTag key={s}>{s}</StatusTag>)
                )}
              </div>

              <h4>{t('roles.knowledgeScope')}</h4>
              <div className="chips">
                {(detail.knowledge?.layers ?? []).length === 0 ? (
                  <span className="small muted">—</span>
                ) : (
                  detail.knowledge?.layers.map((l) => <StatusTag key={l}>{l}</StatusTag>)
                )}
              </div>

              <h4>{t('roles.issues')}</h4>
              {(detail.issues?.length ?? 0) === 0 ? (
                <StatusTag kind="ok">{t('common.valid')}</StatusTag>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 70 }}>{t('roles.issueLevel')}</th>
                      <th style={{ width: 170 }}>{t('roles.issueCode')}</th>
                      <th>{t('roles.issueDetail')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.issues?.map((issue, i) => (
                      <tr key={`${issue.code}-${i}`}>
                        <td>
                          <StatusTag kind={issue.level === 'error' ? 'err' : 'warn'}>{issue.level}</StatusTag>
                        </td>
                        <td className="mono small">{issue.code}</td>
                        <td className="small">{issue.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h4>{t('common.body')}</h4>
              <button onClick={() => setShowBody((prev) => !prev)}>
                {showBody ? t('common.close') : `${detail.body.length} chars`}
              </button>
              {showBody && <pre className="entry-body" style={{ marginTop: 10 }}>{detail.body}</pre>}
            </>
          )}
        </State>
      </Pane>

      {/* F-D2 有效集（正向视图）：与技能页「使用情况」互链 */}
      {detail !== undefined && (
        <Pane>
          <EffectiveSkills key={name} role={name} roleFixed onOpenUsage={onOpenUsage} />
        </Pane>
      )}

      {confirming && (
        <Pane>
          <div className="danger-zone">
            <div className="small" style={{ marginBottom: 8 }}>
              <strong>删除是不可逆的硬删</strong>：会直接删掉宿主目录里的 <span className="mono">{name}.md</span>
              （兼容形态 <span className="mono">{name}/AGENTS.md</span> 一并删）。服务端要求显式给出目录。
            </div>
            <label className="field" htmlFor="rd-dir">
              <span className="label">角色目录（roles_dir，必填）</span>
              <input
                id="rd-dir"
                value={dirValue}
                placeholder={rolesDir ?? '如 D:\\prism-home\\agents'}
                disabled={deleting}
                onChange={(e) => setDirOverride(e.target.value)}
              />
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

/**
 * 从角色正文里抠出某个二级小节的要点（职责 / 边界）。
 * 角色正文是自由 Markdown，这里只做**尽力而为**的抽取：找不到就返回空数组，
 * 详情页仍有完整正文可看，不因抽取失败丢信息。
 */
function splitSection(body: string, headings: string[]): string[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let active = false
  for (const line of lines) {
    const heading = /^#{2,4}\s*(.+?)\s*$/.exec(line)
    if (heading !== null) {
      active = headings.some((h) => (heading[1] ?? '').startsWith(h))
      continue
    }
    if (!active) continue
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (bullet !== null) {
      out.push((bullet[1] ?? '').replace(/\*\*/g, '').trim())
      continue
    }
    const text = line.trim()
    // 小节里的普通段落（非空、非代码围栏）也算一条
    if (text !== '' && !text.startsWith('```') && !text.startsWith('|')) out.push(text)
    if (out.length >= 8) break
  }
  return out
}

/* ==================== 新建 / 修改角色（共用字段 UI） ==================== */

interface RoleFormValues {
  name: string
  description: string
  /** 能力白名单（逗号分隔） */
  skills: string
  layers: string[]
  /**
   * 知识「书」绑定（逗号分隔）。
   * 2026-09-14：界面上**不再展示**这一层（用户裁决「不显示这一层」），
   * 但表单里保留该值并在提交时**原样透传**，避免编辑一次就静默清空既有绑定。
   */
  books: string
  color: string
  model: string
  thoughtLevel: string
  body: string
  rolesDir: string
}

const EMPTY_FORM = (layers: string[]): RoleFormValues => ({
  name: '',
  description: '',
  skills: '',
  layers,
  books: '',
  color: '',
  model: '',
  thoughtLevel: '',
  body: '',
  rolesDir: '',
})

function csv(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s !== '')
}

function joinCsv(items: string[] | undefined): string {
  return (items ?? []).join(', ')
}

/** 三入口共用的字段区（`new` 不显示 name 之外的只读项，`edit` 显示全部）。 */
function RoleFields({
  v,
  set,
  submitting,
  errors,
  nameReadOnly,
  bodyHint,
}: {
  v: RoleFormValues
  set: <K extends keyof RoleFormValues>(key: K, value: RoleFormValues[K]) => void
  submitting: boolean
  errors: Record<string, string>
  /** `edit` 时角色名是主键，不可改 */
  nameReadOnly: boolean
  bodyHint: string
}) {
  const t = useT()
  return (
    <>
      <div className="form-grid">
        <label className="field" htmlFor="rf-name">
          <span className="label">
            {t('roles.form.name')}（kebab-case{nameReadOnly ? '，不可改' : '，必填'}）
          </span>
          <input
            id="rf-name"
            value={v.name}
            placeholder="dev-1"
            readOnly={nameReadOnly}
            disabled={submitting || nameReadOnly}
            aria-describedby={errors.name !== undefined ? 'rf-name-err' : undefined}
            onChange={(e) => set('name', e.target.value)}
          />
          {errors.name !== undefined && (
            <span className="err-text" id="rf-name-err">
              {errors.name}
            </span>
          )}
        </label>
        <label className="field" htmlFor="rf-color">
          <span className="label">{t('roles.form.color')}</span>
          <select
            id="rf-color"
            value={v.color}
            disabled={submitting}
            onChange={(e) => set('color', e.target.value)}
          >
            <option value="">（不变 / 缺省）</option>
            {ROLE_COLOR_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field" htmlFor="rf-description" style={{ gridColumn: '1 / -1' }}>
          <span className="label">{t('roles.form.description')}</span>
          <textarea
            id="rf-description"
            rows={2}
            value={v.description}
            placeholder="一句话说清职责 + 适用于 + 不适用于"
            disabled={submitting}
            onChange={(e) => set('description', e.target.value)}
          />
          {errors.description !== undefined && <span className="err-text">{errors.description}</span>}
        </label>
      </div>

      <div className="form-grid" style={{ marginTop: 10 }}>
        <label className="field" htmlFor="rf-skills">
          <span className="label">{t('roles.form.skills')}</span>
          <input
            id="rf-skills"
            value={v.skills}
            placeholder="kb, graph, arch"
            disabled={submitting}
            onChange={(e) => set('skills', e.target.value)}
          />
          <span className="small muted">留空 = 未声明能力（校验给 warning，不是 error）。</span>
        </label>
      </div>

      <div style={{ marginTop: 10 }}>
        <span className="label small">{t('roles.form.layers')}</span>
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          {LAYERS.map((l) => {
            const on = v.layers.includes(l.value)
            return (
              <button
                key={l.value}
                className={on ? 'primary' : ''}
                aria-pressed={on}
                disabled={submitting}
                onClick={() =>
                  set('layers', on ? v.layers.filter((x) => x !== l.value) : [...v.layers, l.value])
                }
              >
                {l.label}
              </button>
            )
          })}
        </div>
        {errors.layers !== undefined && <span className="err-text">{errors.layers}</span>}
      </div>

      <div className="form-grid" style={{ marginTop: 10 }}>
        <label className="field" htmlFor="rf-model">
          <span className="label">model（可选；空 = 清除）</span>
          <input
            id="rf-model"
            value={v.model}
            placeholder="留空即由宿主决定"
            disabled={submitting}
            onChange={(e) => set('model', e.target.value)}
          />
        </label>
        <label className="field" htmlFor="rf-thought">
          <span className="label">thoughtLevel（可选）</span>
          <select
            id="rf-thought"
            value={v.thoughtLevel}
            disabled={submitting}
            onChange={(e) => set('thoughtLevel', e.target.value)}
          >
            <option value="">（不变 / 缺省）</option>
            {THOUGHT_LEVELS.map((t2) => (
              <option key={t2} value={t2}>
                {t2}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field" htmlFor="rf-body" style={{ marginTop: 10 }}>
        <span className="label">{t('roles.form.body')}</span>
        <textarea
          id="rf-body"
          rows={10}
          className="mono"
          value={v.body}
          placeholder={bodyHint}
          disabled={submitting}
          onChange={(e) => set('body', e.target.value)}
        />
        <span className="small muted">{bodyHint}</span>
      </label>
    </>
  )
}

/** 新建角色（`POST /api/roles`，与 `prism role new` 同一实现）。 */
function NewRoleForm({
  existingNames,
  defaultRolesDir,
  onCancel,
  onCreated,
}: {
  existingNames: string[]
  defaultRolesDir: string | undefined
  onCancel: () => void
  onCreated: (name: string, path: string) => void
}) {
  const t = useT()
  const [v, setV] = useState<RoleFormValues>(() => ({ ...EMPTY_FORM(['global', 'project']), rolesDir: defaultRolesDir ?? '' }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [alert, setAlert] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const alertRef = useRef<HTMLDivElement | null>(null)

  const set = <K extends keyof RoleFormValues>(key: K, value: RoleFormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }))

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {}
    const name = v.name.trim()
    if (name === '') e.name = '角色名不能为空'
    else if (!ROLE_ID_RE.test(name)) e.name = '只能用小写字母、数字和连字符（-），且以字母或数字开头'
    else if (name.length > 40) e.name = '角色名最多 40 字符'
    else if (existingNames.includes(name)) e.name = `角色「${name}」已存在，改用「编辑」或换一个名字`
    if (v.description.length > 200) e.description = '描述最多 200 字'
    if (v.layers.length === 0) e.layers = '至少选 1 个知识层'
    if (v.rolesDir.trim() === '') e.rolesDir = '请先填写写入目录'
    return e
  }

  const submit = async () => {
    const found = validate()
    if (Object.keys(found).length > 0) {
      setErrors(found)
      setAlert(`有 ${Object.keys(found).length} 项需要修正，已在下方标出`)
      return
    }
    setErrors({})
    setAlert('')

    const skills = csv(v.skills)
    const input: RoleWriteInput = {
      name: v.name.trim(),
      roles_dir: v.rolesDir.trim(),
      knowledge: { layers: v.layers as KnowledgeBinding['layers'] },
      ...(v.description.trim() !== '' ? { description: v.description.trim() } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(v.color !== '' ? { color: v.color as RoleColor } : {}),
      ...(v.model.trim() !== '' ? { model: v.model.trim() } : {}),
      ...(v.thoughtLevel !== '' ? { thought_level: v.thoughtLevel as ThoughtLevel } : {}),
      ...(v.body.trim() !== '' ? { body: v.body } : {}),
    }

    setSubmitting(true)
    try {
      const result = await teamApi.createRole(input)
      onCreated(input.name ?? '', result.path)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      setAlert(describeRoleFailure(raw, v.name.trim()))
      alertRef.current?.focus()
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = !submitting && v.rolesDir.trim() !== '' && v.name.trim() !== '' && v.layers.length > 0

  return (
    <div>
      {alert !== '' && (
        <div className="error" role="alert" tabIndex={-1} ref={alertRef} style={{ marginBottom: 12 }}>
          {alert}
        </div>
      )}

      <RoleFields
        v={v}
        set={set}
        submitting={submitting}
        errors={errors}
        nameReadOnly={false}
        bodyHint="留空 → 用内置骨架（核心第一原则 / 职责 / 边界 / 协作位置 / 完成判定），再自行填实。"
      />

      <label className="field" htmlFor="rf-rolesDir" style={{ marginTop: 10 }}>
        <span className="label">{t('roles.form.dir')}</span>
        <input
          id="rf-rolesDir"
          value={v.rolesDir}
          placeholder="如 D:\prism-home\agents"
          disabled={submitting}
          onChange={(e) => set('rolesDir', e.target.value)}
        />
        <span className="small muted">{t('roles.form.dirHint')}</span>
        {errors.rolesDir !== undefined && <span className="err-text">{errors.rolesDir}</span>}
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        <button onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? t('common.saving') : t('roles.new')}
        </button>
      </div>
    </div>
  )
}

/** 修改角色（`PATCH /api/roles/:name`，外科式补丁——只提交改动过的字段）。 */
function RoleEditForm({
  role,
  defaultRolesDir,
  onCancel,
  onSaved,
  onFailed,
}: {
  role: RoleDefinition
  defaultRolesDir: string | undefined
  onCancel: () => void
  onSaved: (text: string) => void
  onFailed: (text: string) => void
}) {
  const t = useT()
  /** 初始快照（不随父级刷新而变，供 diff 用）。 */
  const [initial] = useState<RoleFormValues>(() => ({
    name: role.name,
    description: role.description,
    skills: joinCsv(role.skills),
    layers: [...(role.knowledge?.layers ?? [])],
    books: joinCsv(role.knowledge?.books),
    color: role.color ?? '',
    model: role.model ?? '',
    thoughtLevel: role.thoughtLevel ?? '',
    body: role.body,
    rolesDir: defaultRolesDir ?? '',
  }))
  const [v, setV] = useState<RoleFormValues>(initial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [alert, setAlert] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const set = <K extends keyof RoleFormValues>(key: K, value: RoleFormValues[K]) =>
    setV((prev) => ({ ...prev, [key]: value }))

  /** 与快照求差，只提交改动过的字段（服务端的 PATCH 语义：缺省 = 不改）。 */
  const buildPatch = (): { patch: RoleWriteInput; fields: string[] } | string => {
    const init = initial
    if (v.rolesDir.trim() === '') return '请先填写角色目录（roles_dir）'
    const patch: RoleWriteInput = { roles_dir: v.rolesDir.trim() }
    const fields: string[] = []

    if (v.description !== init.description) {
      patch.description = v.description
      fields.push('description')
    }
    if (v.skills !== init.skills) {
      // 显式给数组（含 `[]`）＝ 写入该值；`[]` 即清空白名单
      patch.skills = csv(v.skills)
      fields.push('skills')
    }
    const layersChanged = v.layers.join(',') !== init.layers.join(',')
    // books 界面上不展示，但值随快照带入 → 不变即不提交；只有知识层改动时才带上原值透传
    if (layersChanged || v.books !== init.books) {
      const books = csv(v.books)
      patch.knowledge = { layers: v.layers as KnowledgeBinding['layers'], ...(books.length > 0 ? { books } : {}) }
      fields.push('knowledge')
    }
    if (v.color !== init.color) {
      // 空串 = 清除该 frontmatter 键（服务端 optionalClearable）
      patch.color = v.color === '' ? '' : (v.color as RoleColor)
      fields.push('color')
    }
    if (v.model !== init.model) {
      patch.model = v.model.trim() === '' ? '' : v.model.trim()
      fields.push('model')
    }
    if (v.thoughtLevel !== init.thoughtLevel) {
      patch.thought_level = v.thoughtLevel === '' ? '' : (v.thoughtLevel as ThoughtLevel)
      fields.push('thought_level')
    }
    if (v.body !== init.body) {
      patch.body = v.body
      fields.push('body')
    }
    return { patch, fields }
  }

  const submit = async () => {
    if (v.layers.length === 0) {
      setErrors({ layers: '至少选 1 个知识层' })
      setAlert('知识范围至少留 1 个（要清空请用删除 + 新建）')
      return
    }
    setErrors({})
    const built = buildPatch()
    if (typeof built === 'string') {
      setAlert(built)
      return
    }
    if (built.fields.length === 0) {
      setAlert('没有任何改动——改一处再提交。')
      return
    }
    setAlert('')
    setSubmitting(true)
    try {
      await teamApi.updateRole(role.name, built.patch)
      onSaved(`${role.name} 已更新（改动字段：${built.fields.join(', ')}；正文与未知 frontmatter 键原样保留）`)
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      onFailed(describeRoleFailure(raw, role.name))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        只提交改动过的字段；正文不重排，未知 frontmatter 键原样保留。
      </div>

      {alert !== '' && (
        <div className="error" role="alert" style={{ marginBottom: 12 }}>
          {alert}
        </div>
      )}

      <RoleFields
        v={v}
        set={set}
        submitting={submitting}
        errors={errors}
        nameReadOnly
        bodyHint="整段替换正文（仅当你在下方改动过正文时提交）。"
      />

      <label className="field" htmlFor="ref-rolesDir" style={{ marginTop: 10 }}>
        <span className="label">{t('roles.form.dir')}</span>
        <input
          id="ref-rolesDir"
          value={v.rolesDir}
          placeholder="如 D:\prism-home\agents"
          disabled={submitting}
          onChange={(e) => set('rolesDir', e.target.value)}
        />
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        <button onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </button>
        <button className="primary" onClick={() => void submit()} disabled={submitting || v.rolesDir.trim() === ''}>
          {submitting ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  )
}

/** 校验状态徽标：无 issue → ok；有 error → err；仅 warning → warn。 */
function IssueBadge({ issues }: { issues: ValidationIssue[] | undefined }) {
  const list = issues ?? []
  if (list.length === 0) return <span className="tag ok">ok</span>
  const errors = list.filter((i) => i.level === 'error').length
  const warnings = list.length - errors
  return (
    <span className={`tag ${errors > 0 ? 'err' : 'warn'}`} title={list.map((i) => `[${i.code}] ${i.message}`).join('\n')}>
      {errors}E / {warnings}W
    </span>
  )
}

/** 服务端错误码 → 界面文案（未列出的 code 一律走通用文案，**不静默**）。
 *
 * 服务端实际形状（读 `packages/server/src/roles/role-create.ts`）：
 * - 业务码在信封 code 上：`id_conflict`（已存在不覆盖）、`not_found`（改/删的目标不存在）；
 * - 校验失败信封 code 是 `bad_request`，**具体码在 message 开头**（全角冒号分隔）：
 *   `roles_dir_required：…` / `role_name_required：…` / `role_patch_empty：…`；
 * - `RoleWriteError` 的 message 自带 `role_name_invalid:` / `role_not_found:` / `role_write_failed:` 前缀。
 */
function describeRoleFailure(raw: string, name: string): string {
  const idx = raw.indexOf(': ')
  const envelopeCode = idx === -1 ? '' : raw.slice(0, idx)
  const message = idx === -1 ? raw : raw.slice(idx + 2)

  if (envelopeCode === '') {
    return `操作失败：无法连接服务（${raw}）。检查 \`prism serve\` 是否在运行，然后重试。`
  }
  const detailCode = /^([a-z_]+)\s*[:：]/.exec(message)?.[1] ?? ''
  const code = detailCode !== '' ? detailCode : envelopeCode
  const detail = message.replace(/^[a-z_]+\s*[:：]\s*/, '')

  if (code === 'roles_dir_required') {
    return '操作失败：未指定角色目录（防误写真实宿主）。请填写「角色目录 / 写入目录」后重试。'
  }
  if (code === 'role_name_required') return '操作失败：未指定角色名。'
  if (code === 'role_name_invalid') {
    return `操作失败：角色名不合法（${detail}）。只能用小写字母、数字和连字符。`
  }
  if (code === 'role_patch_empty') return '操作失败：没有任何要修改的字段。'
  if (code === 'role_not_found') {
    return `操作失败：角色「${name}」不存在（可能已被删除或不在该目录）。刷新列表后重试。`
  }
  if (code === 'id_conflict') {
    return `操作失败：角色「${name}」已存在（未覆盖）。改用「编辑」，或换个名字 / 删除原文件。`
  }
  if (code === 'role_write_failed') return `操作失败：目标不可写（${detail}）。`
  if (envelopeCode === 'bad_request') return `操作失败：${detail}`
  return `操作失败：${code}：${message}`
}
