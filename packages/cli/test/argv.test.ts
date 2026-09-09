import { describe, expect, it } from 'vitest'

import { parseArgv, USAGE, cliVersion } from '../src/argv.js'

describe('parseArgv（node:util.parseArgs，零框架）', () => {
  it('位置参数 + 全局选项', () => {
    const { positionals, values } = parseArgv(['kb', 'search', '性能', '--limit', '5', '--json'])
    expect(positionals).toEqual(['kb', 'search', '性能'])
    expect(values.limit).toBe('5')
    expect(values.json).toBe(true)
  })

  it('--home 覆盖', () => {
    const { values } = parseArgv(['serve', '--home', 'D:/tmp/prism-x', '--port', '8080'])
    expect(values.home).toBe('D:/tmp/prism-x')
    expect(values.port).toBe('8080')
  })

  it('未知选项不炸（strict:false；其值落为位置参数，宽容前向兼容）', () => {
    const { positionals } = parseArgv(['kb', 'stats', '--future-flag', 'x'])
    expect(positionals).toEqual(['kb', 'stats', 'x'])
  })

  it('--version / --help 开关', () => {
    expect(parseArgv(['--version']).values.version).toBe(true)
    expect(parseArgv(['--help']).values.help).toBe(true)
  })

  it('USAGE 覆盖 design.md §5 全部命令', () => {
    for (const command of ['init', 'serve', 'doctor', 'kb', 'graph']) {
      expect(USAGE).toContain(command)
    }
    expect(USAGE).toContain('--version')
  })

  it('cliVersion 可读', async () => {
    expect(await cliVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
