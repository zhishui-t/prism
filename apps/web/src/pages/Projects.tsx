import { api, type GraphProject, type ScanRecord } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'
import { CopyCommand, PageHead, Pane, StatusTag } from '../components/ui.tsx'
import { useT } from '../i18n.ts'

/**
 * 项目台账页：登记过的项目 + 建图/扫描状态。
 *
 * 为什么单独一页：`prism project add` 登记的项目可能尚未建图，
 * 知识扫描（`prism kb sync`）与代码图谱（`prism graph build`）都依赖这份台账。
 * 界面只读展示 + 复制命令，**登记/移除仍在 CLI**（避免控制台误操作项目目录）。
 */
export function ProjectsPage() {
  const t = useT()
  const projects = useAsync(() => api.graphProjects(), [])

  /** 常用命令：与文档同一口径，一行一条，可一键复制。 */
  const commands: Array<{ cmd: string; comment: string }> = [
    { cmd: 'prism project add <项目根目录> --name <项目名>', comment: t('projects.commands.comment.add') },
    { cmd: 'prism graph build <项目根目录> --name <项目名>', comment: t('projects.commands.comment.build') },
    { cmd: 'prism kb sync <项目名> [--dry-run]', comment: t('projects.commands.comment.sync') },
    { cmd: 'prism project show <项目名>', comment: t('projects.commands.comment.show') },
    { cmd: 'prism project remove <项目名> --yes', comment: t('projects.commands.comment.remove') },
  ]

  return (
    <>
      <PageHead title={t('projects.title')} sub={t('projects.desc')} />

      <Pane
        head={
          <div className="pane-head">
            <h3>{t('projects.registered')}</h3>
            <span className="spacer">
              <button onClick={projects.reload}>{t('common.refresh')}</button>
            </span>
          </div>
        }
      >
        <State
          loading={projects.loading}
          error={projects.error}
          empty={!projects.loading && !projects.error && (projects.data?.length ?? 0) === 0}
          emptyText={t('projects.empty')}
        >
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>{t('projects.col.project')}</th>
                  <th>{t('projects.col.root')}</th>
                  <th style={{ width: 110 }}>{t('projects.col.graph')}</th>
                  <th style={{ width: 170 }}>{t('projects.col.scan')}</th>
                </tr>
              </thead>
              <tbody>
                {projects.data?.map((p) => (
                  <tr key={p.project}>
                    <td className="mono small">{p.project}</td>
                    <td className="mono small muted">{p.root}</td>
                    <td className="small">
                      <GraphBadge project={p} />
                    </td>
                    <td className="small muted">
                      {p.last_scan_at !== undefined ? (
                        <>
                          {fmt(p.last_scan_at)}
                          <span className="muted">
                            {' '}
                            · {t('projects.scan.sources', { n: p.scanned_sources ?? 0 })}
                          </span>
                        </>
                      ) : (
                        t('projects.scan.none')
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </State>
      </Pane>

      <ScanHistoryCard />

      <Pane title={t('projects.commands')}>
        <div style={{ display: 'grid', gap: 6 }}>
          {commands.map((item) => (
            <div key={item.cmd} className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
              <CopyCommand command={item.cmd} />
              <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
                {item.comment}
              </span>
            </div>
          ))}
        </div>
      </Pane>
    </>
  )
}

/**
 * 扫描历史：孤儿索引（源文件已删）与不可读目录的历史留痕。
 * 只读展示——`missing` 条目需要人来决定「重建索引还是清理条目」。
 */
function ScanHistoryCard() {
  const t = useT()
  const history = useAsync(() => api.kbScanHistory(undefined, 15), [])
  const list = history.data ?? []

  return (
    <Pane
      head={
        <div className="pane-head">
          <h3>{t('projects.scanHistory')}</h3>
          <span className="spacer">
            <button onClick={history.reload}>{t('common.refresh')}</button>
          </span>
        </div>
      }
    >
      <State
        loading={history.loading}
        error={history.error}
        empty={!history.loading && !history.error && list.length === 0}
        emptyText={t('projects.scanHistory.empty')}
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 150 }}>{t('projects.scanHistory.col.time')}</th>
                <th style={{ width: 120 }}>{t('projects.scanHistory.col.project')}</th>
                <th>{t('projects.scanHistory.col.result')}</th>
                <th style={{ width: 140 }}>{t('projects.scanHistory.col.flags')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={`${r.project}-${r.scanned_at}-${i}`}>
                  <td className="mono small muted">{fmt(r.scanned_at)}</td>
                  <td className="mono small">{r.project}</td>
                  <td className="small muted">
                    {t('projects.scanHistory.result', {
                      discovered: r.discovered,
                      created: r.created,
                      updated: r.updated,
                      unchanged: r.unchanged,
                    })}
                    {r.skipped > 0 ? t('projects.scanHistory.skipped', { n: r.skipped }) : ''}
                  </td>
                  <td className="small">
                    <ScanFlags record={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </State>
    </Pane>
  )
}

function ScanFlags({ record }: { record: ScanRecord }) {
  const t = useT()
  const flags: string[] = []
  if (record.missing.length > 0) flags.push(t('projects.scanHistory.orphan', { n: record.missing.length }))
  if (record.unreadable.length > 0) flags.push(t('projects.scanHistory.unreadable', { n: record.unreadable.length }))
  if (record.truncated) flags.push(t('projects.scanHistory.truncated'))
  if (flags.length === 0) return <span className="muted">—</span>
  return (
    <StatusTag kind="warn" title={record.missing.join(', ')}>
      {flags.join(' · ')}
    </StatusTag>
  )
}

function GraphBadge({ project }: { project: GraphProject }) {
  const t = useT()
  if (project.built_at === undefined || project.built_at === null) {
    return <StatusTag kind="info">{t('projects.graph.none')}</StatusTag>
  }
  if (project.stale === true) {
    return (
      <StatusTag kind="warn" title={`${t('projects.graph.built')} · ${fmt(project.built_at)}`}>
        {t('projects.graph.stale')}
      </StatusTag>
    )
  }
  return (
    <StatusTag kind="ok" title={`${t('projects.graph.built')} · ${fmt(project.built_at)}`}>
      {t('projects.graph.built')}
    </StatusTag>
  )
}

function fmt(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}
