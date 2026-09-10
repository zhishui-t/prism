import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMcpTools, handleRpcRequest, startServer, type AppHandle, type McpTool } from '../src/index.js'
import type { BookStructure } from '../src/kb/port.js'
import { MemoryKb, makeTempDir } from './helpers.js'

/**
 * 书结构暴露面（F-A1/F-A2，design-v4 §3.4）：HTTP `GET|POST /api/kb/book-structure`
 * + MCP `prism_kb_book_structure`。
 *
 * 口径基线 = CLI `prism kb structure`（t14，`packages/cli/src/commands/kb.ts`）：
 * - `show` 结构未生成/书不存在 → `not_found`（**不是** `ok(null)`／空结构）；
 * - `generate` → `{ structure, files }`；`freeze` → `BookStructure`（`revision+1`）；
 * - 字段名 snake_case 原样（`inherited_from`/`frozen_at`/`confirmed_by`）；
 * - 非法层/无条目书/非法 slug → `bad_request`（owner 消歧在知识侧：多 owner → `bad_request`）。
 *
 * 阶梯：① MemoryKb 桩锁暴露面形状与参数校验；② **真实知识服务**跑一遍（防「桩与真实
 * 服务背离」的假绿）；③ R5—落点必须全在临时 `PRISM_HOME` 下，且两入口都不接目录参数。
 */

const rpc = (method: string, params?: Record<string, unknown>, id: number | string | null = 1) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
})

async function callTool(tools: McpTool[], name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await handleRpcRequest(rpc('tools/call', { name, arguments: args }), tools)
  const result = response?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
  const text = result?.content?.[0]?.text ?? ''
  if (result?.isError === true) throw new Error(`MCP ${name} 失败: ${text}`)
  return JSON.parse(text) as unknown
}

async function callToolError(tools: McpTool[], name: string, args: Record<string, unknown>): Promise<string> {
  const response = await handleRpcRequest(rpc('tools/call', { name, arguments: args }), tools)
  const result = response?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
  expect(result?.isError).toBe(true)
  return result?.content?.[0]?.text ?? ''
}

/** 直落一条条目（省去每条用例重复字段）。 */
async function seed(kb: MemoryKb, id: string, book: string, module?: string): Promise<void> {
  await kb.deposit({
    id,
    title: id,
    type: 'rule',
    layer: 'global',
    book,
    content: `正文 ${id}`,
    ...(module !== undefined ? { module } : {}),
  })
}

// ------------------------------------------------------------------ HTTP（桩）

