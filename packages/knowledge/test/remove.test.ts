import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/**
 * QA 门禁回归：软删引用型条目绝不改写项目原件（A3 红线：只读项目文件）。
 * 场景：项目 md 带 YAML frontmatter 时，remove 若顺手把 status 写进 path 指向的
 * 原件，用户文件即被污染（曾实测发生）。引用型的软删状态只存 DB。
 */
describe('软删引用型不改写项目原件', () => {
  it('引用型软删：原件逐字节不变，DB status=deprecated，reindex 后仍 deprecated', async () => {
    const kb = await makeKb()
    const proj = mkdtempSync(join(tmpdir(), 'prism-rm-idx-'))
    const original = '---\ntitle: 项目设计文档\nauthor: user\n---\n\n# 项目设计文档\n\n原件内容。\n'
    const src = join(proj, 'design.md')
    writeFileSync(src, original, 'utf-8')

    await kb.index({
      id: 'IDX-FM',
      title: '项目设计文档',
      layer: 'project',
      owner: 'p',
      book: 'p',
      path: src,
      source_hash: 'sh1',
      content: '# 项目设计文档\n\n原件内容。\n',
    })
    await kb.remove('IDX-FM')

    // 原件必须逐字节不变（QA 实证过被注入 status: deprecated 的回归）
    expect(readFileSync(src, 'utf-8')).toBe(original)
    expect((await kb.get('IDX-FM'))?.status).toBe('deprecated')

    // DB-only 的软删状态在 reindex 后仍稳定（reindex 不重建引用型行）
    await kb.reindex()
    expect((await kb.get('IDX-FM'))?.status).toBe('deprecated')

    kb.close()
    rmSync(proj, { recursive: true, force: true })
  })
})

/** 回归：硬删引用型条目**绝不能删项目原件**（数据安全红线）。 */
describe('硬删不碰项目原件', () => {
  it('引用型条目硬删后，源文件仍然存在', async () => {
    const { mkdtemp, mkdir, writeFile, stat } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const kb = await makeKb()
    // 造一个真实项目文件
    const proj = await mkdtemp(join(tmpdir(), 'prism-origin-'))
    await mkdir(join(proj, 'docs'), { recursive: true })
    const file = join(proj, 'docs', 'readme.md')
    await writeFile(file, '# 项目文档\n\n这是用户的项目文件。', 'utf-8')

    await kb.index({
      id: 'IDX-origin',
      title: '项目文档',
      layer: 'project',
      owner: 'p',
      book: 'p',
      path: file,
      source_hash: 'h',
      content: '内容',
    })

    await kb.remove('IDX-origin', { hard: true })
    expect(await kb.get('IDX-origin')).toBeNull()
    // 关键断言：项目文件必须还在
    await expect(stat(file)).resolves.toBeDefined()
    kb.close()
  })

  it('自有型条目硬删会清理 Prism 版次文件目录', async () => {
    const { stat } = await import('node:fs/promises')
    const kb = await makeKb()
    const result = await kb.deposit({ id: 'OWN-X', title: 'T', type: 'rule', layer: 'global', book: 'b', content: 'x' })
    await expect(stat(result.path)).resolves.toBeDefined()

    await kb.remove('OWN-X', { hard: true })
    await expect(stat(result.path)).rejects.toThrow()
    kb.close()
  })
})
