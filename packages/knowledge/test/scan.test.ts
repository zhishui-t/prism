import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '../src/service.js'
import { extractTitle, idFromRel, moduleFromRel } from '../../server/src/kb/scan.js'
import { makeTempDir } from '../../server/test/helpers.js'

/** 建一个临时项目，写入给定文件（路径 → 内容）。 */
async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir('prism-scan-')
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content, 'utf-8')
  }
  return root
}

function makeKb(home: string): PrismKnowledgeService {
  return new PrismKnowledgeService({ home })
}

describe('引用型索引 kb.index()（A3）', () => {
  it('新建 → created；源未变 → unchanged；源变了 → updated', async () => {
    const home = await makeTempDir('prism-idx-')
    const kb = makeKb(home)
    const base = {
      id: 'IDX-a',
      title: '文档 A',
      layer: 'project' as const,
      owner: 'proj',
      book: 'proj',
      path: 'D:/x/a.md',
      content: '内容',
    }

    expect((await kb.index({ ...base, source_hash: 'h1' })).action).toBe('created')
    expect((await kb.index({ ...base, source_hash: 'h1' })).action).toBe('unchanged')
    expect((await kb.index({ ...base, source_hash: 'h2' })).action).toBe('updated')
    kb.close()
  })

  it('引用型条目不写副本、path 指向原件、origin=indexed', async () => {
    const home = await makeTempDir('prism-idx-')
    const kb = makeKb(home)
    await kb.index({
      id: 'IDX-a',
      title: '文档 A',
      layer: 'project',
      owner: 'proj',
      book: 'proj',
      path: 'D:/project/README.md',
      source_hash: 'h1',
      content: '正文',
    })
    const entry = await kb.get('IDX-a')
    expect(entry?.origin).toBe('indexed')
    expect(entry?.path).toBe('D:/project/README.md')
    expect(entry?.source_hash).toBe('h1')
    // 未在 knowledgeDir 下生成任何版次文件
    expect(entry?.version).toBe(1)
    kb.close()
  })

  it('同 id 位置冲突 → id_conflict', async () => {
    const home = await makeTempDir('prism-idx-')
    const kb = makeKb(home)
    await kb.index({ id: 'IDX-a', title: 'A', layer: 'project', owner: 'p1', book: 'p1', path: 'D:/a', source_hash: 'h', content: 'x' })
    await expect(
      kb.index({ id: 'IDX-a', title: 'A', layer: 'project', owner: 'p2', book: 'p2', path: 'D:/b', source_hash: 'h', content: 'x' }),
    ).rejects.toMatchObject({ code: 'id_conflict' })
    kb.close()
  })

  it('引用型条目可被检索（FTS 索引生效）', async () => {
    const home = await makeTempDir('prism-idx-')
    const kb = makeKb(home)
    await kb.index({
      id: 'IDX-a',
      title: '订单规则',
      layer: 'project',
      owner: 'proj',
      book: 'proj',
      path: 'D:/a.md',
      source_hash: 'h',
      content: '禁止吞掉异常，金额超过一千需要审核。',
    })
    const hits = await kb.search({ q: '审核' })
    expect(hits.length).toBe(1)
    expect(hits[0]?.id).toBe('IDX-a')
    kb.close()
  })
})

describe('扫描辅助函数（A3）', () => {
  it('moduleFromRel 压平多层目录为单段名', () => {
    expect(moduleFromRel('README.md')).toBe('')
    expect(moduleFromRel('docs/rules.md')).toBe('docs')
    expect(moduleFromRel('docs/order/rules.md')).toBe('docs-order')
    expect(moduleFromRel('a.b/c.md')).toBe('a_b')
  })

  it('idFromRel 稳定且只含单段合法字符', () => {
    expect(idFromRel('docs/order/rules.md')).toBe('IDX-docs-order-rules')
    expect(idFromRel('docs/order/rules.md')).toBe(idFromRel('docs/order/rules.md'))
    expect(idFromRel('a/b.md')).not.toContain('/')
  })

  it('extractTitle 取首个一级标题，缺失回落文件名', () => {
    expect(extractTitle('# 标题\n正文', 'fallback')).toBe('标题')
    expect(extractTitle('正文无标题', 'fallback')).toBe('fallback')
  })
})

