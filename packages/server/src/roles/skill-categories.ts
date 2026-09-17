import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PrismError, SingleWriterQueue } from '@prism/core'

/**
 * 技能分类存储：`<PRISM_HOME>/skill-categories.json` —— **双节形态**
 * `{ "categories": string[], "mapping": { "<技能名>": "<分类>" } }`。
 *
 * v12 F4（SPEC-4.3 / design-v12 F4「存储扩展」）——从**旧裸映射**
 * `{ "<技能名>": "<分类>" }` 迁移而来：
 *
 * - **判别式**：解析结果是普通对象、且 `categories` 是数组、且 `mapping` 是普通对象 → 新形态；
 *   否则按旧裸映射读（半写新形态——只有 `categories` 无 `mapping`、或 `mapping` 非普通对象
 *   ——由此**自然降级**到旧路径）。`categories: []`（mapping 同空或含游离分类）**仍按新形态
 *   识别，绝不回落裸读**；旧文件里技能恰好叫 `categories`/`mapping` 不会误判（旧语义下其值是
 *   字符串，不满足数组/对象判据）。
 * - **旧形态读时升级**：`categories` = `mapping` 值去重（按首次出现序），语义等价；
 *   **写时不回退**——一旦写盘即新形态。
 * - **游离分类**（新形态 `mapping` 值 ∉ `categories`）：读时该技能按未分类呈现（读出的
 *   `mapping` 不含该条目），下次写时修复文件（剔除游离条目）；**不把游离分类悄悄加回
 *   `categories`**。
 * - **不变式**：任何写盘后 `mapping` 的值 ⊆ `categories`。`categorize` 设置分类时若目标分类
 *   未登记则**自动登记**（追加末尾）——旧入口传任意字符串仍可用；清除某技能分类**不**从
 *   `categories` 删除该分类（空分类要存得住）。
 * - **读出口径 = 写盘口径**（往返稳定）：技能名原样保留；分类名与分类值一律 trim、空串丢弃
 *   （写路径本就 trim，故手改文件里的空白不会造成「读了再写就变样」）。
 *
 * 并发与原子性（design-v12「F4 并发口径」复核 N-8）：写入**沿用 `ProjectRegistry` 既有范式**
 * （`graph/registry.ts`）：tmp 文件 + rename 原子替换、进程内 `SingleWriterQueue` 串行、
 * **每次访问重读磁盘**（跨进程后写胜出）、坏文件按**空新形态**降级不抛。并发 categorize 经
 * 队列串行化，后写胜出，无需额外锁。
 *
 * 三方（HTTP `/api/skills/categorize`、MCP `prism_skill_categorize`、CLI `prism skill categorize`）
 * **共用本实现**——不镜像第二份读写逻辑（仓库红线「镜像契约」）。
 */
export type SkillCategoryMap = Record<string, string>

/** 磁盘双节形态（读接口一律返回本形——已归一化：分类保序、映射值 ⊆ 分类）。 */
export interface SkillCategoryData {
  /** 分类名清单（**保序**，界面分组顺序即此序）。 */
  categories: string[]
  /** 技能名 → 分类（只含值在 `categories` 内的条目）。 */
  mapping: SkillCategoryMap
}

/** `category` 是**归一化后**的生效值；`updated` / `cleared` 描述**写入后的结果状态**（幂等）。 */
export interface SkillCategorizeResult {
  /** 归一化后的分类（清除时为 undefined；`null` 是 JSON 形态）。 */
  category: string | null
  /** 写入后**带有**该分类的技能名（category 非空时 = 本次 names；否则为空）。 */
  updated: string[]
  /** 写入后**不带**任何分类的技能名（清除时 = 本次 names）。 */
  cleared: string[]
  /** 写入后的**分类名清单**（v12 迁移：原为裸映射；回显用）。 */
  categories: string[]
  /** 写入后的全量映射表（回显用，前端/宿主要分组计数不必再读一次）。 */
  mapping: SkillCategoryMap
}

/** 空 mapping：**null 原型**——`__proto__` 作技能名时赋值是普通属性写入（不是原型 setter），
 * 否则该键静默不可表达（n-2）。`JSON.stringify` / 读回语义不变。 */
const emptyMapping = (): SkillCategoryMap => Object.create(null) as SkillCategoryMap

/** 空的**全新**数据（返回给调用方后可能被改动，绝不共享模块级常量里的对象）。 */
const emptyData = (): SkillCategoryData => ({ categories: [], mapping: emptyMapping() })

