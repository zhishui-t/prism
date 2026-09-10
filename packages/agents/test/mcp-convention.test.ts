/**
 * MCP 注册约定（`HarnessAdapter.mcp`）——宿主专属的注册文件位置/形态。
 *
 * 回归背景：`configFile` 曾硬编码 `<root>/cli/config.json`（ZCode 专属），
 * 插件 harness 会拿到一个对它无意义的路径。现由适配器自述；`null` = 无 MCP 机制，
 * `prism init` 跳过注册并提示（不报错）。
 */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createZcodeAdapter } from '../src/adapters/zcode.js'
import { harnessPaths } from '../../server/src/roles/wiring.js'

describe('MCP 注册约定', () => {
  it('zcode 声明 <root>/cli/config.json（mcp-servers-json 形态）', () => {
    const root = join('K:', 'zroot')
    const adapter = createZcodeAdapter({ root })
    expect(adapter.mcp).not.toBeNull()
    expect(adapter.mcp?.configFile).toBe(join(root, 'cli', 'config.json'))
    expect(adapter.mcp?.format).toBe('mcp-servers-json')
  })

  it('harnessPaths 从适配器取 configFile（不再硬编码路径形态）', () => {
    const root = join('K:', 'zroot2')
    const paths = harnessPaths(root)
    expect(paths.configFile).toBe(join(root, 'cli', 'config.json'))
    // 其余路径同样来自适配器自述
    expect(paths.agentsDir).toBe(join(root, 'agents'))
    expect(paths.teamDir).toBe(join(root, 'teams'))
    expect(paths.skillsDir).toBe(join(root, 'skills'))
  })
})
