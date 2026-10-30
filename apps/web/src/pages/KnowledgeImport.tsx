/**
 * 知识导入弹窗（`POST /api/kb/import`，与 MCP `prism_kb_import` 同一实现）。
 *
 * 控制台的两步用法：**dry-run 预览 → 真导入**——先只报告不落库（发现/纳入/跳过分列），
 * 看清了再真跑。项目只从**已注册项目**里选（root 来自项目台账，不在界面里手填路径）。
 * 真导入完成后「刷新查看」重载页面（树的缓存多，整页刷新最诚实）。
 */

import { useEffect, useState } from 'react'

import { api } from '../api.ts'
import { Modal } from '../components/ui.tsx'
import { useT } from '../i18n.ts'

type ImportResult = Awaited<ReturnType<typeof api.kbImport>>

export function KnowledgeImportModal({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [projects, setProjects] = useState<Array<{ project: string; root: string }> | null>(null)
  const [project, setProject] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportResult | null>(null)

  useEffect(() => {
    let alive = true
    api
      .graphProjects()
      .then((list) => {
        if (!alive) return
        setProjects(list.map((p) => ({ project: p.project, root: p.root })))
        if (list.length > 0) setProject(list[0]!.project)
      })
      .catch(() => {
        if (alive) setProjects([])
      })
    return () => {
      alive = false
    }
  }, [])

  const run = async (dryRun: boolean): Promise<void> => {
    const hit = (projects ?? []).find((p) => p.project === project)
    if (hit === undefined) return
    setRunning(true)
    setError('')
    try {
      setResult(await api.kbImport({ path: hit.root, owner: hit.project, ...(dryRun ? { dry_run: true } : {}) }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  const included = result === null ? 0 : result.created + result.updated + result.unchanged

  return (
    <Modal size="md" title={t('knowledge.import.title')} onClose={onClose}>
      <p className="small muted">{t('knowledge.import.desc')}</p>
      {projects === null ? (
        <div className="small muted">{t('common.loading')}</div>
      ) : projects.length === 0 ? (
        <div className="small muted">{t('runtime.noProjects')}</div>
      ) : (
        <>
          <label className="field">
            <span>{t('runtime.project')}</span>
            <select value={project} onChange={(e) => setProject(e.target.value)} disabled={running}>
              {projects.map((p) => (
                <option key={p.project} value={p.project}>
                  {p.project}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="button" className="tool-btn" disabled={running} onClick={() => void run(true)}>
              {t('knowledge.import.preview')}
            </button>
            <button type="button" className="primary" disabled={running} onClick={() => void run(false)}>
              {t('knowledge.import.run')}
            </button>
          </div>
        </>
      )}

      {error !== '' && (
        <div className="banner">
          <span className="small">{error}</span>
        </div>
      )}

      {result !== null && (
        <div className="kb-import-result">
          <div className="runtime-summary">
            <span className="tag">{t('knowledge.import.r.discovered', { n: result.discovered })}</span>
            <span className="tag tag-done">{t('knowledge.import.r.included', { n: included })}</span>
            {result.created > 0 && <span className="tag tag-running">{t('knowledge.import.r.created', { n: result.created })}</span>}
            {result.updated > 0 && <span className="tag tag-running">{t('knowledge.import.r.updated', { n: result.updated })}</span>}
            {result.skipped > 0 && <span className="tag tag-blocked">{t('knowledge.import.r.skipped', { n: result.skipped })}</span>}
            {result.dry_run && <StatusDryTag />}
          </div>
          {Object.keys(result.by_skip_reason).length > 0 && (
            <dl className="kv">
              {Object.entries(result.by_skip_reason).map(([reason, n]) => (
                <div className="runtime-kv-row" key={reason}>
                  <dt className="mono small">{reason}</dt>
                  <dd className="small">{n}</dd>
                </div>
              ))}
            </dl>
          )}
          {result.ignored_dirs.length > 0 && (
            <div className="small muted">
              {t('knowledge.import.r.gitignore', { dirs: result.ignored_dirs.join(String.fromCharCode(65307)) })}
            </div>
          )}
          {result.missing.length > 0 && (
            <div className="small" style={{ color: 'var(--warn)' }}>
              {t('knowledge.import.r.missing', { n: result.missing.length })}
            </div>
          )}
          {!result.dry_run && (
            <button type="button" className="rel-link" onClick={() => window.location.reload()}>
              {t('knowledge.import.refresh')}
            </button>
          )}
        </div>
      )}
    </Modal>
  )
}

function StatusDryTag() {
  const t = useT()
  return <span className="tag">{t('knowledge.import.r.dry')}</span>
}
