/**
 * `prism skill categorize <name...> [--category <分类>]`（design-v8 §3 F7 CLI 面）。
 *
 * 对账物（design-v8 §6 第 6 条）：**CLI 写 → HTTP 读**——CLI 落盘后，真实 server 进程的
 * `GET /api/skills`（合并 category）与 `GET /api/skills/categories`（全量表）必须看到同一份映射。
 * （HTTP 写 → MCP 读在 `packages/server/test/skill-categorize-surface.test.ts`。）
 */
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '@prism/server'

import { defaultContext, runCommand, type CommandContext } from '../src/argv.js'

describe('prism skill categorize（F7 CLI）', () => {
  let tmp: string
  let home: string
  let harnessRoot: string
  let app: AppHandle
  let base: string
  let lines: string[]
  let ctx: CommandContext

  const run = async (...argv: string[]): Promise<number> => {
    lines = []
    return await runCommand(ctx, ['skill', 'categorize', ...argv, '--home', home, '--harness-root', harnessRoot])
  }

  const categoriesFile = (): string => join(home, 'skill-categories.json')

  const readSkills = async (): Promise<Array<{ name: string; category?: string }>> => {
    const res = await fetch(`${base}/api/skills`)
    const body = (await res.json()) as { value: { skills: Array<{ name: string; category?: string }> } }
    return body.value.skills
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-skillcat-cli-'))
    home = join(tmp, 'home')
    harnessRoot = join(tmp, 'zcode')
    await mkdir(home, { recursive: true })
    // B8：数据源与 CLI 同源（resolveDirs）——prism.yaml 显式指向临时目录，避免回落真实宿主
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
    app = await startServer({ home, harnessRoot, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('CLI 写 → HTTP 读：GET /api/skills 合并 category、GET /api/skills/categories 有映射', async () => {
    expect(await run('prism', 'code-review', '--category', '质量', '--json')).toBe(0)
    const out = JSON.parse(lines[lines.length - 1]) as {
      value: { category: string; updated: string[]; cleared: string[]; categories: Record<string, string>; file: string }
    }
    expect(out.value.category).toBe('质量')
    expect(out.value.updated).toEqual(['prism', 'code-review'])
    expect(out.value.cleared).toEqual([])
    expect(out.value.categories).toEqual({ prism: '质量', 'code-review': '质量' })
    expect(out.value.file.replaceAll('\\', '/')).toBe(categoriesFile().replaceAll('\\', '/'))

    // —— HTTP 读（真实 server，同一 home）——
    const skills = await readSkills()
    expect(skills.find((s) => s.name === 'prism')?.category).toBe('质量')
    // 映射里没有的技能不加 category 键（与 MCP 同口径）
    expect(skills.filter((s) => 'category' in s).map((s) => s.name).sort()).toEqual(['prism'])

    const res = await fetch(`${base}/api/skills/categories`)
    const body = (await res.json()) as { value: { categories: Record<string, string> } }
    expect(body.value.categories).toEqual({ prism: '质量', 'code-review': '质量' })
  })

  it('人类可读回显（非 --json）：逐条 + 汇总行', async () => {
    expect(await run('a', 'b', 'c', '--category', 'X')).toBe(0)
    expect(lines).toEqual([
      '  已分类 a → X',
      '  已分类 b → X',
      '  已分类 c → X',
      `已分类 3 个技能 → X（${categoriesFile()}）`,
    ])
  })

  it('省略 --category = 清除；--category "" 与省略同义', async () => {
    expect(await run('a', 'b')).toBe(0)
    expect(lines).toEqual(['  已清除 a 的分类', '  已清除 b 的分类', `已清除 2 个技能的分类 → ${categoriesFile()}`])
    let onDisk = JSON.parse(await readFile(categoriesFile(), 'utf-8')) as Record<string, string>
    expect(onDisk).toEqual({ prism: '质量', 'code-review': '质量', c: 'X' })

    expect(await run('c', '--category', '')).toBe(0)
    onDisk = JSON.parse(await readFile(categoriesFile(), 'utf-8')) as Record<string, string>
    expect(onDisk).toEqual({ prism: '质量', 'code-review': '质量' })
  })

  it('names 必须非空：空 → 用法错误 + 退出非零，且不写盘', async () => {
    const before = await readFile(categoriesFile(), 'utf-8')
    expect(await run('--category', 'X')).toBe(1)
    expect(await run()).toBe(1)
    expect(lines.join('\n')).toContain('names 不能为空')
    expect(lines.join('\n')).toContain('用法: prism skill categorize')
    expect(await readFile(categoriesFile(), 'utf-8')).toBe(before)
  })

  it('不校验技能存在性（R3 不做审核）：不存在的技能名照写', async () => {
    expect(await run('ghost-skill', '--category', '鬼')).toBe(0)
    const onDisk = JSON.parse(await readFile(categoriesFile(), 'utf-8')) as Record<string, string>
    expect(onDisk['ghost-skill']).toBe('鬼')
    // 它不会出现在技能清单里（映射独立于技能台账）
    const skills = await readSkills()
    expect(skills.map((s) => s.name)).not.toContain('ghost-skill')
    expect(skills.every((s) => s.category !== '鬼')).toBe(true)
  })

  it('从未写过时不伪造文件（初始态）', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'prism-skillcat-cli-bare-'))
    try {
      lines = []
      const code = await runCommand(ctx, ['skill', 'categorize', '--home', bare, '--harness-root', harnessRoot])
      expect(code).toBe(1)
      expect(existsSync(join(bare, 'skill-categories.json'))).toBe(false)
    } finally {
      await rm(bare, { recursive: true, force: true }).catch(() => {})
    }
  })
})
