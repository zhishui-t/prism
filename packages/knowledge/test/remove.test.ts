import { describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { makeTempDir } from '../../server/test/helpers.js'

async function makeKb(): Promise<PrismKnowledgeService> {
  return new PrismKnowledgeService({ home: await makeTempDir('prism-rm-') })
}

describe('软删与硬删（B1）', () => {
  it('默认软删：status=deprecated，行与文件保留，仍可按 id 取到', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'E-1', title: 'T', type: 'rule', layer: 'global', book: 'b', content: '内容' })

    const result = await kb.remove('E-1')
    expect(result.mode).toBe('soft')
    expect(result.references).toBe(0)

    // get 仍可取到（便于恢复）
    const entry = await kb.get('E-1')
    expect(entry?.status).toBe('deprecated')
    kb.close()
  })

  it('软删后不出现在检索 / catalog / tree 里', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'E-1', title: '异常处理规则', type: 'rule', layer: 'global', book: 'b', content: '禁止吞异常' })
    expect((await kb.search({ q: '异常' })).length).toBe(1)

    await kb.remove('E-1')
    expect((await kb.search({ q: '异常' })).length).toBe(0)
    expect((await kb.catalog()).length).toBe(0)
    expect((await kb.tree()).length).toBe(0)
    kb.close()
  })

  it('被引用的条目禁止硬删（referenced）', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'A', title: 'A', type: 'rule', layer: 'global', book: 'b', content: 'x' })
    await kb.deposit({ id: 'B', title: 'B', type: 'rule', layer: 'global', book: 'b', content: '参见 [[A]]' })

    const soft = await kb.remove('A')
    expect(soft.references).toBeGreaterThan(0)
    await expect(kb.remove('A', { hard: true })).rejects.toMatchObject({ code: 'referenced' })
    kb.close()
  })

  it('无引用时可硬删：行、边、FTS 均清除', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'E-1', title: '异常规则', type: 'rule', layer: 'global', book: 'b', content: '内容' })

    const result = await kb.remove('E-1', { hard: true })
    expect(result.mode).toBe('hard')
    expect(await kb.get('E-1')).toBeNull()
    expect((await kb.search({ q: '异常' })).length).toBe(0)
    kb.close()
  })

  it('不存在的 id → not_found', async () => {
    const kb = await makeKb()
    await expect(kb.remove('nope')).rejects.toMatchObject({ code: 'not_found' })
    kb.close()
  })
})

/** QA BLK-2 回归：软删状态必须持久化到文件，reindex 不能复活。 */
describe('软删与 reindex 共存（BLK-2 回归）', () => {
  it('软删后 reindex → 仍是 deprecated，且不回到检索结果', async () => {
    const kb = await makeKb()
    await kb.deposit({ id: 'E-1', title: '异常规则', type: 'rule', layer: 'global', book: 'b', content: '内容' })
    await kb.remove('E-1')

    await kb.reindex()

    const entry = await kb.get('E-1')
    expect(entry?.status).toBe('deprecated')
    expect((await kb.search({ q: '异常' })).length).toBe(0)
    kb.close()
  })
})
