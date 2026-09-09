import { describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { makeTempDir } from '../../server/test/helpers.js'

async function makeKb(): Promise<PrismKnowledgeService> {
  return new PrismKnowledgeService({ home: await makeTempDir('prism-vis-') })
}

/** B3：visibility 读过滤是 opt-in——不传参数时行为必须完全不变。 */
describe('visibility 读过滤（B3）', () => {
  it('不传 visibilities → 不过滤（既有行为不变）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'A', title: '全局规则', type: 'rule', layer: 'global', book: 'b', content: '内容', visibility: 'global' })
    await kb.deposit({ id: 'B', title: '项目规则', type: 'rule', layer: 'project', owner: 'p', book: 'b', content: '内容', visibility: 'project' })

    expect((await kb.search({ q: '规则' })).length).toBe(2)
    expect((await kb.catalog()).length).toBe(2)
    kb.close()
  })

  it('传入 visibilities → 只返回匹配项', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'A', title: '全局规则', type: 'rule', layer: 'global', book: 'b', content: '内容', visibility: 'global' })
    await kb.deposit({ id: 'B', title: '项目规则', type: 'rule', layer: 'project', owner: 'p', book: 'b', content: '内容', visibility: 'project' })

    const onlyGlobal = await kb.search({ q: '规则', visibilities: ['global'] })
    expect(onlyGlobal.map((r) => r.id)).toEqual(['A'])

    const onlyProject = await kb.catalog({ visibilities: ['project'] })
    expect(onlyProject.map((r) => r.id)).toEqual(['B'])

    const both = await kb.search({ q: '规则', visibilities: ['global', 'project'] })
    expect(both.length).toBe(2)
    kb.close()
  })

  it('visibility 缺省值 = layer（deposit 时按层回落）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'A', title: 'T', type: 'rule', layer: 'global', book: 'b', content: 'x' })
    const entry = await kb.get('A')
    // 未显式指定时按层回落为 global
    expect((await kb.search({ q: 'T', visibilities: ['global'] })).length).toBe(1)
    expect(entry).not.toBeNull()
    kb.close()
  })
})
