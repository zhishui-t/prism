import { useEffect, useMemo, useState } from 'react'

import { teamApi, type ValidationIssue } from '../api-team.ts'
import { useAsync } from '../components/useAsync.ts'
import { useT } from '../i18n.ts'

/**
 * 角色页（2026-09-15 重设计）：
 * 卡片网格 + 侧栏详情。用户反馈「信息太杂乱、全是文字没重点、skill 默认不显示」。
 *
 * 卡片只显示：角色名（带颜色）、一句话职责、模型/思考档、所属团队数。
 * 点击卡片 → 右侧抽屉展开全部详情（第一原则、skill、知识绑定、正文）。
 */

const COLOR_MAP: Record<string, string> = {
  red: '#e05555', blue: '#5b8cff', green: '#35c46b', yellow: '#e0c23a',
  purple: '#a06bff', orange: '#e08a3a', pink: '#e06ba0', cyan: '#3ac0c4',
  gray: '#8b93a7',
}
function colorOf(c?: string): string {
  return (c !== undefined && COLOR_MAP[c]) || '#8b93a7'
}

interface TeamRef {
  teamId: string
  teamName: string
}

export function RolesPage({ sel, onSelect }: { sel?: string; onSelect?: (name?: string) => void }) {
  const t = useT()
  const roles = useAsync(() => teamApi.roles(), [])
  const teams = useAsync(() => teamApi.teams(), [])
  const [selected, setSelected] = useState<string>(sel ?? '')
  const [showDrawer, setShowDrawer] = useState(false)
  /** 深链指向的角色不在列表（已删 / 名字错）时的提示；空串 = 无 */
  const [notFoundName, setNotFoundName] = useState('')

  const roleList = useMemo(() => roles.data?.roles ?? [], [roles.data])
  const teamList = useMemo(() => teams.data?.teams ?? [], [teams.data])

  // 深链：sel 变化时打开对应角色的抽屉（Teams 页「查看角色」跳转也走这里）。
  // 列表加载完仍找不到该角色 → 视为不存在/已删：给提示并回写清掉 sel，别卡在「抽屉开着却没内容」的死状态。
  useEffect(() => {
    if (sel === undefined || sel === '') return
    if (roles.loading) return
    if (roleList.some((r) => r.name === sel)) {
      setNotFoundName('')
      setSelected(sel)
      setShowDrawer(true)
    } else {
      // 提示不随 sel 被清空而消失（否则刚显示就被本 effect 抹掉）；等选中下一个角色时再清。
      setNotFoundName(sel)
      setShowDrawer(false)
      setSelected('')
      onSelect?.(undefined)
    }
    // onSelect 是 Shell 的稳定转发（只闭包 navigate），不入依赖无陈旧风险
  }, [sel, roles.loading, roleList])

  // 角色 → 所属团队映射
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

  const role = useMemo(() => {
    if (selected === '') return null
    return roleList.find((r) => r.name === selected) ?? null
  }, [roleList, selected])

  const openDetail = (name: string) => {
    setNotFoundName('')
    setSelected(name)
    setShowDrawer(true)
    onSelect?.(name)
  }

  /** 关抽屉 → 回写 hash 去掉 sel（深链与界面状态一致）。 */
  const closeDrawer = () => {
    setShowDrawer(false)
    onSelect?.(undefined)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('roles.title')}</h1>
          <p className="muted">{t('roles.overviewCount', { roles: roleList.length, assigned: roleTeams.size })}</p>
        </div>
      </div>

      {roles.error && <div className="error">{roles.error}</div>}
      {roles.loading && <div className="muted">…</div>}
      {notFoundName !== '' && <div className="banner small">{t('roles.notFound')}</div>}

      <div className="role-grid">
        {roleList.map((r) => {
          const teams2 = roleTeams.get(r.name) ?? []
          const errors = (r.issues ?? []).filter((i: ValidationIssue) => i.level === 'error').length
          return (
            <div key={r.name} className="role-card" onClick={() => openDetail(r.name)}>
              <div className="role-name">
                <span
                  className="role-dot"
                  style={{
                    background: colorOf(r.color),
                  }}
                />
                {r.name}
                {errors > 0 && (
                  <span className="role-tag" style={{ background: '#e0555522', color: '#e05555', marginLeft: 'auto' }}>
                    ⚠ {errors}
                  </span>
                )}
              </div>
              <div className="role-desc">
                {firstSentence(r.description)}
              </div>
              <div className="role-tags">
                {r.model && <span className="role-tag">⚙ {shortModel(r.model)}</span>}
                {r.thoughtLevel && <span className="role-tag">🧠 {r.thoughtLevel}</span>}
                {teams2.length > 0 && (
                  <span className="role-tag" style={{ background: 'color-mix(in srgb, var(--accent) 13%, transparent)', color: 'var(--accent)' }}>
                    👥 {t('roles.teamCount', { n: teams2.length })}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 侧栏详情 */}
      {showDrawer && role !== null && (
        <>
          <div
            onClick={closeDrawer}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 99 }}
          />
          <div className="role-detail-drawer">
            <button className="drawer-close" onClick={closeDrawer}>✕</button>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: colorOf(role.color) }} />
              {role.name}
            </h3>

            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 16 }}>
              {role.description}
            </p>

            {/* 第一原则 */}
            {role.principle && role.principle.trim() !== '' && (
              <div style={{ background: 'var(--panel-2)', borderRadius: 8, padding: 12, marginBottom: 16, borderLeft: '3px solid var(--accent)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 4 }}>{t('roles.principle')}</div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>{role.principle}</div>
              </div>
            )}

            {/* 配置标签 */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16 }}>
              {role.model && <span className="tag">model: {role.model}</span>}
              {role.thoughtLevel && <span className="tag">thought: {role.thoughtLevel}</span>}
              {role.color && <span className="tag">color: {role.color}</span>}
            </div>

            {/* 所属团队 */}
            {(roleTeams.get(role.name) ?? []).length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>{t('roles.teams')}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {(roleTeams.get(role.name) ?? []).map((tm) => (
                    <span key={tm.teamId} className="tag" style={{ background: 'color-mix(in srgb, var(--accent) 13%, transparent)', color: 'var(--accent)' }}>
                      {tm.teamName}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Skill 白名单 */}
            {role.skills && role.skills.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>{t('roles.capabilities')}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {role.skills.map((s: string) => (
                    <span key={s} className="tag">{s}</span>
                  ))}
                </div>
              </div>
            )}

            {/* 知识绑定 */}
            {(role.knowledge?.layers?.length ?? 0) > 0 || (role.knowledge?.books?.length ?? 0) > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>{t('roles.knowledgeScope')}</div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {role.knowledge.layers?.map((l: string) => (
                    <span key={l} className="tag">layer: {l}</span>
                  ))}
                  {role.knowledge.books?.map((b: string) => (
                    <span key={b} className="tag">book: {b}</span>
                  ))}
                </div>
              </div>
            ) : null}

            {/* 正文 */}
            <details>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                {t('common.showDetails')}
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, background: 'var(--panel-2)', padding: 12, borderRadius: 8 }}>
                {role.body}
              </pre>
            </details>

            {/* 校验问题 */}
            {(role.issues ?? []).length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>{t('roles.issues')}</div>
                {(role.issues ?? []).map((issue: ValidationIssue, i: number) => (
                  <div key={i} style={{ fontSize: 12, color: issue.level === 'error' ? '#e05555' : 'var(--muted)', marginBottom: 2 }}>
                    {issue.level === 'error' ? '✗' : '⚠'} {issue.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

/** 模型名缩短显示。 */
function shortModel(model: string): string {
  // "custom:builtin%3Abigmodel-coding-plan:GLM-5.3-Flash" → "GLM-5.3-Flash"
  const parts = model.split(':')
  const last = parts[parts.length - 1] ?? model
  // 裸 `%` 会让 decodeURIComponent 抛 URIError（无 ErrorBoundary 时整页白屏）→ 失败回落原文
  let decoded: string
  try {
    decoded = decodeURIComponent(last)
  } catch {
    decoded = last
  }
  return decoded.slice(0, 20)
}

/** 取第一句（到第一个句号/换行）。 */
function firstSentence(text: string): string {
  const idx = text.search(/[。\n]|\. /)
  return idx > 0 ? text.slice(0, idx + 1) : text.slice(0, 80)
}