describe('scanProject 端到端（A3）', () => {
  it('扫描目录：忽略 node_modules、跳过不支持格式、幂等', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({
      'README.md': '# 订单平台\n\n总体说明。',
      'docs/order/rules.md': '# 订单规则\n\n禁止吞异常。',
      'docs/image.png': 'binary-ish',
      'node_modules/skip.md': '# 应被忽略',
    })
    const home = await makeTempDir('prism-scan-home-')
    const kb = makeKb(home)

    const first = await scanProject(kb, { root, owner: 'proj', book: 'proj' })
    expect(first.discovered).toBe(2) // 只 .md（png 不支持、node_modules 忽略）
    expect(first.created).toBe(2)
    expect(first.skipped).toBe(0)

    const second = await scanProject(kb, { root, owner: 'proj', book: 'proj' })
    expect(second.created).toBe(0)
    expect(second.unchanged).toBe(2)
    kb.close()
  })

  it('源文件变更后重扫 → updated', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({ 'a.md': '# A\n\n旧内容。' })
    const home = await makeTempDir('prism-scan-home-')
    const kb = makeKb(home)
    await scanProject(kb, { root, owner: 'p', book: 'p' })

    await writeFile(join(root, 'a.md'), '# A\n\n新内容。', 'utf-8')
    const again = await scanProject(kb, { root, owner: 'p', book: 'p' })
    expect(again.updated).toBe(1)
    kb.close()
  })

  it('超大文件被跳过（不读入内存）', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({ 'big.md': `# 大文件\n\n${'x'.repeat(2000)}` })
    const home = await makeTempDir('prism-scan-home-')
    const kb = makeKb(home)
    const report = await scanProject(kb, { root, owner: 'p', book: 'p', maxFileBytes: 100 })
    expect(report.skipped).toBe(1)
    expect(report.files[0]?.reason).toContain('过大')
    kb.close()
  })
})

/** 回归：引用型条目正文必须取转换结果，不能读二进制原件。 */
describe('引用型正文读取（二进制原件）', () => {
  it('path 指向二进制文件时，get/search 返回转换后的内容而非原始字节', async () => {
    const { PrismKnowledgeService } = await import('../src/service.js')
    const { makeTempDir } = await import('../../server/test/helpers.js')
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-idx-body-') })

    // 模拟 docx：path 指向不存在的二进制文件，正文只存在于索引里
    await kb.index({
      id: 'IDX-doc',
      title: '规格说明',
      layer: 'project',
      owner: 'p',
      book: 'p',
      path: 'D:/proj/spec.docx',
      source_hash: 'h',
      content: '转换后的中文内容，含关键词 契约',
    })

    const entry = await kb.get('IDX-doc')
    expect(entry?.content).toContain('契约')
    expect(entry?.content).not.toContain('PK')

    const hits = await kb.search({ q: '契约' })
    expect(hits[0]?.excerpt).toContain('契约')
    kb.close()
  })
})

/** 生产级：源文件消失时报告孤儿索引（不静默）。 */
describe('孤儿索引检测', () => {
  it('源文件被删除后重扫 → missing 列出该条目，索引保留', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const { rm } = await import('node:fs/promises')
    const root = await makeProject({ 'a.md': '# A', 'b.md': '# B' })
    const home = await makeTempDir('prism-missing-')
    const kb = makeKb(home)

    await scanProject(kb, { root, owner: 'p', book: 'p' })
    await rm(join(root, 'b.md'))

    const report = await scanProject(kb, { root, owner: 'p', book: 'p' })
    expect(report.missing).toContain('IDX-b')
    // 索引保留（软处理，不自动删——删除是人的决定）
    expect(await kb.get('IDX-b')).not.toBeNull()
    kb.close()
  })
})

