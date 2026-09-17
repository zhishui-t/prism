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
 * v12 F4（W-5）追加：`categoryColor`（分类色点：分类名 → 既有 `--role-*` token）的纯判据——
 * 确定性（同名恒同色）、只用既有变量（不含 hex）、未分类不出色点。
 *
 * v12 F4（W-7）追加：拖拽归类的 `categorizePayload` / `dropCategorizeCall`（drop 目标 → 调用
 * 参数，含「未分类 = 省略 `category`」的清除语义与「同组放回 = null」），以及折叠记忆的
 * `normalizeCollapsed`（损坏自愈）/ `renameCollapsed`（改名迁移）。
 *
 * 环境：默认 node（不写环境 pragma，同 `knowledge-logic.test.ts` 的既有做法）。
 */

import { describe, expect, it } from 'vitest'

import { UNCATEGORIZED, categoryColor, categoryErrorKey, categorizePayload, cleanSkillDescription, COLLAPSED_STORAGE_KEY, dropCategorizeCall, externalDeleteErrorKey, groupSkills, mergeSkillCatalog, moveGroup, normalizeCollapsed, normalizeGroupOrder, renameCollapsed } from '../src/pages/skills-logic.ts'

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

/**
 * F1（v11）：技能台账的两路合并（`/api/skills` 内置清单 ∪ `/api/skills/usage` 使用情况）。
 *
 * 这段逻辑原本内联在 `Skills.tsx` 的 `useMemo` 里、只由技能页的 DOM 测试间接覆盖；
 * F1 起**角色表单的技能选取器也吃它**（同一份实现），故在本文件里直接钉住逐字段来源。
 */
describe('F1 技能台账合并：内置清单 ∪ 使用情况', () => {
  it('同名条目合并：内置路给来源/描述/分类，usage 路给宿主态与引用方', () => {
    const rows = mergeSkillCatalog(
      [{ name: 'tech-doc', description: '写文档', category: 'docs' }],
      [{ name: 'tech-doc', builtin: true, installed: true, roles: ['dev-1'], teams: ['core'] }],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      name: 'tech-doc',
      summary: '写文档',
      builtin: true,
      installed: true,
      roles: ['dev-1'],
      teams: ['core'],
      category: 'docs',
      externalRemovable: false,
    })
  })

  it('外部技能（只出现在 usage 路）恒成立：无描述、非内置，分类只可能来自该路', () => {
    const rows = mergeSkillCatalog([], [{ name: 'mine', installed: true, category: 'ui' }])
    expect(rows[0]).toMatchObject({ name: 'mine', summary: '', builtin: false, installed: true, category: 'ui' })
  })

  it('顺序契约：内置路写过的 `category` **不被** usage 路覆盖（`??=` 而非 `=`）', () => {
    const rows = mergeSkillCatalog(
      [{ name: 'a', description: '', category: 'docs' }],
      [{ name: 'a', category: 'ui' }],
    )
    expect(rows[0]!.category).toBe('docs')
  })

  it('`builtin` 取或、`installed` / `roles` / `teams` / `externalRemovable` 缺键即缺省', () => {
    const rows = mergeSkillCatalog([], [{ name: 'a', installed: true }])
    expect(rows[0]).toMatchObject({ builtin: false, installed: true, roles: [], teams: [], externalRemovable: false })
    // 两路都没给分类 ⇒ **值**是 undefined（= 未分类）。
    // ⚠ 不按键是否存在断言：`??=` 会把键落成 `undefined` 值（键在、值为空），
    // 消费方（`groupSkills` / 选取器）一律按值读——这正是它必须按值读的原因。
    expect(rows[0]!.category).toBeUndefined()
  })

  it('`external_removable` 只认 `=== true`（服务端不给键时与 `false` 同档：仍走卸载）', () => {
    const rows = mergeSkillCatalog([], [{ name: 'a' }, { name: 'b', external_removable: true }])
    expect(rows.find((r) => r.name === 'a')!.externalRemovable).toBe(false)
    expect(rows.find((r) => r.name === 'b')!.externalRemovable).toBe(true)
  })

  it('结果按技能名排序（与技能页列表原有排序同口径），且未分类可由 groupSkills 归一', () => {
    const rows = mergeSkillCatalog([{ name: 'zeta' }, { name: 'alpha' }], [])
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zeta'])
    expect(groupSkills(rows)[0]!.category).toBe(UNCATEGORIZED)
  })
})