/** 普通对象判定（排除数组 / null）——判别式与逐项解析共用。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 分类名归一化：trim → 去空 → 去重（保首次出现序）。 */
function normalizeCategories(raw: unknown[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

/** 分类值归一化：非字符串 / 空串 / 纯空白 → `null`（= 无分类，不塞进表里）。 */
function normalizeValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export class SkillCategoryStore {
  readonly #file: string
  readonly #writeQueue = new SingleWriterQueue()

  constructor(home: string) {
    this.#file = join(home, 'skill-categories.json')
  }

  /** 映射文件绝对路径（报错信息 / 回显用；不含读写副作用）。 */
  get file(): string {
    return this.#file
  }

  /** 全量数据（双节新形态；文件缺失/损坏/结构不可识别 → 空新形态，不抛）。 */
  async all(): Promise<SkillCategoryData> {
    return await this.#read()
  }

  /** `all()` 的别名（同一实现，供「列清单」语义的调用方按名取用）。 */
  async list(): Promise<SkillCategoryData> {
    return await this.#read()
  }

  /**
   * 写入 / 清除分类（原子写；同名并发为「后写胜出」）。
   * - `names` 非空（空 → `bad_request`）；重复名去重；
   * - `category` 省略 / `null` / 空串（含纯空白）→ 清除；
   * - 设置分类时若目标分类未登记 → **自动登记**（追加末尾）；
   * - 清除时**不**从 `categories` 删除该分类；
   * - 只动本次点名的键，其余条目原样保留。
   */
  async categorize(names: string[], category?: string | null): Promise<SkillCategorizeResult> {
    const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))]
    if (clean.length === 0) {
      throw new PrismError('bad_request', 'names 不能为空（至少一个技能名）')
    }
    const value = typeof category === 'string' ? category.trim() : ''
    let after = emptyData()
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      after = data
      if (value === '') {
        for (const name of clean) {
          delete data.mapping[name]
        }
      } else {
        if (!data.categories.includes(value)) data.categories.push(value)
        for (const name of clean) {
          data.mapping[name] = value
        }
      }
      await this.#save(data)
    })
    return {
      category: value === '' ? null : value,
      updated: value === '' ? [] : clean,
      cleared: value === '' ? clean : [],
      categories: after.categories,
      mapping: after.mapping,
    }
  }

  /**
   * 新建分类（写 `categories` **不写** `mapping`——空分类要存得住）。
   * - `name` trim 后为空 → `bad_request`；
   * - 重名 → `id_conflict`（HTTP 409）。
   */
  async addCategory(name: string): Promise<SkillCategoryData> {
    const clean = typeof name === 'string' ? name.trim() : ''
    if (clean === '') {
      throw new PrismError('bad_request', '分类名不能为空')
    }
    let after = emptyData()
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      after = data
      if (data.categories.includes(clean)) {
        throw new PrismError('id_conflict', `分类已存在：${clean}`)
      }
      data.categories.push(clean)
      await this.#save(data)
    })
    return after
  }

  /**
   * 分类改名（**级联改 `mapping`**，分类在原位置就地替换以保序）。
   * - `from` / `to` trim 后为空 → `bad_request`；
   * - `from` 不在 `categories` → `not_found`；
   * - `to` 与现存的**另一个**分类重名 → `id_conflict`（HTTP 409）；
   * - `from === to`（trim 后）→ 幂等 no-op（不算重名冲突）。
   */
  async renameCategory(from: string, to: string): Promise<SkillCategoryData> {
    const src = typeof from === 'string' ? from.trim() : ''
    const dst = typeof to === 'string' ? to.trim() : ''
    if (src === '' || dst === '') {
      throw new PrismError('bad_request', '分类名不能为空')
    }
    let after = emptyData()
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      after = data
      const index = data.categories.indexOf(src)
      if (index === -1) {
        throw new PrismError('not_found', `分类不存在：${src}`)
      }
      if (src === dst) return // 幂等 no-op：名称没变，不写盘
      if (data.categories.includes(dst)) {
        throw new PrismError('id_conflict', `分类已存在：${dst}`)
      }
      data.categories[index] = dst
      for (const [skill, value] of Object.entries(data.mapping)) {
        if (value === src) data.mapping[skill] = dst
      }
      await this.#save(data)
    })
    return after
  }

  /**
   * 删除分类：从 `categories` 移除，并清掉指向它的 `mapping` 条目（**组内技能回未分类**）。
   * - `name` trim 后为空 → `bad_request`；不存在 → `not_found`。
   */
  async removeCategory(name: string): Promise<SkillCategoryData> {
    const clean = typeof name === 'string' ? name.trim() : ''
    if (clean === '') {
      throw new PrismError('bad_request', '分类名不能为空')
    }
    let after = emptyData()
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      after = data
      const index = data.categories.indexOf(clean)
      if (index === -1) {
        throw new PrismError('not_found', `分类不存在：${clean}`)
      }
      data.categories.splice(index, 1)
      for (const [skill, value] of Object.entries(data.mapping)) {
        if (value === clean) delete data.mapping[skill]
      }
      await this.#save(data)
    })
    return after
  }

  /**
   * 从磁盘读取（文件缺失/损坏/结构不可识别 → 空新形态，不抛）。
   *
   * 判别式：普通对象 ∧ `categories` 是数组 ∧ `mapping` 是普通对象 → 新形态；否则旧裸映射。
   * 两种形态都做同一套归一化（**读出口径 = 写盘口径**，故往返稳定）：技能名原样保留，
   * 分类名与分类值一律 trim、空串丢弃；新形态下值还必须命中 `categories`——游离分类按
   * 未分类呈现，不静默塞进表里（R7 精神——表里只有真分类）。
   */
  async #read(): Promise<SkillCategoryData> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.#file, 'utf-8'))
    } catch {
      return emptyData()
    }
    if (!isPlainObject(parsed)) {
      return emptyData()
    }

    if (Array.isArray(parsed.categories) && isPlainObject(parsed.mapping)) {
      // —— 新形态 ——
      const categories = normalizeCategories(parsed.categories)
      const known = new Set(categories)
      const mapping = emptyMapping()
      for (const [name, value] of Object.entries(parsed.mapping)) {
        // 值非字符串/空串 → 无分类；游离分类（∉ categories）→ 按未分类呈现
        const category = normalizeValue(value)
        if (category !== null && known.has(category)) {
          mapping[name] = category
        }
      }
      return { categories, mapping }
    }

    // —— 旧裸映射（含半写新形态的降级路径）——
    const mapping = emptyMapping()
    for (const [name, value] of Object.entries(parsed)) {
      const category = normalizeValue(value)
      if (category !== null) {
        mapping[name] = category
      }
    }
    // 读时升级：categories = mapping 值去重（按首次出现序）
    const categories: string[] = []
    for (const value of Object.values(mapping)) {
      if (!categories.includes(value)) categories.push(value)
    }
    return { categories, mapping }
  }

  /**
   * 原子写：tmp + rename（Windows 上 rename 覆盖已有文件；瞬时锁重试）。
   *
   * b-6 加固：tmp 名带**随机短后缀**（同一进程内并发/重入也不会撞名）；三次 rename
   * 全败抛出前 best-effort `unlink` 掉 tmp（失败吞掉）——不给磁盘留 `.tmp` 残渣。
   */
  async #save(data: SkillCategoryData): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(tmp, this.#file)
        return
      } catch (error) {
        lastError = error
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
      }
    }
    await unlink(tmp).catch(() => {})
    throw lastError
  }
}

