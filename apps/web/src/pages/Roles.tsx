import { useMemo, useState } from 'react'

import {
  ROLE_COLOR_OPTIONS,
  THOUGHT_LEVELS,
  teamApi,
  type RoleDefinition,
  type RoleWriteInput,
  type ValidationIssue,
} from '../api-team.ts'
import { ConfirmModal } from '../components/ConfirmModal.tsx'
import { CountLine } from '../components/CountLine.tsx'
import { NavRow } from '../components/NavRow.tsx'
import { Ref } from '../components/ref.tsx'
import { State } from '../components/State.tsx'
import { CopyCommand, Drawer, EmptyBlock, PageHead, firstSentence, stripStrongMarkers } from '../components/ui.tsx'
import { useAsync } from '../components/useAsync.ts'
import { hrefOf, navigate } from '../route.ts'
import { useT, type DictKey } from '../i18n.ts'
import { buildRoleInput } from './roles-form-logic.ts'

/**
 * 角色页（v7 §4.2 R1-R8；F8 §一 层级重排）。
 *
 * 四条纪律：
 * 1. **hash 是唯一选中真相**（R8）：点卡片 = 改 hash，关抽屉 = 清 sel；
 *    深链未命中 → notFound pane，`sel` 一变即自动恢复（不再延迟清 `notFoundName`）。
 * 2. **三档层级只用字号/字重/间距/折叠表达**（F8 §0.1）：第一眼带 = 名字行 → 一句话职责 →
 *    原则强调块 → 徽章行；常用带 = `CountLine section` 分段头 + `Ref` 列；深挖带 = `<details>`。
 *    不新增任何颜色/灰阶/字号档——着色只出现在状态（卡片底行校验 `lamp` = `--warn`、
 *    校验问题 error 级文本 = `--madder`）。
 * 3. **卡片底行三计数压成同行**（F8 §1.4）：技能 / 团队 / 校验（lamp 仅 >0 点灯），
 *    `margin-top: auto` 把它钉在卡片底部。
 * 4. **`roles_dir` 必填且来自读回值**（design-v7 §2.4）：表单预填 `GET /api/roles`
 *    的 `rolesDir`、可改、显式提交；读回为空则禁用提交，绝不猜宿主目录。
 */

const COLOR_MAP: Record<string, string> = {
  red: 'var(--madder)', blue: 'var(--role-blue)', green: 'var(--role-green)', yellow: 'var(--role-yellow)',
  purple: 'var(--role-purple)', orange: 'var(--role-orange)', pink: 'var(--role-pink)', cyan: 'var(--role-cyan)',
  gray: 'var(--role-gray)',
}
function colorOf(c?: string): string {
  return (c !== undefined && COLOR_MAP[c]) || 'var(--role-gray)'
}

/** 校验码 → 人话（R7）。静态映射：动态拼 key 会被 `dead-keys.mjs` 判为疑似引用（§6.2 禁令）。 */
const ISSUE_KEYS: Record<string, DictKey> = {
  name_required: 'roles.issue.nameRequired',
  role_name_not_kebab: 'roles.issue.nameNotKebab',
  name_dirname_mismatch: 'roles.issue.nameDirname',
  description_required: 'roles.issue.descriptionRequired',
  description_too_long: 'roles.issue.descriptionTooLong',
  principle_missing: 'roles.issue.principleMissing',
  skills_empty: 'roles.issue.skillsEmpty',
  skill_unknown: 'roles.issue.skillUnknown',
  knowledge_layers_empty: 'roles.issue.layersEmpty',
  knowledge_layers_invalid: 'roles.issue.layersInvalid',
  color_invalid: 'roles.issue.colorInvalid',
  thoughtLevel_invalid: 'roles.issue.thoughtInvalid',
  role_duplicate: 'roles.issue.duplicate',
}

/** 能在表单里修的码（其余给「复制命令」出路，R7）。 */
const FORM_FIXABLE = new Set([
  'description_required', 'description_too_long', 'principle_missing', 'skills_empty', 'skill_unknown',
  'knowledge_layers_empty', 'knowledge_layers_invalid', 'color_invalid', 'thoughtLevel_invalid',
])

interface TeamRef {
  teamId: string
  teamName: string
}

