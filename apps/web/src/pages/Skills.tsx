import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  teamApi,
  type SkillDetail,
  type SkillUninstallOutcome,
  type SkillUsage,
} from '../api-team.ts'
import { ConfirmModal } from '../components/ConfirmModal.tsx'
import { CountLine } from '../components/CountLine.tsx'
import { EffectiveSkills } from '../components/EffectiveSkills.tsx'
import { MarkdownBlocks } from '../components/Markdown.tsx'
import { NavRow } from '../components/NavRow.tsx'
import { ScopeLayerRows } from '../components/SkillScopeList.tsx'
import { State } from '../components/State.tsx'
import { CopyCommand, PageHead, Pane, StatusTag, firstSentence } from '../components/ui.tsx'
import { useAsync } from '../components/useAsync.ts'
import { parseMarkdown } from '../markdown.ts'
import { hrefOf, navigate } from '../route.ts'
import { useT } from '../i18n.ts'
import {
  groupSkills,
  mergeSkillCatalog,
  UNCATEGORIZED,
  cleanSkillDescription,
  externalDeleteErrorKey,
  type SkillCatalogRow,
} from './skills-logic.ts'

/**
 * 技能页（v7 §4.3 S1-S10）：**三正交轴的技能台账**，不是「带徽标的列表」。
 *
 * 三轴（全站一个说法）：
 * - **来源**：内置 / 外部（仅本地有 SKILL.md）——行内文字标记，不用第二个同色徽标（S3）；
 * - **宿主**：已装 / 未装——未装行加 lamp + 「被 N 角色引用」警示（S4）；
 * - **层级 = 谁指定它**：全局 / 团队 / 角色——详情画成三行（`ScopeLayerRows`，与 teams 共用）。
 *
 * 废止 `N refs` 徽标（S1）；`skills_dir` 只用 `GET /api/skills` 读回值，读回为空即禁用
 * 安装/卸载（S6，绝不猜宿主目录）。
 *
 * **F8 §3.1 三档层级（本页）**：
 * - 第一眼 = 行内名字（`.md-row .t`，mono `--fs-200`/600 + 选中左 3px `--buckram` 引线）
 *   + 描述 1 行摘要（`.md-row .s`，32 字）/ 详情里的描述正文（`.skill-desc`，`--fs-300`）；
 * - 常用 = 未装时的 `.scope-callout`（安装命令）与 `.scope-rows` 三行（谁指定了它）；
 * - 深挖 = `.skill-deep`（`<details>` 默认折叠：安装路径 + SKILL.md 全文，含 render｜源码档位）。
 *
 * **F7 分类分组 + 详情居中（本批）**：
 * - **列表侧**：按 `category` 分组（`skills-logic.ts#groupSkills` 的纯判据），组头 = `CountLine`
 *   `size="section"`（组名 + 引线 + 计数）+ `.toc-chev`，组内行容器 = `.collapse`**默认全展开**；
 *   未分类组置末尾、组头带 `lamp`。折叠只服务「技能上百条时按需收窄」，不是默认态。
 *   数据源是两路**各自合并的 `category` 字段**（内置 = `GET /api/skills`，外部 = F7-1 起
 *   同样并进 `GET /api/skills/usage`）（R-v8-5：不做「列表 + 独立映射表」二次拼接；
 *   `/api/skills/categories` 全量表在本页**零消费方**）。
 * - **详情侧**：分组只存在于列表——详情侧无分组概念；居中的单位是**详情整体**
 *   （`.skill-detail` 包一层 66ch 居中列，命令块 / scope / 折叠三层都在同一列内）。
 *
 * **v10 F3ui 外部技能删除（本批）**：详情工具条的破坏性动作是**二选一**——
 * usage 行 `external_removable === true`（宿主目录里人写、无 Prism 标记的目录）显「删除」
 * （`DELETE /api/skills/external/:name`，整目录进回收站），否则显既有的「卸载」
 * （只清 Prism 产物）。字段缺失 / `false` 一律按现状走卸载（内置与 Prism 产物零变更）。
 */

