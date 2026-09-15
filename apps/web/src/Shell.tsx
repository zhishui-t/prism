import { KnowledgePage } from './pages/Knowledge.tsx'
import { ProjectsPage } from './pages/Projects.tsx'
import { CodeGraphPage } from './pages/CodeGraph.tsx'
import { TasksPage } from './pages/Tasks.tsx'
import { RolesPage } from './pages/Roles.tsx'
import { TeamsPage } from './pages/Teams.tsx'
import { SkillsPage } from './pages/Skills.tsx'
import { useT } from './i18n.ts'
import { navigate, useRoute } from './route.ts'
import { toggleTheme, useTheme } from './theme.ts'
import { toggleLang } from './i18n.ts'
import type { DictKey } from './i18n.ts'
import type { PageKey } from './nav.ts'

// 知识图谱/架构图谱没有一级页：它们归入「知识库 → 当前范围」（用户裁决）。
export type { PageKey }

const NAV: Array<{ key: PageKey; label: DictKey; group?: DictKey }> = [
  { key: 'knowledge', label: 'nav.knowledge' },
  { key: 'graph', label: 'nav.graph' },
  { key: 'projects', label: 'nav.projects' },
  { key: 'roles', label: 'nav.roles', group: 'nav.group.org' },
  { key: 'teams', label: 'nav.teams' },
  { key: 'skills', label: 'nav.skills' },
  { key: 'tasks', label: 'nav.tasks' },
]

/**
 * 控制台外壳：顶栏（品牌 · 导航 · 主题/语言）+ 页面。
 *
 * 导航状态全部来自 hash（`route.ts`）——刷新、分享链接、前进后退都保留位置；
 * 支持深链的页面（knowledge / roles / teams / skills）通过 `sel` 收「该展开哪个实体」，
 * 通过 `onSelect` 回写 hash（graph / projects / tasks 无实体深链）。
 */
export function Shell() {
  const route = useRoute()
  const theme = useTheme()
  const t = useT()

  let lastGroup: string | undefined
  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          Prism<span>{t('brand.suffix')}</span>
        </div>
        <nav className="topnav">
          {NAV.map((item) => {
            const showGroup = item.group !== undefined && item.group !== lastGroup
            lastGroup = item.group
            const label = t(item.label)
            return (
              <span key={item.key} className="topnav-cell">
                {showGroup && <span className="nav-group">{t(item.group ?? item.label)}</span>}
                <button
                  className={`nav-item${route.page === item.key ? ' active' : ''}`}
                  onClick={() => navigate({ page: item.key })}
                >
                  {label}
                </button>
              </span>
            )
          })}
        </nav>
        <div className="topbar-tools">
          <button
            className="tool-btn"
            title={t('theme.hint')}
            aria-label={t('theme.hint')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
          </button>
          <button className="tool-btn" title={t('lang.hint')} aria-label={t('lang.hint')} onClick={toggleLang}>
            {t('lang.switch')}
          </button>
        </div>
      </header>
      <main className="main">
        {route.page === 'knowledge' && (
          <KnowledgePage
            sel={route.sel}
            onSelect={(id) =>
              navigate(id === undefined || id === '' ? { page: 'knowledge' } : { page: 'knowledge', sel: id })
            }
          />
        )}
        {route.page === 'graph' && <CodeGraphPage />}
        {route.page === 'projects' && <ProjectsPage />}
        {route.page === 'roles' && (
          <RolesPage
            sel={route.sel}
            onSelect={(name) =>
              navigate(name === undefined || name === '' ? { page: 'roles' } : { page: 'roles', sel: name })
            }
          />
        )}
        {route.page === 'teams' && (
          <TeamsPage
            sel={route.sel}
            onSelect={(id) => navigate({ page: 'teams', sel: id })}
            onOpenRole={(name) => navigate({ page: 'roles', sel: name })}
            onOpenUsageSkills={() => navigate({ page: 'skills' })}
          />
        )}
        {route.page === 'skills' && (
          <SkillsPage
            sel={route.sel}
            onSelect={(name) => navigate({ page: 'skills', sel: name })}
            onOpenRole={(name) => navigate({ page: 'roles', sel: name })}
            onOpenTeam={(id) => navigate({ page: 'teams', sel: id })}
          />
        )}
        {route.page === 'tasks' && <TasksPage />}
      </main>
    </div>
  )
}
