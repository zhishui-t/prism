/**
 * 技能页的**纯判据**（可 node 直测，不牵入 React / `api-team.ts`）。
 *
 * 与 `pages/knowledge-logic.ts` / `pages/roles-form-logic.ts` 同路：把组件里「有语义、
 * 易写错、值得锁」的判断抽成纯函数，避免为一条判据去搭整个组件级渲染测试。
 */

/**
 * 未分类组的哨兵键：`category` 缺省（服务端不加键）或为空串的技能都收进它。
 *
 * ⚠ 组头**文案**不在这里——它由调用方按 `skills.uncategorized`（R-v8-6：「未分类」，
 * 与知识页既有的 `knowledge.uncategorized`=「未归类」**刻意不同词**）取字典；
 * 数据层留中文会撞裸 CJK 守卫。
 */
export const UNCATEGORIZED = ''

/** 一个分类组：`category` 是分类名（`''` = 未分类组），`skills` 已按技能名排序。 */
export interface SkillGroup<T> {
  category: string
  skills: T[]
}

/** `groupSkills` 的可选口径。 */
export interface SkillGroupOptions {
  /**
   * `true` = **不渲染空分类组**（组内 0 条连组头一起收起）。只在**过滤视图**下用：
   * 过滤是「把命中行挑出来」，把没命中的空分类组头留在屏上会与「过滤后某组空了，该组连组头
   * 一起消失」的既有口径打架（`skills-groups-dom.test.ts` 锁着）。
   *
   * 缺省 `false` = 空分类**照常成组**（SPEC-4.4「空分类在界面成组」）——这是无过滤时的默认，
   * 也是本函数相对旧版的**行为变更点**。
   */
  hideEmpty?: boolean
}

/**
 * 把技能行分组（v8 F7 / 层级稿 §3.5；v12 F4 / W-6 扩为「行 + 分类清单」）。
 *
 * 口径：
 * - **分类清单（第二参，可选）是权威的组集与组序**：
 *   - 给清单（`categories` 为数组）——**空分类也成组**（组内 0 条、计数 0，SPEC-4.4），
 *     组序**就是清单顺序**（清单由 `GET /api/skills/categories` 的 `categories` 给，
 *     调用方通常已按用户 `localStorage` 组序归一化过，见 `normalizeGroupOrder`）；
 *   - 不给（`undefined`）——旧口径：分类清单由**行自己**推、组间按分类名排序。角色表单的
 *     技能选取器走这一支（它没有分类管理面，也不需要空分类组）。
 * - **游离值归未分类**：给清单时，行的 `category` **不在清单内**（含删除后残留的旧值、
 *   空串 / 缺键）一律进未分类组——与 SPEC-4.3「映射指向不在 categories 里的游离分类 ⇒
 *   读时按未分类呈现」同口径，不凭空补出一个清单里没有的组。
 * - **未分类组置末尾**：它不挡已分类的主内容（组名与 `lamp` 由调用方渲染）；
 * - **组内排序**：按技能名 `localeCompare`（与技能台账既有排序同口径）⇒ 组内结果与入参顺序无关。
 *
 * 边界：给清单但清单为空 ⇒ 所有行都是游离值 ⇒ 单个未分类组；不给清单且全未分类 ⇒
 * 单个未分类组；无行且无清单 ⇒ 空数组（调用方据此走行内空态）。
 */
