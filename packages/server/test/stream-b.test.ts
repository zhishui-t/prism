import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMcpTools, handleRpcRequest, startServer, type AppHandle, type McpTool } from '../src/index.js'
import type { DepositInput, DepositResult, EntryVersion, KnowledgeService } from '../src/kb/port.js'
import { CORE_DEV_TEAM_MD } from '../src/roles/templates.js'
import { MemoryKb } from './helpers.js'

/**
 * 流 B（server）新增面回归：F-B1/F-B2 暴露面、F-B4、F-D2、F-E2、F-E3。
 *
 * 纪律（R5）：全部数据源落在临时目录（prism.yaml 显式指向），真实宿主零写入。
 */

const ROLE_MD = `---
name: dev-1
description: "开发角色：交付可运行增量。"
color: blue
knowledge:
  layers: [global, project]
  books: []
---

# 开发 1

## 核心契约
**交付可运行的增量。**
`

/** 只用 dev-1 一个成员（便于断言），保留工作流/沉淀/仲裁全字段。 */
const TEAM_MD = CORE_DEV_TEAM_MD.replace(
  /members:\n(?: {2}- role: .*\n {4}count: \d+\n)+/,
  'members:\n  - role: dev-1\n    count: 2\n',
).replace(/ {2}- role: (dev-2|researcher|super-dev|tester|qa-checker)\n/g, '  - role: dev-1\n')

/** 关掉沉淀的团队（F-E2 拒绝路径 / F-E3「不打扰」路径）。 */
const NO_DEPOSIT_TEAM_MD = TEAM_MD.replace('  enabled: true', '  enabled: false')

/** 记录落库入参的桩（断言策略注入的字段用）。 */
class RecordingKb extends MemoryKb {
  readonly deposited: DepositInput[] = []

  override async deposit(input: DepositInput): Promise<DepositResult> {
    this.deposited.push(JSON.parse(JSON.stringify(input)) as DepositInput)
    return await super.deposit(input)
  }
}

function rpc(
  id: number,
  method: string,
  params?: Record<string, unknown>,
): { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> } {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
}

/** tools/call 的 JSON 结果（isError 时抛，便于定位）。 */
async function callTool(tools: McpTool[], name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await handleRpcRequest(rpc(1, 'tools/call', { name, arguments: args }), tools)
  const result = response?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
  const text = result?.content?.[0]?.text ?? ''
  if (result?.isError === true) throw new Error(`MCP ${name} 失败: ${text}`)
  return JSON.parse(text) as unknown
}

/** tools/call 的错误文本（断言拒绝路径用）。 */
async function callToolError(tools: McpTool[], name: string, args: Record<string, unknown>): Promise<string> {
  const response = await handleRpcRequest(rpc(1, 'tools/call', { name, arguments: args }), tools)
  const result = response?.result as { isError?: boolean; content?: Array<{ text?: string }> } | undefined
  return result?.content?.[0]?.text ?? ''
}

