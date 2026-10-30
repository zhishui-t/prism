/**
 * 团队运行时看板（只读）——把项目 `.agent-team/` 黑板读成「现在该派谁」。
 *
 * 定位（R1）：Prism **不调度、不派发**。调度是队长的事，真相在黑板文件里；本组件
 * 只做三件事：**显示**（任务四态 / 会话登记 / 门禁 / 断点快照）、**推导**（可派发集
 * 由服务端算好）、**对账**（缺口清单）。
 *
 * 为什么值得有：此前控制台对「调度 / 派发 / 监控」是**完全空白**——用户只能靠队长
 * 口述知道进度。这里给的是文件里的事实（含「谁登记了、谁没登记」这类会直接导致
 * 重复派遣的缺口），不是估算。
 *
 * 口径：
 * - 项目必须显式选（项目注册表里的项目；不猜路径）；
 * - 没有黑板 ≠ 错误（团队可以刚建、还没开工），给一句人话说明 + 下一步；
 * - 缺口分级：error（数据坏了，会算错）> warning（能跑但会误导）> info（提示）。
 */

import { Fragment, useEffect, useState } from 'react'

import { teamApi, type RuntimeGapView, type RuntimeTaskView, type TeamRuntimeView } from '../../../api-team.ts'
import { CountLine } from '../../../components/CountLine.tsx'
import { Pane, StatusTag } from '../../../components/ui.tsx'
import { useT } from '../../../i18n.ts'
import type { DictKey } from '../../../i18n.ts'

const STATUS_LABEL: Record<RuntimeTaskView['status'], DictKey> = {
  done: 'runtime.status.done',
  running: 'runtime.status.running',
  pending: 'runtime.status.pending',
  blocked: 'runtime.status.blocked',
}

const STATUS_KIND: Record<RuntimeTaskView['status'], 'ok' | 'info' | 'warn' | 'err'> = {
  done: 'ok',
  running: 'info',
  pending: 'info',
  blocked: 'err',
}

/** 产物分类的展示顺序（state → 流程产物 → 门禁 → 交付 → 杂项）。 */
const KIND_ORDER = ['state', 'brief', 'manifest', 'design', 'spec', 'tasks', 'review', 'test', 'gate', 'delivery', 'other'] as const

/** 分类 → 词条（静态映射，禁动态拼 key）。 */
const KIND_LABEL: Record<(typeof KIND_ORDER)[number], DictKey> = {
  state: 'runtime.kind.state',
  brief: 'runtime.kind.brief',
  manifest: 'runtime.kind.manifest',
  design: 'runtime.kind.design',
  spec: 'runtime.kind.spec',
  tasks: 'runtime.kind.tasks',
  review: 'runtime.kind.review',
  test: 'runtime.kind.test',
  gate: 'runtime.kind.gate',
  delivery: 'runtime.kind.delivery',
  other: 'runtime.kind.other',
}

const GAP_KIND: Record<RuntimeGapView['level'], 'err' | 'warn' | 'info'> = {
  error: 'err',
  warning: 'warn',
  info: 'info',
}

