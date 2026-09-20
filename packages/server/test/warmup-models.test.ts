/**
 * 模型预热 opt-in（v14 检视批队长裁决①的回归锁）。
 *
 * 裁决①的缺陷背景：GPU 档 rerank 冷启首请求 9.7s > timeoutMs 3s，常驻 serve 的
 * 「冷启后第一次检索」必静默降级 RRF——修法是 `warmupModels?: boolean`（**缺省
 * false**），仅两个真实 serve 入口打开。本文件锁住两头：
 * - 缺省（不传）→ startServer **不碰**任何 ensure*（测试/一次性调用不得凭空 spawn
 *   438MB 的真实推理进程——与 trashSweep 缺省关同一哲学）；
 * - 显式 true → listen 后 fire-and-forget 拉起 embedding 与 rerank 两实例。
 *
 * 手法：`vi.mock` **partial** 替换（`importOriginal` 保真其余导出——`wiring.ts` 等
 * 同图模块不受影响），只换两个 ensure* 为 spy，配合临时 home（R5）与 `port: 0`
 * （不占真实端口、不碰 8191/8192），全程零真实子进程。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { ensureEmbedding, ensureRerank } = vi.hoisted(() => ({
  ensureEmbedding: vi.fn(async (): Promise<boolean> => true),
  ensureRerank: vi.fn(async (): Promise<boolean> => true),
}))

vi.mock('../src/kb/embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/kb/embedding.js')>()
  return {
    ...actual,
    ensureEmbeddingServer: () => ensureEmbedding(),
    ensureRerankServer: () => ensureRerank(),
  }
})

import { startServer } from '../src/app.js'

const homes: string[] = []

afterEach(() => {
  ensureEmbedding.mockClear()
  ensureRerank.mockClear()
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'prism-warmup-'))
  homes.push(home)
  return home
}

describe('startServer 的 warmupModels（v14 检视批裁决①）', () => {
  it('缺省 false：预热零调用（server 包十余个测试直接 startServer({port:0})，不得凭空拉实例）', async () => {
    const handle = await startServer({ home: makeHome(), port: 0 })
    // fire-and-forget 若被误开也会在这个窗口里触发——让出几个宏任务再断言
    await new Promise((r) => setTimeout(r, 50))
    expect(ensureEmbedding).not.toHaveBeenCalled()
    expect(ensureRerank).not.toHaveBeenCalled()
    await handle.close()
  })

  it('显式 true：listen 后两实例都被预热（embedding 与 rerank 各一次、互不阻塞）', async () => {
    const handle = await startServer({ home: makeHome(), port: 0, warmupModels: true })
    await new Promise((r) => setTimeout(r, 50))
    expect(ensureEmbedding).toHaveBeenCalledTimes(1)
    expect(ensureRerank).toHaveBeenCalledTimes(1)
    await handle.close()
  })
})