/**
 * 技能台账行（F1 起抽到 `skills-logic.ts#SkillCatalogRow` 并**与角色表单选取器共用**）：
 * 两路合并的口径、排序与字段来源注释都在那里——本页只消费，不再自己合并
 * （此前内联在下面的 `useMemo` 里，选取器若再抄一遍就是第二处镜像）。
 */
type SkillRow = SkillCatalogRow

export function SkillsPage({ sel }: { sel?: string }) {
  const t = useT()
  const skills = useAsync(() => teamApi.skills(), [])
  const usage = useAsync(() => teamApi.skillUsage(), [])
  const [filter, setFilter] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  /**
   * 收起的**分类组**（F7 §3.5）：与知识库目录树的 `collapsedDirs` 同口径——存**收起态**，
   * 缺省即展开，故「默认全部展开」是天然的（折叠是用户主动的收窄手段，不是默认态）。
   * 键 = 分类名；未分类组的键是哨兵 `''`（分类名恒非空，不会撞）。
   */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  /** 页内视图切换（**不进 hash**，S7）：详情 | 有效集（正向视图） */
  const [view, setView] = useState<'detail' | 'effective'>('detail')
  const [busy, setBusy] = useState(false)
  const [pendingUninstall, setPendingUninstall] = useState<SkillDetail | null>(null)
  /**
   * 待确认的**外部技能删除**（F3ui）：存技能名——删除口只吃 `:name`（整目录由服务端按
   * 落点搬运），不需要 `SkillDetail` 的其余字段，故不复用 `pendingUninstall` 的载荷。
   */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** 删除失败的就地反馈（模态未关时不能落到背后的列表上，同 `ConfirmModal#error` 的既有口径）。 */
  const [deleteError, setDeleteError] = useState('')
  /** 删除成功的**页级提示条**（列表刷新后人在列表上，反馈贴结果而不是留在已关的模态里）。 */
  const [notice, setNotice] = useState('')
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'warn' | 'err'; lines: string[] } | null>(null)

  const key = sel?.trim() ?? ''
  const detail = useAsync(
    () => (key === '' ? Promise.resolve(undefined) : teamApi.skill(key)),
    [key],
  )

  useEffect(() => setView('detail'), [key])

  /**
   * 台账行 = 两路合并（口径与排序都在 `mergeSkillCatalog`，F1 起与角色表单选取器共用一份）。
   * 外部技能的 `category` / `external_removable` 与 `installed` / `roles` / `teams` 同源同路
   * （都只出现在 usage 路）——逐字段语义见 `skills-logic.ts`。
   */
  const rows = useMemo<SkillRow[]>(
    () => mergeSkillCatalog(skills.data?.skills ?? [], (usage.data ?? []) as SkillUsage[]),
    [skills.data, usage.data],
  )

  /**
   * S1 页头三轴计数（F8 §3.4 #3 后只剩两轴）：「内置 / 外部」这一列已删——来源是行内文字标记
   * （S3）且 F7 的分类组头已逐组报数（本批已落），页头再报一遍是按行第二遍陈述；
   * 保留的两轴都**行动相关**：已装/未装（决定命令块出不出）与 被角色/团队引用（决定谁是引用方）。
   */
  const counts = useMemo(
    () => ({
      installed: rows.filter((r) => r.installed).length,
      missing: rows.filter((r) => !r.installed).length,
      byRole: rows.filter((r) => r.roles.length > 0).length,
      byTeam: rows.filter((r) => r.teams.length > 0).length,
    }),
    [rows],
  )

  // S9：过滤扩到 name + 描述 + 引用方名（正文需逐个拉详情，客户端不做）
  const keyword = filter.trim().toLowerCase()
  const shown = rows.filter((r) => {
    if (onlyMissing && r.installed) return false
    if (keyword === '') return true
    const hay = [r.name, r.summary, ...r.roles, ...r.teams].join(' ').toLowerCase()
    return hay.includes(keyword)
  })

  /**
   * F7 分组（§3.5）：分组只吃**已过滤**的行——命中的组才出现，组头计数即命中数
   * （过滤后某组空了，该组连组头一起消失，不留空壳）。判据在 `skills-logic.ts`（node 直测）。
   */
  const groups = groupSkills(shown)

  /** 组头是**展开切换**不是导航实体：对齐知识库目录树 `.toc-mod` 的既有交互口径。 */
  const keyboardToggle = (e: ReactKeyboardEvent<HTMLDivElement>, run: () => void) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    run()
  }

  const toggleGroup = (category: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  const loading = skills.loading || usage.loading
  const error = skills.error ?? usage.error
  const skillsDir = skills.data?.skills_dir ?? ''
  const dirMissing = skills.data !== undefined && skillsDir === ''

  const refreshAll = () => {
    skills.reload()
    usage.reload()
    detail.reload()
  }

  const install = async (name: string) => {
    if (skillsDir === '') return
    setBusy(true)
    setFeedback(null)
    try {
      const out = await teamApi.skillInstall({ skills_dir: skillsDir, names: [name] })
      const lines = [
        t('skills.install.done', { n: out.written.length }),
        ...out.written.map((n) => `${t('skills.install.written')} ${n}`),
        ...out.skipped.map((s) => t('skills.install.skippedLine', { path: s.path, reason: s.reason })),
      ]
      setFeedback({ kind: out.skipped.length > 0 ? 'warn' : 'ok', lines })
      refreshAll()
    } catch (e) {
      setFeedback({ kind: 'err', lines: [t('common.loadFailed', { msg: e instanceof Error ? e.message : String(e) })] })
    } finally {
      setBusy(false)
    }
  }

  const uninstall = async () => {
    if (pendingUninstall === null || skillsDir === '') return
    setBusy(true)
    setFeedback(null)
    try {
      const out: SkillUninstallOutcome = await teamApi.skillUninstall({
        skills_dir: skillsDir,
        names: [pendingUninstall.name],
      })
      const lines = [
        t('skills.uninstall.done', { n: out.removed.length }),
        ...out.removed.map((n) => `${t('skills.uninstall.removed')} ${n}`),
        ...out.kept.map((k) => t('skills.uninstall.keptLine', { name: k.name, reason: k.reason })),
      ]
      setFeedback({ kind: out.kept.length > 0 ? 'warn' : 'ok', lines })
      setPendingUninstall(null)
      refreshAll()
    } catch (e) {
      setFeedback({ kind: 'err', lines: [t('common.loadFailed', { msg: e instanceof Error ? e.message : String(e) })] })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除**外部**技能（F3ui）：与 `uninstall` 是两条不同语义的动作（见本文件头注），
   * 故独立一条链路而不是给 `uninstall` 加分支——两者的入参、返回值、失败面都不同。
   *
   * 三点刻意：
   * 1. **不要求 `skills_dir`**：本口无 body，服务端用它自己解析的同源目录（`wiring.ts` 口径）；
   *    `skills_dir` 读不回来时「卸载」要禁用，但删除不受这条影响（少一个假禁用）；
   * 2. 失败码映射走 `skills-logic.ts#externalDeleteErrorKey`（纯函数、node 直测）；
   *    未知码原文透出（`common.loadFailed`），不猜服务端文案；
   * 3. 成功后若删的正是当前选中项 → 回列表页：实体已不存在，停在详情上只会看到
   *    一次 404「未命中」（与角色页 D-2「删除后不留幽灵浮层」同一条裁决）。
   */
  const removeExternal = async () => {
    if (pendingDelete === null) return
    const name = pendingDelete
    setBusy(true)
    setDeleteError('')
    setNotice('')
    try {
      const out = await teamApi.skillDeleteExternal(name)
      setPendingDelete(null)
      setNotice(t('skills.delete.done', { name, id: out.trash_id }))
      if (key === name) navigate({ page: 'skills' })
      refreshAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const mapped = externalDeleteErrorKey(msg)
      setDeleteError(mapped !== null ? t(mapped) : t('common.loadFailed', { msg }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * MINOR-13：`useAsync` 换 key 不清 `data`（`useAsync.ts:21`），首帧会把**上一个技能**的
   * 正文画到新 hash 下。只消费「名字与当前 key 一致」的那条（与 `Roles.tsx:111` 的
   * `linked.data.name === key` 同一守卫）；对不上且未报错时按未就绪走 loading，
   * 不落 notFound（否则换 key 的首帧会闪一次「未命中」）。
   */
  const d = detail.data !== undefined && detail.data.name === key ? detail.data : undefined
  const staleDetail = detail.data !== undefined && detail.data.name !== key
  /**
   * 选中技能的「外部可删」态（F3ui）：详情接口（`GET /api/skills/:name`）不下发
   * `external_removable`，故按名字回查 usage 路合出来的行——**行是它唯一的来源**，
   * 不回查内置清单、也不按名字猜（判定归服务端，见 `SkillUsage.external_removable`）。
   */
  const externalRemovable = d !== undefined && rows.find((r) => r.name === d.name)?.externalRemovable === true
  const detailPane =
    key === '' ? (
      <Pane>
        <div className="small muted">{t('skills.selectHint')}</div>
      </Pane>
    ) : detail.loading || (staleDetail && detail.error === undefined) ? (
      <Pane>
        {/* B10：详情加载走统一骨架，不再手写 `…` */}
        <State loading />
      </Pane>
    ) : detail.error !== undefined || d === undefined ? (
      /* 深链未命中（S9/R8 模式）：带名称 + 出路 */
      <Pane>
        <h3 className="mono">{key}</h3>
        <p className="muted">{t('skills.notFound.desc', { name: key })}</p>
        <div className="row">
          <a className="tool-btn" href={hrefOf({ page: 'skills' })}>{t('skills.notFound.back')}</a>
          <a className="tool-btn" href={hrefOf({ page: 'teams' })}>{t('skills.notFound.teams')}</a>
        </div>
      </Pane>
    ) : (
      <Pane
        head={
          <div className="pane-head">
            <h3 className="mono">{d.name}</h3>
            <StatusTag kind={d.installed ? 'ok' : 'warn'}>
              {d.installed ? t('common.installed') : t('common.notInstalled')}
            </StatusTag>
            {!d.installed && d.roles.length > 0 && (
              <StatusTag kind="warn">{t('skills.row.refWarn', { n: d.roles.length })}</StatusTag>
            )}
            <span className="spacer" />
            {view === 'detail' ? (
              <button type="button" className="tool-btn" onClick={() => setView('effective')}>
                {t('skills.effective.view')}
              </button>
            ) : (
              <button type="button" className="tool-btn" onClick={() => setView('detail')}>
                {t('skills.effective.back')}
              </button>
            )}
          </div>
        }
      >
        {view === 'effective' ? (
          <EffectiveSkills
            role={d.roles[0] ?? ''}
            roleOptions={d.roles.length > 0 ? d.roles : undefined}
            onOpenUsage={() => setView('detail')}
          />
        ) : (
          <SkillBody
            detail={d}
            skillsDir={skillsDir}
            dirMissing={dirMissing}
            busy={busy}
            feedback={feedback}
            externalRemovable={externalRemovable}
            onInstall={() => void install(d.name)}
            onAskUninstall={() => setPendingUninstall(d)}
            onAskDelete={() => setPendingDelete(d.name)}
          />
        )}
      </Pane>
    )

  return (
    <>
      {/* F3：`.page-fill` 吃满 `.page` 的**内容盒**（内容盒 = 视口 − 顶栏 − 页内边距，
          故不必写 `100vh − …` 的减法）；页头/计数条按内容占高、`.md` 吃剩余高度
          ⇒ 左右两栏各自在视口内滚动、整页不滚（见 styles.css 的 F3 段）。 */}
      <div className="page-fill">
        {/* B1：页标题走 `<PageHead>`（`--fs-600`/600）——手写 `<h1>` 是 UA 默认 28px/700。 */}
        <PageHead title={t('skills.title')} sub={t('skills.desc')} />

        {/* S1：页头计数 + 只看未装 + 过滤框。
            B7：三轴各两值此前是三条 `A n · B m` 独立计数行（第 5 种计数排法）→ 统一引线口径
            （`<CountLine>`）：一轴一列、每列两行，同列计数右对齐成一列（§2.9「可比的一列」）。
            F8 §3.4 #3：「内置 / 外部」列删除（该信息已由行内文字标记 S3 表达），剩两轴。 */}
        <div className="scope-head">
          <div className="scope-counts">
            <div className="scope-count-col">
              <CountLine label={t('common.installed')} count={counts.installed} />
              <CountLine label={t('common.notInstalled')} count={counts.missing} />
            </div>
            <div className="scope-count-col">
              <CountLine label={t('skills.counts.byRole')} count={counts.byRole} />
              <CountLine label={t('skills.counts.byTeam')} count={counts.byTeam} />
            </div>
          </div>
          <span className="spacer" />
          <label className="scope-check">
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            {t('skills.onlyMissing')}
          </label>
          <input
            className="role-filter"
            placeholder={t('skills.filterPlaceholder')}
            aria-label={t('skills.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {dirMissing && <div className="banner small">{t('skills.dirMissing')}</div>}
        {/* R-6 Q2（按触发源就地）：安装/卸载的**唯一触发面是详情**（`onInstall`/`onAskUninstall` 只由
            SkillBody 发起），故反馈条只渲染在详情内（见 SkillBody），页头不再镜像一份同样的结果。
            F3ui 的**外部技能删除**是这条口径的例外：删除成功后被删技能已不存在，详情要收口回列表
            （否则停在一次 404 上），反馈没有可依附的触发点 ⇒ 落到**页级**提示条（人在列表上）。 */}
        {notice !== '' && <div className="banner small" role="status">{notice}</div>}

        <State loading={loading} error={error} empty={!loading && !error && rows.length === 0} emptyText={t('skills.empty')}>
          <div className="md">
            <div className="md-list">
              {/* S9：检索/过滤无结果走行内空态（唯一出口），不再与整页空态同屏 */}
              {shown.length === 0 && (
                <div className="pane" style={{ margin: 'var(--s-2)' }}>
                  <p className="muted small">{t('skills.filterNone')}</p>
                </div>
              )}
              {/* F7 分类分组（§3.5）：**层级载体是「组」本身**——折叠态下组头是唯一的可见结构
                  （列表的第一眼 = 组名 + 计数）；展开后组内每一行仍按技能三层排（分组**不改变**
                  行的层级，只把「同一屏里的行数」从全量降到一组）。组内行容器走 `.collapse`
                  （工作流阶段已在用的高度过渡），**默认全展开**。 */}
              {groups.map((group) => {
                const open = !collapsedGroups.has(group.category)
                const uncategorized = group.category === UNCATEGORIZED
                return (
                  <div key={group.category} className="skill-group">
                    {/* 组头 = `CountLine size="section"`（组名 + 引线 + 计数）+ `.toc-chev`
                        （展开态旋转 90°，复用知识库目录树的既有类）。未分类组置**末尾**、
                        组头带 `CountLine` 的 `lamp`——`--warn` 是既有状态色，不是新增颜色。
                        `bare` 让引线吃满这一行的弹性宽度（`.pane-head` / `.row` 同款用法）。 */}
                    <div
                      className="skill-group-head"
                      role="button"
                      tabIndex={0}
                      aria-expanded={open}
                      onClick={() => toggleGroup(group.category)}
                      onKeyDown={(e) => keyboardToggle(e, () => toggleGroup(group.category))}
                    >
                      <CountLine
                        size="section"
                        bare
                        label={uncategorized ? t('skills.uncategorized') : group.category}
                        count={group.skills.length}
                        lamp={uncategorized}
                      />
                      <span className={`toc-chev${open ? ' open' : ''}`}>▸</span>
                    </div>
                    {/* 收起不卸载（`.collapse` 的 `grid-template-rows: 0fr→1fr` 要求内容常驻
                        DOM，见 `collapse-dom.test.ts`）；折叠态由 `visibility: hidden` 挡出
                        Tab 序列与无障碍树。 */}
                    <div className={`collapse${open ? ' open' : ''}`}>
                      <div>
                        {group.skills.map((row) => (
                          <NavRow
                            key={row.name}
                            href={hrefOf({ page: 'skills', sel: row.name })}
                            selected={key === row.name}
                          >
                            <span className="t mono">{row.name}</span>
                            {/* F8 §3.1 第一眼②：摘要收 **1 行 ≤32 字**（§3.4 #5 砍掉 2 行 clamp 与 76 字上限）
                                ——列表里只留入口，全文进详情第一眼（`SkillBody` 的 `.skill-desc`，不截断）；
                                截断量由 `.md-row .s` 的 `-webkit-line-clamp: 1`（styles.css）兜底。 */}
                            {row.summary !== '' && <span className="s">{firstSentence(row.summary, 32)}</span>}
                            {/* S3：来源与宿主都是行内文字标记（未装才给色与 lamp），排在摘要之后——
                                它们是「标记」不是标题，不参与第一眼的名字行。 */}
                            <span className="src">{row.builtin ? t('common.builtin') : t('common.external')}</span>
                            <span className="host">
                              {row.installed ? t('common.installed') : t('common.notInstalled')}
                              {!row.installed && <span className="scope-lamp" />}
                            </span>
                            {!row.installed && row.roles.length > 0 && (
                              <span className="tags">
                                <StatusTag kind="warn">{t('skills.row.refWarn', { n: row.roles.length })}</StatusTag>
                              </span>
                            )}
                          </NavRow>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* v7.1 P2：换技能 / 换视图（详情 ⇄ 有效集）时右栏**轻过渡**（纯 opacity）。
                `key` 让内容重挂 ⇒ 动画重放；顺带修掉一处旧语义：`SkillBody` 的
                「渲染 | 源码」档位此前跨技能保留（换了本书还停在上一本的源码档），
                重挂后回到默认的渲染档。
                **F8 §3.4 #4** 只把档位切换器挪进深挖 `<details>`（位置变），
                `mode` 仍是 `SkillBody` 的同一个 `useState`、重挂语义也仍由这里的 `key` 决定
                ——行为一字未改（见 `SkillBody` 头注）。

                **F7（本批）起左列有可折叠的分类组**（组头 + `.collapse`，见上）；
                「有效集」视图里的 全局/团队/角色 三段仍是**常驻信息**而非可折叠层
                ——为满足清单而给它加折叠会把「一眼看全」改成「再点一下」，属改信息架构，故不做。
                换视图的整块淡入仍是这里（`key` 含 `view`）。 */}
            <div className="md-detail">
              {/* F7 详情居中（§3.5 实施要点）：居中的单位是**详情整体**——命令块 / scope / 折叠
                  三层都在同一个 66ch 居中列内（列宽沿用 `.md-read` 口径），只给正文段加居中会
                  变成「正文居中、命令块与 scope 左贴」的错位。
                  ⚠ 这是**内层包裹**：滚动容器仍是 `.md-detail`（F3 的 `overflow-y` 不动），
                  左列表宽度也仍是 `.md` 网格的 `minmax(220px, 300px)`（居中列不反向影响它）。 */}
              <div className="swap-in skill-detail" key={`${key}|${view}`}>
                {detailPane}
              </div>
            </div>
          </div>
        </State>
      </div>

      {/* S5：卸载 = 统一确认模态（B5：Esc / 遮罩 / 滚动锁 / 焦点 / 危险色全站一套） */}
      {pendingUninstall !== null && (
        <ConfirmModal
          title={t('skills.uninstall.title', { name: pendingUninstall.name })}
          body={<p className="muted">{t('skills.uninstall.body')}</p>}
          busy={busy}
          confirmDisabled={skillsDir === ''}
          onConfirm={() => void uninstall()}
          onCancel={() => setPendingUninstall(null)}
        />
      )}

      {/* F3ui：外部技能删除 = 同一个确认零件（危险色 + 进回收站文案）。
          ⚠ 与上面的卸载模态**不共用** `confirmDisabled` 判据：删除口无 body、目录由服务端解析，
          本页读不到 `skills_dir` 时不该假装这条路走不通（少一个假禁用）。 */}
      {pendingDelete !== null && (
        <ConfirmModal
          title={t('skills.delete.title', { name: pendingDelete })}
          body={<p className="muted">{t('skills.delete.body')}</p>}
          busy={busy}
          error={deleteError}
          onConfirm={() => void removeExternal()}
          onCancel={() => {
            setPendingDelete(null)
            setDeleteError('')
          }}
        />
      )}
    </>
  )
}

/**
 * 技能详情正文（F8 §3.1 三段带）：
 *
 * - **第一眼**：`Pane` 头的名（`h3.mono` `--fs-500`，在 `SkillsPage`）+ 描述**直接作为正文**
 *   （`.skill-desc`，`--fs-300`/`--lh-ui`）——§3.4 #6 删「关于」段头：段头的语义是「这段是次要的」，
 *   给第一眼套段头等于把第一眼降级；
 * - **常用**：未装时的 `.scope-callout`（安装命令 + 口径说明 + 安装按钮、`.cmd-row`）、
 *   宿主状态（`Pane` 头的 `StatusTag`）+ 引用范围（`ScopeLayerRows` 三行）——§3.4 #2 删掉原来的
 *   「引用计数」独立行，计数并入本段 `CountLine`；
 * - **深挖**：`<details class="skill-deep">` 默认折叠，装 SKILL.md 全文 + 安装路径（§3.4 #1/#4）。
 *   档位切换器（`.seg`）随之进折叠，但**行为不变**：`mode` 仍是本组件里那一个 `useState`，
 *   切换仍是原来的 `setMode`，跨技能重置仍由外层 `.swap-in` 的 `key` 决定（P2 旧语义），
 *   本轮只挪位置。（`skills-install-pending.test.ts` 只走安装按钮，未断言档位位置。）
 * - **F3ui 破坏性动作**：`externalRemovable` 时出「删除」（整目录进回收站），否则出既有的
 *   「卸载」——**二选一**，不是并排两个按钮：同一条目录上两者的语义互斥（卸载只清 Prism 产物，
 *   对外部技能恒 `kept`），并排只会让用户选错。
 */
function SkillBody({
  detail,
  skillsDir,
  dirMissing,
  busy,
  feedback,
  externalRemovable,
  onInstall,
  onAskUninstall,
  onAskDelete,
}: {
  detail: SkillDetail
  skillsDir: string
  dirMissing: boolean
  busy: boolean
  feedback: { kind: string; lines: string[] } | null
  /** 外部可删态（来自 usage 行）：`true` 才把「卸载」换成「删除」。 */
  externalRemovable: boolean
  onInstall: () => void
  onAskUninstall: () => void
  onAskDelete: () => void
}) {
  const t = useT()
  const [mode, setMode] = useState<'render' | 'source'>('render')
  const parsed = useMemo(() => parseMarkdown(detail.content), [detail.content])
  /* F9-3：详情头描述先剥 frontmatter 块标量标记（`description: >-` 在服务端单行解析下
     会把 `>-` 当值）。剥完为空 ⇒ 与服务端没返回描述同一档，走既有空态文案（`common.unset`），
     而不是渲染一个内容为 `>-` 的伪描述。 */
  const desc = cleanSkillDescription(detail.description)

  return (
    <>
      {/* 第一眼②：描述即正文（不截断——左侧列表的 32 字摘要只是入口，全文落在这里）。 */}
      <div className="skill-desc">{desc !== '' ? desc : t('common.unset')}</div>

      {/* S4：未装三件套 —— 可复制命令 + 口径说明 + 安装按钮（F8 §3.1「常用」：命令块放 `.scope-callout`）。 */}
      {!detail.installed && (
        <div className="scope-callout">
          <div className="small muted">{t('skills.install.notByPrism')}</div>
          <CopyCommand command={`prism skill install ${detail.name}`} label={t('skills.install.copy')} />
          <div className="row">
            <button
              type="button"
              className="tool-btn"
              disabled={busy || !skillsDir}
              aria-busy={busy}
              title={dirMissing ? t('skills.dirMissing') : undefined}
              onClick={onInstall}
            >
              {busy ? t('skills.install.busy') : t('skills.install.action')}
            </button>
          </div>
        </div>
      )}
      {dirMissing && <div className="small err-text">{t('skills.dirMissing')}</div>}

      {/* 常用④：宿主状态由 `Pane` 头的 `StatusTag` 表达（§3.1「一行 StatusTag + ScopeLayerRows」），
          原先「宿主」段的两行（状态行重复、计数行与三行同源）整段删除；计数并到这里（§3.4 #2）。 */}
      <CountLine
        label={t('skills.scope')}
        count={t('skills.counts.refs', { roles: detail.roles.length, teams: detail.teams.length })}
        size="section"
      />
      <ScopeLayerRows installed={detail.installed} teams={detail.teams} roles={detail.roles} />

      {/* 卸载是安装的对位动作，留在常用带可见处（不进深挖折叠）。
          F3ui：外部可删技能把这一格换成「删除」（同一位置、同一零件，语义换一条口）。 */}
      {detail.installed && (
        <div className="row" style={{ marginTop: 'var(--s-2)' }}>
          {externalRemovable ? (
            <button type="button" className="tool-btn" disabled={busy} onClick={onAskDelete}>
              {t('skills.delete.action')}
            </button>
          ) : (
            <button type="button" className="tool-btn" disabled={busy || skillsDir === ''} onClick={onAskUninstall}>
              {t('skills.uninstall.action')}
            </button>
          )}
        </div>
      )}

      {/* 深挖⑤（§0.1：默认折叠，summary 一行常驻）：路径（§3.4 #1）+ SKILL.md 全文（§3.4 #4）。 */}
      <details className="skill-deep">
        <summary>{t('skills.deepDive')}</summary>
        <div className="row">
          <span className="small muted">{t('skills.detail.path')}</span>
          <span className="mono small" style={{ wordBreak: 'break-all' }}>{detail.path}</span>
        </div>
        <div className="row" style={{ marginTop: 'var(--s-2)' }}>
          <div className="seg">
            <button type="button" className={mode === 'render' ? 'on' : ''} onClick={() => setMode('render')}>
              {t('skills.view.render')}
            </button>
            <button type="button" className={mode === 'source' ? 'on' : ''} onClick={() => setMode('source')}>
              {t('skills.view.source')}
            </button>
          </div>
        </div>
        {detail.content === '' ? (
          <div className="small muted">{t('skills.detail.bodyUnavailable')}</div>
        ) : mode === 'source' ? (
          <div className="md-source-wrap">
            <pre className="md-source">{detail.content}</pre>
          </div>
        ) : (
          /* S10：frontmatter 结构化 kv + 正文渲染（复用 Markdown） */
          <>
            {parsed.frontmatter !== undefined && (
              <table className="md-frontmatter">
                <tbody>
                  {Object.entries(parsed.frontmatter).map(([k, v]) => (
                    <tr key={k}>
                      <th className="mono">{k}</th>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="md-body md-read">
              <MarkdownBlocks blocks={parsed.blocks} />
            </div>
          </>
        )}
      </details>
      {feedback !== null && (
        <div className="banner small" style={{ marginTop: 'var(--s-2)' }}>
          {feedback.lines.map((line, i) => (
            <div key={i} className={i === 0 ? '' : 'small muted'}>{line}</div>
          ))}
        </div>
      )}
    </>
  )
}
