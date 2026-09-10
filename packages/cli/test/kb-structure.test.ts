/**
 * F-A1/F-A2 的 CLI 入口：`prism kb structure <show|generate|freeze>`（design-v4 §3.5 / §6 验收行）。
 *
 * 覆盖：
 * - `show`：**合并后**模块清单（父在前）+ `inherited_from` + `revision`/`frozen_at`/`confirmed_by`/`suggested`；
 * - `generate`：产 `_modules.yaml` + 书级/各模块 `_summary.md` 并打印**文件路径**；**幂等**（连续两次输出与文件逐字节一致）；
 * - `freeze`：`--modules a,b` + `--confirmed-by` → `revision+1`，省略 `--modules` 沿用当前清单；
 * - 缺参 / 非法动作 → 可执行用法提示；三者 `--json` 走 `{ok,value}` 信封。
 *
 * R5：全部落在临时 `PRISM_HOME`（`mkdtemp` + `process.env.PRISM_HOME` + `ctx.home` + `kbFactory`），
 * 不触碰真实宿主目录。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKnowledgeService } from '@prism/knowledge'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

describe('F-A1/F-A2：kb structure CLI（show / generate / freeze）', () => {
  let home: string
  let lines: string[]
  let ctx: CommandContext
  const cleanup: string[] = []
  const services: Array<{ close?: () => void }> = []
  let savedHome: string | undefined
  let service: ReturnType<typeof createKnowledgeService>

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'prism-cli-struct-'))
    cleanup.push(home)
    savedHome = process.env['PRISM_HOME']
    process.env['PRISM_HOME'] = home // R5：任何回落 prismPaths() 的路径也指向临时目录
    lines = []
    service = createKnowledgeService({ home })
    services.push(service)
    ctx = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home,
      kbFactory: async () => service,
    }
  })

  afterEach(async () => {
    for (const s of services.splice(0)) s.close?.()
    if (savedHome === undefined) delete process.env['PRISM_HOME']
    else process.env['PRISM_HOME'] = savedHome
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  const bookDir = (layer: string, book: string): string => join(home, 'knowledge', layer, book)

  /** 手写一份 `_modules.yaml`（模拟人工声明本地清单 / `inherits` —— 文件为真相，F-A2）。 */
  async function writeModules(
    layer: string,
    book: string,
    modules: string[],
    inherits: string[] = [],
    revision = 1,
  ): Promise<void> {
    const dir = bookDir(layer, book)
    await mkdir(dir, { recursive: true })
    await writeFile(
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

  /** 造一本书的条目（走 knowledge 服务直接落库，作为 CLI 测试的夹具）。 */
  async function seedBook(
    book: string,
    layout: Array<{ id: string; title: string; module?: string }>,
  ): Promise<void> {
    for (const entry of layout) {
      await service.deposit({
        id: entry.id,
        title: entry.title,
        type: 'doc',
        layer: 'global',
        book,
        ...(entry.module !== undefined ? { module: entry.module } : {}),
        content: `${entry.title} 的正文。`,
      })
    }
  }

  /** 从 CLI 输出里取 `generate` 打印的文件路径行（缩进两格）。 */
  function printedFiles(): string[] {
    return lines.filter((l) => l.startsWith('  ')).map((l) => l.trim())
  }

  function json(): { ok: boolean; value: unknown } {
    return JSON.parse(lines[lines.length - 1]!) as { ok: boolean; value: unknown }
  }

  it('generate：产 _modules.yaml + 书级/模块级 _summary.md，并打印全部文件路径', async () => {
    await seedBook('demo', [
      { id: 'D-1', title: '甲一', module: 'm1' },
      { id: 'D-2', title: '甲二', module: 'm1' },
      { id: 'D-3', title: '乙一', module: 'm2' },
      { id: 'D-4', title: '未归类' },
    ])

    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--layer', 'global', '--book', 'demo'])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('已生成书结构 global/demo')
    expect(output).toContain('5 个文件')

    const files = printedFiles()
    expect(files).toHaveLength(5)
    const dir = bookDir('global', 'demo')
    expect(files).toEqual([
      join(dir, '_modules.yaml'),
      join(dir, '_summary.md'),
      join(dir, 'm1', '_summary.md'),
      join(dir, 'm2', '_summary.md'),
      join(dir, '_inbox', '_summary.md'),
    ])
    for (const file of files) expect(existsSync(file)).toBe(true)
    expect(readFileSync(join(dir, '_summary.md'), 'utf-8')).toContain('| m1 | 2 |')
    expect(readFileSync(join(dir, 'm1', '_summary.md'), 'utf-8')).toContain('`D-1`')
  })

  it('generate 幂等：连续两次输出一致、文件逐字节一致、revision 不递增', async () => {
    await seedBook('idem', [
      { id: 'I-1', title: '甲', module: 'm1' },
      { id: 'I-2', title: '乙', module: 'm2' },
    ])

    const args = ['kb', 'structure', 'generate', '--layer', 'global', '--book', 'idem']
    expect(await runCommand(ctx, args)).toBe(0)
    const firstOut = [...lines]
    const dir = bookDir('global', 'idem')
    const paths = [
      join(dir, '_modules.yaml'),
      join(dir, '_summary.md'),
      join(dir, 'm1', '_summary.md'),
      join(dir, 'm2', '_summary.md'),
    ]
    const firstFiles = paths.map((p) => readFileSync(p, 'utf-8'))

    lines = []
    expect(await runCommand(ctx, args)).toBe(0)
    expect([...lines]).toEqual(firstOut) // 打印内容逐行一致（无时钟字段）
    expect(paths.map((p) => readFileSync(p, 'utf-8'))).toEqual(firstFiles) // 文件逐字节一致

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--layer', 'global', '--book', 'idem', '--json'])).toBe(0)
    const generated = json().value as { structure: { revision: number; modules: string[] } }
    expect(generated.structure.revision).toBe(0) // 只有 freeze 递增
    expect(generated.structure.modules).toEqual([])
  })

  it('show：合并后清单（父在前）+ inherited_from + revision/frozen_at/confirmed_by/suggested', async () => {
    // 父书：3 个模块，freeze 后 revision=1
    await seedBook('parent', [
      { id: 'PA-1', title: 'a 条目', module: 'a' },
      { id: 'PA-2', title: 'b 条目', module: 'b' },
      { id: 'PA-3', title: 'c 条目', module: 'c' },
    ])
    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--layer', 'global', '--book', 'parent'])).toBe(0)
    lines = []
    expect(
      await runCommand(ctx, [
        'kb', 'structure', 'freeze', '--layer', 'global', '--book', 'parent',
        '--modules', 'a,b,c', '--confirmed-by', 'dev-1',
      ]),
    ).toBe(0)

    // 子书：本地 1 条 + 人工声明 inherits（文件为真相）
    await seedBook('child', [{ id: 'CH-1', title: '子条目', module: 'b' }])
    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--layer', 'global', '--book', 'child'])).toBe(0)
    await writeModules('global', 'child', ['b', 'x'], ['global/parent'], 2)

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'show', '--layer', 'global', '--book', 'child'])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('global/child')
    expect(output).toContain('revision=2')
    expect(output).toContain('inherited_from: global/parent')
    expect(output).toContain('confirmed_by:   （无）')
    expect(output).toContain('frozen_at:      （未冻结）')
    expect(output).toContain('suggested:      b(1)')
    // 父在前：a → b → c → 本地新增 x（本地 b 不重复）
    const modulesLine = lines.find((l) => l.includes('modules（合并后，父在前）'))!
    expect(modulesLine).toContain('a, b, c, x')
    expect(modulesLine.indexOf('a')).toBeLessThan(modulesLine.indexOf('x'))

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'show', '--layer', 'global', '--book', 'child', '--json'])).toBe(0)
    const value = json().value as {
      modules: string[]
      inherited_from: string[]
      revision: number
      suggested: Array<{ slug: string; entries: number }>
      frozen_at: string | null
      confirmed_by: string | null
    }
    expect(value.modules).toEqual(['a', 'b', 'c', 'x'])
    expect(value.inherited_from).toEqual(['global/parent'])
    expect(value.revision).toBe(2)
    expect(value.suggested).toEqual([{ slug: 'b', entries: 1 }])
    expect(value.frozen_at).toBeNull()
    expect(value.confirmed_by).toBeNull()
  })

  it('freeze：revision+1、confirmed_by 落文件与表；省略 --modules 沿用当前清单', async () => {
    await seedBook('frozen', [
      { id: 'F-1', title: '甲', module: 'm1' },
      { id: 'F-2', title: '乙', module: 'm2' },
    ])
    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--layer', 'global', '--book', 'frozen'])).toBe(0)

    lines = []
    expect(
      await runCommand(ctx, [
        'kb', 'structure', 'freeze', '--layer', 'global', '--book', 'frozen',
        '--modules', 'm1', '--confirmed-by', 'dev-3',
      ]),
    ).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('已固化书结构 global/frozen（revision=1）')
    expect(output).toContain('modules:      m1')
    expect(output).toContain('confirmed_by: dev-3')

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'show', '--layer', 'global', '--book', 'frozen', '--json'])).toBe(0)
    const first = json().value as {
      revision: number
      modules: string[]
      confirmed_by: string | null
      frozen_at: string | null
    }
    expect(first.revision).toBe(1)
    expect(first.modules).toEqual(['m1'])
    expect(first.confirmed_by).toBe('dev-3')
    expect(first.frozen_at).not.toBeNull()

    // 二次 freeze 不传 --modules：沿用当前本地清单，revision 继续 +1
    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'freeze', '--layer', 'global', '--book', 'frozen', '--json'])).toBe(0)
    const second = json().value as { revision: number; modules: string[]; confirmed_by: string | null }
    expect(second.revision).toBe(2)
    expect(second.modules).toEqual(['m1'])
    expect(second.confirmed_by).toBe('dev-3') // 未传 --confirmed-by → 沿用既有值

    // 非法 slug → bad_request（错误码可被脚本消费）
    lines = []
    expect(
      await runCommand(ctx, [
        'kb', 'structure', 'freeze', '--layer', 'global', '--book', 'frozen', '--modules', 'Bad_Slug',
      ]),
    ).toBe(1)
    expect(lines.join('\n')).toContain('错误 [bad_request]')
  })

  it('缺参 / 非法动作 → 可执行用法提示（exit 1）', async () => {
    lines = []
    expect(await runCommand(ctx, ['kb', 'structure'])).toBe(1)
    expect(lines.join('\n')).toContain('用法: prism kb structure <show|generate|freeze>')
    expect(lines.join('\n')).toContain('示例: prism kb structure generate --layer global --book demo')

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'bogus', '--layer', 'global', '--book', 'demo'])).toBe(1)
    expect(lines.join('\n')).toContain('未知动作: bogus')
    expect(lines.join('\n')).toContain('用法: prism kb structure <show|generate|freeze>')

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'show', '--layer', 'global'])).toBe(1)
    expect(lines.join('\n')).toContain('缺少必填参数: --book <b>')

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--book', 'demo'])).toBe(1)
    expect(lines.join('\n')).toContain('缺少必填参数: --layer <l>')

    lines = []
    expect(
      await runCommand(ctx, ['kb', 'structure', 'freeze', '--layer', 'global', '--book', 'demo', '--modules', ',']),
    ).toBe(1)
    expect(lines.join('\n')).toContain('--modules 需要至少一个模块 slug')
  })

  it('show 不存在的书 → not_found（含可执行下一步提示）；层非法 → bad_request', async () => {
    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'show', '--layer', 'global', '--book', 'nope'])).toBe(1)
    const output = lines.join('\n')
    expect(output).toContain('错误 [not_found] 书结构不存在: global/nope')
    expect(output).toContain('提示: 先跑 prism kb structure generate --layer global --book nope')

    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--layer', 'bogus', '--book', 'demo'])).toBe(1)
    expect(lines.join('\n')).toContain('错误 [bad_request]')
  })

  it('generate 不存在的书 → bad_request（不静默造空结构）', async () => {
    lines = []
    expect(await runCommand(ctx, ['kb', 'structure', 'generate', '--layer', 'global', '--book', 'ghost'])).toBe(1)
    expect(lines.join('\n')).toContain('错误 [bad_request]')
  })
})
