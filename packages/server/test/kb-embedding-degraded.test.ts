/**
 * v15 §2 / SPEC-2.4：`embedding_degraded` 的 **HTTP / MCP 透传** 与 **装配侧不误置**。
 *
 * - SPEC-2.4：真服务（mock embed 恒 null + `vectorCapable:true`）注入为 kb 端口 →
 *   `GET /api/kb/search` 与 MCP `prism_kb_search` 的响应都带 `embedding_degraded`（v13 信封
 *   additive，旧消费方无感）；MCP 工具描述补枚举（S-9 宿主可发现）。
 * - M-1 修订的**假阳性回归**：真 `loadKnowledgeService`（`PRISM_EMBEDDING=off` → 未装/禁用）
 *   不得置 `vectorCapable`，故响应**无**该字段。若有人把 wiring 改成无条件 `vectorCapable:true`，
 *   此用例即红——这正是 M-1 要堵的洞。
 *
 * 全部临时目录（R5），零真实宿主污染。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmpTag } from '@prism/core'

import { afterEach, describe, expect, it } from 'vitest'

import { PrismKnowledgeService } from '@prism/knowledge'

import { startServer } from '../src/app.js'
import { loadKnowledgeService } from '../src/kb/wiring.js'
import { createMcpTools, handleRpcRequest } from '../src/mcp/server.js'
import type { KnowledgeService, SearchResponse } from '../src/kb/port.js'

const dirs: string[] = []

async function makeHome(prefix = 'prism-kb-degraded-srv-'): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix.replace(/-$/, `-${tmpTag()}-`)))
  dirs.push(home)
  return home
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** 假活/超时/失败：恒「算不出」。 */
const deadEmbed = async (): Promise<Float32Array | null> => null

/** 造一个「能力已装但向量算不出」的真服务，并落一条可 BM25 命中的条目。 */
async function seedDegradedService(home: string): Promise<PrismKnowledgeService> {
  const kb = new PrismKnowledgeService({ home, embed: deadEmbed, vectorCapable: true })
  await kb.deposit({
    id: 'K-1',
    title: '性能守则',
    type: 'rule',
    layer: 'global',
    book: 'h',
    module: '',
    content: '遇到性能问题先量化，再做优化。',
  })
  return kb
}

describe('v15 SPEC-2.4：embedding_degraded 经 HTTP / MCP 透传', () => {
  it('HTTP GET /api/kb/search 带 embedding_degraded:true（且结果照常）', async () => {
    const home = await makeHome()
    const kb = await seedDegradedService(home)
    const app = await startServer({ home, kb, port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${app.port}/api/kb/search?q=${encodeURIComponent('性能')}`)
      const body = (await res.json()) as { ok: boolean; value: SearchResponse }
      expect(body.ok).toBe(true)
      expect(body.value.embedding_degraded).toBe(true)
      // 降级不吞结果：纯 BM25 照常命中
      expect(body.value.results.map((r) => r.id)).toEqual(['K-1'])
    } finally {
      await app.close()
      kb.close()
    }
  })

  it('MCP prism_kb_search 带同一字段（信封 additive）', async () => {
    const home = await makeHome()
    const kb = await seedDegradedService(home)
    try {
      const tools = createMcpTools({ home, kb })
      const res = await handleRpcRequest(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prism_kb_search', arguments: { q: '性能' } } },
        tools,
      )
      const content = (res?.result as { isError: boolean; content: Array<{ text: string }> }).content
      const parsed = JSON.parse(content[0]!.text) as SearchResponse
      expect(parsed.embedding_degraded).toBe(true)
      expect(parsed.results.map((r) => r.id)).toEqual(['K-1'])
    } finally {
      kb.close()
    }
  })

  it('MCP 工具描述补枚举 embedding_degraded（S-9 宿主可发现）', () => {
    const tools = createMcpTools({ home: 'X:/unused' })
    const search = tools.find((t) => t.name === 'prism_kb_search')
    expect(search?.description).toContain('embedding_degraded')
  })
})

describe('v15 SPEC-2.3（装配侧）：未装/off 不置 vectorCapable → 不误报', () => {
  it('loadKnowledgeService（PRISM_EMBEDDING=off）产出的服务，向量算不出也不带该字段', async () => {
    const home = await makeHome('prism-kb-degraded-wire-')
    const saved = process.env['PRISM_EMBEDDING']
    process.env['PRISM_EMBEDDING'] = 'off'
    const kb: KnowledgeService & { close?: () => void } = await loadKnowledgeService(home)
    try {
      await kb.deposit({
        id: 'K-1',
        title: '性能守则',
        type: 'rule',
        layer: 'global',
        book: 'h',
        module: '',
        content: '遇到性能问题先量化，再做优化。',
      })
      const response = (await kb.searchWithMeta!({ q: '性能' })) as SearchResponse
      expect('embedding_degraded' in response).toBe(false)
      expect(response.results.map((r) => r.id)).toEqual(['K-1'])
    } finally {
      kb.close?.()
      if (saved === undefined) delete process.env['PRISM_EMBEDDING']
      else process.env['PRISM_EMBEDDING'] = saved
    }
  })
})
