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

/**
 * 按 `category` 把技能行分组（v8 F7 / 层级稿 §3.5）。
 *
 * 口径（三条都有回归测试）：
 * - **数据源 = 入参行自带的 `category`**（`GET /api/skills` 合并进来的字段，R-v8-5）：
 *   本函数**不做**「列表 + 独立映射表（`/api/skills/categories`）」的二次拼接——
 *   映射里没有的技能就是未分类，不回头查第二张表；
 * - **未分类组置末尾**：它不挡已分类的主内容（组名与 `lamp` 由调用方渲染）；
 * - **排序**：组间按分类名、组内按技能名，都用 `localeCompare`（与技能台账既有的
 *   `rows.sort((a, b) => a.name.localeCompare(b.name))` 同口径）⇒ 结果**与入参顺序无关**，
 *   过滤只改入参、不改排序契约。
 *
 * 边界：**全未分类 ⇒ 单个「未分类」组**（不是空数组、也不是不分组）；无行 ⇒ 空数组
 * （调用方据此走行内空态，不渲染空组头）。
 */
export function groupSkills<T extends { name: string; category?: string }>(
  rows: readonly T[],
): SkillGroup<T>[] {
  const buckets = new Map<string, T[]>()
  for (const row of rows) {
    const category = row.category ?? UNCATEGORIZED
    const bucket = buckets.get(category)
    if (bucket === undefined) buckets.set(category, [row])
    else bucket.push(row)
  }
  const named = [...buckets.keys()]
    .filter((category) => category !== UNCATEGORIZED)
    .sort((a, b) => a.localeCompare(b))
  const order = buckets.has(UNCATEGORIZED) ? [...named, UNCATEGORIZED] : named
  return order.map((category) => ({
    category,
    skills: (buckets.get(category) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
  }))
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