describe('v12 F4（W-5）分类色点：分类名 → 既有颜色 token', () => {
  it('确定性：同名恒同色（含调用顺序 / 大小写之外的输入差异都不影响）', () => {
    expect(categoryColor('ui')).toBe(categoryColor('ui'))
    // 判据只吃名字本身 ⇒ 同一分类无论何时求值都同色（列表重排 / 过滤 / 刷新都不换色）
    expect(categoryColor('ui')).not.toBeUndefined()
    expect(categoryColor('docs')).not.toBeUndefined()
  })

  it('取值只落在既有 `--role-*` 颜色变量上（不新增 hex / 变量）', () => {
    const seen = new Set<string>()
    for (const name of ['ui', 'docs', 'backend', 'data', 'ops', 'x', '分类甲', 'a-b_c']) {
      const c = categoryColor(name)!
      expect(c, name).toMatch(/^var\(--role-(red|blue|green|yellow|purple|orange|pink|cyan)\)$/)
      seen.add(c)
    }
    // 不是「永远返回同一个」的退化解——名字变了色相会变（多样性的存在性证明）
    expect(seen.size).toBeGreaterThan(1)
    // 灰是「无色」档：留给未分类，故不进候选集
    expect(categoryColor('ui')).not.toContain('gray')
  })

  it('未分类（缺省 / 空串 / 纯空白）⇒ `undefined`（调用方据此完全不渲染色点）', () => {
    expect(categoryColor()).toBeUndefined()
    expect(categoryColor(undefined)).toBeUndefined()
    expect(categoryColor('')).toBeUndefined()
    expect(categoryColor('   ')).toBeUndefined()
    // 空白只影响判空，不参与取色：`' ui '` 与 `'ui'` 同色（trim 后同一个名字）
    expect(categoryColor(' ui ')).toBe(categoryColor('ui'))
  })
})

/**
 * v12 F4（W-6）：分组入参扩为「行 + 分类清单」。
 *
 * 行为变更点只有一个，但它正是 SPEC-4.4 的落点：**清单里的空分类也成组**（旧版由行推组，
 * 空分类渲染不出来）。其余三条是与之配套的边界：清单顺序即组序、游离值归未分类、
 * 未分类仍恒末。
 */
describe('v12 F4（W-6）分组：行 + 分类清单', () => {
  it('空分类也成组（组内 0 条），且组头计数为 0（SPEC-4.4）', () => {
    const groups = groupSkills([inCat('a', 'ui')], ['ui', 'empty'])
    expect(groups.map((g) => g.category)).toEqual(['ui', 'empty'])
    expect(groups[1]!.skills).toEqual([])
    expect(groups[1]!.skills.length).toBe(0)
  })

  it('组序 = **清单顺序**（不再按分类名排序：清单里 zeta 在 alpha 前就按这个来）', () => {
    const groups = groupSkills([inCat('a', 'alpha'), inCat('b', 'zeta')], ['zeta', 'alpha'])
    expect(groups.map((g) => g.category)).toEqual(['zeta', 'alpha'])
  })

  it('清单里没有的**游离值**归未分类（不凭空补出清单外的组）', () => {
    const groups = groupSkills([inCat('a', 'gone'), inCat('b', '')], ['ui'])
    expect(groups.map((g) => g.category)).toEqual(['ui', UNCATEGORIZED])
    expect(names(groups.at(-1)!.skills)).toEqual(['a', 'b'])
  })

  it('未分类组仍**恒在末尾**（清单顺序再怪也不越位）', () => {
    const groups = groupSkills([plain('x'), inCat('y', 'zzz')], ['zzz'])
    expect(groups.map((g) => g.category)).toEqual(['zzz', UNCATEGORIZED])
  })

  it('无行但有清单 ⇒ 全是空组（调用方据此渲染「组头 + 空态」）；无行无清单 ⇒ 空数组', () => {
    expect(groupSkills([], ['ui']).map((g) => g.skills.length)).toEqual([0])
    expect(groupSkills([], [])).toEqual([])
  })

  it('清单重复 / 含空白项：去重、去空（不改写分类名，只做防御）', () => {
    expect(groupSkills([], ['ui', 'ui', '  ']).map((g) => g.category)).toEqual(['ui'])
  })

  it('`hideEmpty`（过滤视图）：空分类组连组头一起收起，未分类有行才在', () => {
    const rows = [inCat('a', 'ui')]
    const shown = groupSkills(rows, ['ui', 'empty'], { hideEmpty: true })
    expect(shown.map((g) => g.category)).toEqual(['ui'])
    // 未分类组本就「有行才出现」，`hideEmpty` 不改这条
    const withUncat = groupSkills([...rows, plain('z')], ['ui', 'empty'], { hideEmpty: true })
    expect(withUncat.map((g) => g.category)).toEqual(['ui', UNCATEGORIZED])
  })

  it('不给清单 = 旧口径（由行推组、按分类名排序）——角色表单选取器走这一支', () => {
    const groups = groupSkills([inCat('a', 'zeta'), inCat('b', 'alpha')])
    expect(groups.map((g) => g.category)).toEqual(['alpha', 'zeta'])
  })
})

