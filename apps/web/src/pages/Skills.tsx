import { useEffect, useMemo, useState } from 'react'

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
import { hrefOf } from '../route.ts'
import { useT } from '../i18n.ts'

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
 */

interface SkillRow {
  name: string
  summary: string
  builtin: boolean
  installed: boolean
  roles: string[]
  teams: string[]
}

export function SkillsPage({ sel }: { sel?: string }) {
  const t = useT()
  const skills = useAsync(() => teamApi.skills(), [])
  const usage = useAsync(() => teamApi.skillUsage(), [])
  const [filter, setFilter] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  /** 页内视图切换（**不进 hash**，S7）：详情 | 有效集（正向视图） */
  const [view, setView] = useState<'detail' | 'effective'>('detail')
  const [busy, setBusy] = useState(false)
  const [pendingUninstall, setPendingUninstall] = useState<SkillDetail | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'warn' | 'err'; lines: string[] } | null>(null)

  const key = sel?.trim() ?? ''
  const detail = useAsync(
    () => (key === '' ? Promise.resolve(undefined) : teamApi.skill(key)),
    [key],
  )

  useEffect(() => setView('detail'), [key])

  const rows = useMemo<SkillRow[]>(() => {
    const map = new Map<string, SkillRow>()
    const ensure = (name: string): SkillRow => {
      let row = map.get(name)
      if (row === undefined) {
        row = { name, summary: '', builtin: false, installed: false, roles: [], teams: [] }
        map.set(name, row)
      }
      return row
    }
    for (const skill of skills.data?.skills ?? []) {
      const row = ensure(skill.name)
      row.builtin = true
      row.summary = skill.description
    }
    for (const item of (usage.data ?? []) as SkillUsage[]) {
      const row = ensure(item.name)
      row.builtin = row.builtin || item.builtin
      row.installed = item.installed
      row.roles = item.roles
      row.teams = item.teams
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [skills.data, usage.data])

  const counts = useMemo(
    () => ({
      builtin: rows.filter((r) => r.builtin).length,
      external: rows.filter((r) => !r.builtin).length,
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
   * MINOR-13：`useAsync` 换 key 不清 `data`（`useAsync.ts:21`），首帧会把**上一个技能**的
   * 正文画到新 hash 下。只消费「名字与当前 key 一致」的那条（与 `Roles.tsx:111` 的
   * `linked.data.name === key` 同一守卫）；对不上且未报错时按未就绪走 loading，
   * 不落 notFound（否则换 key 的首帧会闪一次「未命中」）。
   */
  const d = detail.data !== undefined && detail.data.name === key ? detail.data : undefined
  const staleDetail = detail.data !== undefined && detail.data.name !== key
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
            onInstall={() => void install(d.name)}
            onAskUninstall={() => setPendingUninstall(d)}
          />
        )}
      </Pane>
    )

  return (
    <>
      {/* B1：页标题走 `<PageHead>`（`--fs-600`/600）——手写 `<h1>` 是 UA 默认 28px/700。 */}
      <PageHead title={t('skills.title')} sub={t('skills.desc')} />

      {/* S1：页头三轴计数 + 只看未装 + 过滤框。
          B7：三轴各两值此前是三条 `A n · B m` 独立计数行（第 5 种计数排法）→ 统一引线口径
          （`<CountLine>`）：一轴一列、每列两行，同列计数右对齐成一列（§2.9「可比的一列」）。 */}
      <div className="scope-head">
        <div className="scope-counts">
          <div className="scope-count-col">
            <CountLine label={t('common.builtin')} count={counts.builtin} />
            <CountLine label={t('common.external')} count={counts.external} />
          </div>
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
          SkillBody 发起），故反馈条只渲染在详情内（见 SkillBody），页头不再镜像一份同样的结果。 */}

      <State loading={loading} error={error} empty={!loading && !error && rows.length === 0} emptyText={t('skills.empty')}>
        <div className="md">
          <div className="md-list">
            {/* S9：检索/过滤无结果走行内空态（唯一出口），不再与整页空态同屏 */}
            {shown.length === 0 && (
              <div className="pane" style={{ margin: 'var(--s-2)' }}>
                <p className="muted small">{t('skills.filterNone')}</p>
              </div>
            )}
            {shown.map((row) => (
              <NavRow
                key={row.name}
                href={hrefOf({ page: 'skills', sel: row.name })}
                selected={key === row.name}
              >
                <span className="t mono">{row.name}</span>
                {/* S3：来源与宿主都是行内文字标记（未装才给色与 lamp） */}
                <span className="src">{row.builtin ? t('common.builtin') : t('common.external')}</span>
                <span className="host">
                  {row.installed ? t('common.installed') : t('common.notInstalled')}
                  {!row.installed && <span className="scope-lamp" />}
                </span>
                {row.summary !== '' && <span className="s">{firstSentence(row.summary, 76)}</span>}
                {!row.installed && row.roles.length > 0 && (
                  <span className="tags">
                    <StatusTag kind="warn">{t('skills.row.refWarn', { n: row.roles.length })}</StatusTag>
                  </span>
                )}
              </NavRow>
            ))}
          </div>

          {/* v7.1 P2：换技能 / 换视图（详情 ⇄ 有效集）时右栏**轻过渡**（纯 opacity）。
              `key` 让内容重挂 ⇒ 动画重放；顺带修掉一处旧语义：`SkillBody` 的
              「渲染 | 源码」档位此前跨技能保留（换了本书还停在上一本的源码档），
              重挂后回到默认的渲染档。

              关于「技能分组展开」：本页左列是**扁平台账**，没有可折叠的分组结构；
              分组的只有「有效集」视图里的 全局/团队/角色 三段，它们是**常驻信息**而非可折叠层
              ——为满足清单而给它加折叠会把「一眼看全」改成「再点一下」，属改信息架构，故不做。
              等效落点是这里：切进有效集时整块淡入（取舍见报告 §5 开放项）。 */}
          <div className="md-detail">
            <div className="swap-in" key={`${key}|${view}`}>
              {detailPane}
            </div>
          </div>
        </div>
      </State>

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
    </>
  )
}

