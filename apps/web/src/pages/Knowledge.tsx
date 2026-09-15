import { useEffect, useMemo, useRef, useState } from 'react'

import { api, type CatalogEntry, type EntryVersion, type SearchResult } from '../api.ts'
import { useAsync } from '../components/useAsync.ts'
import { useT } from '../i18n.ts'

/**
 * 知识库（书架式布局，2026-09-15 重设计）：
 * 左侧目录树（书→模块→条目）+ 服务端搜索结果，右侧内容面板。
 *
 * 用户裁决：「按照一本本书设计 点开左侧是目录章节 右侧是内容」。
 * 数据模型不变（catalog API），只是展示方式从星图改为书籍目录。
 */

const TYPE_COLOR: Record<string, string> = {
  rule: '#ff6b6b',
  doc: '#5b8cff',
  guide: '#35c46b',
  pitfall: '#e0c23a',
  pattern: '#a06bff',
  diagram: '#3ac0c4',
  summary: '#e06ba0',
  other: '#8b93a7',
}

/** 无 module 的条目在侧栏分组用的哨兵；展示时经 i18n 映射为「未归类」。 */
const INBOX = '_inbox'

interface TocEntry {
  entry: CatalogEntry
}

interface TocModule {
  name: string
  entries: TocEntry[]
}

interface TocBook {
  book: string
  layer: string
  owner?: string
  modules: TocModule[]
  total: number
}

/** 右侧面板展示所需的条目摘要（目录条目与搜索结果同形，取公共字段）。 */
interface EntryMeta {
  id: string
  title: string
  type: string
  layer: string
  owner?: string
  book: string
  module: string
  version: number
}

function bookKey(book: { layer: string; owner?: string; book: string }): string {
  return `${book.layer}/${book.owner ?? ''}/${book.book}`
}

