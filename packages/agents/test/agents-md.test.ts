import { describe, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tmpTag } from '@prism/core'

import { findPrismBlock, hasPrismBlock, injectAgentsBlock, injectTeamBlock, removeAgentsBlock, removeTeamBlocks, teamBlockEnd, teamBlockStart } from '../src/agents-md.js'

async function tmpFile(name: string, content?: string): Promise<string> {
  const path = join(tmpdir(), `prism-inject-${tmpTag()}-${Date.now()}-${name}`)
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

/** 团队约定块（team-definition.md §7「注入」；编制/工作流/仲裁链的落点）。 */
describe('agents-md 团队约定块', () => {
  const rendered = (teamId: string): string =>
    [teamBlockStart(teamId), `# 团队约定：${teamId}`, '', '| 角色 | 实例上限 |', '| :--- | :--- |', '| dev | 2 |', teamBlockEnd(teamId)].join('\n')

  it('标记单点：teamBlockStart/End 与块渲染契约同构', () => {
    expect(teamBlockStart('delivery')).toBe('<!-- prism:team:delivery:start -->')
    expect(teamBlockEnd('delivery')).toBe('<!-- prism:team:delivery:end -->')
  })

  it('文件不存在 → 创建；无块 → 追加（手写内容不动）', async () => {
    const path = await tmpFile('team-append.md', '# 我的项目\n\n手写内容。\n')
    const result = await injectTeamBlock(path, 'delivery', rendered('delivery'))
    expect(result.action).toBe('appended')
    const text = await readFile(path, 'utf-8')
    expect(text.startsWith('# 我的项目')).toBe(true)
    expect(text).toContain(teamBlockStart('delivery'))
    expect(text).toContain('| dev | 2 |')
  })

  it('已有块 → 只更新块内（编制改版即刷新）；块外与知识块不动', async () => {
    const original = [
      '# 项目',
      '',
      '<!-- prism:begin -->',
      '知识指引',
      '<!-- prism:end -->',
      '',
      teamBlockStart('delivery'),
      '旧约定（过期编制）',
      teamBlockEnd('delivery'),
      '',
      '尾部手写。',
      '',
    ].join('\n')
    const path = await tmpFile('team-update.md', original)
    const result = await injectTeamBlock(path, 'delivery', rendered('delivery'))
    expect(result.action).toBe('updated')
    const text = await readFile(path, 'utf-8')
    expect(text).not.toContain('旧约定')
    expect(text).toContain('| dev | 2 |')
    expect(text).toContain('知识指引') // 知识块不受影响
    expect(text).toContain('尾部手写。')
    // 只有一份该团队的块（替换而非追加）
    expect(text.split(teamBlockStart('delivery'))).toHaveLength(2)
  })

  it('不同团队各自独立块、可共存（切团队互不覆盖）', async () => {
    const path = await tmpFile('team-multi.md', '')
    await injectTeamBlock(path, 'delivery', rendered('delivery'))
    await injectTeamBlock(path, 'core-dev', rendered('core-dev'))
    // 再更新 delivery 不动 core-dev
    const next = rendered('delivery').replace('| dev | 2 |', '| dev | 3 |')
    await injectTeamBlock(path, 'delivery', next)
    const text = await readFile(path, 'utf-8')
    expect(text).toContain('| dev | 3 |')
    expect(text).toContain(teamBlockStart('core-dev'))
    expect(text).toContain(teamBlockEnd('core-dev'))
  })

  it('半截块自愈：end 被人删了 → 从 start 到文末整段替换（其后内容本就无法界定归属，一并重建）', async () => {
    const path = await tmpFile('team-half.md', `# 项目\n\n尾部手写（在坏块之前，必须保留）。\n\n${teamBlockStart('delivery')}\n残留旧内容没有 end\n`)
    const result = await injectTeamBlock(path, 'delivery', rendered('delivery'))
    expect(result.action).toBe('updated')
    const text = await readFile(path, 'utf-8')
    expect(text).not.toContain('残留旧内容')
    expect(text).toContain('| dev | 2 |')
    expect(text).toContain('尾部手写（在坏块之前，必须保留）。')
    expect(text).toContain(teamBlockEnd('delivery')) // 重建后的块是完整的
  })

  it('渲染结果缺标记 → 拒写（适配器契约破坏不落盘）', async () => {
    const path = await tmpFile('team-bad.md', '# 项目\n')
    await expect(injectTeamBlock(path, 'delivery', '# 裸内容没有标记')).rejects.toThrow(/缺起止标记/)
    const text = await readFile(path, 'utf-8')
    expect(text).toBe('# 项目\n')
  })

  it('removeTeamBlocks 摘除全部团队块（含半截），知识块与手写内容保留', async () => {
    const original = [
      '# 项目',
      '',
      '<!-- prism:begin -->',
      '知识指引',
      '<!-- prism:end -->',
      '',
      teamBlockStart('delivery'),
      '约定 A',
      teamBlockEnd('delivery'),
      '',
      teamBlockStart('core-dev'),
      '约定 B',
      teamBlockEnd('core-dev'),
      '',
      '尾部。',
      '',
    ].join('\n')
    const path = await tmpFile('team-remove.md', original)
    expect(await removeTeamBlocks(path)).toBe(2)
    const text = await readFile(path, 'utf-8')
    expect(text).not.toContain('prism:team:')
    expect(text).toContain('知识指引')
    expect(text).toContain('尾部。')
    expect(await removeTeamBlocks(path)).toBe(0)
  })
})