describe('流 B：server 增量（F-B1/B2/B4/D2/E2/E3）', () => {
  let tmp: string
  let home: string
  let teamsDir: string
  let harnessRoot: string
  let app: AppHandle
  let base: string
  let kb: RecordingKb
  let tools: McpTool[]

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'prism-stream-b-'))
    home = join(tmp, 'home')
    teamsDir = join(home, 'teams')
    harnessRoot = join(tmp, 'zcode')
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'prism.yaml'),
      `roles_dir: ${join(home, 'roles').replaceAll('\\', '/')}\nteams_dir: ${teamsDir.replaceAll('\\', '/')}\n`,
      'utf-8',
    )
    await mkdir(join(home, 'roles', 'dev-1'), { recursive: true })
    await writeFile(join(home, 'roles', 'dev-1', 'AGENTS.md'), ROLE_MD, 'utf-8')
    await mkdir(join(teamsDir, 'core-dev'), { recursive: true })
    await writeFile(join(teamsDir, 'core-dev', 'AGENTS.md'), TEAM_MD, 'utf-8')
    await mkdir(join(teamsDir, 'no-deposit'), { recursive: true })
    await writeFile(join(teamsDir, 'no-deposit', 'AGENTS.md'), NO_DEPOSIT_TEAM_MD.replace('core-dev', 'no-deposit'), 'utf-8')

    kb = new RecordingKb()
    await kb.deposit({
      id: 'SEC-1',
      title: 'wiring.ts 装配约定',
      type: 'rule',
      layer: 'global',
      book: 'b',
      content: '改 wiring.ts 必须同步契约（security）。',
    })
    await kb.deposit({
      id: 'PRJ-1',
      title: '项目鉴权约定',
      type: 'rule',
      layer: 'project',
      owner: 'prism',
      book: 'auth',
      content: '令牌必须校验过期。',
    })

    app = await startServer({ home, harnessRoot, kb, port: 0 })
    base = `http://127.0.0.1:${app.port}`
    tools = createMcpTools({ home, harnessRoot, kb: kb satisfies KnowledgeService })
  })

  afterAll(async () => {
    await app.close()
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  })

  // ---------------------------------------------------------------- F-B4
  it('F-B4 HTTP GET /api/kb/versions/:id → {versions} 降序 + is_latest；不存在 → 空数组', async () => {
    const res = await fetch(`${base}/api/kb/versions/SEC-1`)
    const body = (await res.json()) as { ok: boolean; value: { versions: EntryVersion[] } }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.value.versions).toHaveLength(1)
    expect(body.value.versions[0]).toMatchObject({ id: 'SEC-1', version: 1, is_latest: true, title: 'wiring.ts 装配约定' })

    const missing = await fetch(`${base}/api/kb/versions/没有这个条目`)
    const missingBody = (await missing.json()) as { ok: boolean; value: { versions: EntryVersion[] } }
    expect(missing.status).toBe(200)
    expect(missingBody.value.versions).toEqual([])
  })

  it('F-B4 多版次 → 降序返回且只有最新版 is_latest', async () => {
    const multi = new RecordingKb()
    await multi.deposit({ id: 'M-1', title: 'T', type: 'doc', layer: 'global', book: 'b', content: 'v1' })
    await multi.deposit({ id: 'M-1', title: 'T', type: 'doc', layer: 'global', book: 'b', content: 'v2' })
    const tmpHome = join(tmp, 'multi-home')
    await mkdir(tmpHome, { recursive: true })
    const multiApp = await startServer({ home: tmpHome, harnessRoot, kb: multi, port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${multiApp.port}/api/kb/versions/M-1`)
      const body = (await res.json()) as { value: { versions: EntryVersion[] } }
      expect(body.value.versions.map((v) => v.version)).toEqual([2, 1])
      expect(body.value.versions.map((v) => v.is_latest)).toEqual([true, false])
    } finally {
      await multiApp.close()
    }
  })

  it('F-B4 MCP prism_kb_versions → {versions}（与 HTTP 同数据源）', async () => {
    const result = (await callTool(tools, 'prism_kb_versions', { id: 'SEC-1' })) as { versions: EntryVersion[] }
    expect(result.versions).toHaveLength(1)
    expect(result.versions[0].id).toBe('SEC-1')

    const none = (await callTool(tools, 'prism_kb_versions', { id: 'nope' })) as { versions: EntryVersion[] }
    expect(none.versions).toEqual([])
  })

  // ------------------------------------------------------- F-B1 / F-B2 HTTP
  it('F-B1/B2 HTTP GET /api/kb/context-pack 支持 layers/books/symbols/max_excerpt_chars + normalized_by', async () => {
    const url =
      `${base}/api/kb/context-pack?role=dev-1&task=${encodeURIComponent('装配约定')}` +
      `&layers=global&symbols=${encodeURIComponent('wiring.ts')}&max_excerpt_chars=8`
    const res = await fetch(url)
    const body = (await res.json()) as {
      ok: boolean
      value: {
        normalized_by: string
        items: Array<{ id: string; excerpt: string; graph_hits: string[]; relevance: number; layer: string }>
      }
    }
    expect(res.status).toBe(200)
    expect(body.value.normalized_by).toBe('candidate_max')
    const hit = body.value.items.find((i) => i.id === 'SEC-1')
    expect(hit).toBeDefined()
    expect(hit!.graph_hits).toEqual(['wiring.ts'])
    expect(hit!.excerpt.length).toBeLessThanOrEqual(8)
    expect(body.value.items.every((i) => i.layer === 'global')).toBe(true)
    expect(body.value.items.every((i) => i.relevance >= 0 && i.relevance <= 1)).toBe(true)

    // books 覆盖：binding.books=[] 但显式 books=auth → 只该出现 project/auth 条目
    const booksUrl = `${base}/api/kb/context-pack?role=dev-1&task=${encodeURIComponent('令牌')}&layers=project&books=auth`
    const booksBody = (await (await fetch(booksUrl)).json()) as { value: { items: Array<{ id: string }> } }
    expect(booksBody.value.items.map((i) => i.id)).toContain('PRJ-1')
  })

  it('F-B2 MCP prism_context_pack schema 含 symbols/layers/books/max_excerpt_chars', async () => {
    const response = await handleRpcRequest(rpc(1, 'tools/list'), tools)
    const list = (response?.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }).tools
    const pack = list.find((t) => t.name === 'prism_context_pack')!
    expect(Object.keys(pack.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['role', 'task', 'budget_tokens', 'layers', 'books', 'symbols', 'max_excerpt_chars']),
    )

    const result = (await callTool(tools, 'prism_context_pack', {
      role: 'dev-1',
      task: '装配约定',
      layers: ['global'],
      symbols: ['wiring.ts'],
      max_excerpt_chars: 8,
    })) as { normalized_by: string; items: Array<{ id: string; graph_hits: string[]; excerpt: string }> }
    expect(result.normalized_by).toBe('candidate_max')
    const hit = result.items.find((i) => i.id === 'SEC-1')!
    expect(hit.graph_hits).toEqual(['wiring.ts'])
    expect(hit.excerpt.length).toBeLessThanOrEqual(8)
  })

  it('F-B1 MCP prism_context_pack 角色不存在 → isError', async () => {
    const text = await callToolError(tools, 'prism_context_pack', { role: 'nope', task: 'x' })
    expect(text).toContain('角色不存在')
  })

  // ---------------------------------------------------------------- F-D2
  it('F-D2 HTTP GET /api/skills/effective → 有效集；角色不存在 → 404 信封', async () => {
    const res = await fetch(`${base}/api/skills/effective?role=dev-1`)
    const body = (await res.json()) as {
      ok: boolean
      value: { role: string; skills: Array<{ name: string; sources: string[]; available: boolean }>; warnings: unknown[] }
    }
    expect(res.status).toBe(200)
    expect(body.value.role).toBe('dev-1')
    expect(Array.isArray(body.value.skills)).toBe(true)
    expect(Array.isArray(body.value.warnings)).toBe(true)

    const withTeam = await fetch(`${base}/api/skills/effective?role=dev-1&team=core-dev`)
    const teamBody = (await withTeam.json()) as { value: { team?: string; skills: Array<{ name: string }> } }
    expect(teamBody.value.team).toBe('core-dev')
    // core-dev 声明了 code_review → 必须并入有效集（来源 team）
    const codeReview = teamBody.value.skills.find((s) => s.name === 'code_review')
    expect(codeReview).toBeDefined()

    const miss = await fetch(`${base}/api/skills/effective?role=nope`)
    const missBody = (await miss.json()) as { ok: boolean; error: { code: string } }
    expect(miss.status).toBe(404)
    expect(missBody).toMatchObject({ ok: false, error: { code: 'not_found' } })

    const noRole = await fetch(`${base}/api/skills/effective`)
    expect(noRole.status).toBe(400)
  })

  it('F-D2 MCP prism_skill_effective 与 HTTP 同输入同输出（同一装配点）', async () => {
    const mcp = await callTool(tools, 'prism_skill_effective', { role: 'dev-1', team: 'core-dev' })
    const http = (await (await fetch(`${base}/api/skills/effective?role=dev-1&team=core-dev`)).json()) as { value: unknown }
    expect(mcp).toEqual(http.value)
  })

  it('F-D2 MCP prism_skill_effective 团队不存在 → isError', async () => {
    const text = await callToolError(tools, 'prism_skill_effective', { role: 'dev-1', team: 'nope' })
    expect(text).toContain('团队不存在')
  })

  // ---------------------------------------------------------------- F-E2
  it('F-E2 HTTP POST /api/kb/deposit 带 team_id → 走团队策略（match{type:rule} → layer=global）', async () => {
    const before = kb.deposited.length
    const res = await fetch(`${base}/api/kb/deposit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '接口命名规范',
        type: 'rule',
        layer: 'project',
        owner: 'prism',
        book: 'handbook',
        content: '接口一律 kebab-case。',
        team_id: 'core-dev',
      }),
    })
    const body = (await res.json()) as { ok: boolean; value: { id: string; version: number } }
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    const recorded = kb.deposited[before]!
    expect(recorded.layer).toBe('global') // 团队规则把 project 覆盖为 global
    expect(recorded.type).toBe('rule')
  })

  it('F-E2 MCP prism_kb_deposit 与 HTTP 同策略同结果（同一策略函数）', async () => {
    const before = kb.deposited.length
    await callTool(tools, 'prism_kb_deposit', {
      title: '接口命名规范',
      type: 'rule',
      layer: 'project',
      owner: 'prism',
      book: 'handbook',
      content: '接口一律 kebab-case。',
      team_id: 'core-dev',
    })
    const mcpRecorded = kb.deposited[before]!
    const httpRecorded = kb.deposited[before - 1]!
    expect(mcpRecorded.layer).toBe(httpRecorded.layer)
    expect(mcpRecorded.layer).toBe('global')
    expect(mcpRecorded.type).toBe(httpRecorded.type)
  })

  it('F-E2 团队 deposit.enabled=false → 两入口都拒绝（400 / isError）', async () => {
    const res = await fetch(`${base}/api/kb/deposit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 't',
        type: 'doc',
        layer: 'global',
        book: 'b',
        content: 'c',
        team_id: 'no-deposit',
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('bad_request')
    expect(body.error.message).toContain('沉淀策略拒绝')

    const text = await callToolError(tools, 'prism_kb_deposit', {
      title: 't',
      type: 'doc',
      layer: 'global',
      book: 'b',
      content: 'c',
      team_id: 'no-deposit',
    })
    expect(text).toContain('沉淀策略拒绝')
  })

  it('F-E2 team_id 不存在 → not_found（HTTP 404）/ MCP 明确报团队不存在', async () => {
    const res = await fetch(`${base}/api/kb/deposit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', type: 'doc', layer: 'global', book: 'b', content: 'c', team_id: 'nope' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('not_found')
    // ui-spec-v4 §8-D5：报真实落点 <id>.md（旧文案只写 <id>/AGENTS.md → 用户找错路径）
    expect(body.error.message).toContain('<id>.md')
    const text = await callToolError(tools, 'prism_kb_deposit', {
      title: 't',
      type: 'doc',
      layer: 'global',
      book: 'b',
      content: 'c',
      team_id: 'nope',
    })
    expect(text).toContain('团队不存在: nope')
  })

  it('F-E2 MCP prism_kb_deposit 的 task_id/dag_id/stage → origin_task + source.kind=task', async () => {
    const before = kb.deposited.length
    await callTool(tools, 'prism_kb_deposit', {
      title: '任务沉淀',
      type: 'pitfall',
      layer: 'global',
      book: 'b',
      content: '踩坑记录。',
      task_id: 'T-9',
      dag_id: 'DAG-1',
      stage: '开发',
    })
    const recorded = kb.deposited[before]!
    expect(recorded.origin_task).toEqual({ task_id: 'T-9', dag_id: 'DAG-1', stage: '开发' })
    expect(recorded.source?.kind).toBe('task')
  })

  it('F-E2 MCP deposit schema 含 task_id/dag_id/stage 且 source.kind 枚举含 task', async () => {
    const response = await handleRpcRequest(rpc(1, 'tools/list'), tools)
    const list = (response?.result as { tools: Array<{ name: string; inputSchema: { properties?: Record<string, { enum?: string[]; properties?: Record<string, { enum?: string[] }> }> } }> }).tools
    const deposit = list.find((t) => t.name === 'prism_kb_deposit')!
    const props = deposit.inputSchema.properties!
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['task_id', 'dag_id', 'stage', 'team_id']))
    expect(props['source']?.properties?.['kind']?.enum).toContain('task')
  })

  // ---------------------------------------------------------------- F-E3
  it('F-E3 CLOSED → deposit_suggestions；COMPLETED → 仅 deposit_hint=await_close', async () => {
    await callTool(tools, 'prism_task_register', {
      dag_id: 'DAG-E3',
      session_id: 's-1',
      team_id: 'core-dev',
      project_id: 'prism',
      version: 'adhoc',
      difficulty: 'normal',
      tasks: [{ id: 'T-E3', description: '制定接口规范（规范类沉淀）', stage: '设计' }],
    })

    const running = (await callTool(tools, 'prism_task_report', {
      task_id: 'T-E3',
      to_status: 'RUNNING',
      by: 'tester',
    })) as Record<string, unknown>
    expect(running['deposit_suggestions']).toBeUndefined()
    expect(running['deposit_hint']).toBeUndefined()

    const completed = (await callTool(tools, 'prism_task_report', {
      task_id: 'T-E3',
      to_status: 'COMPLETED',
      by: 'tester',
    })) as Record<string, unknown>
    expect(completed['deposit_hint']).toBe('await_close')
    expect(completed['deposit_suggestions']).toBeUndefined()

    await callTool(tools, 'prism_task_report', { task_id: 'T-E3', to_status: 'AWAITING_FEEDBACK', by: 'tester' })
    const closed = (await callTool(tools, 'prism_task_report', {
      task_id: 'T-E3',
      to_status: 'CLOSED',
      by: 'tester',
    })) as { deposit_suggestions?: Array<{ kind: string; layer: string; priority: string; reason: string; require_note: boolean }> }
    expect(closed.deposit_suggestions).toBeDefined()
    const suggestion = closed.deposit_suggestions![0]!
    expect(suggestion.kind).toBe('rule')
    expect(suggestion.layer).toBe('global')
    expect(suggestion.priority).toBe('high')
    expect(suggestion.require_note).toBe(true)
    expect(suggestion.reason).toContain('团队规则')
  })

  it('F-E3 无团队（team_id 不在 teams 目录）→ 不返回该字段', async () => {
    await callTool(tools, 'prism_task_register', {
      dag_id: 'DAG-E3B',
      session_id: 's-1',
      team_id: 'ghost-team',
      project_id: 'prism',
      version: 'adhoc',
      difficulty: 'normal',
      tasks: [{ id: 'T-E3B', description: '随便写点', stage: '开发' }],
    })
    for (const status of ['RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK'] as const) {
      await callTool(tools, 'prism_task_report', { task_id: 'T-E3B', to_status: status, by: 'tester' })
    }
    const closed = (await callTool(tools, 'prism_task_report', {
      task_id: 'T-E3B',
      to_status: 'CLOSED',
      by: 'tester',
    })) as Record<string, unknown>
    expect(closed['deposit_suggestions']).toBeUndefined()
  })

  it('F-E3 团队 enabled=false → CLOSED 也不返回建议清单', async () => {
    await callTool(tools, 'prism_task_register', {
      dag_id: 'DAG-E3C',
      session_id: 's-1',
      team_id: 'no-deposit',
      project_id: 'prism',
      version: 'adhoc',
      difficulty: 'normal',
      tasks: [{ id: 'T-E3C', description: '规范类', stage: '开发' }],
    })
    for (const status of ['RUNNING', 'COMPLETED', 'AWAITING_FEEDBACK'] as const) {
      await callTool(tools, 'prism_task_report', { task_id: 'T-E3C', to_status: status, by: 'tester' })
    }
    const closed = (await callTool(tools, 'prism_task_report', {
      task_id: 'T-E3C',
      to_status: 'CLOSED',
      by: 'tester',
    })) as Record<string, unknown>
    expect(closed['deposit_suggestions']).toBeUndefined()
  })

  // ---------------------------------------------------------------- F-C3（MCP 面）
  it('F-C3 MCP prism_team_new 与 HTTP POST /api/teams 同实现（同校验同落盘）', async () => {
    const writeDir = join(tmp, 'mcp-teams')
    // 缺 teams_dir → 明确报错（不回落默认宿主）
    const noDir = await callToolError(tools, 'prism_team_new', {
      team_id: 'mcp-team',
      members: [{ role: 'dev-1', count: 1 }],
    })
    expect(noDir).toContain('teams_dir_required')

    const created = (await callTool(tools, 'prism_team_new', {
      team_id: 'mcp-team',
      name: 'MCP 建队',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: writeDir,
    })) as { path: string; issues: Array<{ level: string }> }
    expect(created.path.replaceAll('\\', '/')).toBe(join(writeDir, 'mcp-team.md').replaceAll('\\', '/'))

    // 与 HTTP 同一校验：非法成员同样被拒
    const bad = await callToolError(tools, 'prism_team_new', {
      team_id: 'mcp-team-2',
      members: [{ role: 'ghost', count: 1 }],
      teams_dir: writeDir,
    })
    expect(bad).toContain('member_role_unknown')

    // 已存在 → 不覆盖
    const dup = await callToolError(tools, 'prism_team_new', {
      team_id: 'mcp-team',
      members: [{ role: 'dev-1', count: 1 }],
      teams_dir: writeDir,
    })
    expect(dup).toContain('id_conflict')
  })

  it('F-E3 prism_task_report 的工具描述声明两种完成态口径（宿主可见）', async () => {
    const response = await handleRpcRequest(rpc(1, 'tools/list'), tools)
    const list = (response?.result as { tools: Array<{ name: string; description: string }> }).tools
    const report = list.find((t) => t.name === 'prism_task_report')!
    expect(report.description).toContain('deposit_suggestions')
    expect(report.description).toContain('await_close')
  })
})