export function KnowledgePage({ sel, onSelect }: { sel?: string; onSelect?: (id?: string) => void }) {
  const t = useT()
  const catalog = useAsync(() => api.kbCatalog({ limit: 5000 }), [])
  const stats = useAsync(() => api.kbStats(), [])
  const [selectedId, setSelectedId] = useState<string>(sel ?? '')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [initedBooks, setInitedBooks] = useState(false)
  const [viewVersion, setViewVersion] = useState<number | undefined>(undefined)
  const [showVersions, setShowVersions] = useState(false)
  const [busyRemove, setBusyRemove] = useState(false)
  const [notice, setNotice] = useState('')
  /** 软删后一次性守卫：sel 尚未清空的这一帧别再按旧 sel 选回已删条目（会冲掉提示）。 */
  const justRemovedRef = useRef(false)

  // 搜索框防抖 300ms → 触发服务端全文检索（正文也能搜到，非仅 title/id/tags）
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  const searchRun = useAsync(
    () => (query !== '' ? api.kbSearch({ q: query, limit: 50 }) : Promise.resolve<SearchResult[]>([])),
    [query],
  )

  const books = useMemo(() => {
    const list = catalog.data ?? []
    const map = new Map<string, TocBook>()
    for (const e of list) {
      const key = bookKey(e)
      if (!map.has(key)) {
        map.set(key, {
          book: e.book,
          layer: e.layer,
          owner: e.owner,
          modules: [],
          total: 0,
        })
      }
      const bk = map.get(key)!
      bk.total++
      const modName = e.module || INBOX
      let mod = bk.modules.find((m) => m.name === modName)
      if (!mod) {
        mod = { name: modName, entries: [] }
        bk.modules.push(mod)
      }
      mod.entries.push({ entry: e })
    }
    // 排序
    for (const bk of map.values()) {
      bk.modules.sort((a, b) => a.name.localeCompare(b.name))
    }
    return [...map.values()].sort((a, b) => a.book.localeCompare(b.book))
  }, [catalog.data])

  // 默认只展开第一本书（空集=全折叠）——避免首渲染把所有书全展开
  useEffect(() => {
    if (initedBooks || books.length === 0) return
    setExpanded(new Set([bookKey(books[0]!)]))
    setInitedBooks(true)
  }, [books, initedBooks])

  // 过滤搜索（本地：title/id/tags；正文命中由上面的服务端检索补足）
  const filtered = useMemo(() => {
    if (search.trim() === '') return books
    const q = search.trim().toLowerCase()
    const result: TocBook[] = []
    for (const bk of books) {
      const mods = bk.modules
        .map((m) => ({
          ...m,
          entries: m.entries.filter(
            (e) =>
              e.entry.title.toLowerCase().includes(q) ||
              e.entry.id.toLowerCase().includes(q) ||
              e.entry.tags.some((tag) => tag.toLowerCase().includes(q)),
          ),
        }))
        .filter((m) => m.entries.length > 0)
      if (mods.length > 0) {
        result.push({ ...bk, modules: mods, total: mods.reduce((n, m) => n + m.entries.length, 0) })
      }
    }
    return result
  }, [books, search])

  // 搜索时展开命中书目
  useEffect(() => {
    if (search.trim() !== '') {
      setExpanded(new Set(filtered.map(bookKey)))
    }
  }, [search, filtered])

  // 深链：sel 变化时选中对应条目并展开所在书（catalog 尚未加载时，books 变化后本 effect 会重跑）
  useEffect(() => {
    if (sel === undefined || sel === '') {
      justRemovedRef.current = false
      return
    }
    // 软删后我们主动清 hash，但 books 的 reload 可能先于 sel 清空到达这一帧——
    // 此时若按旧 sel 把已删条目选回来，会连带清掉「已软删」提示。一次性守卫跳过。
    if (justRemovedRef.current) return
    setSelectedId(sel)
    setNotice('')
    for (const bk of books) {
      for (const mod of bk.modules) {
        if (mod.entries.some((e) => e.entry.id === sel)) {
          setExpanded((prev) => new Set(prev).add(bookKey(bk)))
          return
        }
      }
    }
  }, [sel, books])

  const selectedMeta = useMemo<EntryMeta | null>(() => {
    if (selectedId === '') return null
    for (const bk of books) {
      for (const mod of bk.modules) {
        for (const e of mod.entries) {
          if (e.entry.id === selectedId) return e.entry
        }
      }
    }
    const hit = (searchRun.data ?? []).find((r) => r.id === selectedId)
    return hit ?? null
  }, [books, selectedId, searchRun.data])

  const selectedContent = useAsync(
    () => (selectedId !== '' ? api.kbGet(selectedId, viewVersion) : Promise.resolve(null)),
    [selectedId, viewVersion],
  )

  const versions = useAsync(
    () => (showVersions && selectedId !== '' ? api.kbVersions(selectedId) : Promise.resolve<EntryVersion[]>([])),
    [showVersions, selectedId],
  )

  // 条目正文兜底：深链到超出目录上限的条目时，目录/搜索结果都查不到，用取回的正文明示摘要
  const meta = useMemo<EntryMeta | null>(() => {
    if (selectedMeta !== null) return selectedMeta
    const entry = selectedContent.data
    if (entry === null || entry === undefined) return null
    return {
      id: entry.id,
      title: entry.title,
      type: entry.type,
      layer: entry.layer,
      owner: entry.owner,
      book: entry.book,
      module: entry.module,
      version: entry.version,
    }
  }, [selectedMeta, selectedContent.data])

  // 切换条目时复位「查看某版次 / 版本面板」（notice 不在此处清，否则软删成功的提示会被冲掉）
  useEffect(() => {
    setViewVersion(undefined)
    setShowVersions(false)
  }, [selectedId])

  /** 选中某条目（用户主动选择时清掉上一次的操作提示，并回写 hash 深链）。 */
  const select = (id: string) => {
    justRemovedRef.current = false
    setSelectedId(id)
    setNotice('')
    onSelect?.(id)
  }

  const modLabel = (name: string): string => (name === '' || name === INBOX ? t('knowledge.uncategorized') : name)

  const layerLabel = (layer: string): string => {
    if (layer === 'global') return t('knowledge.layer.global')
    if (layer === 'project') return t('knowledge.layer.project')
    if (layer === 'role') return t('knowledge.layer.role')
    return layer
  }

  const toggleBook = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const onRemove = async () => {
    if (meta === null) return
    if (!window.confirm(t('knowledge.entry.confirmRemove', { title: meta.title }))) return
    setBusyRemove(true)
    setNotice('')
    try {
      const res = await api.kbRemove(selectedId, false)
      // 先立守卫再清 sel：books 的 reload 可能先于 hash 清空到达，别让 effect 把已删条目选回来
      justRemovedRef.current = true
      setNotice(t('knowledge.entry.removed', { n: res.references }))
      setSelectedId('')
      onSelect?.(undefined) // 清 hash 深链，右侧回到空态、提示保留
      catalog.reload()
      stats.reload()
    } catch (e) {
      setNotice(t('knowledge.entry.removeFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyRemove(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t('knowledge.title')}</h1>
          <p className="muted">{t('knowledge.desc')}</p>
        </div>
      </div>

      {catalog.error && <div className="error">{catalog.error}</div>}
      {catalog.loading && <div className="muted">…</div>}

      {!catalog.loading && !catalog.error && (
        <div className="book-layout">
          {/* 左侧目录 */}
          <div className="book-sidebar">
            <div className="book-search">
              <input
                type="text"
                placeholder={t('knowledge.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <nav className="book-toc">
              {/* 服务端全文搜索结果（正文命中也能搜到） */}
              {query !== '' && (
                <div className="toc-section">
                  <div className="toc-label">
                    {t('knowledge.searchResults')}
                    {searchRun.loading ? ' …' : ''}
                  </div>
                  {searchRun.error && <div className="error small" style={{ margin: '4px 12px' }}>{searchRun.error}</div>}
                  {(searchRun.data ?? []).map((r) => (
                    <div
                      key={r.id}
                      className={`toc-item${selectedId === r.id ? ' active' : ''}`}
                      onClick={() => select(r.id)}
                      title={r.excerpt}
                    >
                      <span className="toc-dot" style={{ background: TYPE_COLOR[r.type] ?? '#8b93a7' }} />
                      <span className="toc-title">{r.title}</span>
                    </div>
                  ))}
                  {!searchRun.loading && (searchRun.data ?? []).length === 0 && (
                    <div className="small muted" style={{ padding: '4px 12px' }}>
                      {t('knowledge.search.none', { q: query })}
                    </div>
                  )}
                </div>
              )}

              {filtered.map((bk) => {
                const key = bookKey(bk)
                const isOpen = expanded.has(key)
                return (
                  <div key={key} className="toc-section">
                    <div
                      className="toc-label"
                      onClick={() => toggleBook(key)}
                      style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
                    >
                      <span style={{ fontSize: 10, transition: 'transform .15s', display: 'inline-block', transform: isOpen ? 'rotate(90deg)' : 'rotate(0)' }}>▶</span>
                      <span style={{ color: 'var(--text)', fontWeight: 600 }}>{bk.book}</span>
                      <span className="toc-count">{bk.total}</span>
                    </div>
                    {isOpen &&
                      bk.modules.map((mod) => (
                        <div key={mod.name}>
                          <div style={{ padding: '3px 12px 3px 28px', fontSize: 11.5, color: 'var(--muted)', fontWeight: 500 }}>
                            {modLabel(mod.name)}
                          </div>
                          {mod.entries.map(({ entry }) => (
                            <div
                              key={entry.id}
                              className={`toc-item${selectedId === entry.id ? ' active' : ''}`}
                              onClick={() => select(entry.id)}
                            >
                              <span className="toc-dot" style={{ background: TYPE_COLOR[entry.type] ?? '#8b93a7' }} />
                              <span className="toc-title">{entry.title}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                  </div>
                )
              })}
              {/* query 非空时由 search.none 出空态文案，同屏只出一条，避免两行同义并存 */}
              {filtered.length === 0 && query === '' && (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
                  {t('knowledge.noResults')}
                </div>
              )}
            </nav>
            <div className="book-footer">{t('knowledge.total', { n: stats.data?.entries ?? 0 })}</div>
          </div>

          {/* 右侧内容 */}
          <div className="book-content">
            {/* 操作提示（软删成功/失败）挂在面板外：软删后选中被清空、面板消失，提示仍需可见 */}
            {notice !== '' && <div className="banner small">{notice}</div>}
            {meta === null ? (
              <div className="empty-hint">
                <span style={{ fontSize: 32 }}>📖</span>
                <span>{t('knowledge.selectEntry')}</span>
                <span className="small" style={{ color: 'var(--muted)' }}>
                  {t('knowledge.bookSummary', { entries: catalog.data?.length ?? 0, books: books.length })}
                </span>
              </div>
            ) : (
              <>
                <div className="entry-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h2 style={{ margin: 0, flex: 1 }}>{meta.title}</h2>
                    <button className="tool-btn" onClick={() => setShowVersions((v) => !v)}>
                      {t('knowledge.entry.history')}
                    </button>
                    <button className="tool-btn" disabled={busyRemove} onClick={() => void onRemove()}>
                      {busyRemove ? t('knowledge.entry.softDeleting') : t('knowledge.entry.softDelete')}
                    </button>
                  </div>
                  <div className="entry-meta" style={{ marginTop: 6 }}>
                    <span className="tag" style={{ background: TYPE_COLOR[meta.type] ?? '#8b93a7', color: '#fff', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>
                      {meta.type}
                    </span>
                    <span className="tag">{layerLabel(meta.layer)}</span>
                    {meta.owner && <span className="tag">{meta.owner}</span>}
                    <span className="tag muted">{meta.book} / {modLabel(meta.module)}</span>
                    <span className="tag muted">v{meta.version}</span>
                  </div>
                </div>

                {viewVersion !== undefined && (
                  <div className="banner">
                    <span className="tag warn">{t('knowledge.entry.viewing')} v{viewVersion}</span>
                    <button className="tool-btn" onClick={() => setViewVersion(undefined)}>
                      {t('knowledge.entry.backToCurrent')}
                    </button>
                  </div>
                )}

                {showVersions && (
                  <div className="pane">
                    <h3>{t('knowledge.entry.versionsCount', { n: versions.data?.length ?? 0 })}</h3>
                    {versions.loading && <div className="muted small">…</div>}
                    {versions.error && <div className="error small">{versions.error}</div>}
                    {(versions.data ?? []).map((v) => (
                      <button
                        key={v.version}
                        className="list-row"
                        disabled={v.version === viewVersion}
                        onClick={() => setViewVersion(v.version)}
                      >
                        <span className="list-main mono">
                          v{v.version} · {v.status}
                          {v.is_latest ? ` · ${t('knowledge.entry.current')}` : ''}
                        </span>
                        <span className="small muted">{v.updated_at.slice(0, 16).replace('T', ' ')}</span>
                      </button>
                    ))}
                    {!versions.loading && (versions.data ?? []).length === 0 && (
                      <div className="small muted">{t('knowledge.entry.none')}</div>
                    )}
                  </div>
                )}

                <div className="entry-body">
                  {selectedContent.loading && <p className="muted">…</p>}
                  {selectedContent.error && <div className="error">{selectedContent.error}</div>}
                  {selectedContent.data && (
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {selectedContent.data.content}
                    </pre>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
