/**
 * 知识库页的**纯判据**（可 node 直测，不牵入 React / `api.ts`）。
 *
 * 与 `pages/roles-form-logic.ts` 同路：把组件里「有语义、易写错、值得锁」的
 * 判断抽成纯函数，避免为一条判据去搭整个组件级渲染测试。
 */

/**
 * 深链选中未命中（design-v7 §2.5）：**请求已完结且未取到内容** → notFound pane。
 *
 * - `selectedId === ''` = 未选中，不算未命中（走「从左侧选择条目」空态，meta 也是 null）；
 * - `loading` 为真时 `data` 还是上一轮的值或 `undefined`，此时不能判未命中；
 * - `data == null` 用**宽松等于**：同时覆盖「`kbGet` 返回 null（not_found）」与
 *   「`useAsync` 出错只 `setError`、不 `setData` 留下 `undefined`」两条路径
 *   （`components/useAsync.ts:23-25`）。
 *
 * 历史 bug（M4）：判据曾是 `data === null`——出错路径恒为 `undefined`，
 * 于是冷启动的未命中深链停在「从左侧选择条目」，既无名称也无出路。
 */
export function isSelMiss(selectedId: string, loading: boolean, data: unknown): boolean {
  // 故意用宽松等于：null 与 undefined 都算「未取到」（见上方两条路径）。
  return selectedId !== '' && !loading && data == null
}

/**
 * notFound pane 是否要捎带请求错误原文（复检 MINOR-②）。
 *
 * `isSelMiss` 把两条路径合流进同一个 pane：① 真「未命中」（服务端信封 `not_found`，
 * `api.request()` 抛 `Error("not_found: …")`）与 ② 基建错误（500 / 网络断，错误文本
 * 停在 `selectedContent.error`）。pane 的标题写的是「不存在」，② 被它盖住会把人引去
 * 查错误的方向——所以 ② 的原文必须在 pane 里可见，① 则不需要（标题即答案）。
 *
 * 判据：`api.ts` 的 `request()` 用 `code + ': ' + message` 拼错误文本，信封码
 * `not_found`（`packages/server/src/http/envelope.ts` ERROR_CODES）是唯一代表
 * 「未命中」的码；其余一律视为应展示的错误原文。
 */
export function selMissDetail(error: string | undefined): string | undefined {
  if (error === undefined) return undefined
  return error.startsWith('not_found:') ? undefined : error
}

/** 书的最小身份（结构型，不 import `api.ts` 的 `BookNode`——本模块保持零运行时耦合）。 */
export interface BookDeepLinkRef {
  layer: string
  owner?: string
  book: string
}

/* ── F2 书内目录树（前端按 `path` 建树，不改后端） ───────────────────────────
 *
 * 机制（design-v8 §5 钉死）：书列表骨架仍走 `kbTree`（`BookNode.modules` 只回**压平**的
 * module 计数，建不了多级树）；**书内多级目录树由前端按每书 `kbCatalog` 条目的 `path`
 * 字段建真目录树**。`moduleFromRel` 的压平（`packages/server/src/kb/scan.ts:296`）从此
 * 只存续于存储层。
 */

/**
 * 架构图节点（F2，`packages/server/src/http/routes/arch.ts` 的 diagrams 响应项子集）。
 *
 * 本模块保持零运行时耦合（不 import `api.ts`），故只声明**建树/过滤真正用到**的字段；
 * 完整形状由 `api.ts#ArchDiagram` 承担——它是本接口的**结构超集**（另含 `bytes` / `has_ir` /
 * `source` / `ir`），因此 `ArchDiagram` 可原样传进 `mountArch` 与 `archVisible`。
 * `preview` / `mtime` 只参与右栏渲染与工具条，不参与树判据，一并留着免得调用方再拼一次。
 */
export interface ArchNode {
  type: string
  name: string
  title?: string
  layer?: string
  book?: string
  module?: string
  project?: string
  preview: string
  mtime: string
}

/** 目录树节点：`name` 是**路径段名**；`key` 是树根到本节点的段路径（折叠态与 React key 的键）。 */
export interface DirNode<T> {
  name: string
  key: string
  dirs: DirNode<T>[]
  entries: T[]
  /**
   * 挂在本目录下的架构图（F2）。**必填**（构建时恒给空数组）：可选字段会让每个消费方
   * 都要写 `node.arch ?? []`，而树只在本模块构建，成本为零。
   */
  arch: ArchNode[]
}

/**
 * Prism 自有序条目的版次文件名（`<knowledgeDir>/<layer>[/<owner>]/<book>/<module|_inbox>/<id>/vNN.md`，
 * `packages/knowledge/src/store.ts:56`）。条目的 `path` 列指向**版次文件**，故
 * `<id>/vNN.md` 这两段是 Prism 自己的存储结构、不是用户的目录。
 */