export function TeamRuntimePane({ teamId, projects }: { teamId: string; projects: string[] }) {
  const t = useT()
  /** 选中的项目。 */
  const [project, setProject] = useState('')
  const [data, setData] = useState<TeamRuntimeView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openGaps, setOpenGaps] = useState(false)
  /** 任务下钻（点行展开契约与证据明细）。 */
  const [openTask, setOpenTask] = useState<string | null>(null)

  /**
   * 首次自动选项目：依次探测已注册项目，选**第一个有黑板的**——否则默认落在空项目
   * （实测注册项里 mini-snake 无黑板、prism 有），用户看到「还没开工」，尽管另一个项目有活。
   * 探测数 = 注册项目数（通常个位数）。用户手动选过（autoPicked）就不再自动改。
   */
  /** 选中的任务目录（null = 自动；'__root__' = 旧版平铺；其余 = .agent-team/<run>/）。 */
  const [runSel, setRunSel] = useState<string | null>(null)
  const [autoPicked, setAutoPicked] = useState(false)
  useEffect(() => {
    if (autoPicked || project !== '' || projects.length === 0) return
    let alive = true
    void (async () => {
      for (const p of projects) {
        try {
          const rt = await teamApi.runtime(teamId, p)
          if (!alive) return
          if (rt.hasBlackboard) {
            setProject(p)
            setAutoPicked(true)
            return
          }
        } catch {
          /* 探测失败不阻断：换下一个项目 */
        }
      }
      if (alive) {
        setProject(projects[0]!)
        setAutoPicked(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [autoPicked, project, projects, teamId])

  useEffect(() => {
    if (project === '') return
    let alive = true
    setLoading(true)
    setError('')
    teamApi
      .runtime(teamId, project, runSel === null ? undefined : runSel === '__root__' ? '' : runSel)
      .then((value) => {
        if (alive) setData(value)
      })
      .catch((e: unknown) => {
        if (alive) {
          setData(null)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [teamId, project, runSel])

  const gaps: RuntimeGapView[] = data?.gaps ?? []
  const artifactList: Array<{ name: string; kind: string; mtime: number; dir: boolean }> = data?.artifacts ?? []
  const snapshot: Array<{ key: string; value: string }> = data?.snapshot ?? []
  const gateList: Array<{ name: string; present: boolean }> = data?.gates ?? []
  const errs = gaps.filter((g) => g.level === 'error').length
  const warns = gaps.filter((g) => g.level === 'warning').length

  return (
    <Pane
      head={
        <div className="pane-head">
          <CountLine
            size="section"
            bare
            label={t('runtime.title')}
            count={data?.tasks.length ?? 0}
            lamp={errs + warns > 0}
            title={t('runtime.hint')}
          />
          <span className="flex-1" />
          {projects.length > 0 && (
            <label className="runtime-project">
              <span className="small muted">{t('runtime.project')}</span>
              <select
                value={project}
                onChange={(e) => {
                  setAutoPicked(true)
                  setProject(e.target.value)
                }}
              >
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          )}
          {/* 同项目多团队并行：黑板按任务分目录（.agent-team/<run>/），这里切换看哪支 */}
          {data !== null && data.runs.length > 1 && (
            <label className="runtime-project">
              <span className="small muted">{t('runtime.run')}</span>
              <select
                value={runSel ?? (data.run === '' ? '__root__' : data.run)}
                onChange={(e) => setRunSel(e.target.value)}
              >
                {data.runs.map((r) => (
                  <option key={r.id === '' ? '__root__' : r.id} value={r.id === '' ? '__root__' : r.id}>
                    {r.legacy ? t('runtime.runRoot') : r.title !== '' ? `${r.id} · ${r.title}` : r.id}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      }
    >
      <div className="runtime-pane">
      {projects.length === 0 ? (
        <div className="small muted">{t('runtime.noProjects')}</div>
      ) : loading ? (
        <div className="small muted">{t('common.loading')}</div>
      ) : error !== '' ? (
        <div className="banner lamp">
          <StatusTag kind="err">{t('status.failed')}</StatusTag>
          <span className="small">{error}</span>
        </div>
      ) : data === null ? null : !data.hasBlackboard ? (
        <div className="runtime-empty">
          <div className="small">{t('runtime.noBlackboard', { project })}</div>
          <div className="small muted mono">{data.root}</div>
        </div>
      ) : (
        <div className="runtime-board">
          {/* 一行结论：四态计数 + 可派发/受阻数 */}
          <div className="runtime-summary">
            <span className="tag tag-done">{t('runtime.count.done', { n: data.counts.done })}</span>
            <span className="tag tag-running">{t('runtime.count.running', { n: data.counts.running })}</span>
            <span className="tag">{t('runtime.count.pending', { n: data.counts.pending })}</span>
            {data.counts.blocked > 0 && (
              <span className="tag tag-blocked">{t('runtime.count.blocked', { n: data.counts.blocked })}</span>
            )}
            <span className="scope-leader" />
            <StatusTag kind={data.ready.length > 0 ? 'ok' : 'info'}>
              {t('runtime.readyCount', { n: data.ready.length })}
            </StatusTag>
            {data.waiting.length > 0 && (
              <StatusTag kind="info">{t('runtime.waitingCount', { n: data.waiting.length })}</StatusTag>
            )}
            {data.dagTitle !== '' && <span className="small muted runtime-goal">{data.dagTitle}</span>}
          </div>

          {/* 交付门禁：机械判定（全部完成 + 审核 pass + 无失败）——不看叙述看证据 */}
          <div className={`runtime-gate-bar${data.deliveryGate.ok ? ' ok' : ''}`}>
            <StatusTag kind={data.deliveryGate.ok ? 'ok' : 'warn'}>
              {data.deliveryGate.ok ? t('runtime.gate.pass') : t('runtime.gate.blocked')}
            </StatusTag>
            {data.deliveryGate.ok ? (
              <span className="small">{t('runtime.gate.passHint')}</span>
            ) : (
              <span className="small">
                {data.deliveryGate.blockers.map((b) => b.message).join(String.fromCharCode(65307)) ||
                  t('runtime.gate.noTasks')}
              </span>
            )}
          </div>

          {/* 任务表：可派发行高亮（这就是「现在该派谁」） */}
          <table className="runtime-table">
            <thead>
              <tr>
                <th style={{ width: 72 }}>{t('runtime.col.status')}</th>
                <th>{t('runtime.col.task')}</th>
                <th style={{ width: 120 }}>{t('runtime.col.role')}</th>
                <th style={{ width: 110 }}>{t('runtime.col.kind')}</th>
                <th style={{ width: 96 }}>{t('runtime.col.dispatchState')}</th>
              </tr>
            </thead>
            <tbody>
              {data.tasks.map((task) => {
                const reg = data.dispatch.find((d) => d.taskIds.includes(task.id))
                const open = openTask === task.id
                return (
                  <Fragment key={task.id}>
                  <tr
                    className={task.ready ? 'is-ready' : undefined}
                    onClick={() => setOpenTask(open ? null : task.id)}
                    aria-expanded={open}
                  >
                    <td>
                      <StatusTag kind={task.ready ? 'ok' : STATUS_KIND[task.status]}>
                        {task.ready ? t('runtime.status.ready') : t(STATUS_LABEL[task.status])}
                      </StatusTag>
                    </td>
                    <td className="small">
                      {task.label}
                      {task.deps.length > 0 && (
                        <span className="small muted runtime-deps">
                          {' '}
                          {t('runtime.deps', { deps: task.deps.join(', ') })}
                        </span>
                      )}
                    </td>
                    <td className="mono small">{task.role === '' ? t('common.unset') : task.role}</td>
                    <td className="small">
                      {task.contract.kind === 'work' ? (
                        <span className="muted">{t('runtime.kind.work')}</span>
                      ) : (
                        <span
                          className="tag small"
                          title={[
                            task.contract.objective !== '' ? `${t('runtime.contract.objective')}: ${task.contract.objective}` : '',
                            task.contract.acceptance.length > 0
                              ? `${t('runtime.contract.acceptance')}: ${task.contract.acceptance.join(' / ')}`
                              : '',
                            task.contract.inScope.length > 0
                              ? `${t('runtime.contract.scope')}: ${task.contract.inScope.join(', ')}`
                              : '',
                            task.contract.verify.length > 0
                              ? `${t('runtime.contract.verify')}: ${task.contract.verify.join(' / ')}`
                              : '',
                            task.contract.verdict !== '' ? `${t('runtime.contract.verdict')}: ${task.contract.verdict}` : '',
                            task.contract.changedPaths.length > 0
                              ? `${t('runtime.contract.changed')}: ${task.contract.changedPaths.length}`
                              : '',
                          ]
                            .filter((x) => x !== '')
                            .join(String.fromCharCode(10))}
                        >
                          {task.contract.kind}
                          {task.contract.verdict !== '' ? ` · ${task.contract.verdict}` : ''}
                        </span>
                      )}
                    </td>
                    <td className="small">
                      {reg === undefined ? (
                        <span className="muted">{t('runtime.noRegistration')}</span>
                      ) : (
                        <span className="mono small" title={reg.state}>
                          {reg.agentId ?? reg.sessionId ?? '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="runtime-task-detail">
                      <td colSpan={5}>
                        <dl className="kv">
                          <div className="runtime-kv-row"><dt>{t('runtime.contract.objective')}</dt><dd className="small">{task.contract.objective !== '' ? task.contract.objective : t('common.unset')}</dd></div>
                          {task.contract.acceptance.length > 0 && (
                            <div className="runtime-kv-row"><dt>{t('runtime.contract.acceptance')}</dt><dd className="small">
                              {task.contract.acceptance.map((a) => {
                                const hit = task.contract.acceptanceResults.find((r) => r.acceptance === a)
                                return (
                                  <div key={a}>
                                    <StatusTag kind={hit === undefined ? 'info' : hit.status === 'pass' ? 'ok' : 'err'}>
                                      {hit === undefined ? '—' : hit.status}
                                    </StatusTag>{' '}
                                    {a}
                                    {hit?.evidence !== undefined && hit.evidence !== '' && <span className="small muted"> {'·'} {hit.evidence}</span>}
                                  </div>
                                )
                              })}
                            </dd></div>
                          )}
                          {task.contract.verify.length > 0 && (
                            <div className="runtime-kv-row"><dt>{t('runtime.contract.verify')}</dt><dd className="small mono">
                              {task.contract.verify.map((v) => {
                                const hit = task.contract.commandsRun.find((r) => r.command === v)
                                return (
                                  <div key={v}>
                                    <StatusTag kind={hit === undefined ? 'info' : hit.status === 'pass' ? 'ok' : 'err'}>
                                      {hit === undefined ? '—' : hit.status}
                                    </StatusTag>{' '}{v}
                                  </div>
                                )
                              })}
                            </dd></div>
                          )}
                          {task.contract.changedPaths.length > 0 && (
                            <div className="runtime-kv-row"><dt>{t('runtime.contract.changed')}</dt><dd className="small mono">{task.contract.changedPaths.join(String.fromCharCode(65307))}</dd></div>
                          )}
                          {task.contract.findings.length > 0 && (
                            <div className="runtime-kv-row"><dt>findings</dt><dd className="small">
                              {task.contract.findings.map((f, i) => <div key={i}>[{f.severity}] {f.text}</div>)}
                            </dd></div>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>

          {/* 缺口：默认折叠一行摘要（有 error 时自动展开一次） */}
          {gaps.length > 0 && (
            <div className="runtime-gaps">
              <button type="button" className="rel-link" onClick={() => setOpenGaps((v) => !v)}>
                {t('runtime.gaps', { errs, warns, total: gaps.length })}
                {openGaps ? ' ▾' : ' ▸'}
              </button>
              {openGaps && (
                <ul className="runtime-gap-list">
                  {gaps.map((g, i) => (
                    <li key={i} className={`runtime-gap lv-${g.level}`}>
                      <StatusTag kind={GAP_KIND[g.level]}>{g.level}</StatusTag>
                      <span className="small">{g.message}</span>
                      {g.where !== undefined && <span className="small muted mono">{g.where}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* 深挖：断点快照 / 门禁 / 黑板文件 */}
          <details className="runtime-deep">
            <summary>{t('runtime.deepDive')}</summary>
            {snapshot.length > 0 && (
              <dl className="kv">
                {snapshot.map((row) => (
                  <div key={row.key} className="runtime-kv-row">
                    <dt>{row.key}</dt>
                    <dd className="small">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            <div className="runtime-gates">
              <span className="small muted">{t('runtime.gates')}</span>
              {gateList.length === 0 ? (
                <span className="small muted">{t('runtime.gatesNone')}</span>
              ) : (
                gateList.map((g) => (
                  <span key={g.name} className="tag mono small">
                    {g.name}
                  </span>
                ))
              )}
            </div>
            {/* 产物清单：run 目录全量盘点，按类别分组（dev-team.md §4 的可见面） */}
            <div className="runtime-artifacts">
              <span className="small muted">{t('runtime.artifacts', { n: artifactList.length })}</span>
              {KIND_ORDER.filter((k) => artifactList.some((a) => a.kind === k)).map((k) => (
                <div key={k} className="runtime-artifact-group">
                  <span className="tag">{t(KIND_LABEL[k])}</span>
                  <span className="runtime-artifact-files">
                    {artifactList.filter((a) => a.kind === k).map((a) => (
                      <span key={a.name} className="mono small runtime-artifact-file" title={new Date(a.mtime).toLocaleString()}>
                        {a.name}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
      </div>
    </Pane>
  )
}
