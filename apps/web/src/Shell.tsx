import { useEffect, useState } from 'react'

import { api } from './api.ts'
import { KnowledgePage } from './pages/Knowledge.tsx'
import { ProjectsPage } from './pages/Projects.tsx'
import { CodeGraphPage } from './pages/CodeGraph.tsx'
import { RolesPage } from './pages/Roles.tsx'
import { TeamsPage } from './pages/teams/TeamsPage.tsx'
import { SkillsPage } from './pages/Skills.tsx'
import { useT } from './i18n.ts'
import { navigate, queryOf, useRoute, withQuery } from './route.ts'
import { toggleTheme, useTheme } from './theme.ts'
import { toggleLang } from './i18n.ts'
import type { DictKey } from './i18n.ts'
import type { PageKey } from './nav.ts'

export type { PageKey }

const NAV: Array<{ key: PageKey; label: DictKey; group?: DictKey }> = [
  { key: 'knowledge', label: 'nav.knowledge' },
  { key: 'graph', label: 'nav.graph' },
  { key: 'projects', label: 'nav.projects' },
  { key: 'roles', label: 'nav.roles', group: 'nav.group.org' },
  { key: 'teams', label: 'nav.teams' },
  { key: 'skills', label: 'nav.skills' },
]

/**
 * 控制台外壳：顶栏（品牌 · 导航 · 主题/语言）+ 页面。
 *
 * 导航状态全部来自 hash（`route.ts`）——刷新、分享链接、前进后退都保留位置；
 * 支持深链的页面（knowledge / roles / teams / skills / graph）通过 `sel` 收「该展开哪个实体」，
 * 通过 `onSelect` 回写 hash（projects 无实体深链——它的「项目」就是 graph 页的 sel）。
 *
 * 原有一条「知识图谱/架构图谱没有一级页」的注释已删除：它与 NAV 自相矛盾
 * （graph 一直是一级页），留着会诱导下一轮重复决策一次。
 */
/**
 * 顶栏连接状态（brief-A §6.3 `health` 裁决：**接上且克制**）。
 *
 * 挂载与每次路由变化后**静默**探一次 `/api/health`：健康时**不渲染任何东西**
 * （不引入环境装饰），失败时只出一条 `mute` 文字 +「重试」。不轮询、不弹错、不阻塞页面——
 * 服务没起时页面自身的空态/错误态仍照常表达，这里只回答「有没有连上」。
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

  if (!down) return null
  return (
    <span className="conn-status">
      <span className="muted">{t('common.offline')}</span>
      <button className="tool-btn" onClick={() => setTick((n) => n + 1)}>
        {t('common.retry')}
      </button>
    </span>
  )
}

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
          <ConnStatus />
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
      {/*
        页面区**自己滚**（§2.7 锚点 9）：`.main` 只在栅格里分配视口高度（`overflow: hidden`），
        `.page` 才承担内边距 + 内滚。于是「满屏」布局（graph 页 / 书架 / 主从列表）都能用
        `100%` 直接表达，不再需要 `calc(100vh - 顶栏 - 内边距)` 这种需要人工同步的减法。
      */}
      <main className="main">
        <div className="page">
          {route.page === 'knowledge' && (
            <KnowledgePage
              sel={route.sel}
              query={route.query}
              onQuery={(patch) => navigate(withQuery(route, patch))}
              onSelect={(id) => {
                // 选中条目沿用 WITH_SEL 形态，但**保留 query**——否则点条目会把层/书过滤冲掉
                const next = id === undefined || id === '' ? { page: 'knowledge' as const } : { page: 'knowledge' as const, sel: id }
                const kept = queryOf(route)
                navigate(Object.keys(kept).length === 0 ? next : { ...next, query: kept })
              }}
            />
          )}
          {/* graph 也吃 `sel`（= 项目名），未命中由页内回落 + replace 修正 hash */}
          {route.page === 'graph' && <CodeGraphPage sel={route.sel} />}
          {route.page === 'projects' && <ProjectsPage />}
          {/* v7 §3.3：Shell 不认识实体——roles 的选中/关闭由页内 Ref/卡片直接改 hash */}
          {route.page === 'roles' && <RolesPage sel={route.sel} />}
          {route.page === 'teams' && (
            <TeamsPage
              sel={route.sel}
              onSelect={(id) => navigate({ page: 'teams', sel: id })}
              onOpenUsageSkills={() => navigate({ page: 'skills' })}
            />
          )}
          {/* v7 §3.3：Shell 不认识实体——skills 的选中/互链由页内 Ref/行链接直接改 hash */}
          {route.page === 'skills' && <SkillsPage sel={route.sel} />}
        </div>
      </main>
    </div>
  )
}