/**
 * `{ names, category }` 入参归一化（HTTP body / MCP args 共用；CLI 走位置参数不经此）。
 *
 * 三入口同口径由本函数 + `SkillCategoryStore.categorize` 单点保证：
 * - `names` 必须是**纯**字符串数组且非空（trim 后），否则 `bad_request`——数组里混入
 *   非字符串项同样 `bad_request`（n-1：不静默过滤，与 category 侧的严格度取齐）；
 * - `category` 允许 `undefined` / `null` / 字符串；空串（含纯空白）= 清除；
 *   其它类型（数字/布尔/对象）→ `bad_request`（不静默当清除）。
 */
export function parseCategorizeInput(input: {
  names?: unknown
  category?: unknown
}): { names: string[]; category?: string } {
  const raw = input.names
  if (!Array.isArray(raw)) {
    throw new PrismError('bad_request', 'names 必须是字符串数组')
  }
  if (raw.some((item) => typeof item !== 'string')) {
    throw new PrismError('bad_request', 'names 必须是字符串数组（含非字符串项）')
  }
  const names = raw.map((n) => n.trim()).filter((n) => n !== '')
  if (names.length === 0) {
    throw new PrismError('bad_request', 'names 不能为空（至少一个技能名）')
  }
  if (input.category !== undefined && input.category !== null && typeof input.category !== 'string') {
    throw new PrismError('bad_request', 'category 必须是字符串（省略或空串 = 清除分类）')
  }
  const category = typeof input.category === 'string' ? input.category : undefined
  return category === undefined ? { names } : { names, category }
}