describe('书结构 HTTP 面（GET show / POST generate|freeze，注入 MemoryKb 桩）', () => {
  let app: AppHandle
  let base: string
  let home: string
  const kb = new MemoryKb()

  beforeAll(async () => {
    home = await makeTempDir('prism-bs-http-')
    await seed(kb, 'H-1', 'demo', 'core')
    await seed(kb, 'H-2', 'demo', 'core')
    await seed(kb, 'H-3', 'demo', 'api')
    await seed(kb, 'H-4', 'demo') // 不传 module → _inbox
    app = await startServer({ home, kb, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  const getStructure = async (query: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/kb/book-structure?${query}`)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const postAction = async (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/kb/book-structure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('show：未 generate → 404 not_found（不是 ok(null)／空结构）', async () => {
    const { status, body } = await getStructure('layer=global&book=demo')
    expect(status).toBe(404)
    expect(body).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect((body.error as { message: string }).message).toContain('尚未 generate/freeze')
  })

  it('show：书不存在 → 同样是 not_found（与 CLI 一致）', async () => {
    const { status, body } = await getStructure('layer=global&book=%E6%B2%A1%E6%9C%89%E8%BF%99%E6%9C%AC%E4%B9%A6')
    expect(status).toBe(404)
    expect((body.error as { code: string }).code).toBe('not_found')
  })

  it('show：缺 book / 非法层 → 400 bad_request', async () => {
    const missing = await getStructure('layer=global')
    expect(missing.status).toBe(400)
    expect((missing.body.error as { code: string }).code).toBe('bad_request')

    const badLayer = await getStructure('layer=bogus&book=demo')
    expect(badLayer.status).toBe(400)
    expect((badLayer.body.error as { code: string }).code).toBe('bad_request')
  })

  it('generate → {structure, files}；随后 show 可读回（suggested 降序 + _inbox 殿后）', async () => {
    const gen = await postAction({ action: 'generate', layer: 'global', book: 'demo', confirmed_by: 'dev-2' })
    expect(gen.status).toBe(200)
    expect(gen.body.ok).toBe(true)
    const value = gen.body.value as { structure: BookStructure; files: string[] }
    expect(value.structure).toMatchObject({
      layer: 'global',
      book: 'demo',
      revision: 0,
      modules: [],
      frozen_at: null,
      confirmed_by: 'dev-2',
    })
    expect(value.structure.suggested).toEqual([
      { slug: 'core', entries: 2 },
      { slug: 'api', entries: 1 },
      { slug: '_inbox', entries: 1 },
    ])
    // 桩不落文件：显式断言「未建模」的返回值，免得被当成「三份文件已生成」
    expect(value.files).toEqual([])

    const shown = await getStructure('layer=global&book=demo')
    expect(shown.status).toBe(200)
    expect((shown.body.value as BookStructure).suggested).toEqual(value.structure.suggested)
  })

  it('generate：书不存在 → 400 bad_request（真实服务/桩同口径，不静默造空结构）', async () => {
    const { status, body } = await postAction({ action: 'generate', layer: 'global', book: '不存在的书' })
    expect(status).toBe(400)
    expect((body.error as { code: string }).code).toBe('bad_request')
    expect((body.error as { message: string }).message).toContain('不存在')
  })

  it('freeze：显式 modules + confirmed_by/note → revision=1；省略 modules 再 freeze → revision=2 且沿用清单', async () => {
    const first = await postAction({
      action: 'freeze',
      layer: 'global',
      book: 'demo',
      modules: ['core'],
      confirmed_by: 'dev-2',
      note: '首冻',
    })
    expect(first.status).toBe(200)
    const frozen = first.body.value as BookStructure
    expect(frozen).toMatchObject({ layer: 'global', book: 'demo', revision: 1, modules: ['core'], confirmed_by: 'dev-2' })
    expect(frozen.frozen_at).not.toBeNull()

    // 逗号分隔字符串与数组同形（对齐 CLI `--modules a,b`）
    const second = await postAction({ action: 'freeze', layer: 'global', book: 'demo', modules: 'core, api' })
    expect((second.body.value as BookStructure)).toMatchObject({ revision: 2, modules: ['core', 'api'] })

    const third = await postAction({ action: 'freeze', layer: 'global', book: 'demo' })
    expect((third.body.value as BookStructure)).toMatchObject({ revision: 3, modules: ['core', 'api'] }) // 沿用当前清单
  })

  it('freeze：无条目书 → 400 bad_request（真实服务/桩同口径）', async () => {
    const { status, body } = await postAction({ action: 'freeze', layer: 'global', book: '空书' })
    expect(status).toBe(400)
    expect((body.error as { code: string }).code).toBe('bad_request')
  })

  it('参数非法：action 缺失/非法、缺 layer|book、modules 空或非法类型 → 400 bad_request', async () => {
    const cases: Array<Record<string, unknown>> = [
      { layer: 'global', book: 'demo' }, // 缺 action
      { action: 'bogus', layer: 'global', book: 'demo' },
      { action: 'generate', book: 'demo' }, // 缺 layer
      { action: 'generate', layer: 'global' }, // 缺 book
      { action: 'freeze', layer: 'global', book: 'demo', modules: [] },
      { action: 'freeze', layer: 'global', book: 'demo', modules: ['core', 42] },
      { action: 'freeze', layer: 'global', book: 'demo', modules: ' , ' },
      { action: 'generate', layer: 'bogus', book: 'demo' }, // 非法层
    ]
    for (const body of cases) {
      const res = await postAction(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((res.body.error as { code: string }).code, JSON.stringify(body)).toBe('bad_request')
    }
  })

  it('R5/R6：请求体里的任何宿主/知识目录参数都被忽略，落点仍由组合根决定', async () => {
    const bait = join(home, 'host-should-not-be-used')
    await mkdir(bait, { recursive: true })
    const res = await postAction({
      action: 'freeze',
      layer: 'global',
      book: 'demo',
      modules: ['core'],
      knowledge_dir: bait,
      harness_root: bait,
      dir: bait,
      path: bait,
    })
    expect(res.status).toBe(200)
    expect((res.body.value as BookStructure).book).toBe('demo')
    // 传进来的目录没有被当作落点使用（未被写入任何东西）
    expect(await readdir(bait)).toEqual([])
  })
})

// ------------------------------------------------------------------- MCP（桩）

describe('书结构 MCP 工具（prism_kb_book_structure）', () => {
  let tools: McpTool[]
  const kb = new MemoryKb()

  beforeAll(async () => {
    await seed(kb, 'M-1', 'mcpdemo', 'core')
    await seed(kb, 'M-2', 'mcpdemo', 'api')
    tools = createMcpTools({ home: await makeTempDir('prism-bs-mcp-'), kb })
  })

  it('tools/list：新工具存在，schema 含 action/layer/book/modules/confirmed_by/note（无任何目录参数）', async () => {
    const res = await handleRpcRequest(rpc('tools/list'), tools)
    const list = (res?.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools
    const tool = list.find((t) => t.name === 'prism_kb_book_structure')
    expect(tool, 'tools/list 里没有 prism_kb_book_structure').toBeDefined()
    expect(Object.keys(tool!.inputSchema.properties as Record<string, unknown>).sort()).toEqual([
      'action',
      'book',
      'confirmed_by',
      'layer',
      'modules',
      'note',
    ])
    expect(tool!.inputSchema.required).toEqual(['action', 'layer', 'book'])
    expect((tool!.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum).toEqual([
      'show',
      'generate',
      'freeze',
    ])
    expect((tool!.inputSchema.properties as Record<string, { enum?: string[] }>).layer!.enum).toEqual([
      'global',
      'project',
      'role',
    ])
    expect((tool!.inputSchema.properties as Record<string, { type?: string }>).modules!.type).toBe('array')
    // 名称里的目录参数一个都没有（R6：路径一律参数化在组合根，不暴露给调用方）
    const keys = JSON.stringify(tool!.inputSchema)
    for (const forbidden of ['dir', 'knowledge_dir', 'harness_root', 'home']) {
      expect(keys.includes(forbidden), `schema 不应出现 ${forbidden}`).toBe(false)
    }
  })

  it('show 未生成 → isError [not_found]（不是空结构）', async () => {
    const text = await callToolError(tools, 'prism_kb_book_structure', { action: 'show', layer: 'global', book: 'mcpdemo' })
    expect(text).toContain('[not_found]')
    expect(text).toContain('尚未 generate/freeze')
  })

  it('generate → {structure, files}；show 读回同形；freeze → revision+1 + confirmed_by/note', async () => {
    const generated = (await callTool(tools, 'prism_kb_book_structure', {
      action: 'generate',
      layer: 'global',
      book: 'mcpdemo',
      confirmed_by: 'dev-2',
    })) as { structure: BookStructure; files: string[] }
    expect(generated.structure).toMatchObject({ layer: 'global', book: 'mcpdemo', revision: 0, modules: [] })
    expect(generated.structure.suggested).toEqual([
      { slug: 'api', entries: 1 },
      { slug: 'core', entries: 1 },
    ])

    const shown = (await callTool(tools, 'prism_kb_book_structure', { action: 'show', layer: 'global', book: 'mcpdemo' })) as BookStructure
    expect(shown).toEqual(generated.structure)

    const frozen = (await callTool(tools, 'prism_kb_book_structure', {
      action: 'freeze',
      layer: 'global',
      book: 'mcpdemo',
      modules: ['core'],
      confirmed_by: 'dev-2',
      note: '首冻',
    })) as BookStructure
    expect(frozen).toMatchObject({ revision: 1, modules: ['core'], confirmed_by: 'dev-2' })
    expect(frozen.frozen_at).not.toBeNull()

    // 读回与 freeze 返回值一致（show 是 merge 后的口径，本地项在内）
    expect(await callTool(tools, 'prism_kb_book_structure', { action: 'show', layer: 'global', book: 'mcpdemo' })).toEqual(frozen)
  })

  it('参数非法 / 书不存在 → isError [bad_request]', async () => {
    const invalidAction = await callToolError(tools, 'prism_kb_book_structure', { action: 'bogus', layer: 'global', book: 'mcpdemo' })
    expect(invalidAction).toContain('[bad_request]')

    const missing = await callToolError(tools, 'prism_kb_book_structure', { action: 'generate', layer: 'global' })
    expect(missing).toContain('[bad_request]')

    const noBook = await callToolError(tools, 'prism_kb_book_structure', { action: 'generate', layer: 'global', book: '没有这本书' })
    expect(noBook).toContain('[bad_request]')
    expect(noBook).toContain('不存在')

    const emptyBook = await callToolError(tools, 'prism_kb_book_structure', { action: 'freeze', layer: 'global', book: '没有这本书' })
    expect(emptyBook).toContain('[bad_request]')

    const emptyModules = await callToolError(tools, 'prism_kb_book_structure', {
      action: 'freeze',
      layer: 'global',
      book: 'mcpdemo',
      modules: [],
    })
    expect(emptyModules).toContain('[bad_request]')
  })
})

// -------------------------------------------------- 真实知识服务（端到端 + R5）

describe('书结构暴露面 × 真实知识服务（@prism/knowledge，R5：落点全在临时 PRISM_HOME）', () => {
  let app: AppHandle
  let base: string
  let home: string

  beforeAll(async () => {
    home = await makeTempDir('prism-bs-real-')
    const { PrismKnowledgeService } = await import('@prism/knowledge')
    const kb = new PrismKnowledgeService({ home })
    await kb.deposit({
      id: 'R-1',
      title: '真实条目',
      type: 'rule',
      layer: 'global',
      book: 'demo',
      module: 'core',
      content: '真实服务的书结构落盘。',
    })
    app = await startServer({ home, kb, port: 0 })
    base = `http://127.0.0.1:${app.port}`
  })

  afterAll(async () => {
    await app.close()
  })

  it('show → 404；generate → 文件落在 <home> 下；show/freeze → revision 递增；不存在的书 → 400', async () => {
    const before = await fetch(`${base}/api/kb/book-structure?layer=global&book=demo`)
    expect(before.status).toBe(404)

    const genRes = await fetch(`${base}/api/kb/book-structure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate', layer: 'global', book: 'demo', confirmed_by: 'dev-2' }),
    })
    const gen = (await genRes.json()) as { ok: boolean; value: { structure: BookStructure; files: string[] } }
    expect(genRes.status).toBe(200)
    expect(gen.value.files.length).toBeGreaterThan(0)
    // R5：所有产物都在临时 home 下，且真实落盘
    for (const file of gen.value.files) {
      expect(file.startsWith(home)).toBe(true)
      expect(existsSync(file)).toBe(true)
    }
    expect(gen.value.files.some((f) => f.endsWith('_modules.yaml'))).toBe(true)
    expect(gen.value.structure.suggested).toEqual([{ slug: 'core', entries: 1 }])

    const showRes = await fetch(`${base}/api/kb/book-structure?layer=global&book=demo`)
    const show = (await showRes.json()) as { ok: boolean; value: BookStructure }
    expect(showRes.status).toBe(200)
    expect(show.value).toMatchObject({ layer: 'global', book: 'demo', revision: 0, frozen_at: null, confirmed_by: 'dev-2' })

    const freezeRes = await fetch(`${base}/api/kb/book-structure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'freeze', layer: 'global', book: 'demo', modules: ['core'], confirmed_by: 'dev-2', note: '冻结' }),
    })
    const frozen = (await freezeRes.json()) as { ok: boolean; value: BookStructure }
    expect(freezeRes.status).toBe(200)
    expect(frozen.value).toMatchObject({ revision: 1, modules: ['core'] })
    expect(frozen.value.frozen_at).not.toBeNull()

    const missing = await fetch(`${base}/api/kb/book-structure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate', layer: 'global', book: '没有这本书' }),
    })
    const missingBody = (await missing.json()) as { error: { code: string } }
    expect(missing.status).toBe(400)
    expect(missingBody.error.code).toBe('bad_request')
  })

  it('MCP 面 × 真实服务：generate 的文件清单是真实路径（供宿主消费）', async () => {
    const tools = createMcpTools({ home, kbFactory: async () => {
      const { PrismKnowledgeService } = await import('@prism/knowledge')
      return new PrismKnowledgeService({ home })
    } })
    const generated = (await callTool(tools, 'prism_kb_book_structure', {
      action: 'generate',
      layer: 'global',
      book: 'demo',
    })) as { structure: BookStructure; files: string[] }
    expect(generated.files.length).toBeGreaterThan(0)
    for (const file of generated.files) {
      expect(file.startsWith(home)).toBe(true)
      expect(existsSync(file)).toBe(true)
    }
  })
})
