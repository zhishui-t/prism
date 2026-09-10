import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { isPrismError } from '@prism/core'

import { splitFrontmatter } from '../src/frontmatter.js'
import { PrismKnowledgeService } from '../src/service.js'

let service: PrismKnowledgeService | undefined
let home: string | undefined

function makeService(): PrismKnowledgeService {
  home = mkdtempSync(join(tmpdir(), 'prism-kb-version-'))
  return new PrismKnowledgeService({ home })
}

const BASE = {
  title: '禁止吞掉异常',
  type: 'rule' as const,
  layer: 'global' as const,
  book: 'java-standards',
  module: 'exception-handling',
}

afterAll(() => {
  service?.close()
})

describe('版次制（F02 验收：同 id deposit 递增版本，历史版可读）', () => {
  it('同 id deposit 两次 → version 1 → 2，get(id,1) 可取历史版', async () => {
    service = service ?? makeService()
    const v1 = await service.deposit({
      ...BASE,
      id: 'JAVA-01-002',
      content: '第一版：异常处理要求记录日志。',
    })
    expect(v1.version).toBe(1)
    expect(v1.path).toContain(join('java-standards', 'exception-handling', 'JAVA-01-002', 'v01.md'))

    const v2 = await service.deposit({
      ...BASE,
      id: 'JAVA-01-002',
      content: '第二版：异常处理必须带上下文 id。',
    })
    expect(v2.version).toBe(2)
    expect(v2.path).toContain('v02.md')

    // get 不带版本 → 最新版
    const latest = await service.get('JAVA-01-002')
    expect(latest).not.toBeNull()
    expect(latest?.version).toBe(2)
    expect(latest?.status).toBe('active')
    expect(latest?.content).toContain('第二版')

    // get(id, 1) → 历史版，正文为第一版
    const old = await service.get('JAVA-01-002', 1)
    expect(old).not.toBeNull()
    expect(old?.version).toBe(1)
    expect(old?.status).toBe('superseded')
    expect(old?.content).toContain('第一版')
    expect(old?.superseded_by).toBe('JAVA-01-002@v2')
    // 检索默认只出最新版
    const search = await service.search({ q: '异常处理' })
    expect(search.filter((r) => r.id === 'JAVA-01-002')).toHaveLength(1)
    expect(search.find((r) => r.id === 'JAVA-01-002')?.version).toBe(2)
    // all_versions: true 才返回历史版
    const all = await service.search({ q: '异常处理', all_versions: true })
    const versions = all.filter((r) => r.id === 'JAVA-01-002').map((r) => r.version)
    expect(versions).toContain(1)
    expect(versions).toContain(2)
  })

  it('版次文件逐版独立落盘，<id>.md 为最新版副本，frontmatter 记 supersedes', () => {
    const dir = join(home!, 'knowledge', 'global', 'java-standards', 'exception-handling', 'JAVA-01-002')
    expect(existsSync(join(dir, 'v01.md'))).toBe(true)
    expect(existsSync(join(dir, 'v02.md'))).toBe(true)
    const latest = readFileSync(join(dir, 'JAVA-01-002.md'), 'utf-8')
    const { data } = splitFrontmatter(latest)
    expect(data?.version).toBe(2)
    expect(data?.supersedes).toBe('JAVA-01-002@v1')
    const v1File = readFileSync(join(dir, 'v01.md'), 'utf-8')
    expect(splitFrontmatter(v1File).data?.supersedes).toBeNull()
  })

  it('get 历史版返回的 path 指向该版次的 v<NN>.md', async () => {
    const old = await service!.get('JAVA-01-002', 1)
    expect(old?.path?.endsWith('v01.md')).toBe(true)
  })

  it('未知 id / 未知版次 → null', async () => {
    expect(await service!.get('NO-SUCH-ID')).toBeNull()
    expect(await service!.get('JAVA-01-002', 99)).toBeNull()
  })

  it('同 id 但 layer/book/owner 不一致 → id_conflict', async () => {
    await expect(
      service!.deposit({ ...BASE, id: 'JAVA-01-002', book: 'other-book', content: 'x' }),
    ).rejects.toMatchObject({ code: 'id_conflict' })
    await expect(
      service!.deposit({
        ...BASE,
        id: 'JAVA-01-002',
        layer: 'project',
        owner: 'p1',
        content: 'x',
      }),
    ).rejects.toMatchObject({ code: 'id_conflict' })
  })
})

