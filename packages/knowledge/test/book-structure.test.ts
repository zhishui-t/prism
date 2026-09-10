/**
 * F-A1 书结构生成/固化/读取 + F-A2 继承。
 *
 * 关键点：
 * - `generateBookStructure` **零 LLM**：从条目 + 边表推导 `suggested`，产三份文件；
 * - **幂等**：二次执行文件逐字节一致、`revision` 不递增（只有 freeze 递增）；
 * - `freezeBookStructure` 校验 slug / `_inbox` / 无条目书，写文件 + 表；
 * - `bookStructure()` 读回（文件为真相 + 表补充 `suggested`）；
 * - F-A2 `inherits`：只读合并（并集去重、父在前、本地覆盖），环/缺父 → `book_inherit_invalid`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseFrontmatter } from '../src/frontmatter.js'
import { INBOX_DIR } from '../src/store.js'
import { PrismKnowledgeService } from '../src/service.js'

const dirs: string[] = []

function makeService(): PrismKnowledgeService {
  const home = mkdtempSync(join(tmpdir(), 'prism-kb-struct-'))
  dirs.push(home)
  return new PrismKnowledgeService({ home })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function bookDir(kb: PrismKnowledgeService, layer: string, book: string): string {
  return join(kb.knowledgeDir, layer, book)
}

function readModules(kb: PrismKnowledgeService, layer: string, book: string): Record<string, unknown> {
  return parseFrontmatter(readFileSync(join(bookDir(kb, layer, book), '_modules.yaml'), 'utf-8')) as Record<
    string,
    unknown
  >
}

/** 手写一份 `_modules.yaml`（模拟人工声明本地清单 / 继承）。 */
function writeModules(
  kb: PrismKnowledgeService,
  layer: string,
  book: string,
  modules: string[],
  inherits: string[] = [],
  revision = 1,
): void {
  const dir = bookDir(kb, layer, book)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '_modules.yaml'),
    [
      '# generated: true',
      `layer: ${layer}`,
      `book: ${book}`,
      'generated: true',
      `revision: ${revision}`,
      'frozen_at: null',
      'confirmed_by: null',
      `inherits: [${inherits.join(', ')}]`,
      `modules: [${modules.join(', ')}]`,
      '',
    ].join('\n'),
    'utf-8',
  )
}

async function seedBook(
  kb: PrismKnowledgeService,
  book: string,
  layout: Array<{ id: string; title: string; module?: string; content?: string }>,
  layer: 'global' = 'global',
): Promise<void> {
  for (const entry of layout) {
    await kb.deposit({
      id: entry.id,
      title: entry.title,
      type: 'doc',
      layer,
      book,
      ...(entry.module !== undefined ? { module: entry.module } : {}),
      content: entry.content ?? `${entry.title} 的正文。`,
    })
  }
}

