import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { PrismError, SingleWriterQueue } from '@prism/core'

/**
 * 技能分类映射：`<PRISM_HOME>/skill-categories.json` —— `{ "<技能名>": "<分类>" }`。
 *
 * design-v8 §3（F7）：
 * - 这是 **Prism 侧独立映射**，不碰宿主技能文件，也**不校验技能是否存在**
 *   （映射独立于技能台账；R3 不做审核——分类判断归宿主）；
 * - 写入**沿用 `ProjectRegistry` 既有范式**（`graph/registry.ts`）：tmp 文件 + rename 原子替换、
 *   进程内 `SingleWriterQueue` 串行、**每次访问重读磁盘**（跨进程后写胜出）、坏文件按空表降级；
 * - `names` 必须非空（空 → `bad_request`）；`category` 省略或空串同义 = **清除**该技能的分类。
 *
 * 三方（HTTP `/api/skills/categorize`、MCP `prism_skill_categorize`、CLI `prism skill categorize`）
 * **共用本实现**——不镜像第二份读写逻辑（仓库红线「镜像契约」）。
 */
export type SkillCategoryMap = Record<string, string>

/** `category` 是**归一化后**的生效值；`updated` / `cleared` 描述**写入后的结果状态**（幂等）。 */
export interface SkillCategorizeResult {
  /** 归一化后的分类（清除时为 undefined；`null` 是 JSON 形态）。 */
  category: string | null
  /** 写入后**带有**该分类的技能名（category 非空时 = 本次 names；否则为空）。 */
  updated: string[]
  /** 写入后**不带**任何分类的技能名（清除时 = 本次 names）。 */
  cleared: string[]
  /** 写入后的全量映射表（回显用，前端/宿主要分组计数不必再读一次）。 */
  categories: SkillCategoryMap
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

  /** 全量映射表（文件缺失/损坏 → 空表，不抛）。 */
  async all(): Promise<SkillCategoryMap> {
    return await this.#read()
  }

  /**
   * 写入 / 清除分类（原子写；同名并发为「后写胜出」）。
   * - `names` 非空（空 → `bad_request`）；重复名去重；
   * - `category` 省略 / `null` / 空串（含纯空白）→ 清除；
   * - 只动本次点名的键，其余条目原样保留。
   */
  async categorize(names: string[], category?: string | null): Promise<SkillCategorizeResult> {
    const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))]
    if (clean.length === 0) {
      throw new PrismError('bad_request', 'names 不能为空（至少一个技能名）')
    }
    const value = typeof category === 'string' ? category.trim() : ''
    await this.#writeQueue.run(async () => {
      const data = await this.#read()
      for (const name of clean) {
        if (value === '') {
          delete data[name]
        } else {
          data[name] = value
        }
      }
      await this.#save(data)
    })
    return {
      category: value === '' ? null : value,
      updated: value === '' ? [] : clean,
      cleared: value === '' ? clean : [],
      categories: await this.#read(),
    }
  }

  /** 从磁盘读取（文件缺失/损坏/结构不可识别 → 空表，不抛）。 */
  async #read(): Promise<SkillCategoryMap> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.#file, 'utf-8'))
    } catch {
      return {}
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const out: SkillCategoryMap = {}
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 值非字符串 / 空串视为无分类：不静默塞进表里（R7 精神——表里只有真分类）
      if (typeof value === 'string' && value !== '') {
        out[name] = value
      }
    }
    return out
  }

  /** 原子写：tmp + rename（Windows 上 rename 覆盖已有文件；瞬时锁重试）。 */
  async #save(data: SkillCategoryMap): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.${process.pid}.tmp`
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
    throw lastError
  }
}

/**
 * `{ names, category }` 入参归一化（HTTP body / MCP args 共用；CLI 走位置参数不经此）。
 *
 * 三入口同口径由本函数 + `SkillCategoryStore.categorize` 单点保证：
 * - `names` 必须是字符串数组且非空（trim 后），否则 `bad_request`；
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
  const names = raw.filter((n): n is string => typeof n === 'string').map((n) => n.trim()).filter((n) => n !== '')
  if (names.length === 0) {
    throw new PrismError('bad_request', 'names 不能为空（至少一个技能名）')
  }
  if (input.category !== undefined && input.category !== null && typeof input.category !== 'string') {
    throw new PrismError('bad_request', 'category 必须是字符串（省略或空串 = 清除分类）')
  }
  const category = typeof input.category === 'string' ? input.category : undefined
  return category === undefined ? { names } : { names, category }
}
