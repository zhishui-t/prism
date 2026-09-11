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

/**
 * T-3（v5 收口）：引用型 `index()` 的 `visibility` **缺省跟随 layer**（显式传入优先）。
 *
 * 修复前 `index()` 的 INSERT 把该列硬编码为 `'project'`——layer=global/role 的引用型
 * 条目会得到与层矛盾的 visibility，`search/catalog({visibilities})` 过滤即错漏。
 * 证据与裁决：`.agent-team/debts-v5.md` T-3（本例直接读 DB 列，不看实现内部变量）。
 */
describe('引用型 visibility 跟随 layer（T-3）', () => {
  /** 读 DB 真列（不经读面字段，避免「读面没暴露」造成的假通过）。 */
  function visibilityOf(kb: PrismKnowledgeService, id: string): string {
    const row = kb.persistence.knowledge.raw
      .prepare('SELECT visibility FROM knowledge_entries WHERE id = ? AND is_latest = 1')
      .get(id) as { visibility: string } | undefined
    expect(row).toBeDefined()
    return row!.visibility
  }

  it('layer=global 的引用型条目 → DB visibility=global，且按 global 可过滤', async () => {
    const kb = await makeKb()
    await kb.index({
      id: 'IDX-G',
      title: '全局引用文档',
      type: 'doc',
      layer: 'global',
      book: 'b',
      path: 'D:/proj/global.md',
      source_hash: 'h-g',
      content: '全局引用文档正文。',
    })
    expect(visibilityOf(kb, 'IDX-G')).toBe('global')
    expect((await kb.search({ q: '全局引用文档', visibilities: ['global'] })).map((r) => r.id)).toEqual(['IDX-G'])
    // 反向：按 project 过滤不得命中（修复前这里会命中，因为列被写成 project）
    expect((await kb.catalog({ visibilities: ['project'] })).map((e) => e.id)).not.toContain('IDX-G')
    kb.close()
  })

  it('layer=role 的引用型条目 → visibility=role', async () => {
    const kb = await makeKb()
    await kb.index({
      id: 'IDX-R',
      title: '角色引用文档',
      type: 'doc',
      layer: 'role',
      owner: 'r1',
      book: 'b',
      path: 'D:/proj/role.md',
      source_hash: 'h-r',
      content: '角色引用文档正文。',
    })
    expect(visibilityOf(kb, 'IDX-R')).toBe('role')
    kb.close()
  })

  it('显式传 visibility → 优先于 layer（不被覆盖）', async () => {
    const kb = await makeKb()
    await kb.index({
      id: 'IDX-EXPLICIT',
      title: '显式可见性',
      type: 'doc',
      layer: 'project',
      owner: 'p1',
      book: 'b',
      path: 'D:/proj/explicit.md',
      source_hash: 'h-e',
      content: '显式可见性正文。',
      visibility: 'global',
    })
    expect(visibilityOf(kb, 'IDX-EXPLICIT')).toBe('global')
    kb.close()
  })

  it('更新分支同步写 visibility（修复前写坏的老行自愈，免存量迁移）', async () => {
    const kb = await makeKb()
    const input = {
      id: 'IDX-FIX',
      title: '待收敛',
      type: 'doc' as const,
      layer: 'project' as const,
      owner: 'p1',
      book: 'b',
      path: 'D:/proj/fix.md',
      source_hash: 'h1',
      content: '待收敛正文。',
    }
    await kb.index(input)
    expect(visibilityOf(kb, 'IDX-FIX')).toBe('project')

    // 模拟修复前的历史脏值（层与可见性不一致的既有行）
    kb.persistence.knowledge.raw
      .prepare('UPDATE knowledge_entries SET visibility = ? WHERE id = ? AND is_latest = 1')
      .run('global', 'IDX-FIX')
    expect(visibilityOf(kb, 'IDX-FIX')).toBe('global')

    // 源变化 → 走 UPDATE 分支（layer 不变）→ visibility 重新按 layer 计算并落库
    await kb.index({ ...input, source_hash: 'h2', content: '待收敛正文（改）。' })
    expect(visibilityOf(kb, 'IDX-FIX')).toBe('project')
    kb.close()
  })
})
