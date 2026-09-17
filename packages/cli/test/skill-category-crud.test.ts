/**
 * `prism skill category add|rename|rm`（v12 F4 / SPEC-4.9 CLI 面）。
 *
 * 三动词与 HTTP 三条路由（`POST|PATCH|DELETE /api/skills/categories[/:name]`）、
 * MCP `prism_skill_category_add|rename|rm` **同名同位**，同一 `SkillCategoryStore`。
 * 本文件验 CLI 的入参风格（位置参数）、退出码、错误码回显与 `--json` envelope；
 * HTTP / MCP 侧同名语义分别在 `packages/server/test/skill-categories-crud.test.ts`
 * 与 `packages/server/test/mcp-skill-category-crud.test.ts`。
 */
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

describe('prism skill category add|rename|rm（F4 CLI）', () => {
  let tmp: string
  let home: string
  let harnessRoot: string
  let lines: string[]
  let ctx: CommandContext

  const run = async (...argv: string[]): Promise<number> => {
    lines = []
    return await runCommand(ctx, ['skill', 'category', ...argv, '--home', home, '--harness-root', harnessRoot])
  }

  const categorize = async (...argv: string[]): Promise<number> => {
    lines = []
    return await runCommand(ctx, ['skill', 'categorize', ...argv, '--home', home, '--harness-root', harnessRoot])
  }

  const categoriesFile = (): string => join(home, 'skill-categories.json')

  const onDisk = async (): Promise<{ categories: string[]; mapping: Record<string, string> }> =>
    JSON.parse(await readFile(categoriesFile(), 'utf-8')) as {
      categories: string[]
      mapping: Record<string, string>
    }

  const lastJson = <T,>(): T => JSON.parse(lines[lines.length - 1]) as T

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-skillcat-crud-cli-'))
    home = join(tmp, 'home')
    harnessRoot = join(tmp, 'zcode')
    await mkdir(home, { recursive: true })
    // 数据源与 CLI 同源（resolveDirs）——prism.yaml 显式指向临时目录，避免回落真实宿主
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\nteams_dir: ${join(home, 'teams').replaceAll('\\', '/')}\nskills_dir: ${join(harnessRoot, 'skills').replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    ctx = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home,
    }
  })

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('add：新建分类（保序，只写 categories）+ 人类可读回显', async () => {
    expect(await run('add', '质量')).toBe(0)
    expect(lines).toEqual([`已新建分类「质量」（共 1 个分类） → ${categoriesFile()}`])

    expect(await run('add', '  构建  ')).toBe(0)
    expect(lines).toEqual([`已新建分类「构建」（共 2 个分类） → ${categoriesFile()}`])
    // trim 后写入 + 保序
    expect(await onDisk()).toEqual({ categories: ['质量', '构建'], mapping: {} })
  })

  it('add --json：与其它命令同款 envelope（value = 双节 + file）', async () => {
    expect(await run('add', '测试', '--json')).toBe(0)
    const out = lastJson<{ ok: boolean; value: { categories: string[]; mapping: Record<string, string>; file: string } }>()
    expect(out.ok).toBe(true)
    expect(out.value.categories).toEqual(['质量', '构建', '测试'])
    expect(out.value.mapping).toEqual({})
    expect(out.value.file.replaceAll('\\', '/')).toBe(categoriesFile().replaceAll('\\', '/'))
  })

  it('add：重名 → 退出 1 + [id_conflict]；空名 → 退出 1 + [bad_request]（都不写盘）', async () => {
    const before = await readFile(categoriesFile(), 'utf-8')
    expect(await run('add', ' 质量 ')).toBe(1)
    expect(lines.join('\n')).toContain('[id_conflict]')
    expect(await run('add', '')).toBe(1)
    expect(lines.join('\n')).toContain('[bad_request]')
    expect(await readFile(categoriesFile(), 'utf-8')).toBe(before)
  })

  it('rename：级联改 mapping（原位替换保序）；回显跟过去的技能数', async () => {
    expect(await categorize('a-skill', 'b-skill', '--category', '质量')).toBe(0)
    expect(await run('rename', '质量', '品质')).toBe(0)
    expect(lines).toEqual([`已改名「质量」→「品质」（2 个技能跟到新名） → ${categoriesFile()}`])
    expect(await onDisk()).toEqual({
      categories: ['品质', '构建', '测试'], // 原位替换 —— 不是「删了再追加」
      mapping: { 'a-skill': '品质', 'b-skill': '品质' },
    })
  })

  it('rename：目标重名 → [id_conflict]；源不存在 → [not_found]；缺参 → 用法错误', async () => {
    expect(await run('rename', '品质', '构建')).toBe(1)
    expect(lines.join('\n')).toContain('[id_conflict]')
    expect(await run('rename', '查无此分类', 'X')).toBe(1)
    expect(lines.join('\n')).toContain('[not_found]')
    // 位置参数数量不对 → 用法错误（不落到 store）
    expect(await run('rename', '品质')).toBe(1)
    expect(lines.join('\n')).toContain('用法: prism skill category')

    expect(await onDisk()).toEqual({
      categories: ['品质', '构建', '测试'],
      mapping: { 'a-skill': '品质', 'b-skill': '品质' },
    })
  })

  it('rm：删分类并清掉指向它的 mapping 条目（组内技能回未分类）', async () => {
    expect(await run('rm', '品质')).toBe(0)
    expect(lines).toEqual([`已删除分类「品质」（组内技能回未分类） → ${categoriesFile()}`])
    expect(await onDisk()).toEqual({
      categories: ['构建', '测试'],
      mapping: {}, // 键**消失**（回未分类），不是指向空串
    })

    expect(await run('rm', '品质')).toBe(1)
    expect(lines.join('\n')).toContain('[not_found]')
  })

  it('用法守卫：缺动词 / 未知动词 → 退出 1（不写盘）；从未写过时不伪造文件', async () => {
    const before = await readFile(categoriesFile(), 'utf-8')
    expect(await run()).toBe(1)
    expect(lines.join('\n')).toContain('用法: prism skill category')
    expect(await run('list')).toBe(1)
    expect(lines.join('\n')).toContain('未知子命令: skill category list')
    expect(await readFile(categoriesFile(), 'utf-8')).toBe(before)

    const bare = await mkdtemp(join(tmpdir(), 'prism-skillcat-crud-bare-'))
    try {
      lines = []
      // 空 home：`rm` 一个不存在的分类 → not_found，且**不创建**文件
      expect(await runCommand(ctx, ['skill', 'category', 'rm', 'X', '--home', bare])).toBe(1)
      expect(lines.join('\n')).toContain('[not_found]')
      expect(existsSync(join(bare, 'skill-categories.json'))).toBe(false)
    } finally {
      await rm(bare, { recursive: true, force: true }).catch(() => {})
    }
  })
})
