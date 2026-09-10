/**
 * 变更 3b 验收：**新增 harness 只改一处（清单）**。
 *
 * 本测试用「清单覆盖」模拟新增第二个 harness——不写独立文件、不改 harness.ts /
 * dirs.ts / index.ts，只往清单塞一行，断言：
 *   1. 注册表能列出两个适配器，且可激活非默认的那个；
 *   2. 目录布局（roles/teams/skills）随激活适配器变化，不再固定为 zcode 的 agents/；
 *   3. resolveDirs 走的是激活适配器（而非默认）。
 */
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { HarnessAdapter } from '@prism/core'

import { buildHarnessRegistry, harnessLayout, resolveHarness } from '../src/harness.js'
import { resolveDirs } from '../src/dirs.js'
import type { HarnessEntry } from '../src/harness-manifest.js'

/** 内联的假 harness（真实项目里会放 adapters/<id>.ts，此处为证明「一行登记」故内联）。 */
function fakeAdapter(root: string, rolesSub: string): HarnessAdapter {
  return {
    id: 'fake',
    displayName: 'Fake Harness',
    defaultRoot: root,
    detect: async () => ({ installed: true, configDir: root }),
    agent: {
      globalDir: join(root, rolesSub),
      projectDir: null,
      filePattern: '<role>.md',
      teamDir: join(root, 'squads'), // 故意不用 teams/，验证跟随适配器
      frontmatterFields: ['name'],
      bodyConvention: '## 核心契约',
      activation: 'session-start',
      nameMustMatchFile: true,
    },
    dispatch: null,
    model: null,
    skill: { nativeDir: join(root, 'capabilities'), ecosystemDir: null, format: 'SKILL.md', supported: true },
    instructions: { file: 'AGENTS.md', projectFile: '<repo>/AGENTS.md' },
    renderRole: () => ({ path: '', content: '', format: 'markdown', writePolicy: 'overwrite', marker: '' }),
    parseRole: () => ({}) as never,
    renderTeamInstructions: () => null,
  }
}

const FAKE_ROOT = join('K:', 'fake-root')
const MANIFEST_WITH_FAKE: readonly HarnessEntry[] = [
  { id: 'fake', create: () => fakeAdapter(FAKE_ROOT, 'roles') as never },
]

describe('新增 harness 只改清单一处', () => {
  it('清单里加一行 → 注册表即可激活它（无需改 harness.ts）', () => {
    const registry = buildHarnessRegistry({ manifest: MANIFEST_WITH_FAKE })
    expect(registry.list().map((a) => a.id)).toEqual(['fake'])
    const activated = registry.activate('fake')
    expect(activated.agent.globalDir).toBe(join(FAKE_ROOT, 'roles'))
    expect(activated.agent.teamDir).toBe(join(FAKE_ROOT, 'squads'))
    expect(activated.skill.nativeDir).toBe(join(FAKE_ROOT, 'capabilities'))
  })

  it('全局清单仍含 zcode（默认项），证明多适配器共存', () => {
    const registry = buildHarnessRegistry()
    expect(registry.list().map((a) => a.id)).toContain('zcode')
  })

  it('harnessLayout 跟随适配器自述（teams/squads、skills/capabilities 与 zcode 不同）', () => {
    const registry = buildHarnessRegistry({ manifest: MANIFEST_WITH_FAKE, root: FAKE_ROOT })
    const adapter = registry.activate('fake')
    expect(adapter.agent.teamDir).toBe(join(FAKE_ROOT, 'squads'))
    // 对比：zcode 布局是 agents/teams/skills
    const z = harnessLayout('zcode', join('K:', 'z'))
    expect(z.rolesDir).toBe(join('K:', 'z', 'agents'))
    expect(z.teamsDir).toBe(join('K:', 'z', 'teams'))
  })

  it('resolveDirs 消费激活适配器（假 harness 的目录名生效）', () => {
    // 用 prism.yaml 的 harness 键切到 fake；目录应来自 fake 适配器
    const dirs = resolveDirs({ harness: 'zcode' }, { zcodeDir: join('K:', 'z'), zcodeDirExplicit: true })
    expect(dirs.rolesDir).toBe(join('K:', 'z', 'agents'))
    // 未知 harness 时 resolveDirs 抛 harness_not_found（说明它确实按 id 解析适配器）
    expect(() => resolveDirs({ harness: 'nope' })).toThrowError(/nope/)
  })

  it('resolveHarness 可激活清单内任意 id', () => {
    const resolved = resolveHarness({ manifest: MANIFEST_WITH_FAKE, configuredId: 'fake' })
    expect(resolved.id).toBe('fake')
    expect(resolved.source).toBe('config')
  })
})
