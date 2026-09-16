import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'

import { api, type BookNode, type BookStructure, type CatalogEntry, type EntryVersion, type SearchResult } from '../api.ts'
import { ConfirmModal } from '../components/ConfirmModal.tsx'
import { MarkdownBlocks } from '../components/Markdown.tsx'
import { Ref } from '../components/ref.tsx'
import { State } from '../components/State.tsx'
import { CopyButton, EmptyBlock, PageHead } from '../components/ui.tsx'
import { useAsync } from '../components/useAsync.ts'
import { useT } from '../i18n.ts'
import { parseMarkdown } from '../markdown.ts'
import { hrefOf } from '../route.ts'
import { fmtTime } from '../time.ts'
import { isSelMiss, resolveBookDeepLink, selMissDetail } from './knowledge-logic.ts'
import { SearchHitRow } from './SearchHitRow.tsx'

/**
 * 知识库（左栏目录 + 右栏书页，v7 阅读室）。
 *
 * 左栏模型（design-brief-v7-a §4.1 K1/K2/K3/K13）：
 * - **3 层**：书 → 模块 → 条目；**层（global/project/role）不占树的一层**，
 *   降为两处 —— ① 每本书恒有副行「层 › 归属」（global 无归属只显示「全局」，
 *   同名书因此必然两行文本不同，K2）；② 顶部过滤 chips（全部/全局/项目/角色）。
 * - **数据源**：骨架走 `kbTree()`（无 limit，含 `modules[].count`/`total`）；
 *   **条目按书懒加载** —— 首次展开某书才 `kbCatalog({layer, owner, book, limit: 200})`，
 *   超 200 时该书末尾给「还有 N 条」。旧的 `kbCatalog({limit:5000})` 整页拉取模式**已废**。
 * - 目录引线（§2.9）：模块行的「标题 …… 计数」用 `border-bottom: 1px dotted var(--rule)`
 *   撑满弹性区，计数列 `tabular-nums` 右对齐。
 * - 深链：`?layer/?owner/?book` 初始化过滤与展开态；**`?book=` 命中时目录收敛到那一本**
 *   （D-3 / T6 边表：`Ref kind=book` 的落点必须收敛，判据见 `knowledge-logic.ts`）；
 *   点书/模块/条目回写 hash。
 *
 * 本批只重写左栏；右栏书页（结构化正文渲染、边注、层间冲突）留待下一批。
 */

const TYPE_COLOR: Record<string, string> = {
  rule: 'var(--type-rule)',
  doc: 'var(--type-doc)',
  guide: 'var(--type-guide)',
  pitfall: 'var(--type-pitfall)',
  pattern: 'var(--type-pattern)',
  diagram: 'var(--type-diagram)',
  summary: 'var(--type-summary)',
  other: 'var(--type-other)',
}

/** 无 module 的条目在侧栏分组用的哨兵；展示时经 i18n 映射为「未归类」。 */
const INBOX = '_inbox'
/** 层过滤 chip；`all` 不带 `?layer=`。 */
const LAYER_CHIPS = ['all', 'global', 'project', 'role'] as const
type LayerFilter = (typeof LAYER_CHIPS)[number]
/** 检索每页条数：请求 `limit + 1` 以判定截断（K6）。 */
const SEARCH_PAGE = 50

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

function modKey(book: string, module: string): string {
  return `${book}::${module}`
}