const VERSION_FILE = /^v\d+\.md$/i

/**
 * `path` → 目录段数组。
 *
 * - 分隔符先归一（`path` 在 Windows 上是 `K:\a\b.md`，见本机库实测）；
 * - 丢掉文件名段：**条目本身是叶子**，文件名不参与建树（否则自有序条目的叶子全叫 `v01.md`）；
 * - `vNN.md` 再连同其 `<id>` 目录段一起丢：不丢的话每个条目都会独占一个 `KB-xxxx` 目录；
 * - 空 path / 无分隔（如 `README.md`）→ 空数组 → 归**顶层**（任务书 F2 明文）。
 */
function dirSegments(path: string): string[] {
  const segs = path.replace(/\\/g, '/').split('/').filter((s) => s !== '')
  const file = segs.pop()
  if (file !== undefined && VERSION_FILE.test(file)) segs.pop()
  return segs
}

/** 各段数组的最长公共前缀（无公共段 → 空数组）。 */
function commonPrefix(list: readonly string[][]): string[] {
  const first = list[0]
  if (first === undefined) return []
  let len = first.length
  for (const segs of list) len = Math.min(len, segs.length)
  const out: string[] = []
  for (let i = 0; i < len; i++) {
    const seg = first[i]
    if (!list.every((segs) => segs[i] === seg)) break
    out.push(seg)
  }
  return out
}

/**
 * 建「书内目录树」。**根锚定**（本实现的唯一取舍，见交付报告偏差节）：
 * 索引型条目的 `path` 是**项目原件**的绝对路径（`scan.ts:580` `path: abs`），自有序条目是
 * `<knowledgeDir>/<layer>/<owner>/<book>/…`——两者都以「最后一个与**书名**相等的段」为权威
 * 边界，锚**之后**的段才是书内目录。不锚定的话，本机实测（`~/.prism/state/knowledge.db`）
 * 目录树顶层会被 `K: › work › project › prism › …` / `C: › Users › <你> › .prism › knowledge › …`
 * 淹没，前 4–7 层全是机器路径、与「书内层级」无关。
 *
 * 锚的三条退化路径：
 * - **无锚**（书自定义名不出现在任何有目录的条目路径里）→ 剥「全部条目的目录公共前缀」（相对化兜底）；
 * - 连公共段也没有（如索引型与自有序条目混在一本书、盘符都不同）→ 原样展示绝对层级（照实，不猜）；
 * - `path` 空 / 无分隔 → 不产生任何目录段，条目落**顶层**（且不参与上面的锚判定）。
 *
 * 纯函数（`node` 环境直测）：不 import `api.ts`，条目只要求带 `path`。
 */
export function buildTree<T extends { path: string }>(entries: readonly T[], book = ''): DirNode<T> {
  const dirs = entries.map((entry) => dirSegments(entry.path))
  const anchors = dirs.map((segs) => (book === '' ? -1 : segs.lastIndexOf(book)))
  // 「本书有没有锚」判定**只针对有目录段的条目**：`README.md` 这类没有目录的条目本来就落顶层，
  // 拿它当否决票会让一本书里出现一条根级文件就全体退回绝对路径（实测 mini-snake 正是这种混合书）。
  const allAnchored = dirs.every((segs, i) => segs.length === 0 || (anchors[i] ?? -1) >= 0)
  const common = allAnchored ? [] : commonPrefix(dirs)

  const root: DirNode<T> = { name: '', key: '', dirs: [], entries: [], arch: [] }
  entries.forEach((entry, i) => {
    const segs = dirs[i] ?? []
    const from = allAnchored ? (anchors[i] ?? -1) + 1 : common.length
    let node = root
    for (const name of segs.slice(from)) {
      let next = node.dirs.find((child) => child.name === name)
      if (next === undefined) {
        next = { name, key: node.key === '' ? name : `${node.key}/${name}`, dirs: [], entries: [], arch: [] }
        node.dirs.push(next)
      }
      node = next
    }
    node.entries.push(entry)
  })
  sortDirs(root)
  return root
}

/** 同层目录按段名排序（条目保持入参顺序 = catalog 的 `updated_at DESC`）。 */
function sortDirs<T>(node: DirNode<T>): void {
  node.dirs.sort((a, b) => a.name.localeCompare(b.name))
  for (const child of node.dirs) sortDirs(child)
}

/** 子树条目总数（目录行右侧的计数；含所有层级）。**架构图节点同等计入**（F2：树的一等公民）。 */
export function countTree<T>(node: DirNode<T>): number {
  return node.entries.length + node.arch.length + node.dirs.reduce((n, child) => n + countTree(child), 0)
}