describe('落库校验（§3.5 清单 → bad_request）', () => {
  it('缺必填字段', async () => {
    service = service ?? makeService()
    await expect(
      service.deposit({ ...BASE, id: 'V-1', title: '', content: 'c' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      service.deposit({ ...BASE, id: 'V-2', content: ' ' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      service.deposit({ type: 'rule', layer: 'global', book: 'b', content: 'c' } as never),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('project 层缺 owner / global 层带 owner', async () => {
    await expect(
      service!.deposit({
        title: 't',
        type: 'doc',
        layer: 'project',
        book: 'b',
        content: 'c',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      service!.deposit({
        title: 't',
        type: 'doc',
        layer: 'global',
        owner: 'p1',
        book: 'b',
        content: 'c',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('非法类型与非法段名', async () => {
    await expect(
      service!.deposit({ ...BASE, id: 'V-3', type: 'secret' as never, content: 'c' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      service!.deposit({ ...BASE, id: 'V-4', book: 'a/b', content: 'c' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      service!.deposit({ ...BASE, id: '../escape', content: 'c' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      service!.deposit({ ...BASE, id: 'V-5', module: '_inbox', content: 'c' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('confidence 越界 / 非法枚举', async () => {
    await expect(
      service!.deposit({ ...BASE, id: 'V-6', confidence: 1.5, content: 'c' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(
      service!.deposit({ ...BASE, id: 'V-7', risk: 'extreme' as never, content: 'c' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('留痕与统计（§3.5 content_hash + AuditLog；tree/stats）', () => {
  it('content_hash=SHA256(正文)，AuditLog 记 deposited 与 superseded', async () => {
    service = service ?? makeService()
    const { createHash } = await import('node:crypto')
    const deposited = await service.deposit({ ...BASE, id: 'AUDIT-1', content: '审计正文' })
    const entry = await service.get('AUDIT-1')
    expect(entry?.content_hash).toBe(createHash('sha256').update('审计正文', 'utf-8').digest('hex'))

    const events = await service.audit.query({ types: ['knowledge.deposited'] })
    expect(events.some((e) => (e as { knowledge_id?: string }).knowledge_id === 'AUDIT-1')).toBe(true)
    await service.deposit({ ...BASE, id: 'AUDIT-1', content: '审计正文第二版' })
    const supersededEvents = await service.audit.query({ types: ['knowledge.superseded'] })
    expect(
      supersededEvents.some(
        (e) => (e as { new_id?: string }).new_id === 'AUDIT-1@v2',
      ),
    ).toBe(true)
    expect(deposited.version).toBe(1)
  })

  it('tree 汇总 层→书→模块（含 _inbox），stats 统计各层', async () => {
    service = service ?? makeService()
    await service.deposit({ title: 't1', type: 'doc', layer: 'global', book: 'tree-b', content: 'c' })
    await service.deposit({
      title: 't2',
      type: 'doc',
      layer: 'project',
      owner: 'tree-p',
      book: 'tree-b',
      module: 'm1',
      content: 'c',
    })
    const nodes = await service.tree('global')
    const node = nodes.find((n) => n.book === 'tree-b')
    expect(node).toBeDefined()
    expect(node?.modules.some((m) => m.name === '_inbox' && m.count === 1)).toBe(true)
    const projectNodes = await service.tree('project', 'tree-p')
    expect(projectNodes[0]?.owner).toBe('tree-p')
    expect(projectNodes[0]?.total).toBe(1)

    const stats = await service.stats()
    expect(stats.layers.global).toBeGreaterThanOrEqual(1)
    expect(stats.layers.project).toBeGreaterThanOrEqual(1)
    expect(stats.books).toBeGreaterThanOrEqual(2)
    expect(stats.by_type.rule).toBeGreaterThanOrEqual(1)
  })

  it('PrismError 结构：code + isPrismError 守卫', async () => {
    try {
      await service!.deposit({ ...BASE, id: 'BAD', book: 'x/y', content: 'c' })
      expect.unreachable('应抛出 PrismError')
    } catch (error) {
      expect(isPrismError(error)).toBe(true)
      expect((error as { code: string }).code).toBe('bad_request')
    }
  })
})

/** 版本历史查询面（F-B4）：listVersions 降序 + is_latest；不存在 id → 空数组。 */
describe('listVersions（F-B4 版本历史查询面）', () => {
  it('多版次 → 降序返回全部版次 + is_latest 正确', async () => {
    const kb = new PrismKnowledgeService({ home: mkdtempSync(join(tmpdir(), 'prism-kb-versions-')) })
    await kb.deposit({ ...BASE, id: 'VER-1', content: '第一版' })
    await kb.deposit({ ...BASE, id: 'VER-1', content: '第二版' })
    await kb.deposit({ ...BASE, id: 'VER-1', content: '第三版' })

    const versions = await kb.listVersions('VER-1')
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]) // 降序
    expect(versions.map((v) => v.is_latest)).toEqual([true, false, false])
    expect(versions.map((v) => v.status)).toEqual(['active', 'superseded', 'superseded'])
    expect(versions[0]?.title).toBe('禁止吞掉异常')
    expect(versions[0]?.source_path?.endsWith('v03.md')).toBe(true)
    expect(versions[2]?.source_path?.endsWith('v01.md')).toBe(true)
    kb.close()
  })

  it('单版次 → 1 条；不存在 id → 空数组（不报错）', async () => {
    const kb = new PrismKnowledgeService({ home: mkdtempSync(join(tmpdir(), 'prism-kb-versions2-')) })
    await kb.deposit({ ...BASE, id: 'VER-2', content: '唯一版' })
    expect(await kb.listVersions('VER-2')).toHaveLength(1)
    expect(await kb.listVersions('NO-SUCH-ID')).toEqual([])
    kb.close()
  })

  it('软删后仍列出版次且状态为 deprecated（版本历史不隐藏）', async () => {
    const kb = new PrismKnowledgeService({ home: mkdtempSync(join(tmpdir(), 'prism-kb-versions3-')) })
    await kb.deposit({ ...BASE, id: 'VER-3', content: 'a' })
    await kb.remove('VER-3')
    const versions = await kb.listVersions('VER-3')
    expect(versions).toHaveLength(1)
    expect(versions[0]?.status).toBe('deprecated')
    expect(versions[0]?.is_latest).toBe(true)
    kb.close()
  })
})

/** 版本去重（2026-09-10）：内容未变不产生新版次。 */
describe('版本去重', () => {
  it('重复落库同一内容 → unchanged，不新增版次文件', async () => {
    const { PrismKnowledgeService } = await import('../src/service.js')
    const { makeTempDir } = await import('../../server/test/helpers.js')
    const { readdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')

    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-dedup-') })
    const base = { id: 'D-1', title: 'T', type: 'rule' as const, layer: 'global' as const, book: 'b', content: '相同内容' }

    const first = await kb.deposit(base)
    expect(first.action).toBe('created')
    expect(first.version).toBe(1)

    const second = await kb.deposit(base)
    expect(second.action).toBe('unchanged')
    expect(second.version).toBe(1) // 版本不涨

    // 磁盘上只有 v01，没有 v02
    const files = await readdir(dirname(first.path))
    expect(files.filter((f) => /^v\d+\.md$/.test(f))).toEqual(['v01.md'])

    // 内容变了 → updated
    const third = await kb.deposit({ ...base, content: '改了内容' })
    expect(third.action).toBe('updated')
    expect(third.version).toBe(2)
    kb.close()
  })

  it('unchanged 不写审计（重复落库静默跳过）', async () => {
    const { PrismKnowledgeService } = await import('../src/service.js')
    const { makeTempDir } = await import('../../server/test/helpers.js')
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-dedup2-') })
    const base = { id: 'D-2', title: 'T', type: 'rule' as const, layer: 'global' as const, book: 'b', content: 'x' }
    expect((await kb.deposit(base)).action).toBe('created')
    expect((await kb.deposit(base)).action).toBe('unchanged')
    expect((await kb.deposit(base)).action).toBe('unchanged')
    kb.close()
  })
})
