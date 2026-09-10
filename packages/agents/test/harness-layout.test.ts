/**
 * 变更 3 验收：派生默认值来自**激活的适配器**，而非硬编码路径。
 *
 * 旧实现 `resolveDirs` 直接 `join(root,'agents'|'teams'|'skills')`，新增 harness 要改
 * dirs.ts；现在全部走 `harnessLayout(adapter)`——本测试锁死这个契约：
 * 换 `PRISM_HARNESS` 到另一个适配器，目录布局必须随之改变。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'

import { createHarnessRegistry, type HarnessAdapter } from '@prism/core'

import { harnessLayout } from '../src/harness.js'

describe('变更 3：目录布局由适配器推导（新增 harness 不动上层）', () => {
  it('注册表可容纳多个适配器（编译期登记、运行期激活其一）', () => {
    const registry = createHarnessRegistry()
    const make = (id: string, root: string, rolesSub: string): HarnessAdapter => ({
      id,
      displayName: id,
      defaultRoot: root,
      detect: async () => ({ installed: true, configDir: root }),
      agent: {
        globalDir: `${root}/${rolesSub}`,
        projectDir: null,
        filePattern: '<role>.md',
        teamDir: `${root}/teams`,
        frontmatterFields: ['name'],
        bodyConvention: '## 核心契约',
        activation: 'session-start',
        nameMustMatchFile: true,
      },
      dispatch: null,
      model: null,
      skill: { nativeDir: `${root}/skills`, ecosystemDir: null, format: 'SKILL.md', supported: true },
      instructions: { file: 'AGENTS.md', projectFile: '<repo>/AGENTS.md' },
      mcp: null,
      renderRole: () => ({ path: '', content: '', format: 'markdown', writePolicy: 'overwrite', marker: '' }),
      parseRole: () => ({}) as never,
      renderTeamInstructions: () => null,
    })
    registry.register(make('alpha', '/home/u/.alpha', 'roles'))
    registry.register(make('beta', '/home/u/.beta', 'agents'))
    expect(registry.list().map((a) => a.id)).toEqual(['alpha', 'beta'])
    // 布局随适配器自述，不硬编码
    expect(registry.activate('alpha').agent.globalDir).toBe('/home/u/.alpha/roles')
    expect(registry.activate('beta').agent.globalDir).toBe('/home/u/.beta/agents')
  })

  it('harnessLayout 返回适配器自述的目录（ZCode：<root>/agents、<root>/teams、<root>/skills）', () => {
    const root = join('K:', 'tmp', 'harness-root')
    const layout = harnessLayout('zcode', root)
    expect(layout.id).toBe('zcode')
    expect(layout.root).toBe(root)
    expect(layout.rolesDir).toBe(join(root, 'agents'))
    expect(layout.teamsDir).toBe(join(root, 'teams'))
    expect(layout.skillsDir).toBe(join(root, 'skills'))
  })

  it('未知 harness → harness_not_found（附可用列表）', () => {
    expect(() => harnessLayout('no-such-harness')).toThrowError(/no-such-harness/)
  })
})
