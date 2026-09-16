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
