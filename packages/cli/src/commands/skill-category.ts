import { PrismError, prismHome } from '@prism/core'
import { SkillCategoryStore, type SkillCategoryData } from '@prism/server'

import type { CommandContext } from '../argv.js'

/**
 * `prism skill category add <名称> | rename <旧名> <新名> | rm <名称>`（v12 F4 / SPEC-4.9 CLI 面）。
 *
 * 三个动作与 HTTP 三条路由（`POST|PATCH|DELETE /api/skills/categories[/:name]`）、
 * MCP `prism_skill_category_add|rename|rm` **同名同位**；实现一律转发 `SkillCategoryStore`
 * （`packages/server/src/roles/skill-categories.ts` 是唯一读写逻辑——此处**不镜像第二份**）。
 *
 * - `add <名称>`：只登记分类名（**不写 mapping**——空分类要存得住）；重名 → `id_conflict`，空名 → `bad_request`。
 * - `rename <旧名> <新名>`：**级联**改 mapping（分类在原位置就地替换以保序）；目标重名 → `id_conflict`，
 *   源不存在 → `not_found`，`旧名 === 新名` 幂等 no-op。
 * - `rm <名称>`：删分类并清掉指向它的 mapping 条目（**组内技能回未分类**）；不存在 → `not_found`。
 *
 * ⚠ 为什么单开一个文件、而不是把动词分派塞进 `commands/skill.ts` 的 switch：`cli-doc-drift.test.ts`
 * 用 `case '([a-z-]+)':` **扫整个 skill.ts 源码**提取子命令集合，嵌套的 `case 'add'|'rename'|'rm'`
 * 会被误当成 `prism skill add|rename|rm` 三个子命令，从而要求文档命令树凭空列出它们。
 * 三个动词**不是** `prism skill` 的子命令，而是 `prism skill category` 的子动词——故分派落在本文件。
 */
export async function skillCategory(ctx: CommandContext, rest: string[]): Promise<number> {
  // 位置参数风格与既有 `prism skill categorize` 一致：过滤掉 `--json` 之类的开关项
  const [verb, ...operands] = rest.filter((n) => !n.startsWith('-'))
  const store = new SkillCategoryStore(ctx.home ?? prismHome())
  const usage = '用法: prism skill category add <名称> | rename <旧名> <新名> | rm <名称> [--json]'

  /** 统一回显：`--json` 走与其它命令同款 envelope（`{ok:true, value:{...双节, file}}`）。 */
  const emit = (data: SkillCategoryData, line: string): number => {
    if (ctx.json) {
      ctx.stdout(JSON.stringify({ ok: true, value: { ...data, file: store.file } }))
    } else {
      ctx.stdout(`${line} → ${store.file}`)
    }
    return 0
  }

  try {
    switch (verb) {
      case 'add': {
        if (operands.length !== 1) {
          ctx.stderr(usage)
          return 1
        }
        const name = operands[0].trim()
        const data = await store.addCategory(name)
        return emit(data, `已新建分类「${name}」（共 ${data.categories.length} 个分类）`)
      }

      case 'rename': {
        if (operands.length !== 2) {
          ctx.stderr(usage)
          return 1
        }
        const from = operands[0].trim()
        const to = operands[1].trim()
        const data = await store.renameCategory(from, to)
        // 改名目标必须是**原本不存在**的分类（重名已被 store 拒），故事后值 === to 的条目
        // 恰好就是本次级联过来的那些——不必额外预读一次磁盘。
        const cascaded = Object.values(data.mapping).filter((value) => value === to).length
        return emit(data, `已改名「${from}」→「${to}」（${cascaded} 个技能跟到新名）`)
      }

      case 'rm': {
        if (operands.length !== 1) {
          ctx.stderr(usage)
          return 1
        }
        const name = operands[0].trim()
        const data = await store.removeCategory(name)
        return emit(data, `已删除分类「${name}」（组内技能回未分类）`)
      }

      default:
        ctx.stderr(`未知子命令: skill category ${verb ?? ''}\n${usage}`)
        return 1
    }
  } catch (error) {
    const code = error instanceof PrismError ? error.code : 'bad_request'
    ctx.stderr(`错误 [${code}] ${error instanceof Error ? error.message : String(error)}`)
    ctx.stderr(usage)
    return 1
  }
}
