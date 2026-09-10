/**
 * 软删（remove）的语义闭环回归。
 *
 * 背景缺陷：`remove` 的注释承诺「可恢复」，但（a）没有恢复入口，（b）引用型条目
 * 一旦源文件变化，`kb.index()` 重扫会把 status 无条件写回 active——软删被静默撤销。
 * 本测试锁定修好后的语义：
 *   1. 引用型软删后，源变更重扫仍为 deprecated（不复活）；
 *   2. `restore()` 才恢复（幂等）；
 *   3. 自有型软删后 reindex 不复活，restore 后 reindex 不回退。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { makeTempDir } from '../../server/test/helpers.js'

describe('软删语义：引用型重扫不复活，显式 restore 才恢复', () => {
  it('引用型：软删后改源文件重扫 → 仍 deprecated；restore 恢复', async () => {
    const home = await makeTempDir('prism-restore-idx-')
    const root = await makeTempDir('prism-restore-proj-')
    const abs = join(root, 'doc.md')
    await mkdir(root, { recursive: true })
    await writeFile(abs, '# 原文\n\nv1\n', 'utf-8')

    const kb = new PrismKnowledgeService({ home })
    const base = {
      id: 'IDX-R',
      title: '文档 R',
      layer: 'project' as const,
      owner: 'proj',
      book: 'proj',
      module: 'mod',
      path: abs,
      content: 'v1',
    }
    await kb.index({ ...base, source_hash: 'h1' })

    // 软删
    const rm = await kb.remove('IDX-R')
    expect(rm.mode).toBe('soft')
    expect((await kb.get('IDX-R'))?.status).toBe('deprecated')

    // 源内容变了 → 重扫（此前会把 status 冲成 active = 复活）
    const up = await kb.index({ ...base, content: 'v2 改了', source_hash: 'h2' })
    expect(up.action).toBe('updated')
    expect((await kb.get('IDX-R'))?.status).toBe('deprecated')

    // 检索仍不可见
    expect((await kb.search({ q: '文档 R' })).some((r) => r.id === 'IDX-R')).toBe(false)

    // 显式恢复
    const rs = await kb.restore('IDX-R')
    expect(rs.restored).toBe(true)
    expect((await kb.get('IDX-R'))?.status).toBe('active')
    // 幂等：再恢复一次 → restored=false
    expect((await kb.restore('IDX-R')).restored).toBe(false)
    kb.close()
  })

  it('自有型：软删 → reindex 不复活；restore → reindex 不回退', async () => {
    const home = await makeTempDir('prism-restore-owned-')
    const kb = new PrismKnowledgeService({ home })
    const d = await kb.deposit({
      id: 'OWN-R',
      title: '自有条目',
      type: 'rule',
      layer: 'global',
      book: 'b',
      content: '内容',
    })
    await kb.remove('OWN-R')
    expect((await kb.get('OWN-R'))?.status).toBe('deprecated')

    // reindex 以文件为真相：文件里已是 deprecated → 不复活
    await kb.reindex()
    expect((await kb.get('OWN-R'))?.status).toBe('deprecated')

    // restore 写回文件 → reindex 后仍是 active
    expect((await kb.restore('OWN-R')).restored).toBe(true)
    await kb.reindex()
    expect((await kb.get('OWN-R'))?.status).toBe('active')
    expect((await kb.search({ q: '自有条目' })).some((r) => r.id === 'OWN-R')).toBe(true)
    void d
    kb.close()
  })

  it('restore 不存在的 id → not_found', async () => {
    const home = await makeTempDir('prism-restore-404-')
    const kb = new PrismKnowledgeService({ home })
    await expect(kb.restore('nope')).rejects.toMatchObject({ code: 'not_found' })
    kb.close()
  })
})