export function groupSkills<T extends { name: string; category?: string }>(
  rows: readonly T[],
  categories?: readonly string[],
  options: SkillGroupOptions = {},
): SkillGroup<T>[] {
  const buckets = new Map<string, T[]>()
  const push = (category: string, row: T): void => {
    const bucket = buckets.get(category)
    if (bucket === undefined) buckets.set(category, [row])
    else bucket.push(row)
  }
  /** 清单去重 + 去空（服务端 `POST` 已 trim 非空，这里只做防御，不改写值）。 */
  const listed =
    categories === undefined
      ? undefined
      : [...new Set(categories.filter((name) => name !== UNCATEGORIZED && name.trim() !== ''))]
  // 空分类也成组：先把清单里的分类建桶（0 条也占位）。
  if (listed !== undefined) for (const name of listed) buckets.set(name, [])
  const known = new Set(listed ?? [])
  for (const row of rows) {
    const category = row.category ?? UNCATEGORIZED
    // 无清单：行自带分类即一群；有清单：不在清单内的游离值归未分类。
    if (listed === undefined || (category !== UNCATEGORIZED && known.has(category))) push(category, row)
    else push(UNCATEGORIZED, row)
  }
  const named =
    listed ?? [...buckets.keys()].filter((category) => category !== UNCATEGORIZED).sort((a, b) => a.localeCompare(b))
  const order = buckets.has(UNCATEGORIZED) ? [...named, UNCATEGORIZED] : [...named]
  const hideEmpty = options.hideEmpty === true
  return order
    .filter((category) => !(hideEmpty && category !== UNCATEGORIZED && (buckets.get(category)?.length ?? 0) === 0))
    .map((category) => ({
      category,
      skills: (buckets.get(category) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
}

/* ==================== 分类组序（v12 F4 / W-6，SPEC-4.10） ==================== */

/**
 * 组序的 `localStorage` 键。**为什么落 localStorage 而不是存储文件**：冻结契约的
 * `SkillCategoryStore` 没有顺序端点（`addCategory` 只 append、`renameCategory` 原位、
 * `removeCategory` 只移除），SPEC-4.10 授权「localStorage 或存储文件，W-6 落定」——
 * 组序是**视图偏好**，不是分类数据本身，故不新开后端契约。
 *
 * ⚠ 与 `COLLAPSED_STORAGE_KEY`（折叠态）是**同一族视图偏好**的两把键：组序管「组怎么排」、
 * 折叠管「哪些组收起」。两者都只活在 localStorage（都不进服务端契约），也都以**分类名**
 * 为键——故分类改名时要一起迁移（`renameCollapsed` + `Skills.tsx#submitRename`）。
 */
export const GROUP_ORDER_STORAGE_KEY = 'skills-group-order'

/**
 * 把「清单顺序」与「用户存的组序」归并成**生效组序**（纯函数）。
 *
 * 三条口径（对应任务书的两个开放问）：
 * - **新分类缺省排哪**：`saved` 里有、清单里也在的按 `saved` 顺序在前；清单里**新增**的
 *   分类（`saved` 没见过）按**清单原顺序**补在**已命名组的末尾**（即紧挨未分类组之前）——
 *   也就是服务端 `addCategory` append 的位置，不凭空空插。
 * - **删除后残留键自愈**：`saved` 里**已不存在**于清单的名字直接丢弃。调用方据此把归一化结果
 *   写回存储（`Skills.tsx` 的挂载 effect），下一次渲染即无残留。
 * - 未分类哨兵不参与排序（调用方恒把它置末），传进来也会被过滤掉。
 */
export function normalizeGroupOrder(names: readonly string[], saved: readonly string[]): string[] {
  const known = names.filter((name) => name !== UNCATEGORIZED)
  const set = new Set(known)
  const kept: string[] = []
  for (const name of saved) if (set.has(name) && !kept.includes(name)) kept.push(name)
  const seen = new Set(kept)
  return [...kept, ...known.filter((name) => !seen.has(name))]
}

/**
 * 组序里把 `name` 上/下移一格（纯函数，SPEC-4.10 的「组头 ↑↓」）。
 *
 * **越界返回原数组引用**（调用方据此判断「这一下没发生移动」，不白写一次存储）。
 * 只吃**已命名组**的序（未分类不参与）；`names` 里的名字来自 `normalizeGroupOrder`。
 */
export function moveGroup(names: string[], name: string, delta: -1 | 1): string[] {
  const from = names.indexOf(name)
  const to = from + delta
  if (from === -1 || to < 0 || to >= names.length) return names
  const next = [...names]
  next[from] = names[to]!
  next[to] = names[from]!
  return next
}

/* ============ 折叠记忆（v12 F4 / W-7，SPEC-4.8） ============ */

/**
 * 折叠态的 `localStorage` 键（SPEC-4.8 钉死）。存的是**收起集合**的 JSON 数组
 * （缺省 = 空集 = 全展开，与既有「折叠是用户主动的收窄手段，不是默认态」同口径）。
 *
 * 与 `GROUP_ORDER_STORAGE_KEY` 并存：**组序**与**收起集合**是两把独立的视图偏好键，
 * 都以分类名（未分类组 = 哨兵 `''`）为键——分类改名后两把键都需要跟着搬
 * （组序由 `normalizeGroupOrder` 的残留丢弃兜底为「回默认位」，折叠由 `renameCollapsed` 迁移）。
 */
export const COLLAPSED_STORAGE_KEY = 'skills-collapsed'

/**
 * 收起集合的**归一化**（纯函数）：非数组 / 非字符串项一律丢弃 ⇒ 损坏值自愈成空集。
 *
 * 判据与 `Skills.tsx#readGroupOrder` 同款（`Array.isArray` + 逐项 `typeof === 'string'`），
 * 抽出来的理由：折叠记忆的「损坏 JSON / 缺键自愈」是 SPEC-4.8 的验收点，值得 node 直测，
 * 不搭整个组件的渲染测试。空串是**合法**键（未分类组哨兵），故不做去空。
 */
export function normalizeCollapsed(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : []
}

/**
 * 分类改名时**同步迁移折叠键**（SPEC-4.8 配套，W-7 顺手项）。
 *
 * 旧名不在集合里 ⇒ **原样返回同一引用**（调用方据此不白写一次存储）；在 ⇒ 换成新名
 * （集合是 Set，「先删后加」保住单值语义）。改名后旧名对应的收起态若不迁移，就成了
 * 一条永远命不中的残留键（新名的组会突然展开，且残留键直到下次分类被删才被清）。
 */
export function renameCollapsed(
  collapsed: ReadonlySet<string>,
  from: string,
  to: string,
): ReadonlySet<string> {
  if (!collapsed.has(from)) return collapsed
  const next = new Set(collapsed)
  next.delete(from)
  next.add(to)
  return next
}

/* ============ 拖拽归类（v12 F4 / W-7，SPEC-4.6） ============ */

/**
 * 拖拽载荷：被拖技能名 + 它**当前所在的组键**（生效分类名；未分类组 = 哨兵 `''`）。
 *
 * 用「组」而不是行上的原始 `category`：行里的游离值（不在清单内，SPEC-4.3）在界面上就
 * 呈现为未分类，判「同组放回」必须按**看到的组**判——否则从游离值拖到未分类会白发一次写。
 */
export interface SkillDragPayload {
  name: string
  category: string
}

/**
 * drop 目标解析 → `POST /api/skills/categorize` 的调用参数（**纯函数**，SPEC-4.6 的
 * 「drop 目标解析→categorize 调用」可测点）。
 *
 * **清除语义以服务端实现为准**（`SkillCategoryStore.categorize` + `parseCategorizeInput`，
 * `packages/server/src/http/routes/people.ts` 的 `skillCategorize` 同此）：`category`
 * **省略 / `null` / 空串（含纯空白）** 一律 = 清除。故目标为「未分类」时返回**不带
 * `category` 键**的载荷（而不是传 `category: ''`——服务端两档等价，但省略是契约里
 * 写明的表达，也让 mock 断言能一眼看出「这是清除」）。
 */
export function categorizePayload(
  name: string,
  targetCategory: string,
): { names: string[]; category?: string } {
  return targetCategory === UNCATEGORIZED
    ? { names: [name] }
    : { names: [name], category: targetCategory }
}

/**
 * drop 专用：在 `categorizePayload` 之上加「**同组放回不发请求**」的判据（返回 `null`）。
 *
 * 拖拽排序记债不做（design-v12 F4「拖拽排序记债不做」），故把卡片拖回自己的组是空操作——
 * 不该为一次「什么都没变」的落点写一次存储、再拉一次全量刷新。
 */
export function dropCategorizeCall(
  drag: SkillDragPayload,
  targetCategory: string,
): { names: string[]; category?: string } | null {
  if (drag.category === targetCategory) return null
  return categorizePayload(drag.name, targetCategory)
}

/**
 * 分类管理失败码 → 字典键（v12 F4 / W-6）。
 *
 * `api-team.ts#request` 的契约是错误以 `` `${code}: ${message}` `` 抛成 `Error.message`
 * （debts D-1），故按**前缀**分派（同 `externalDeleteErrorKey`）。三个码在**动作**下语义不同，
 * 故带 `action` 参数而不是让调用方自己拼：
 * - `id_conflict`（409）：**新建**重名 → `exists`；**改名**目标重名 → `targetExists`
 *   （「已存在」与「目标名已被占用」对用户是两条不同的出路）；
 * - `not_found`（404）：改名 / 删除的**源**不存在 → `missing`（新建时该码不该出现，返回 null）；
 * - `bad_request`（400）：契约里只有「名字 trim 后为空」这一种 → `empty`。
 *
 * 其余（网络层 TypeError / 5xx / 未列出的码）返回 `null`，调用方原文透出（`common.loadFailed`）——
 * **不猜**服务端文案。返回字典**键**而非成品文案：本函数保持纯（不引 i18n / React），可 node 直测。
 */
export type SkillCategoryAction = 'add' | 'rename' | 'remove'

export type SkillCategoryErrorKey =
  | 'skills.category.err.exists'
  | 'skills.category.err.targetExists'
  | 'skills.category.err.missing'
  | 'skills.category.err.empty'

export function categoryErrorKey(message: string, action: SkillCategoryAction): SkillCategoryErrorKey | null {
  if (message.startsWith('id_conflict')) {
    return action === 'rename' ? 'skills.category.err.targetExists' : 'skills.category.err.exists'
  }
  if (message.startsWith('bad_request')) return 'skills.category.err.empty'
  if (message.startsWith('not_found')) return action === 'add' ? null : 'skills.category.err.missing'
  return null
}

/**
 * 分类色点的**确定性**映射（v12 F4 / W-5：卡片网格的「分类色点」）。
 *
 * 三条口径：
 * 1. **只用既有颜色 token**——取值是 `var(--role-*)` 八个色相（`roles/COLOR_MAP` 的同一批
 *    语义色，两主题各自定义在 `styles.css` 的 `:root` / 浅色块里）。**不新增 hex、不新增变量**；
 *    刻意**不含 `--role-gray`**：灰是「无色」档，留给未分类，而设计明确「无分类不显示色点」；
 * 2. **稳定性**：同一分类名在任何一次渲染 / 任何一次会话里都得到同一个色相——
 *    判据是**名字本身**（`h = h * 31 + 码点` 的滚动散列），不含时间 / 随机 / 行序，
 *    故列表重排、过滤、刷新都不换色。**不按数组下标取色**（那会让色点随行序漂移）；
 * 3. **未分类 ⇒ `undefined`**（调用方据此完全不渲染色点），而不是回落到灰色。
 *
 * 返回 CSS **值**（`var(--role-x)`）而非类名：色相是数据，写法在调用方一致（`style={{background}}`），
 * 与 `Roles.tsx#colorOf` 的既有用法同形。函数保持纯（不引 i18n / React），可 node 直测。
 */
const CATEGORY_COLOR_VARS = [
  'var(--role-red)',
  'var(--role-blue)',
  'var(--role-green)',
  'var(--role-yellow)',
  'var(--role-purple)',
  'var(--role-orange)',
  'var(--role-pink)',
  'var(--role-cyan)',
] as const

export function categoryColor(category?: string): string | undefined {
  const name = (category ?? '').trim()
  if (name === '') return undefined
  let h = 0
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 2147483647
  return CATEGORY_COLOR_VARS[h % CATEGORY_COLOR_VARS.length]
}

/**
 * YAML 块标量头（值写在**后续缩进行**里）：`>`/`|` 家族 + 裁剪指示符（`-`/`+`）+ 缩进数字，
 * 与 `markdown.ts` 的 `BLOCK_SCALAR_HEAD` **同形**（那边是正文折叠用的解析器，本文件只做
 * 「形态识别」，不重新实现读法——服务端给什么就是什么）。
 *
 * 刻意收紧两点，避免误伤正常描述：
 * - 必须是**行首**（`a > b` / `x |- y` 这种正文里的符号不动）；
 * - 指示符之后必须是**空白或串尾**（`>= 1.0` 这类以 `>` 开头的正常值不动）。
 */
const BLOCK_SCALAR_HEAD = /^[>|][+\-\d]*(?=\s|$)/

/**
 * 详情头描述：剥掉 frontmatter 块标量标记（F9-3：技能详情头渲染裸 `>-`）。
 *
 * **为什么在 web 侧修**（用户裁决）：SKILL.md 正文的 frontmatter 块标量由 `markdown.ts`
 * 正确折叠（正文 kv 表正常），但详情头字段走的是 `GET /api/skills/:name` 的
 * `frontmatterDescription()`——**服务端单行解析**只取 `description:` 行冒号后的原文，
 * `description: >-` 于是变成值 `>-`。服务端数据面不在本批改动范围，故渲染前剥掉标记：
 * 剥完为空串的消费口径与「服务端根本没返回描述」**同一档**（调用方走既有空态文案），
 * 不留下一个内容为 `>-` 的伪描述。
 *
 * 取舍：只剥**标记**，不把后续缩进行并回来（那是解析器的事，见 `markdown.ts#readBlockScalar`）；
 * 真值本批一律不猜。`>` / `|` 想当普通值写引号形态即可（与 markdown.ts 同款歧义口径）。
 */
export function cleanSkillDescription(text: string): string {
  return text.trim().replace(BLOCK_SCALAR_HEAD, '').trim()
}

/**
 * 外部技能删除的**失败码 → 字典键**映射（v10 F3ui）。
 *
 * `api-team.ts#request` 的契约是错误以 `` `${code}: ${message}` `` 抛成 `Error.message`
 * （debts D-1），故按**前缀**分派（与 `EffectiveSkills.tsx` 的 `startsWith('not_found')` 同口径）。
 *
 * 这两个码在界面上不是「同一个错误的两种措辞」，而是**出路不同**：
 * - `id_conflict`（409）——落点 SKILL.md 带 Prism 标记 ⇒ 该走「卸载」，文案要指路；
 * - `not_found`（404）——目录不存在 / 没有 SKILL.md ⇒ 这个对象本来就不可删。
 *
 * 其余（`bad_request` 消毒失败 / 网络层 TypeError / 5xx）返回 `null`，由调用方原文透出
 * （`common.loadFailed` 兜底）——**不猜**服务端文案，也不把未知码硬塞进上面两档。
 *
 * 返回字典**键**而非成品文案：本函数保持纯（不引 i18n / React），可 node 直测。
 */
export function externalDeleteErrorKey(
  message: string,
): 'skills.delete.conflict' | 'skills.delete.notFound' | null {
  if (message.startsWith('id_conflict')) return 'skills.delete.conflict'
  if (message.startsWith('not_found')) return 'skills.delete.notFound'
  return null
}

/* ==================== 技能台账（两路合并，F1 起两处共用） ==================== */

/**
 * `GET /api/skills` 的一条（**内置清单**；F7-1 起外部技能不在这一路）。
 *
 * 结构型入参（不 import `api-team.ts` 的 `PrismSkill`）：本模块保持零耦合、可 node 直测，
 * 且调用方传什么形状都能过（服务端不加 `category` 键时就是 `undefined`）。
 */
export interface SkillCatalogInput {
  name: string
  description?: string
  /** 分类映射（缺键 = 未分类） */
  category?: string
}

/** `GET /api/skills/usage` 的一条（外部技能**只**出现在这一路）。 */
export interface SkillUsageInput {
  name: string
  builtin?: boolean
  installed?: boolean
  roles?: string[]
  teams?: string[]
  /** 分类映射（与内置路同源同口径；缺键 = 未分类） */
  category?: string
  /** 外部可删态（v10 F3ui）：`true` 才把详情工具条的「卸载」换成「删除」 */
  external_removable?: boolean
}

/**
 * 技能台账行：内置清单 ∪ 使用情况**按名字合并**的结果。
 *
 * 这是技能页列表与角色表单选取器（F1）**共用的唯一一份**合并实现——此前它内联在
 * `Skills.tsx` 的 `useMemo` 里，选取器若再抄一遍就是第二处镜像（AGENTS.md 的「镜像契约」坑）。
 *
 * 合并口径（逐条照搬原实现，回归由 `skills-logic.test.ts` 锁）：
 * - `name` 是主键，两路都出现时**后者补前者的缺**（不是覆盖）；
 * - `builtin` 取或（两路任一说内置即内置）；
 * - `summary` / `category` **以内置路为准**（`row.category = skill.category` 是赋值；
 *   内置路没写过的才由 usage 路的 `??=` 补——即「内置清单优先，usage 兜底」）；
 * - `installed` / `roles` / `teams` / `externalRemovable` 只来自 usage 路
 *   （缺省 = `false` / `[]` / `[]` / `false`，与「服务端没这条」同档）；
 * - 结果按技能名 `localeCompare` 排序（与技能页列表原有排序同口径）。
 */
export interface SkillCatalogRow {
  name: string
  summary: string
  builtin: boolean
  installed: boolean
  roles: string[]
  teams: string[]
  category?: string
  externalRemovable: boolean
}

export function mergeSkillCatalog(
  builtin: readonly SkillCatalogInput[],
  usage: readonly SkillUsageInput[],
): SkillCatalogRow[] {
  const map = new Map<string, SkillCatalogRow>()
  const ensure = (name: string): SkillCatalogRow => {
    let row = map.get(name)
    if (row === undefined) {
      row = { name, summary: '', builtin: false, installed: false, roles: [], teams: [], externalRemovable: false }
      map.set(name, row)
    }
    return row
  }
  for (const skill of builtin) {
    const row = ensure(skill.name)
    row.builtin = true
    row.summary = skill.description ?? ''
    row.category = skill.category
  }
  for (const item of usage) {
    const row = ensure(item.name)
    row.builtin = row.builtin || item.builtin === true
    row.installed = item.installed === true
    row.roles = item.roles ?? []
    row.teams = item.teams ?? []
    // `??=`（而非 `=`）是**顺序契约**：内置路已写过的分类不被 usage 路覆盖；
    // 两路都没给 ⇒ **值**仍是 `undefined`（= 未分类）——注意 `??=` 会把键落成
    // `undefined` 值（键在、值为空），故消费方一律按**值**读（`?? ''` / `=== undefined`），
    // 不按「键在不在」读。分组哨兵由 `groupSkills` 归一。
    row.category ??= item.category
    // `=== true` 而非真值判断：服务端不下发该键时是 `undefined`，与 `false` 同档（保持走卸载）。
    row.externalRemovable = item.external_removable === true
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}
