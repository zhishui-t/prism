/**
 * MCP 技能分类**清单**三动作（v12 F4 / SPEC-4.9）：`prism_skill_category_add|rename|rm`。
 *
 * 三动作与 HTTP 三条路由（`POST|PATCH|DELETE /api/skills/categories[/:name]`，见
 * `skill-categories-crud.test.ts`）、CLI `prism skill category add|rename|rm`
 * （见 `packages/cli/test/skill-category-crud.test.ts`）**同名同位**，
 * 三面共用同一 `SkillCategoryStore`——本文件验的是**经 MCP 通道**的错误码与响应形状。
 */
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMcpTools, handleRpcRequest, type JsonRpcResponse } from '../src/mcp/server.js'

function rpc(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> } {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
}

function textOf(response: JsonRpcResponse | null): string {
  const content = (response?.result as { content?: Array<{ text?: string }> } | undefined)?.content
  return content?.[0]?.text ?? ''
}

describe('MCP 技能分类清单三动作（v12 F4：skill_category_add / rename / rm）', () => {
  let tmp: string
  let home: string
  let tools: ReturnType<typeof createMcpTools>

  const categoriesFile = (): string => join(home, 'skill-categories.json')

  const call = (name: string, args: Record<string, unknown>) =>
    handleRpcRequest(rpc(700, 'tools/call', { name, arguments: args }), tools)

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-mcp-skillcat-'))
    home = join(tmp, 'home')
    await mkdir(home, { recursive: true })
    // 数据源与 CLI / HTTP 同源：prism.yaml 指到临时区，绝不碰真实宿主
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\nteams_dir: ${join(home, 'teams').replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    tools = createMcpTools({
      home,
      harnessRoot: join(tmp, 'zcode'),
      kbFactory: async () => {
        throw new Error('本测试不消费 kb')
      },
    })
  })

  afterAll(async () => {
    tools.close?.()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('add：登记分类名（保序，只写 categories 不写 mapping）', async () => {
    const first = await call('prism_skill_category_add', { name: '质量' })
    expect(first?.result).toMatchObject({ isError: false })
    expect(JSON.parse(textOf(first))).toEqual({ categories: ['质量'], mapping: {} })

    const second = await call('prism_skill_category_add', { name: '  构建  ' })
    expect(second?.result).toMatchObject({ isError: false })
    // trim 后写入 + 保序（追加在末尾）
    expect(JSON.parse(textOf(second))).toEqual({ categories: ['质量', '构建'], mapping: {} })

    // 落盘形 = 双节（与 store / HTTP / CLI 一致）
    expect(JSON.parse(await readFile(categoriesFile(), 'utf-8'))).toEqual({
      categories: ['质量', '构建'],
      mapping: {},
    })
  })

  it('add：重名 → id_conflict；空名 / 非字符串 → bad_request（都不写盘）', async () => {
    const dup = await call('prism_skill_category_add', { name: ' 质量 ' })
    expect(dup?.result).toMatchObject({ isError: true })
    expect(textOf(dup)).toContain('id_conflict')

    for (const name of ['', '   ', 42, undefined, {}]) {
      const bad = await call('prism_skill_category_add', { name })
      expect(bad?.result, `name=${JSON.stringify(name)}`).toMatchObject({ isError: true })
      expect(textOf(bad)).toContain('bad_request')
    }
    const onDisk = JSON.parse(await readFile(categoriesFile(), 'utf-8')) as { categories: string[] }
    expect(onDisk.categories).toEqual(['质量', '构建'])
  })

  it('rename：{from,to} 级联改 mapping；分类原位替换保序', async () => {
    // 先造两条映射：a-skill → 质量，b-skill → 构建
    const c1 = await call('prism_skill_categorize', { names: ['a-skill'], category: '质量' })
    expect(c1?.result).toMatchObject({ isError: false })
    const c2 = await call('prism_skill_categorize', { names: ['b-skill'], category: '构建' })
    expect(c2?.result).toMatchObject({ isError: false })

    const res = await call('prism_skill_category_rename', { from: '质量', to: '品质' })
    expect(res?.result).toMatchObject({ isError: false })
    expect(JSON.parse(textOf(res))).toEqual({
      categories: ['品质', '构建'], // 原位替换——不是「删了再追加」
      mapping: { 'a-skill': '品质', 'b-skill': '构建' },
    })
    expect(JSON.parse(await readFile(categoriesFile(), 'utf-8'))).toEqual({
      categories: ['品质', '构建'],
      mapping: { 'a-skill': '品质', 'b-skill': '构建' },
    })
  })

  it('rename：目标重名 → id_conflict；源不存在 → not_found；空名 → bad_request；from===to 幂等', async () => {
    const dup = await call('prism_skill_category_rename', { from: '品质', to: '构建' })
    expect(dup?.result).toMatchObject({ isError: true })
    expect(textOf(dup)).toContain('id_conflict')

    const miss = await call('prism_skill_category_rename', { from: '查无此分类', to: 'X' })
    expect(miss?.result).toMatchObject({ isError: true })
    expect(textOf(miss)).toContain('not_found')

    for (const args of [{ from: '', to: 'X' }, { from: '品质', to: '' }, { from: '品质' }, {}]) {
      const bad = await call('prism_skill_category_rename', args)
      expect(bad?.result, JSON.stringify(args)).toMatchObject({ isError: true })
      expect(textOf(bad)).toContain('bad_request')
    }

    // from === to（trim 后）→ 幂等 no-op，不算重名冲突
    const same = await call('prism_skill_category_rename', { from: '品质', to: ' 品质 ' })
    expect(same?.result).toMatchObject({ isError: false })
    expect((JSON.parse(textOf(same)) as { categories: string[] }).categories).toEqual(['品质', '构建'])
  })

  it('rm：删分类并清掉指向它的 mapping 条目（组内技能回未分类）；不存在 → not_found', async () => {
    const res = await call('prism_skill_category_rm', { name: '构建' })
    expect(res?.result).toMatchObject({ isError: false })
    expect(JSON.parse(textOf(res))).toEqual({
      categories: ['品质'],
      // 键**消失**（回未分类），不是指向空串
      mapping: { 'a-skill': '品质' },
    })

    const miss = await call('prism_skill_category_rm', { name: '构建' })
    expect(miss?.result).toMatchObject({ isError: true })
    expect(textOf(miss)).toContain('not_found')

    const empty = await call('prism_skill_category_rm', { name: '  ' })
    expect(empty?.result).toMatchObject({ isError: true })
    expect(textOf(empty)).toContain('bad_request')
  })

  it('三动作的工具名与 schema 就位（与 HTTP 三路由 / CLI 三动词同名同位）', async () => {
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect([...byName.keys()].filter((n) => n.startsWith('prism_skill_category_'))).toEqual([
      'prism_skill_category_add',
      'prism_skill_category_rename',
      'prism_skill_category_rm',
    ])
    const required = (name: string): string[] =>
      (byName.get(name)!.inputSchema as { required: string[] }).required
    expect(required('prism_skill_category_add')).toEqual(['name'])
    expect(required('prism_skill_category_rename')).toEqual(['from', 'to'])
    expect(required('prism_skill_category_rm')).toEqual(['name'])
  })
})
