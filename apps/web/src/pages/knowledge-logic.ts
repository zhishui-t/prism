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

/** 目录树节点：`name` 是**路径段名**；`key` 是树根到本节点的段路径（折叠态与 React key 的键）。 */
export interface DirNode<T> {
  name: string
  key: string
  dirs: DirNode<T>[]
  entries: T[]
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

  const root: DirNode<T> = { name: '', key: '', dirs: [], entries: [] }
  entries.forEach((entry, i) => {
    const segs = dirs[i] ?? []
    const from = allAnchored ? (anchors[i] ?? -1) + 1 : common.length
    let node = root
    for (const name of segs.slice(from)) {
      let next = node.dirs.find((child) => child.name === name)
      if (next === undefined) {
        next = { name, key: node.key === '' ? name : `${node.key}/${name}`, dirs: [], entries: [] }
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

/** 子树条目总数（目录行右侧的计数；含所有层级）。 */
export function countTree<T>(node: DirNode<T>): number {
  return node.entries.length + node.dirs.reduce((n, child) => n + countTree(child), 0)
}

/**
 * 目录树过滤（单框双语义里的「输入即目录内本地收敛」）：**保留命中条目的祖先目录**
 * （目录行不因未命中而消失，与改造前 `view` 的 `visible` 同口径）；
 * `dirHit` 命中（目录段名含检索词）→ 该节点**整棵子树原样保留**。
 *
 * 返回 `undefined` = 本节点在本轮过滤下整棵不可见。根节点（`name === ''`）不参与 `dirHit`：
 * 否则空检索词会让「整棵保留」这条分支恒真。
 */
export function filterTree<T>(
  node: DirNode<T>,
  hit: (entry: T) => boolean,
  dirHit: (name: string) => boolean,
): DirNode<T> | undefined {
  if (node.name !== '' && dirHit(node.name)) return node
  const dirs: DirNode<T>[] = []
  for (const child of node.dirs) {
    const kept = filterTree(child, hit, dirHit)
    if (kept !== undefined) dirs.push(kept)
  }
  const entries = node.entries.filter(hit)
  if (dirs.length === 0 && entries.length === 0) return undefined
  return { name: node.name, key: node.key, dirs, entries }
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