/**
 * 目录树过滤（单框双语义里的「输入即目录内本地收敛」）：**保留命中条目的祖先目录**
 * （目录行不因未命中而消失，与改造前 `view` 的 `visible` 同口径）；
 * `dirHit` 命中（目录段名含检索词）→ 该节点**整棵子树原样保留**（含其下的架构图节点）。
 *
 * `archHit` 是架构图节点（F2）的命中判据，**缺省恒真**——既让既有三参调用零改动，
 * 也让「只过滤条目」的调用点（纯条目的 node 测试）语义不变。返回的节点里 `arch` 与
 * `entries` 同样只留命中项。
 *
 * 返回 `undefined` = 本节点在本轮过滤下整棵不可见。根节点（`name === ''`）不参与 `dirHit`：
 * 否则空检索词会让「整棵保留」这条分支恒真。
 */
export function filterTree<T>(
  node: DirNode<T>,
  hit: (entry: T) => boolean,
  dirHit: (name: string) => boolean,
  archHit: (arch: ArchNode) => boolean = () => true,
): DirNode<T> | undefined {
  if (node.name !== '' && dirHit(node.name)) return node
  const dirs: DirNode<T>[] = []
  for (const child of node.dirs) {
    const kept = filterTree(child, hit, dirHit, archHit)
    if (kept !== undefined) dirs.push(kept)
  }
  const entries = node.entries.filter(hit)
  const arch = node.arch.filter(archHit)
  if (dirs.length === 0 && entries.length === 0 && arch.length === 0) return undefined
  return { name: node.name, key: node.key, dirs, entries, arch }
}

const KNOWN_LAYERS = ['global', 'project', 'role'] as const

/**
 * book 深链（design-brief-v7-a §3.2 边表 T6 + design-v7 §2）：`?layer=..&owner=..&book=..`
 * → 目录收敛到的那本书（`undefined` = 不带 book 语义）。
 *
 * 契约（与「非法 layer 值」同口径——**静默忽略，不报错**）：
 * - `book` 缺省 / 空串 → `undefined`（普通目录，不受影响）；
 * - 按 `book` 名匹配，`owner` 给了就一并匹配（T6 的书链来自 teams/knowledge 的 `Ref`，
 *   同层多 owner 同名书靠 owner 才能指准）；`layer` 给了且是合法值也一并匹配——
 *   这样「层 chip 切到别的层」时旧 book 参数自然失效，不会把目录锁死在一本看不见的书上；
 * - **多 owner 同名书且 query 未带 owner** → 取**首个**匹配（`books` 由调用方按
 *   `book › owner` 排序，故「首个」是确定的，见 `Knowledge.tsx` 的 `books` memo）；
 * - 一本书都没命中（已删 / 名字错 / 层不符）→ `undefined`（回落成普通目录）；
 * - 返回的是**入参数组里的那个对象本身**（调用方要用它二次比较/取 key）。
 */
export function resolveBookDeepLink<T extends BookDeepLinkRef>(
  books: readonly T[],
  q: Readonly<Record<string, string>>,
): T | undefined {
  const book = q.book
  if (book === undefined || book === '') return undefined
  const owner = q.owner === undefined || q.owner === '' ? undefined : q.owner
  const layer = KNOWN_LAYERS.find((l) => l === q.layer)
  return books.find(
    (b) =>
      b.book === book &&
      (owner === undefined || b.owner === owner) &&
      (layer === undefined || b.layer === layer),
  )
}

/* ── F2 架构图入目录树（design-v9 §4）──────────────────────────────────────── */

/**
 * 五类架构图（**闭集**，与 `packages/server/src/graph/archify.ts` 的
 * `ARCHIFY_DIAGRAM_TYPES` **逐元素同序**）。本模块不 import 服务端，故这里复述一份
 * ——它同时是深链类型段的判定表（见 {@link parseArchSel}）。
 *
 * ⚠ 顺序是**照抄**服务端的（`architecture, sequence, lifecycle, dataflow, workflow`），
 * 但解析**不依赖**它：`parseArchSel` 只认「某类型 + `-`」前缀，五个名字两两不构成前缀关系，
 * 换个顺序结果一样。保持一致只为让「下一个改服务端清单的人」一眼看出该同步哪一行；
 * 集合与顺序由 `knowledge-arch-logic.test.ts` 的字面量用例锁住（跨包 import 在
 * apps/web 测试环境里解析不到，只能写死）。
 */
export const ARCH_TYPES = ['architecture', 'sequence', 'lifecycle', 'dataflow', 'workflow'] as const
export type ArchType = (typeof ARCH_TYPES)[number]

