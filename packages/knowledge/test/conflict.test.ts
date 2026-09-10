import { describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { makeTempDir } from '../../server/test/helpers.js'

async function makeKb(): Promise<PrismKnowledgeService> {
  return new PrismKnowledgeService({ home: await makeTempDir('prism-conf-') })
}

/** B2：层间冲突只记录不阻断（§12.3）。 */
describe('层间冲突检测（B2）', () => {
  it('同名跨层且未声明 overrides → 记录冲突，但落库成功', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: '异常处理', type: 'rule', layer: 'global', book: 'b', module: 'm', content: '全局规定' })

    // 项目层同名 → 应记录冲突
    const result = await kb.deposit({
      id: 'P-1',
      title: '异常处理',
      type: 'rule',
      layer: 'project',
      owner: 'proj',
      book: 'b',
      module: 'm',
      content: '项目规定',
    })
    expect(result.version).toBe(1) // 不阻断落库

    const conflicts = await kb.conflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ high_id: 'P-1', low_id: 'G-1', kind: 'same_title', resolved: false })
    kb.close()
  })

  it('显式声明 overrides → 不算冲突（就近覆盖是有意为之）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: '日志规范', type: 'rule', layer: 'global', book: 'b', module: 'm', content: '全局' })
    await kb.deposit({
      id: 'P-1',
      title: '日志规范',
      type: 'rule',
      layer: 'project',
      owner: 'proj',
      book: 'b',
      module: 'm',
      content: '项目',
      overrides: ['G-1'],
    })
    expect(await kb.conflicts()).toHaveLength(0)
    kb.close()
  })

  it('标题不同 / 模块不同 → 不产生冲突', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: '异常处理', type: 'rule', layer: 'global', book: 'b', module: 'm', content: 'x' })
    await kb.deposit({ id: 'P-1', title: '命名规范', type: 'rule', layer: 'project', owner: 'p', book: 'b', module: 'm', content: 'x' })
    await kb.deposit({ id: 'P-2', title: '异常处理', type: 'rule', layer: 'project', owner: 'p', book: 'b', module: 'other', content: 'x' })
    expect(await kb.conflicts()).toHaveLength(0)
    kb.close()
  })

  it('重复落库不重复记冲突（同 high/low 幂等）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: 'T', type: 'rule', layer: 'global', book: 'b', module: 'm', content: 'x' })
    await kb.deposit({ id: 'P-1', title: 'T', type: 'rule', layer: 'project', owner: 'p', book: 'b', module: 'm', content: 'v1' })
    await kb.deposit({ id: 'P-1', title: 'T', type: 'rule', layer: 'project', owner: 'p', book: 'b', module: 'm', content: 'v2' })
    expect(await kb.conflicts()).toHaveLength(1)
    kb.close()
  })

  it('resolveConflict 标记已处理；默认列表不含已解决', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: 'T', type: 'rule', layer: 'global', book: 'b', module: 'm', content: 'x' })
    await kb.deposit({ id: 'P-1', title: 'T', type: 'rule', layer: 'project', owner: 'p', book: 'b', module: 'm', content: 'x' })

    const [conflict] = await kb.conflicts()
    expect(await kb.resolveConflict(conflict!.id)).toBe(true)
    expect(await kb.conflicts()).toHaveLength(0)
    expect(await kb.conflicts({ includeResolved: true })).toHaveLength(1)
    expect(await kb.resolveConflict('nope')).toBe(false)
    kb.close()
  })

  it('role vs project 同名 → 记录冲突（高层可覆盖更低层；此前漏检）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'P-1', title: '异常处理', type: 'rule', layer: 'project', owner: 'proj', book: 'b', module: 'm', content: '项目' })
    await kb.deposit({ id: 'R-1', title: '异常处理', type: 'rule', layer: 'role', owner: 'dev-1', book: 'b', module: 'm', content: '角色' })
    expect((await kb.conflicts()).map((c) => `${c.high_id}->${c.low_id}`)).toContain('R-1->P-1')
    kb.close()
  })

  it('role 同名同时命中 global 与 project → 记录对应全部组合', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: '日志规范', type: 'rule', layer: 'global', book: 'b', module: 'm', content: 'g' })
    // P-1 落库即对 G-1 记一条（project 覆盖 global）
    await kb.deposit({ id: 'P-1', title: '日志规范', type: 'rule', layer: 'project', owner: 'proj', book: 'b', module: 'm', content: 'p' })
    // R-1 落库对 global 与 project 各记一条
    await kb.deposit({ id: 'R-1', title: '日志规范', type: 'rule', layer: 'role', owner: 'dev-1', book: 'b', module: 'm', content: 'r' })
    const pairs = (await kb.conflicts()).map((c) => `${c.high_id}->${c.low_id}`).sort()
    expect(pairs).toEqual(['P-1->G-1', 'R-1->G-1', 'R-1->P-1'])
    kb.close()
  })

  it('global 层同名不触发（同层不算层间冲突）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: 'X', type: 'rule', layer: 'global', book: 'b', module: 'm', content: 'x' })
    await kb.deposit({ id: 'G-2', title: 'X', type: 'rule', layer: 'global', book: 'b', module: 'm', content: 'x2' })
    expect(await kb.conflicts()).toHaveLength(0)
    kb.close()
  })
})

