import { useState } from 'react'

import { KnowledgePage } from './pages/Knowledge.tsx'
import { KnowledgeGraphPage } from './pages/KnowledgeGraph.tsx'
import { CodeGraphPage } from './pages/CodeGraph.tsx'
import { ArchPage } from './pages/Arch.tsx'
import { TasksPage } from './pages/Tasks.tsx'
import { WorkQueuePage } from './pages/WorkQueue.tsx'
import { RolesPage } from './pages/Roles.tsx'
import { TeamsPage } from './pages/Teams.tsx'
import { SkillsPage } from './pages/Skills.tsx'

export type PageKey = 'knowledge' | 'kbgraph' | 'graph' | 'arch' | 'roles' | 'teams' | 'skills' | 'tasks' | 'work'

const NAV: Array<{ key: PageKey; label: string; group?: string }> = [
  { key: 'knowledge', label: '知识库' },
  { key: 'kbgraph', label: '知识图谱' },
  { key: 'graph', label: '代码图谱' },
  { key: 'arch', label: '架构图谱' },
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
      <aside className="sidebar">
        <div className="brand">
          Prism<span> · 棱镜</span>
        </div>
        {NAV.map((item) => {
          const showGroup = item.group !== undefined && item.group !== lastGroup
          lastGroup = item.group
          return (
            <div key={item.key}>
              {showGroup && <div className="nav-group">{item.group}</div>}
              <button
                className={`nav-item${page === item.key ? ' active' : ''}`}
                onClick={() => setPage(item.key)}
              >
                {item.label}
              </button>
            </div>
          )
        })}
      </aside>
      <main className="main">
        {page === 'knowledge' && <KnowledgePage />}
        {page === 'kbgraph' && <KnowledgeGraphPage />}
        {page === 'graph' && <CodeGraphPage />}
        {page === 'arch' && <ArchPage />}
        {page === 'roles' && <RolesPage />}
        {page === 'teams' && <TeamsPage />}
        {page === 'skills' && <SkillsPage />}
        {page === 'tasks' && <TasksPage />}
        {page === 'work' && <WorkQueuePage />}
      </main>
    </div>
  )
}