/**
 * v12 F4（W-6）组序（SPEC-4.10）：存储 + 清单 → 生效序的**纯判据**。
 * 两个任务书点名要写清的开放点 ——「新分类缺省排哪」「删除后残留键怎么自愈」—— 就在这两个函数里。
 */
describe('v12 F4（W-6）组序：清单顺序 + 用户存储序', () => {
  it('存储序优先：既在存储又在清单里的，按存储顺序在前', () => {
    expect(normalizeGroupOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b'])
  })

  it('新分类缺省补在**已命名组末尾**（清单里新增、存储没见过的按清单原顺序跟在后头）', () => {
    expect(normalizeGroupOrder(['old', 'new1', 'new2'], ['old'])).toEqual(['old', 'new1', 'new2'])
  })

  it('删除后残留键自愈：存储里已不存在的名字直接丢弃（调用方据此写回）', () => {
    expect(normalizeGroupOrder(['ui'], ['ghost', 'ui', 'ghost2'])).toEqual(['ui'])
  })

  it('存储里的重复项只算一次；未分类哨兵不参与排序', () => {
    expect(normalizeGroupOrder(['a', 'b'], ['b', 'b', UNCATEGORIZED])).toEqual(['b', 'a'])
  })

  it('空存储 ⇒ 清单原序（不凭空造序）', () => {
    expect(normalizeGroupOrder(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('上移 / 下移一格（越界返回**同一引用**，调用方据此不白写一次存储）', () => {
    expect(moveGroup(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveGroup(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    const order = ['a', 'b']
    expect(moveGroup(order, 'a', -1)).toBe(order) // 首组不能上移
    expect(moveGroup(order, 'b', 1)).toBe(order) // 末组不能下移
    expect(moveGroup(order, 'ghost', 1)).toBe(order) // 不在序里
  })

  it('纯函数：移动不改入参', () => {
    const order = ['a', 'b']
    moveGroup(order, 'a', 1)
    expect(order).toEqual(['a', 'b'])
  })
})

/**
 * v12 F4（W-6）分类失败码 → 字典键。三个码在**三个动作**下语义不同（409 在「新建」是
 * 「已存在」、在「改名」是「目标名被占」），故判据必须带动作——这是本函数存在的理由。
 */
describe('v12 F4（W-6）分类失败码 → 字典键', () => {
  it('`id_conflict`(409)：新建 → `exists`；改名 → `targetExists`', () => {
    expect(categoryErrorKey('id_conflict: duplicate', 'add')).toBe('skills.category.err.exists')
    expect(categoryErrorKey('id_conflict: duplicate', 'rename')).toBe('skills.category.err.targetExists')
  })

  it('`not_found`(404)：改名 / 删除的源不存在 → `missing`；新建时不适用（null）', () => {
    expect(categoryErrorKey('not_found: nope', 'rename')).toBe('skills.category.err.missing')
    expect(categoryErrorKey('not_found: nope', 'remove')).toBe('skills.category.err.missing')
    expect(categoryErrorKey('not_found: nope', 'add')).toBeNull()
  })

  it('`bad_request`(400)：契约里只有「名字 trim 后为空」一种 → `empty`（三动作同档）', () => {
    for (const action of ['add', 'rename', 'remove'] as const) {
      expect(categoryErrorKey('bad_request: empty name', action)).toBe('skills.category.err.empty')
    }
  })

  it('未知码 / 网络层错误 → `null`（原文透出，不猜服务端文案）；**前缀**匹配', () => {
    for (const msg of ['internal: boom', 'Failed to fetch', '']) {
      expect(categoryErrorKey(msg, 'add'), msg).toBeNull()
    }
    expect(categoryErrorKey('error: id_conflict happened', 'add')).toBeNull()
  })
})

/**
 * v12 F4（W-7）拖拽归类：drop 目标解析 → categorize 调用参数（SPEC-4.6 的可测点）。
 *
 * 关键口径是**清除语义**：目标为未分类 ⇒ **省略 `category` 键**（服务端 `parseCategorizeInput`
 * 把省略 / `null` / 空串归同一档，省略是契约里写明的表达）；同组放回 ⇒ `null`（不发请求）。
 */
describe('v12 F4（W-7）拖拽归类：drop 目标 → categorize 参数', () => {
  it('落到已命名分类 ⇒ 带 `category`（载荷 `{ names:[名], category }`）', () => {
    expect(categorizePayload('a-ui', 'ui')).toEqual({ names: ['a-ui'], category: 'ui' })
  })

  it('落到未分类组 ⇒ **省略 `category` 键**（= 服务端清除档，不是空串）', () => {
    const call = categorizePayload('a-ui', UNCATEGORIZED)
    expect(call).toEqual({ names: ['a-ui'] })
    expect('category' in call).toBe(false)
  })

  it('`dropCategorizeCall`：跨组 ⇒ 复用载荷；**同组放回 ⇒ `null`**（不白写一次存储与刷新）', () => {
    expect(dropCategorizeCall({ name: 'a-ui', category: 'ui' }, 'docs')).toEqual({
      names: ['a-ui'],
      category: 'docs',
    })
    expect(dropCategorizeCall({ name: 'a-ui', category: 'ui' }, UNCATEGORIZED)).toEqual({ names: ['a-ui'] })
    expect(dropCategorizeCall({ name: 'a-ui', category: 'ui' }, 'ui')).toBeNull()
    // 「未分类 → 未分类」也是同组：行里的游离值在界面上就呈现为未分类，拖回未分类是无变化
    expect(dropCategorizeCall({ name: 'ghostly', category: UNCATEGORIZED }, UNCATEGORIZED)).toBeNull()
  })
})

/**
 * v12 F4（W-7）折叠记忆（SPEC-4.8）：收起集合的归一化（损坏自愈）+ 改名迁移。
 */
describe('v12 F4（W-7）折叠记忆：归一化自愈 + 改名迁移', () => {
  it('`COLLAPSED_STORAGE_KEY` 是任务书钉死的键名（与组序键并存）', () => {
    expect(COLLAPSED_STORAGE_KEY).toBe('skills-collapsed')
  })

  it('`normalizeCollapsed`：非数组（损坏 JSON 的解析产物）⇒ 空集；非字符串项丢弃', () => {
    expect(normalizeCollapsed(null)).toEqual([])
    expect(normalizeCollapsed({ ui: true })).toEqual([])
    expect(normalizeCollapsed('ui')).toEqual([])
    expect(normalizeCollapsed(['ui', 42, null, 'docs'])).toEqual(['ui', 'docs'])
  })

  it('空串是**合法**键（未分类组哨兵），不被去空', () => {
    expect(normalizeCollapsed(['', 'ui'])).toEqual(['', 'ui'])
  })

  it('`renameCollapsed`：旧名在集合里 ⇒ 换成新名；不在 ⇒ 返回**同一引用**（调用方不白写盘）', () => {
    expect([...renameCollapsed(new Set(['ui', 'docs']), 'ui', 'ui2')].sort()).toEqual(['docs', 'ui2'])
    const collapsed = new Set(['docs'])
    expect(renameCollapsed(collapsed, 'ui', 'ui2')).toBe(collapsed)
  })

  it('`renameCollapsed` 不改入参（纯函数）', () => {
    const collapsed = new Set(['ui'])
    renameCollapsed(collapsed, 'ui', 'ui2')
    expect([...collapsed]).toEqual(['ui'])
  })
})
