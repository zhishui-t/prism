import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildGraphArgs,
  formatCommand,
  resolveGraphifyCommand,
  runGraphify,
} from '../src/graph/graphify.js'

const isWin = process.platform === 'win32'

async function tempDir(): Promise<string> {
  return await mkdir(join(tmpdir(), `prism-graphify-${Date.now()}-${Math.random().toString(36).slice(2)}`), {
    recursive: true,
  })
}

describe('resolveGraphifyCommand（Windows .cmd 处理）', () => {
  it('GRAPHIFY_BIN 指向 .js → 经 node 调用', async () => {
    const resolved = await resolveGraphifyCommand({ GRAPHIFY_BIN: 'C:/x/graphify-cli.js' })
    expect(resolved.command).toBe(process.execPath)
    expect(resolved.prefixArgs).toEqual(['C:/x/graphify-cli.js'])
    expect(resolved.shell).toBe(false)
  })

  it.skipIf(!isWin)('GRAPHIFY_BIN 指向 .cmd → shell 执行', async () => {
    const resolved = await resolveGraphifyCommand({ GRAPHIFY_BIN: 'C:/x/graphify.cmd' })
    expect(resolved.shell).toBe(true)
  })

  it('PATH 找不到 → graphify_missing（跳过 vendored 子工程）', async () => {
    await expect(
      resolveGraphifyCommand({ PATH: '', PRISM_SKIP_VENDORED: '1' }),
    ).rejects.toMatchObject({ code: 'graphify_missing' })
  })

  it('默认优先仓库内 vendored 子工程（3rd/graphify/dist/cli.js）', async () => {
    const resolved = await resolveGraphifyCommand({ PATH: '' })
    expect(resolved.shell).toBe(false)
    expect(resolved.prefixArgs[0]).toContain(join('3rd', 'graphify', 'dist', 'cli.js'))
  })

  it.skipIf(!isWin)('PATH 上找到 graphify.cmd → shell 执行', async () => {
    const dir = await tempDir()
    const cmd = join(dir, 'graphify.cmd')
    await writeFile(cmd, '@echo off\r\necho FAKE-GRAPHIFY\r\n', 'utf-8')
    const resolved = await resolveGraphifyCommand({ PATH: dir, PRISM_SKIP_VENDORED: '1' })
    expect(resolved.shell).toBe(true)
    // resolver 会剥掉 \\?\ 扩展前缀再返回
    expect(resolved.command.toLowerCase()).toBe(cmd.replace(/^\\\\\?\\/, '').toLowerCase())
    await rm(dir, { recursive: true, force: true })
  })
})

describe('runGraphify（错误映射 + 参数钉死）', () => {
  it('成功：stdout 捕获', async () => {
    const dir = await tempDir()
    const script = join(dir, 'fake.mjs')
    await writeFile(script, "process.stdout.write('FAKE-OK extract');\n", 'utf-8')
    const result = await runGraphify(['extract', 'X'], { env: { GRAPHIFY_BIN: script }, timeoutMs: 5000 })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('FAKE-OK extract')
    await rm(dir, { recursive: true, force: true })
  })

  it('非零退出 → graphify_failed', async () => {
    const dir = await tempDir()
    const script = join(dir, 'fail.mjs')
    await writeFile(script, "process.stderr.write('boom'); process.exit(3);\n", 'utf-8')
    await expect(
      runGraphify(['extract'], { env: { GRAPHIFY_BIN: script }, timeoutMs: 5000 }),
    ).rejects.toMatchObject({ code: 'graphify_failed' })
    await rm(dir, { recursive: true, force: true })
  })

  it('超时 → graphify_timeout', async () => {
    const dir = await tempDir()
    const script = join(dir, 'slow.mjs')
    await writeFile(script, 'setTimeout(() => {}, 60_000);\n', 'utf-8')
    await expect(
      runGraphify(['extract'], { env: { GRAPHIFY_BIN: script }, timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'graphify_timeout' })
    await rm(dir, { recursive: true, force: true })
  })

  it('buildGraphArgs 钉死零 token 参数（禁 LLM 富化）', () => {
    const args = buildGraphArgs('K:/proj')
    expect(args).toEqual([
      ['extract', 'K:/proj', '--out', 'K:/proj', '--no-description', '--no-label'],
      ['flows', 'build', '--graph', join('K:/proj', '.graphify', 'graph.json')],
    ])
  })

  it('formatCommand 对含空格参数加引号', () => {
    const line = formatCommand({ command: 'graphify.cmd', prefixArgs: [], shell: true }, ['extract', 'C:/My Proj'])
    expect(line).toBe('graphify.cmd extract "C:/My Proj"')
  })
})
