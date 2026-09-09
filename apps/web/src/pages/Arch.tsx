import { useEffect, useState } from 'react'

import { api, type ArchDiagram } from '../api.ts'
import { State } from '../components/State.tsx'
import { useAsync } from '../components/useAsync.ts'

const TYPE_HINT: Record<string, string> = {
  architecture: '模块聚类 + 依赖边 → 组件/边界/连接',
  sequence: 'CALLS 边 + Graphify flows → 参与者/消息',
  lifecycle: '状态机（如 14 态任务机）→ 泳道/状态/转移',
  dataflow: '数据读写边 → 阶段/节点/流转',
  workflow: '团队 DAG 工作流 → 泳道/节点/边',
}

/**
 * 架构图谱页（knowledge-base.md §4.4 / D11）：
 * 五类图由 Archify（vendored 子工程 3rd/archify，MIT v2.16.0）从 JSON-IR 渲染为自包含 HTML。
 * Prism 只做编排与预览（iframe），不重写渲染器。
 */
export function ArchPage() {
  const types = useAsync(() => api.archTypes(), [])
  const diagrams = useAsync(() => api.archDiagrams(), [])
  const [selected, setSelected] = useState<ArchDiagram | undefined>(undefined)

  // 首次加载后自动选中最新产物
  useEffect(() => {
    if (selected === undefined && diagrams.data !== undefined && diagrams.data.length > 0) {
      setSelected(diagrams.data[0])
    }
  }, [diagrams.data, selected])

  const previewUrl = selected
    ? `/api/arch/preview/${selected.type}/${encodeURIComponent(selected.name)}`
    : ''

  return (
    <>
      <h2 className="page-title">架构图谱</h2>
      <p className="page-desc">
        五类图由 <strong>Archify</strong>（vendored 子工程，MIT）从 JSON-IR 渲染为自包含 HTML——
        Prism 只做编排与预览，不重写渲染器。IR 是源、HTML 是派生。
      </p>

      <div className="card">
        <h3>支持的五类图</h3>
        <State loading={types.loading} error={types.error}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 140 }}>类型</th>
                <th style={{ width: 100 }}>名称</th>
                <th>数据来源</th>
              </tr>
            </thead>
            <tbody>
              {types.data?.map((t) => (
                <tr key={t.type}>
                  <td className="mono small">{t.type}</td>
                  <td>{t.label}</td>
                  <td className="small muted">{TYPE_HINT[t.type] ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>已渲染产物</h3>
          <button onClick={diagrams.reload}>刷新</button>
        </div>
        <State
          loading={diagrams.loading}
          error={diagrams.error}
          empty={!diagrams.loading && !diagrams.error && (diagrams.data?.length ?? 0) === 0}
          emptyText="还没有渲染产物。用 `prism arch render <type> <ir.json>` 生成，或经 POST /api/arch/render 提交 IR。"
        >
          <table>
            <thead>
              <tr>
                <th style={{ width: 140 }}>类型</th>
                <th>文件</th>
                <th style={{ width: 110 }}>大小</th>
                <th style={{ width: 180 }}>渲染时间</th>
              </tr>
            </thead>
            <tbody>
              {diagrams.data?.map((d) => (
                <tr
                  key={`${d.type}/${d.name}`}
                  style={{ cursor: 'pointer', background: selected === d ? 'var(--panel-2)' : undefined }}
                  onClick={() => setSelected(d)}
                >
                  <td className="mono small">{d.type}</td>
                  <td className="mono small">{d.name}</td>
                  <td className="small muted">{Math.round(d.bytes / 1024)} KB</td>
                  <td className="small muted">{d.mtime.replace('T', ' ').slice(0, 19)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </State>
      </div>

      {selected && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>
              预览 <span className="mono small muted">{selected.name}</span>
            </h3>
            <a href={previewUrl} target="_blank" rel="noreferrer" className="small">
              新窗口打开
            </a>
          </div>
          <iframe
            title={`架构图预览 ${selected.name}`}
            src={previewUrl}
            style={{
              width: '100%',
              height: 620,
              border: '1px solid var(--border)',
              borderRadius: 8,
              marginTop: 10,
              background: '#fff',
            }}
          />
        </div>
      )}

      <div className="card">
        <h3>使用方式</h3>
        <pre
          className="mono small"
          style={{ background: 'var(--panel-2)', padding: 12, borderRadius: 8, margin: 0, whiteSpace: 'pre-wrap' }}
        >
{`# CLI
prism arch types                              # 列出五类图
prism arch validate <type> <ir.json>          # 校验 IR（schema + 布局）
prism arch render <type> <ir.json> [--out f]  # 渲染为自包含 HTML

# HTTP
GET  /api/arch/types
GET  /api/arch/diagrams
POST /api/arch/validate   { type, ir }
POST /api/arch/render     { type, ir, name? }
GET  /api/arch/preview/:type/:file

# 产物落 <PRISM_HOME>/archify/<type>/{<name>.html, <name>.ir.json}
# IR 是源、HTML 是派生，两者都可作为 type: diagram 知识条目沉淀`}
        </pre>
      </div>
    </>
  )
}
