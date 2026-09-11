import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PrismPersistence } from '@prism/core'
import { describe, expect, it, vi } from 'vitest'

import { createMcpTools } from '../src/mcp/server.js'
import type { KnowledgeService, SearchQuery, SearchResult } from '../src/kb/port.js'

const makeTempDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'prism-mcp-lifecycle-'))

/**
 * F-T1：MCP 工具集惰性打开 SQLite（知识库 + 任务台账），必须可被显式释放。
 *
 * 不释放的后果：Windows 上 `*.db/-wal/-shm` 句柄挂到进程结束，临时目录删不掉——
 * e2e 长期静默堆积（修前 `D:\tmp` 积压 97+ 个 `prism-e2e-*`）。
 */
describe('MCP 工具集生命周期（F-T1：惰性句柄释放）', () => {
  it('close() 存在且幂等（从未惰性打开任何句柄时调用也安全）', async () => {
    const tools = createMcpTools({ home: await makeTempDir() })
    expect(typeof tools.close).toBe('function')
    expect(() => tools.close()).not.toThrow()
    expect(() => tools.close()).not.toThrow()
  })

  it('惰性打开的知识库经 kbFactory 创建 → close() 释放（只调一次）', async () => {
    const closed: string[] = []
    const fake = {
      search: async (_q: SearchQuery): Promise<SearchResult[]> => [],
      close: (): void => {
        closed.push('kb')
      },
    } as unknown as KnowledgeService
    const tools = createMcpTools({ home: await makeTempDir(), kbFactory: async () => fake })

    const search = tools.find((t) => t.name === 'prism_kb_search')
    expect(search).toBeDefined()
    await search!.call({ q: '性能' }) // 触发 kb 惰性装载
    expect(closed).toEqual([]) // 装载本身不关

    tools.close()
    tools.close() // 幂等
    expect(closed).toEqual(['kb'])
  })

  it('惰性打开的持久化（任务台账）→ close() 释放', async () => {
    const spy = vi.spyOn(PrismPersistence.prototype, 'close')
    try {
      const tools = createMcpTools({ home: await makeTempDir() })
      const list = tools.find((t) => t.name === 'prism_task_status')
      expect(list).toBeDefined()
      await list!.call({}) // 触发 openPersistence → tasks.db
      expect(spy).not.toHaveBeenCalled()

      tools.close()
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('注入的 kb（调用方持有）不被 close() 关闭：所有权边界不外溢', async () => {
    const closed: string[] = []
    const injected = {
      search: async (_q: SearchQuery): Promise<SearchResult[]> => [],
      close: (): void => {
        closed.push('injected')
      },
    } as unknown as KnowledgeService
    const tools = createMcpTools({ home: await makeTempDir(), kb: injected })

    await tools.find((t) => t.name === 'prism_kb_search')!.call({ q: 'x' })
    tools.close()
    expect(closed).toEqual([])
  })
})
