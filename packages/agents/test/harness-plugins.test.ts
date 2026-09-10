/**
 * 变更 3c 验收：**harness 适配器插件**——发布后第三方把适配包放进
 * `<PRISM_HOME>/harnesses/` 即被自动注册，零代码侵入。
 *
 * 本测试在临时目录里**真实生成一个适配器包**（harness.json + index.mjs），
 * 调 `loadHarnessPlugins()` 后断言：
 *   1. 插件适配器出现在 `listHarnesses()`（origin=external）并能被激活；
 *   2. 其目录布局（自述的 teams/skills）被 `resolveDirs` 采纳；
 *   3. 坏插件（清单缺 entry / id 冲突 / 非法形状）只记 error，不影响其它插件与启动。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ensureHarnessPluginsLoaded,
  loadHarnessPlugins,
  resetHarnessPlugins,
} from '../src/harness-plugins.js'
import { listHarnesses, resolveHarness } from '../src/harness.js'
import { resolveDirs } from '../src/dirs.js'

/** 生成一个合法插件包，返回其目录。 */
function writePlugin(root: string, name: string, id: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'harness.json'), JSON.stringify({ id, entry: './index.mjs' }), 'utf-8')
  writeFileSync(
    join(dir, 'index.mjs'),
    `export default function createAdapter(opts) {
  const root = opts.root ?? '/tmp/' + ${JSON.stringify(id)}
  return {
    id: ${JSON.stringify(id)},
    displayName: 'Plugin ' + ${JSON.stringify(id)},
    defaultRoot: root,
    detect: async () => ({ installed: true, configDir: root }),
    agent: {
      globalDir: root + '/roles',
      projectDir: null,
      filePattern: '<role>.md',
      teamDir: root + '/squads',
      frontmatterFields: ['name'],
      bodyConvention: '## 核心契约',
      activation: 'session-start',
      nameMustMatchFile: true,
    },
    dispatch: null,
    model: null,
    skill: { nativeDir: root + '/skills', ecosystemDir: null, format: 'SKILL.md', supported: true },
    instructions: { file: 'AGENTS.md', projectFile: '<repo>/AGENTS.md' },
    renderRole: () => ({ path: '', content: '', format: 'markdown', writePolicy: 'overwrite', marker: '' }),
    parseRole: () => ({}),
    renderTeamInstructions: () => null,
  }
}
`,
    'utf-8',
  )
  return dir
}

let home: string

function fresh(): string {
  home = mkdtempSync(join(tmpdir(), 'prism-harness-plugin-'))
  process.env['PRISM_HARNESS_DIR'] = join(home, 'harnesses')
  mkdirSync(process.env['PRISM_HARNESS_DIR'], { recursive: true })
  resetHarnessPlugins()
  return process.env['PRISM_HARNESS_DIR']
}

afterEach(() => {
  delete process.env['PRISM_HARNESS_DIR']
  delete process.env['PRISM_NO_HARNESS_PLUGINS']
  resetHarnessPlugins()
})

describe('harness 适配器插件（放目录即注册，零代码侵入）', () => {
  it('插件被自动发现、注册、可激活，布局被采纳', async () => {
    const dir = fresh()
    writePlugin(dir, 'acme', 'acme-harness')

    const report = await loadHarnessPlugins()
    expect(report.errors).toEqual([])

    // 出现在清单里，标记为 external
    const listing = listHarnesses().find((h) => h.id === 'acme-harness')
    expect(listing?.origin).toBe('external')
    // 能激活（走配置指定）
    const resolved = resolveHarness({ configuredId: 'acme-harness' })
    expect(resolved.id).toBe('acme-harness')
    expect(resolved.adapter.agent.teamDir).toContain('squads') // 插件自述的目录被采纳
    // resolveDirs 采用插件布局
    const dirs = resolveDirs({ harness: 'acme-harness' })
    expect(dirs.rolesDir).toContain('roles')
    expect(dirs.teamsDir).toContain('squads')
    expect(dirs.skillsDir).toContain('skills')
  })

  it('坏插件只记错误，不影响好插件与内置', async () => {
    const dir = fresh()
    writePlugin(dir, 'good', 'good-harness')
    // 缺 entry 文件
    mkdirSync(join(dir, 'bad-entry'), { recursive: true })
    writeFileSync(join(dir, 'bad-entry', 'harness.json'), JSON.stringify({ id: 'bad-entry', entry: './nope.mjs' }), 'utf-8')
    // id 与内置冲突
    writePlugin(dir, 'clash', 'zcode')

    const report = await ensureHarnessPluginsLoaded()
    const ids = listHarnesses().map((h) => h.id)
    expect(ids).toContain('good-harness')
    expect(ids).toContain('zcode') // 内置仍在
    expect(ids).not.toContain('bad-entry')
    expect(report.errors.length).toBeGreaterThanOrEqual(2) // entry 缺失 + id 冲突
    expect(report.loaded.map((l) => l.id)).toEqual(['good-harness'])
  })

  it('无插件目录 → 仅内置，不报错', async () => {
    fresh()
    const report = await ensureHarnessPluginsLoaded()
    expect(report.errors).toEqual([])
    expect(listHarnesses().map((h) => h.id)).toEqual(['zcode'])
  })

  it('PRISM_NO_HARNESS_PLUGINS=1 → 跳过加载（即使目录有插件）', async () => {
    const dir = fresh()
    writePlugin(dir, 'acme', 'acme-harness')
    process.env['PRISM_NO_HARNESS_PLUGINS'] = '1'
    resetHarnessPlugins()
    await ensureHarnessPluginsLoaded()
    expect(listHarnesses().map((h) => h.id)).toEqual(['zcode'])
  })

  it('幂等：重复加载不重复注册', async () => {
    const dir = fresh()
    writePlugin(dir, 'acme', 'acme-harness')
    await ensureHarnessPluginsLoaded()
    await loadHarnessPlugins()
    const ids = listHarnesses().map((h) => h.id)
    expect(ids.filter((i) => i === 'acme-harness')).toHaveLength(1)
  })

  it('ZCODE_DIR 不泄漏到插件 harness（插件用自述 defaultRoot）', async () => {
    // 回归：env ZCODE_DIR 曾是通用覆盖源，会把 zcode 的根塞给插件（实测 bug）
    const dir = fresh()
    writePlugin(dir, 'acme', 'acme-harness')
    process.env['ZCODE_DIR'] = '/should/not/leak'
    try {
      await ensureHarnessPluginsLoaded()
      const resolved = resolveHarness({ configuredId: 'acme-harness' })
      // 未显式传 root → 插件 defaultRoot 生效（fixture 里为 /tmp/acme-harness）
      expect(resolved.adapter.defaultRoot).toBe('/tmp/acme-harness')
      expect(resolved.adapter.agent.globalDir).not.toContain('should')
    } finally {
      delete process.env['ZCODE_DIR']
    }
  })
})