describe('书结构生成（F-A1：零 LLM 推导 + 三份文件 + 幂等）', () => {
  it('从条目推导 suggested 并产 _modules.yaml + 书级/模块级 _summary.md；表有行', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'demo', [
        { id: 'D-1', title: '甲一', module: 'm1' },
        { id: 'D-2', title: '甲二', module: 'm1' },
        { id: 'D-3', title: '乙一', module: 'm2' },
        { id: 'D-4', title: '未归类' }, // module '' → _inbox
      ])

      const { structure, files } = await kb.generateBookStructure({ layer: 'global', book: 'demo' })

      // suggested：条目数降序，含 _inbox；未 freeze 过 → revision 0、无冻结时间
      expect(structure.suggested).toEqual([
        { slug: 'm1', entries: 2 },
        { slug: 'm2', entries: 1 },
        { slug: INBOX_DIR, entries: 1 },
      ])
      expect(structure.modules).toEqual([]) // 未 freeze → 冻结清单为空
      expect(structure.revision).toBe(0)
      expect(structure.frozen_at).toBeNull()

      // 三份文件（书级 + 每个非空模块级，含 _inbox）
      const dir = bookDir(kb, 'global', 'demo')
      const expected = [
        join(dir, '_modules.yaml'),
        join(dir, '_summary.md'),
        join(dir, 'm1', '_summary.md'),
        join(dir, 'm2', '_summary.md'),
        join(dir, INBOX_DIR, '_summary.md'),
      ]
      expect([...files].sort()).toEqual([...expected].sort())
      for (const file of expected) expect(existsSync(file)).toBe(true)

      const modulesYaml = readModules(kb, 'global', 'demo')
      expect(modulesYaml['generated']).toBe(true)
      expect(modulesYaml['revision']).toBe(0)
      expect(modulesYaml['inherits']).toEqual([])
      expect(modulesYaml['modules']).toEqual([])

      const summary = readFileSync(join(dir, '_summary.md'), 'utf-8')
      expect(summary).toContain('generated: true')
      expect(summary).toContain('| m1 | 2 |')
      expect(summary).toContain('| m2 | 1 |')
      expect(summary).toContain(`| ${INBOX_DIR} | 1 |`)
      // 模块级总纲列条目清单
      expect(readFileSync(join(dir, 'm1', '_summary.md'), 'utf-8')).toContain('`D-1`')
      expect(readFileSync(join(dir, 'm1', '_summary.md'), 'utf-8')).not.toContain('`D-3`')
    } finally {
      kb.close()
    }
  })

  it('幂等：二次执行三份文件逐字节一致、revision 不递增、表行不重复', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'idem', [
        { id: 'I-1', title: '甲', module: 'm1' },
        { id: 'I-2', title: '乙', module: 'm2' },
      ])
      await kb.generateBookStructure({ layer: 'global', book: 'idem' })
      const dir = bookDir(kb, 'global', 'idem')
      const paths = [
        join(dir, '_modules.yaml'),
        join(dir, '_summary.md'),
        join(dir, 'm1', '_summary.md'),
        join(dir, 'm2', '_summary.md'),
      ]
      const first = paths.map((p) => readFileSync(p, 'utf-8'))
      const revisionBefore = (await kb.bookStructure('global', 'idem'))?.revision

      const again = await kb.generateBookStructure({ layer: 'global', book: 'idem' })
      const second = paths.map((p) => readFileSync(p, 'utf-8'))

      expect(second).toEqual(first) // 逐字节一致
      expect(again.structure.revision).toBe(revisionBefore) // revision 不递增
      const rows = kb.persistence.knowledge.raw
        .prepare('SELECT COUNT(*) AS c FROM book_structures WHERE layer = ? AND book = ?')
        .get('global', 'idem') as { c: number }
      expect(rows.c).toBe(1) // upsert 而非重复插入
    } finally {
      kb.close()
    }
  })

  it('模块级 _summary.md 的计数与 tree() 一致', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'counts', [
        { id: 'C-1', title: '甲', module: 'm1' },
        { id: 'C-2', title: '乙', module: 'm1' },
        { id: 'C-3', title: '丙' },
      ])
      await kb.generateBookStructure({ layer: 'global', book: 'counts' })

      const node = (await kb.tree('global')).find((n) => n.book === 'counts')!
      const fromTree = new Map(node.modules.map((m) => [m.name, m.count]))
      expect(fromTree.get('m1')).toBe(2)
      expect(fromTree.get(INBOX_DIR)).toBe(1)

      const structure = (await kb.bookStructure('global', 'counts'))!
      for (const module of structure.suggested) {
        expect(fromTree.get(module.slug)).toBe(module.entries)
      }
    } finally {
      kb.close()
    }
  })
})

