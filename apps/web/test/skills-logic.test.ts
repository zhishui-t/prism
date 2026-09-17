/**
 * F7 分组的**纯判据**（design-v8 §3 F7 / 层级稿 §3.5）+ F9-3 详情头描述的块标量剥离：
 * node 直测，不牵 React、不牵 `api-team.ts`。
 *
 * 锁四件事（都是「易写错、值得锁」的语义，不是像素）：
 *  1. 按 `category` 分桶——组名 = 分类名**原文**（不翻译、不改写）；
 *  2. **未分类**：`category` 缺省（服务端不加键）与空串（清除后的等价形态）等价，收进同一组；
 *  3. **排序**：组间按分类名、组内按技能名（`localeCompare`），且**与入参顺序无关**；
 *  4. **边界**：全未分类 ⇒ 单个未分类组；无技能 ⇒ 空数组（调用方据此走行内空态）。
 *
 * 另有两条回归红线：
 * - 未分类组**恒在末尾**（分类名无论字典序大小都不越位）；
 * - 纯函数**不就地重排入参**（调用方那张已过滤的数组仍归调用方）。
 *
 * v10 F3ui 追加：`externalDeleteErrorKey`（外部删除失败码 → 字典键）的纯判据，见文件末尾。
 *
 * 环境：默认 node（不写环境 pragma，同 `knowledge-logic.test.ts` 的既有做法）。
 */

import { describe, expect, it } from 'vitest'

import { UNCATEGORIZED, cleanSkillDescription, externalDeleteErrorKey, groupSkills } from '../src/pages/skills-logic.ts'

/** 判据只要求 `name` + 可选 `category`（不依赖技能台账的其它字段）。 */
type Row = { name: string; category?: string }
/** 服务端「映射里没有该技能」的形态：**不加 `category` 键**。 */
const plain = (name: string): Row => ({ name })
const inCat = (name: string, category: string): Row => ({ name, category })

const names = (rows: readonly Row[]): string[] => rows.map((r) => r.name)

describe('F7 分组：按 category 分桶', () => {
  it('同名分类合成一组，组名即分类名原文（不翻译、不改写）', () => {
    const groups = groupSkills([inCat('b', 'ui'), inCat('a', 'ui'), inCat('c', 'docs')])
    expect(groups.map((g) => g.category)).toEqual(['docs', 'ui'])
    expect(groups.map((g) => names(g.skills))).toEqual([['c'], ['a', 'b']])
  })

  it('组间按分类名排序（localeCompare），与入参顺序无关', () => {
    const forward = groupSkills([inCat('a', 'zeta'), inCat('b', 'alpha')])
    const backward = groupSkills([inCat('b', 'alpha'), inCat('a', 'zeta')])
    expect(forward.map((g) => g.category)).toEqual(['alpha', 'zeta'])
    expect(backward.map((g) => g.category)).toEqual(['alpha', 'zeta'])
  })

  it('组内按技能名排序（与技能台账既有的 `.sort(localeCompare)` 同口径），与入参顺序无关', () => {
    const groups = groupSkills([inCat('zeta', 'ui'), inCat('alpha', 'ui')])
    expect(names(groups[0]!.skills)).toEqual(['alpha', 'zeta'])
  })

  it('纯函数：不就地重排入参（调用方的数组仍归调用方）', () => {
    const rows = [inCat('z', 'ui'), inCat('a', 'ui')]
    groupSkills(rows)
    expect(names(rows)).toEqual(['z', 'a'])
  })
})

describe('F7 未分类：缺键 / 空串等价，且恒在末尾', () => {
  it('`category` 缺省（不加键）与空串（清除后的等价形态）收进同一组', () => {
    const groups = groupSkills([plain('b'), inCat('a', ''), inCat('c', 'docs')])
    expect(groups.map((g) => g.category)).toEqual(['docs', UNCATEGORIZED])
    expect(names(groups[1]!.skills)).toEqual(['a', 'b'])
  })

  it('未分类组**恒在最后**（分类名字典序再大也不越位）', () => {
    const groups = groupSkills([plain('x'), inCat('y', 'zzz'), inCat('z', 'aaa')])
    expect(groups.map((g) => g.category)).toEqual(['aaa', 'zzz', UNCATEGORIZED])
  })

  it('没有未分类技能时**不产生**未分类组（不画空组头）', () => {
    expect(groupSkills([inCat('a', 'ui')]).map((g) => g.category)).toEqual(['ui'])
  })
})

