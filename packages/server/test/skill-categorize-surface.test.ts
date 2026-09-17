/**
 * 技能分类 **HTTP + MCP 面**（design-v8 §3 F7 / R-v8-5）。
 *
 * 覆盖三件事：
 * 1. `GET /api/skills/categories` 全量表、`POST /api/skills/categorize` 写入、`GET /api/skills`
 *    合并 `category`（UI 分组的唯一数据源）；
 * 2. **注册顺序回归**——`/api/skills/categories` 不被 `/api/skills/:name` 吞掉；
 * 3. 交叉对账：**HTTP 写 → MCP 读**（`prism_skill_list` 合并 category）。
 *    CLI 写 → HTTP 读在 `packages/cli/test/skill-categorize.test.ts`（那里能同时起 CLI 与 server）。
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer, type AppHandle } from '../src/app.js'
import { createMcpTools, handleRpcRequest, type McpTool } from '../src/mcp/server.js'

interface SkillListItem {
  name: string
  category?: string
}

describe('技能分类 HTTP/MCP 面（design-v8 §3 F7）', () => {
  let tmp: string
  let home: string
  let harnessRoot: string
  let app: AppHandle
  let base: string
  let tools: McpTool[]

  const readJson = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const post = async (
    path: string,
    payload: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const listSkills = async (): Promise<SkillListItem[]> => {
    const { body } = await readJson('/api/skills')
    return (body.value as { skills: SkillListItem[] }).skills
  }

  const mcpSkillList = async (): Promise<{ skills: SkillListItem[] }> => {
    const response = await handleRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_skill_list', arguments: {} } }, tools)
    const text = ((response?.result as { content?: Array<{ text?: string }> }).content ?? [])[0]?.text ?? '{}'
    return JSON.parse(text) as { skills: SkillListItem[] }
  }

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-skillcat-surface-'))
    home = join(tmp, 'home')
    harnessRoot = join(tmp, 'zcode')
    await mkdir(home, { recursive: true })
    app = await startServer({ home, harnessRoot, port: 0 })
    base = `http://127.0.0.1:${app.port}`
    tools = createMcpTools({ home, harnessRoot, kbFactory: async () => { throw new Error('本测试不消费 kb') } })
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('空表起步：GET /api/skills/categories → {categories:[], mapping:{}}，GET /api/skills 无 category 键', async () => {
    const { status, body } = await readJson('/api/skills/categories')
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, value: { categories: [], mapping: {} } })

    const skills = await listSkills()
    expect(skills.map((s) => s.name)).toContain('prism')
    // 口径：映射里没有 → **不加键**（前端 `s.category ?? null`）
    expect(skills.every((s) => !('category' in s))).toBe(true)
  })

  it('POST /api/skills/categorize 写入 → GET /api/skills/categories 双节形态 + GET /api/skills 合并 category', async () => {
    const written = await post('/api/skills/categorize', { names: ['prism', 'ghost-skill'], category: '质量' })
    expect(written.status).toBe(200)
    expect(written.body).toEqual({
      ok: true,
      value: {
        category: '质量',
        updated: ['prism', 'ghost-skill'],
        cleared: [],
        // v12 F4：`categories` 变分类名数组（新分类自动登记），映射在 `mapping`
        categories: ['质量'],
        mapping: { prism: '质量', 'ghost-skill': '质量' },
      },
    })

    const all = await readJson('/api/skills/categories')
    expect(all.body).toEqual({
      ok: true,
      value: { categories: ['质量'], mapping: { prism: '质量', 'ghost-skill': '质量' } },
    })

    const skills = await listSkills()
    expect(skills.find((s) => s.name === 'prism')?.category).toBe('质量')
    // ⚠ 不校验技能存在性（R3 不做审核）：映射里的 ghost-skill 不因「不是技能」被清掉
    const cats = (all.body.value as { mapping: Record<string, string> }).mapping
    expect(cats['ghost-skill']).toBe('质量')

    // 落盘形：双节新形态 `{ categories: string[], mapping: { <技能名>: <分类> } }`
    const onDisk = JSON.parse(await readFile(join(home, 'skill-categories.json'), 'utf-8')) as unknown
    expect(onDisk).toEqual({
      categories: ['质量'],
      mapping: { prism: '质量', 'ghost-skill': '质量' },
    })
  })

  it('交叉对账：HTTP 写 → MCP 读（prism_skill_list 合并 category，同口径「没有则不加键」）', async () => {
    const listed = await mcpSkillList()
    expect(listed.skills.find((s) => s.name === 'prism')?.category).toBe('质量')
    expect(listed.skills.every((s) => ('category' in s) === (s.name === 'prism'))).toBe(true)
  })

  it('POST 省略 category = 清除；清除后 GET /api/skills 不再带 category 键（分类本身保留）', async () => {
    const cleared = await post('/api/skills/categorize', { names: ['prism'] })
    expect(cleared.status).toBe(200)
    expect(cleared.body).toEqual({
      ok: true,
      value: {
        category: null,
        updated: [],
        cleared: ['prism'],
        categories: ['质量'],
        mapping: { 'ghost-skill': '质量' },
      },
    })

    const skills = await listSkills()
    expect('category' in (skills.find((s) => s.name === 'prism') as SkillListItem)).toBe(false)

    const viaMcp = await mcpSkillList()
    expect('category' in (viaMcp.skills.find((s) => s.name === 'prism') as SkillListItem)).toBe(false)

    // 空串 category 与省略同义
    await post('/api/skills/categorize', { names: ['ghost-skill'], category: '质量' })
    const empty = await post('/api/skills/categorize', { names: ['ghost-skill'], category: '' })
    expect((empty.body.value as { mapping: Record<string, string> }).mapping).toEqual({})
  })

  it('names 空 / 非数组 → 400 bad_request（不静默成功）', async () => {
    for (const names of [[], 'prism', undefined]) {
      const res = await post('/api/skills/categorize', { names, category: 'X' })
      expect(res.status).toBe(400)
      expect((res.body.error as { code: string }).code).toBe('bad_request')
    }
    // bad_request 不落盘：上一用例留下的空分类「质量」仍在，但无任何 mapping 条目
    expect((await readJson('/api/skills/categories')).body).toEqual({
      ok: true,
      value: { categories: ['质量'], mapping: {} },
    })
  })

  it('注册顺序回归：/api/skills/categories 不被 /api/skills/:name 吞掉；单技能详情仍可达', async () => {
    // 被 :name 吞掉的表现 = 走到 skill 详情 → not_found「未知 Skill: categories」
    const categories = await readJson('/api/skills/categories')
    expect(categories.status).toBe(200)
    expect(Object.keys(categories.body.value as object)).toEqual(['categories', 'mapping'])

    const detail = await readJson('/api/skills/prism')
    expect(detail.status).toBe(200)
    expect((detail.body.value as { name: string }).name).toBe('prism')
    expect(typeof (detail.body.value as { content: string }).content).toBe('string')

    // :name 路由本身没被顶掉：未知名字仍是 not_found
    const ghost = await readJson('/api/skills/no-such-skill')
    expect(ghost.status).toBe(404)
    expect((ghost.body.error as { code: string }).code).toBe('not_found')

    // v12 F4：新增的分类写路由（`PATCH`/`DELETE /api/skills/categories/:name`）同样不被吞。
    // 被吞的表征是 405（命中 GET 的 `:name`、方法不符，路由器归 405）或 404 且
    // message 是「未知 Skill」；这里用**分类不存在**的 404 反证 handler 真跑到了
    // （只读、零副作用：不存在的分类不会被写入）。
    for (const method of ['PATCH', 'DELETE'] as const) {
      const res = await fetch(`${base}/api/skills/categories/查无此分类`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ name: 'x' }) } : {}),
      })
      expect(res.status, `${method} 应落到分类 handler`).toBe(404)
      const body = (await res.json()) as { error: { code: string; message: string } }
      expect(body.error.code).toBe('not_found')
      expect(body.error.message, `${method} 的错误来自分类 handler`).toContain('分类不存在')
    }
  })

  /**
   * F7-1 回归（黑盒 2026-09-16：外部技能分类后 UI 仍显示「未分类」）。
   *
   * 技能页分组的数据源是 `/api/skills/usage`（含**全部**内置 + 宿主已装 24 条），
   * 而 `category` 此前只并进 `/api/skills`（仅内置）→ 外部条目恒无 category。
   * 口径必须与 `/api/skills`、MCP `prism_skill_list` **完全一致**：映射里没有 → 不加键。
   */
  it('F7-1 回归：外部（宿主已装）技能分类后 /api/skills/usage 也带 category；清除后键消失', async () => {
    const external = 'spec-verify'
    // 外部技能 = 宿主 skills 目录下的子目录（安装产物形态，不写真实宿主目录）
    await mkdir(join(harnessRoot, 'skills', external), { recursive: true })

    const usageOf = async (name: string): Promise<Record<string, unknown>> => {
      const { status, body } = await readJson('/api/skills/usage')
      expect(status).toBe(200)
      const found = (body.value as Array<Record<string, unknown>>).find((s) => s.name === name)
      expect(found, `usage 里应有 ${name}`).toBeDefined()
      return found as Record<string, unknown>
    }

    // 未分类 → 不加键（不是 null / 空串）
    expect('category' in (await usageOf(external))).toBe(false)

    await post('/api/skills/categorize', { names: [external], category: '规格验证' })
    expect((await usageOf(external)).category).toBe('规格验证')
    // 内置但未分类的条目仍无键（单条合并，不是整表齐刷刷塞字段）
    expect('category' in (await usageOf('prism'))).toBe(false)

    await post('/api/skills/categorize', { names: [external] })
    expect('category' in (await usageOf(external))).toBe(false)
  })
})
