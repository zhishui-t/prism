import { useState } from 'react'

import { KnowledgePage } from './pages/Knowledge.tsx'
import { ProjectsPage } from './pages/Projects.tsx'
import { CodeGraphPage } from './pages/CodeGraph.tsx'
import { TasksPage } from './pages/Tasks.tsx'
import { RolesPage } from './pages/Roles.tsx'
import { TeamsPage } from './pages/Teams.tsx'
import { SkillsPage } from './pages/Skills.tsx'
import type { NavTarget, PageKey } from './nav.ts'

// 知识图谱/架构图谱没有一级页：它们归入「知识库 → 书内」（用户裁决）。
export type { PageKey } 

const NAV: Array<{ key: PageKey; label: string; group?: string }> = [
  { key: 'knowledge', label: '知识库' },
  { key: 'graph', label: '代码图谱' },
  { key: 'projects', label: '项目台账' },
  { key: 'roles', label: '角色', group: '团队' },
  { key: 'teams', label: '团队', group: '团队' },
  { key: 'skills', label: '技能', group: '团队' },
  { key: 'tasks', label: '任务中心' },
]

export function Shell() {
  const [page, setPage] = useState<PageKey>('knowledge')
  /** 跨页跳转意图（F-D2 有效集 ↔ 使用情况互链）；每次 navigate 都换新对象，页面据此重设选中项。 */
  const [nav, setNav] = useState<NavTarget | undefined>(undefined)

  const navigate = (target: NavTarget) => {
    setPage(target.page)
    setNav(target)
  }

  let lastGroup: string | undefined
  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          Prism<span> · 棱镜</span>
        </div>
        <nav className="topnav">
          {NAV.map((item) => {
            const showGroup = item.group !== undefined && item.group !== lastGroup
            lastGroup = item.group
            return (
              <span key={item.key} className="topnav-cell">
                {showGroup && <span className="nav-group">{item.group}</span>}
                <button
                  className={`nav-item${page === item.key ? ' active' : ''}`}
                  onClick={() => {
                    setPage(item.key)
                    setNav(undefined)
                  }}
                >
                  {item.label}
                </button>
              </span>
            )
          })}
        </nav>
      </header>
      <main className="main">
        {page === 'knowledge' && <KnowledgePage />}
        {page === 'graph' && <CodeGraphPage />}
        {page === 'projects' && <ProjectsPage />}
        {page === 'roles' && (
          <RolesPage
            nav={nav?.page === 'roles' ? nav : undefined}
            onOpenSkills={() => navigate({ page: 'skills' })}
          />
        )}
        {page === 'teams' && (
          <TeamsPage
            nav={nav?.page === 'teams' ? nav : undefined}
            onOpenSkills={() => navigate({ page: 'skills' })}
          />
        )}
        {page === 'skills' && <SkillsPage onOpenEffective={(t) => navigate(t)} />}
        {page === 'tasks' && <TasksPage />}
      </main>
    </div>
  )
}
