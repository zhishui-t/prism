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
