import { useEffect, useRef, useState } from 'react'

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
import type { NavTarget } from '../nav.ts'

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

/** 知识层（与服务端 `role-create.ts` 的 `KNOWLEDGE_LAYERS` 同口径）。 */
const LAYERS: Array<{ value: KnowledgeBinding['layers'][number]; label: string }> = [
  { value: 'global', label: 'global 全局' },
  { value: 'project', label: 'project 项目' },
  { value: 'role', label: 'role 专家' },
]

/** 与服务端 `packages/agents/src/role/write.ts` 的 `KEBAB_CASE_RE` 同口径（前端先拦，服务端仍校验）。 */
const ROLE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * 角色页：角色库列表 + 详情（核心第一原则 / 边界 / 能力 / 知识绑定 / 有效 Skill）
 * + 增删改（v5：`new` / `edit` / `rm` 与 CLI、MCP 同名同位，见 `packages/cli/src/commands/role.ts`）。
 */
export function RolesPage({
  nav,
  onOpenSkills,
}: {
  /** 跨页跳转意图（有效集反向视图 → 本页展开指定角色） */
  nav?: NavTarget
  onOpenSkills?: () => void
} = {}) {
  const roles = useAsync(() => teamApi.roles(), [])
  const [selected, setSelected] = useState<string>('')
  const [formOpen, setFormOpen] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 从「技能 → 使用情况」跳进来时展开目标角色
  useEffect(() => {
    if (nav?.role !== undefined && nav.role !== '') setSelected(nav.role)
  }, [nav])

  const detail = useAsync(
    () => (selected ? teamApi.role(selected) : Promise.resolve(undefined)),
    [selected],
  )

  const list = roles.data?.roles ?? []
  const rolesDir = roles.data?.rolesDir

  /** 写操作统一出口：刷新列表 + 置提示条（成功保留详情，删除后收起）。 */
  const afterWrite = (kind: 'ok' | 'err', text: string, opts: { close?: boolean; keep?: string } = {}) => {
    setBanner({ kind, text })
    if (opts.close === true) setSelected('')
    roles.reload()
    detail.reload()
    if (opts.keep !== undefined) setSelected(opts.keep)
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 className="page-title">角色</h2>
        <button
          className="primary"
          onClick={() => {
            setFormOpen(true)
            setBanner(null)
          }}
          disabled={formOpen}
        >
          新建角色
        </button>
      </div>
      <p className="page-desc">
        角色是决策契约：核心第一原则决定冲突时牺牲什么；能力用白名单，知识绑到层与书。
      </p>

      <div className="card">
        <h3>角色库</h3>
        {banner !== null && (
          <div className="row" style={{ gap: 8, marginBottom: 10 }}>
            <span className={`tag ${banner.kind === 'ok' ? 'ok' : 'err'}`}>
              {banner.kind === 'ok' ? '已完成' : '失败'}
            </span>
            <span className="small">{banner.text}</span>
          </div>
        )}
        <State
          loading={roles.loading}
          error={roles.error}
          empty={!roles.loading && !roles.error && list.length === 0}
          emptyText="还没有角色。点右上角「新建角色」，或用 prism role new <name> 生成骨架。"
        >
          {/* v5 / T-5：角色库 5 列表在小屏（375px，内容区 351px）会挤压溢出——
              套上既有 `.table-scroll`（styles.css:270-272）横向滚动兜底。
              另给「描述」列一个 minWidth：固定列宽合计 570px 已超过 `.table-scroll table`
              的 min-width:560px，若不给描述列下限，浏览器会把描述压到「一字一行」
              （375px 实测截图 v5-375-roles.png 复现过）。给下限后表格内在宽 ~790px，
              由容器横向滚动承载，描述保持可读。 */}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>角色</th>
                  <th style={{ minWidth: 220 }}>描述</th>
                  <th style={{ width: 160 }}>能力（Skill 白名单）</th>
                  <th style={{ width: 130 }}>知识绑定</th>
                  <th style={{ width: 110 }}>校验</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.name}>
                    <td>
                      <button
                        className="nav-item"
                        style={{ padding: 0, color: COLOR_MAP[r.color ?? ''] ?? 'var(--accent)' }}
                        onClick={() => {
                          setSelected(r.name)
                          setBanner(null)
                        }}
                      >
                        {r.name}
                      </button>
                      {r.installed !== undefined && (
                        <div>
                          <span className={`tag${r.installed ? ' ok' : ' warn'}`} title="宿主 agents 目录里是否有该角色定义">
                            {r.installed ? '已装' : '未装'}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="small">{r.description}</td>
                    <td className="mono small muted">
                      {r.skills.length ? r.skills.join(', ') : '—'}
                    </td>
                    <td className="small muted">
                      {(r.knowledge?.layers ?? []).join('/') || '—'}
                      {r.knowledge?.books?.length ? ` (${r.knowledge.books.join(', ')})` : ''}
                    </td>
                    <td>
                      <IssueBadge issues={r.issues} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </div>

      {formOpen && (
        <NewRoleForm
          existingNames={list.map((r) => r.name)}
          defaultRolesDir={rolesDir}
          onCancel={() => setFormOpen(false)}
          onCreated={(name, path) => {
            setFormOpen(false)
            afterWrite('ok', `${name} 已写入 ${path}`, { keep: name })
          }}
        />
      )}

      {selected !== '' && (
        <RoleDetail
          name={selected}
          detail={detail.data}
          loading={detail.loading}
          error={detail.error}
          rolesDir={rolesDir}
          onClose={() => setSelected('')}
          onOpenSkills={onOpenSkills}
          onSaved={(text) => afterWrite('ok', text, { keep: selected })}
          onDeleted={(text) => afterWrite('ok', text, { close: true })}
          onFailed={(text) => afterWrite('err', text, { keep: selected })}
        />
      )}
    </>
  )
}

/* ==================== 角色详情（读 + 编辑 + 删除） ==================== */

function RoleDetail({
  name,
  detail,
  loading,
  error,
  rolesDir,
  onClose,
  onOpenSkills,
  onSaved,
  onDeleted,
  onFailed,
}: {
  name: string
  detail: RoleDefinition | undefined
  loading: boolean
  error: string | undefined
  /** 受管 roles 目录（只读，来自 GET /api/roles）——删除/编辑的 `roles_dir` 缺省值 */
  rolesDir: string | undefined
  onClose: () => void
  onOpenSkills?: () => void
  onSaved: (text: string) => void
  onDeleted: (text: string) => void
  onFailed: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [delError, setDelError] = useState('')
  /** `null` = 跟随父级给的默认目录；一旦用户动过就固化为自己的值（可清空）。 */
  const [dirOverride, setDirOverride] = useState<string | null>(null)

  const dirValue = dirOverride ?? rolesDir ?? ''
  const effectiveDir = dirValue.trim()

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

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>
          角色详情 <span className="mono small muted">{name}</span>
        </h3>
        <div className="row">
          {!editing && detail !== undefined && (
            <button className="primary" onClick={() => setEditing(true)}>
              编辑
            </button>
          )}
          {!editing && detail !== undefined && (
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
          <button onClick={onClose}>关闭</button>
        </div>
      </div>

      {confirming && !editing && (
        <div className="card" style={{ background: 'var(--panel-2)', marginBottom: 12, borderLeft: '3px solid var(--err)' }}>
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
            {rolesDir === undefined && (
              <span className="small muted">
                未从 <span className="mono">GET /api/roles</span> 拿到默认目录 → 必须手动填写。
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
            <button className="primary" onClick={() => void onDelete()} disabled={deleting || effectiveDir === ''}>
              {deleting ? '删除中…' : '确认删除'}
            </button>
          </div>
        </div>
      )}

      {editing && detail !== undefined ? (
        <RoleEditForm
          role={detail}
          defaultRolesDir={rolesDir}
          onCancel={() => setEditing(false)}
          onSaved={(text) => {
            setEditing(false)
            onSaved(text)
          }}
          onFailed={onFailed}
        />
      ) : (
        <State loading={loading} error={error}>
          {detail && (
            <>
              <div
                style={{
                  background: 'var(--panel-2)',
                  borderLeft: `3px solid ${COLOR_MAP[detail.color ?? ''] ?? 'var(--accent)'}`,
                  padding: '10px 14px',
                  borderRadius: 8,
                  marginBottom: 12,
                }}
              >
                <div className="small muted" style={{ marginBottom: 4 }}>
                  核心第一原则
                </div>
                <div style={{ fontWeight: 600 }}>{detail.principle || '（缺失）'}</div>
              </div>
              <div className="row" style={{ marginBottom: 10 }}>
                {detail.model && <span className="tag">model: {detail.model}</span>}
                {detail.thoughtLevel && <span className="tag">思考: {detail.thoughtLevel}</span>}
                {detail.sourcePath && (
                  <span className="tag small">来源: {detail.sourcePath}</span>
                )}
              </div>
              {(detail.issues?.length ?? 0) > 0 && (
                <div className="card" style={{ background: 'var(--panel-2)', marginBottom: 12 }}>
                  <h3 style={{ marginTop: 0 }}>校验问题</h3>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 70 }}>级别</th>
                        <th style={{ width: 170 }}>代码</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.issues?.map((issue, i) => (
                        <tr key={`${issue.code}-${i}`}>
                          <td>
                            <span className={`tag ${issue.level === 'error' ? 'err' : 'warn'}`}>
                              {issue.level}
                            </span>
                          </td>
                          <td className="mono small">{issue.code}</td>
                          <td className="small">{issue.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {/* F-D2 有效集（正向视图）：正文上方；与技能页「使用情况」互链 */}
              <EffectiveSkills key={name} role={name} roleFixed onOpenUsage={onOpenSkills} />
              <pre
                className="mono"
                style={{
                  whiteSpace: 'pre-wrap',
                  background: 'var(--panel-2)',
                  padding: 12,
                  borderRadius: 8,
                  margin: 0,
                  maxHeight: 360,
                  overflow: 'auto',
                }}
              >
                {detail.body}
              </pre>
            </>
          )}
        </State>
      )}
    </div>
  )
}

/* ==================== 新建 / 修改角色（共用字段 UI） ==================== */

interface RoleFormValues {
  name: string
  description: string
  /** 能力白名单（逗号分隔） */
  skills: string
  layers: string[]
  /** 知识书（逗号分隔） */
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
  return (
    <>
      <div className="form-grid">
        <label className="field" htmlFor="rf-name">
          <span className="label">角色名（kebab-case{nameReadOnly ? '，不可改' : '，必填'}）</span>
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
          <span className="label">角色色</span>
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
          <span className="label">描述（派遣决策依据：职责 + 适用于 + 不适用于）</span>
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
          <span className="label">能力（Skill 白名单，逗号分隔）</span>
          <input
            id="rf-skills"
            value={v.skills}
            placeholder="kb, graph, arch"
            disabled={submitting}
            onChange={(e) => set('skills', e.target.value)}
          />
          <span className="small muted">留空 = 未声明能力（校验给 warning，不是 error）。</span>
        </label>
        <label className="field" htmlFor="rf-books">
          <span className="label">知识书（books，逗号分隔；可选）</span>
          <input
            id="rf-books"
            value={v.books}
            placeholder="prism-overview, team-definition"
            disabled={submitting}
            onChange={(e) => set('books', e.target.value)}
          />
          <span className="small muted">省略 = 该层全部。</span>
        </label>
      </div>

      <div style={{ marginTop: 10 }}>
        <span className="label small">知识层（layers，至少 1 个）</span>
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
            {THOUGHT_LEVELS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field" htmlFor="rf-body" style={{ marginTop: 10 }}>
        <span className="label">正文（Markdown）</span>
        <textarea
          id="rf-body"
          rows={8}
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
    const books = csv(v.books)
    const input: RoleWriteInput = {
      name: v.name.trim(),
      roles_dir: v.rolesDir.trim(),
      knowledge: { layers: v.layers as KnowledgeBinding['layers'], ...(books.length > 0 ? { books } : {}) },
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
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>新建角色</h3>
        <button onClick={onCancel} disabled={submitting}>
          取消
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8, marginBottom: 10 }}>
        <span className="tag">1 身份</span>
        <span className="tag">2 能力与知识</span>
        <span className="tag">3 正文</span>
        <span className="tag">4 提交</span>
      </div>

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
        <span className="label">写入目录（roles_dir，必填；写真实宿主前请确认）</span>
        <input
          id="rf-rolesDir"
          value={v.rolesDir}
          placeholder="如 D:\prism-home\agents"
          disabled={submitting}
          onChange={(e) => set('rolesDir', e.target.value)}
        />
        {defaultRolesDir === undefined ? (
          <span className="small muted">
            未从 <span className="mono">GET /api/roles</span> 拿到默认目录（服务端未返回 rolesDir）→ 请手动填写。
          </span>
        ) : (
          <span className="small muted">
            默认取自服务端受管目录，可改；Prism 不会回落到宿主默认目录。落盘为<strong>宿主原生形态</strong>：
            frontmatter 只含宿主白名单字段，skills / 知识绑定落在正文小节。
          </span>
        )}
        {errors.rolesDir !== undefined && <span className="err-text">{errors.rolesDir}</span>}
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        <button
          onClick={() => {
            setErrors({})
            setAlert('')
          }}
          disabled={submitting}
        >
          重置
        </button>
        <button className="primary" onClick={() => void submit()} disabled={!canSubmit}>
          {submitting ? '创建中…' : '创建角色'}
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
      setAlert('知识层至少留 1 个（要清空请用删除 + 新建）')
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
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>
          编辑角色 <span className="mono small muted">{role.name}</span>
        </h3>
        <span className="small muted">
          只提交改动过的字段；正文不重排，未知 frontmatter 键原样保留。
        </span>
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
        <span className="label">角色目录（roles_dir，必填）</span>
        <input
          id="ref-rolesDir"
          value={v.rolesDir}
          placeholder="如 D:\prism-home\agents"
          disabled={submitting}
          onChange={(e) => set('rolesDir', e.target.value)}
        />
        {defaultRolesDir === undefined && (
          <span className="small muted">
            未从 <span className="mono">GET /api/roles</span> 拿到默认目录 → 必须手动填写。
          </span>
        )}
      </label>

      <div className="form-actions" style={{ marginTop: 14 }}>
        <button onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button className="primary" onClick={() => void submit()} disabled={submitting || v.rolesDir.trim() === ''}>
          {submitting ? '保存中…' : '保存修改'}
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
