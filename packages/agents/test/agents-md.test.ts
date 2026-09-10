import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { findPrismBlock, hasPrismBlock, injectAgentsBlock, removeAgentsBlock } from '../src/agents-md.js'

async function tmpFile(name: string, content?: string): Promise<string> {
  const path = join(tmpdir(), `prism-inject-${Date.now()}-${name}`)
  if (content !== undefined) await writeFile(path, content, 'utf-8')
  return path
}

/** AGENTS.md 注入块（knowledge-injection.md §5 模式 C）。 */
describe('agents-md 注入块', () => {
  it('文件不存在 → 创建（只含块）', async () => {
    const path = await tmpFile('create.md')
    const result = await injectAgentsBlock(path)
    expect(result.action).toBe('created')
    const text = await readFile(path, 'utf-8')
    expect(text).toContain('<!-- prism:begin -->')
    expect(text).toContain('prism_kb_search')
  })

  it('无块 → 追加到末尾，手写内容不动', async () => {
    const path = await tmpFile('append.md', '# 我的项目\n\n手写内容，不许动。\n')
    const result = await injectAgentsBlock(path)
    expect(result.action).toBe('appended')
    const text = await readFile(path, 'utf-8')
    expect(text.startsWith('# 我的项目')).toBe(true)
    expect(text).toContain('手写内容，不许动。')
    expect(text).toContain('<!-- prism:begin -->')
    // 块在手写内容之后
    expect(text.indexOf('手写内容')).toBeLessThan(text.indexOf('prism:begin'))
  })

  it('已有块 → 只更新块内，块外不动（幂等）', async () => {
    const original = '# 项目\n\n<!-- prism:begin -->\n旧内容\n<!-- prism:end -->\n\n尾部手写。\n'
    const path = await tmpFile('update.md', original)
    const first = await injectAgentsBlock(path, { teamId: 'core-dev' })
    expect(first.action).toBe('updated')
    const text = await readFile(path, 'utf-8')
    expect(text).not.toContain('旧内容')
    expect(text).toContain('core-dev')
    expect(text).toContain('尾部手写。')
    expect(text.startsWith('# 项目')).toBe(true)

    // 再注入（无 teamId）→ 块内容变化但尾部仍在
    const second = await injectAgentsBlock(path)
    expect(second.action).toBe('updated')
    const text2 = await readFile(path, 'utf-8')
    expect(text2).toContain('尾部手写。')
    expect(text2).not.toContain('core-dev')
  })

  it('removeAgentsBlock 只删块', async () => {
    const path = await tmpFile('remove.md', '# 项目\n\n<!-- prism:begin -->\n内容\n<!-- prism:end -->\n\n尾部。\n')
    expect(await removeAgentsBlock(path)).toBe(true)
    const text = await readFile(path, 'utf-8')
    expect(text).not.toContain('prism:begin')
    expect(text).toContain('# 项目')
    expect(text).toContain('尾部。')
    // 再删 → false
    expect(await removeAgentsBlock(path)).toBe(false)
  })

  it('hasPrismBlock / findPrismBlock', () => {
    expect(hasPrismBlock('x')).toBe(false)
    expect(hasPrismBlock('<!-- prism:begin -->y')).toBe(false) // 缺 end
    const pos = findPrismBlock('a<!-- prism:begin -->mid<!-- prism:end -->b')
    expect(pos).not.toBeNull()
  })
})