export function KnowledgePage({
  sel,
  query,
  onSelect,
  onQuery,
}: {
  sel?: string
  query?: Readonly<Record<string, string>>
  onSelect?: (id?: string) => void
  onQuery?: (patch: Record<string, string | undefined>) => void
}) {
  const t = useT()
  // 骨架：无 limit 的书/模块树（K3）；条目靠下面的 per-book 懒加载。
  const tree = useAsync(() => api.kbTree(), [])
  const stats = useAsync(() => api.kbStats(), [])
  const q = query ?? {}

  const [layer, setLayer] = useState<LayerFilter>(
    q.layer === 'global' || q.layer === 'project' || q.layer === 'role' ? q.layer : 'all',
  )
  const [owner, setOwner] = useState<string | undefined>(q.owner === '' ? undefined : q.owner)
  const [search, setSearch] = useState(q.q ?? '')
  const [queryText, setQueryText] = useState(q.q ?? '')
  /** 截断后的收窄范围：none / layer（限当前层）/ book（限当前书）。 */
  const [scope, setScope] = useState<'none' | 'layer' | 'book'>('none')
  const [selectedId, setSelectedId] = useState<string>(sel ?? '')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedMods, setCollapsedMods] = useState<Set<string>>(new Set())
  /** bookKey → 该书的条目（懒加载缓存；undefined = 尚未拉取）。 */
  const [entriesByBook, setEntriesByBook] = useState<Record<string, CatalogEntry[]>>({})
  const loadingRef = useRef<Set<string>>(new Set())
  const [viewVersion, setViewVersion] = useState<number | undefined>(undefined)
  const [showVersions, setShowVersions] = useState(false)
  const [busyRemove, setBusyRemove] = useState(false)
  const [notice, setNotice] = useState('')
  /** 渲染视图 / 源码视图（K8）。 */
  const [renderMode, setRenderMode] = useState<'render' | 'source'>('render')
  /** 统一确认模态（K12）：待确认的软删请求。 */
  const [pendingRemove, setPendingRemove] = useState<{ id: string; title: string } | null>(null)
  /** 软删后就地反馈 + 12s 内可撤销（K12）；hash 不变。 */
  const [removed, setRemoved] = useState<{ id: string; references: number } | null>(null)
  const [showConflicts, setShowConflicts] = useState(false)

  const books = useMemo<BookNode[]>(() => {
    const list = tree.data ?? []
    return [...list].sort((a, b) => a.book.localeCompare(b.book) || (a.owner ?? '').localeCompare(b.owner ?? ''))
  }, [tree.data])

  /**
   * book 深链（D-3 / §3.2 边表 T6）：`?layer=..&owner=..&book=..` 命中的那本。
   *
   * 纯判据抽在 `knowledge-logic.ts#resolveBookDeepLink`（node 直测）：`book` 缺省/空串/
   * 未命中一律 `undefined`（静默忽略参数，与非法 `layer` 同口径）；多 owner 同名书且未带
   * `owner` 时取 `books`（已按 `book › owner` 排序）的首个。
   * 本 memo 依赖 `books` → **catalog 未载入时自然回落 `undefined`，`tree.data` 一到就重算**。
   */
  const currentBook = useMemo<BookNode | undefined>(
    () => resolveBookDeepLink(books, q),
    [books, q.book, q.owner, q.layer],
  )

  /**
   * 单框双语义（K5）：**输入** = 目录内本地收敛（`search` → `needle`）；
   * **回车** = 显式升级到全文检索模式，左栏整体替换为结果列表，并写 `?q=`（可分享 / 后退回目录）。
   * 清空输入框**不退出**检索模式——退出只走「← 返回目录」或浏览器后退。
   */
  const enterSearch = () => {
    const word = search.trim()
    if (word === '') return
    setQueryText(word)
    setScope('none')
    onQuery?.({ q: word })
  }
  const exitSearch = () => {
    setQueryText('')
    setScope('none')
    onQuery?.({ q: undefined })
  }

  // `?q=` 存在时刷新/后退直接进检索模式（前进后退都靠这条对齐 hash）。
  useEffect(() => {
    setQueryText(q.q ?? '')
    if (q.q === undefined || q.q === '') setScope('none')
  }, [q.q])

  const searching = queryText !== ''
  // K6：多请求 1 条判截断（51），只展示前 50。
  const searchRun = useAsync(
    () =>
      searching
        ? api.kbSearch({
            q: queryText,
            layers: scope === 'layer' && layer !== 'all' ? layer : undefined,
            book: scope === 'book' ? currentBook?.book : undefined,
            limit: SEARCH_PAGE + 1,
          })
        : Promise.resolve<SearchResult[]>([]),
    [queryText, scope, layer, currentBook?.book],
  )
  const searchRaw = searchRun.data ?? []
  const truncated = searchRaw.length > SEARCH_PAGE
  const hits = truncated ? searchRaw.slice(0, SEARCH_PAGE) : searchRaw

  // 深链：?layer/?owner/?book 初始化过滤与展开态（点书后 hash 变、本 effect 幂等重跑）。
  // hash 是过滤态的唯一真相源：**无参时同样复位**，否则浏览器后退到无参地址
  // （如 `#/knowledge`）会留下上一页的 layer/owner 过滤器（MINOR-14）。
  // 复位用函数式 set 且只在值真的不同时才换引用，避免与守卫互相触发成环。
  useEffect(() => {
    if (q.layer === 'global' || q.layer === 'project' || q.layer === 'role') setLayer(q.layer)
    else setLayer((prev) => (prev === 'all' ? prev : 'all'))
    if (q.owner !== undefined && q.owner !== '') setOwner(q.owner)
    else setOwner((prev) => (prev === undefined ? prev : undefined))
    // book 深链：把命中那本**展开**（懒加载由下面那条 effect 按 `expanded` 接手）——
    // 与用户点书同一条落点语义（`toggleBook` 也是「进 expanded + 回写 hash」）。
    // 旧写法按 `tree.data` 里 book 名相符的**全部**书展开，同层多 owner 同名书时会把
    // 未收敛进来的那几本也展开；这里只认 `currentBook` 这一本。
    if (currentBook !== undefined) {
      const key = bookKey(currentBook)
      setExpanded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
    }
  }, [q.layer, q.owner, currentBook])

  // 懒加载：只拉「已展开且未缓存」的书（K3）。
  useEffect(() => {
    for (const bk of books) {
      const key = bookKey(bk)
      if (!expanded.has(key) || entriesByBook[key] !== undefined || loadingRef.current.has(key)) continue
      loadingRef.current.add(key)
      void api
        .kbCatalog({ layer: bk.layer, owner: bk.owner, book: bk.book, limit: 200 })
        .then((list) => setEntriesByBook((prev) => ({ ...prev, [key]: list })))
        .catch(() => setEntriesByBook((prev) => ({ ...prev, [key]: [] })))
        .finally(() => loadingRef.current.delete(key))
    }
  }, [books, expanded, entriesByBook])

  // 深链到某条目：选中它；若它所在的（已加载）书未展开，则展开（§2.5：sel 变更自动恢复）。
  useEffect(() => {
    if (sel === undefined || sel === '') {
      setSelectedId('')
      return
    }
    setSelectedId(sel)
    for (const [key, list] of Object.entries(entriesByBook)) {
      if (list.some((e) => e.id === sel)) {
        setExpanded((prev) => new Set(prev).add(key))
        break
      }
    }
  }, [sel, entriesByBook])

  const entryIndex = useMemo(() => {
    const map = new Map<string, CatalogEntry>()
    for (const list of Object.values(entriesByBook)) for (const e of list) map.set(e.id, e)
    return map
  }, [entriesByBook])

  const needle = search.trim().toLowerCase()
  /**
   * 目录收敛（D-3 / T6）：层/归属过滤之上，再叠一层 **book 深链**——
   * `?book=` 命中时目录**只剩那一本**（`Ref kind=book` 的落点不收敛就只是「过滤了个层」，
   * 契约要求「落点收敛到该书」）。`currentBook` 为 `undefined`（无 `book` 参数 / 未命中）
   * 时这一层不存在，普通目录行为不变。
   *
   * ⚠ 由此带来的语义：`toggleBook` 本来就会把 `book=` 回写进 hash（现有行为），所以
   * **点开某本书后目录即聚焦到它**（hash 是过滤态的唯一真相，收敛跟着 hash 走）。
   * 回到整层目录的出路是层 chips——`pickLayer` 已一并清掉 book（见其注释）。
   */
  const scopedBooks = useMemo(
    () =>
      books.filter(
        (b) =>
          (layer === 'all' || b.layer === layer) &&
          (owner === undefined || b.owner === owner) &&
          (currentBook === undefined || b === currentBook),
      ),
    [books, layer, owner, currentBook],
  )
  const owners = useMemo(() => {
    const set = new Set<string>()
    for (const b of books) {
      if (layer !== 'all' && b.layer !== layer) continue
      if (b.owner !== undefined && b.owner !== '') set.add(b.owner)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [books, layer])

  /**
   * 过滤视图：命中条目保留祖先路径（书/模块行不因未命中而消失）；
   * 书名命中则整本书的模块全可见。未展开的书只能按书名/模块名命中 —— 懒加载的必然代价。
   */
  const view = useMemo(() => {
    const nd = needle
    const isHit = (e: CatalogEntry): boolean =>
      e.title.toLowerCase().includes(nd) || e.id.toLowerCase().includes(nd) || e.tags.some((tag) => tag.toLowerCase().includes(nd))
    return scopedBooks
      .map((bk) => {
        const key = bookKey(bk)
        const cached = entriesByBook[key]
        const bookHit = nd !== '' && bk.book.toLowerCase().includes(nd)
        const modules = bk.modules.map((m) => {
          const name = m.name === '' ? INBOX : m.name
          const own = (cached ?? []).filter((e) => (e.module === '' ? INBOX : e.module) === name)
          const entries = nd === '' || bookHit ? own : own.filter(isHit)
          const modHit = nd !== '' && name.toLowerCase().includes(nd)
          return { name: m.name, count: m.count, entries, visible: nd === '' || bookHit || modHit || entries.length > 0 }
        })
        return { node: bk, key, modules, visible: nd === '' || bookHit || modules.some((m) => m.visible), cached }
      })
      .filter((b) => b.visible)
  }, [scopedBooks, entriesByBook, needle])

  const hitCount = view.reduce((n, b) => n + b.modules.reduce((k, m) => k + m.entries.length, 0), 0)

  const selectedMeta = useMemo<EntryMeta | null>(() => {
    if (selectedId === '') return null
    const cached = entryIndex.get(selectedId)
    if (cached !== undefined) return cached
    return (searchRun.data ?? []).find((r) => r.id === selectedId) ?? null
  }, [entryIndex, selectedId, searchRun.data])

  const selectedContent = useAsync(
    () => (selectedId !== '' ? api.kbGet(selectedId, viewVersion) : Promise.resolve(null)),
    [selectedId, viewVersion],
  )

  const versions = useAsync(
    () => (showVersions && selectedId !== '' ? api.kbVersions(selectedId) : Promise.resolve<EntryVersion[]>([])),
    [showVersions, selectedId],
  )

  // 条目正文兜底：深链到未加载成目录条目的 id 时，用取回的正文明示摘要
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
    setShowConflicts(false)
    setRenderMode('render')
  }, [selectedId])

  const layerLabel = (value: string): string => {
    if (value === 'global') return t('knowledge.layer.global')
    if (value === 'project') return t('knowledge.layer.project')
    if (value === 'role') return t('knowledge.layer.role')
    return value
  }
  const modLabel = (name: string): string => (name === '' || name === INBOX ? t('knowledge.uncategorized') : name)
  const statusLabel = (status: string): string => {
    if (status === 'candidate') return t('knowledge.status.candidate')
    if (status === 'superseded') return t('knowledge.status.superseded')
    if (status === 'deprecated') return t('knowledge.status.deprecated')
    return status
  }
  const statusKind = (status: string): string => {
    if (status === 'candidate') return 'warn'
    if (status === 'deprecated') return 'err'
    return 'muted'
  }

  /**
   * 层 chip = 「重选范围」，故一并清掉 `book` 深链（与它已经在清的 `owner` 同理）：
   * 目录一旦被 `?book=` 收敛到一本，若 hash 里那本书留得住，切层只会换出一份
   * 「按新层过滤 + 仍只剩那一本」的目录，用户再也回不到整层——chip 必须能解除收敛。
   */
  const pickLayer = (next: LayerFilter) => {
    setLayer(next)
    setOwner(undefined)
    onQuery?.({ layer: next === 'all' ? undefined : next, owner: undefined, book: undefined })
  }
  const pickOwner = (next: string | undefined) => {
    setOwner(next)
    onQuery?.({ owner: next })
  }
  const toggleBook = (bk: BookNode) => {
    const key = bookKey(bk)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    onQuery?.({ layer: bk.layer, owner: bk.owner, book: bk.book })
  }
  const toggleModule = (bk: BookNode, name: string) => {
    const key = modKey(bookKey(bk), name)
    setCollapsedMods((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    onQuery?.({ layer: bk.layer, owner: bk.owner, book: bk.book })
  }

  /** 选中某条目（用户主动选择时清掉上一次的操作提示，并回写 hash 深链）。 */
  const select = (id: string) => {
    setSelectedId(id)
    setNotice('')
    onSelect?.(id)
  }

  /**
   * A2：目录行的 `href` —— 与 `select()` 回写的 hash 同目标（条目 + 保留过滤 query）。
   * 行本身用 `<a href>` 承担键盘/中键/复制链接；`onClick` 仍调 `select()`，
   * 因为右栏读的是**本地** `selectedId`（不是 route），纯 href 会让同页点击不换页。
   */
  const entryHref = (id: string): string => hrefOf({ page: 'knowledge', sel: id, query: { ...q } })

  /** A2：非原生可点行（展开切换）的键盘契约 —— Enter / Space 等价于点击。 */
  const keyboardToggle = (e: ReactKeyboardEvent<HTMLDivElement>, run: () => void) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    run()
  }

  /** 把条目从已加载缓存里摘掉（软删后行内立即消失，不整页重拉）。 */
  const dropEntry = (id: string) => {
    setEntriesByBook((prev) => {
      const next: Record<string, CatalogEntry[]> = {}
      for (const [key, list] of Object.entries(prev)) next[key] = list.filter((e) => e.id !== id)
      return next
    })
  }

  const confirmRemove = async () => {
    if (pendingRemove === null) return
    const id = pendingRemove.id
    setPendingRemove(null)
    setBusyRemove(true)
    setNotice('')
    try {
      const res = await api.kbRemove(id, false)
      // K12：hash 不变（不调用 onSelect），就地反馈 + 12s 内可撤销
      setRemoved({ id, references: res.references })
      dropEntry(id)
      tree.reload()
      stats.reload()
    } catch (e) {
      setNotice(t('knowledge.entry.removeFailed', { msg: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusyRemove(false)
    }
  }

  const undoRemove = async () => {
    if (removed !== null) await restoreEntry(removed.id)
  }

  /** 撤销软删（K12）：恢复后清缓存 → 展开中的书按需重拉，行会回来。 */
  async function restoreEntry(id: string): Promise<void> {
    try {
      await api.kbRestore(id)
      setRemoved(null)
      setEntriesByBook({})
      tree.reload()
      stats.reload()
    } catch (e) {
      setNotice(t('knowledge.entry.removeFailed', { msg: e instanceof Error ? e.message : String(e) }))
    }
  }

  // 12s 后撤销窗口关闭（K12）
  useEffect(() => {
    if (removed === null) return
    const timer = window.setTimeout(() => setRemoved(null), 12_000)
    return () => window.clearTimeout(timer)
  }, [removed])

  // ── 右栏数据（K4/K8/K9/K10/K11）────────────────────────────────────────────
  const content = selectedContent.data?.content ?? ''
  /** K10：单条 > 256KB 退化源码视图，防一次性渲染卡死。 */
  const tooLarge = content.length > 262_144
  // MINOR-12：tooLarge 时**不解析**（`parseMarkdown` 在渲染期同步跑，后置 effect 挡不住）；
  // 下游据 `parsed === null` 走源码分支，解析结果不会被渲染。
  const parsed = useMemo(() => (tooLarge ? null : parseMarkdown(content)), [content, tooLarge])
  useEffect(() => {
    if (tooLarge) setRenderMode('source')
  }, [tooLarge])

  /** 书头定位：选中条目的书优先，否则 ?book= 命中的书。 */
  const bookRef = useMemo(
    () =>
      meta !== null
        ? { layer: meta.layer, book: meta.book }
        : currentBook !== undefined
          ? { layer: currentBook.layer, book: currentBook.book }
          : undefined,
    [meta, currentBook],
  )
  // K4：not_found / bad_request（同层多 owner 同名书）与「未生成」同路 —— 一律回落，不弹错误
  const structure = useAsync(
    () =>
      bookRef === undefined
        ? Promise.resolve<BookStructure | null>(null)
        : api.kbBookStructure(bookRef).catch(() => null),
    [bookRef?.layer, bookRef?.book],
  )
  const inherited = structure.data?.inherited_from ?? []

  // K11：层间冲突只读提示（kbConflicts 是全局列表，按「当前已加载条目的 id」落到本模块）
  const conflicts = useAsync(() => api.kbConflicts(), [])
  const myConflicts = useMemo(
    () => (conflicts.data ?? []).filter((c) => entryIndex.has(c.high_id) || entryIndex.has(c.low_id)),
    [conflicts.data, entryIndex],
  )
  const metaEntry = meta === null ? undefined : entryIndex.get(meta.id)
  /** 深链未命中（K12/§2.5）：请求已完结且未取到内容（含出错路径）→ notFound pane。判据见 `isSelMiss`。 */
  const notFound = isSelMiss(selectedId, selectedContent.loading, selectedContent.data)
  /** 复检 MINOR-②：pane 合流了「真未命中」与「500/网络错」——后者的错误原文在 pane 里捎带，不许被「不存在」标题吞掉。 */
  const missError = selMissDetail(selectedContent.error)

  // R-6 Q5：owner 的落点由 `Ref`/`refRoute` 统一表达（role → #/roles/<name>，project → #/projects），
  // 页面不再自建 href 拼接。

  return (
    <>
      {/* B1：页标题走 `<PageHead>`（`--fs-600`/600）——手写 `<h1>` 是 UA 默认 28px/700，§2.4 只认 20px。 */}
      <PageHead title={t('knowledge.title')} sub={t('knowledge.desc')} />

      <State loading={tree.loading} error={tree.error ?? undefined}>
        {books.length === 0 ? (
          <EmptyBlock
            title={t('knowledge.empty.title')}
            desc={t('knowledge.empty.desc')}
            command={t('knowledge.empty.command')}
          />
        ) : (
          <div className="book-layout">
            {/* 左栏：目录（或检索结果，二选一，永不并排） */}
            <div className="book-sidebar">
              <div className="book-search">
                <input
                  type="text"
                  placeholder={t('knowledge.searchPlaceholder')}
                  aria-label={t('knowledge.searchPlaceholder')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') enterSearch()
                  }}
                />
              </div>

              {/* 层过滤 chips：层不占树层，靠 chips + 书副行表达（K1） */}
              {!searching && (
                <div className="toc-chips">
                  {LAYER_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      className={`toc-chip${layer === chip ? ' active' : ''}`}
                      onClick={() => pickLayer(chip)}
                    >
                      {chip === 'all' ? t('knowledge.chip.all') : layerLabel(chip)}
                    </button>
                  ))}
                </div>
              )}
              {!searching && layer !== 'all' && owners.length > 0 && (
                <div className="toc-chips toc-chips-sub">
                  <button className={`toc-chip${owner === undefined ? ' active' : ''}`} onClick={() => pickOwner(undefined)}>
                    {t('knowledge.chip.all')}
                  </button>
                  {owners.map((name) => (
                    <button
                      key={name}
                      className={`toc-chip${owner === name ? ' active' : ''}`}
                      onClick={() => pickOwner(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}

              <nav className="book-toc">
                {searching && (
                  <div className="toc-section">
                    {/* 顶部行：← 返回目录 · N 条（显示前 N）；截断时才给收窄按钮（K6） */}
                    <div className="toc-search-head">
                      <button className="tool-btn" onClick={exitSearch}>
                        {t('knowledge.search.back')}
                      </button>
                      <span className="toc-count">
                        {t('knowledge.searchResults')} ›{' '}
                        {truncated
                          ? t('knowledge.search.truncated', { n: SEARCH_PAGE })
                          : t('knowledge.search.count', { n: hits.length })}
                        {/* B10：此处是**行内**在途标记（计数行右端），不是三态容器 —— 骨架条会与
                            旧结果同屏、且每次击键都闪一次，故按 `graph.querying` 同制走 i18n 文案，
                            不手写 `…`（`<State loading>` 用在上方目录/版本/正文三处）。 */}
                        {searchRun.loading && (
                          <span className="muted"> {t('knowledge.search.running')}</span>
                        )}
                      </span>
                    </div>
                    {truncated && (
                      <div className="toc-scope">
                        <button
                          className={`toc-chip${scope === 'layer' ? ' active' : ''}`}
                          disabled={layer === 'all'}
                          onClick={() => setScope('layer')}
                        >
                          {t('knowledge.search.limitLayer')}
                        </button>
                        <button
                          className={`toc-chip${scope === 'book' ? ' active' : ''}`}
                          disabled={currentBook === undefined}
                          onClick={() => setScope('book')}
                        >
                          {t('knowledge.search.limitBook')}
                        </button>
                      </div>
                    )}
                    {searchRun.error && <div className="error small toc-note">{searchRun.error}</div>}

                    {/* 结果行（K7）：标题 + 副行「层 › 归属 › 书 › 模块」+ excerpt + 命中来源；不做高亮
                        D-1：行抽成 `SearchHitRow`（原内联结构把标题压成 width:0），形状由
                        `apps/web/test/knowledge-search-hit.test.ts` 锁。 */}
                    {hits.map((r) => (
                      <SearchHitRow
                        key={r.id}
                        entry={r}
                        href={entryHref(r.id)}
                        active={selectedId === r.id}
                        onOpen={() => select(r.id)}
                        layerText={layerLabel(r.layer)}
                        moduleText={modLabel(r.module)}
                      />
                    ))}

                    {/* 检索无结果：行内空态 + 出路（K13） */}
                    {!searchRun.loading && hits.length === 0 && (
                      <div className="small muted toc-note">
                        {t('knowledge.search.none', { q: queryText })}
                        <br />
                        {t('knowledge.search.hint')}
                      </div>
                    )}
                  </div>
                )}

                {!searching &&
                  view.map((bk) => {
                    const isOpen = expanded.has(bk.key)
                    return (
                      <div key={bk.key} className="toc-section">
                        {/* A2：书行是**展开切换**（不是导航实体），故不做 `<a>`：
                            补 role/tabIndex/Enter·Space，键盘与读屏可用（DOM 结构不动，视觉零变化）。 */}
                        <div
                          className="toc-book"
                          role="button"
                          tabIndex={0}
                          aria-expanded={isOpen}
                          onClick={() => toggleBook(bk.node)}
                          onKeyDown={(e) => keyboardToggle(e, () => toggleBook(bk.node))}
                        >
                          <div className="toc-book-main">
                            <span className={`toc-chev${isOpen ? ' open' : ''}`}>▸</span>
                            <span className="toc-bookname">{bk.node.book}</span>
                            <span className="toc-leader" />
                            <span className="toc-count">{bk.node.total}</span>
                          </div>
                          {/* 每本书恒有副行「层 › 归属」；global 无归属只显示「全局」（K2） */}
                          <div className="toc-book-sub">
                            <span>{layerLabel(bk.node.layer)}</span>
                            {bk.node.owner !== undefined && bk.node.owner !== '' && (
                              <>
                                <span className="toc-sep">›</span>
                                <span>{bk.node.owner}</span>
                              </>
                            )}
                          </div>
                        </div>

                        {isOpen &&
                          bk.modules
                            .filter((m) => m.visible)
                            .map((m) => {
                              const modOpen = !collapsedMods.has(modKey(bk.key, m.name))
                              return (
                                <div key={m.name}>
                                  {/* A2：模块行同为展开切换，处理方式与书行一致。 */}
                                  <div
                                    className="toc-mod"
                                    role="button"
                                    tabIndex={0}
                                    aria-expanded={modOpen}
                                    onClick={() => toggleModule(bk.node, m.name)}
                                    onKeyDown={(e) => keyboardToggle(e, () => toggleModule(bk.node, m.name))}
                                  >
                                    <span className={`toc-chev${modOpen ? ' open' : ''}`}>▸</span>
                                    <span className="toc-modname">{modLabel(m.name)}</span>
                                    <span className="toc-leader" />
                                    <span className="toc-count">{m.count}</span>
                                  </div>
                                  {modOpen &&
                                    m.entries.map((entry) => (
                                      <a
                                        key={entry.id}
                                        href={entryHref(entry.id)}
                                        className={`toc-item${selectedId === entry.id ? ' active' : ''}`}
                                        onClick={() => select(entry.id)}
                                      >
                                        <span className="toc-title">{entry.title}</span>
                                        {/* 仅 status ≠ active 时画状态点 + 文字（K11） */}
                                        {entry.status !== 'active' && (
                                          <span className={`toc-status ${statusKind(entry.status)}`}>
                                            <span className="toc-lamp" />
                                            {statusLabel(entry.status)}
                                          </span>
                                        )}
                                      </a>
                                    ))}
                                </div>
                              )
                            })}

                        {/* B10：该书条目懒加载中 → 统一骨架（保留目录缩进容器） */}
                        {isOpen && bk.cached === undefined && (
                          <div className="toc-note">
                            <State loading />
                          </div>
                        )}

                        {/* 截断可见：超 200 时明示剩余条数（K3/K6） */}
                        {isOpen && bk.cached !== undefined && bk.node.total - bk.cached.length > 0 && (
                          <div className="small muted toc-note">
                            {t('knowledge.book.remaining', { n: bk.node.total - bk.cached.length })}
                          </div>
                        )}
                      </div>
                    )
                  })}

                {/* 过滤无匹配：行内空态，不是整页空态（K13） */}
                {!searching && view.length === 0 && (
                  <div className="small muted toc-note">{t('knowledge.noResults')}</div>
                )}
              </nav>

              {!searching && (
                <div className="book-footer">
                  {t('knowledge.total', { n: stats.data?.entries ?? 0 })}
                  {needle === '' ? '' : ` › ${t('knowledge.moduleHits', { n: hitCount })}`}
                </div>
              )}
            </div>

            {/* 右栏：书页（K4 书头 + K8 渲染/源码 + K9 frontmatter + K11 页边 + K12 软删） */}
            <div className="book-content">
              {notice !== '' && <div className="banner small">{notice}</div>}
              {/* K12：软删后就地反馈 + 12s 内可撤销（hash 不变） */}
              {removed !== null && (
                <div className="banner small">
                  <span>{t('knowledge.entry.removed', { n: removed.references })}</span>
                  <button className="tool-btn" onClick={() => void undoRemove()}>
                    {t('knowledge.entry.undo')}
                  </button>
                </div>
              )}

              {/* K4 书头：定稿目录 rev + 继承链；not_found / bad_request 一律回落「按实际条目列目录」 */}
              {bookRef !== undefined && (
                <div className="book-head">
                  <div className="book-head-row">
                    <h2 className="book-head-title">{bookRef.book}</h2>
                    <span className="small muted">
                      {structure.data !== null && structure.data !== undefined
                        ? `${t('knowledge.book.rev', { n: structure.data.revision })}${
                            structure.data.frozen_at === null
                              ? ''
                              : ` › ${t('knowledge.book.frozenAt', { ts: fmtTime(structure.data.frozen_at) })}`
                          }`
                        : t('knowledge.book.derived')}
                    </span>
                  </div>
                  {inherited.length > 0 && (
                    <div className="book-head-inherit">
                      <span className="small muted">{t('knowledge.book.inherited')}</span>
                      {inherited.map((ref) => {
                        const cut = ref.indexOf('/')
                        const ly = cut === -1 ? ref : ref.slice(0, cut)
                        const bk = cut === -1 ? '' : ref.slice(cut + 1)
                        return (
                          <button
                            key={ref}
                            className="toc-chip"
                            onClick={() => onQuery?.({ layer: ly, owner: undefined, book: bk })}
                          >
                            {ref}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {notFound ? (
                /* 深链未命中 / 已移出索引（§2.5）：带名称 + 出路（撤销 / 返回目录） */
                <div className="pane">
                  <h3>{t('knowledge.notFound.title')}</h3>
                  <div className="small muted">{t('knowledge.notFound.desc', { id: selectedId })}</div>
                  {missError !== undefined && (
                    <div className="small muted" style={{ marginTop: 'var(--s-2)' }} role="alert">
                      {missError}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-3)' }}>
                    <button className="tool-btn" onClick={() => void restoreEntry(selectedId)}>
                      {t('knowledge.entry.undo')}
                    </button>
                    <button className="tool-btn" onClick={() => onSelect?.(undefined)}>
                      {t('knowledge.search.back')}
                    </button>
                  </div>
                </div>
              ) : meta === null ? (
                <div className="empty-hint">
                  {/* B-2e §P3：📖 字形装饰已删（§3.D 默认禁 emoji）——空态只由两行文案承担。 */}
                  <span>{t('knowledge.selectEntry')}</span>
                  <span className="small" style={{ color: 'var(--mute)' }}>
                    {t('knowledge.bookSummary', { entries: stats.data?.entries ?? 0, books: books.length })}
                  </span>
                </div>
              ) : (
                <>
                  <div className="entry-head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
                      <h2 style={{ margin: 0, flex: 1 }}>{meta.title}</h2>
                      {/* K8：渲染 | 源码 segmented（MINOR-12：tooLarge 时无解析结果可渲染，渲染档禁用） */}
                      <div className="seg">
                        <button
                          className={renderMode === 'render' && !tooLarge ? 'active' : ''}
                          disabled={tooLarge}
                          onClick={() => setRenderMode('render')}
                        >
                          {t('knowledge.view.render')}
                        </button>
                        <button
                          className={renderMode === 'source' || tooLarge ? 'active' : ''}
                          onClick={() => setRenderMode('source')}
                        >
                          {t('knowledge.view.source')}
                        </button>
                      </div>
                      <button className="tool-btn" onClick={() => setShowVersions((v) => !v)}>
                        {t('knowledge.entry.history')}
                      </button>
                      <button
                        className="tool-btn"
                        disabled={busyRemove}
                        onClick={() => setPendingRemove({ id: meta.id, title: meta.title })}
                      >
                        {busyRemove ? t('knowledge.entry.softDeleting') : t('knowledge.entry.softDelete')}
                      </button>
                    </div>
                    <div className="entry-meta" style={{ marginTop: 'var(--s-2)' }}>
                      {/* A3：类型徽标改「`--ink` 文字 + 类型色 15% 混色底」（样式见 `.tag-type`）。
                          旧写法把主题反色文字压在实心类型色上，浅色主题 8/8 只有 1.76–3.48:1。
                          这里只注入类型色变量，双主题由 token 自己切。 */}
                      <span
                        className="tag tag-type"
                        style={{ '--type-color': TYPE_COLOR[meta.type] ?? 'var(--type-other)' } as CSSProperties}
                      >
                        {meta.type}
                      </span>
                      <span className="tag">{layerLabel(meta.layer)}</span>
                      {/* K11 + R-6 Q5：owner 是**关系列**，统一走 `Ref` 零件（不再自绘 tag 链接）。
                          role/project 两层的 owner 各指向自己的页；其余层（global 无归属）保持静态 tag。 */}
                      {meta.owner !== undefined && meta.owner !== '' ? (
                        meta.layer === 'role' || meta.layer === 'project' ? (
                          <Ref kind={meta.layer} name={meta.owner} />
                        ) : (
                          <span className="tag">{meta.owner}</span>
                        )
                      ) : null}
                      <span className="tag muted">
                        {meta.book} / {modLabel(meta.module)}
                      </span>
                      <span className="tag muted">v{meta.version}</span>
                    </div>
                  </div>

                  {viewVersion !== undefined && (
                    <div className="banner">
                      <span className="tag warn">
                        {t('knowledge.entry.viewing')} v{viewVersion}
                      </span>
                      <button className="tool-btn" onClick={() => setViewVersion(undefined)}>
                        {t('knowledge.entry.backToCurrent')}
                      </button>
                    </div>
                  )}

                  {showVersions && (
                    <div className="pane">
                      <h3>{t('knowledge.entry.versionsCount', { n: versions.data?.length ?? 0 })}</h3>
                      {versions.loading && <State loading />}
                      {versions.error && <div className="error small">{versions.error}</div>}
                      {(versions.data ?? []).map((v) => (
                        <button
                          key={v.version}
                          className="list-row"
                          disabled={v.version === viewVersion}
                          onClick={() => setViewVersion(v.version)}
                        >
                          <span className="list-main mono">
                            v{v.version} › {v.status}
                            {v.is_latest ? ` › ${t('knowledge.entry.current')}` : ''}
                          </span>
                          <span className="small muted">{fmtTime(v.updated_at)}</span>
                        </button>
                      ))}
                      {!versions.loading && (versions.data ?? []).length === 0 && (
                        <div className="small muted">{t('knowledge.entry.none')}</div>
                      )}
                    </div>
                  )}

                  {/* K11 页边（§2.9）：关系计数 / tags / 版本史；冲突只读，不 resolve */}
                  <aside className="entry-margin">
                    <div className="small muted">
                      {t('knowledge.entry.relations', { n: (metaEntry?.in_degree ?? 0) + (metaEntry?.out_degree ?? 0) })}
                    </div>
                    <div className="small mono muted">
                      {t('knowledge.entry.degrees', { in: metaEntry?.in_degree ?? 0, out: metaEntry?.out_degree ?? 0 })}
                    </div>
                    {/* 条目自带 risk 字段（low/high…）：页边展示，与 tags/关系同层信息 */}
                    {(metaEntry?.risk ?? '') !== '' && (
                      <div className="small">
                        <span className="muted">{t('knowledge.entry.risk', { level: metaEntry?.risk ?? '' })}</span>
                      </div>
                    )}
                    {(metaEntry?.tags ?? []).length > 0 && (
                      <div className="entry-margin-tags">
                        <span className="small muted">{t('knowledge.tags')}</span>
                        {(metaEntry?.tags ?? []).map((tag) => (
                          <span key={tag} className="tag muted">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {myConflicts.length > 0 && (
                      <button className="tool-btn" onClick={() => setShowConflicts((v) => !v)}>
                        {t('knowledge.entry.conflicts', { n: myConflicts.length })}
                      </button>
                    )}
                    {showConflicts &&
                      myConflicts.map((c) => (
                        <div key={c.id} className="entry-margin-conflict">
                          <span className="small muted">{c.kind}</span>
                          <button className="toc-chip" onClick={() => select(c.high_id)}>
                            {c.high_id}
                          </button>
                          <button className="toc-chip" onClick={() => select(c.low_id)}>
                            {c.low_id}
                          </button>
                        </div>
                      ))}
                  </aside>

                  {/* B3：`entry-body` 类已删（它的等宽带底框规则压过正文的衬线 17px），正文外观只由 `.md-read` 决定。 */}
                  <div className="md-read">
                    {selectedContent.loading && <State loading />}
                    {selectedContent.error !== undefined && !notFound && (
                      <div className="error">{selectedContent.error}</div>
                    )}
                    {selectedContent.data &&
                      (renderMode === 'source' || parsed === null ? (
                        /* 源码视图：行号 + 复制 + 横向滚动（K8） */
                        <div className="md-source-wrap">
                          <div className="md-source-bar">
                            <CopyButton text={content} label={t('common.copy')} />
                            {tooLarge && <span className="small muted">{t('knowledge.entry.tooLarge')}</span>}
                          </div>
                          <pre className="md-source">
                            {content.split('\n').map((line, i) => (
                              <span key={i} className="md-line">
                                <span className="md-lineno">{i + 1}</span>
                                {line}
                                {'\n'}
                              </span>
                            ))}
                          </pre>
                        </div>
                      ) : (
                        <>
                          {/* K9：frontmatter 结构化 kv（等宽键 + 正文值）置于正文之上，未知键原样列出 */}
                          {parsed.frontmatter !== undefined && (
                            <table className="md-frontmatter">
                              <tbody>
                                {Object.entries(parsed.frontmatter).map(([key, value]) => (
                                  <tr key={key}>
                                    <th>{key}</th>
                                    <td>{value}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <MarkdownBlocks blocks={parsed.blocks} />
                        </>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </State>

      {/* K12 统一确认模态（B5：改走 `<ConfirmModal>`，Esc / 遮罩 / 滚动锁 / 焦点 / 危险色全站一套）。
          正文含条目名 + 影响说明（references 由 kbRemove 返回，故在事后 banner 里给数）。 */}
      {pendingRemove !== null && (
        <ConfirmModal
          body={t('knowledge.entry.confirmRemove', { title: pendingRemove.title })}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </>
  )
}
