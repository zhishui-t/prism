import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prismTmpPrefix } from '@prism/core'

import type { CommandContext } from '../src/argv.js'
import { defaultContext, runCommand } from '../src/argv.js'

/**
 * B6 写守卫（回归测试）：默认链（无 --harness-root、无 prism.yaml）落"宿主默认目录"时，
 * 写操作必须被阻止，直到 --yes 确认或显式 --harness-root。
 *
 * **安全口径**：守卫按「来源」判定（env `PRISM_HARNESS_ROOT` 注入的临时目录同样触发守卫），
 * 因此本组测试把默认链重定向到临时目录——**任何断言都不触碰真实 ~/.zcode**。
 */
describe('B6 写守卫：默认宿主目录写入需确认', () => {
  let fakeDefaultZcode = ''
  let bareHome = ''
  let directZcode = ''
  let prevEnv: string | undefined
  let lines: string[]
  let bareCtx: CommandContext

  beforeEach(async () => {
    fakeDefaultZcode = mkdtempSync(join(tmpdir(), prismTmpPrefix('guard-default')))
    bareHome = mkdtempSync(join(tmpdir(), prismTmpPrefix('guard-home'))) // 无 prism.yaml → 默认链
    directZcode = mkdtempSync(join(tmpdir(), prismTmpPrefix('guard-direct')))
    prevEnv = process.env['PRISM_HARNESS_ROOT']
    process.env['PRISM_HARNESS_ROOT'] = fakeDefaultZcode // 默认链重定向到临时目录（守卫仍触发：env 不算显式）
    lines = []
    bareCtx = {
      ...defaultContext({
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(`[stderr] ${line}`),
      }),
      home: bareHome,
    }
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env['PRISM_HARNESS_ROOT']
    else process.env['PRISM_HARNESS_ROOT'] = prevEnv
  })

  it('role new：默认链 + 无确认 → rc 1 + 提示 + 不写；--yes → 写临时默认链；显式 --harness-root → 直接写', async () => {
    // 1) 默认链，无确认 → 阻止
    lines = []
    expect(await runCommand(bareCtx, ['role', 'new', 'guard-blocked'])).toBe(1)
    const blocked = lines.join('\n')
    expect(blocked).toContain('已阻止写入')
    expect(blocked).toContain('--harness-root')
    expect(blocked).toContain('--yes')
    expect(existsSync(join(fakeDefaultZcode, 'agents', 'guard-blocked.md'))).toBe(false)

    // 2) --yes → 放行（写入 env 注入的临时默认链，非真实 ~/.zcode）
    lines = []
    expect(await runCommand(bareCtx, ['role', 'new', 'guard-blocked', '--yes'])).toBe(0)
    expect(lines.join('\n')).toContain('--yes：确认写入')
    expect(existsSync(join(fakeDefaultZcode, 'agents', 'guard-blocked.md'))).toBe(true)

    // 3) 显式 --harness-root → 直接写，无需 --yes
    lines = []
    expect(await runCommand(bareCtx, ['role', 'new', 'guard-direct', '--harness-root', directZcode])).toBe(0)
    expect(existsSync(join(directZcode, 'agents', 'guard-direct.md'))).toBe(true)
  })

  it('skill install：默认链 + 无确认 → 阻止且不写；--harness-root → 直接写', async () => {
    lines = []
    expect(await runCommand(bareCtx, ['skill', 'install', 'prism'])).toBe(1)
    expect(lines.join('\n')).toContain('已阻止写入')
    expect(existsSync(join(fakeDefaultZcode, 'skills', 'prism', 'SKILL.md'))).toBe(false)

    lines = []
    expect(await runCommand(bareCtx, ['skill', 'install', 'prism', '--harness-root', directZcode])).toBe(0)
    expect(existsSync(join(directZcode, 'skills', 'prism', 'SKILL.md'))).toBe(true)
  })

  it('prism init：默认链 + 无确认 → 阻止（建议 --yes）；--yes → 放行', async () => {
    // `--skip-cli`：本组用例只测写守卫。init 默认要做 F5 的 CLI 全局注册——
    // 默认链一旦被 --yes 放行就会真实写本机 npm 全局 bin 目录（SPEC-5.6 红线）。
    lines = []
    expect(await runCommand(bareCtx, ['init', '--skip-cli'])).toBe(1)
    const blocked = lines.join('\n')
    expect(blocked).toContain('已阻止写入')
    // v10 F7：init 的守卫改为指向 `--yes`（init 的正常落点就是默认宿主目录）；
    // `--harness-root` 在 init 语境只作测试/CI 用，不再作为「换个位置」的用户向建议。
    expect(blocked).toContain('--yes')
    expect(blocked).toContain('加 --yes 确认写入默认宿主配置')
    expect(blocked).not.toContain('指定其他位置')
    expect(blocked).not.toContain('或加 --yes')
    expect(blocked).toContain('测试/CI 专用')

    lines = []
    expect(await runCommand(bareCtx, ['init', '--yes', '--skip-cli', '--json'])).toBe(0)
    expect(existsSync(join(fakeDefaultZcode, 'skills'))).toBe(true)
  })

  it('init 成功输出：--harness-root 标注「测试/CI 专用」（未探测到宿主时那句）', async () => {
    // 用一个**不存在**的根：`harnessDetected` 为 false，才会打出推荐 --harness-root 的那句
    const missingRoot = join(directZcode, 'not-there')
    lines = []
    expect(await runCommand(bareCtx, ['init', '--harness-root', missingRoot, '--skip-cli'])).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('--harness-root')
    expect(output).toContain('测试/CI 专用')
  })

  it('role 守卫文案不受 init 改动影响（--harness-root 仍是用户向出路，无「测试/CI 专用」标注）', async () => {
    lines = []
    expect(await runCommand(bareCtx, ['role', 'new', 'guard-role-text'])).toBe(1)
    const blocked = lines.join('\n')
    expect(blocked).toContain('--harness-root')
    expect(blocked).toContain('加 --harness-root 指定其他位置')
    expect(blocked).not.toContain('测试/CI 专用')
  })
})
