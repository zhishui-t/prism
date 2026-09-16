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
