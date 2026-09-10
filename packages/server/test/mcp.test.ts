import { describe, expect, it } from 'vitest'

import { createMcpTools, handleRpcRequest } from '../src/mcp/server.js'
import { MemoryKb, makeTempDir } from './helpers.js'
import type { JsonRpcRequest } from '../src/mcp/server.js'

const rpc = (method: string, params?: Record<string, unknown>, id: number | string | null = 1): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
})

/** 取 tools/call 返回的文本内容（JSON 字符串）。 */
function textOf(response: Awaited<ReturnType<typeof handleRpcRequest>>): string {
  const result = response?.result as { content?: Array<{ text?: string }> } | undefined
  return result?.content?.[0]?.text ?? ''
}

describe('MCP stdio（手写 JSON-RPC，design.md §4 最小 5 工具 + design-v3 §3.4 增量 4 工具）', () => {
  it('initialize → serverInfo + capabilities', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-') })
    const res = await handleRpcRequest(rpc('initialize', { protocolVersion: '2024-11-05' }), tools)
    expect(res).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'prism-mcp' },
        capabilities: { tools: {} },
      },
    })
  })

  it('tools/list → 固定 30 个工具（kb 14 + graph 7 + role/team 6 + task 3）', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-') })
    const res = await handleRpcRequest(rpc('tools/list'), tools)
    const names = ((res?.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name)
    expect(names).toEqual([
      'prism_kb_search',
      'prism_kb_get',
      'prism_kb_deposit',
      'prism_kb_convert',
      'prism_kb_import',
      'prism_kb_enrich',
      'prism_kb_graph',
      'prism_kb_tree',
      'prism_kb_stats',
      'prism_kb_catalog',
      'prism_kb_path',
      'prism_kb_remove',
      'prism_kb_conflicts',
      'prism_kb_resolve_conflict',
      'prism_graph_query',
      'prism_graph_status',
      'prism_graph_path',
      'prism_graph_explain',
      'prism_graph_affected',
      'prism_graph_summary',
      'prism_graph_god_nodes',
      'prism_role_list',
      'prism_role_get',
      'prism_context_pack',
      'prism_role_render',
      'prism_team_get',
      'prism_team_activate',
      'prism_task_register',
      'prism_task_report',
      'prism_task_status',
    ])
  })

  it('tools/call prism_kb_graph → 邻域节点/边（id 省略返回概览）', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'M-A', title: 'A', type: 'rule', layer: 'global', book: 'h', content: 'A' })
    await kb.deposit({ id: 'M-B', title: 'B', type: 'rule', layer: 'global', book: 'h', content: 'B [[M-A]]' })
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-'), kb })
    const res = await handleRpcRequest(
      rpc('tools/call', { name: 'prism_kb_graph', arguments: { id: 'M-B' } }),
      tools,
    )
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(false)
    const value = JSON.parse(result.content[0]!.text) as {
      root: string
      edges: Array<{ from_id: string; to_id: string }>
    }
    expect(value.root).toBe('M-B')
    expect(value.edges.map((e) => `${e.from_id}->${e.to_id}`)).toContain('M-B->M-A')
  })

  it('tools/call prism_kb_search → content 文本 JSON', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ title: '性能守则', type: 'rule', layer: 'global', book: 'h', content: '含性能两字' })
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-'), kb })
    const res = await handleRpcRequest(rpc('tools/call', { name: 'prism_kb_search', arguments: { q: '性能' } }), tools)
    const result = res?.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.content[0].text) as Array<{ title: string }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0].title).toBe('性能守则')
  })

  it('tools/call 工具执行错误 → isError:true（非 JSON-RPC error）', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-') })
    const res = await handleRpcRequest(rpc('tools/call', { name: 'prism_kb_search', arguments: {} }), tools)
    expect((res?.result as { isError: boolean }).isError).toBe(true)
    expect(res?.error).toBeUndefined()
  })

  it('未知工具 → -32601', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-') })
    const res = await handleRpcRequest(rpc('tools/call', { name: 'nope' }), tools)
    expect(res?.error?.code).toBe(-32601)
  })

  it('notifications/* 不响应（返回 null）', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-') })
    const res = await handleRpcRequest(rpc('notifications/initialized'), tools)
    expect(res).toBeNull()
  })

  it('未知方法 → -32601', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-') })
    const res = await handleRpcRequest(rpc('resources/list'), tools)
    expect(res?.error?.code).toBe(-32601)
  })
})