describe('书结构固化（F-A1：freeze 校验 + revision+1 + 写文件与表）', () => {
  it('freeze 通过：revision+1、frozen_at/confirmed_by 落文件与表；generate 不再改冻结清单', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'frozen', [
        { id: 'F-1', title: '甲', module: 'm1' },
        { id: 'F-2', title: '乙', module: 'm2' },
      ])
      await kb.generateBookStructure({ layer: 'global', book: 'frozen' })
      const frozen = await kb.freezeBookStructure({
        layer: 'global',
        book: 'frozen',
        modules: ['m1'],
        confirmed_by: 'dev-1',
      })
      expect(frozen.revision).toBe(1)
      expect(frozen.modules).toEqual(['m1'])
      expect(frozen.frozen_at).not.toBeNull()
      expect(frozen.confirmed_by).toBe('dev-1')

      const yaml = readModules(kb, 'global', 'frozen')
      expect(yaml['modules']).toEqual(['m1'])
      expect(yaml['revision']).toBe(1)
      expect(yaml['confirmed_by']).toBe('dev-1')

      // 读回：文件与表一致
      const readBack = (await kb.bookStructure('global', 'frozen'))!
      expect(readBack.revision).toBe(1)
      expect(readBack.modules).toEqual(['m1'])
      expect(readBack.confirmed_by).toBe('dev-1')
      expect(readBack.suggested).toEqual([
        { slug: 'm1', entries: 1 },
        { slug: 'm2', entries: 1 },
      ])

      // 再 generate：不覆盖冻结清单、不递增 revision
      const regenerated = await kb.generateBookStructure({ layer: 'global', book: 'frozen' })
      expect(regenerated.structure.modules).toEqual(['m1'])
      expect(regenerated.structure.revision).toBe(1)
      expect(readFileSync(join(bookDir(kb, 'global', 'frozen'), '_modules.yaml'), 'utf-8')).toBe(
        readFileSync(join(bookDir(kb, 'global', 'frozen'), '_modules.yaml'), 'utf-8'),
      )
      expect(readModules(kb, 'global', 'frozen')['modules']).toEqual(['m1']) // 未被建议清单覆盖
    } finally {
      kb.close()
    }
  })

  it('freeze 省略 modules → 接受推导建议（_inbox 不作模块）', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'accept', [
        { id: 'A-1', title: '甲', module: 'm1' },
        { id: 'A-2', title: '乙', module: 'm2' },
        { id: 'A-3', title: '未归类' },
      ])
      await kb.generateBookStructure({ layer: 'global', book: 'accept' })
      const frozen = await kb.freezeBookStructure({ layer: 'global', book: 'accept' })
      expect(frozen.modules).toEqual(['m1', 'm2'])
    } finally {
      kb.close()
    }
  })

  it('校验：非法 slug / 保留名 _inbox / 无条目书 → bad_request', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'bad', [{ id: 'B-1', title: '甲', module: 'm1' }])
      await kb.generateBookStructure({ layer: 'global', book: 'bad' })

      await expect(
        kb.freezeBookStructure({ layer: 'global', book: 'bad', modules: ['Bad_Slug'] }),
      ).rejects.toMatchObject({ code: 'bad_request' })
      await expect(
        kb.freezeBookStructure({ layer: 'global', book: 'bad', modules: ['ok-1', INBOX_DIR] }),
      ).rejects.toMatchObject({ code: 'bad_request' })
      await expect(
        kb.freezeBookStructure({ layer: 'global', book: 'bad', modules: [] }),
      ).rejects.toMatchObject({ code: 'bad_request' })

      // 无条目书：先有结构文件（generate 过），条目被清掉 → 拒绝冻结
      kb.persistence.knowledge.raw.prepare('DELETE FROM knowledge_entries WHERE book = ?').run('bad')
      await expect(kb.freezeBookStructure({ layer: 'global', book: 'bad' })).rejects.toMatchObject({
        code: 'bad_request',
      })
    } finally {
      kb.close()
    }
  })

  it('project 层：owner 由条目推导，落 <layer>/<owner>/<book>/', async () => {
    const kb = makeService()
    try {
      await kb.deposit({
        id: 'P-1',
        title: '项目条目',
        type: 'doc',
        layer: 'project',
        owner: 'proj-a',
        book: 'pbook',
        module: 'm1',
        content: '项目条目正文。',
      })
      const { files } = await kb.generateBookStructure({ layer: 'project', book: 'pbook' })
      expect(files[0]).toBe(join(kb.knowledgeDir, 'project', 'proj-a', 'pbook', '_modules.yaml'))
      expect(existsSync(files[0]!)).toBe(true)
      const structure = await kb.bookStructure('project', 'pbook')
      expect(structure?.layer).toBe('project')
      expect(structure?.suggested).toEqual([{ slug: 'm1', entries: 1 }])
    } finally {
      kb.close()
    }
  })

  it('不存在/无法定位的书 → bookStructure null；generate → bad_request', async () => {
    const kb = makeService()
    try {
      expect(await kb.bookStructure('global', 'nope')).toBeNull()
      expect(await kb.bookStructure('project', 'nope')).toBeNull()
      await expect(kb.generateBookStructure({ layer: 'global', book: 'nope' })).rejects.toMatchObject({
        code: 'bad_request',
      })
      await expect(kb.bookStructure('bogus', 'nope')).rejects.toMatchObject({ code: 'bad_request' })
    } finally {
      kb.close()
    }
  })
})

