import { api, type GraphProject } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

/**
 * 项目台账页：登记过的项目 + 建图/扫描状态。
 *
 * 为什么单独一页：`prism project add` 登记的项目可能尚未建图，
 * 知识扫描（`prism kb sync`）与代码图谱（`prism graph build`）都依赖这份台账。
 * 界面只读展示 + 复制命令，**登记/移除仍在 CLI**（避免控制台误操作项目目录）。
 */
export function ProjectsPage() {
  const projects = useAsync(() => api.graphProjects(), [])

  return (
    <>
      <h2 className="page-title">项目台账</h2>
      <p className="page-desc">
        登记过的项目（<span className="mono">prism project add &lt;路径&gt;</span>）。
        建图与知识扫描都以这份台账为准；Prism 只记录路径与时间，不读 git、不动项目文件。
      </p>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>已登记项目</h3>
          <button onClick={projects.reload}>刷新</button>
        </div>
        <State
          loading={projects.loading}
          error={projects.error}
          empty={!projects.loading && !projects.error && (projects.data?.length ?? 0) === 0}
          emptyText="还没有登记项目。在终端执行：prism project add <项目根目录>"
        >
          <table>
            <thead>
              <tr>
                <th style={{ width: 160 }}>项目</th>
                <th>根目录</th>
                <th style={{ width: 110 }}>代码图谱</th>
                <th style={{ width: 150 }}>知识扫描</th>
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
                        <span className="muted"> · {p.scanned_sources ?? 0} 源</span>
                      </>
                    ) : (
                      '未扫描'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      <div className="card">
        <h3>常用命令</h3>
        <pre className="mono small" style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, margin: 0, whiteSpace: 'pre-wrap' }}>
{`prism project add <项目根目录> --name <项目名>   # 登记
prism graph build <项目根目录> --name <项目名>    # 建代码图谱
prism kb sync <项目名> [--dry-run]                # 扫描项目文档建引用索引
prism project show <项目名>                       # 查看详情
prism project remove <项目名> --yes               # 从台账移除（不动项目文件）`}
        </pre>
      </div>
    </>
  )
}

function GraphBadge({ project }: { project: GraphProject }) {
  if (project.built_at === undefined || project.built_at === null) {
    return <span className="tag">未建图</span>
  }
  if (project.stale === true) {
    return (
      <span className="tag warn" title={`建图于 ${fmt(project.built_at)}`}>
        陈旧
      </span>
    )
  }
  return (
    <span className="tag" title={`建图于 ${fmt(project.built_at)}`} style={{ color: 'var(--ok, #35c46b)' }}>
      已建图
    </span>
  )
}

function fmt(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19)
}