function SkillBody({
  detail,
  skillsDir,
  dirMissing,
  busy,
  feedback,
  onInstall,
  onAskUninstall,
}: {
  detail: SkillDetail
  skillsDir: string
  dirMissing: boolean
  busy: boolean
  feedback: { kind: string; lines: string[] } | null
  onInstall: () => void
  onAskUninstall: () => void
}) {
  const t = useT()
  const [mode, setMode] = useState<'render' | 'source'>('render')
  const parsed = useMemo(() => parseMarkdown(detail.content), [detail.content])

  return (
    <>
      <h4>{t('skills.detail.about')}</h4>
      <div className="small">{detail.description !== '' ? detail.description : t('common.unset')}</div>

      <h4>{t('skills.host')}</h4>
      {/* B11：状态与引用计数此前同行拼 `已装 · 被角色引用 N · …` → 拆两行（§7.1 两行排版）。 */}
      <div className="small">{detail.installed ? t('common.installed') : t('common.notInstalled')}</div>
      <div className="small muted">
        {t('skills.counts.refs', { roles: detail.roles.length, teams: detail.teams.length })}
      </div>
      {/* S4：未装三件套 —— 可复制命令 + 口径说明 + 安装按钮 */}
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

      <h4>{t('skills.scope')}</h4>
      <ScopeLayerRows installed={detail.installed} teams={detail.teams} roles={detail.roles} />

      <h4>{t('skills.detail.path')}</h4>
      <div className="mono small" style={{ wordBreak: 'break-all' }}>{detail.path}</div>
      {detail.installed && (
        <div className="row" style={{ marginTop: 'var(--s-2)' }}>
          <button type="button" className="tool-btn" disabled={busy || skillsDir === ''} onClick={onAskUninstall}>
            {t('skills.uninstall.action')}
          </button>
        </div>
      )}

      <div className="row" style={{ marginTop: 'var(--s-4)' }}>
        <h4 style={{ margin: 0 }}>SKILL.md</h4>
        <span className="spacer" />
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