describe('MCP 富化直付工具（prism_kb_enrich，工作队列已移除）', () => {
  it('summarize 直付 → 落 SUMMARY 条目', async () => {
    // 用真实知识服务：MemoryKb 的 deposit 不返回 action，无法验证落库动作
    const { PrismKnowledgeService } = await import('@prism/knowledge')
    const kb = new PrismKnowledgeService({ home: await makeTempDir('prism-mcp-enrich-kb-') })
    await kb.deposit({ id: 'K-1', title: '订单规则', type: 'rule', layer: 'global', book: 'b', content: '订单必须幂等。' })
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-enrich-'), kb })
    const res = await handleRpcRequest(
      rpc('tools/call', {
        name: 'prism_kb_enrich',
        arguments: {
          kind: 'summarize',
          payload: { entry_id: 'K-1', book: 'b' },
          result: { summary: '订单处理需幂等' },
          by: 'host-A',
        },
      }),
      tools,
    )
    const out = JSON.parse(textOf(res)) as { kind: string; action: string; detail: string }
    expect(out.kind).toBe('summarize')
    expect(out.action).toBe('created')
    expect(out.detail).toContain('SUMMARY-K-1')
  })

  it('diagram_ir → skipped（不回写知识库）', async () => {
    const kb = new MemoryKb()
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-enrich2-'), kb })
    const res = await handleRpcRequest(
      rpc('tools/call', {
        name: 'prism_kb_enrich',
        arguments: { kind: 'diagram_ir', payload: { entry_id: 'x' }, result: { diagram_type: 'architecture', meta: { title: 't' } } },
      }),
      tools,
    )
    expect((JSON.parse(textOf(res)) as { action: string }).action).toBe('skipped')
  })

  it('缺 payload/result → isError', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-enrich3-') })
    const res = await handleRpcRequest(rpc('tools/call', { name: 'prism_kb_enrich', arguments: { kind: 'summarize' } }), tools)
    expect(res?.result).toMatchObject({ isError: true })
  })
})
describe('MCP 任务台账工具（被动台账：register → report → status）', () => {
  it('register → report → status 端到端', async () => {
    const home = await makeTempDir('prism-mcp-task-')
    const tools = createMcpTools({ home })

    const reg = await handleRpcRequest(
      rpc('tools/call', {
        name: 'prism_task_register',
        arguments: {
          dag_id: 'dag-mcp',
          session_id: 'sess-1',
          team_id: 'core-dev',
          project_id: 'prism',
          version: 'v1',
          difficulty: 'normal',
          tasks: [
            { id: 'm1', description: '设计' },
            { id: 'm2', description: '开发', depends_on: ['m1'] },
          ],
        },
      }),
      tools,
    )
    expect(JSON.parse(textOf(reg))).toEqual({ dag_id: 'dag-mcp', tasks: 2, edges: 1 })

    const report = await handleRpcRequest(
      rpc('tools/call', { name: 'prism_task_report', arguments: { task_id: 'm1', to_status: 'RUNNING', by: 'dev-1' } }),
      tools,
    )
    expect(JSON.parse(textOf(report))).toMatchObject({ status: 'RUNNING', revision: 1 })

    const status = await handleRpcRequest(
      rpc('tools/call', { name: 'prism_task_status', arguments: { dag_id: 'dag-mcp' } }),
      tools,
    )
    const graph = JSON.parse(textOf(status)) as { edges: Array<{ from: string; to: string }>; tasks: unknown[] }
    expect(graph.edges).toEqual([{ from: 'm1', to: 'm2' }])
    expect(graph.tasks).toHaveLength(2)

    const list = await handleRpcRequest(rpc('tools/call', { name: 'prism_task_status', arguments: {} }), tools)
    const overview = JSON.parse(textOf(list)) as { tasks: unknown[]; stats: { total: number } }
    expect(overview.stats.total).toBe(2)
  })

  it('report 非法转移 → isError（状态机拒绝）', async () => {
    const home = await makeTempDir('prism-mcp-task2-')
    const tools = createMcpTools({ home })
    await handleRpcRequest(
      rpc('tools/call', {
        name: 'prism_task_register',
        arguments: {
          dag_id: 'dag-x', session_id: 's', team_id: 't', project_id: 'p', version: 'v1', difficulty: 'normal',
          tasks: [{ id: 'x1', description: 'X' }],
        },
      }),
      tools,
    )
    const bad = await handleRpcRequest(
      rpc('tools/call', { name: 'prism_task_report', arguments: { task_id: 'x1', to_status: 'COMPLETED', by: 'x' } }),
      tools,
    )
    expect(bad?.result).toMatchObject({ isError: true })
    expect(textOf(bad)).toContain('invalid_status_transition')
  })
})

describe('MCP 新增工具（kb stats/catalog/path/remove/conflicts/resolve）', () => {
  it('prism_kb_stats → 统计；prism_kb_remove → 软删', async () => {
    const kb = new MemoryKb()
    await kb.deposit({ id: 'M-1', title: 'T', type: 'rule', layer: 'global', book: 'b', content: 'x' })
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-new-'), kb })

    const stats = await handleRpcRequest(rpc('tools/call', { name: 'prism_kb_stats', arguments: {} }), tools)
    const statsPayload = JSON.parse((stats?.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      total?: number
      entries?: number
    }
    expect(typeof statsPayload).toBe('object')

    const removed = await handleRpcRequest(
      rpc('tools/call', { name: 'prism_kb_remove', arguments: { id: 'M-1' } }),
      tools,
    )
    const removedPayload = JSON.parse(
      (removed?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { mode: string }
    expect(removedPayload.mode).toBe('soft')
  })

  it('prism_kb_conflicts → 数组；prism_kb_path 缺参 → isError', async () => {
    const tools = createMcpTools({ home: await makeTempDir('prism-mcp-new2-'), kb: new MemoryKb() })
    const conflicts = await handleRpcRequest(
      rpc('tools/call', { name: 'prism_kb_conflicts', arguments: {} }),
      tools,
    )
    const payload = JSON.parse((conflicts?.result as { content: Array<{ text: string }> }).content[0]!.text)
    expect(Array.isArray(payload)).toBe(true)

    const bad = await handleRpcRequest(
      rpc('tools/call', { name: 'prism_kb_path', arguments: { from: 'a' } }),
      tools,
    )
    expect((bad?.result as { isError?: boolean }).isError).toBe(true)
  })
})