describe('书结构继承（F-A2：只读合并 / 环 / 缺父 / 多层）', () => {
  async function seedParent(kb: PrismKnowledgeService, book: string, modules: string[]): Promise<void> {
    await seedBook(
      kb,
      book,
      modules.map((module, i) => ({ id: `${book.toUpperCase()}-${i}`, title: `${module} 条目`, module })),
    )
    await kb.generateBookStructure({ layer: 'global', book })
    await kb.freezeBookStructure({ layer: 'global', book, modules })
  }

  it('正例：父 3 模块 + 本地覆盖其中 1 + 新增 1 → 并集去重且父在前', async () => {
    const kb = makeService()
    try {
      await seedParent(kb, 'parent', ['a', 'b', 'c'])
      await seedBook(kb, 'child', [{ id: 'CH-1', title: '子条目', module: 'b' }])
      await kb.generateBookStructure({ layer: 'global', book: 'child' })
      // 人工声明继承（文件为真相）
      writeModules(kb, 'global', 'child', ['b', 'x'], ['global/parent'], 2)

      const structure = (await kb.bookStructure('global', 'child'))!
      expect(structure.modules).toEqual(['a', 'b', 'c', 'x']) // 父在前 + 本地新增；b 不重复
      expect(structure.inherits).toEqual(['global/parent'])
      expect(structure.inherited_from).toEqual(['global/parent'])
      expect(structure.revision).toBe(2)
    } finally {
      kb.close()
    }
  })

  it('多层继承（孙）：inherited_from 父在前（根 → 叶）', async () => {
    const kb = makeService()
    try {
      await seedParent(kb, 'root', ['r1', 'r2'])
      await seedParent(kb, 'mid', ['m1'])
      writeModules(kb, 'global', 'mid', ['m1'], ['global/root'], 2)
      await seedBook(kb, 'leaf', [{ id: 'LF-1', title: '叶条目', module: 'l1' }])
      await kb.generateBookStructure({ layer: 'global', book: 'leaf' })
      writeModules(kb, 'global', 'leaf', ['l1'], ['global/mid'], 1)

      const structure = (await kb.bookStructure('global', 'leaf'))!
      expect(structure.inherited_from).toEqual(['global/root', 'global/mid'])
      expect(structure.modules).toEqual(['r1', 'r2', 'm1', 'l1'])
    } finally {
      kb.close()
    }
  })

  it('环（A→B→A）→ book_inherit_invalid，消息含链路', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'a', [{ id: 'A-1', title: '甲', module: 'm' }])
      await seedBook(kb, 'b', [{ id: 'B-1', title: '乙', module: 'm' }])
      writeModules(kb, 'global', 'a', ['m'], ['global/b'])
      writeModules(kb, 'global', 'b', ['m'], ['global/a'])

      await expect(kb.bookStructure('global', 'a')).rejects.toMatchObject({
        code: 'book_inherit_invalid',
      })
      try {
        await kb.bookStructure('global', 'a')
        expect.unreachable('应抛出 book_inherit_invalid')
      } catch (error) {
        const message = (error as { message: string }).message
        expect(message).toContain('global/a')
        expect(message).toContain('global/b')
        expect(message).toContain('->')
      }
    } finally {
      kb.close()
    }
  })

  it('自继承 → book_inherit_invalid', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'self', [{ id: 'S-1', title: '甲', module: 'm' }])
      writeModules(kb, 'global', 'self', ['m'], ['global/self'])
      await expect(kb.bookStructure('global', 'self')).rejects.toMatchObject({
        code: 'book_inherit_invalid',
      })
    } finally {
      kb.close()
    }
  })

  it('缺父 / 缺层 → book_inherit_invalid，消息含缺失链路', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'orphan', [{ id: 'O-1', title: '甲', module: 'm' }])
      writeModules(kb, 'global', 'orphan', ['m'], ['global/ghost'])
      try {
        await kb.bookStructure('global', 'orphan')
        expect.unreachable('应抛出 book_inherit_invalid')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('book_inherit_invalid')
        expect((error as { message: string }).message).toContain('global/ghost')
      }

      // 不存在的 layer
      writeModules(kb, 'global', 'orphan', ['m'], ['bogus/ghost'])
      await expect(kb.bookStructure('global', 'orphan')).rejects.toMatchObject({
        code: 'book_inherit_invalid',
      })
      // 引用格式非法（段数不对）
      writeModules(kb, 'global', 'orphan', ['m'], ['global'])
      await expect(kb.bookStructure('global', 'orphan')).rejects.toMatchObject({
        code: 'book_inherit_invalid',
      })
    } finally {
      kb.close()
    }
  })

  it('父书只有条目、未冻结结构 → 视为存在（贡献空清单），不报缺父', async () => {
    const kb = makeService()
    try {
      await seedBook(kb, 'raw-parent', [{ id: 'RP-1', title: '甲', module: 'pa' }])
      await seedBook(kb, 'child2', [{ id: 'CD-1', title: '乙', module: 'cb' }])
      await kb.generateBookStructure({ layer: 'global', book: 'child2' })
      writeModules(kb, 'global', 'child2', ['cb'], ['global/raw-parent'])

      const structure = (await kb.bookStructure('global', 'child2'))!
      expect(structure.modules).toEqual(['cb'])
      expect(structure.inherited_from).toEqual(['global/raw-parent'])
    } finally {
      kb.close()
    }
  })
})
