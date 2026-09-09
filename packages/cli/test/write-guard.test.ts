import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CommandContext } from '../src/argv.js'
import { defaultContext, runCommand } from '../src/argv.js'

/**
 * B6 写守卫（回归测试）：默认链（无 --zcode-dir、无 prism.yaml）落"宿主默认目录"时，
 * 写操作必须被阻止，直到 --yes 确认或显式 --zcode-dir。
 *
 * **安全口径**：守卫按「来源」判定（env `ZCODE_DIR` 注入的临时目录同样触发守卫），
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
    fakeDefaultZcode = mkdtempSync(join(tmpdir(), 'prism-guard-default-'))
    bareHome = mkdtempSync(join(tmpdir(), 'prism-guard-home-')) // 无 prism.yaml → 默认链
    directZcode = mkdtempSync(join(tmpdir(), 'prism-guard-direct-'))
    prevEnv = process.env['ZCODE_DIR']
    process.env['ZCODE_DIR'] = fakeDefaultZcode // 默认链重定向到临时目录（守卫仍触发：env 不算显式）
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
    if (prevEnv === undefined) delete process.env['ZCODE_DIR']
    else process.env['ZCODE_DIR'] = prevEnv
  })

  it('role init：默认链 + 无确认 → rc 1 + 提示 + 不写；--yes → 写临时默认链；显式 --zcode-dir → 直接写', async () => {
    // 1) 默认链，无确认 → 阻止
    lines = []
    expect(await runCommand(bareCtx, ['role', 'init', 'guard-blocked'])).toBe(1)
    const blocked = lines.join('\n')
    expect(blocked).toContain('已阻止写入')
    expect(blocked).toContain('--zcode-dir')
    expect(blocked).toContain('--yes')
    expect(existsSync(join(fakeDefaultZcode, 'agents', 'guard-blocked.md'))).toBe(false)

    // 2) --yes → 放行（写入 env 注入的临时默认链，非真实 ~/.zcode）
    lines = []
    expect(await runCommand(bareCtx, ['role', 'init', 'guard-blocked', '--yes'])).toBe(0)
    expect(lines.join('\n')).toContain('--yes：确认写入')
    expect(existsSync(join(fakeDefaultZcode, 'agents', 'guard-blocked.md'))).toBe(true)

    // 3) 显式 --zcode-dir → 直接写，无需 --yes
    lines = []
    expect(await runCommand(bareCtx, ['role', 'init', 'guard-direct', '--zcode-dir', directZcode])).toBe(0)
    expect(existsSync(join(directZcode, 'agents', 'guard-direct.md'))).toBe(true)
  })

  it('skill install：默认链 + 无确认 → 阻止且不写；--zcode-dir → 直接写', async () => {
    lines = []
    expect(await runCommand(bareCtx, ['skill', 'install', 'prism'])).toBe(1)
    expect(lines.join('\n')).toContain('已阻止写入')
    expect(existsSync(join(fakeDefaultZcode, 'skills', 'prism', 'SKILL.md'))).toBe(false)

    lines = []
    expect(await runCommand(bareCtx, ['skill', 'install', 'prism', '--zcode-dir', directZcode])).toBe(0)
    expect(existsSync(join(directZcode, 'skills', 'prism', 'SKILL.md'))).toBe(true)
  })

  it('prism init：默认链 + 无确认 → 阻止；--yes → 放行', async () => {
    lines = []
    expect(await runCommand(bareCtx, ['init'])).toBe(1)
    expect(lines.join('\n')).toContain('已阻止写入')

    lines = []
    expect(await runCommand(bareCtx, ['init', '--yes', '--json'])).toBe(0)
    expect(existsSync(join(fakeDefaultZcode, 'skills'))).toBe(true)
  })
})
