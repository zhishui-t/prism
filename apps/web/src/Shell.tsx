import { useEffect, useState } from 'react'

import { api } from './api.ts'
import { Icon, PrismMark, type IconName } from './components/Icon.tsx'
import { useClipboard } from './components/useClipboard.ts'
import { useT } from './i18n.ts'
import { toggleLang } from './i18n.ts'
import type { DictKey } from './i18n.ts'
import { CodeGraphPage } from './pages/CodeGraph.tsx'
import { KnowledgePage } from './pages/Knowledge.tsx'
import { ProjectsPage } from './pages/Projects.tsx'
import { RolesPage } from './pages/Roles.tsx'
import { SkillsPage } from './pages/Skills.tsx'
import { TeamsPage } from './pages/teams/TeamsPage.tsx'
import { WorkflowsPage } from './pages/Workflows.tsx'
import { hrefOf, navigate, queryOf, useRoute, withQuery } from './route.ts'
import { toggleTheme, useTheme } from './theme.ts'
import type { PageKey } from './nav.ts'

export type { PageKey }

/**
 * 一级导航：左侧栏按语义分成三组，组标签是导航骨架而非页面。
 * 顺序与 `nav.ts` 的 PageKey 一致；图标在 `components/Icon.tsx` 内联定义（零依赖）。
 */
const NAV_GROUPS: ReadonlyArray<{
  label: DictKey
  items: ReadonlyArray<{ key: PageKey; label: DictKey; icon: IconName }>
}> = [
  {
    label: 'nav.group.knowledge',
    items: [
      { key: 'knowledge', label: 'nav.knowledge', icon: 'book' },
      { key: 'graph', label: 'nav.graph', icon: 'graph' },
    ],
  },
  {
    label: 'nav.group.workspace',
    items: [{ key: 'projects', label: 'nav.projects', icon: 'folder' }],
  },
  {
    label: 'nav.group.org',
    items: [
      { key: 'roles', label: 'nav.roles', icon: 'user' },
      { key: 'teams', label: 'nav.teams', icon: 'users' },
      { key: 'workflows', label: 'nav.workflows', icon: 'workflow' },
      { key: 'skills', label: 'nav.skills', icon: 'sparkles' },
    ],
  },
]

const ALL_ITEMS = NAV_GROUPS.flatMap((group) => group.items)

/**
 * 顶栏「复制当前页链接」：深链是控制台的唯一选中真相，把地址栏 URL 复制走就是分享。
 * 成功后就地换成对勾 +「已复制」，1.6s 复位；剪贴板不可用时静默失败，不打断页面。
 */
function CopyLinkButton() {
  const t = useT()
  const { copied, copy } = useClipboard()

  const label = copied ? t('common.copied') : t('common.copyLink')
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        title={label}
        aria-label={label}
        onClick={() => copy(window.location.href)}
      >
        <Icon name={copied ? 'check' : 'link'} size={16} />
      </button>
      {copied && (
        <span className="copy-note" role="status">
          {t('common.copied')}
        </span>
      )}
    </>
  )
}

/**
 * 连接状态（侧栏底部常驻）：
 * - 健康：一个绿点 +「本地工作区」，不引入更多环境装饰；
 * - 断连：红点 + 文案 + 重试，不轮询、不弹错、不阻塞页面。
 */
function ConnStatus() {
  const t = useT()
  const route = useRoute()
  const [down, setDown] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    api
      .health()
      .then(() => {
        if (alive) setDown(false)
      })
      .catch(() => {
        if (alive) setDown(true)
      })
    return () => {
      alive = false
    }
  }, [route.page, route.sel, tick])

  return (
    <span className="side-status" aria-live="polite">
      <span className={`status-dot${down ? ' down' : ''}`} />
      <span className={`side-status-text${down ? ' muted' : ''}`}>
        {down ? t('common.offline') : t('shell.local')}
      </span>
      {down && (
        <button type="button" className="tool-btn" onClick={() => setTick((n) => n + 1)}>
          {t('common.retry')}
        </button>
      )}
    </span>
  )
}

