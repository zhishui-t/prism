import { describe, expect, it } from 'vitest'

import {
  buildHarnessRegistry,
  harnessSummary,
  resolveHarness,
} from '../src/harness.js'
import { DEFAULT_HARNESS_ID, HARNESS_ENV_VAR } from '../src/harness-id.js'
import { parsePrismConfig, resolveDirs } from '../src/dirs.js'

describe('harness 常量与注册表（deployment-model §1）', () => {
  it('默认适配器为 zcode；注册表编译进 ZCode 适配器', () => {
    expect(DEFAULT_HARNESS_ID).toBe('zcode')
    const registry = buildHarnessRegistry()
    expect(registry.list().map((a) => a.id)).toEqual(['zcode'])
  })
})

describe('resolveHarness：优先级 env > prism.yaml > 默认', () => {
  it('无配置无环境变量 → 默认 zcode（source=default）', () => {
    const resolved = resolveHarness({ env: {} })
    expect(resolved.id).toBe('zcode')
    expect(resolved.source).toBe('default')
    expect(resolved.adapter.id).toBe('zcode')
  })

  it('prism.yaml 配置 → source=config', () => {
    const resolved = resolveHarness({ configuredId: 'zcode', env: {} })
    expect(resolved.id).toBe('zcode')
    expect(resolved.source).toBe('config')
  })

  it('环境变量优先于配置 → source=env', () => {
    const resolved = resolveHarness({
      configuredId: 'zcode',
      env: { [HARNESS_ENV_VAR]: 'zcode' },
    })
    expect(resolved.source).toBe('env')
  })

  it('未知 harness → harness_not_found（附可用列表）', () => {
    expect(() => resolveHarness({ configuredId: 'codex', env: {} })).toThrowError(
      expect.objectContaining({ code: 'harness_not_found' }),
    )
  })

  it('harnessSummary 暴露约定字段', () => {
    const { adapter } = resolveHarness({ env: {} })
    const summary = harnessSummary(adapter)
    expect(summary.id).toBe('zcode')
    expect(summary.displayName).toBe('ZCode')
    expect(summary.agent.filePattern).toBe('<role>.md')
    expect(summary.agent.bodyConvention).toBe('## 核心契约')
    expect(summary.skill.format).toBe('SKILL.md')
    expect(summary.instructions.file).toBe('AGENTS.md')
  })
})

describe('prism.yaml 的 harness 键（解析与目录集透传）', () => {
  it('parsePrismConfig 识别 harness 键（与三个目录键共存）', () => {
    const config = parsePrismConfig(
      ['# 宿主适配器', 'harness: zcode', 'roles_dir: ~/my-agents', 'unknown: x'].join('\n'),
    )
    expect(config).toEqual({ harness: 'zcode', roles_dir: '~/my-agents' })
  })

  it('resolveDirs 透传 harness；缺省回落默认', () => {
    expect(resolveDirs({ harness: 'zcode' }, { zcodeDir: 'K:/z' }).harness).toBe('zcode')
    expect(resolveDirs(null, { zcodeDir: 'K:/z' }).harness).toBe(DEFAULT_HARNESS_ID)
  })
})