describe('F7 边界', () => {
  it('全未分类 ⇒ 单个「未分类」组（不是空数组、也不是不分组）', () => {
    const groups = groupSkills([plain('b'), plain('a'), inCat('c', '')])
    expect(groups.length).toBe(1)
    expect(groups[0]!.category).toBe(UNCATEGORIZED)
    expect(names(groups[0]!.skills)).toEqual(['a', 'b', 'c'])
  })

  it('无技能 ⇒ 空数组（调用方据此走行内空态）', () => {
    expect(groupSkills([])).toEqual([])
  })
})

/**
 * F9-3：详情头描述渲染前剥 YAML 块标量标记（`GET /api/skills/:name` 的
 * `frontmatterDescription()` 是**单行**解析，`description: >-` 会把 `>-` 当值，
 * 详情头于是渲染一个裸 `>-`）。判据的边界就是这两条：**该剥的剥干净**、**不该剥的一个不动**。
 */
describe('F9-3 详情头描述：剥 frontmatter 块标量标记', () => {
  it('块标量家族一律剥成空串（`>`/`|` + 裁剪符 + 缩进数字）', () => {
    for (const marker of ['>-', '|-', '|', '>', '>+', '|+', '>-2', '>2-', '|-2', '>+2']) {
      expect(cleanSkillDescription(marker), marker).toBe('')
    }
  })

  it('首尾空白一并吃掉（服务端 trim 过的形态与没 trim 过的等价）', () => {
    expect(cleanSkillDescription('  >-  ')).toBe('')
    expect(cleanSkillDescription('一句话描述。 ')).toBe('一句话描述。')
  })

  it('标记后另起内容时只剥标记，正文保留（不猜后续缩进行）', () => {
    expect(cleanSkillDescription('> 折叠后的说明')).toBe('折叠后的说明')
    expect(cleanSkillDescription('| 逐行说明')).toBe('逐行说明')
  })

  it('普通描述**一个字符不动**（恒等变换）', () => {
    const plain = '使用 Prism 平台能力时触发：检索/沉淀知识（kb）、查询知识图谱（graph）。'
    expect(cleanSkillDescription(plain)).toBe(plain)
  })

  it('不含块标量头形态的 `>`/`-`/`|` 文本不误伤（符号在中段、或指示符后紧跟非空白）', () => {
    const cases = [
      'a > b：大于号的说明',
      '箭头 -> 指向下游',
      '>= 1.0 版本起支持',
      '前置条件 | 后置条件',
      '说明：键形如 `description:`',
    ]
    for (const text of cases) expect(cleanSkillDescription(text), text).toBe(text)
  })

  it('空串进 ⇒ 空串出（消费方据此走既有空态文案，与「服务端没给描述」同一档）', () => {
    expect(cleanSkillDescription('')).toBe('')
    expect(cleanSkillDescription('   ')).toBe('')
  })
})

/**
 * v10 F3ui：外部技能删除的**失败码 → 字典键**映射。
 *
 * `api-team.ts#request` 的契约是错误以 `` `${code}: ${message}` `` 抛成 `Error.message`
 * （debts D-1），故按**前缀**分派。这里锁三条：
 *  - 两个已知码各归各档（`id_conflict` / `not_found`）；
 *  - **前缀**匹配而非全等（真正的 message 里 `${code}` 后面跟着 `: 说明`）；
 *  - 其余码一律 `null`（调用方原文透出），不被硬塞进上面两档。
 */
describe('v10 F3ui 外部删除失败码 → 字典键', () => {
  it('`id_conflict` 前缀 → 走 `skills.delete.conflict`（409：落点带 Prism 标记，该改用卸载）', () => {
    expect(externalDeleteErrorKey('id_conflict: skill already exists with prism marker')).toBe(
      'skills.delete.conflict',
    )
    expect(externalDeleteErrorKey('id_conflict')).toBe('skills.delete.conflict')
  })

  it('`not_found` 前缀 → 走 `skills.delete.notFound`（404：目录不存在 / 没有 SKILL.md）', () => {
    expect(externalDeleteErrorKey('not_found: no SKILL.md at target')).toBe('skills.delete.notFound')
  })

  it('未知码 / 网络层错误 → `null`（原文透出，不猜服务端文案）', () => {
    for (const msg of [
      'bad_request: invalid name',
      'internal: boom',
      'Failed to fetch',
      '',
    ]) {
      expect(externalDeleteErrorKey(msg), msg).toBeNull()
    }
  })

  it('**前缀**匹配：码作为子串出现在别处不算命中（码必须打头）', () => {
    expect(externalDeleteErrorKey('error: id_conflict happened')).toBeNull()
  })
})