export function Shell() {
  const route = useRoute()
  const theme = useTheme()
  const t = useT()
  const current = ALL_ITEMS.find((item) => item.key === route.page)

  /**
   * 全局 `/`：聚焦当前页的第一个搜索 / 过滤框（`SearchField` 带 `data-search-input`）。
   * 输入框、文本域、下拉和任何浮层里不抢键——那是用户正在输入的地方。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null) {
        return
      }
      if (document.querySelector('.modal-mask, .drawer-mask') !== null) return
      const input = document.querySelector<HTMLInputElement>('[data-search-input]')
      if (input === null) return
      event.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <PrismMark size={19} />
          </span>
          <span className="brand-text">
            <span className="brand-name">Prism</span>
            <span className="brand-sub">{t('brand.suffix').trim()}</span>
          </span>
        </div>

        <nav className="side-nav" aria-label={t('shell.nav')}>
          {NAV_GROUPS.map((group) => (
            <div className="nav-block" key={group.label}>
              <div className="nav-block-label">{t(group.label)}</div>
              {group.items.map((item) => {
                const active = route.page === item.key
                return (
                  <a
                    key={item.key}
                    className={`nav-item${active ? ' active' : ''}`}
                    href={hrefOf({ page: item.key })}
                    title={t(item.label)}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className="nav-icon">
                      <Icon name={item.icon} size={18} />
                    </span>
                    <span className="nav-label">{t(item.label)}</span>
                  </a>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <ConnStatus />
          <div className="side-actions">
            <button
              type="button"
              className="icon-btn"
              title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              onClick={toggleTheme}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
            </button>
            <button
              type="button"
              className="icon-btn wide"
              title={t('lang.hint')}
              aria-label={t('lang.hint')}
              onClick={toggleLang}
            >
              {t('lang.switch')}
            </button>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="crumb">
            <span className="crumb-root">Prism</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="crumb-current">{current !== undefined ? t(current.label) : t('brand.suffix').trim()}</span>
            {route.sel !== undefined && route.sel !== '' && (
              <>
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
                <span className="crumb-sel" title={route.sel}>
                  {route.sel}
                </span>
              </>
            )}
          </div>
          <div className="topbar-tools">
            <CopyLinkButton />
          </div>
        </header>

        <main className="main">
          <div className="page">
            <div className="page-inner">
              {route.page === 'knowledge' && (
                <KnowledgePage
                  sel={route.sel}
                  query={route.query}
                  onQuery={(patch) => navigate(withQuery(route, patch))}
                  onSelect={(id) => {
                    // 选中条目沿用 WITH_SEL 形态，但保留 query——否则点条目会把层/书过滤冲掉
                    const next =
                      id === undefined || id === ''
                        ? { page: 'knowledge' as const }
                        : { page: 'knowledge' as const, sel: id }
                    const kept = queryOf(route)
                    navigate(Object.keys(kept).length === 0 ? next : { ...next, query: kept })
                  }}
                />
              )}
              {route.page === 'graph' && <CodeGraphPage sel={route.sel} />}
              {route.page === 'projects' && <ProjectsPage />}
              {route.page === 'roles' && <RolesPage sel={route.sel} />}
              {route.page === 'teams' && (
                <TeamsPage
                  sel={route.sel}
                  onSelect={(id) => navigate({ page: 'teams', sel: id })}
                  onOpenUsageSkills={() => navigate({ page: 'skills' })}
                />
              )}
              {route.page === 'skills' && <SkillsPage sel={route.sel} />}
              {route.page === 'workflows' && (
                <WorkflowsPage
                  sel={route.sel}
                  onSelect={(id) => navigate({ page: 'workflows', sel: id })}
                />
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