/** 深链前缀：`#/knowledge/arch-<type>-<name>`（**单段 sel**，design-v9 E-5）。 */
const ARCH_SEL_PREFIX = 'arch-'

/** 架构图节点的深链 sel（`arch-<type>-<name>`）。 */
export function archSel(item: { type: string; name: string }): string {
  return `${ARCH_SEL_PREFIX}${item.type}-${item.name}`
}

/**
 * 解析架构图深链 sel（design-v9 §4 / E-5）：`arch-<type>-<name>` → `{ type, name }`。
 *
 * - `arch-` 前缀是**唯一**的形态判据——条目的 id 是 `KB-*` / `IDX-*`（`store.ts`），
 *   与它不可能相撞；页面据此**先分支**，arch sel 永不落 `kbGet(sel)` 的 404 帧。
 * - 类型必须落在 {@link ARCH_TYPES} **闭集**里，且类型后**紧跟**一个 `-`：
 *   `arch-architecture`（缺名字）与 `arch-gantt-x`（非法类型）都返回 `null`，
 *   走条目分支（与「非法 layer 静默忽略」同口径，不新增错误面）。
 * - `name` 是**剩余原串逐字保留**：服务端产物名可含 `.` / `_` / `-`
 *   （`arch.ts:144` 的消毒白名单就是这三类），剥前缀后不许再切分、不许去后缀。
 */
export function parseArchSel(sel: string): { type: ArchType; name: string } | null {
  if (!sel.startsWith(ARCH_SEL_PREFIX)) return null
  const rest = sel.slice(ARCH_SEL_PREFIX.length)
  for (const type of ARCH_TYPES) {
    const head = `${type}-`
    if (rest.startsWith(head) && rest.length > head.length) {
      return { type, name: rest.slice(head.length) }
    }
  }
  return null
}

/**
 * 把架构图挂进已建好的书内目录树（F2）：`item.module` 与某个**目录段名**相等 →
 * 挂该目录；`module` 空 / 未命中 → 回落**书根**（design-v9 E-2）。同节点内
 * `arch` 数组排在 `entries` 之后由渲染层保证（`arch` 是独立数组，天然分组）。
 *
 * 返回**新树**（不动入参）：树由 `buildTree` 每次现建，本函数的不可变性让调用方可以放心
 * 把它 memo 在同一层，也便于 node 直测「同一入参 → 同一形态」。
 * 注意 `module` 是**单段名**（`moduleFromRel` 的压平结果），不做多段路径匹配。
 */
export function mountArch<T>(tree: DirNode<T>, items: readonly ArchNode[]): DirNode<T> {
  const root = cloneNode(tree)
  for (const item of items) {
    const module = item.module
    const target = module === undefined || module === '' ? root : (findDir(root, module) ?? root)
    target.arch.push(item)
  }
  return root
}

function cloneNode<T>(node: DirNode<T>): DirNode<T> {
  return {
    name: node.name,
    key: node.key,
    dirs: node.dirs.map(cloneNode),
    entries: node.entries,
    arch: [...node.arch],
  }
}

/** 前序 DFS 找 `name` 相等的目录段（首个命中；同层目录已按段名排序 ⇒ 结果确定）。 */
function findDir<T>(node: DirNode<T>, name: string): DirNode<T> | undefined {
  for (const child of node.dirs) {
    if (child.name === name) return child
    const found = findDir(child, name)
    if (found !== undefined) return found
  }
  return undefined
}

/** 架构图节点的检索命中：`name` / `type` / `title` 任一 contains（design-v9 §4 的可测判据）。 */
export function archMatches(item: ArchNode, needle: string): boolean {
  const nd = needle.trim().toLowerCase()
  if (nd === '') return true
  return (
    item.name.toLowerCase().includes(nd) ||
    item.type.toLowerCase().includes(nd) ||
    (item.title ?? '').toLowerCase().includes(nd)
  )
}

/**
 * 架构图节点在当前「检索词 + 层 chip」下的可见性（F2）。
 *
 * - 检索：见 {@link archMatches}；
 * - 层：**无 `layer` 恒可见**（design-v9 §4：侧车没记层的图在任意 chip 下都看得到）；
 *   有 `layer` 时 `all` 也可见，否则仅相等可见。
 *
 * ⚠ 层判据**不覆盖书的可见性**：挂在某本书下的图随书走——书被层过滤掉时其图一并不可见
 * （书的可见性优先，故本函数只用于书内的 `archHit` 与「全局图集」组）。
 */
export function archVisible(item: ArchNode, needle: string, layer: string): boolean {
  if (!archMatches(item, needle)) return false
  if (item.layer === undefined || item.layer === '') return true
  return layer === 'all' || item.layer === layer
}