/** F-A3：`index()`（引用型）也走同一检测；`detected_from` 只进审计事件。 */
describe('引用型写路径也检测层间冲突（F-A3）', () => {
  it('index 落地的引用型同名跨层 → 记录 conflict，且不阻断（返回 created）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-1', title: '异常处理', type: 'rule', layer: 'global', book: 'b', module: 'm', content: '全局' })

    const result = await kb.index({
      id: 'IDX-1',
      title: '异常处理',
      layer: 'project',
      owner: 'proj',
      book: 'b',
      module: 'm',
      path: 'D:/proj/a.md',
      source_hash: 'h1',
      content: '项目里的同名文档',
    })
    expect(result.action).toBe('created') // 不阻断

    const conflicts = await kb.conflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ high_id: 'IDX-1', low_id: 'G-1', kind: 'same_title' })
    kb.close()
  })

  it('detected_from 区分 deposit / index 且只进审计事件（返回体与表结构无此字段）', async () => {
    const kb = await makeKb()
    // ① deposit 路径
    await kb.deposit({ id: 'G-1', title: '日志规范', type: 'rule', layer: 'global', book: 'b', module: 'm', content: 'g' })
    await kb.deposit({ id: 'P-1', title: '日志规范', type: 'rule', layer: 'project', owner: 'p', book: 'b', module: 'm', content: 'p' })
    // ② index 路径
    await kb.index({
      id: 'IDX-2',
      title: '日志规范',
      layer: 'role',
      owner: 'dev-1',
      book: 'b',
      module: 'm',
      path: 'D:/proj/b.md',
      source_hash: 'h2',
      content: '角色层同名文档',
    })

    const events = (await kb.audit.query({ types: ['knowledge.conflict_detected'] })) as unknown as Array<
      Record<string, unknown>
    >
    const byKind = events.map((e) => `${String(e['high_id'])}:${String(e['detected_from'])}`)
    expect(byKind).toContain('P-1:deposit')
    expect(byKind).toContain('IDX-2:index')

    // 冲突记录本体不含 detected_from（零迁移：不加列、不进返回体）
    const [conflict] = await kb.conflicts()
    expect(Object.keys(conflict!)).not.toContain('detected_from')
    kb.close()
  })
})

/** F-A3：`overrides` 运行时降权——默认关闭，`graph_boost: true` 才生效。 */
describe('overrides 运行时降权（F-A3，默认关）', () => {
  async function seedOverride(): Promise<PrismKnowledgeService> {
    const kb = await makeKb()
    await kb.deposit({
      id: 'G-1',
      title: '日志规范',
      type: 'rule',
      layer: 'global',
      book: 'b',
      module: 'm',
      content: '日志规范要求记录 trace id。',
    })
    await kb.deposit({
      id: 'P-1',
      title: '日志规范',
      type: 'rule',
      layer: 'project',
      owner: 'p',
      book: 'b',
      module: 'm',
      content: '日志规范要求记录 trace id 与 span id。',
      overrides: ['G-1'],
    })
    return kb
  }

  it('不传 graph_boost → 与改动前一致（无 overridden_by、分数不变）', async () => {
    const kb = await seedOverride()
    const plain = await kb.search({ q: '日志规范' })
    expect(plain.length).toBeGreaterThan(0)
    expect(plain.every((r) => r.overridden_by === undefined)).toBe(true)
    expect(plain.every((r) => !('overridden_by' in r))).toBe(true)

    const explicitFalse = await kb.search({ q: '日志规范', graph_boost: false })
    expect(explicitFalse.map((r) => `${r.id}:${r.score}`)).toEqual(plain.map((r) => `${r.id}:${r.score}`))
    kb.close()
  })

  it('graph_boost: true + overrides 边 → 被覆盖条目降权 0.5 且返回 overridden_by，不删除', async () => {
    const kb = await seedOverride()
    const base = await kb.search({ q: '日志规范' })
    const boosted = await kb.search({ q: '日志规范', graph_boost: true })

    // 不删除、不过滤：结果集合一致
    expect([...boosted.map((r) => r.id)].sort()).toEqual([...base.map((r) => r.id)].sort())

    const baseG = base.find((r) => r.id === 'G-1')!
    const boostG = boosted.find((r) => r.id === 'G-1')!
    expect(boostG.score).toBeCloseTo(baseG.score * 0.5, 10)
    expect(boostG.overridden_by).toBe('P-1@v1')

    // 覆盖者本身不被标记、不降权
    const boostP = boosted.find((r) => r.id === 'P-1')!
    const baseP = base.find((r) => r.id === 'P-1')!
    expect(boostP.overridden_by).toBeUndefined()
    expect(boostP.score).toBe(baseP.score)

    // 降权后排序不得提前（同相关性下靠后）
    expect(boosted.findIndex((r) => r.id === 'G-1')).toBeGreaterThanOrEqual(
      base.findIndex((r) => r.id === 'G-1'),
    )
    kb.close()
  })

  it('无 overrides 声明 → graph_boost 不改变任何分数（仅记录冲突）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'G-9', title: '命名规范', type: 'rule', layer: 'global', book: 'b', module: 'm', content: '全局命名规范。' })
    await kb.deposit({
      id: 'P-9',
      title: '命名规范',
      type: 'rule',
      layer: 'project',
      owner: 'p',
      book: 'b',
      module: 'm',
      content: '项目命名规范。',
    })
    expect(await kb.conflicts()).toHaveLength(1) // 冲突仍记录

    const base = await kb.search({ q: '命名规范' })
    const boosted = await kb.search({ q: '命名规范', graph_boost: true })
    expect(boosted.map((r) => `${r.id}:${r.score}:${r.overridden_by ?? ''}`)).toEqual(
      base.map((r) => `${r.id}:${r.score}:${r.overridden_by ?? ''}`),
    )
    kb.close()
  })
})
