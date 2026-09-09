import { useState } from 'react'

import { KnowledgePage } from './pages/Knowledge.tsx'
import { CodeGraphPage } from './pages/CodeGraph.tsx'
import { TasksPage } from './pages/Tasks.tsx'
import { WorkQueuePage } from './pages/WorkQueue.tsx'
import { RolesPage } from './pages/Roles.tsx'
import { TeamsPage } from './pages/Teams.tsx'
import { SkillsPage } from './pages/Skills.tsx'

export type PageKey = 'knowledge' | 'kbgraph' | 'graph' | 'arch' | 'roles' | 'teams' | 'skills' | 'tasks' | 'work'

const NAV: Array<{ key: PageKey; label: string; group?: string }> = [
  // 知识图谱/架构图谱已归入「知识库 → 书内」（用户裁决：它们属于具体的书，不是一级页）
  { key: 'knowledge', label: '知识库' },
  { key: 'graph', label: '代码图谱' },
  { key: 'roles', label: '角色', group: '团队' },
  { key: 'teams', label: '团队', group: '团队' },
  { key: 'skills', label: '技能', group: '团队' },
  { key: 'tasks', label: '任务中心' },
  { key: 'work', label: '工作队列' },
]

export function Shell() {
  const [page, setPage] = useState<PageKey>('knowledge')

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
                  onClick={() => setPage(item.key)}
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
        {page === 'roles' && <RolesPage />}
        {page === 'teams' && <TeamsPage />}
        {page === 'skills' && <SkillsPage />}
        {page === 'tasks' && <TasksPage />}
        {page === 'work' && <WorkQueuePage />}
      </main>
    </div>
  )
}