/** 扫描范围：读项目根 `.gitignore`（2026-09-14 用户诉求「被忽略的文件夹要真的忽略掉」）。 */
describe('扫描尊重 .gitignore', () => {
  it('默认读根 .gitignore：忽略其中的目录与文件，并计数上报', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({
      '.gitignore': '# 构建与私有\n\ngenerated/\nprivate.md\n',
      'README.md': '# 项目\n\n说明。',
      'docs/rules.md': '# 规则\n\n禁止吞异常。',
      'generated/out.md': '# 构建产物\n\n不该被索引。',
      'generated/deep/nested.md': '# 更深一层',
      'private.md': '# 私有\n\n不该被索引。',
      'node_modules/x.md': '# 依赖\n\n内置忽略仍然生效。',
    })
    const home = await makeTempDir('prism-gitignore-')
    const kb = makeKb(home)

    const report = await scanProject(kb, { root, owner: 'p', book: 'p' })
    expect(report.discovered).toBe(2) // README.md + docs/rules.md
    expect(report.ignored_dirs).toEqual(['generated'])
    expect(report.ignored_files).toBe(1) // private.md
    kb.close()
  })

  it('`!` 取反可把文件捞回来', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({
      '.gitignore': 'notes/*.md\n!notes/keep.md\n',
      'notes/skip.md': '# 跳过',
      'notes/keep.md': '# 保留',
    })
    const home = await makeTempDir('prism-gitignore-neg-')
    const kb = makeKb(home)

    const report = await scanProject(kb, { root, owner: 'p', book: 'p' })
    expect(report.discovered).toBe(1)
    expect(report.files.map((f) => f.rel)).toContain('notes/keep.md')
    expect(report.ignored_files).toBe(1)
    kb.close()
  })

  it('多级叠加：子目录 .gitignore 生效，且不外溢到别的子树', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({
      '.gitignore': 'root-only.md\n',
      'README.md': '# 项目',
      'root-only.md': '# 根级忽略',
      // 用 artifacts/ 而非 build/：后者在 DEFAULT_IGNORE_DIRS 里，属内置忽略、不计入 .gitignore 报告
      'pkg/.gitignore': 'local.md\nartifacts/\n',
      'pkg/local.md': '# 子包忽略',
      'pkg/keep.md': '# 保留',
      'pkg/artifacts/out.md': '# 产物',
      'other/local.md': '# 同名文件：pkg 的规则管不到这里',
    })
    const home = await makeTempDir('prism-gitignore-multi-')
    const kb = makeKb(home)

    const report = await scanProject(kb, { root, owner: 'p', book: 'p' })
    const rels = report.files.map((f) => f.rel)
    expect(rels).toContain('README.md')
    expect(rels).toContain('pkg/keep.md')
    expect(rels).toContain('other/local.md') // 子目录规则不外溢
    expect(rels).not.toContain('root-only.md')
    expect(rels).not.toContain('pkg/local.md')
    expect(rels).not.toContain('pkg/artifacts/out.md')
    expect(report.ignored_dirs).toEqual(['pkg/artifacts'])
    expect(report.ignored_files).toBe(2) // root-only.md + pkg/local.md
    kb.close()
  })

  it('深层「没意见」不覆盖浅层的忽略判定', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({
      '.gitignore': 'secrets/\n',
      'sub/.gitignore': 'notes.md\n',
      'sub/notes.md': '# 子层忽略',
      'secrets/key.md': '# 根层忽略',
      'sub/secrets/key.md': '# 子层的 .gitignore 压根没提它，根层判定必须保留',
    })
    const home = await makeTempDir('prism-gitignore-layer-')
    const kb = makeKb(home)

    const report = await scanProject(kb, { root, owner: 'p', book: 'p' })
    const rels = report.files.map((f) => f.rel)
    expect(rels).not.toContain('sub/notes.md')
    expect(rels).not.toContain('secrets/key.md')
    expect(rels).not.toContain('sub/secrets/key.md')
    expect(report.ignored_dirs.sort()).toEqual(['secrets', 'sub/secrets'])
    kb.close()
  })

  it('子目录 .gitignore 的取反可捞回父层忽略的文件', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({
      '.gitignore': '*.tmp.md\n',
      'pkg/.gitignore': '!keep.tmp.md\n',
      'pkg/keep.tmp.md': '# 被深层取反捞回',
      'pkg/drop.tmp.md': '# 仍被根层挡下',
    })
    const home = await makeTempDir('prism-gitignore-neg2-')
    const kb = makeKb(home)

    const report = await scanProject(kb, { root, owner: 'p', book: 'p' })
    const rels = report.files.map((f) => f.rel)
    expect(rels).toContain('pkg/keep.tmp.md')
    expect(rels).not.toContain('pkg/drop.tmp.md')
    expect(report.ignored_files).toBe(1)
    kb.close()
  })

  it('respectGitignore: false → 只按内置目录名过滤，.gitignore 不生效', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({
      '.gitignore': 'generated/\n',
      'README.md': '# 项目',
      'generated/out.md': '# 产物',
    })
    const home = await makeTempDir('prism-nogi-')
    const kb = makeKb(home)

    const report = await scanProject(kb, { root, owner: 'p', book: 'p', respectGitignore: false })
    expect(report.discovered).toBe(2)
    expect(report.ignored_dirs).toEqual([])
    kb.close()
  })

  it('无 .gitignore → 行为与从前一致（零忽略）', async () => {
    const { scanProject } = await import('../../server/src/kb/scan.js')
    const root = await makeProject({ 'a.md': '# A', 'b/c.md': '# C' })
    const home = await makeTempDir('prism-nogifile-')
    const kb = makeKb(home)

    const report = await scanProject(kb, { root, owner: 'p', book: 'p' })
    expect(report.discovered).toBe(2)
    expect(report.ignored_dirs).toEqual([])
    expect(report.ignored_files).toBe(0)
    kb.close()
  })
})