export function RolesPage({ sel }: { sel?: string }) {
  const t = useT()
  const roles = useAsync(() => teamApi.roles(), [])
  const teams = useAsync(() => teamApi.teams(), [])
  const [filter, setFilter] = useState('')
  const [issuesOnly, setIssuesOnly] = useState(false)
  const [form, setForm] = useState<{ mode: 'new' | 'edit'; initial: RoleDefinition | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RoleDefinition | null>(null)
  const [busyDelete, setBusyDelete] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [notice, setNotice] = useState('')

  const roleList = useMemo(() => roles.data?.roles ?? [], [roles.data])
  const rolesDir = roles.data?.rolesDir ?? ''
  const teamList = useMemo(() => teams.data?.teams ?? [], [teams.data])

  // 角色 → 所属团队映射（抽屉第一段）
  const roleTeams = useMemo(() => {
    const map = new Map<string, TeamRef[]>()
    for (const team of teamList) {
      for (const member of team.members ?? []) {
        const list = map.get(member.role) ?? []
        list.push({ teamId: team.team_id, teamName: team.name ?? team.team_id })
        map.set(member.role, list)
      }
    }
    return map
  }, [teamList])

  /** 本角色的所属团队（`roleTeams` 的反查）——卡片与抽屉共用一处，避免四处重复 `?? []`。 */
  const teamRefsOf = (r: RoleDefinition): TeamRef[] => roleTeams.get(r.name) ?? []

  const key = sel?.trim() ?? ''
  /**
   * 深链（R8/§6.3）：**唯一数据源是 `teamApi.role(name)`** —— 单角色接口，
   * `not_found` 语义清晰，也不再为了一个深链把全量角色拉下来。
   * 列表仍在内存时用其兜底回填（首帧不闪），但只认「名字对得上」的那条：
   * `linked.data` 跨 `key` 变化会残留上一个角色，靠 `name === key` 挡住。
   */
  const linked = useAsync(
    () => (key === '' ? Promise.resolve(null) : teamApi.role(key).catch(() => null)),
    [key],
  )
  const linkedRole = linked.data != null && linked.data.name === key ? linked.data : null
  const role = key === '' ? null : linkedRole ?? roleList.find((r) => r.name === key) ?? null
  /** 深链未命中（已删 / 名字错）：列表与单角色请求都落定才判定，避免首帧误报。 */
  const notFound = key !== '' && !roles.loading && !linked.loading && role === null

  const effective = useAsync(
    () => (key === '' ? Promise.resolve(null) : teamApi.effectiveSkills(key).catch(() => null)),
    [key],
  )
  /**
   * MINOR-13：与 `linkedRole` 同一守卫——`effective` 也随 `key` 换，而 `useAsync` 不清
   * `data`；响应自带 `role`，只认与当前 key 一致的那条（否则抽屉首帧会显示上一个角色的
   * 「有效 Skill」计数与清单）。
   */
  const effectiveSet = effective.data != null && effective.data.role === key ? effective.data : null

  const issueRoles = useMemo(() => roleList.filter((r) => (r.issues ?? []).length > 0).length, [roleList])
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return roleList.filter((r) => {
      if (issuesOnly && (r.issues ?? []).length === 0) return false
      if (q === '') return true
      return r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    })
  }, [roleList, filter, issuesOnly])

  const doDelete = async () => {
    if (pendingDelete === null) return
    const target = pendingDelete
    setBusyDelete(true)
    setNotice('')
    setDeleteError('')
    try {
      await teamApi.deleteRole(target.name, rolesDir)
      setPendingDelete(null)
      /**
       * D-2：删除成功后**收口全部浮层**。详情抽屉由下面的 `navigate` 关（hash 是选中
       * 唯一真相）；编辑表单抽屉是本页 state，必须显式清——否则它会继续显示已删角色的
       * 名称/描述（实测复现：列表已刷新、toast 已出，抽屉仍开着）。
       * ⚠ 与 R-6 Q1「保存成功不关抽屉」不冲突：Q1 管**保存**（实体仍在，反馈就地留在
       * 抽屉内），这里管**删除**（实体已不存在，留着就是幽灵数据）。
       */
      setForm(null)
      if (key === target.name) navigate({ page: 'roles' })
      setNotice(t('roles.deleted', { name: target.name }))
      roles.reload()
      linked.reload()
    } catch (e) {
      // R-6 Q1 边界：删除**失败**时确认模态还开着，列表 banner 在遮罩后面＝看不到 → 就地报在模态内
      setDeleteError(t('common.loadFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyDelete(false)
    }
  }

  return (
    <>
      {/* B1：页标题走 `<PageHead>`（`--fs-600`/600）——手写 `<h1>` 是 UA 默认 28px/700。 */}
      <PageHead title={t('roles.title')} sub={t('roles.desc')} />

      {roles.error !== undefined && <div className="error">{roles.error}</div>}
      {/* R-6 Q1 边界：`notice` 现在**只服务删除**（纯列表操作，删完抽屉即关、人落在列表上，
          反馈贴触发点＝就地保留）；表单的保存/错误反馈一律留在抽屉内（见 RoleForm）。 */}
      {notice !== '' && <div className="banner small">{notice}</div>}

      <div className="role-toolbar">
        <input
          className="role-filter"
          value={filter}
          placeholder={t('roles.filterPlaceholder')}
          aria-label={t('roles.filterPlaceholder')}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className={`role-count${issuesOnly ? ' active' : ''}`}
          title={t('roles.issuesOnly')}
          onClick={() => setIssuesOnly((v) => !v)}
        >
          {t('roles.countLine', { total: roleList.length, issues: issueRoles })}
        </button>
        <span className="spacer" />
        <button type="button" className="tool-btn" onClick={() => setForm({ mode: 'new', initial: null })}>
          {t('roles.new')}
        </button>
      </div>

      {/* B10：加载态统一走 `State`（静态骨架），不再手写 `…` */}
      {roles.loading && <State loading />}

      {roles.loading ? null : notFound ? (
        /* R8：sel 不存在 → notFound pane（hash 是唯一真相，sel 一变这里自动消失） */
        <div className="pane">
          <h3>{t('roles.notFound', { name: key })}</h3>
          <p className="muted">{t('roles.notFound.desc')}</p>
          <div className="row">
            <a className="tool-btn" href={hrefOf({ page: 'roles' })}>{t('roles.notFound.back')}</a>
            <a className="tool-btn" href={hrefOf({ page: 'teams' })}>{t('roles.notFound.teams')}</a>
          </div>
        </div>
      ) : roleList.length === 0 ? (
        <EmptyBlock title={t('roles.empty')} command="prism role new <name>" />
      ) : shown.length === 0 ? (
        <div className="pane">
          <p className="muted">{t('roles.filterNone')}</p>
        </div>
      ) : (
        <div className="role-grid">
          {shown.map((r) => {
            const teamRefs = teamRefsOf(r)
            const issues = r.issues ?? []
            return (
              <NavRow key={r.name} variant="card" href={hrefOf({ page: 'roles', sel: r.name })}>
                <div className="role-name">
                  <span className="role-dot" style={{ background: colorOf(r.color) }} />
                  {r.name}
                </div>
                <RoleGlance role={r} />
                {/* F8 §1.1 固定底行：三计数**同行**（`margin-top: auto` 钉底）；lamp 仅 >0 点灯 */}
                <div className="role-metrics">
                  <CountLine label={t('roles.card.skills')} count={r.skills.length} />
                  <CountLine label={t('roles.card.teams')} count={teamRefs.length} />
                  <CountLine label={t('roles.issues')} count={issues.length} lamp={issues.length > 0} />
                </div>
              </NavRow>
            )
          })}
        </div>
      )}

      {role !== null && (
        <Drawer
          /* R-v8-1：详情抽屉加宽到 `min(680px, 72vw)`（编辑表单抽屉维持 560）。
             ⚠ 宽度**不作为层级手段**（F8 §1.6）——层级仍由三段带子表达，加宽只影响常用带
             一行的 `Ref` 个数。`.drawer-body` 内部滚动，窄屏由 `72vw` 兜住。 */
          width={680}
          maxVw={72}
          title={
            <span className="row">
              <span className="role-dot" style={{ background: colorOf(role.color) }} />
              {role.name}
            </span>
          }
          onClose={() => navigate({ page: 'roles' })}
          footer={
            <>
              <button type="button" className="tool-btn" onClick={() => setForm({ mode: 'edit', initial: role })}>
                {t('common.edit')}
              </button>
              <button
                type="button"
                className="tool-btn"
                disabled={rolesDir === ''}
                title={rolesDir === '' ? t('roles.form.dirMissing') : undefined}
                onClick={() => setPendingDelete(role)}
              >
                {t('common.delete')}
              </button>
            </>
          }
        >
          {/* v7.1 P2：换角色时抽屉正文**轻过渡**（纯 opacity，`key` 让动画随换选中重放）。
              `role-detail` = R-v8-1 的「内容列 66ch 居中」落点（MIN-4）：它必须挂在滚动容器
              `.drawer-body` 的**内层**——那容器是详情 / 编辑表单 / 团队页三处共用的，改它越权。 */}
          <div className="swap-in role-detail" key={role.name}>
            {/* 第一眼带（F8 §1.3 同构）：与卡片正面**同一个组件**、同一顺序、同一视觉手段
                —— 点开是放大，不是换重心。 */}
            <RoleGlance role={role} />

            {/* 常用带·一：所属团队（R4 段一；`CountLine section` + `Ref kind="team"`） */}
            <section>
              <CountLine size="section" label={t('roles.teams')} count={teamRefsOf(role).length} />
              {teamRefsOf(role).length === 0 ? (
                <div className="rsec-empty">
                  {t('roles.teams.empty')}{' '}
                  <a className="ref" href={hrefOf({ page: 'teams' })}>{t('roles.teams.go')}</a>
                </div>
              ) : (
                <div className="rsec-list">
                  {teamRefsOf(role).map((tm) => (
                    <Ref key={tm.teamId} kind="team" name={tm.teamId} title={tm.teamName} />
                  ))}
                </div>
              )}
            </section>

            {/* 常用带·二：白名单技能。
                F5 落点：**只列 `role.skills`**（全局/团队带进来的那部分不在本页罗列）；
                原先常驻的「声明 vs 有效」两行口径说明降级为分段头的 `title`（§1.5 #4）；
                「有效 Skill」差集清单整段删除（§1.5 #3）——`effective` 请求保留，只供计数。 */}
            <section>
              <CountLine
                size="section"
                label={t('roles.capabilities')}
                count={role.skills.length}
                title={`${t('roles.effectiveHint')} · ${t('roles.skills.counts', {
                  declared: role.skills.length,
                  effective: effectiveSet?.skills.length ?? 0,
                })}`}
              />
              <div className="rsec-list">
                {role.skills.length === 0 ? (
                  <EmptyRef text={t('roles.skills.none')} />
                ) : (
                  role.skills.map((s) => <Ref key={s} kind="skill" name={s} />)
                )}
              </div>
            </section>

            {/* 常用带·三：知识范围（R-v8-4：落「常用」，不再是带说明行的小段）。
                §1.5 #5：过滤串 `role/<name>` 降级为 `Ref` 的 `title`（`Ref` 自带 layer/owner 跳转）。 */}
            <section>
              <CountLine
                size="section"
                label={t('roles.knowledgeScope')}
                count={(role.knowledge?.books?.length ?? 0) + (role.knowledge?.layers?.length ?? 0)}
              />
              <div className="rsec-list">
                {(role.knowledge?.layers ?? []).map((l) => (
                  <span key={l} className="tag">layer: {l}</span>
                ))}
                {(role.knowledge?.books ?? []).map((b) => (
                  <Ref
                    key={b}
                    kind="book"
                    name={b}
                    layer="role"
                    owner={role.name}
                    title={`${t('roles.knowledge.filter')}: role/${role.name}`}
                  />
                ))}
              </div>
            </section>

            {/* 深挖带·一：校验问题清单（R-v8-4：状态位由卡片底行 lamp 承担，清单**默认折叠**）。
                error 级文本走 `--madder`（唯一的层级外着色之一，与层级无关）。 */}
            {(role.issues ?? []).length > 0 && (
              <details className="role-issues">
                <summary>
                  <CountLine size="section" bare label={t('roles.issues')} count={(role.issues ?? []).length} lamp />
                </summary>
                {(role.issues ?? []).map((issue: ValidationIssue, i: number) => (
                  <div key={i} className="rsec-issue">
                    <code className="mono">{issue.code}</code>
                    <span className={`rsec-issue-text${issue.level === 'error' ? ' err' : ''}`}>
                      {ISSUE_KEYS[issue.code] !== undefined ? t(ISSUE_KEYS[issue.code]) : issue.message}
                    </span>
                    {FORM_FIXABLE.has(issue.code) ? (
                      <button type="button" className="tool-btn" onClick={() => setForm({ mode: 'edit', initial: role })}>
                        {t('roles.issue.fixInForm')}
                      </button>
                    ) : (
                      <CopyCommand command={`prism role new ${role.name}`} label={t('roles.issue.copyCommand')} />
                    )}
                  </div>
                ))}
              </details>
            )}

            {/* 深挖带·二：完整定义正文（§1.1：折叠是唯一去处）。
                §1.5 #6：第一眼与卡面只留一句话职责，**描述全文**落到这里
                （`role.body` 是 frontmatter 之后的正文，不含 `description`，故单独补一行）。 */}
            <details className="role-body">
              <summary>{t('common.showDetails')}</summary>
              <p className="role-body-desc">{role.description}</p>
              <pre>{role.body}</pre>
            </details>
          </div>
        </Drawer>
      )}

      {form !== null && (
        <RoleForm
          mode={form.mode}
          initial={form.initial}
          rolesDir={rolesDir}
          onClose={() => setForm(null)}
          onSaved={() => {
            // R-6 Q1：保存成功**不关抽屉**——反馈由 RoleForm 就地渲染，列表提示条不再镜像一份。
            roles.reload()
            linked.reload() // 深链数据源是 role()：编辑后就地刷新抽屉，不然抽屉留着旧字段
            if (form.mode === 'edit' && form.initial !== null) effective.reload()
          }}
        />
      )}

      {pendingDelete !== null && (
        <ConfirmModal
          title={t('roles.delete.title', { name: pendingDelete.name })}
          body={<p className="muted">{t('roles.delete.body')}</p>}
          busy={busyDelete}
          confirmDisabled={rolesDir === ''}
          error={deleteError}
          onConfirm={() => void doDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  )
}

/** 卡片底行一格与抽屉分段头（B7）此前是本页自带的 `Metric`/`SecHead` 两套引线零件，
 *  现已收进 `components/CountLine.tsx`（`.rm-*`/`.rsec-head` 两条 CSS 同步删除）。 */

/**
 * 第一眼带的**后三件**（F8 §1.1 / §1.3）：一句话职责 → 原则强调块 → 徽章行。
 *
 * 卡片正面与抽屉正文**共用这同一个组件**——这是「点开卡片 = 放大而不是换重心」的实现方式
 * （顺序与视觉手段只有一处定义，改一处两边同时变）。
 *
 * 三档语法全靠字号/字重/间距表达（§0.1），不引入任何新颜色：
 * - 职责 `.role-desc`：`--fs-200`/`--mute`，**1 行**、`firstSentence(desc, 22)`，全文进 `title`；
 * - 原则 `.role-principle`：`--sheet-2` 底 + 左 3px `--buckram` 边 + `--r-2`，`--fs-300` 正文
 *   **2 行截断**（`firstSentence(principle, 38)`）；空值走 `.missing` 变体（`--rule` 边 + `--mute` 标签）；
 *   **F8-1**：渲染前先 `stripStrongMarkers` 剥掉强强调标记——本块是纯文本强调块（无粗体语义），
 *   截断在首个句号会把成对的 `**…**` 截成半截标记，字面输出就是缺陷本身；
 * - 徽章 `.role-tags`：中性 `.tag`（`--fs-100`）**≤ 3 个**——引擎 / 强度 / 装载。
 *   ⚠ §1.5 #1：原先的 `color` 标签已删（颜色已由标题行的 `.role-dot` 表达，是同一信息的第二次陈述）。
 */
function RoleGlance({ role }: { role: RoleDefinition }) {
  const t = useT()
  /* F8-1：原则块是**纯文本**强调块（无粗体语义），`**` 进不了渲染 ⇒ 但截断会留下半截标记
     （首个句号常把闭合的 `**` 截掉）。渲染前一律剥掉，成对 / 不成对同待遇；`missing` 也据
     剥完的文本判——只剩标记的原则等于没写原则（走 `.missing` 变体，不显示一堆星号）。
     `title` 用同一份剥完的**全文**：悬停看到的和块里看到的口径必须一致。 */
  const principle = stripStrongMarkers(role.principle)
  const missing = principle.trim() === ''
  return (
    <>
      <div className="role-desc" title={role.description}>
        {firstSentence(role.description, 22)}
      </div>
      <div className={`role-principle${missing ? ' missing' : ''}`}>
        <div className="rp-label">{t('roles.principle')}</div>
        <div className="rp-text" title={missing ? undefined : principle}>
          {missing ? t('roles.principleMissing') : firstSentence(principle, 38)}
        </div>
      </div>
      <div className="role-tags">
        {role.model !== undefined && role.model !== '' && <span className="tag">{t('roles.form.model')}: {role.model}</span>}
        {role.thoughtLevel !== undefined && role.thoughtLevel !== '' && <span className="tag">{t('roles.form.thought')}: {role.thoughtLevel}</span>}
        <span className="tag">{role.installed === true ? t('common.installed') : t('common.notInstalled')}</span>
      </div>
    </>
  )
}

function EmptyRef({ text }: { text: string }) {
  return <span className="rsec-empty">{text}</span>
}

/** 新建 / 编辑共用表单（R2）。`roles_dir` 必填、预填读回值、随表单提交。 */
function RoleForm({
  mode,
  initial,
  rolesDir,
  onClose,
  onSaved,
}: {
  mode: 'new' | 'edit'
  initial: RoleDefinition | null
  rolesDir: string
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [color, setColor] = useState(initial?.color ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [thought, setThought] = useState(initial?.thoughtLevel ?? '')
  const [skills, setSkills] = useState((initial?.skills ?? []).join(', '))
  const [layers, setLayers] = useState((initial?.knowledge?.layers ?? ['global']).join(', '))
  const [body, setBody] = useState(initial?.body ?? '')
  const [dir, setDir] = useState(rolesDir)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** R-6 Q1：保存反馈**就地**留在抽屉内（保存后不关抽屉），不再上抛给列表提示条。 */
  const [saved, setSaved] = useState('')

  const dirOk = dir.trim() !== ''
  const canSubmit = !busy && dirOk && (mode === 'edit' || name.trim() !== '')

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    setSaved('')
    // B1：payload 构造抽到 `roles-form-logic.ts`（纯函数、有回归锁）——`knowledge`
    // 在 PATCH 下是全量写入，表单没暴露的 `books` 由该函数从 `initial` 原样回传。
    const input: RoleWriteInput = buildRoleInput(mode, initial, {
      name, description, color, model, thought, skills, layers, body, dir,
    })
    try {
      if (mode === 'new') await teamApi.createRole(input)
      else if (initial !== null) await teamApi.updateRole(initial.name, input)
      const who = mode === 'new' ? name.trim() : (initial?.name ?? '')
      setSaved(t(mode === 'new' ? 'roles.form.created' : 'roles.form.updated', { name: who }))
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      width={560}
      title={t(mode === 'new' ? 'roles.form.new' : 'roles.form.edit')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="tool-btn" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="tool-btn" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? t('roles.form.saving') : t('common.save')}
          </button>
        </>
      }
    >
      {error !== '' && <div className="error">{error}</div>}
      {saved !== '' && (
        <div className="banner small" role="status">
          {saved}
        </div>
      )}

      <label className="field">
        <span>{t('roles.form.name')}</span>
        <input value={name} disabled={mode === 'edit'} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <span>{t('roles.form.description')}</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <div className="row">
        <label className="field">
          <span>{t('roles.form.color')}</span>
          <select value={color} onChange={(e) => setColor(e.target.value)}>
            <option value="">{t('common.unset')}</option>
            {ROLE_COLOR_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('roles.form.model')}</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('roles.form.thought')}</span>
          <select value={thought} onChange={(e) => setThought(e.target.value)}>
            <option value="">{t('common.unset')}</option>
            {THOUGHT_LEVELS.map((lv) => (
              <option key={lv} value={lv}>{lv}</option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>{t('roles.form.skills')}</span>
        <input value={skills} onChange={(e) => setSkills(e.target.value)} />
      </label>

      <label className="field">
        <span>{t('roles.form.layers')}</span>
        <input value={layers} onChange={(e) => setLayers(e.target.value)} />
        {/* B1：`books` 没有编辑位，但保存时原样回传——必须让用户知道，否则会以为能在这里改/清 */}
        <span className="hint">{t('roles.form.booksHint')}</span>
      </label>

      <label className="field">
        <span>{t('roles.form.dir')}</span>
        <input value={dir} onChange={(e) => setDir(e.target.value)} />
        <span className="hint">{dirOk ? t('roles.form.dirHint') : t('roles.form.dirMissing')}</span>
      </label>

      <label className="field">
        <span>{t('roles.form.body')}</span>
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
        <span className="hint">{t('roles.form.bodyHint')}</span>
      </label>
    </Drawer>
  )
}
